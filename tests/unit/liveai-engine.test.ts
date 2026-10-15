// LiveEngine end to end with fake recognition, CAS and provider: settle timing, mode gating
// (Local never calls the AI), per-line judging and caching, instant clearing, stale cancellation,
// the red-mark policy and timing as the viewport would see it, first error only, live results,
// mistake journal, exam mode, paused pages and deictic resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (/^\.\.?\//.test(spec) && ctx.parentURL?.endsWith('.ts'))
        for (const ext of ['.ts', '/index.ts'])
          try {
            return next(spec + ext, ctx);
          } catch {
            /* next */
          }
      throw e;
    }
  },
});

const { LiveEngine, needsAi, linesToJudge, markGeometry } = await import('../../src/renderer/live/engine.ts');
const { LiveAi } = await import('../../src/renderer/live/ai/service.ts');

type BBox = [number, number, number, number];
type Stroke = { id: string; kind: 'pen'; color: string; width: number; pts: Float32Array; bbox: BBox };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stroke that "writes" one character; its id carries the character: "<n>:<char>". */
let n = 0;
function glyph(ch: string, col: number, row: number): Stroke {
  const x = 20 + col * 12, y = 20 + row * 40;
  return { id: `${++n}:${ch}`, kind: 'pen', color: '#000', width: 1.5, pts: new Float32Array([x, y, 0.5, x + 8, y + 20, 0.5]), bbox: [x, y, x + 9, y + 22] };
}
const write = (text: string, row: number, col = 0) => [...text].map((ch, i) => glyph(ch, col + i, row));

/** Blocks are separated by an empty row; one line per row; text from the stroke ids; tokens per stroke. */
const recog = {
  conf: 0.95,
  groupInk(pageId: string, strokes: readonly Stroke[]) {
    const rows = new Map<number, Stroke[]>();
    for (const s of strokes) {
      const r = Math.round((s.bbox[1] - 20) / 40);
      rows.set(r, [...(rows.get(r) ?? []), s]);
    }
    const sorted = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    const groups: [number, Stroke[]][][] = [];
    for (const e of sorted) {
      const g = groups[groups.length - 1];
      if (g && e[0] - g[g.length - 1][0] === 1) g.push(e);
      else groups.push([e]);
    }
    return groups.map((g) => {
      const lines = g.map(([, ss]) => {
        ss.sort((a, b) => a.bbox[0] - b.bbox[0]);
        const bbox: BBox = [ss[0].bbox[0], Math.min(...ss.map((s) => s.bbox[1])), ss[ss.length - 1].bbox[2], Math.max(...ss.map((s) => s.bbox[3]))];
        return { id: 'L' + ss.map((s) => s.id).sort().join(','), pageId, strokeIds: ss.map((s) => s.id), bbox };
      });
      const bbox: BBox = [Math.min(...lines.map((l) => l.bbox[0])), lines[0].bbox[1], Math.max(...lines.map((l) => l.bbox[2])), lines[lines.length - 1].bbox[3]];
      return { id: 'B' + lines.map((l) => l.id).join('|'), pageId, lines, bbox };
    });
  },
  async recognizeBlock(block: { id: string; lines: { id: string; strokeIds: string[] }[] }, strokes: ReadonlyMap<string, Stroke>) {
    return {
      blockId: block.id,
      ms: 1,
      lines: block.lines.map((l) => {
        const ss = l.strokeIds.map((id) => strokes.get(id)!);
        const text = ss.map((s) => s.id.split(':')[1]).join('');
        return { lineId: l.id, kind: /[=\d]/.test(text) ? ('math' as const) : ('text' as const), text, latex: text, confidence: recog.conf, alternates: [], source: 'local-ink' as const, tokens: ss.map((s, i) => ({ text: text[i], strokeIds: [s.id], bbox: s.bbox, span: [i, i + 1] as [number, number] })) };
      }),
    };
  },
};

/** A tiny CAS: knows a few equations; everything else is 'unsure'. "x=5" after "2x=10" is carried. */
const TRUTH: Record<string, 'ok' | 'error'> = { '2x+3=7': 'ok', '2x=4': 'ok', 'x=2': 'ok', '2x=10': 'error', '1+1=2': 'ok', '1+1=3': 'error', 'a=3': 'ok' };
let casKnows = true;
const math = {
  checkSteps(lines: { lineId: string; text: string; kind: string }[]) {
    const out = lines.map((l, i) => {
      if (l.kind !== 'math') return { lineId: l.lineId, verdict: 'none' as const };
      if (l.text === 'x=5' && lines[i - 1]?.text === '2x=10') return { lineId: l.lineId, verdict: 'ok' as const, carried: true };
      return { lineId: l.lineId, verdict: casKnows && TRUTH[l.text] ? TRUTH[l.text] : ('unsure' as const) };
    });
    const issues = out.filter((l) => l.verdict === 'error').map((l) => {
      const t = lines.find((x) => x.lineId === l.lineId)!.text;
      const k = t.indexOf('=');
      return { lineId: l.lineId, span: [k, t.length] as [number, number], severity: 'error' as const, title: 'Not equal', detail: 'd', fix: '2x=4', source: 'local-cas' as const, confidence: 0.98, misconception: 'sign-move' };
    });
    return { lines: out, issues };
  },
  toLatex: (t: string) => t,
  evaluate(lines: { lineId: string; text: string }[], vars?: ReadonlyMap<string, string>) {
    const out: { lineId: string; value: string; latex: string }[] = [];
    for (const l of lines) {
      const m = /^([a-z\d]+)\+([a-z\d]+)=$/.exec(l.text);
      if (!m) continue;
      const v = (t: string) => Number(/\d/.test(t) ? t : vars?.get(t));
      const r = v(m[1]) + v(m[2]);
      if (Number.isFinite(r)) out.push({ lineId: l.lineId, value: String(r), latex: String(r) });
    }
    return out;
  },
  variant: () => null,
};

class FakeSession {
  id = 'nb1';
  strokes: Stroke[] = [];
  private fns = new Set<(e: { type: string; pageId?: string; stroke?: Stroke }) => void>();
  on(fn: (e: { type: string; pageId?: string }) => void) {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }
  content(id: string) {
    return id === 'p1' ? { strokes: this.strokes, objects: [] } : undefined;
  }
  add(ss: Stroke[]) {
    for (const s of ss) {
      this.strokes = [...this.strokes, s];
      for (const f of this.fns) f({ type: 'page', pageId: 'p1', stroke: s });
    }
  }
  remove(id: string) {
    this.strokes = this.strokes.filter((s) => s.id !== id);
    for (const f of this.fns) f({ type: 'page', pageId: 'p1' });
  }
}

const isVerify = (sys: string) => /verify one step/.test(sys);
const stepOf = (user: string) => /text: (.*)/.exec(user)?.[1] ?? /Step to verify:\n(.*)/.exec(user)?.[1] ?? '';
type Script = (sys: string, user: string) => string;
function provider(script: Script, latency = 0) {
  const calls: { system: string; user: string; signal?: AbortSignal }[] = [];
  const complete = async (c: unknown, req: { system: string; turns: { text: string }[]; signal?: AbortSignal }) => {
    calls.push({ system: req.system, user: req.turns[0].text, signal: req.signal });
    if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (latency)
      await new Promise((r, j) => {
        const t = setTimeout(r, latency);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          j(new DOMException('aborted', 'AbortError'));
        });
      });
    return { text: script(req.system, req.turns[0].text), truncated: false, usage: { input: 500, output: 80 }, model: 'fake' };
  };
  return { complete, calls, judges: () => calls.filter((c) => !isVerify(c.system)), verifies: () => calls.filter((c) => isVerify(c.system)) };
}

const judgeReply = (o: Record<string, unknown> = {}) => JSON.stringify({ reading_ok: true, corrected: '', latex: '', verdict: 'ok', wrong_span: '', title: '', detail: '', hint: '', fix: '', misconception: '', concept: 'Linear equations', ...o });
/** judge: 2x=10 and 1+1=3 are wrong; verify: says "no" for those when `agree`, else "yes". */
const standard = (agree: () => boolean) => (sys: string, user: string) => {
  const step = stepOf(user).trim();
  const bad = step === '2x=10' || step === '1+1=3';
  if (isVerify(sys)) return JSON.stringify({ readingOk: true, work: '', valid: bad && agree() ? 'no' : 'yes', reason: '' });
  return bad ? judgeReply({ verdict: 'error', wrong_span: step.split('=')[1], title: 'Arithmetic', detail: 'Check the numbers.', hint: 'h', fix: '2x=4', misconception: 'arithmetic' }) : judgeReply();
};

const settings = () => ({ provider: 'google', models: {}, efforts: {}, baseURLs: {}, keys: ['google'] }) as never;
const fakeCrop = async () => ({ mime: 'image/png' as const, data: 'AAAA', w: 400, h: 60 });
const memKV = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m };
};

function setup(mode: 'off' | 'local' | 'smart' | 'max', script: Script, o: { latency?: number; redMinMs?: number; kv?: ReturnType<typeof memKV>; session?: FakeSession } = {}) {
  const s = o.session ?? new FakeSession();
  const p = provider(script, o.latency ?? 0);
  const ai = new LiveAi({ settings, complete: p.complete as never, listModels: async () => [], kv: null });
  const e = new LiveEngine(s, {
    mode,
    recog: recog as never,
    math: math as never,
    ai,
    crop: fakeCrop,
    idle: (fn) => {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    },
    settleMs: 40,
    redMinMs: o.redMinMs ?? 0,
    kv: o.kv ?? null,
  });
  e.decorations('p1'); // start watching the page
  return { s, e, p };
}

const kinds = (e: InstanceType<typeof LiveEngine>) => e.decorations('p1').map((d) => `${d.kind}`).sort();
const settle = () => sleep(150);

test('Local mode makes zero AI calls, even when the CAS cannot decide', async () => {
  casKnows = false;
  const { s, e, p } = setup('local', () => judgeReply());
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await settle();
  assert.equal(p.calls.length, 0);
  assert.deepEqual(kinds(e), ['unsure', 'unsure']);
  assert.ok(e.stats().lastLocalMs! < 120, `local verdict took ${e.stats().lastLocalMs} ms`);
  e.setMode('off');
  assert.deepEqual(e.decorations('p1'), []);
  s.add(write('1', 3));
  await settle();
  assert.equal(p.calls.length, 0);
  e.dispose();
  casKnows = true;
});

test('nothing runs before the block settles; a proven error is red under the wrong part only', async () => {
  const { s, e, p } = setup('smart', () => judgeReply());
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await sleep(10);
  assert.equal(e.decorations('p1').length, 0);
  assert.ok(e.stats().pending > 0);
  await settle();
  // the CAS proved line 2 wrong on a confident reading: red, no AI needed
  assert.deepEqual(kinds(e), ['error', 'ok']);
  assert.equal(p.calls.length, 0);
  const err = e.decorations('p1').find((d) => d.kind === 'error')!;
  // the underline runs under "=10" only (strokes 3..5 of line 2), just below them
  assert.equal(err.underline.x1, 20 + 2 * 12);
  assert.equal(err.underline.x2, 20 + 4 * 12 + 9);
  assert.ok(err.underline.y > 20 + 40 + 22 && err.underline.y < 20 + 40 + 22 + 5);
  assert.equal(err.priority, 0);
  e.dispose();
});

test('red waits 900 ms after pen-up and is held while the pen is busy at that line', async () => {
  const { s, e } = setup('local', () => '', { redMinMs: 300 });
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await sleep(120); // settled and checked, but too soon for red
  assert.deepEqual(kinds(e), ['ok']);
  // the pen keeps working on that line: still held after the minimum
  const iv = setInterval(() => e.notePenActivity('p1', 90, 70), 50);
  await sleep(300);
  assert.deepEqual(kinds(e), ['ok']);
  clearInterval(iv);
  // a new line below releases it at once
  e.notePenActivity('p1', 30, 140);
  assert.deepEqual(kinds(e), ['error', 'ok']);
  // once shown, more writing nearby never hides it again
  e.notePenActivity('p1', 90, 70);
  assert.deepEqual(kinds(e), ['error', 'ok']);
  e.dispose();
});

test('Smart: undecided lines are judged one by one, cached; red only after the blind re-solve agrees', async () => {
  casKnows = false;
  let agree = false;
  const { s, e, p } = setup('smart', standard(() => agree));
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await settle();
  // one judge call per undecided step (the first line is a given, never judged); the parallel
  // re-solve disagreed on line 2: never red
  assert.equal(p.judges().length, 1);
  assert.ok(p.judges().every((c) => /Recogniser reading of the new step/.test(c.user)));
  assert.ok(!kinds(e).includes('error'));
  const st = e.stats();
  assert.ok(st.tokensIn >= 1000 && st.tokensOut >= 160);
  assert.ok(st.lastMs != null);

  // erase a stroke of line 2: its mark goes at once, before anything is re-checked
  agree = true;
  const last = s.strokes[s.strokes.length - 1];
  s.remove(last.id);
  await sleep(5);
  assert.equal(e.decorations('p1').filter((d) => d.lineId.includes(last.id)).length, 0);
  // rewrite it: line 1 comes from the cache, only line 2 is judged again; now the re-solve agrees
  const before = p.judges().length;
  s.add([glyph('0', 4, 1)]);
  await settle();
  const err = e.decorations('p1').find((d) => d.kind === 'error');
  assert.ok(err, 'confirmed error is red');
  assert.equal(err.underline.x1, 20 + 3 * 12);
  assert.equal(err.title, 'Arithmetic');
  assert.ok(p.judges().length - before <= 2);
  const ins = e.insightAt('p1', err.underline.x1 + 2, err.bbox[1] + 5)!;
  assert.equal(ins.focusLineId, err.lineId);
  const issue = ins.check?.issues.find((i) => i.severity === 'error');
  assert.equal(issue?.source, 'ai-verified');
  assert.equal(issue?.misconception, 'arithmetic');
  e.dispose();
  casKnows = true;
});

test('Smart skips lines the CAS decided; Max judges them too', async () => {
  const { s, e, p } = setup('smart', standard(() => true));
  s.add(write('1+1=2', 0));
  s.add(write('1+1=2', 1));
  await settle();
  assert.equal(p.calls.length, 0);
  e.setMode('max');
  await settle();
  assert.equal(p.judges().length, 1);
  e.dispose();
});

test('first error only; a carried line gets no mark', async () => {
  casKnows = false;
  const { s, e } = setup('smart', standard(() => true));
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  s.add(write('1+1=3', 2));
  await settle();
  const ds = e.decorations('p1');
  assert.equal(ds.filter((d) => d.kind === 'error').length, 1, 'only the first error is red');
  const c = e.check(e.blockFor('p1', [0, 0, 999, 999])!.id)!;
  assert.equal(c.lines.filter((l) => l.verdict === 'error').length, 2, 'the card still knows both');
  casKnows = true;
  e.dispose();
  const t = setup('local', () => '');
  t.s.add(write('2x+3=7', 0));
  t.s.add(write('2x=10', 1));
  t.s.add(write('x=5', 2));
  await settle();
  const lines = t.e.decorations('p1').map((d) => d.lineId);
  const carriedLine = t.e.check(t.e.blockFor('p1', [0, 0, 999, 999])!.id)!.lines.find((l) => l.carried)!;
  assert.ok(carriedLine, 'the CAS marks x=5 as carried');
  assert.ok(!lines.includes(carriedLine.lineId), 'no mark (not even a tick) on a carried line');
  t.e.dispose();
});

test('a block that changes while its AI check runs is cancelled; the stale result is dropped', async () => {
  casKnows = false;
  const { s, e, p } = setup('smart', standard(() => true), { latency: 300 });
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await sleep(110);
  assert.ok(p.calls.length >= 1);
  s.add(write('+', 2));
  await sleep(20);
  assert.ok(p.calls.every((c) => c.signal?.aborted), 'every call of the old block was aborted');
  await sleep(1000);
  for (const d of e.decorations('p1')) assert.equal(d.blockId, e.blockFor('p1', [0, 0, 999, 999])!.id);
  e.dispose();
  casKnows = true;
});

test('offline: the local verdict stands and the pill says so', async () => {
  casKnows = false;
  const s = new FakeSession();
  const ai = new LiveAi({ settings, complete: (async () => { throw new Error('Could not reach the AI provider: dns error'); }) as never, listModels: async () => [], kv: null });
  const e = new LiveEngine(s, { mode: 'smart', recog: recog as never, math: math as never, ai, crop: fakeCrop, idle: (fn) => (setTimeout(fn, 0), () => {}), settleMs: 20, redMinMs: 0, kv: null });
  e.decorations('p1');
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await settle();
  assert.deepEqual(kinds(e), ['unsure', 'unsure']);
  assert.equal(e.stats().state, 'offline');
  e.dispose();
  casKnows = true;
});

test('recheck with a corrected reading uses the text and the CAS', async () => {
  recog.conf = 0.5; // shaky reading: a local error alone is only amber
  const { s, e } = setup('local', () => '');
  try {
    s.add(write('2x+3=7', 0));
    s.add(write('2x=1O', 1)); // misread "10" as "1O"
    await settle();
    const b = e.blockFor('p1', [0, 0, 999, 999])!;
    assert.ok(!kinds(e).includes('error'));
    const c = await e.recheck(b.id, '2x=10', b.lines[1].id);
    assert.equal(c?.lines[1].verdict, 'error');
    assert.equal(c?.recognition.lines[1].text, '2x=10');
    assert.ok(kinds(e).includes('error'));
  } finally {
    recog.conf = 0.95;
    e.dispose();
  }
});

test('live results after a trailing "=", with variables from earlier lines', async () => {
  const { s, e } = setup('local', () => '');
  s.add(write('a=3', 0));
  s.add(write('2+a=', 3)); // a separate block below
  await settle();
  const r = e.decorations('p1').find((d) => d.kind === 'result');
  assert.ok(r, 'a result mark');
  assert.equal(r.text, '5');
  assert.ok(r.bbox[0] > 20 + 3 * 12, 'to the right of the line');
  e.dispose();
});

test('mistake journal: confirmed errors are kept per notebook, grouped, and become flashcards', async () => {
  const kv = memKV();
  const { s, e } = setup('local', () => '', { kv });
  let journalEvents = 0;
  e.subscribe((ev) => ev.type === 'journal' && journalEvents++);
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await settle();
  assert.equal(e.journal().length, 1);
  assert.equal(journalEvents, 1);
  const j = e.journal()[0];
  assert.equal(j.misconception, 'sign-move');
  assert.equal(j.text, '2x=10');
  const pat = e.patterns();
  assert.equal(pat[0].misconception, 'sign-move');
  assert.equal(pat[0].count, 1);
  assert.match(pat[0].rule, /changes its sign/);
  const cards = e.journalCards();
  assert.ok(cards.some((c) => /What is wrong with this step\? \$2x=10\$/.test(c.front) && /2x=4/.test(c.back)));
  assert.ok(cards.some((c) => /what is the rule/.test(c.front)));
  // the same mistake again (undo/redo) is not recorded twice; the journal survives a reload
  const s2 = new FakeSession();
  const again = setup('local', () => '', { kv, session: s2 });
  assert.equal(again.e.journal().length, 1);
  e.dispose();
  again.e.dispose();
});

test('exam mode hides every mark until reveal; a paused page shows and checks nothing', async () => {
  const kv = memKV();
  const { s, e } = setup('local', () => '', { kv });
  e.setExamMode(true);
  s.add(write('2x+3=7', 0));
  s.add(write('2x=10', 1));
  await settle();
  assert.deepEqual(e.decorations('p1'), []);
  assert.equal(e.check(e.blockFor('p1', [0, 0, 999, 999])!.id)?.lines[1].verdict, 'error', 'checked in the background');
  e.reveal();
  assert.deepEqual(kinds(e), ['error', 'ok']);
  e.setExamMode(false);
  e.pausePage('p1', true);
  assert.deepEqual(e.decorations('p1'), []);
  s.add(write('1+1=3', 3));
  await settle();
  assert.equal(e.blockFor('p1', [0, 100, 999, 200]), null, 'nothing new is grouped on a paused page');
  assert.ok(e.isPaused('p1'));
  e.pausePage('p1', false);
  await settle();
  assert.ok(kinds(e).filter((k) => k === 'error').length >= 1);
  e.dispose();
});

test('deictic: "why?" refers to the block under the pen, else the one written in the last 10 s', async () => {
  const { s, e } = setup('local', () => '');
  s.add(write('1+1=2', 0));
  s.add(write('2x=4', 4));
  await settle();
  const last = e.resolveDeictic();
  assert.equal(last?.block.lines[0].strokeIds.length, 4, 'the last written block (2x=4)');
  e.notePenActivity('p1', 30, 30);
  assert.equal(e.resolveDeictic()?.block.lines[0].strokeIds.length, 5, 'the block under the pen (1+1=2)');
  e.dispose();
});

test('mode gating and geometry helpers', () => {
  // a premise line first: the first line of a block is a given and never judged
  const line0 = { lineId: 'p', kind: 'math' as const, text: 'p', latex: '', confidence: 1, alternates: [], tokens: [], source: 'local-ink' as const };
  const rec = (kind: 'math' | 'text', confidence = 0.95) => ({ blockId: 'b', ms: 0, lines: [line0, { lineId: 'l', kind, text: 't', latex: '', confidence, alternates: [], tokens: [], source: 'local-ink' as const }] });
  const loc = (v: 'ok' | 'error' | 'unsure' | 'none', carried = false) => ({ lines: [{ lineId: 'l', verdict: v, carried }], issues: v === 'error' ? [{ lineId: 'l', span: null, severity: 'error' as const, title: '', detail: '', source: 'local-cas' as const, confidence: 0.99 }] : [] });
  assert.equal(needsAi('local', rec('math'), loc('unsure')), false);
  assert.equal(needsAi('off', rec('math'), loc('unsure')), false);
  assert.equal(needsAi('smart', rec('math'), loc('unsure')), true);
  assert.equal(needsAi('smart', rec('math'), loc('ok')), false);
  assert.equal(needsAi('smart', rec('text'), loc('none')), false);
  assert.equal(needsAi('smart', rec('math', 0.5), loc('error')), true);
  assert.equal(needsAi('smart', rec('math', 0.95), loc('error')), false);
  assert.equal(needsAi('smart', rec('math'), loc('unsure', true)), false, 'carried lines are not judged');
  assert.equal(needsAi('max', rec('text'), loc('none')), true);
  assert.equal(linesToJudge('max', rec('math', 0.95), loc('error')).length, 0, 'a proven error is final even in Max');
  const lone = { blockId: 'b', ms: 0, lines: [{ ...line0, lineId: 'l' }] };
  assert.equal(needsAi('smart', lone, loc('unsure')), false, 'a lone line is a given, not a step');
  const line = { id: 'l', pageId: 'p', strokeIds: [], bbox: [0, 0, 100, 20] as BBox };
  const g = markGeometry(line, undefined, null);
  assert.deepEqual([g.underline.x1, g.underline.x2], [0, 100]);
  assert.ok(g.underline.y > 20);
});
