// A small scripted engine for building and screenshotting the Live Ink UI before (or without) the
// real recogniser, CAS and AI layer. Turned on with localStorage 'goodink:live-fake' = '1'.
// It groups a page's pen strokes into lines by height, "reads" them from a script and marks the
// third line of a block as wrong, so every UI state can be produced with real ink on a real page.
import type { NotebookSession } from '../../engine/session';
import type { Stroke } from '../../engine/model';
import type { BBox, BlockCheck, InkBlock, InkLine, Insight, Issue, LineRecognition } from '../contract';
import type { AskResult, JournalEntry, LiveStatus, LiveUiEngine, StreamOpts, UiDecoration } from './engineApi';
import type { LiveMode } from '../contract';

const DEFAULT_SCRIPT = ['2x+3=7', '2x=4', 'x=3', 'x=2'];

/** + - * / on numbers only (the fake's live results) */
function arith(s: string): string | null {
  if (!/^[\d+\-*/.()·×]+$/.test(s)) return null;
  try {
    const v = Function(`"use strict";return (${s.replace(/[·×]/g, '*')})`)() as number;
    return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : null;
  } catch {
    return null;
  }
}
const LATEX: Record<string, string> = { '2x+3=7': '2x+3=7', '2x=4': '2x=4', 'x=3': 'x=3', 'x=2': 'x=2' };

type FakeOpts = { blockScripts?: string[][]; script?: string[]; latency?: number; offline?: boolean; aiReady?: boolean; unsureLine?: number };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new DOMException('aborted', 'AbortError'));
    });
  });

async function stream(text: string, opts: StreamOpts, cps = 160) {
  let out = '';
  const words = text.split(/(?<=\s)/);
  for (const w of words) {
    await sleep(Math.max(8, (w.length / cps) * 1000), opts.signal);
    out += w;
    opts.onDelta(out);
  }
  return out;
}

export function createFakeEngine(s: NotebookSession, o: FakeOpts = {}): LiveUiEngine {
  const cfg = (): FakeOpts => ({ ...o, ...((window as unknown as { __liveFake?: FakeOpts }).__liveFake ?? {}) });
  let status: LiveStatus = { mode: 'smart', state: 'idle', lastMs: null, tokens: 0, aiReady: cfg().aiReady ?? true };
  const statusFns = new Set<(s: LiveStatus) => void>();
  const decoFns = new Set<(pageId: string, d: UiDecoration[]) => void>();
  const insightFns = new Map<string, Set<(i: Insight) => void>>();
  const blocks = new Map<string, { block: InkBlock; check: BlockCheck | null }>();
  const overrides = new Map<string, string>(); // lineId -> corrected reading
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const journalSet = new Map<string, JournalEntry>();

  const setStatus = (p: Partial<LiveStatus>) => {
    status = { ...status, ...p };
    for (const f of statusFns) f(status);
  };

  const group = (pageId: string): InkBlock[] => {
    const c = s.content(pageId);
    const strokes = (c?.strokes ?? []).filter((st) => st.kind === 'pen');
    if (!strokes.length) return [];
    const sorted = [...strokes].sort((a, b) => (a.bbox[1] + a.bbox[3]) / 2 - (b.bbox[1] + b.bbox[3]) / 2);
    const lines: { strokes: Stroke[]; bbox: BBox }[] = [];
    // a line: strokes at the same height and close to each other horizontally
    for (const st of [...sorted].sort((a, b) => a.bbox[0] - b.bbox[0])) {
      const cy = (st.bbox[1] + st.bbox[3]) / 2;
      const last = lines.find((l) => cy <= l.bbox[3] + 4 && cy >= l.bbox[1] - 4 && st.bbox[0] - l.bbox[2] < 40);
      if (last) {
        last.strokes.push(st);
        last.bbox = [Math.min(last.bbox[0], st.bbox[0]), Math.min(last.bbox[1], st.bbox[1]), Math.max(last.bbox[2], st.bbox[2]), Math.max(last.bbox[3], st.bbox[3])];
      } else lines.push({ strokes: [st], bbox: [...st.bbox] as BBox });
    }
    lines.sort((a, b) => Math.floor(a.bbox[0] / 150) - Math.floor(b.bbox[0] / 150) || a.bbox[1] - b.bbox[1]);
    const inkLines: InkLine[] = lines.map((l) => {
      const ids = l.strokes.map((x) => x.id).sort();
      return { id: `L${hash(ids.join(','))}`, pageId, strokeIds: ids, bbox: l.bbox };
    });
    // blocks: lines closer than 2.2 line heights belong together
    const out: InkBlock[] = [];
    let cur: InkLine[] = [];
    const flush = () => {
      if (!cur.length) return;
      const b = cur.reduce<BBox>((a, l) => [Math.min(a[0], l.bbox[0]), Math.min(a[1], l.bbox[1]), Math.max(a[2], l.bbox[2]), Math.max(a[3], l.bbox[3])], [...cur[0].bbox] as BBox);
      out.push({ id: `B${hash(cur.map((l) => l.id).join(','))}`, pageId, lines: cur, bbox: b });
      cur = [];
    };
    for (const l of inkLines) {
      const prev = cur[cur.length - 1];
      if (prev && (l.bbox[1] - prev.bbox[3] > Math.max(24, (prev.bbox[3] - prev.bbox[1]) * 2.2) || l.bbox[1] < prev.bbox[1] || Math.abs(l.bbox[0] - prev.bbox[0]) > 120)) flush();
      cur.push(l);
    }
    flush();
    return out;
  };

  const read = (block: InkBlock): LineRecognition[] => {
    const bi = group(block.pageId).findIndex((b) => b.id === block.id);
    const script = cfg().blockScripts?.[bi] ?? cfg().script ?? DEFAULT_SCRIPT;
    return block.lines.map((l, i) => {
      const raw = overrides.get(l.id) ?? script[i % script.length];
      // a leading "?" in a script line means: read with low confidence
      const shaky = raw.startsWith('?');
      const text = shaky ? raw.slice(1) : raw;
      const n = Math.max(1, text.length);
      const w = l.bbox[2] - l.bbox[0];
      return {
        lineId: l.id,
        kind: 'math',
        text,
        latex: LATEX[text] ?? text,
        confidence: shaky || i === (cfg().unsureLine ?? -1) ? 0.62 : 0.97,
        alternates: [],
        tokens: [...text].map((ch, k) => ({ text: ch, strokeIds: l.strokeIds, bbox: [l.bbox[0] + (w * k) / n, l.bbox[1], l.bbox[0] + (w * (k + 1)) / n, l.bbox[3]] as BBox, span: [k, k + 1] as [number, number] })),
        source: 'local-ink',
      };
    });
  };

  const check = (block: InkBlock): BlockCheck => {
    const rec = read(block);
    const issues: Issue[] = [];
    let afterError = false;
    const lines = rec.map((r, i) => {
      // x = 3 after 2x = 4 is the scripted mistake; a line read with low confidence is unsure
      if (r.text === 'x=3') {
        issues.push({ lineId: r.lineId, span: [2, 3], severity: 'error', title: 'Division error', detail: 'From $2x = 4$, dividing both sides by $2$ gives a different value for $x$.', hint: 'What do you get when you divide both sides of $2x = 4$ by $2$?', fix: 'x = 2', source: 'local-cas', confidence: 0.99, misconception: 'divide-one-side' });
        journalSet.set(r.lineId, { id: r.lineId, at: Date.now(), title: 'Division error', tag: 'divide-one-side', line: r.text, fix: 'x = 2', pageId: block.pageId });
        afterError = true;
        return { lineId: r.lineId, verdict: 'error' as const };
      }
      if (r.confidence < 0.8) {
        issues.push({ lineId: r.lineId, span: null, severity: 'unsure', title: 'Hard to read', detail: 'I am not sure I read this line correctly. Check the reading below.', source: 'local-cas', confidence: r.confidence });
        return { lineId: r.lineId, verdict: 'unsure' as const };
      }
      // steps after a mistake that follow correctly from it carry no mark
      if (afterError && /^x=\d+$/.test(r.text)) return { lineId: r.lineId, verdict: 'none' as const, carried: true };
      return { lineId: r.lineId, verdict: i === 0 || r.text.endsWith('=') ? ('none' as const) : ('ok' as const) };
    });
    return { blockId: block.id, pageId: block.pageId, recognition: { blockId: block.id, lines: rec, ms: 18 }, lines, issues, via: 'local', ms: 42 };
  };

  const decorations = (pageId: string): UiDecoration[] => {
    const out: UiDecoration[] = [];
    for (const { block, check: c } of blocks.values()) {
      if (block.pageId !== pageId || !c) continue;
      for (const lc of c.lines) {
        const line = block.lines.find((l) => l.id === lc.lineId)!;
        const issue = c.issues.find((x) => x.lineId === lc.lineId);
        const rec = c.recognition.lines.find((r) => r.lineId === lc.lineId)!;
        let x1 = line.bbox[0], x2 = line.bbox[2];
        if (issue?.span) {
          const toks = rec.tokens.filter((t) => t.span[0] >= issue.span![0] && t.span[1] <= issue.span![1]);
          if (toks.length) {
            x1 = Math.min(...toks.map((t) => t.bbox[0]));
            x2 = Math.max(...toks.map((t) => t.bbox[2]));
          }
        }
        // live result after a trailing "=" (Math Notes style)
        const value = rec.text.endsWith('=') ? arith(rec.text.slice(0, -1)) : null;
        if (value != null) out.push({ id: `${lc.lineId}:result`, pageId, kind: 'result', text: value, bbox: line.bbox, underline: { x1, x2, y: line.bbox[3] + 3 }, blockId: block.id, lineId: lc.lineId });
        const kind = lc.verdict === 'error' ? 'error' : lc.verdict === 'unsure' ? 'unsure' : lc.verdict === 'ok' ? 'ok' : null;
        if (!kind) continue;
        const tip = kind === 'unsure' ? `${Math.round(rec.confidence * 100)}% sure: I read “${rec.text}”?` : undefined;
        out.push({ id: `${lc.lineId}:${kind}`, pageId, kind, bbox: line.bbox, underline: { x1, x2, y: line.bbox[3] + 3 }, blockId: block.id, lineId: lc.lineId, title: issue?.title, tip, confidence: kind === 'unsure' ? rec.confidence : undefined });
      }
    }
    return out;
  };

  const emitPage = (pageId: string) => {
    const d = status.mode === 'off' ? [] : decorations(pageId);
    for (const f of decoFns) f(pageId, d);
  };

  const run = async (pageId: string) => {
    if (status.mode === 'off') return emitPage(pageId);
    const found = group(pageId);
    const ids = new Set(found.map((b) => b.id));
    for (const [id, b] of blocks) if (b.block.pageId === pageId && !ids.has(id)) blocks.delete(id);
    // marks of changed blocks go away at once
    emitPage(pageId);
    const todo = found.filter((b) => !blocks.get(b.id)?.check);
    if (!todo.length) return;
    for (const b of todo) blocks.set(b.id, { block: b, check: null });
    setStatus({ state: 'checking' });
    const t0 = performance.now();
    await sleep(cfg().latency ?? 260);
    for (const b of todo) {
      const entry = blocks.get(b.id);
      if (!entry) continue;
      entry.check = check(b);
      for (const f of insightFns.get(b.id) ?? []) f(insightOf(entry.block, entry.check, null));
    }
    setStatus({ state: cfg().offline ? 'offline' : 'idle', lastMs: Math.round(performance.now() - t0), tokens: status.tokens + (status.mode === 'local' ? 0 : 0) });
    emitPage(pageId);
  };

  const insightOf = (block: InkBlock, c: BlockCheck | null, focus: string | null): Insight => ({ pageId: block.pageId, block, check: c, focusLineId: focus });

  const off = s.on((e) => {
    if (e.type !== 'page') return;
    const id = e.pageId;
    clearTimeout(timers.get(id));
    // erasing clears marks right away; new ink waits for the pen to settle
    if (e.change !== 'append') {
      const found = new Set(group(id).map((b) => b.id));
      for (const [bid, b] of blocks) if (b.block.pageId === id && !found.has(bid)) blocks.delete(bid);
      emitPage(id);
    }
    timers.set(id, setTimeout(() => void run(id), 600));
  });
  // pages that already have ink
  setTimeout(() => {
    for (const p of s.pages) if (s.content(p.id)?.strokes.length) void run(p.id);
  }, 300);

  return {
    kind: 'fake',
    dispose: () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
    },
    status: () => status,
    onStatus: (fn) => (statusFns.add(fn), () => statusFns.delete(fn)),
    setMode: (mode: LiveMode) => {
      setStatus({ mode });
      for (const p of s.pages) {
        if (mode === 'off') emitPage(p.id);
        else void run(p.id);
      }
    },
    onDecorations: (fn) => (decoFns.add(fn), () => decoFns.delete(fn)),
    insightAt(pageId, x, y) {
      for (const { block, check: c } of blocks.values()) {
        if (block.pageId !== pageId) continue;
        const [x0, y0, x1, y1] = block.bbox;
        if (x < x0 - 10 || x > x1 + 10 || y < y0 - 10 || y > y1 + 12) continue;
        const line = block.lines.find((l) => y >= l.bbox[1] - 8 && y <= l.bbox[3] + 10) ?? null;
        return insightOf(block, c, line?.id ?? null);
      }
      // ink that has not been grouped yet still opens a card (in its loading state)
      const b = group(pageId).find((bl) => x >= bl.bbox[0] - 10 && x <= bl.bbox[2] + 10 && y >= bl.bbox[1] - 10 && y <= bl.bbox[3] + 12);
      if (!b) return null;
      blocks.set(b.id, { block: b, check: null });
      void run(pageId);
      return insightOf(b, null, null);
    },
    onInsight(blockId, fn) {
      let set = insightFns.get(blockId);
      if (!set) insightFns.set(blockId, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    async recheck(blockId, lineId, text) {
      overrides.set(lineId, text.replace(/\s+/g, ''));
      const entry = blocks.get(blockId);
      if (!entry) return null;
      entry.check = null;
      for (const f of insightFns.get(blockId) ?? []) f(insightOf(entry.block, null, lineId));
      setStatus({ state: 'checking' });
      await sleep(cfg().latency ?? 260);
      entry.check = check(entry.block);
      setStatus({ state: 'idle', lastMs: 38 });
      for (const f of insightFns.get(blockId) ?? []) f(insightOf(entry.block, entry.check, lineId));
      emitPage(entry.block.pageId);
      return entry.check;
    },
    async hint(_insight, level, opts) {
      const text =
        level === 1
          ? 'Look at the step from $2x = 4$ to the next line. Which operation undoes multiplying by 2?'
          : level === 2
            ? 'Divide **both sides** by $2$: $\\frac{2x}{2} = \\frac{4}{2}$. Now simplify each side.'
            : 'The correct line is $x = 2$, because $4 \\div 2 = 2$. Your next line $x = 2$ is then right.';
      await sleep(cfg().latency ?? 420, opts.signal);
      return stream(text, opts);
    },
    async ask(ctx, question, history, opts): Promise<AskResult> {
      if (!status.aiReady) throw new Error('AI is not set up');
      if (cfg().offline) {
        await sleep(400, opts.signal);
        throw new Error('You are offline. The local check still works; answers need the internet.');
      }
      setStatus({ state: 'checking' });
      const t0 = performance.now();
      await sleep(cfg().latency ?? 650, opts.signal);
      const a = ctx.action ?? (question ? 'q' : 'explain');
      const text =
        a === 'flashcards'
          ? '**3 flashcards**\n- *Solve* $2x + 3 = 7$ → $x = 2$\n- *Undo* $+3$ → subtract $3$ from both sides\n- *Undo* $\\times 2$ → divide both sides by $2$'
          : a === 'solve'
            ? '**Step 1.** Subtract $3$ from both sides: $2x = 4$.\n**Step 2.** Divide both sides by $2$: $x = 2$.\n**Check.** $2 \\cdot 2 + 3 = 7$ ✓'
            : history.length
              ? `Good question. Dividing by $2$ keeps the equation balanced: $$\\frac{2x}{2} = \\frac{4}{2} \\Rightarrow x = 2$$ That is why the third line should read $x = 2$.`
              : `You are solving the linear equation $2x + 3 = 7$. The first step is right: subtracting $3$ gives $2x = 4$. In the next step $4 \\div 2$ was written as $3$; it should be $x = 2$.`;
      const out = await stream(text, opts);
      setStatus({ state: 'idle', lastMs: Math.round(performance.now() - t0), tokens: status.tokens + 412 + Math.round(out.length / 3.6) });
      return { text: out, followUps: history.length ? ['Show a similar example', 'Quiz me on this'] : ['Why divide both sides?', 'Show a similar example', 'Check my next line'] };
    },
    journal: () => [...journalSet.values()],
    async transcribe() {
      await sleep(500);
      return 'Why do I divide both sides by two here?';
    },
  };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
