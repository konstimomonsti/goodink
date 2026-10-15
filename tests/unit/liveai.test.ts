// Live Ink AI layer: JSON repair and validation, span mapping, the red-mark policy, cache keys,
// model routing, failover, token accounting, verification and streaming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// the app's modules import each other without extensions (Vite style); resolve those to .ts here
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

const J = await import('../../src/renderer/live/ai/json.ts');
const M = await import('../../src/renderer/live/ai/merge.ts');
const H = await import('../../src/renderer/live/ai/hash.ts');
const C = await import('../../src/renderer/live/ai/cache.ts');
const R = await import('../../src/renderer/live/ai/router.ts');
const K = await import('../../src/renderer/live/ai/check.ts');
const S = await import('../../src/renderer/live/ai/service.ts');
const ST = await import('../../src/renderer/live/ai/stream.ts');
const P = await import('../../src/renderer/live/ai/policy.ts');
const CR = await import('../../src/renderer/live/ai/crop.ts');
const { default: OpenAI } = await import('openai');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- JSON ---------------------------------------------------------------------------------------

const judgeObj = (o: Record<string, unknown>) => ({ reading_ok: true, corrected: '', latex: '', verdict: 'ok', wrong_span: '', title: '', detail: '', hint: '', fix: '', misconception: '', concept: 'Linear equations', ...o });
const judgeJson = (o: Record<string, unknown>) => JSON.stringify(judgeObj(o));

test('clean structured judge output parses', () => {
  const j = J.parseAiJudge(judgeJson({ latex: '2x=10', verdict: 'error', wrong_span: '10', title: 'Subtraction error', detail: 'Subtract 3: $7-3$.', hint: 'h', fix: '2x=4', misconception: 'sign-move' }), '2x=10');
  assert.ok(j);
  assert.equal(j.verdict, 'error');
  assert.equal(j.wrongSpan, '10');
  assert.equal(j.misconception, 'sign-move');
  assert.equal(j.readingOk, true);
  assert.equal(j.corrected, '');
  assert.equal(j.concept, 'Linear equations');
});

test('a corrected reading is kept; the same reading counts as ok', () => {
  const j = J.parseAiJudge(judgeJson({ reading_ok: false, corrected: 'x=±3', verdict: 'ok' }), 'x=3');
  assert.equal(j?.readingOk, false);
  assert.equal(j?.corrected, 'x=±3');
  const same = J.parseAiJudge(judgeJson({ reading_ok: false, corrected: '2x = 4', verdict: 'ok' }), '2x=4');
  assert.equal(same?.readingOk, true);
  assert.equal(same?.corrected, '');
  // the wrong part is quoted from the corrected reading
  const k = J.parseAiJudge(judgeJson({ reading_ok: false, corrected: '2x=12', verdict: 'error', wrong_span: '12', title: 'T' }), '2x=1Z');
  assert.equal(k?.wrongSpan, '12');
});

test('fences, prose, trailing commas and single-backslash LaTeX are repaired', () => {
  const raw = 'Here is the check:\n```json\n{"reading_ok":true,"corrected":"","latex":"x=\\frac{4}{2}","verdict":"error","wrong_span":"4/2","title":"Root","detail":"Take $\\sqrt{4}$, not half.","hint":"","fix":"x=\\pm 2","misconception":"root-sign","concept":"roots",}\n```';
  const j = J.parseAiJudge(raw, 'x=4/2');
  assert.ok(j);
  assert.equal(j.latex, 'x=\\frac{4}{2}');
  assert.equal(j.detail, 'Take $\\sqrt{4}$, not half.');
  assert.equal(j.fix, 'x=\\pm 2');
});

test('a reply cut off at the token limit still yields the verdict', () => {
  const full = judgeJson({ verdict: 'error', wrong_span: '10', title: 'Oops', detail: 'This is a long explanation that gets cut' });
  const j = J.parseAiJudge(full.slice(0, full.indexOf('gets cut')), '2x=10');
  assert.equal(j?.verdict, 'error');
  assert.equal(j?.title, 'Oops');
  assert.equal((J.parseLooseJson('{"a":1,"b"') as { a: number }).a, 1);
});

test('aliases and verdict words are normalised; unplaceable quotes and unexplained errors are dropped', () => {
  assert.equal(J.parseAiJudge('{"status":"Correct"}', '3x=9')?.verdict, 'ok');
  const a = J.parseAiJudge('{"status":"wrong","wrongSpan":"x=5"}', 'x=4');
  assert.equal(a?.verdict, 'unsure'); // quote not in the reading, and no explanation
  assert.equal(a?.wrongSpan, '');
  const b = J.parseAiJudge('{"verdict":"incorrect","error":"Wrong value","span":"=1","tag":"Arithmetic!"}', 'y=1');
  assert.equal(b?.verdict, 'error');
  assert.equal(b?.title, 'Wrong value');
  assert.equal(b?.misconception, 'arithmetic');
  // an ok verdict never carries an explanation or a fix
  const c = J.parseAiJudge(judgeJson({ verdict: 'ok', title: 'x', fix: 'y' }), 'a=1');
  assert.deepEqual([c?.title, c?.fix], ['', '']);
});

test('garbage is null, never a guess', () => {
  assert.equal(J.parseAiJudge('I cannot read this image.', 'x'), null);
  assert.equal(J.parseAiJudge('{"lines": []}', 'x'), null);
  assert.equal(J.parseAiJudge('', 'x'), null);
});

test('verification replies parse, including loose forms', () => {
  assert.deepEqual(J.parseAiVerify('{"readingOk":true,"work":"7-3=4","valid":"no","reason":"7-3 is 4"}'), { readingOk: true, valid: false, gap: '', reason: '7-3 is 4' });
  assert.equal(J.parseAiVerify('{"valid":"yes"}')?.valid, true);
  assert.equal(J.parseAiVerify('{"valid":"unsure","readingOk":false}')?.valid, null);
  assert.equal(J.parseAiVerify('{"valid":false,"readingOk":"no"}')?.readingOk, false);
  assert.equal(J.parseAiVerify('nope'), null);
});

// ---- spans --------------------------------------------------------------------------------------

test('wrong part maps onto the recognised line text', () => {
  assert.deepEqual(J.mapSpan('2x+3=7', '2x+3=7', '+3'), [2, 4]);
  // spaces and symbol variants differ between the readings
  assert.deepEqual(J.mapSpan('2x = 10', '2x=10', '=10'), [3, 7]);
  assert.deepEqual(J.mapSpan('x-3=4', 'x − 3 = 4', '− 3'), [1, 3]);
  assert.deepEqual(J.mapSpan('2*x=6', '2x=6', '2x'), [0, 3]);
  // not in the line at all: whole line
  assert.equal(J.mapSpan('2x=10', '2x=4', 'y'), null);
  assert.equal(J.mapSpan('2x=10', '2x=10', ''), null);
});

test('with several matches the one at the same relative place wins', () => {
  // "x" appears three times; the AI meant the last one
  const s = J.mapSpan('x+x=2x', 'x+x=2x', '2x');
  assert.deepEqual(s, [4, 6]);
  const t = J.mapSpan('3+3=7', '3 + 3 = 7', '3');
  assert.deepEqual(t, [0, 1]);
});

test('lines are aligned by position or by similarity', () => {
  assert.deepEqual(J.alignLines(['a=1', 'b=2'], ['a=1', 'b=3']), [0, 1]);
  assert.deepEqual(J.alignLines(['2x+3=7', '2x=4', 'x=2'], ['2x+3=7', 'x=2']), [0, -1, 1]);
  assert.ok(J.similarity('2x + 3 = 7', '2x+3=7') === 1);
});

// ---- merge policy -------------------------------------------------------------------------------

// every block starts with a premise line 'p0' (a block's first line is a given, never red)
const rec = (lines: { id: string; text: string; conf: number; kind?: 'math' | 'text' }[]) => ({
  blockId: 'b',
  ms: 1,
  lines: [{ id: 'p0', text: 'given', conf: 1 }, ...lines].map((l) => ({ lineId: l.id, kind: l.kind ?? 'math', text: l.text, latex: l.text, confidence: l.conf, alternates: [], tokens: [], source: 'local-ink' as const })),
});
const casIssue = (lineId: string, confidence = 0.97) => ({ lineId, span: [0, 1] as [number, number], severity: 'error' as const, title: 'Wrong', detail: 'd', source: 'local-cas' as const, confidence });
const aiLine = (lineId: string, verdict: 'ok' | 'error' | 'unsure', confirmed = false, refuted = false) => ({ lineId, verdict, confirmed, refuted, reading: 'r', span: null, title: verdict === 'ok' ? '' : 'T', detail: verdict === 'ok' ? '' : 'D', hint: 'h', fix: 'f' });
const ai = (lines: ReturnType<typeof aiLine>[]) => ({ lines, concept: 'c', finalAnswer: '', tokens: { input: 10, output: 5 }, model: 'm', cached: false });
const merge = (r: ReturnType<typeof rec>, local: { lines: { lineId: string; verdict: 'ok' | 'error' | 'unsure' | 'none' | 'pending' }[]; issues: ReturnType<typeof casIssue>[] }, a: ReturnType<typeof ai> | null) =>
  M.mergeCheck({ blockId: 'b', pageId: 'p', recognition: r, local, ai: a, ms: 1, via: a ? 'ai' : 'local' });
const verdicts = (c: { lines: { lineId: string; verdict: string }[] }) => c.lines.filter((l) => l.lineId !== 'p0').map((l) => l.verdict);

test('CAS error on a confident reading is red and final, whatever the AI says', () => {
  const c = merge(rec([{ id: 'a', text: '2x=10', conf: 0.95 }]), { lines: [{ lineId: 'a', verdict: 'error' }], issues: [casIssue('a')] }, ai([aiLine('a', 'ok')]));
  assert.deepEqual(verdicts(c), ['error']);
  assert.equal(c.issues[0].source, 'local-cas');
});

test('CAS error on a shaky reading is only amber without AI', () => {
  const c = merge(rec([{ id: 'a', text: '2x=10', conf: 0.6 }]), { lines: [{ lineId: 'a', verdict: 'error' }], issues: [casIssue('a')] }, null);
  assert.deepEqual(verdicts(c), ['unsure']);
  assert.equal(c.issues[0].severity, 'unsure');
});

test('AI error turns red only when independently confirmed', () => {
  const r = rec([{ id: 'a', text: '?', conf: 0.3 }]);
  const local = { lines: [{ lineId: 'a', verdict: 'unsure' as const }], issues: [] };
  assert.deepEqual(verdicts(merge(r, local, ai([aiLine('a', 'error')]))), ['unsure']);
  const ok = merge(r, local, ai([aiLine('a', 'error', true)]));
  assert.deepEqual(verdicts(ok), ['error']);
  assert.equal(ok.issues[0].source, 'ai-verified');
  // refuted by the second opinion: not wrong
  assert.deepEqual(verdicts(merge(r, local, ai([aiLine('a', 'error', false, true)]))), ['ok']);
  // confirmed and refuted at once (CAS vs verifier): never red
  assert.deepEqual(verdicts(merge(r, local, ai([aiLine('a', 'error', true, true)]))), ['unsure']);
});

test('AI settles what the CAS left open but does not overrule a local error', () => {
  const r = rec([{ id: 'a', text: 'x', conf: 0.5 }, { id: 'b', text: 'y', conf: 0.5 }]);
  const c = merge(r, { lines: [{ lineId: 'a', verdict: 'unsure' }, { lineId: 'b', verdict: 'error' }], issues: [casIssue('b', 0.95)] }, ai([aiLine('a', 'ok'), aiLine('b', 'ok')]));
  assert.deepEqual(verdicts(c), ['ok', 'unsure']);
});

test('property: no red mark ever without a confident CAS proof or a confirmed AI error', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  for (let n = 0; n < 3000; n++) {
    const ids = ['a', 'b', 'c'].slice(0, 1 + Math.floor(rnd() * 3));
    const r = rec(ids.map((id) => ({ id, text: id, conf: rnd() })));
    const lv = ids.map((id) => ({ lineId: id, verdict: pick(['ok', 'error', 'unsure', 'none', 'pending'] as const) }));
    const issues = lv.filter((l) => l.verdict === 'error' && rnd() < 0.8).map((l) => casIssue(l.lineId, rnd()));
    const a = rnd() < 0.7 ? ai(ids.filter(() => rnd() < 0.8).map((id) => aiLine(id, pick(['ok', 'error', 'unsure'] as const), rnd() < 0.5, rnd() < 0.3))) : null;
    const c = merge(r, { lines: lv, issues }, a);
    for (const l of c.lines) {
      if (l.verdict !== 'error') continue;
      const conf = r.lines.find((x) => x.lineId === l.lineId)!.confidence;
      const A = a?.lines.find((x) => x.lineId === l.lineId);
      const casProof = lv.find((x) => x.lineId === l.lineId)!.verdict === 'error' && conf >= M.CONFIDENT_READING && issues.some((i) => i.lineId === l.lineId && i.confidence >= M.CONFIDENT_CAS);
      const aiProof = !!A && A.verdict === 'error' && A.confirmed && !A.refuted;
      assert.ok(casProof || aiProof, `unconfirmed red on ${JSON.stringify({ l, conf, A, lv })}`);
      assert.ok(c.issues.some((i) => i.lineId === l.lineId && i.severity === 'error'));
    }
    for (const i of c.issues) if (i.severity === 'error') assert.ok(i.source === 'ai-verified' || i.source === 'local-cas');
  }
});

test('enforceRedPolicy demotes a forged red mark', () => {
  const r = rec([{ id: 'a', text: 'x', conf: 0.99 }]);
  const forged = { blockId: 'b', pageId: 'p', recognition: r, lines: [{ lineId: 'a', verdict: 'error' as const }], issues: [{ ...casIssue('a'), source: 'ai' as const }], via: 'ai' as const, ms: 0 };
  const c = M.enforceRedPolicy(forged);
  assert.equal(c.lines[0].verdict, 'unsure');
  assert.equal(c.issues[0].severity, 'unsure');
  const noIssue = M.enforceRedPolicy({ ...forged, issues: [] });
  assert.equal(noIssue.lines[0].verdict, 'unsure');
});

// ---- cache keys ---------------------------------------------------------------------------------

const stroke = (id: string, x: number, y: number, n = 4) => {
  const pts = new Float32Array(n * 3).map((_, i) => (i % 3 === 0 ? x + i : i % 3 === 1 ? y + i / 2 : 0.5));
  return { id, kind: 'pen' as const, color: '#000', width: 1.5, pts, bbox: [x, y, x + 10, y + 12] as [number, number, number, number] };
};
const block = (strokes: ReturnType<typeof stroke>[]) => {
  const bbox: [number, number, number, number] = [Math.min(...strokes.map((s) => s.bbox[0])), Math.min(...strokes.map((s) => s.bbox[1])), Math.max(...strokes.map((s) => s.bbox[2])), Math.max(...strokes.map((s) => s.bbox[3]))];
  return { id: 'blk', pageId: 'p', bbox, lines: [{ id: 'l1', pageId: 'p', strokeIds: strokes.map((s) => s.id), bbox }] };
};

test('content key: stable for the same ink, moved as a whole; changes when a stroke changes', () => {
  const a = [stroke('s1', 10, 10), stroke('s2', 25, 10)];
  const k1 = H.blockKey(block(a), new Map(a.map((s) => [s.id, s])));
  const again = H.blockKey(block([...a].reverse()), new Map(a.map((s) => [s.id, s])));
  assert.equal(k1, again);
  const moved = [stroke('s1', 110, 60), stroke('s2', 125, 60)];
  assert.equal(H.blockKey(block(moved), new Map(moved.map((s) => [s.id, s]))), k1);
  const nudged = [stroke('s1', 10, 10), stroke('s2', 27, 10)];
  assert.notEqual(H.blockKey(block(nudged), new Map(nudged.map((s) => [s.id, s]))), k1);
  const more = [...a, stroke('s3', 40, 10)];
  assert.notEqual(H.blockKey(block(more), new Map(more.map((s) => [s.id, s]))), k1);
  assert.equal(H.hash53('abc'), H.hash53('abc'));
  assert.notEqual(H.hash53('abc'), H.hash53('abd'));
});

test('LRU evicts the least recently used; the persistent one survives a reload', async () => {
  const l = new C.Lru<number>(2);
  l.set('a', 1);
  l.set('b', 2);
  l.get('a');
  l.set('c', 3);
  assert.equal(l.has('b'), false);
  assert.equal(l.get('a'), 1);
  const store = new Map<string, string>();
  const kv = { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string) => void store.set(k, v) };
  const p = new C.PersistentLru<{ v: number }>(kv, 'k', 10);
  p.set('x', { v: 1 });
  p.save();
  const q = new C.PersistentLru<{ v: number }>(kv, 'k', 10);
  assert.deepEqual(q.get('x'), { v: 1 });
  store.set('k', '{broken');
  assert.equal(new C.PersistentLru(kv, 'k').size, 0);
});

// ---- routing ------------------------------------------------------------------------------------

test('cheapest fast vision model and strongest model per provider', () => {
  const g = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite-preview-09', 'gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts'];
  assert.equal(R.pickModel('google', g, 'fast', 'gemini-flash-latest'), 'gemini-3.5-flash-lite');
  assert.equal(R.pickModel('google', g, 'strong', 'gemini-flash-latest'), 'gemini-2.5-pro');
  const a = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5'];
  assert.equal(R.pickModel('anthropic', a, 'fast', 'claude-opus-5-5'), 'claude-haiku-5-5');
  assert.equal(R.pickModel('anthropic', a, 'strong', 'claude-opus-5-5'), 'claude-sonnet-5-5');
  const o = ['gpt-5', 'gpt-5-mini', 'gpt-5.5-mini', 'gpt-5-nano', 'gpt-4o-mini-audio-preview', 'gpt-5.5'];
  assert.equal(R.pickModel('openai', o, 'fast', 'gpt-5.5'), 'gpt-5.5-mini');
  assert.equal(R.pickModel('openai', o, 'strong', 'gpt-5.5'), 'gpt-5.5');
  // unknown provider or empty list: the user's model
  assert.equal(R.pickModel('ollama', ['llava'], 'fast', 'qwen-vl'), 'qwen-vl');
  assert.equal(R.pickModel('google', [], 'fast', 'gemini-flash-latest'), 'gemini-flash-latest');
  assert.equal(R.effortFor('anthropic', 'fast'), '');
  assert.equal(R.effortFor('google', 'fast'), 'none');
  assert.equal(R.effortFor('openai', 'fast'), 'none');
});

test('breaker: back-off doubles, success resets, auth pauses long', () => {
  let t = 0;
  const b = new R.Breaker(() => t);
  b.fail('google', 'busy');
  assert.equal(b.allow('google'), false);
  t += 20_001;
  assert.equal(b.allow('google'), true);
  b.fail('google', 'busy');
  t += 20_001;
  assert.equal(b.allow('google'), false);
  t += 20_000;
  assert.equal(b.allow('google'), true);
  b.ok('google');
  b.fail('google', 'abort');
  assert.equal(b.allow('google'), true);
  b.fail('anthropic', 'auth');
  t += 5 * 60_000;
  assert.equal(b.allow('anthropic'), false);
});

// ---- fake providers -----------------------------------------------------------------------------

type Req = { system: string; turns: { role: string; text: string }[]; maxTokens: number; json?: unknown; signal?: AbortSignal; onDelta?: (d: string) => void; images?: unknown[]; cacheSystem?: boolean };
type Choice = { provider: string; model: string; effort: string };

const settings = (keys: string[], provider = keys[0]) => ({ provider, models: { google: 'gemini-flash-latest', anthropic: 'claude-opus-5-5', openai: 'gpt-5.5' }, efforts: { google: 'high', anthropic: 'high' }, baseURLs: {}, keys }) as never;

function fakeComplete(script: (c: Choice, req: Req) => { text: string; usage?: { input: number; output: number } | null; delay?: number } | Error) {
  const calls: { c: Choice; req: Req; t: number; end?: number; aborted?: boolean }[] = [];
  const t0 = Date.now();
  const fn = async (c: Choice, req: Req) => {
    const rec: (typeof calls)[number] = { c, req, t: Date.now() - t0 };
    calls.push(rec);
    if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const r = script(c, req);
    if (r instanceof Error) throw r;
    if (r.delay)
      await new Promise((ok, no) => {
        const t = setTimeout(ok, r.delay);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rec.aborted = true;
          no(new DOMException('aborted', 'AbortError'));
        });
      });
    rec.end = Date.now() - t0;
    if (req.onDelta) for (let i = 0; i < r.text.length; i += 7) req.onDelta(r.text.slice(i, i + 7));
    return { text: r.text, truncated: false, usage: r.usage === undefined ? { input: 400, output: 120 } : r.usage, model: c.model };
  };
  return { fn: fn as never, calls };
}

const rateLimit = () => new OpenAI.RateLimitError(429, { message: 'slow down' }, 'slow down', new Headers());

const img = { mime: 'image/png' as const, data: 'AAAA', w: 600, h: 120 };
const isVerify = (req: Req) => /verify one step/.test(req.system);
const recLine = (id: string, text: string, conf = 0.9) => ({ lineId: id, kind: 'math' as const, text, latex: text, confidence: conf, alternates: [], tokens: [], source: 'local-ink' as const });
const judgeIn = (o: Partial<Parameters<typeof K.judgeLine>[1]> = {}) => ({ line: recLine('b', '2x=10'), prior: [recLine('a', '2x+3=7')], image: img, localVerdict: 'unsure' as const, tier: 'fast' as const, verifyTier: 'fast' as const, ...o });
const wrong = judgeJson({ latex: '2x=10', verdict: 'error', wrong_span: '10', title: 'Subtraction error', detail: 'Moving $+3$ across should subtract it.', hint: 'What is $7-3$?', fix: '2x=4', misconception: 'sign-move' });

test('judge: the cloud judges the local reading; the blind re-solve runs in parallel and never sees the verdict', async () => {
  const { fn, calls } = fakeComplete((_, req) => (isVerify(req) ? { text: '{"readingOk":true,"work":"2x=7-3=4","valid":"no","reason":"7-3=4"}', delay: 40 } : { text: wrong, delay: 40 }));
  const ai = new S.LiveAi({ settings: () => settings(['google']), complete: fn, listModels: async () => ['gemini-3.5-flash-lite'], kv: null });
  const out = await ai.judge('k1', judgeIn());
  assert.ok(out);
  assert.equal(out.outcome.confirmed, true);
  assert.deepEqual(out.outcome.span, [3, 5]);
  assert.equal(out.outcome.misconception, 'sign-move');
  assert.equal(calls.length, 2);
  const judge = calls.find((c) => !isVerify(c.req))!;
  const verify = calls.find((c) => isVerify(c.req))!;
  // parallel: the re-solve started before the judge answered
  assert.ok(verify.t < judge.end!, `verify started at ${verify.t} ms, judge ended at ${judge.end} ms`);
  // the judge gets the local reading as text, the earlier steps as text, one crop, a static cached prompt
  assert.match(judge.req.turns[0].text, /text: 2x=10/);
  assert.match(judge.req.turns[0].text, /2x\+3=7/);
  assert.equal(judge.req.images?.length, 1);
  assert.equal(judge.req.cacheSystem, true);
  assert.ok(judge.req.json, 'structured output requested');
  assert.ok(judge.req.maxTokens <= 400, `small output budget, got ${judge.req.maxTokens}`);
  // thinking off for the judge (the user's 'high' effort is not used)
  assert.equal(judge.c.effort, 'none');
  assert.equal(judge.c.model, 'gemini-3.5-flash-lite');
  assert.ok(!/Subtraction error|Moving|What is|error/i.test(JSON.stringify(verify.req.turns)), 'the verifier must not see the verdict');
  // same content again: the cache answers, nothing is sent
  const again = await ai.judge('k1', judgeIn());
  assert.equal(calls.length, 2);
  assert.deepEqual(again?.tokens, { input: 0, output: 0 });
  assert.equal(again?.outcome.confirmed, true);
});

test('judge: nothing wrong => the parallel re-solve is aborted', async () => {
  const { fn, calls } = fakeComplete((_, req) => (isVerify(req) ? { text: '{"valid":"yes","readingOk":true}', delay: 300 } : { text: judgeJson({ latex: '2x=4' }), delay: 10 }));
  const ai = new S.LiveAi({ settings: () => settings(['google']), complete: fn, listModels: async () => [], kv: null });
  const out = await ai.judge('k', judgeIn({ line: recLine('b', '2x=4') }));
  assert.equal(out?.outcome.verdict, 'ok');
  await sleep(20);
  assert.equal(calls.find((c) => isVerify(c.req))?.aborted, true);
});

test('judge: cross-vendor re-solve when two providers are ready', async () => {
  const { fn, calls } = fakeComplete((_, req) => (isVerify(req) ? { text: '{"valid":"no","readingOk":true}' } : { text: wrong }));
  const ai = new S.LiveAi({ settings: () => settings(['google', 'anthropic']), complete: fn, listModels: async (c) => (c.provider === 'anthropic' ? ['claude-haiku-5-5'] : ['gemini-3.5-flash-lite']), kv: null });
  await ai.judge('k', judgeIn());
  assert.equal(calls.find((c) => !isVerify(c.req))?.c.provider, 'google');
  assert.equal(calls.find((c) => isVerify(c.req))?.c.provider, 'anthropic');
  assert.equal(calls.find((c) => isVerify(c.req))?.c.model, 'claude-haiku-5-5');
});

test('judge: a re-solve that disagrees, or a CAS that finds the reading correct, keeps it from red', async () => {
  const yes = fakeComplete((_, req) => (isVerify(req) ? { text: '{"readingOk":true,"valid":"yes"}' } : { text: wrong }));
  const ai = new S.LiveAi({ settings: () => settings(['google']), complete: yes.fn, listModels: async () => [], kv: null });
  const a = await ai.judge('k', judgeIn());
  assert.equal(a?.outcome.refuted, true);
  assert.equal(a?.outcome.confirmed, false);
  const no = fakeComplete((_, req) => (isVerify(req) ? { text: '{"readingOk":true,"valid":"no"}' } : { text: wrong }));
  const ai2 = new S.LiveAi({ settings: () => settings(['google']), complete: no.fn, listModels: async () => [], kv: null });
  const b = await ai2.judge('k', judgeIn({ checkSteps: (lines) => ({ lines: lines.map((l) => ({ lineId: l.lineId, verdict: 'ok' as const })), issues: [] }) }));
  assert.equal(b?.outcome.refuted, true);
  assert.equal(b?.outcome.confirmed, false);
  const merged = M.mergeCheck({ blockId: 'x', pageId: 'p', recognition: rec([{ id: 'b', text: '2x=10', conf: 0.9 }]), local: { lines: [{ lineId: 'b', verdict: 'unsure' }], issues: [] }, ai: { lines: [b!.outcome], concept: '', finalAnswer: '', tokens: b!.tokens, model: 'm', cached: false }, ms: 0, via: 'ai' });
  assert.notEqual(merged.lines[0].verdict, 'error');
});

test('judge: a corrected reading is re-solved on the corrected text', async () => {
  const { fn, calls } = fakeComplete((_, req) =>
    isVerify(req) ? { text: /2x=12/.test(req.turns[0].text) ? '{"readingOk":true,"valid":"no"}' : '{"readingOk":false,"valid":"unsure"}' } : { text: judgeJson({ reading_ok: false, corrected: '2x=12', verdict: 'error', wrong_span: '12', title: 'T', detail: 'd' }) },
  );
  const ai = new S.LiveAi({ settings: () => settings(['google']), complete: fn, listModels: async () => [], kv: null });
  const out = await ai.judge('k', judgeIn({ line: recLine('b', '2x=1Z') }));
  assert.equal(out?.outcome.corrected, '2x=12');
  assert.equal(out?.outcome.confirmed, true);
  assert.equal(calls.filter((c) => isVerify(c.req)).length, 2);
});

test('judge: malformed JSON is retried once; still garbage => null and nothing cached', async () => {
  let n = 0;
  const { fn, calls } = fakeComplete((_, req) => (isVerify(req) ? { text: '{"valid":"yes"}' } : { text: n++ === 0 ? 'Sorry, here: fine' : judgeJson({}) }));
  const ai = new S.LiveAi({ settings: () => settings(['google']), complete: fn, listModels: async () => [], kv: null });
  const out = await ai.judge('k', judgeIn({ line: recLine('b', 'a=1') }));
  assert.equal(out?.outcome.verdict, 'ok');
  assert.match(calls.filter((c) => !isVerify(c.req))[1].req.turns[0].text, /not valid JSON/);
  const bad = fakeComplete(() => ({ text: 'no' }));
  const ai2 = new S.LiveAi({ settings: () => settings(['google']), complete: bad.fn, listModels: async () => [], kv: null });
  assert.equal(await ai2.judge('k', judgeIn()), null);
  assert.equal(ai2.cached('k'), undefined);
});

test('failover: a rate-limited provider is skipped and paused; the next ready one answers', async () => {
  const { fn, calls } = fakeComplete((c, req) => (c.provider === 'google' ? rateLimit() : { text: isVerify(req) ? '{"valid":"yes"}' : judgeJson({}) }));
  const ai = new S.LiveAi({ settings: () => settings(['google', 'anthropic']), complete: fn, listModels: async (c) => (c.provider === 'anthropic' ? ['claude-haiku-5-5', 'claude-opus-5-5'] : []), kv: null });
  const out = await ai.judge('k', judgeIn({ line: recLine('b', 'a=1') }));
  assert.ok(out);
  const judges = calls.filter((c) => !isVerify(c.req));
  assert.deepEqual(judges.map((c) => c.c.provider), ['google', 'anthropic']);
  assert.equal(judges[1].c.model, 'claude-haiku-5-5');
  assert.equal(judges[1].c.effort, '', 'no thinking for Claude judge calls');
  assert.equal(ai.breaker.allow('google' as never), false);
});

test('all providers down: a clear error, health reported, aborts propagate', async () => {
  const { fn } = fakeComplete(() => new OpenAI.APIConnectionError({ message: 'Could not reach the AI provider' }));
  const ai = new S.LiveAi({ settings: () => settings(['google']), complete: fn, listModels: async () => [], kv: null });
  await assert.rejects(ai.call('fast', { system: 's', turns: [{ role: 'user', text: 'x' }], maxTokens: 10 }));
  assert.equal(ai.health, 'offline');
  await assert.rejects(ai.call('fast', { system: 's', turns: [{ role: 'user', text: 'x' }], maxTokens: 10 }), (e: Error) => e.name === 'NoAiProvider');
  const ok = fakeComplete(() => ({ text: 'x' }));
  const ai2 = new S.LiveAi({ settings: () => settings(['google']), complete: ok.fn, listModels: async () => [], kv: null });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(ai2.call('fast', { system: 's', turns: [{ role: 'user', text: 'x' }], maxTokens: 10, signal: ctrl.signal }), (e: Error) => e.name === 'AbortError');
  assert.equal(ai2.breaker.allow('google' as never), true, 'an abort does not pause the provider');
  const none = new S.LiveAi({ settings: () => undefined, complete: ok.fn, kv: null });
  assert.equal(none.ready(), false);
  await assert.rejects(none.call('fast', { system: 's', turns: [], maxTokens: 1 }), (e: Error) => e.name === 'NoAiProvider');
});

test('token and cost accounting: reported usage, or an estimate when the provider reports none', async () => {
  let report = true;
  const { fn } = fakeComplete(() => ({ text: '{"a":1}', usage: report ? { input: 1000, output: 100 } : null }));
  const ai = new S.LiveAi({ settings: () => settings(['anthropic']), complete: fn, listModels: async () => ['claude-haiku-5-5'], kv: null });
  await ai.call('fast', { system: 'sys', turns: [{ role: 'user', text: 'hello' }], maxTokens: 10 });
  assert.deepEqual([ai.meter.input, ai.meter.output], [1000, 100]);
  // Haiku 5.5: $0.10 in / $0.50 out per 1M
  assert.ok(Math.abs(ai.meter.usd - (1000 * 0.1 + 100 * 0.5) / 1e6) < 1e-12);
  report = false;
  await ai.call('fast', { system: 'sys', images: [{ mime: 'image/png', data: '', w: 600, h: 120 }], turns: [{ role: 'user', text: 'hello' }], maxTokens: 10 });
  assert.ok(ai.meter.input > 1000 + 90, 'image tokens estimated');
  assert.ok(ai.meter.output > 100);
  assert.equal(ai.meter.calls, 2);
  assert.equal(P.priceOf('claude-haiku-5-5-20261001')?.in, 0.1);
  assert.equal(P.priceOf('unknown-model'), null);
});

test('crop geometry: x-height about 24 px, 12 px padding, long edge capped', () => {
  const g = CR.cropGeometry([100, 100, 220, 130], { lineHeight: 30 });
  // x-height = 0.45 * 30 pt = 13.5 pt -> 24 px
  assert.ok(Math.abs(g.s * 13.5 - 24) < 0.01);
  assert.equal(g.pw, Math.round(120 * g.s + 24));
  const long = CR.cropGeometry([0, 0, 2000, 30], { lineHeight: 30 });
  assert.ok(long.pw <= 1000);
});

// ---- streaming ----------------------------------------------------------------------------------

test('follow-up line is split off, also while it streams in', () => {
  assert.deepEqual(P.splitFollowUps('Answer.\n>>> Why? | What next? | Another one'), { body: 'Answer.', followUps: ['Why?', 'What next?', 'Another one'] });
  assert.equal(P.splitFollowUps('Answer.\n>>').body, 'Answer.');
  assert.equal(P.splitFollowUps('Answer.').followUps.length, 0);
});

test('streamAsk reveals text progressively and returns follow-ups', async () => {
  const text = 'Subtract $3$ from both sides first: $2x = 4$. Then divide by $2$.\n>>> Why subtract first? | What is x?';
  const { fn, calls } = fakeComplete(() => ({ text }));
  const seen: string[] = [];
  const r = await ST.streamAsk({ choice: { provider: 'google', model: 'm', effort: '' }, images: [img], context: '1. 2x+3=7', level: 'hint', issue: { title: 'Sign error', detail: 'd', lineText: '2x=10' } }, (t) => seen.push(t), fn);
  assert.ok(seen.length > 3, `progressive updates, got ${seen.length}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].length >= seen[i - 1].length);
  assert.ok(!seen.some((s) => s.includes('>>>')));
  assert.equal(r.text, 'Subtract $3$ from both sides first: $2x = 4$. Then divide by $2$.');
  assert.deepEqual(r.followUps, ['Why subtract first?', 'What is x?']);
  const turn = calls[0].req.turns[0].text;
  assert.match(turn, /2x\+3=7/);
  assert.match(turn, /guiding question/);
});

test('ask turns carry history and the new question', () => {
  const t = ST.askTurns({ context: 'ctx', question: 'And now?', history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'ans' }] });
  assert.deepEqual(t.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.match(t[0].text, /ctx[\s\S]*first/);
  assert.equal(t[2].text, 'The learner asks: And now?');
});

test('tutor prompts: one step, ask before telling, grounded on the verified fix, answer only at "fix"', () => {
  assert.match(P.TUTOR_SYSTEM, /One step per reply, at most 60 words/);
  assert.match(P.TUTOR_SYSTEM, /Ask before telling/);
  assert.match(P.TUTOR_SYSTEM, /different numbers/);
  const issue = { title: 'Subtraction error', detail: 'd', lineText: '2x=10', fix: '2x=4' };
  const hint = P.questionFor({ level: 'hint', issue });
  assert.match(hint, /Verified correct step \(for you; reveal it only when showing the fix\): 2x=4/);
  assert.match(hint, /Do not reveal/);
  assert.match(P.questionFor({ level: 'next', issue }), /not its result/);
  assert.match(P.questionFor({ level: 'fix', issue }), /^[\s\S]*Show the fix/);
  assert.match(P.questionFor({ level: 'explainBack', issue }), /explain-back question/);
  // an unverified fix never grounds the tutor
  assert.doesNotMatch(P.questionFor({ level: 'hint', issue: { ...issue, fix: undefined } }), /Verified/);
  assert.ok(P.DEICTIC.test('why?') && P.DEICTIC.test('Warum ist das falsch') && P.DEICTIC.test('?') && !P.DEICTIC.test('integrate sin x'));
});

test('ask fails over before any text is shown', async () => {
  const { fn, calls } = fakeComplete((c) => (c.provider === 'google' ? rateLimit() : { text: 'Hello there.' }));
  const ai = new S.LiveAi({ settings: () => settings(['google', 'anthropic']), complete: fn, listModels: async () => [], kv: null });
  const r = await ai.ask({ images: [img], question: 'hi', action: 'explain' }, () => undefined);
  assert.equal(r.text, 'Hello there.');
  assert.deepEqual(calls.map((c) => c.c.provider), ['google', 'anthropic']);
  assert.ok(ai.meter.input > 0);
});

test('misconception tags: the judge, the journal and the CAS share one list', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/renderer/live/math/index.ts', import.meta.url), 'utf8');
  const map = /const MISCONCEPTION[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
  const tags = new Set([...map.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(tags.size >= 11, `found ${tags.size} CAS tags`);
  for (const t of tags) {
    assert.ok(t in P.MISCONCEPTIONS, `CAS tag ${t} has a name and rule`);
    assert.ok(P.JUDGE_SYSTEM.includes(t), `the judge may answer ${t}`);
  }
  assert.equal(P.normMisconception('Sign-Move'), 'sign-move');
  assert.equal(P.normMisconception('made-up'), 'other');
  assert.equal(P.normMisconception(''), '');
  // rules are LaTeX with real backslashes
  assert.match(P.MISCONCEPTIONS['sign-move'].rule, /\Rightarrow/);
});
