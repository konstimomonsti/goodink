// Reading a laid-out line: picks each run's reading from the recogniser's ranked alternates,
// aligns its characters to the glyphs that drew them, fixes math confusables from context
// (x/×, 1/l/|, 0/O, 2/z, 5/S, t/+, -/−) and emits linear text, LaTeX and stroke-mapped tokens.
import type { BBox, InkToken, LineRecognition } from '../contract';
import { symOf, type Sym } from './geom';
import { runsOf, type Layout, type Run } from './layout';

/** One recognised word of a run: its ranked readings and the strokes it covers. */
export interface WordIn {
  alternates: string[]; // most likely first
  strokeIds: string[];
  bbox: BBox;
}

// ---- character classes ------------------------------------------------------------------------------

const DIGIT = /[0-9]/;
const LETTER = /[a-zA-Z]/;
const FUNCS = ['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min'];
const MATH_OK = /[0-9a-zA-Z+\-×÷*/=().,<>≤≥'!√π]/;

const isOperandL = (c: string | undefined) => !!c && (DIGIT.test(c) || LETTER.test(c) || c === ')');
const isOperandR = (c: string | undefined) => !!c && (DIGIT.test(c) || LETTER.test(c) || c === '(');

/** Context-free spelling fixes for one recogniser reading of math. */
function plainMath(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[−–—_~]/g, '-')
    .replace(/[·•∙⋅]/g, '×')
    .replace(/\*/g, '×')
    .replace(/[:]/g, '÷')
    .replace(/[“”"`^]/g, '');
}

// ---- alignment: characters <-> glyphs -------------------------------------------------------------------

interface Piece {
  chars: string;
  syms: Sym[];
}

/** two straight strokes crossing: '+' (one level, one upright) or 'x' / '×' (both diagonal) */
function crossKind(s: Sym | undefined): 'plus' | 'cross' | null {
  if (!s || s.ink.length !== 2 || s.ink.some((k) => k.straight < 0.9)) return null;
  const ang = s.ink.map((k) => {
    const p = k.pts, n = p.length;
    return (Math.atan2(Math.abs(p[n - 2] - p[1]), Math.abs(p[n - 3] - p[0])) * 180) / Math.PI;
  });
  const lo = Math.min(...ang), hi = Math.max(...ang);
  if (lo < 25 && hi > 58) return 'plus';
  if (lo > 22 && hi < 72) return 'cross';
  return null;
}

const isEqSym = (s: Sym) => s.ink.length === 2 && s.ink.every((k) => k.flat);
const isDivSym = (s: Sym) => s.ink.length === 3 && s.ink.filter((k) => k.flat).length === 1 && s.ink.filter((k) => k.dot).length === 2;
const isMinusSym = (s: Sym) => s.ink.length === 1 && s.flat;

/** a single curved tall stroke: '(' bulges left, ')' bulges right */
function parenKind(s: Sym, run: Run): '(' | ')' | null {
  const hh = run.hh;
  // a smooth shallow arc (not a straight '/', not a 3 or 1 with corners), at least as tall as the
  // glyphs and reaching down to the baseline
  if (s.ink.length !== 1 || s.h < hh * 1.02 || s.w > s.h * 0.5 || s.y1 < run.base - hh * 0.05) return null;
  const k = s.ink[0], p = k.pts, n = p.length;
  if (k.straight > 0.985 || k.straight < 0.8) return null;
  // signed bulge of the middle point against the chord
  const m = Math.floor(n / 6) * 3;
  const ax = p[0], ay = p[1], bx = p[n - 3], by = p[n - 2];
  const cross = ((bx - ax) * (p[m + 1] - ay) - (by - ay) * (p[m] - ax)) / Math.hypot(bx - ax, by - ay);
  if (Math.abs(cross) < s.h * 0.06) return null;
  // written top to bottom: a bulge to the left of the downward chord is '('
  const down = by > ay;
  return (cross > 0) === down ? '(' : ')';
}

/** Short glyphs (x-height letters) next to tall ones (digits, ascenders) in one run. */
const tallRefs = new WeakMap<Sym[], number>();
function tallRef(syms: Sym[]): number {
  let v = tallRefs.get(syms);
  if (v == null) {
    const hs = syms.filter((x) => !x.flat && !x.dot).map((x) => x.h).sort((a, b) => a - b);
    v = hs.length >= 3 ? hs[Math.floor(hs.length * 0.75)] : 0;
    tallRefs.set(syms, v);
  }
  return v;
}

function shapeCost(c: string, s: Sym, run: Run, tall: number): number {
  const dash = c === '-';
  const paren = parenKind(s, run);
  if (paren) return c === paren ? 0 : '()'.includes(c) ? 1.5 : 0.9;
  // digits are all about as tall as each other; a much shorter glyph is a letter (a, not 9)
  if (tall && DIGIT.test(c) && !s.flat && !s.dot && s.h < tall * 0.74) return 2.2;
  // digits sit on the baseline; a glyph reaching well under it is a letter (y, g, p), not 4 or 9
  if (DIGIT.test(c) && !s.flat && s.y1 > run.base + run.hh * 0.3 && s.y0 > run.mid - run.hh * 0.6) return 1.5;
  // operators are smaller than digits (an f is not a +); x does not reach under the baseline (y does)
  if ((c === '+' || c === '=') && tall && s.h > tall * 0.92) return 1.2;
  if ('xX×'.includes(c) && s.y1 > run.base + run.hh * 0.3) return 1;
  if (c === '/' && s.ink.length > 1) return 1; // a slash is one stroke (y is two)
  // 1 is narrow, 7 has a top bar
  if (c === '1' && s.w > s.h * 0.45) return 1;
  if (c === '7' && s.w < s.h * 0.25) return 1;
  if (s.dot) return c === '.' || c === '×' || c === ',' ? 0 : 1;
  if (isMinusSym(s)) return dash ? 0 : c === '=' ? 0.6 : 1.2;
  if (isEqSym(s)) return c === '=' ? 0 : dash ? 0.5 : 1.2;
  if (dash) return s.h < s.w * 0.35 ? 0.3 : 1;
  if (c === '.') return 1;
  return 0;
}

/** Cheapest alignment of chars to the word's glyphs (left to right). */
function align(chars: string, syms: Sym[], run: Run, tall: number): { cost: number; pieces: Piece[] } {
  const hh = run.hh;
  const m = chars.length, n = syms.length;
  const INF = 1e9;
  const cost: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(INF));
  const from: [number, number][][] = Array.from({ length: m + 1 }, () => new Array(n + 1));
  cost[0][0] = 0;
  const relax = (i: number, j: number, di: number, dj: number, c: number) => {
    const v = cost[i][j] + c;
    if (v < cost[i + di][j + dj]) {
      cost[i + di][j + dj] = v;
      from[i + di][j + dj] = [di, dj];
    }
  };
  for (let i = 0; i <= m; i++)
    for (let j = 0; j <= n; j++) {
      if (cost[i][j] >= INF) continue;
      if (i < m && j < n) relax(i, j, 1, 1, shapeCost(chars[i], syms[j], run, tall));
      if (i + 1 < m && j < n && syms[j].w > hh * 0.5) relax(i, j, 2, 1, 0.8);
      if (i + 2 < m && j < n && syms[j].w > hh * 0.9) relax(i, j, 3, 1, 1.6);
      if (i < m && j + 1 < n) relax(i, j, 1, 2, 0.8 + (chars[i] === '=' && syms[j].flat && syms[j + 1].flat ? -0.8 : 0));
      if (i < m && j + 2 < n) relax(i, j, 1, 3, 1.6);
      if (j < n) relax(i, j, 0, 1, 1.5);
      if (i < m) relax(i, j, 1, 0, 1.5);
    }
  const pieces: Piece[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    const [di, dj] = from[i][j];
    pieces.push({ chars: chars.slice(i - di, i), syms: syms.slice(j - dj, j) });
    i -= di;
    j -= dj;
  }
  pieces.reverse();
  return { cost: cost[m][n], pieces };
}

// ---- context normalisation ---------------------------------------------------------------------------------

/**
 * Fixes confusable characters from their neighbours and their glyph's shape. Works on pieces
 * (char groups mapped to glyphs) so the mapping survives. Returns the number of substitutions.
 */
function normalise(pieces: Piece[], run: Run): number {
  // flatten to (char, sym) pairs
  const cs: { c: string; p: Piece }[] = [];
  for (const p of pieces) for (const c of p.chars) cs.push({ c, p });
  let subs = 0;
  const at = (i: number) => cs[i]?.c;
  const set = (i: number, c: string) => {
    if (cs[i].c !== c) {
      cs[i].c = c;
      subs++;
    }
  };
  const nearDigit = (i: number) => DIGIT.test(at(i - 1) ?? '') || DIGIT.test(at(i + 1) ?? '');
  const word = cs.map((x) => x.c).join('');
  const inFunc = (i: number) => FUNCS.some((f) => {
    for (let k = Math.max(0, i - f.length + 1); k <= i; k++) if (word.startsWith(f, k)) return true;
    return false;
  });
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i].c, p = cs[i].p, s = p.syms[0];
    const single = p.chars.length === 1 && p.syms.length === 1;
    // the glyph's shape decides operators that the recogniser mixes up
    if (single && isEqSym(s) && c !== '=') {
      set(i, '=');
      continue;
    }
    if (single && isMinusSym(s) && !'-=÷'.includes(c)) {
      set(i, '-');
      continue;
    }
    const pk = single ? parenKind(s, run) : null;
    if (pk && c !== pk) {
      set(i, pk);
      continue;
    }
    const tall = tallRef(run.syms);
    if (single && tall && /[CKMNOPSUVWXYZ]/.test(c) && s.h < tall * 0.74) {
      set(i, c.toLowerCase()); // a capital's shape at x-height is the small letter
      continue;
    }
    if (single && isDivSym(s) && c !== '÷') {
      set(i, '÷');
      continue;
    }
    if (single && s.dot && c !== '.' && c !== '×') {
      set(i, Math.abs(s.cy - run.mid) < run.hh * 0.25 ? '×' : '.');
      continue;
    }
    const l = at(i - 1), r = at(i + 1);
    if (inFunc(i)) continue;
    // two touching crosses read as two chars ("x+" drawn as one blob): judge each half on its own
    const half = !single && p.chars.length === 2 && p.syms.length === 1 && s.ink.length === 4 ? s.ink.slice().sort((a, b) => a.cx - b.cx) : null;
    const cross = single ? crossKind(s) : half ? crossKind(symOf(cs[i - 1]?.p !== p ? half.slice(0, 2) : half.slice(2))) : null;
    if (cross === 'plus') {
      // an upright cross is a plus; a 't' too, unless it ends a term like 3t+1 (a variable t)
      if (c !== 't' || !(isOperandL(l) && (!r || /[-+=×÷)]/.test(r)))) set(i, '+');
      continue;
    }
    if (cross === 'cross' && c === '+') set(i, 'x');
    // function notation: a tall two-stroke glyph read as + or x right before "(" is an f
    const tallRef0 = tallRef(run.syms);
    if ('+xX×t'.includes(c) && r === '(' && single && s.ink.length === 2 && tallRef0 && s.h > tallRef0 * 0.85 && (!l || !isOperandL(l))) {
      set(i, 'f');
      continue;
    }
    if ('xX×'.includes(cs[i].c)) {
      // × floats above the baseline and is smaller than the letters; x sits on the baseline
      const raised = !!s && s.y1 < run.base - run.hh * 0.12 && s.h < run.hh * 0.85;
      const between = (DIGIT.test(l ?? '') || l === ')') && (DIGIT.test(r ?? '') || r === '(');
      set(i, raised && between ? '×' : c === '×' && between ? '×' : 'x');
    } else if ('lI|'.includes(c)) set(i, '1');
    else if ('Oo'.includes(c) && (nearDigit(i) || !LETTER.test(l ?? '') && !LETTER.test(r ?? ''))) set(i, '0');
    else if ('zZ'.includes(c) && (isOperandR(r) && r !== '(' ? true : DIGIT.test(l ?? '') || c === 'Z')) set(i, '2');
    else if ('sS'.includes(c) && (nearDigit(i) || (c === 'S' && !LETTER.test(l ?? '') && !LETTER.test(r ?? '')))) set(i, '5');
    else if (c === 'B' && nearDigit(i)) set(i, '8');
    else if ((c === 'b' || c === 'G') && nearDigit(i)) set(i, '6');
    else if ((c === 'g' || c === 'q') && nearDigit(i)) set(i, '9');
    else if (c === 't' && isOperandL(l) && isOperandR(r) && !!s && s.y1 < run.base - run.hh * 0.06) set(i, '+');
    else if (c === ',' && DIGIT.test(l ?? '') && DIGIT.test(r ?? '')) set(i, '.');
    else if (c === 'Y') set(i, 'y');
  }
  // a lone glyph (a numerator, an exponent, a root's body) is far more often a digit than a
  // look-alike letter: q/g -> 9, z -> 2, S -> 5, O -> 0, l/|/' -> 1, b -> 6, B -> 8
  if (cs.length === 1) {
    const d = ({ q: '9', g: '9', z: '2', Z: '2', s: '5', S: '5', o: '0', O: '0', l: '1', I: '1', '|': '1', "'": '1', ',': '1', b: '6', B: '8', T: '7' } as Record<string, string>)[cs[0].c];
    if (d) set(0, d);
  }
  // write back
  let k = 0;
  for (const p of pieces) {
    let out = '';
    for (let t = 0; t < p.chars.length; t++) out += cs[k++].c;
    p.chars = out;
  }
  return subs;
}

/** How unlikely a string is as (part of) a math expression; 0 = fine. */
function implausible(s: string, isScript: boolean): number {
  let pen = 0, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!MATH_OK.test(c)) pen += 2;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) pen += 1.2;
      else depth--;
    }
    if (/[A-Z]/.test(c)) pen += 0.25;
    const n = s[i + 1];
    if (n && /[+×÷=]/.test(c) && /[+×÷=]/.test(n)) pen += 1.5;
    if (n && c === '-' && /[+×÷=]/.test(n)) pen += 1.5;
    if (c === '.' && !(DIGIT.test(s[i - 1] ?? '') && DIGIT.test(n ?? ''))) pen += 0.8;
    if (c === "'" && !LETTER.test(s[i - 1] ?? '')) pen += 1; // a prime follows a letter (f')
    if (n === c && LETTER.test(c)) pen += 0.5; // "xx" is usually x+ or x×
  }
  pen += depth * 1.2;
  if (/^[×÷=+]/.test(s)) pen += 1;
  if (/[+×÷=-]$/.test(s) && !isScript) pen += 0.6;
  if ((s.match(/=/g) ?? []).length > 2) pen += 1;
  const letters = s.match(/[a-zA-Z]{3,}/g) ?? [];
  for (const w of letters) if (!FUNCS.some((f) => w.includes(f))) pen += 0.15 * (w.length - 2);
  return pen;
}

// ---- reading one run ------------------------------------------------------------------------------------

interface RunReading {
  pieces: Piece[];
  cost: number;
  text: string;
}

interface Path {
  pieces: Piece[];
  cost: number;
  ranks: number;
}

function symsOfWord(run: Run, words: WordIn[]): Sym[][] {
  const owner = new Map<string, number>();
  words.forEach((w, i) => w.strokeIds.forEach((id) => owner.set(id, i)));
  const out: Sym[][] = words.map(() => []);
  const orphans: Sym[] = [];
  for (const s of run.syms) {
    const votes = new Map<number, number>();
    for (const k of s.ink) {
      const o = owner.get(k.id);
      if (o != null) votes.set(o, (votes.get(o) ?? 0) + 1);
    }
    let best = -1, bv = 0;
    for (const [o, v] of votes) if (v > bv) [best, bv] = [o, v];
    if (best >= 0) out[best].push(s);
    else orphans.push(s);
  }
  // glyphs the recogniser left out join the word nearest to them
  for (const s of orphans) {
    let best = 0, bd = Infinity;
    words.forEach((w, i) => {
      const d = Math.max(0, w.bbox[0] - s.x1, s.x0 - w.bbox[2]);
      if (d < bd) [best, bd] = [i, d];
    });
    out[best]?.push(s);
  }
  for (const a of out) a.sort((p, q) => p.x0 - q.x0);
  return out;
}

/** cost of taking the recogniser's n-th alternate instead of its first */
const RANK_COST = 0.45;

/**
 * The run's text with an operand placeholder where a fraction, root or script sits between its
 * glyphs, so "1/2 + 1/3 = 5/6" is not judged as "+=".
 */
function withStructures(pieces: Piece[], run: Run): string {
  const xs = run.items.filter((it) => it.t === 'frac' || it.t === 'sqrt').map((it) => it.x0).sort((a, b) => a - b);
  let out = '', k = 0;
  for (const p of pieces) {
    const x = p.syms.length ? p.syms[0].x0 : -Infinity;
    while (k < xs.length && xs[k] < x) {
      out += 'F';
      k++;
    }
    out += p.chars;
  }
  return out + 'F'.repeat(xs.length - k);
}

const clonePieces = (ps: Piece[]) => ps.map((p) => ({ chars: p.chars, syms: p.syms }));

/** The best few readings of a math run, cheapest first. */
function readMathRun(run: Run, words: WordIn[], isScript: boolean): RunReading[] {
  if (!run.syms.length) return [{ pieces: [], cost: 0, text: '' }];
  if (!words.length) return [{ pieces: run.syms.map((s) => ({ chars: '', syms: [s] })), cost: 6, text: '' }];
  const ws = words.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
  const wsyms = symsOfWord(run, ws);
  let beam: Path[] = [{ pieces: [], cost: 0, ranks: 0 }];
  ws.forEach((w, wi) => {
    const seen = new Set<string>();
    const cands: { pieces: Piece[]; cost: number; rank: number }[] = [];
    w.alternates.slice(0, 10).forEach((alt, rank) => {
      const chars = plainMath(alt);
      if (seen.has(chars)) return;
      seen.add(chars);
      const a = align(chars, wsyms[wi], run, tallRef(run.syms));
      cands.push({ pieces: a.pieces, cost: a.cost + rank * RANK_COST, rank });
    });
    if (!wsyms[wi].length && !cands.length) return;
    const next: Path[] = [];
    for (const p of beam) for (const c of cands) next.push({ pieces: [...p.pieces, ...c.pieces], cost: p.cost + c.cost, ranks: p.ranks + c.rank });
    next.sort((a, b) => a.cost - b.cost);
    beam = next.slice(0, 16);
  });
  const done: RunReading[] = beam.map((p) => {
    const pieces = clonePieces(p.pieces);
    const subs = normalise(pieces, run);
    const text = pieces.map((x) => x.chars).join('');
    return { pieces, cost: p.cost + subs * 0.15 + implausible(withStructures(pieces, run), isScript), text };
  });
  done.sort((a, b) => a.cost - b.cost);
  const uniq: RunReading[] = [];
  for (const d of done) if (!uniq.some((u) => u.text === d.text)) uniq.push(d);
  return uniq;
}

// ---- emitting text, LaTeX and tokens -----------------------------------------------------------------------

const LATEX_CHAR: Record<string, string> = { '×': '\\times ', '÷': '\\div ', '≤': '\\le ', '≥': '\\ge ', 'π': '\\pi ' };
const LINEAR_CHAR: Record<string, string> = { '×': '*', '÷': '/' };

function latexOf(s: string): string {
  let out = s.replace(/[×÷≤≥π]/g, (c) => LATEX_CHAR[c]);
  for (const f of FUNCS) out = out.replace(new RegExp(`(?<!\\\\)\\b${f}`, 'g'), `\\${f}`);
  return out.replace(/ $/, '');
}

const bboxOfSyms = (ss: { x0: number; y0: number; x1: number; y1: number }[]): BBox => {
  let b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of ss) b = [Math.min(b[0], s.x0), Math.min(b[1], s.y0), Math.max(b[2], s.x1), Math.max(b[3], s.y1)];
  return b;
};

class Out {
  text = '';
  tokens: InkToken[] = [];
  add(s: string, tok?: { text?: string; strokeIds: string[]; bbox: BBox }, start = this.text.length) {
    this.text += s;
    if (tok && tok.strokeIds.length) this.tokens.push({ text: tok.text ?? s, strokeIds: tok.strokeIds, bbox: tok.bbox, span: [start, this.text.length] });
  }
}

/** short scripts need no parentheses in linear text: x^2, x^12, a_n */
const bare = (s: string) => /^([0-9]+|[a-zA-Z])$/.test(s);

function emit(run: Run, readings: Map<Run, RunReading>, out: Out): string {
  const r = readings.get(run)!;
  // the run's own pieces and its structures, left to right
  type Ev = { x: number; piece?: Piece; item?: Run['items'][number] };
  const evs: Ev[] = [];
  let lastX = -Infinity;
  for (const p of r.pieces) {
    const x = p.syms.length ? Math.min(...p.syms.map((s) => s.x0)) : lastX + 0.001;
    lastX = x;
    evs.push({ x, piece: p });
  }
  for (const it of run.items) if (it.t !== 'sym') evs.push({ x: it.x0, item: it });
  evs.sort((a, b) => a.x - b.x);
  let latex = '';
  let seg = '';
  const flush = () => {
    latex += latexOf(seg);
    seg = '';
  };
  for (const ev of evs) {
    if (ev.piece) {
      const p = ev.piece;
      const lin = [...p.chars].map((c) => LINEAR_CHAR[c] ?? c).join('');
      out.add(lin, { text: lin, strokeIds: p.syms.flatMap((s) => s.ink.map((k) => k.id)), bbox: bboxOfSyms(p.syms) });
      seg += p.chars;
      continue;
    }
    flush();
    const it = ev.item!;
    if (it.t === 'sup' || it.t === 'sub') {
      const mark = it.t === 'sup' ? '^' : '_';
      const inner = readings.get(it.run)?.text ?? '';
      const start = out.text.length;
      if (bare(inner) && it.run.items.every((x) => x.t === 'sym')) {
        // one token for the whole script, e.g. "^2"
        out.add(mark);
        const sub = new Out();
        const l = emit(it.run, readings, sub);
        out.add(sub.text, { text: mark + sub.text, strokeIds: sub.tokens.flatMap((t) => t.strokeIds), bbox: bboxOfSyms(it.run.syms) }, start);
        latex += `${mark}{${l}}`;
      } else {
        out.add(mark + '(');
        const l = emit(it.run, readings, out);
        out.add(')');
        latex += `${mark}{${l}}`;
      }
    } else if (it.t === 'frac') {
      out.add('(');
      const n = emit(it.num, readings, out);
      out.add(')');
      out.add('/', { text: 'frac', strokeIds: [it.bar.id], bbox: [it.bar.x0, it.bar.y0, it.bar.x1, it.bar.y1] });
      out.add('(');
      const d = emit(it.den, readings, out);
      out.add(')');
      latex += `\\frac{${n}}{${d}}`;
    } else if (it.t === 'sqrt') {
      out.add('sqrt', { text: '√', strokeIds: [it.radical.id], bbox: [it.radical.x0, it.radical.y0, it.radical.x1, it.radical.y1] });
      out.add('(');
      const b = emit(it.body, readings, out);
      out.add(')');
      latex += `\\sqrt{${b}}`;
    }
  }
  flush();
  return latex;
}

// ---- line ---------------------------------------------------------------------------------------------------

/** 'math' or 'text' from the top readings (and any 2-D structure). */
export function lineKind(layout: Layout, words: WordIn[]): 'math' | 'text' {
  if (layout.structured) return 'math';
  const ws = words.map((w) => (w.alternates[0] ?? '').trim()).filter(Boolean);
  const s = ws.join(' ');
  const longWords = ws.filter((w) => {
    const letters = (w.match(/[a-zA-Z]/g) ?? []).length;
    return letters >= 3 && letters >= w.length * 0.7;
  }).length;
  const mathChars = (s.match(/[0-9=+\-−×÷*/()^<>≤≥]/g) ?? []).length;
  const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
  if (/[=<>≤≥]/.test(s) && longWords <= 1) return 'math';
  // math glyph density: operator-shaped glyphs (=, −, +, ×, ÷, brackets) are rare in prose
  const syms = layout.root.syms;
  const mathy = syms.filter((g) => isEqSym(g) || isMinusSym(g) || isDivSym(g) || crossKind(g) === 'plus' || parenKind(g, layout.root)).length;
  const density = syms.length ? mathy / syms.length : 0;
  if (density >= 0.25 && longWords <= 2) return 'math';
  if (longWords >= 2) return 'text';
  return mathChars > 0 || letters <= 2 ? 'math' : 'text';
}

/** line alternates kept (the CAS checks every one with p >= 0.1) and their cost temperature */
const ALT_MAX = 5;
const ALT_TEMP = 0.5;
const ALT_COVER = 0.35;

/**
 * Logistic confidence over [1, gap, sub, per, cost, runs]: gap = cost margin to the runner-up
 * reading, sub = the same for a runner-up one character away, per/cost = reading cost per run and
 * in total. Fitted on the synthetic eval corpus (tests/live/recog-eval.mjs, docs/live-ink/recog.md).
 */
export const CALIB = [2.869, 0.957, 0.074, -1.122, -0.891, 0.482];
/** features of the last math line read (for calibration tooling) */
export const lastFeatures: number[] = [];

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Turns the recogniser's words for each run (runsOf order) into the line's recognition.
 * `runWords[i]` are the words of run i.
 */
export function readLine(lineId: string, layout: Layout, runWords: WordIn[][]): LineRecognition {
  const runs = runsOf(layout.root);
  const kind = lineKind(layout, runWords.flat());
  if (kind === 'text') return readText(lineId, runWords.flat());
  const readings = new Map<Run, RunReading>();
  const options = new Map<Run, RunReading[]>();
  let cost = 0, margin = Infinity, subGap = Infinity, letters = 0;
  runs.forEach((run, i) => {
    const isScript = i > 0;
    const rs = readMathRun(run, runWords[i] ?? [], isScript);
    options.set(run, rs);
    readings.set(run, rs[0]);
    cost += rs[0].cost;
    if (rs.length > 1) {
      margin = Math.min(margin, rs[1].cost - rs[0].cost);
      // a runner-up one character away (7 vs 1, a vs 9) is the typical misreading
      const a = rs[0].text, b = rs[1].text;
      if (a.length === b.length && [...a].filter((c, k) => c !== b[k]).length === 1) subGap = Math.min(subGap, rs[1].cost - rs[0].cost);
    }
    letters += rs[0].text.length;
  });
  const out = new Out();
  const latex = emit(layout.root, readings, out);
  // other readings of the line: the runner-ups of one run at a time, and of two runs together
  const alts = new Map<string, number>(); // text -> extra cost over the best reading
  const tryAlt = (swaps: [Run, RunReading][]) => {
    const m = new Map(readings);
    let extra = 0;
    for (const [run, alt] of swaps) {
      m.set(run, alt);
      extra += alt.cost - readings.get(run)!.cost;
    }
    const o = new Out();
    emit(layout.root, m, o);
    if (o.text !== out.text && !(alts.get(o.text)! <= extra)) alts.set(o.text, extra);
  };
  const runners = runs.flatMap((run) => (options.get(run) ?? []).slice(1, 4).map((alt) => [run, alt] as [Run, RunReading]));
  for (const a of runners) tryAlt([a]);
  // pairs among the closest runner-ups only (bounded work on long lines)
  const close = runners.sort((a, b) => a[1].cost - readings.get(a[0])!.cost - (b[1].cost - readings.get(b[0])!.cost)).slice(0, 6);
  for (let i = 0; i < close.length; i++) for (let j = i + 1; j < close.length; j++) if (close[i][0] !== close[j][0]) tryAlt([close[i], close[j]]);
  const ranked = [...alts].sort((a, b) => a[1] - b[1]).slice(0, ALT_MAX);
  // confidence: cheap readings with a clear runner-up gap are right; empty readings are not
  const per = cost / Math.max(1, runs.length);
  const gap = Math.min(margin, 3);
  const sub = Math.min(subGap, 3);
  const feats = [gap, sub, per, cost, runs.length];
  lastFeatures.splice(0, lastFeatures.length, ...feats);
  let confidence = sigmoid(CALIB.reduce((a, w, k) => a + w * (k ? feats[k - 1] : 1), 0));
  if (!letters) confidence = 0;
  // the rest of the probability goes to the alternates, by how much more they cost
  const w = ranked.map(([, extra]) => Math.exp(-extra / ALT_TEMP));
  const wsum = w.reduce((a, b) => a + b, 0);
  // most misreadings are not among the alternates at all (measured ~1 in 3), so they share only
  // part of the remaining probability
  const alternateProbs = w.map((x) => Math.round(((1 - confidence) * ALT_COVER * x) / Math.max(wsum, 1e-9) * 1000) / 1000);
  return {
    lineId,
    kind: 'math',
    text: out.text,
    latex,
    confidence: Math.round(confidence * 1000) / 1000,
    alternates: ranked.map(([t]) => t),
    alternateProbs,
    tokens: out.tokens,
    source: 'local-ink',
  };
}

/** A prose line: the recogniser's (dictionary-backed) top reading, one token per word. */
function readText(lineId: string, words: WordIn[]): LineRecognition {
  const ws = words.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
  const out = new Out();
  let agree = 0;
  ws.forEach((w, i) => {
    let t = w.alternates[0] ?? '';
    // inline math in prose ("is 2x"): a capitals-only reading with a digit-led alternate
    if (/^[A-Z]{1,3}$/.test(t)) {
      const m = w.alternates.slice(1, 5).find((a) => /^[0-9]+[a-z]?$/.test(a));
      if (m) t = m;
    }
    // a capital inside a sentence is usually the recogniser's guess, not the writer's
    if (i > 0 && /[A-Z]/.test(t) && w.alternates.slice(1, 4).includes(t.toLowerCase())) t = t.toLowerCase();
    if (i) out.add(' ');
    out.add(t, { strokeIds: w.strokeIds, bbox: w.bbox });
    if ((w.alternates[1] ?? '').toLowerCase() === t.toLowerCase() || w.alternates.length < 2) agree++;
  });
  const confidence = ws.length ? 0.75 + 0.2 * (agree / ws.length) : 0;
  return { lineId, kind: 'text', text: out.text, latex: `\\text{${out.text.replace(/[\\{}$%#&_^~]/g, (c) => '\\' + c)}}`, confidence, alternates: [], tokens: out.tokens, source: 'local-ink' };
}
