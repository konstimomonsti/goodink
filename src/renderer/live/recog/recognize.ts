// Block recognition behind pluggable backends. Each backend gets the block's uncached lines (stroke
// point sequences plus the 2-D layout) and returns one reading per line; readings are fused per line
// by confidence (two backends agreeing on the text raise it). Lines are cached by content, so an
// unchanged line is never recognised twice.
//
// Built in: the Windows ink backend (InkAnalyzer per layout run + the reading pass in read.ts).
// A second on-device model (e.g. an ONNX math recogniser) plugs in as another RecogBackend.
import type { InkAnalysis } from '../../lib/api';
import type { BlockRecognition, InkBlock, LineRecognition, Stroke } from '../contract';
import { layoutLine, runsOf, type Layout } from './layout';
import { readLine, type WordIn } from './read';

/** One line handed to a backend. Strokes keep their full x, y, pressure point sequences. */
export interface LineInput {
  lineId: string;
  strokes: Stroke[];
  layout: Layout;
}

export interface RecogBackend {
  name: string;
  /**
   * A dedicated math reader (the HMER model): on math lines its LaTeX wins unless it is clearly
   * less sure than the others; prose lines stay with the text reader (InkAnalyzer).
   */
  math?: boolean;
  /** one result per input line (null = no opinion); may throw, which counts as all null */
  recognize(lines: LineInput[]): Promise<(LineRecognition | null)[]>;
}

export type Analyze = (strokes: ArrayLike<number>[], opts: { groups: number[][] }) => Promise<InkAnalysis>;

const round = (p: ArrayLike<number>) => {
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i++) out[i] = Math.round(p[i] * 100) / 100;
  return out;
};

/** The Windows ink stack: every layout run of every line is one recognition group, one call per block. */
export function inkBackend(analyze: Analyze): RecogBackend {
  return {
    name: 'windows-ink',
    async recognize(lines) {
      const sent: ArrayLike<number>[] = [];
      const sentIds: string[] = [];
      const groups: number[][] = [];
      const perLine: number[][] = [];
      for (const l of lines) {
        const base = sent.length;
        l.strokes.forEach((s) => {
          sent.push(round(s.pts));
          sentIds.push(s.id);
        });
        const idx = new Map(l.strokes.map((s, k) => [s.id, base + k]));
        const gi: number[] = [];
        for (const run of runsOf(l.layout.root)) {
          gi.push(groups.length);
          groups.push(run.syms.flatMap((sym) => sym.ink.map((k) => idx.get(k.id)!)));
        }
        perLine.push(gi);
      }
      const res = await analyze(sent, { groups });
      const words: WordIn[][] = groups.map(() => []);
      for (const l of res.lines) {
        for (const w of l.words) words[l.group]?.push({ alternates: w.alternates.length ? w.alternates : [w.text], strokeIds: w.strokes.map((k) => sentIds[k]), bbox: w.bbox });
      }
      return lines.map((l, i) => readLine(l.lineId, l.layout, perLine[i].map((g) => words[g])));
    },
  };
}

/** Readings compare by their linear text without spaces and single-token parentheses: (3)/(4) = 3/4. */
const key = (t: string) => t.replace(/\s+/g, '').replace(/\(([^()+\-*/=]{1,3})\)/g, '$1').replace(/·|×/g, '*');

/** How much a non-math reader's probabilities count on a line a math reader also read. */
const TEXT_READER_WEIGHT = 0.85;

/**
 * Per line, fuses the backends' readings (in backend order; `backends` tells which are math
 * readers). The router:
 * - prose: a text reader's confident 'text' line wins (math readers return nothing for prose);
 * - math: every reading is a distribution over texts (top line + alternates); texts that agree
 *   add up as independent evidence (noisy-or), the math reader's evidence counts fully and the
 *   text reader's slightly less, so ties go to the LaTeX-native model. LaTeX and tokens come from
 *   the backend whose top reading won; when a text reader read the same line, its glyph-level
 *   tokens are kept (they map exactly onto strokes).
 */
export function fuse(results: (LineRecognition | null)[], backends: Pick<RecogBackend, 'math'>[] = []): LineRecognition | null {
  const items = results.map((r, i) => ({ r: r!, math: !!backends[i]?.math })).filter((x) => !!x.r && !!x.r.text);
  if (!items.length) return results.find((r) => !!r) ?? null;
  const anyMath = items.some((x) => x.math);
  const prose = items.find((x) => !x.math && x.r.kind === 'text');
  if (prose && (!anyMath || prose.r.confidence >= 0.6)) return prose.r;
  if (items.length === 1) return items[0].r;
  type Entry = { text: string; latex: string; score: number };
  const entries = new Map<string, Entry>();
  const miss = new Map<string, number>(); // product of (1 - p) per text
  for (const { r, math } of items) {
    const w = anyMath && !math ? TEXT_READER_WEIGHT : 1;
    const add = (text: string, latex: string, p: number) => {
      const k = key(text);
      if (!entries.has(k)) entries.set(k, { text, latex, score: 0 });
      else if (math && latex) entries.get(k)!.latex = latex; // the math reader's LaTeX for a shared text
      miss.set(k, (miss.get(k) ?? 1) * (1 - Math.min(0.999, p * w)));
    };
    add(r.text, r.latex, r.confidence);
    r.alternates.forEach((t, i) => add(t, r.alternateLatex?.[i] ?? '', r.alternateProbs?.[i] ?? 0));
  }
  for (const [k, e] of entries) e.score = 1 - miss.get(k)!;
  // the winner is some backend's top reading (it carries tokens and LaTeX)
  const tops = items.slice().sort((x, y) => entries.get(key(y.r.text))!.score - entries.get(key(x.r.text))!.score || Number(y.math) - Number(x.math));
  const win = tops[0];
  const k0 = key(win.r.text);
  let top = entries.get(k0)!.score;
  // same line read by a text reader: its tokens are glyph-exact
  const twin = items.find((x) => !x.math && key(x.r.text) === k0);
  const tokens = twin && twin.r.tokens.length ? twin.r.tokens : win.r.tokens;
  const latex = entries.get(k0)!.latex || win.r.latex;
  const ranked = [...entries].filter(([k]) => k !== k0).sort((x, y) => y[1].score - x[1].score);
  const rest = ranked.reduce((q, [, e]) => q + e.score, 0);
  const room = Math.max(0, 1 - top);
  const scale = rest > room && rest > 0 ? room / rest : 1;
  top = Math.min(0.995, top);
  const alts = ranked.slice(0, 5).map(([, e]) => e);
  return {
    ...win.r,
    kind: 'math',
    latex,
    tokens,
    confidence: Math.round(top * 1000) / 1000,
    alternates: alts.map((e) => e.text),
    alternateProbs: alts.map((e) => Math.round(e.score * scale * 1000) / 1000),
    alternateLatex: alts.map((e) => e.latex),
  };
}

const CACHE_MAX = 600;

/** cache key: the line's strokes and their geometry relative to the line */
function lineKey(lineId: string, strokes: Stroke[]): string {
  if (!strokes.length) return lineId;
  const ox = Math.min(...strokes.map((s) => s.bbox[0])), oy = Math.min(...strokes.map((s) => s.bbox[1]));
  return lineId + ':' + strokes.map((s) => `${s.pts.length}/${Math.round(s.bbox[0] - ox)},${Math.round(s.bbox[1] - oy)}`).join(';');
}

export function makeRecognizer(backends: RecogBackend[]) {
  const cache = new Map<string, LineRecognition>();

  return async function recognizeBlock(block: InkBlock, strokes: ReadonlyMap<string, Stroke>): Promise<BlockRecognition> {
    const t0 = performance.now();
    const out: (LineRecognition | null)[] = [];
    const todo: { i: number; key: string }[] = [];
    const inputs: LineInput[] = [];
    block.lines.forEach((line, i) => {
      const ss = line.strokeIds.map((id) => strokes.get(id)).filter((s): s is Stroke => !!s);
      const key = lineKey(line.id, ss);
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key); // LRU: move to the end
        cache.set(key, hit);
        out.push({ ...hit, lineId: line.id });
        return;
      }
      out.push(null);
      todo.push({ i, key });
      inputs.push({ lineId: line.id, strokes: ss, layout: layoutLine(ss) });
    });
    if (inputs.length) {
      const all = await Promise.all(backends.map((b) => b.recognize(inputs).catch(() => inputs.map(() => null))));
      todo.forEach((t, k) => {
        const line = block.lines[t.i];
        const rec = fuse(all.map((r) => r[k] ?? null), backends);
        if (rec) {
          out[t.i] = rec;
          cache.set(t.key, rec);
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
        } else {
          // no backend could read it (recogniser unavailable): empty, zero confidence, not cached
          out[t.i] = { lineId: line.id, kind: 'text', text: '', latex: '', confidence: 0, alternates: [], tokens: [], source: 'local-ink' };
        }
      });
    }
    return { blockId: block.id, lines: out as LineRecognition[], ms: Math.round((performance.now() - t0) * 10) / 10 };
  };
}
