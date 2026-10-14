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

/** A backend's reading as a distribution over texts: its top line plus its alternates. */
function dist(r: LineRecognition): Map<string, number> {
  const d = new Map<string, number>([[r.text, r.confidence]]);
  r.alternates.forEach((t, i) => {
    const p = r.alternateProbs?.[i] ?? 0;
    if (!d.has(t)) d.set(t, p);
  });
  return d;
}

/**
 * Per line, fuses the backends' readings. Each reading counts as independent evidence for its
 * texts (noisy-or of their probabilities), so two backends agreeing raise the confidence and a
 * disagreement keeps the loser as a weighted alternate. Tokens and LaTeX come from the backend
 * whose top reading won.
 */
export function fuse(results: (LineRecognition | null)[]): LineRecognition | null {
  const ok = results.filter((r): r is LineRecognition => !!r && !!r.text);
  if (!ok.length) return results.find((r) => !!r) ?? null;
  if (ok.length === 1) return ok[0];
  const ds = ok.map(dist);
  const texts = new Set(ds.flatMap((d) => [...d.keys()]));
  const score = new Map<string, number>();
  for (const t of texts) score.set(t, 1 - ds.reduce((q, d) => q * (1 - (d.get(t) ?? 0)), 1));
  // the winner must be some backend's top reading (it carries tokens and LaTeX)
  const best = ok.slice().sort((x, y) => score.get(y.text)! - score.get(x.text)! || y.confidence - x.confidence)[0];
  const ranked = [...score].filter(([t]) => t !== best.text).sort((x, y) => y[1] - x[1]);
  let top = score.get(best.text)!;
  // keep it a distribution: the alternates share what the winner leaves
  const rest = ranked.reduce((q, [, p]) => q + p, 0);
  const room = Math.max(0, 1 - top);
  const k = rest > room && rest > 0 ? room / rest : 1;
  top = Math.min(0.995, top);
  const alts = ranked.slice(0, 5);
  return { ...best, confidence: Math.round(top * 1000) / 1000, alternates: alts.map(([t]) => t), alternateProbs: alts.map(([, p]) => Math.round(p * k * 1000) / 1000) };
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
        const rec = fuse(all.map((r) => r[k] ?? null));
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
