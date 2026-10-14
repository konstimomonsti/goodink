// Local handwritten-math model as a RecogBackend (src-tauri/src/hmer.rs: Pix2Text MFR through ONNX
// Runtime). Each line's strokes go to Rust, which renders them black on white and returns the top-k
// LaTeX readings with probabilities; here they become the contract's linear text, alternates and
// alternateProbs, and the symbols are mapped back onto strokes by aligning the LaTeX tree with the
// line's 2-D layout (fractions, roots and scripts in order, plain glyphs left to right).
//
// Pure apart from the injected `call`, so it runs under node for tests:
//   hmerBackend((strokes, opts) => api.hmerRecognize(strokes, opts))
import type { BBox, InkToken, LineRecognition } from '../contract';
import type { Ink } from './geom';
import type { Run } from './layout';
import type { LineInput, RecogBackend } from './recognize';

export interface HmerHyp {
  latex: string;
  logp: number;
  prob: number;
}
export interface HmerOut {
  hyps: HmerHyp[];
  ms: number;
}
export type HmerCall = (strokes: ArrayLike<number>[], opts: { topK?: number; beam?: number; ep?: 'cpu' | 'dml' }) => Promise<HmerOut>;

// ---- LaTeX -> tree --------------------------------------------------------------------------------

export type TexNode =
  | { t: 'atom'; s: string } // one visible symbol in linear form ("x", "2", "*", "sin")
  | { t: 'frac'; num: TexNode[]; den: TexNode[] }
  | { t: 'sqrt'; body: TexNode[]; index?: TexNode[] }
  | { t: 'sup' | 'sub'; body: TexNode[] };

const SYMBOL: Record<string, string> = {
  times: '*', cdot: '*', ast: '*', div: '/', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠',
  approx: '≈', pi: 'π', infty: '∞', lt: '<', gt: '>', prime: "'", circ: '°', degree: '°', to: '→', rightarrow: '→',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', phi: 'φ', omega: 'ω', Delta: 'Δ',
  ldots: '...', cdots: '...', dots: '...', '%': '%', '{': '(', '}': ')', '|': '|', lbrace: '(', rbrace: ')', vert: '|',
};
const FUNCS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan']);
const SKIP = new Set(['left', 'right', 'big', 'Big', 'bigl', 'bigr', 'Bigl', 'Bigr', 'displaystyle', 'textstyle', ',', ';', ':', '!', ' ', 'quad', 'qquad', 'limits', 'nolimits']);
const WRAP = new Set(['mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt', 'text', 'textrm', 'textit', 'boldsymbol', 'bm', 'operatorname', 'mbox', 'hbox', 'underline', 'overline']);

function lex(src: string): string[] {
  const out: string[] = [];
  const s = src.replace(/^\s*(\\\[|\$\$?|\\\()/, '').replace(/(\\\]|\$\$?|\\\))\s*$/, '');
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (m) {
        out.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (!/\s/.test(c)) out.push(c);
    i++;
  }
  return out;
}

/** Parses LaTeX (as the model writes it) into a tree of visible atoms and 2-D structures. */
export function parseLatex(src: string): TexNode[] {
  const toks = lex(src);
  let i = 0;
  const group = (): TexNode[] => {
    // one argument: {...} or a single token
    if (toks[i] === '{') {
      i++;
      const g = seq('}');
      i++;
      return g;
    }
    return i < toks.length ? seq(null, 1) : [];
  };
  const seq = (close: string | null, limit = Infinity): TexNode[] => {
    const out: TexNode[] = [];
    let n = 0;
    while (i < toks.length && toks[i] !== close && n < limit) {
      const t = toks[i++];
      n++;
      if (t === '{') {
        out.push(...seq('}'));
        i++;
      } else if (t === '}') {
        continue;
      } else if (t === '^' || t === '_') {
        out.push({ t: t === '^' ? 'sup' : 'sub', body: group() });
      } else if (t === '\\frac' || t === '\\dfrac' || t === '\\tfrac' || t === '\\cfrac') {
        const num = group();
        out.push({ t: 'frac', num, den: group() });
      } else if (t === '\\sqrt') {
        let index: TexNode[] | undefined;
        if (toks[i] === '[') {
          i++;
          index = seq(']');
          i++;
        }
        out.push({ t: 'sqrt', body: group(), index });
      } else if (t.startsWith('\\') && t.length > 1) {
        const name = t.slice(1);
        if (SKIP.has(name)) continue;
        if (WRAP.has(name)) {
          const g = group();
          // \operatorname{sin} or \mathrm{sin}: one function atom; otherwise the contents
          const word = g.every((x) => x.t === 'atom') ? g.map((x) => (x as { s: string }).s).join('') : '';
          if (FUNCS.has(word)) out.push({ t: 'atom', s: word });
          else out.push(...g);
        } else if (FUNCS.has(name)) out.push({ t: 'atom', s: name });
        else if (SYMBOL[name]) out.push({ t: 'atom', s: SYMBOL[name] });
        else out.push({ t: 'atom', s: name.length === 1 ? name : `\\${name}` });
      } else if (t === '~') {
        continue;
      } else {
        out.push({ t: 'atom', s: t === '×' || t === '·' ? '*' : t === '÷' ? '/' : t === '−' ? '-' : t });
      }
    }
    return out;
  };
  return seq(null);
}

// ---- tree -> linear text and LaTeX ------------------------------------------------------------------

const bare = (s: string) => /^([0-9]+|[a-zA-Z])$/.test(s);

/** Linear text (read.ts conventions: (a)/(b), sqrt(x), x^2, x^(n+1), * and /) */
export function linear(nodes: TexNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'atom') out += n.s;
    else if (n.t === 'frac') out += `(${linear(n.num)})/(${linear(n.den)})`;
    else if (n.t === 'sqrt') out += n.index ? `(${linear(n.body)})^(1/(${linear(n.index)}))` : `sqrt(${linear(n.body)})`;
    else {
      const b = linear(n.body);
      out += (n.t === 'sup' ? '^' : '_') + (bare(b) ? b : `(${b})`);
    }
  }
  return out;
}

const TEX: Record<string, string> = { '*': '\\times ', '/': '\\div ', '≤': '\\le ', '≥': '\\ge ', '≠': '\\neq ', 'π': '\\pi ', '±': '\\pm ', '∞': '\\infty ', '...': '\\ldots ' };

/** Tidy LaTeX from the tree (the model's own output has tokeniser spaces and \left/\right noise) */
export function texOf(nodes: TexNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'atom') out += FUNCS.has(n.s) ? `\\${n.s} ` : TEX[n.s] ?? (n.s.startsWith('\\') ? n.s + ' ' : n.s);
    else if (n.t === 'frac') out += `\\frac{${texOf(n.num)}}{${texOf(n.den)}}`;
    else if (n.t === 'sqrt') out += n.index ? `\\sqrt[${texOf(n.index)}]{${texOf(n.body)}}` : `\\sqrt{${texOf(n.body)}}`;
    else out += `${n.t === 'sup' ? '^' : '_'}{${texOf(n.body)}}`;
  }
  return out.replace(/ +([^a-zA-Z]|$)/g, '$1').trim();
}

/** Text the math checker can't use: words, \text blocks (the model read prose as math). */
export function looksLikeProse(nodes: TexNode[]): boolean {
  const s = linear(nodes);
  return /[a-zA-Z]{3,}/.test(s.replace(new RegExp([...FUNCS].sort((a, b) => b.length - a.length).join('|'), 'g'), '')) || /\\[a-zA-Z]/.test(s);
}

// ---- alignment: tree <-> layout --------------------------------------------------------------------

interface Slot {
  ink: Ink[];
}

/** every glyph of a run's subtree, in reading order (structures in place, at their x) */
function flatSlots(run: Run): Slot[] {
  const out: Slot[] = [];
  for (const it of run.items) {
    if (it.t === 'sym') out.push({ ink: it.sym.ink });
    else if (it.t === 'frac') out.push(...flatSlots(it.num), { ink: [it.bar] }, ...flatSlots(it.den));
    else if (it.t === 'sqrt') out.push({ ink: [it.radical] }, ...flatSlots(it.body));
    else out.push(...flatSlots(it.run));
  }
  return out;
}

const bboxOf = (ink: Ink[]): BBox => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of ink) {
    x0 = Math.min(x0, k.x0);
    y0 = Math.min(y0, k.y0);
    x1 = Math.max(x1, k.x1);
    y1 = Math.max(y1, k.y1);
  }
  return [x0, y0, x1, y1];
};

class Emit {
  text = '';
  tokens: InkToken[] = [];
  add(s: string, ink: Ink[] | null, tokText = s, start = this.text.length) {
    this.text += s;
    if (ink && ink.length) this.tokens.push({ text: tokText, strokeIds: [...new Set(ink.map((k) => k.id))], bbox: bboxOf(ink), span: [start, this.text.length] });
  }
}

/** atoms -> slots monotonically: 1:1 when the counts agree, else proportionally (each atom >= 1 slot) */
function spread<T>(n: number, slots: T[]): T[][] {
  if (!slots.length) return Array.from({ length: n }, () => []);
  if (n === slots.length) return slots.map((s) => [s]);
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * slots.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * slots.length) / n));
    return slots.slice(a, Math.min(b, slots.length));
  });
}

const structKind = (n: TexNode) => (n.t === 'atom' ? null : n.t);

/** Emits linear text for `nodes`, taking strokes from `run` (null run = no ink known). */
function emitAligned(nodes: TexNode[], run: Run | null, out: Emit) {
  const texStructs = nodes.filter((n) => n.t !== 'atom');
  const inkStructs = run ? run.items.filter((it) => it.t !== 'sym') : [];
  const same = run && texStructs.length === inkStructs.length && texStructs.every((n, k) => structKind(n) === inkStructs[k].t);
  if (!same) {
    // structures disagree: plain left-to-right over every glyph of the subtree
    const count = (ns: TexNode[]): number => ns.reduce((a: number, n) => a + (n.t === 'atom' ? 1 : n.t === 'frac' ? count(n.num) + 1 + count(n.den) : n.t === 'sqrt' ? 1 + count(n.body) : count(n.body)), 0);
    const slots = run ? flatSlots(run) : [];
    const per = spread(count(nodes), slots);
    let k = 0;
    const take = () => (per[k++] ?? []).flatMap((s) => s.ink);
    const walk = (ns: TexNode[]) => {
      for (const n of ns) {
        if (n.t === 'atom') out.add(n.s, take());
        else if (n.t === 'frac') {
          out.add('(', null);
          walk(n.num);
          out.add(')', null);
          out.add('/', take(), 'frac');
          out.add('(', null);
          walk(n.den);
          out.add(')', null);
        } else if (n.t === 'sqrt') {
          out.add('sqrt', take(), '√');
          out.add('(', null);
          walk(n.body);
          out.add(')', null);
        } else {
          const b = linear(n.body), mark = n.t === 'sup' ? '^' : '_';
          if (bare(b)) {
            const ink = n.body.flatMap(() => take());
            out.add(mark + b, ink, mark + b);
          } else {
            out.add(mark + '(', null);
            walk(n.body);
            out.add(')', null);
          }
        }
      }
    };
    walk(nodes);
    return;
  }
  // same structure: atoms between structures map onto the run's own glyphs between them
  const items = run!.items;
  const segAtoms: TexNode[][] = [[]];
  for (const n of nodes) {
    if (n.t === 'atom') segAtoms[segAtoms.length - 1].push(n);
    else segAtoms.push([]);
  }
  const segSlots: Slot[][] = [[]];
  for (const it of items) {
    if (it.t === 'sym') segSlots[segSlots.length - 1].push({ ink: it.sym.ink });
    else segSlots.push([]);
  }
  let seg = 0, si = 0;
  const per = segAtoms.map((a, k) => spread(a.length, segSlots[k] ?? []));
  for (const n of nodes) {
    if (n.t === 'atom') {
      out.add(n.s, (per[seg][si++] ?? []).flatMap((s) => s.ink));
      continue;
    }
    const it = inkStructs[seg];
    seg++;
    si = 0;
    if (n.t === 'frac' && it.t === 'frac') {
      out.add('(', null);
      emitAligned(n.num, it.num, out);
      out.add(')', null);
      out.add('/', [it.bar], 'frac');
      out.add('(', null);
      emitAligned(n.den, it.den, out);
      out.add(')', null);
    } else if (n.t === 'sqrt' && it.t === 'sqrt') {
      out.add('sqrt', [it.radical], '√');
      out.add('(', null);
      emitAligned(n.body, it.body, out);
      out.add(')', null);
    } else if ((n.t === 'sup' || n.t === 'sub') && (it.t === 'sup' || it.t === 'sub')) {
      const b = linear(n.body), mark = n.t === 'sup' ? '^' : '_';
      if (bare(b)) out.add(mark + b, flatSlots(it.run).flatMap((s) => s.ink), mark + b);
      else {
        out.add(mark + '(', null);
        emitAligned(n.body, it.run, out);
        out.add(')', null);
      }
    }
  }
}

/** One reading of a line: linear text, tidy LaTeX and stroke-mapped tokens. */
export function readLatex(latex: string, root: Run | null): { text: string; latex: string; tokens: InkToken[]; nodes: TexNode[] } {
  const nodes = parseLatex(latex);
  const out = new Emit();
  emitAligned(nodes, root, out);
  return { text: out.text, latex: texOf(nodes), tokens: out.tokens, nodes };
}

// ---- backend ------------------------------------------------------------------------------------

export interface HmerBackendOptions {
  topK?: number;
  beam?: number;
  ep?: 'cpu' | 'dml';
}

/**
 * Readings -> one LineRecognition. Confidence is the top reading's sequence probability (the model's
 * own estimate that the whole line is right); alternates carry the other readings' shares of the
 * probability mass, merged when two LaTeX strings read the same.
 */
export function toRecognition(lineId: string, hyps: HmerHyp[], root: Run | null): LineRecognition | null {
  if (!hyps.length) return null;
  const read = hyps.map((h) => ({ h, r: readLatex(h.latex, root) })).filter((x) => x.r.text);
  if (!read.length || looksLikeProse(read[0].r.nodes)) return null;
  const mass = new Map<string, number>();
  for (const { h, r } of read) mass.set(r.text, (mass.get(r.text) ?? 0) + Math.exp(h.logp));
  const total = [...mass.values()].reduce((a, b) => a + b, 0) || 1;
  const best = read[0].r;
  const alts = [...mass.entries()].filter(([t]) => t !== best.text).sort((a, b) => b[1] - a[1]);
  const pBest = Math.exp(read[0].h.logp);
  return {
    lineId,
    kind: 'math',
    text: best.text,
    latex: best.latex,
    confidence: Math.max(0.01, Math.min(0.99, pBest)),
    alternates: alts.map(([t]) => t),
    alternateProbs: alts.map(([, p]) => Math.round((p / total) * 1000) / 1000),
    tokens: best.tokens,
    source: 'local-ink',
  };
}

const round = (p: ArrayLike<number>) => {
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i++) out[i] = Math.round(p[i] * 100) / 100;
  return out;
};

/** The local math model as a recognition backend: one model call per line, lines in order. */
export function hmerBackend(call: HmerCall, opts: HmerBackendOptions = {}): RecogBackend {
  return {
    name: 'hmer',
    async recognize(lines: LineInput[]) {
      const out: (LineRecognition | null)[] = [];
      for (const l of lines) {
        if (!l.strokes.length) {
          out.push(null);
          continue;
        }
        const r = await call(l.strokes.map((s) => round(s.pts)), { topK: opts.topK ?? 5, beam: opts.beam ?? 5, ep: opts.ep });
        out.push(toRecognition(l.lineId, r.hyps, l.layout.root));
      }
      return out;
    },
  };
}
