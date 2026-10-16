// Live Ink math checker: an on-device CAS that verifies handwritten working step by step.
// Recogniser text (linear, e.g. "2x+3=7") is parsed by a Pratt parser that keeps char spans on every
// node, evaluated exactly with BigInt rationals where possible and by numeric sampling otherwise, and
// consecutive lines are compared as expression chains, arithmetic facts, or equation / inequality
// transformations (the solution set must be preserved).
// Rule zero: 'error' only on overwhelming evidence on a confident reading. Anything this module cannot
// parse or decide comes back 'none' or 'unsure', never 'error'.
// Single file on purpose: node's strip-types test runner cannot resolve extensionless relative imports.
import type { Issue, LineCheck, LineRecognition, MathModule, Verdict } from '../contract';

/** below this recogniser confidence a proven-wrong step is still only 'unsure' (could be a misread) */
export const MIN_ERROR_CONFIDENCE = 0.9;

// ---- exact rationals ------------------------------------------------------------------------------

export interface Rat { n: bigint; d: bigint }
const babs = (a: bigint) => (a < 0n ? -a : a);
function bgcd(a: bigint, b: bigint): bigint {
  a = babs(a); b = babs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}
function mkr(n: bigint, d: bigint): Rat {
  if (d < 0n) { n = -n; d = -d; }
  const g = bgcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}
const rq = (n: number, d = 1): Rat => mkr(BigInt(n), BigInt(d));
const ZERO = rq(0), ONE = rq(1);
const BIG = 1n << 4096n;
const fits = (r: Rat): Rat | null => (babs(r.n) > BIG || r.d > BIG ? null : r);
const radd = (a: Rat, b: Rat) => fits(mkr(a.n * b.d + b.n * a.d, a.d * b.d));
const rsub = (a: Rat, b: Rat) => fits(mkr(a.n * b.d - b.n * a.d, a.d * b.d));
const rmul = (a: Rat, b: Rat) => fits(mkr(a.n * b.n, a.d * b.d));
const rdiv = (a: Rat, b: Rat) => (b.n === 0n ? null : fits(mkr(a.n * b.d, a.d * b.n)));
const req = (a: Rat, b: Rat) => a.n === b.n && a.d === b.d;
const rneg = (a: Rat): Rat => ({ n: -a.n, d: a.d });
const rcmp = (a: Rat, b: Rat) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
const bitlen = (x: bigint) => babs(x).toString(2).length;
function rnum(r: Rat): number {
  const a = Number(r.n), b = Number(r.d);
  if (Number.isFinite(a) && Number.isFinite(b)) return a / b;
  const sh = BigInt(Math.max(bitlen(r.n), bitlen(r.d)) - 1000);
  return Number(r.n >> sh) / Number(r.d >> sh);
}
function rpowi(a: Rat, k: bigint): Rat | null {
  if (k < 0n) { if (a.n === 0n) return null; a = { n: a.d * (a.n < 0n ? -1n : 1n), d: babs(a.n) }; k = -k; }
  if (k > 4000n || (bitlen(a.n) + bitlen(a.d)) * Number(k) > 12000) return null;
  return fits({ n: a.n ** k, d: a.d ** k });
}
function iroot(x: bigint, k: bigint): bigint | null {
  if (x < 0n) return null;
  if (x < 2n) return x;
  const est = Math.pow(Number(x), 1 / Number(k));
  let r = Number.isFinite(est) ? BigInt(Math.round(est)) : 1n << BigInt(Math.ceil(bitlen(x) / Number(k)));
  if (r < 1n) r = 1n;
  for (let i = 0; i < 400; i++) {
    const nx = ((k - 1n) * r + x / r ** (k - 1n)) / k;
    if (nx === r || nx === r + 1n || nx === r - 1n) { r = nx; break; }
    r = nx;
  }
  for (const c of [r - 1n, r, r + 1n]) if (c >= 0n && c ** k === x) return c;
  return null;
}
function rroot(a: Rat, k: bigint): Rat | null {
  if (k <= 0n) return null;
  if (a.n < 0n) { if (k % 2n === 0n) return null; const r = rroot(rneg(a), k); return r && rneg(r); }
  const n = iroot(a.n, k), d = iroot(a.d, k);
  return n !== null && d !== null ? { n, d } : null;
}
function ratFromStr(s: string): Rat {
  const [i, f = ''] = s.split(/[.,]/);
  return mkr(BigInt((i || '0') + f), 10n ** BigInt(f.length));
}
/** best rational with denominator <= maxDen within 1e-9 relative, by continued fractions */
function nice(x: number, maxDen = 1000): Rat | null {
  if (!Number.isFinite(x) || Math.abs(x) > 1e12) return null;
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, y = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(y);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(x - h1 / k1) <= 1e-9 * Math.max(1, Math.abs(x))) return rq(h1, k1);
    const f = y - a;
    if (f < 1e-12) break;
    y = 1 / f;
  }
  return null;
}
function ratText(r: Rat): string {
  return r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`;
}

// ---- AST ------------------------------------------------------------------------------------------

type Kind = 'num' | 'var' | 'const' | 'neg' | 'add' | 'sub' | 'mul' | 'div' | 'pow' | 'pm' | 'fn' | 'deriv' | 'call';
export interface Node {
  t: Kind;
  s: number; // char range in the line text; -1 for synthesised nodes
  e: number;
  q?: Rat; // num value
  txt?: string; // num as written
  name?: string; // var, const ('pi' | 'e'), fn, call
  a?: Node; // operand / fn argument
  b?: Node; // operand / root index / log base
  sym?: string; // operator glyph as written: '*', '·', '×', '' (implicit), '/', '÷', ':'
  os?: number; // operator char offset
  paren?: string; // '(' '[' '{' when written in brackets
  mp?: boolean; // ∓
  v?: string; // deriv variable
  fv?: boolean | 'd'; // value of a user function f(…) substituted from its definition ('d': of f')
}
type RelOp = '=' | '<' | '>' | '<=' | '>=' | '!=' | '~';
interface Rel { parts: Node[]; ops: RelOp[]; opSpans: [number, number][] }
interface Stmt { rels: Rel[]; lead: RelOp | null }
interface Parsed { text: string; segs: Stmt[]; label: boolean; note?: 'pct' | 'sup' | 'ann' | 'mode' } // note: a reading that may only yield 'unsure'

const N = (t: Kind, o: Partial<Node> = {}): Node => ({ t, s: -1, e: -1, ...o });
const num = (q: Rat) => N('num', { q });
const nneg = (a: Node) => N('neg', { a });
const nadd = (a: Node, b: Node) => N('add', { a, b });
const nsub = (a: Node, b: Node) => N('sub', { a, b });
const nmul = (a: Node, b: Node) => N('mul', { a, b, sym: '·' });
const ndiv = (a: Node, b: Node) => N('div', { a, b, sym: '/' });
const npow = (a: Node, b: Node) => N('pow', { a, b });
const nfn = (name: string, a: Node, b?: Node) => N('fn', { name, a, b });

function walk(n: Node, f: (n: Node, parent: Node | null) => void, parent: Node | null = null) {
  f(n, parent);
  if (n.a) walk(n.a, f, n);
  if (n.b) walk(n.b, f, n);
}
function replaceIn(n: Node, target: Node, rep: Node): Node {
  if (n === target) return rep;
  const a = n.a && replaceIn(n.a, target, rep);
  const b = n.b && replaceIn(n.b, target, rep);
  return a === n.a && b === n.b ? n : { ...n, a, b };
}
function varsOf(n: Node, out = new Set<string>()): Set<string> {
  walk(n, (m) => { if (m.t === 'var') out.add(m.name!); });
  return out;
}
const hasVar = (n: Node, v: string) => { let f = false; walk(n, (m) => { if (m.t === 'var' && m.name === v) f = true; }); return f; };
const hasKind = (n: Node, k: Kind) => { let f = false; walk(n, (m) => { if (m.t === k) f = true; }); return f; };
function key(n: Node): string {
  switch (n.t) {
    case 'num': return ratText(n.q!);
    case 'var': case 'const': return n.name!;
    case 'fn': case 'call': return `${n.name}(${key(n.a!)}${n.b ? ',' + key(n.b) : ''})`;
    case 'deriv': return `d${n.v}(${key(n.a!)})`;
    default: return `${n.t}(${n.a ? key(n.a) : ''}${n.b ? ',' + key(n.b) : ''})`;
  }
}
const same = (a: Node, b: Node) => key(a) === key(b);
const size = (n: Node) => { let k = 0; walk(n, () => k++); return k; };

interface Term { n: Node; sign: number; os: number | null }
const isSum = (n: Node) => n.t === 'add' || n.t === 'sub';
/** additive terms of a sum; parenthesised sub-sums stay whole */
function termsOf(n: Node): Term[] {
  const out: Term[] = [];
  const rec = (m: Node, sign: number, os: number | null, top: boolean) => {
    if (isSum(m) && (top || !m.paren)) {
      rec(m.a!, sign, os, false);
      rec(m.b!, m.t === 'sub' ? -sign : sign, m.os ?? null, false);
    } else out.push({ n: m, sign, os });
  };
  rec(n, 1, null, true);
  return out;
}
function buildSum(ts: { n: Node; sign: number }[]): Node {
  if (!ts.length) return num(ZERO);
  let acc = ts[0].sign < 0 ? nneg(ts[0].n) : ts[0].n;
  for (const t of ts.slice(1)) acc = t.sign < 0 ? nsub(acc, t.n) : nadd(acc, t.n);
  return acc;
}

// ---- tokenizer ------------------------------------------------------------------------------------

type TK = 'num' | 'id' | 'fn' | 'const' | 'op' | 'lp' | 'rp' | 'bar' | 'rel' | 'pm' | 'sup' | 'post' | 'sep' | 'imp' | 'deriv';
interface Tok { k: TK; s: number; e: number; v: string; q?: Rat; base?: Rat; mp?: boolean; g?: string }

const KEYWORDS = ['arcsin', 'arccos', 'arctan', 'sqrt', 'sinh', 'cosh', 'tanh', 'asin', 'acos', 'atan', 'oder', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'exp', 'log', 'and', 'und', 'lg', 'ln', 'pi', 'or', 'of'];
const FN_ALIAS: Record<string, string> = { arcsin: 'asin', arccos: 'acos', arctan: 'atan', lg: 'log10' };
const GREEK = 'αβγδεζηθικλμνξοστυφχψωΓΔΘΛΞΣΦΨΩ';
const SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };
const SUB: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
const PF = new Error('parse');

function tokenize(text: string, lo: number, hi: number, commaDecimal: boolean): Tok[] | null {
  const out: Tok[] = [];
  let i = lo;
  const push = (k: TK, s: number, e: number, v: string, extra: Partial<Tok> = {}) => out.push({ k, s, e, v, ...extra });
  while (i < hi) {
    const c = text[i];
    const rest = text.slice(i, hi);
    if (/\s/.test(c) || c === '✓' || c === '✔') { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = rest.match(commaDecimal ? /^(\d+(?:[.,]\d+)?|[.,]\d+)/ : /^(\d+(?:\.\d+)?|\.\d+)/))) {
      push('num', i, i + m[0].length, m[0], { q: ratFromStr(m[0]) });
      i += m[0].length; continue;
    }
    if (SUP[c] !== undefined) {
      let j = i, s = '';
      while (j < hi && SUP[text[j]] !== undefined) s += SUP[text[j++]];
      if (!/^-?\d+$/.test(s)) return null;
      push('sup', i, j, s, { q: rq(Number(s)) });
      i = j; continue;
    }
    if (SUB[c] !== undefined) {
      const prev = out[out.length - 1];
      if (!prev || prev.k !== 'id' || prev.e !== i) {
        if (prev && prev.k === 'fn' && prev.v === 'log' && prev.e === i) {
          let j = i, s = '';
          while (j < hi && SUB[text[j]] !== undefined) s += SUB[text[j++]];
          prev.base = rq(Number(s)); prev.e = j; i = j; continue;
        }
        return null;
      }
      let j = i, s = '';
      while (j < hi && SUB[text[j]] !== undefined) s += SUB[text[j++]];
      prev.v += '_' + s; prev.e = j; i = j; continue;
    }
    if (c === '_') {
      const prev = out[out.length - 1];
      m = rest.match(/^_\{?([0-9]+|[a-zA-Z])\}?/);
      if (!prev || !m) return null;
      if (prev.k === 'id') { prev.v += '_' + m[1]; prev.e = i + m[0].length; i += m[0].length; continue; }
      if (prev.k === 'fn' && prev.v === 'log' && /^\d+$/.test(m[1])) { prev.base = rq(Number(m[1])); prev.e = i + m[0].length; i += m[0].length; continue; }
      return null;
    }
    if ((m = rest.match(/^d([a-zA-Z])\/d([a-zA-Z])(?![a-zA-Z])/))) {
      push('id', i, i + m[0].length, m[1] + "'"); i += m[0].length; continue; // dy/dx is y'
    }
    if ((m = rest.match(/^d\/d([a-zA-Z])(?![a-zA-Z])/))) {
      push('deriv', i, i + m[0].length, m[1]); i += m[0].length; continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < hi && /[A-Za-z]/.test(text[j])) j++;
      const run = text.slice(i, j);
      let p = 0, singles = 0, kw = 0;
      while (p < run.length) {
        const low = run.slice(p).toLowerCase();
        const w = KEYWORDS.find((k) => low.startsWith(k));
        if (w && !(w === 'pi' && run.length > 2 && p > 0)) {
          const s = i + p, e = s + w.length;
          if (w === 'or' || w === 'oder' || w === 'and' || w === 'und') push('sep', s, e, w);
          else if (w === 'of') push('op', s, e, '*', {});
          else if (w === 'pi') push('const', s, e, 'pi');
          else push('fn', s, e, FN_ALIAS[w] ?? w);
          p += w.length; kw++;
        } else {
          const ch = run[p];
          if (ch === 'e') push('const', i + p, i + p + 1, 'e');
          else push('id', i + p, i + p + 1, ch);
          p++; singles++;
        }
      }
      if (run.length >= 4 && singles >= 3) return null; // prose, not maths
      if (kw && singles > 2) return null;
      // a subscript base flattened by the recogniser: log10(…), log2(…), "log 2(8)"
      const last = out[out.length - 1];
      if (last?.k === 'fn' && last.v === 'log' && last.e === j && !last.base) {
        const mm = text.slice(j, hi).match(/^\s?(\d+)\s*(?=[([])/);
        if (mm) { last.base = rq(Number(mm[1])); last.e = j + mm[0].length; j += mm[0].length; }
      }
      i = j; continue;
    }
    if (c === 'π') { push('const', i, i + 1, 'pi'); i++; continue; }
    if (GREEK.includes(c)) { push('id', i, i + 1, c); i++; continue; }
    const two = rest.slice(0, 3);
    if (two.startsWith('<=>') || two.startsWith('<->')) { push('imp', i, i + 3, '⇔'); i += 3; continue; }
    if (two.startsWith('=>') || two.startsWith('->')) { push('imp', i, i + 2, '⇒'); i += 2; continue; }
    if (two.startsWith('<=')) { push('rel', i, i + 2, '<='); i += 2; continue; }
    if (two.startsWith('>=')) { push('rel', i, i + 2, '>='); i += 2; continue; }
    if (two.startsWith('!=') && !/[\d)a-zA-Z]/.test(text[i - 1] ?? '')) { push('rel', i, i + 2, '!='); i += 2; continue; }
    if (two.startsWith('==')) { push('rel', i, i + 2, '='); i += 2; continue; }
    if (two.startsWith('~~')) { push('rel', i, i + 2, '~'); i += 2; continue; }
    if (two.startsWith('**')) { push('op', i, i + 2, '^'); i += 2; continue; }
    switch (c) {
      case '+': push('op', i, i + 1, '+'); break;
      case '-': case '−': case '–': case '—': push('op', i, i + 1, '-'); break;
      case '±': push('pm', i, i + 1, '±'); break;
      case '∓': push('pm', i, i + 1, '∓', { mp: true }); break;
      case '*': case '·': case '⋅': case '•': case '∙': case '×': push('op', i, i + 1, '*', { g: c === '×' ? '×' : '·' }); break;
      case '/': case '÷': case ':': case '∕': push('op', i, i + 1, '/', { g: c === '÷' ? '÷' : c === ':' ? ':' : '/' }); break;
      case '^': push('op', i, i + 1, '^'); break;
      case '(': case '[': case '{': push('lp', i, i + 1, c); break;
      case ')': case ']': case '}': push('rp', i, i + 1, c); break;
      case '|': push('bar', i, i + 1, '|'); break;
      case '√': push('fn', i, i + 1, 'sqrt'); break;
      case '∛': push('fn', i, i + 1, 'cbrt'); break;
      case '∜': push('fn', i, i + 1, 'qrt'); break;
      case '!': case '%': case "'": case '′': case '’': push('post', i, i + 1, c === '!' ? '!' : c === '%' ? '%' : "'"); break;
      case '=': push('rel', i, i + 1, '='); break;
      case '<': push('rel', i, i + 1, '<'); break;
      case '>': push('rel', i, i + 1, '>'); break;
      case '≤': case '⩽': push('rel', i, i + 1, '<='); break;
      case '≥': case '⩾': push('rel', i, i + 1, '>='); break;
      case '≠': push('rel', i, i + 1, '!='); break;
      case '≈': case '≃': case '≅': case '~': push('rel', i, i + 1, '~'); break;
      case '⇒': case '→': case '⟹': case '⇔': case '⟺': case '↔': case '∴': push('imp', i, i + 1, c); break;
      case ',': push('sep', i, i + 1, ','); break;
      case ';': case '∨': case '∧': push('sep', i, i + 1, c); break;
      default: return null;
    }
    i++;
  }
  return out;
}

// ---- parser ---------------------------------------------------------------------------------------

const USER_FNS = new Set(['f', 'g', 'h']);

class Parser {
  i = 0;
  abs = 0;
  noFnImplicit = 0;
  fracTight: boolean;
  private t: Tok[];
  private tight: boolean;
  constructor(t: Tok[], tight: boolean) { this.t = t; this.tight = tight; this.fracTight = t.some((x) => x.g === '÷' || x.g === ':'); }
  peek(o = 0): Tok | undefined { return this.t[this.i + o]; }
  next(): Tok { const t = this.t[this.i++]; if (!t) throw PF; return t; }
  done() { return this.i >= this.t.length; }

  stmt(): Stmt {
    let lead: RelOp | null = null;
    if (this.peek()?.k === 'rel') lead = this.next().v as RelOp;
    const rels: Rel[] = [];
    for (;;) {
      const parts = [this.expr(0)];
      const ops: RelOp[] = [];
      const opSpans: [number, number][] = [];
      while (this.peek()?.k === 'rel') {
        const r = this.next();
        ops.push(r.v as RelOp); opSpans.push([r.s, r.e]);
        parts.push(this.expr(0));
      }
      rels.push({ parts, ops, opSpans });
      if (this.peek()?.k === 'sep') { this.next(); if (this.done()) break; continue; }
      break;
    }
    if (!this.done()) throw PF;
    // "x = 2, -2": bare items after "v = c" mean "v = item"
    if (rels.length > 1) {
      const head = rels[0];
      const v = head.parts[0];
      if (head.ops.length === 1 && head.ops[0] === '=' && v.t === 'var') {
        for (const r of rels.slice(1)) if (!r.ops.length) { r.parts.unshift(N('var', { name: v.name })); r.ops.push('='); r.opSpans.push([-1, -1]); }
      }
      if (rels.some((r) => !r.ops.length)) throw PF;
    }
    return { rels, lead };
  }

  expr(minBp: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      let bp = -1, op = '';
      if (t.k === 'op') {
        op = t.v;
        bp = op === '+' || op === '-' ? 10 : op === '^' ? 30 : op === '/' && t.g === '/' && this.fracTight ? 22 : 20;
      } else if (t.k === 'pm') { op = t.v; bp = 10; }
      else if (this.startsPrimary(t)) { op = 'implicit'; bp = this.tight ? 25 : 20; }
      else break;
      if (bp <= minBp) break;
      if (op === 'implicit') {
        const prev = this.t[this.i - 1];
        if (t.k === 'num' && prev.k !== 'rp' && prev.k !== 'bar') throw PF; // "x2", "2 3": misread, not a product
        const right = this.expr(bp);
        left = N('mul', { a: left, b: right, sym: '', s: left.s, e: right.e });
        continue;
      }
      this.next();
      const right = this.expr(op === '^' ? bp - 1 : bp);
      const base = { a: left, b: right, s: left.s, e: right.e, os: t.s };
      if (op === '+') left = N('add', base);
      else if (op === '-') left = N('sub', base);
      else if (t.k === 'pm') left = N('pm', { ...base, mp: t.mp });
      else if (op === '^') left = N('pow', base);
      else if (op === '*') left = N('mul', { ...base, sym: glyph(t) });
      else left = N('div', { ...base, sym: glyph(t) });
    }
    return left;
  }

  startsPrimary(t: Tok): boolean {
    if (t.k === 'num' || t.k === 'id' || t.k === 'const' || t.k === 'lp' || t.k === 'deriv') return true;
    if (t.k === 'fn') return !this.noFnImplicit;
    if (t.k === 'bar') return this.abs === 0;
    return false;
  }

  group(): Node {
    const l = this.next();
    if (l.k !== 'lp') throw PF;
    const saved = this.abs, savedFn = this.noFnImplicit;
    this.abs = 0; this.noFnImplicit = 0;
    const inner = this.expr(0);
    this.abs = saved; this.noFnImplicit = savedFn;
    const r = this.next();
    if (r.k !== 'rp') throw PF;
    return { ...inner, paren: inner.paren ? inner.paren : l.v, s: l.s, e: r.e };
  }

  prefix(): Node {
    const t = this.peek();
    if (!t) throw PF;
    let n: Node;
    switch (t.k) {
      case 'num': this.next(); n = N('num', { q: t.q, txt: t.v, s: t.s, e: t.e }); break;
      case 'const': this.next(); n = N('const', { name: t.v, s: t.s, e: t.e }); break;
      case 'id': {
        this.next();
        let name = t.v, end = t.e;
        while (this.peek()?.k === 'post' && this.peek()!.v === "'") { name += "'"; end = this.next().e; }
        const nx = this.peek();
        if (name.endsWith("'")) {
          // derivative notation, never a product: y', y'', f'(x), f''(2)
          if (nx?.k === 'lp') { const a = this.group(); n = N('call', { name, a, s: t.s, e: a.e }); break; }
          n = N('var', { name, s: t.s, e: end });
          break;
        }
        if (USER_FNS.has(t.v) && nx?.k === 'lp' && nx.s === t.e) { const a = this.group(); n = N('call', { name: t.v, a, s: t.s, e: a.e }); break; }
        n = N('var', { name: t.v, s: t.s, e: t.e });
        break;
      }
      case 'lp': n = this.group(); break;
      case 'bar': {
        this.next(); this.abs++;
        const inner = this.expr(0);
        this.abs--;
        const r = this.next();
        if (r.k !== 'bar') throw PF;
        n = N('fn', { name: 'abs', a: inner, s: t.s, e: r.e });
        break;
      }
      case 'op':
        this.next();
        if (t.v === '-') { const a = this.expr(20); return N('neg', { a, s: t.s, e: a.e }); }
        if (t.v === '+') return this.expr(20);
        throw PF;
      case 'pm': { this.next(); const b = this.expr(20); return N('pm', { b, s: t.s, e: b.e, os: t.s, mp: t.mp }); }
      case 'fn': n = this.fn(); break;
      case 'deriv': {
        this.next();
        const a = this.peek()?.k === 'lp' ? this.group() : this.expr(20);
        n = N('deriv', { v: t.v, a, s: t.s, e: a.e });
        break;
      }
      case 'sup': {
        this.next();
        const f = this.peek();
        if (f?.k !== 'fn' || f.v !== 'sqrt') throw PF;
        const r = this.fn();
        n = N('fn', { name: 'root', a: r.a, b: num(t.q!), s: t.s, e: r.e });
        break;
      }
      default: throw PF;
    }
    return this.postfix(n);
  }

  postfix(n: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t?.k === 'post') {
        this.next();
        if (t.v === '!') n = N('fn', { name: 'fact', a: n, s: n.s, e: t.e });
        else if (t.v === '%') n = N('fn', { name: 'pct', a: n, s: n.s, e: t.e });
        else n = N('deriv', { v: '?', a: n, s: n.s, e: t.e });
      } else if (t?.k === 'sup') {
        this.next();
        n = N('pow', { a: n, b: N('num', { q: t.q, txt: t.v, s: t.s, e: t.e }), s: n.s, e: t.e, os: t.s });
      } else return n;
    }
  }

  fn(): Node {
    const t = this.next();
    let name = t.v;
    let index: Node | undefined;
    if (name === 'cbrt' || name === 'qrt') { index = num(rq(name === 'cbrt' ? 3 : 4)); name = 'root'; }
    if (name === 'log' && t.base) { name = 'logb'; index = num(t.base); }
    let powAfter: Node | null = null;
    if (name !== 'sqrt' && name !== 'root') {
      const nx = this.peek();
      if (nx?.k === 'sup') { this.next(); powAfter = N('num', { q: nx.q, txt: nx.v, s: nx.s, e: nx.e }); }
      else if (nx?.k === 'op' && nx.v === '^') {
        this.next();
        const p = this.peek();
        if (p?.k === 'num') { this.next(); powAfter = N('num', { q: p.q, txt: p.v, s: p.s, e: p.e }); }
        else if (p?.k === 'lp') powAfter = this.group();
        else if (p?.k === 'op' && p.v === '-') { this.next(); const q = this.next(); if (q.k !== 'num') throw PF; powAfter = N('neg', { a: N('num', { q: q.q, txt: q.v, s: q.s, e: q.e }), s: p.s, e: q.e }); }
        else throw PF;
      }
    }
    let a: Node;
    const nx = this.peek();
    if (nx?.k === 'lp') a = this.group();
    else if (name === 'sqrt' || name === 'root') a = this.prefix();
    else { this.noFnImplicit++; a = this.expr(20); this.noFnImplicit--; }
    if (powAfter && ['sin', 'cos', 'tan'].includes(name)) {
      const k = constRat(powAfter);
      if (k && req(k, rq(-1))) { name = 'a' + name; powAfter = null; } // sin^-1 is arcsin, not 1/sin
    }
    let n = N('fn', { name, a, b: index, s: t.s, e: a.e });
    if (powAfter) n = N('pow', { a: n, b: powAfter, s: t.s, e: a.e });
    return n;
  }
}
const glyph = (t: Tok) => t.g ?? t.v;

/** strip labels ("a)", "1.", "⇒") and trailing working notes ("| -3", "✓"); returns [lo, hi, labelled] */
const ANNOT = /^\|+\s*(?:[+\-−–·×*:÷/^]|√|sqrt|ln|log|exp|\(\s*\)|\d|x\d)/;
/** a trailing operation note without its bar ("4x=12 :4", "x+3=7 (-3)"), as a recogniser that drops "|" produces */
const BARLESS = /\s+(?:[:÷/·×*]{1,2}\s*\(?[+\-−]?\d+(?:[.,]\d+)?\)?|[+\-−]\s*\d+(?:[.,]\d+)?|\(\s*[+\-−·:×÷*/]\s*-?\d+(?:[.,]\d+)?\s*\)|\(\s*-\d+(?:[.,]\d+)?\s*\))\s*$/;
/** strip labels ("a)", "1.", "⇒") and trailing working notes ("| -3 | :2", "✓"); returns [lo, hi, labelled] */
function trimLine(text: string, barless = false): [number, number, boolean] {
  let lo = 0, hi = text.length, label = false;
  const m = text.match(/^\s*(?:(?:[a-hA-H]|\d{1,2}|[ivx]{1,4})\)\s+|\(\s*(?:[a-h]|\d{1,2})\s*\)\s+|\d{1,2}\.\s+|[⇒→∴]|=>|->)\s*/);
  if (m) { lo = m[0].length; label = !/^[\s⇒→∴=>-]+$/.test(m[0]); }
  const bars = [...text.matchAll(/\|+/g)].map((x) => x.index!);
  // the first even bar from which every bar segment to the end is an annotation
  for (let k = 0; k < bars.length; k += 1) {
    if (k % 2 !== 0 && !/^\|\s*[:÷·×*/+\-−]/.test(text.slice(bars[k]))) continue; // closing an |abs|
    let all = true;
    for (let j = k; j < bars.length; j++) if (!ANNOT.test(text.slice(bars[j], bars[j + 1] ?? text.length))) all = false;
    if (all && text.slice(lo, bars[k]).includes('=')) { hi = bars[k]; break; }
  }
  if (barless) {
    for (let g = 0; g < 3; g++) {
      const body = text.slice(lo, hi);
      const mm = body.match(BARLESS);
      if (!mm || !body.slice(0, mm.index).includes('=') || /=\s*$/.test(body.slice(0, mm.index))) break;
      hi = lo + mm.index!;
    }
  }
  return [lo, hi, label];
}

function parseOne(text: string, commaDecimal: boolean, tight: boolean, barless = false): Parsed | null {
  const [lo, hi, label] = trimLine(text, barless);
  const toks = tokenize(text, lo, hi, commaDecimal);
  if (!toks || !toks.length) return null;
  const segs: Stmt[] = [];
  let cur: Tok[] = [];
  const flush = () => {
    if (!cur.length) return;
    const p = new Parser(cur, tight);
    segs.push(p.stmt());
    cur = [];
  };
  try {
    for (const t of toks) { if (t.k === 'imp') flush(); else cur.push(t); }
    flush();
  } catch {
    return null;
  }
  return segs.length ? { text, segs, label } : null;
}

function mapStmt(s: Stmt, f: (n: Node) => Node): Stmt {
  return { lead: s.lead, rels: s.rels.map((r) => ({ ...r, parts: r.parts.map(f) })) };
}
function mapNodes(n: Node, f: (n: Node) => Node | null): Node {
  const r = f(n);
  if (r) return r;
  const a = n.a && mapNodes(n.a, f), b = n.b && mapNodes(n.b, f);
  return a === n.a && b === n.b ? n : { ...n, a, b };
}
const anyNode = (p: Parsed, pred: (n: Node) => boolean) => {
  let f = false;
  for (const s of p.segs) for (const r of s.rels) for (const x of r.parts) walk(x, (m) => { if (pred(m)) f = true; });
  return f;
};

const TRIG_ALL = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc'];
/**
 * Is this trig argument an angle in degrees? One rule for checking and live results: it has no π
 * and its value is 7 or more in size ("sin(30)", "sin(15+15)", "sin(x)" with x = 30). Below that,
 * radians ("sin(1)", "sin(π/6)").
 */
function degreeArg(a: Node, env: Env): boolean {
  let pi = false;
  walk(a, (m) => { if (m.t === 'const' && m.name === 'pi') pi = true; });
  if (pi) return false;
  const [x] = fval(a, env);
  return Number.isFinite(x) && Math.abs(x) >= 7;
}

/** all plausible parses of a line, primary first (decimal comma, 1/2x, log base, degree mode) */
export function parseVariants(text: string): Parsed[] {
  const out: Parsed[] = [];
  const commaAmb = /\d,\d/.test(text);
  const tightAmb = /[/÷:]\s*[\d.]+\s*[A-Za-zα-ωπ(√]/.test(text);
  const commaOpts = commaAmb ? (/\d,\s/.test(text) ? [false, true] : [true, false]) : [false];
  for (const cd of commaOpts) for (const tight of tightAmb ? [false, true] : [false]) {
    const p = parseOne(text, cd, tight);
    if (p) out.push(p);
  }
  if (BARLESS.test(text.replace(/[|✓✔\s]+$/, ''))) {
    const p = parseOne(text, commaOpts[0], false, true);
    // reading the end of the line as a working note may rescue a false red, never make a line right
    if (p && (!out.length || p.segs.length === out[0].segs.length)) out.push(out.length ? { ...p, note: 'ann' } : p);
  }
  const more: Parsed[] = [];
  for (const p of out) {
    if (anyNode(p, (m) => m.t === 'fn' && m.name === 'log')) {
      const numeric = anyNode(p, (m) => m.t === 'fn' && m.name === 'log' && !varsOf(m.a!).size);
      const order = numeric ? ['log10', 'ln'] : ['ln', 'log10'];
      for (const nm of order) more.push({ ...p, segs: p.segs.map((s) => mapStmt(s, (x) => mapNodes(x, (m) => (m.t === 'fn' && m.name === 'log' ? { ...m, name: nm, a: mapNodes(m.a!, () => null) } : null)))) });
    } else more.push(p);
  }
  const res: Parsed[] = [];
  const remap = (p: Parsed, f: (m: Node) => Node | null, note?: Parsed['note']): Parsed => ({ ...p, note, segs: p.segs.map((s) => mapStmt(s, (x) => mapNodes(x, f))) });
  for (const p of more) {
    // angle mode, decided once per line (shared with evaluate): degrees when a numeric angle is a
    // degree-sized number (see degreeArg); the other mode is kept only as an 'unsure'-only reading
    const trig = (m: Node) => m.t === 'fn' && TRIG_ALL.includes(m.name!) && !varsOf(m.a!).size;
    const itrig = (m: Node) => m.t === 'fn' && ['asin', 'acos', 'atan'].includes(m.name!) && !varsOf(m.a!).size;
    if (anyNode(p, (m) => trig(m) || itrig(m))) {
      const deg = remap(p, (m) => (trig(m) ? { ...m, a: nmul(m.a!, ndiv(N('const', { name: 'pi' }), num(rq(180)))) } : itrig(m) ? nmul({ ...m }, ndiv(num(rq(180)), N('const', { name: 'pi' }))) : null));
      if (anyNode(p, (m) => trig(m) && degreeArg(m.a!, {}))) res.push(deg, { ...p, note: 'mode' });
      else res.push(p, { ...deg, note: 'mode' });
    } else res.push(p);
  }
  const base = res[0];
  if (base) {
    // "e" used as a variable (an edge, a misread c) unless it is clearly Euler's number
    let eConst = false, euler = false;
    for (const st of base.segs) for (const r of st.rels) for (const x of r.parts) walk(x, (m, parent) => {
      if (m.t !== 'const' || m.name !== 'e') return;
      eConst = true;
      if (parent && ((parent.t === 'pow' && parent.a === m) || (parent.t === 'fn' && ['ln', 'log', 'log10', 'logb'].includes(parent.name!)))) euler = true;
    });
    if (eConst && !euler && !/[≈~]/.test(text)) res.push(remap(base, (m) => (m.t === 'const' && m.name === 'e' ? { ...m, t: 'var' } : null)));
    // calculator percent: a ± p% means a·(1 ± p/100)
    if (anyNode(base, (m) => isSum(m) && m.b!.t === 'fn' && m.b!.name === 'pct')) {
      res.push(remap(base, (m) => (isSum(m) && m.b!.t === 'fn' && m.b!.name === 'pct' ? { ...m, b: nmul(mapNodes(m.a!, () => null), m.b!) } : null), 'pct'));
    }
    // a dropped superscript on a pure-number line: "23=8" may be 2^3 = 8
    if (/^\s*\d{2,3}\s*=\s*\d{1,3}\s*$/.test(text)) {
      const lit = base.segs[0].rels[0].parts[0];
      const t = lit.txt ?? '';
      const splits = t.length === 2 ? [[t[0], t[1]]] : [[t[0], t.slice(1)], [t.slice(0, 2), t[2]]];
      for (const [a, b] of splits) res.push(remap(base, (m) => (m === lit ? npow(num(rq(Number(a))), num(rq(Number(b)))) : null), 'sup'));
    }
  }
  return res.slice(0, 8);
}

// ---- evaluation -----------------------------------------------------------------------------------

type Env = Record<string, number>;
type QEnv = Record<string, Rat>;
type FF = (env: Env) => number;
let SC = 0; // largest magnitude summed in the current float evaluation (cancellation scale)
const fcache = new WeakMap<Node, FF>();
const dcache = new WeakMap<Node, Node | null>();

function derivOf(n: Node): Node | null {
  if (dcache.has(n)) return dcache.get(n)!;
  let v = n.v!;
  if (v === '?') { const vs = [...varsOf(n.a!)]; v = vs.length === 1 ? vs[0] : vs.length === 0 ? 'x' : ''; }
  const d = v ? D(n.a!, v) : null;
  dcache.set(n, d);
  return d;
}

function cf(n: Node): FF {
  let f = fcache.get(n);
  if (!f) { f = cf0(n); fcache.set(n, f); }
  return f;
}
function cf0(n: Node): FF {
  switch (n.t) {
    case 'num': { const x = rnum(n.q!); return () => x; }
    case 'var': { const k = n.name!; return (env) => { const x = env[k]; return x === undefined ? NaN : x; }; }
    case 'const': { const x = n.name === 'pi' ? Math.PI : Math.E; return () => x; }
    case 'neg': { const A = cf(n.a!); return (env) => -A(env); }
    case 'add': case 'sub': {
      const A = cf(n.a!), B = cf(n.b!), m = n.t === 'sub' ? -1 : 1;
      return (env) => {
        const x = A(env), y = B(env);
        const ax = Math.abs(x), ay = Math.abs(y);
        if (ax > SC) SC = ax;
        if (ay > SC) SC = ay;
        return x + m * y;
      };
    }
    case 'mul': { const A = cf(n.a!), B = cf(n.b!); return (env) => A(env) * B(env); }
    case 'div': { const A = cf(n.a!), B = cf(n.b!); return (env) => { const y = B(env); return y === 0 ? NaN : A(env) / y; }; }
    case 'pow': {
      const A = cf(n.a!), B = cf(n.b!);
      const ex = constRat(n.b!);
      return (env) => {
        const x = A(env), y = B(env);
        if (x === 0 && y < 0) return NaN;
        if (x < 0 && !Number.isInteger(y)) {
          if (ex && ex.d % 2n === 1n) { const r = Math.pow(-x, y); return ex.n % 2n === 0n ? r : -r; }
          return NaN;
        }
        return Math.pow(x, y);
      };
    }
    case 'fn': {
      const A = cf(n.a!);
      const B = n.b ? cf(n.b) : null;
      const g = FLOAT_FN[n.name!];
      if (n.name === 'root') return (env) => { const k = B!(env), x = A(env); if (x < 0) return Number.isInteger(k) && k % 2 === 1 ? -Math.pow(-x, 1 / k) : NaN; return Math.pow(x, 1 / k); };
      if (n.name === 'logb') return (env) => { const b = B!(env), x = A(env); return b > 0 && b !== 1 && x > 0 ? Math.log(x) / Math.log(b) : NaN; };
      if (!g) return () => NaN;
      return (env) => g(A(env));
    }
    case 'deriv': { const d = derivOf(n); return d ? cf(d) : () => NaN; }
    default: return () => NaN;
  }
}
const FLOAT_FN: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos,
  tan: (x) => { const c = Math.cos(x); return Math.abs(c) < 1e-12 ? NaN : Math.sin(x) / c; },
  cot: (x) => { const s = Math.sin(x); return Math.abs(s) < 1e-12 ? NaN : Math.cos(x) / s; },
  sec: (x) => { const c = Math.cos(x); return Math.abs(c) < 1e-12 ? NaN : 1 / c; },
  csc: (x) => { const s = Math.sin(x); return Math.abs(s) < 1e-12 ? NaN : 1 / s; },
  asin: (x) => (Math.abs(x) <= 1 ? Math.asin(x) : NaN), acos: (x) => (Math.abs(x) <= 1 ? Math.acos(x) : NaN), atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  ln: (x) => (x > 0 ? Math.log(x) : NaN), log10: (x) => (x > 0 ? Math.log10(x) : NaN), exp: Math.exp,
  sqrt: (x) => (x < 0 ? (x > -1e-12 ? 0 : NaN) : Math.sqrt(x)), abs: Math.abs, pct: (x) => x / 100,
  fact: (x) => { if (!Number.isInteger(x) || x < 0 || x > 170) return NaN; let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; },
};

function constRat(n: Node): Rat | null { return varsOf(n).size ? null : ex(n, {}); }

/** exact rational value, or null when not rational / not decidable exactly */
function ex(n: Node, env: QEnv): Rat | null {
  switch (n.t) {
    case 'num': return n.q!;
    case 'var': return env[n.name!] ?? null;
    case 'neg': { const a = ex(n.a!, env); return a && rneg(a); }
    case 'add': case 'sub': case 'mul': case 'div': {
      const a = ex(n.a!, env); if (!a) return null;
      const b = ex(n.b!, env); if (!b) return null;
      return n.t === 'add' ? radd(a, b) : n.t === 'sub' ? rsub(a, b) : n.t === 'mul' ? rmul(a, b) : rdiv(a, b);
    }
    case 'pow': {
      const a = ex(n.a!, env); if (!a) return null;
      const b = ex(n.b!, env); if (!b) return null;
      if (b.d === 1n) return rpowi(a, b.n);
      if (b.d > 64n) return null;
      const r = rroot(a, b.d);
      return r && rpowi(r, b.n);
    }
    case 'fn': {
      const a = ex(n.a!, env); if (!a) return null;
      switch (n.name) {
        case 'sqrt': return rroot(a, 2n);
        case 'root': { const k = n.b && ex(n.b, env); return k && k.d === 1n && k.n > 0n && k.n < 64n ? rroot(a, k.n) : null; }
        case 'abs': return a.n < 0n ? rneg(a) : a;
        case 'pct': return rdiv(a, rq(100));
        case 'fact': { if (a.d !== 1n || a.n < 0n || a.n > 60n) return null; let r = 1n; for (let i = 2n; i <= a.n; i++) r *= i; return { n: r, d: 1n }; }
        case 'sin': case 'tan': case 'asin': case 'atan': case 'sinh': case 'tanh': return a.n === 0n ? ZERO : null;
        case 'cos': case 'cosh': case 'exp': return a.n === 0n ? ONE : null;
        case 'ln': return req(a, ONE) ? ZERO : null;
        case 'log10': return logExact(a, rq(10));
        case 'logb': { const b = n.b && ex(n.b, env); return b ? logExact(a, b) : null; }
        default: return null;
      }
    }
    case 'deriv': { const d = derivOf(n); return d ? ex(d, env) : null; }
    default: return null;
  }
}
function logExact(a: Rat, b: Rat): Rat | null {
  if (a.n <= 0n || b.n <= 0n || req(b, ONE)) return null;
  if (req(a, ONE)) return ZERO;
  for (let k = 1n; k <= 64n; k++) {
    const p = rpowi(b, k);
    if (!p) return null;
    if (req(p, a)) return { n: k, d: 1n };
    const ip = rpowi(b, -k);
    if (ip && req(ip, a)) return { n: -k, d: 1n };
    if (rcmp(p, a) > 0 && ip && rcmp(ip, a) < 0 && p.d === 1n && b.d === 1n && rcmp(b, ONE) > 0) return null;
  }
  return null;
}

/** symbolic derivative; null where we do not know the rule */
function D(n: Node, v: string): Node | null {
  switch (n.t) {
    case 'num': case 'const': return num(ZERO);
    case 'var': return num(n.name === v ? ONE : ZERO);
    case 'neg': { const a = D(n.a!, v); return a && nneg(a); }
    case 'add': case 'sub': { const a = D(n.a!, v), b = D(n.b!, v); return a && b && N(n.t, { a, b }); }
    case 'mul': { const a = D(n.a!, v), b = D(n.b!, v); return a && b && nadd(nmul(a, n.b!), nmul(n.a!, b)); }
    case 'div': { const a = D(n.a!, v), b = D(n.b!, v); return a && b && ndiv(nsub(nmul(a, n.b!), nmul(n.a!, b)), npow(n.b!, num(rq(2)))); }
    case 'pow': {
      const aH = hasVar(n.a!, v), bH = hasVar(n.b!, v);
      if (!bH) { const da = D(n.a!, v); return da && nmul(nmul(n.b!, npow(n.a!, nsub(n.b!, num(ONE)))), da); }
      const db = D(n.b!, v);
      if (!db) return null;
      if (!aH) return nmul(nmul(n, nfn('ln', n.a!)), db);
      const da = D(n.a!, v);
      return da && nmul(n, nadd(nmul(db, nfn('ln', n.a!)), ndiv(nmul(n.b!, da), n.a!)));
    }
    case 'fn': {
      const a = n.a!, da = D(a, v);
      if (!da) return null;
      const two = num(rq(2));
      switch (n.name) {
        case 'sin': return nmul(nfn('cos', a), da);
        case 'cos': return nneg(nmul(nfn('sin', a), da));
        case 'tan': return ndiv(da, npow(nfn('cos', a), two));
        case 'ln': return ndiv(da, a);
        case 'log10': return ndiv(da, nmul(a, nfn('ln', num(rq(10)))));
        case 'exp': return nmul(n, da);
        case 'sqrt': return ndiv(da, nmul(two, n));
        case 'root': return D(npow(a, ndiv(num(ONE), n.b!)), v);
        case 'abs': return ndiv(nmul(a, da), n);
        case 'pct': return ndiv(da, num(rq(100)));
        case 'sinh': return nmul(nfn('cosh', a), da);
        case 'cosh': return nmul(nfn('sinh', a), da);
        default: return null;
      }
    }
    case 'deriv': { const inner = derivOf(n); return inner && D(inner, v); }
    default: return null;
  }
}

/** float value plus the cancellation scale of that evaluation */
function fval(n: Node, env: Env): [number, number] {
  SC = 0;
  const x = cf(n)(env);
  return [x, Math.max(SC, Math.abs(x), 1)];
}
const toEnv = (q: QEnv): Env => { const o: Env = {}; for (const k in q) o[k] = rnum(q[k]); return o; };

// ---- polynomials (exact, for term-level diagnostics) -----------------------------------------------

type Poly = Map<string, Rat>;
function monoMul(a: string, b: string): string {
  const m = new Map<string, number>();
  for (const k of [a, b]) for (const p of k ? k.split('*') : []) { const [v, e] = p.split('^'); m.set(v, (m.get(v) ?? 0) + Number(e)); }
  return [...m.entries()].filter(([, e]) => e).sort(([x], [y]) => (x < y ? -1 : 1)).map(([v, e]) => `${v}^${e}`).join('*');
}
function padd(a: Poly, b: Poly, sign = 1): Poly {
  const r = new Map(a);
  for (const [k, c] of b) { const s = radd(r.get(k) ?? ZERO, sign < 0 ? rneg(c) : c)!; if (s.n === 0n) r.delete(k); else r.set(k, s); }
  return r;
}
function pmul(a: Poly, b: Poly): Poly | null {
  let r: Poly = new Map();
  for (const [ka, ca] of a) for (const [kb, cb] of b) { const c = rmul(ca, cb); if (!c) return null; r = padd(r, new Map([[monoMul(ka, kb), c]])); }
  return r.size > 400 ? null : r;
}
function toPoly(n: Node): Poly | null {
  switch (n.t) {
    case 'num': return n.q!.n === 0n ? new Map() : new Map([['', n.q!]]);
    case 'var': return new Map([[`${n.name}^1`, ONE]]);
    case 'neg': { const a = toPoly(n.a!); return a && padd(new Map(), a, -1); }
    case 'add': case 'sub': { const a = toPoly(n.a!), b = toPoly(n.b!); return a && b && padd(a, b, n.t === 'sub' ? -1 : 1); }
    case 'mul': { const a = toPoly(n.a!), b = toPoly(n.b!); return a && b && pmul(a, b); }
    case 'div': { const a = toPoly(n.a!), c = constRat(n.b!); if (!a || !c || c.n === 0n) return null; const inv = rdiv(ONE, c)!; return pmul(a, new Map([['', inv]])); }
    case 'pow': {
      const k = constRat(n.b!);
      if (!k || k.d !== 1n || k.n < 0n || k.n > 12n) return null;
      const a = toPoly(n.a!);
      if (!a) return null;
      let r: Poly | null = new Map([['', ONE]]);
      for (let i = 0n; i < k.n && r; i++) r = pmul(r, a);
      return r;
    }
    case 'fn': if (n.name === 'pct') { const a = toPoly(n.a!); return a && pmul(a, new Map([['', rq(1, 100)]])); } return null;
    case 'deriv': { const d = derivOf(n); return d && toPoly(d); }
    default: return null;
  }
}
function polyText(p: Poly): string {
  if (!p.size) return '0';
  const exps = (k: string) => new Map(k.split('*').filter(Boolean).map((t) => { const [v, e] = t.split('^'); return [v, Number(e)] as const; }));
  const allv = [...new Set([...p.keys()].flatMap((k) => [...exps(k).keys()]))].sort();
  const keys = [...p.keys()].sort((x, y) => {
    if (degOf(y) !== degOf(x)) return degOf(y) - degOf(x);
    const ex2 = exps(x), ey = exps(y);
    for (const v of allv) { const d = (ey.get(v) ?? 0) - (ex2.get(v) ?? 0); if (d) return d; }
    return 0;
  });
  let s = '';
  for (const k of keys) {
    const c = p.get(k)!;
    const neg = c.n < 0n, a = neg ? rneg(c) : c;
    const mono = k.split('*').filter(Boolean).map((t) => { const [v, e] = t.split('^'); return e === '1' ? v : `${v}^${e}`; }).join('');
    const coef = mono && req(a, ONE) ? '' : a.d === 1n ? a.n.toString() : `(${a.n})/(${a.d})`;
    s += (s ? (neg ? '-' : '+') : neg ? '-' : '') + coef + mono;
  }
  return s;
}
const degOf = (k: string) => (k ? k.split('*').reduce((s, t) => s + Number(t.split('^')[1]), 0) : 0);

// ---- sampling and comparison ----------------------------------------------------------------------

const SAMP: Rat[] = [[3, 7], [2, 1], [-5, 3], [7, 4], [-2, 1], [5, 2], [11, 6], [-7, 5], [13, 9], [3, 1], [-9, 4], [8, 5], [1, 3], [-1, 2], [17, 7], [4, 1], [-3, 1], [6, 5], [-11, 8], [9, 2], [5, 7], [-13, 6], [7, 3], [-4, 3]].map(([n, d]) => rq(n, d));
const POS = SAMP.filter((r) => r.n > 0n);
function points(vs: string[], positive: boolean, count: number, offset = 0): QEnv[] {
  const tab = positive ? POS : SAMP;
  const out: QEnv[] = [];
  for (let i = 0; i < count; i++) {
    const p: QEnv = {};
    vs.forEach((v, j) => { p[v] = tab[(i + offset + j * 5 + j * j) % tab.length]; });
    out.push(p);
  }
  return out;
}

type Cmp = 'equal' | 'different' | 'domain' | 'unknown';
function compareConst(A: Node, B: Node): Cmp {
  const a = ex(A, {}), b = ex(B, {});
  if (a && b) return req(a, b) ? 'equal' : 'different';
  const [x, sa] = fval(A, {}), [y, sb] = fval(B, {});
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'unknown';
  const d = Math.abs(x - y), sc = Math.max(sa, sb);
  if (d <= 1e-9 * sc) return 'equal';
  if (d > 1e-6 * sc) return 'different';
  return 'unknown';
}
/** are A and B the same function? 'different' needs an exact counterexample pair or >= 8 strong ones */
function compareExpr(A: Node, B: Node): Cmp {
  const vs = [...varsOf(B, varsOf(A))];
  if (!vs.length) return compareConst(A, B);
  let good = 0, posGood = 0, exactBad = 0, strongBad = 0, posBad = 0, amb = 0;
  const pts = [...points(vs, true, 12, 3).map((p) => [p, true] as const), ...points(vs, false, 20).map((p) => [p, false] as const)];
  for (const [p, pos] of pts) {
    let r: 'eq' | 'X' | 'ne' | 'amb' | 'skip' | null = null;
    { // fast path: floats agreeing to 1e-12 are equal (exact rationals are only needed as evidence of a difference)
      const env = toEnv(p);
      const [x, sa] = fval(A, env), [y, sb] = fval(B, env);
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-12 * Math.max(sa, sb)) r = 'eq';
    }
    const a = r ? null : ex(A, p), b = r ? null : ex(B, p);
    if (r) { /* equal */ }
    else if (a && b) r = req(a, b) ? 'eq' : 'X';
    else {
      const env = toEnv(p);
      const [x, sa] = fval(A, env), [y, sb] = fval(B, env);
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e12 || Math.abs(y) > 1e12) r = 'skip';
      else {
        const d = Math.abs(x - y), sc = Math.max(sa, sb);
        r = d <= 1e-9 * sc ? 'eq' : d > 1e-5 * sc ? 'ne' : 'amb';
      }
    }
    if (r === 'eq') { good++; if (pos) posGood++; }
    else if (r === 'X') { exactBad++; strongBad++; if (pos) posBad++; }
    else if (r === 'ne') { strongBad++; if (pos) posBad++; }
    else if (r === 'amb') amb++;
    if ((exactBad >= 2 && posBad >= 1) || (strongBad >= 8 && posBad >= 3)) return 'different'; // enough evidence
  }
  const bad = strongBad;
  if (!bad && !amb && good >= 6) return 'equal';
  if (!bad) return 'unknown';
  if (!posBad && posGood >= 4) return 'domain';
  if ((exactBad >= 2 && posBad >= 1) || (strongBad >= 8 && posBad >= 3)) return 'different';
  return 'unknown';
}

/** f2 = c·f1 for a nonzero constant c at every sample point (same solution set, any domain) */
function ratioEquiv(f1: Node, f2: Node, vs: string[]): boolean {
  let refQ: Rat | null = null, refF: number | null = null, n = 0;
  for (const p of points(vs, false, 16)) {
    const a = ex(f1, p), b = a ? ex(f2, p) : null;
    if (a && b) {
      if (a.n === 0n) { if (b.n !== 0n) return false; continue; }
      const r = rdiv(b, a)!;
      if (r.n === 0n) return false;
      if (refQ && !req(refQ, r)) return false;
      if (refF !== null && Math.abs(rnum(r) - refF) > 1e-8 * Math.max(1, Math.abs(refF))) return false;
      if (!refQ && refF === null) refQ = r;
      n++;
      continue;
    }
    const env = toEnv(p);
    const [x, sx] = fval(f1, env), [y] = fval(f2, env);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) < 1e-7 * sx) continue;
    const r = y / x;
    if (Math.abs(r) < 1e-12) return false;
    const ref = refQ ? rnum(refQ) : refF;
    if (ref !== null && Math.abs(r - ref) > 1e-7 * Math.max(1, Math.abs(ref))) return false;
    if (ref === null) refF = r;
    n++;
  }
  return n >= 5;
}

// ---- roots ----------------------------------------------------------------------------------------

type Eq = [Node, Node];
interface Root { x: number; q: Rat | null }
const GRID: number[] = (() => {
  const g = new Set<number>([0]);
  for (let i = -200; i <= 200; i++) g.add(i / 20);
  for (let k = -16; k <= 48; k++) { const x = Math.pow(10, k / 8); g.add(x); g.add(-x); }
  return [...g].sort((a, b) => a - b);
})();
const isSolvedEq = (eq: Eq, v?: string) =>
  (eq[0].t === 'var' && (!v || eq[0].name === v) && !varsOf(eq[1]).size) || (eq[1].t === 'var' && (!v || eq[1].name === v) && !varsOf(eq[0]).size);
const solvedVar = (eq: Eq) => (eq[0].t === 'var' && !varsOf(eq[1]).size ? eq[0].name! : eq[1].t === 'var' && !varsOf(eq[0]).size ? eq[1].name! : null);

function rootsOf(eq: Eq, v: string, base: QEnv): Root[] {
  const fb = toEnv(base);
  if (isSolvedEq(eq, v)) {
    const c = eq[0].t === 'var' && eq[0].name === v ? eq[1] : eq[0];
    const q = ex(c, base);
    const [x] = fval(c, fb);
    return Number.isFinite(x) ? [{ x: q ? rnum(q) : x, q }] : [];
  }
  const exact = polyRoots(eq, v, base);
  if (exact) return exact;
  const L = cf(eq[0]), R = cf(eq[1]);
  const env: Env = { ...fb };
  const h = (x: number): [number, number] => {
    env[v] = x; SC = 0;
    const l = L(env); const s1 = SC; SC = 0;
    const r = R(env);
    return [l - r, Math.max(s1, SC, Math.abs(l), Math.abs(r), 1)];
  };
  const out: Root[] = [];
  const add = (x: number) => {
    if (out.some((r) => Math.abs(r.x - x) <= 1e-7 * Math.max(1, Math.abs(x)))) return;
    const q = nice(x);
    if (q) {
      const e = { ...base, [v]: q };
      const a = ex(eq[0], e), b = ex(eq[1], e);
      if (a && b && req(a, b)) { out.push({ x: rnum(q), q }); return; }
    }
    out.push({ x, q: null });
  };
  const vals = GRID.map(h);
  for (let i = 0; i < GRID.length && out.length < 40; i++) {
    const [y, s] = vals[i];
    if (!Number.isFinite(y)) continue;
    if (y === 0) { add(GRID[i]); continue; }
    if (i + 1 < GRID.length) {
      const [y2] = vals[i + 1];
      if (Number.isFinite(y2) && y2 !== 0 && Math.sign(y) !== Math.sign(y2)) {
        let a = GRID[i], b = GRID[i + 1], fa = y;
        for (let k = 0; k < 200 && b - a > 1e-15 * Math.max(1, Math.abs(a)); k++) {
          const m = (a + b) / 2;
          const [fm] = h(m);
          if (!Number.isFinite(fm)) break;
          if (fm === 0) { a = b = m; break; }
          if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m;
        }
        const r = (a + b) / 2;
        const [fr, sr] = h(r);
        if (Number.isFinite(fr) && Math.abs(fr) <= 1e-7 * sr) add(r);
      }
    }
    if (i > 0 && i + 1 < GRID.length) {
      const [y0] = vals[i - 1], [y2] = vals[i + 1];
      if (Number.isFinite(y0) && Number.isFinite(y2) && Math.abs(y) < Math.abs(y0) && Math.abs(y) < Math.abs(y2) && Math.sign(y0) === Math.sign(y) && Math.sign(y2) === Math.sign(y) && Math.abs(y) < 1e-2 * s) {
        let a = GRID[i - 1], b = GRID[i + 1];
        const gr = (Math.sqrt(5) - 1) / 2;
        for (let k = 0; k < 120; k++) {
          const c = b - gr * (b - a), d = a + gr * (b - a);
          if (Math.abs(h(c)[0]) < Math.abs(h(d)[0])) b = d; else a = c;
        }
        const m = (a + b) / 2;
        const [fm, sm] = h(m);
        if (Number.isFinite(fm) && Math.abs(fm) <= 1e-10 * sm) add(m);
      }
    }
  }
  return out;
}

/** exact real roots of a polynomial equation of degree <= 2 in v (other variables fixed), else null */
function polyRoots(eq: Eq, v: string, base: QEnv): Root[] | null {
  const vs = varsOf(eq[1], varsOf(eq[0]));
  for (const x of vs) if (x !== v && !base[x]) return null;
  const subst = (n: Node) => mapNodes(n, (m) => (m.t === 'var' && m.name !== v ? num(base[m.name!]) : null));
  const pe = toPoly(nsub(subst(eq[0]), subst(eq[1])));
  if (!pe) return null;
  const k1 = `${v}^1`, k2 = `${v}^2`;
  for (const k of pe.keys()) if (k !== '' && k !== k1 && k !== k2) return null;
  const c0 = pe.get('') ?? ZERO, c1 = pe.get(k1) ?? ZERO, c2 = pe.get(k2) ?? ZERO;
  const mk = (q: Rat): Root => ({ x: rnum(q), q });
  if (c2.n === 0n) return c1.n === 0n ? null : [mk(rdiv(rneg(c0), c1)!)];
  const D = rsub(rmul(c1, c1)!, rmul(rq(4), rmul(c2, c0)!)!);
  if (!D) return null;
  if (D.n < 0n) return [];
  const two = rmul(rq(2), c2)!;
  if (D.n === 0n) return [mk(rdiv(rneg(c1), two)!)];
  const r = rroot(D, 2n);
  if (r) return [mk(rdiv(rsub(rneg(c1), r)!, two)!), mk(rdiv(radd(rneg(c1), r)!, two)!)];
  const sd = Math.sqrt(rnum(D)), b = rnum(c1), a2 = rnum(two);
  return [{ x: (-b - sd) / a2, q: null }, { x: (-b + sd) / a2, q: null }];
}

type Sat = 'yes' | 'no' | 'undef' | 'amb';
function satisfies(eqs: Eq[], r: Root, v: string, base: QEnv): Sat {
  let best: Sat = 'undef';
  const rank = { yes: 3, amb: 2, no: 1, undef: 0 };
  for (const eq of eqs) {
    let s: Sat | null = null;
    if (r.q) {
      const e = { ...base, [v]: r.q };
      const a = ex(eq[0], e), b = ex(eq[1], e);
      if (a && b) s = req(a, b) ? 'yes' : 'no';
    }
    if (!s) {
      const env = { ...toEnv(base), [v]: r.x };
      const [l, s1] = fval(eq[0], env), [rr, s2] = fval(eq[1], env);
      if (!Number.isFinite(l) || !Number.isFinite(rr)) s = 'undef';
      else {
        const rel = Math.abs(l - rr) / Math.max(s1, s2);
        s = rel <= 1e-7 ? 'yes' : rel >= 1e-4 ? 'no' : 'amb';
      }
    }
    if (rank[s] > rank[best]) best = s;
  }
  return best;
}

type SetCmp = 'equiv' | 'diff' | 'superset' | 'subset' | 'unknown';
const diffNode = (eq: Eq) => nsub(eq[0], eq[1]);
function pickVar(P: Eq[], C: Eq[], vs: string[]): string {
  const sv = C.map(solvedVar);
  if (sv[0] && sv.every((x) => x === sv[0])) return sv[0];
  const iso = C.map((eq) => (eq[0].t === 'var' && !hasVar(eq[1], eq[0].name!) ? eq[0].name : eq[1].t === 'var' && !hasVar(eq[0], eq[1].name!) ? eq[1].name : null)).find(Boolean);
  if (iso) return iso;
  return P.length && P[0][0].t === 'var' ? P[0][0].name! : vs.sort()[vs.length - 1 >= 0 ? vs.indexOf('x') >= 0 ? vs.indexOf('x') : 0 : 0];
}
/** do two disjunctions of equations have the same real solution set? */
function compareEqs(P: Eq[], C: Eq[]): SetCmp {
  const vs = [...new Set([...P.flatMap((e) => [...varsOf(e[0]), ...varsOf(e[1])]), ...C.flatMap((e) => [...varsOf(e[0]), ...varsOf(e[1])])])];
  if (!vs.length) return 'unknown';
  if (P.length === 1 && C.length === 1 && ratioEquiv(diffNode(P[0]), diffNode(C[0]), vs)) return 'equiv';
  const v = pickVar(P, C, vs);
  const others = vs.filter((x) => x !== v);
  const fixings = others.length ? [...points(others, false, 3, 1), ...points(others, true, 1, 2)] : [{}];
  const res: SetCmp[] = [];
  for (const base of fixings) {
    const rp = P.flatMap((eq) => rootsOf(eq, v, base));
    const rc = C.flatMap((eq) => rootsOf(eq, v, base));
    let extra = 0, missing = 0, amb = 0, yes = 0;
    for (const r of rc) { const s = satisfies(P, r, v, base); if (s === 'no') extra++; else if (s === 'amb') amb++; else if (s === 'yes') yes++; }
    for (const r of rp) { const s = satisfies(C, r, v, base); if (s === 'no') missing++; else if (s === 'amb') amb++; else if (s === 'yes') yes++; }
    res.push(extra && missing ? 'diff' : extra ? 'superset' : missing ? 'subset' : amb || !yes ? 'unknown' : 'equiv');
  }
  if (res.every((r) => r === 'equiv')) return 'equiv';
  if (res.every((r) => r === 'diff')) return 'diff';
  if (res.every((r) => r === 'superset' || r === 'equiv')) return 'superset';
  if (res.every((r) => r === 'subset' || r === 'equiv')) return 'subset';
  return 'unknown';
}

type Cond = [Node, RelOp, Node];
function truth(cs: Cond[], env: Env): boolean | null {
  let all = true;
  for (const [L, op, R] of cs) {
    const [l, s1] = fval(L, env), [r, s2] = fval(R, env);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
    const m = (l - r) / Math.max(s1, s2);
    if (Math.abs(m) < 1e-9) return null;
    const t = op === '<' ? m < 0 : op === '<=' ? m < 0 : op === '>' ? m > 0 : op === '>=' ? m > 0 : null;
    if (t === null) return null;
    all = all && t;
  }
  return all;
}
function compareIneqs(P: Cond[], C: Cond[]): SetCmp | 'domain' {
  const vs = [...new Set([...P, ...C].flatMap((c) => [...varsOf(c[0]), ...varsOf(c[2])]))];
  if (!vs.length) return 'unknown';
  const v = vs.includes('x') ? 'x' : vs[0];
  const others = vs.filter((x) => x !== v);
  const fixings = others.length ? points(others, true, 3, 1) : [{}];
  const res: (SetCmp | 'domain')[] = [];
  for (const base of fixings) {
    const env = toEnv(base);
    let agree = 0, dis = 0, posDis = 0;
    for (let i = 0; i < GRID.length; i += 2) {
      env[v] = GRID[i];
      const a = truth(P, env), b = truth(C, env);
      if (a === null || b === null) continue;
      if (a === b) agree++;
      else { dis++; if (GRID[i] > 0) posDis++; }
    }
    res.push(!dis && agree >= 40 ? 'equiv' : dis >= 8 ? (posDis >= 3 ? 'diff' : 'domain') : 'unknown');
  }
  if (res.every((r) => r === 'equiv')) return 'equiv';
  if (res.every((r) => r === 'diff')) return 'diff';
  if (res.every((r) => r === 'domain' || r === 'equiv')) return 'domain';
  return 'unknown';
}

// ---- misconception templates ----------------------------------------------------------------------

interface Mut { title: string; node: Node }
const TRIG = ['sin', 'cos', 'tan'];
const LOGS = ['ln', 'log10', 'logb', 'log'];
function mutateExpr(root: Node): Mut[] {
  const out: Mut[] = [];
  const put = (title: string, target: Node, rep: Node) => out.push({ title, node: replaceIn(root, target, rep) });
  walk(root, (m) => {
    const a = m.a, b = m.b;
    switch (m.t) {
      case 'mul': {
        for (const [k, s] of [[a!, b!], [b!, a!]] as const) {
          if (isSum(s)) {
            const ts = termsOf(s);
            put('Distributed to one term', m, buildSum([{ n: nmul(k, ts[0].n), sign: ts[0].sign }, ...ts.slice(1)]));
            if (ts.length === 2) put('Distributed to one term', m, buildSum([ts[0], { n: nmul(k, ts[1].n), sign: ts[1].sign }]));
          }
        }
        if (a!.t === 'pow' && b!.t === 'pow' && same(a!.a!, b!.a!)) put('Exponent rule', m, npow(a!.a!, nmul(a!.b!, b!.b!)));
        if (same(a!, b!) && hasVars(a!)) put('Like terms', m, nmul(num(rq(2)), a!)); // x·x -> 2x
        if (a!.t === 'div' && !a!.paren) put('Order of operations', m, ndiv(a!.a!, nmul(a!.b!, b!)));
        if (b!.t === 'pow' && !b!.paren) put('Order of operations', m, npow(nmul(a!, b!.a!), b!.b!));
        break;
      }
      case 'neg':
        if (isSum(a!)) { const ts = termsOf(a!); put('Sign error', m, buildSum([{ n: ts[0].n, sign: -ts[0].sign }, ...ts.slice(1)])); }
        if (a!.t === 'pow' && !a!.paren) put('Order of operations', m, npow(nneg(a!.a!), a!.b!));
        break;
      case 'add': case 'sub': {
        const sg = m.t === 'sub' ? -1 : 1;
        if (m.t === 'sub' && isSum(b!)) { const ts = termsOf(b!); put('Sign error', m, buildSum([{ n: a!, sign: 1 }, { n: ts[0].n, sign: -ts[0].sign }, ...ts.slice(1)])); }
        if (b!.t === 'mul' && !b!.paren && b!.sym !== '') put('Order of operations', m, nmul(N(m.t, { a: a!, b: b!.a! }), b!.b!));
        if (a!.t === 'mul' && !a!.paren && a!.sym !== '') put('Order of operations', m, nmul(a!.a!, N(m.t, { a: a!.b!, b: b! })));
        if (m.t === 'add' && a!.t === 'sub' && !a!.paren) put('Order of operations', m, nsub(a!.a!, nadd(a!.b!, b!)));
        if (m.t === 'sub' && a!.t === 'sub' && !a!.paren) put('Order of operations', m, nsub(a!.a!, nsub(a!.b!, b!)));
        // like terms: 2x+3x -> 5x^2
        const coef = (n: Node): [Rat, Node] | null => (n.t === 'mul' && n.a!.t === 'num' ? [n.a!.q!, n.b!] : n.t === 'var' ? [ONE, n] : null);
        const ca = coef(a!), cb = coef(b!);
        if (m.t === 'add' && ca && cb && same(ca[1], cb[1])) put('Like terms', m, nmul(num(radd(ca[0], cb[0])!), npow(ca[1], num(rq(2)))));
        if (a!.t === 'div' && b!.t === 'div') {
          put('Adding fractions', m, ndiv(N(m.t, { a: a!.a!, b: b!.a! }), N(m.t, { a: a!.b!, b: b!.b! })));
          put('Adding fractions', m, ndiv(N(m.t, { a: a!.a!, b: b!.a! }), nmul(a!.b!, b!.b!)));
          put('Adding fractions', m, ndiv(N(m.t, { a: a!.a!, b: b!.a! }), a!.b!));
        }
        if (a!.t !== 'div' && b!.t === 'div') put('Adding fractions', m, ndiv(N(m.t, { a: a!, b: b!.a! }), b!.b!));
        if (a!.t === 'div' && b!.t !== 'div') put('Adding fractions', m, ndiv(N(m.t, { a: a!.a!, b: b! }), a!.b!));
        void sg;
        break;
      }
      case 'pow': {
        const k = constRat(b!);
        if (isSum(a!) && k && k.d === 1n && k.n >= 2n && k.n <= 6n) {
          const ts = termsOf(a!);
          put('Squared term by term', m, buildSum(ts.map((t) => ({ n: npow(t.n, b!), sign: k.n % 2n === 0n ? 1 : t.sign }))));
          put('Squared term by term', m, buildSum(ts.map((t) => ({ n: npow(t.n, b!), sign: t.sign }))));
        }
        if (a!.t === 'pow') put('Exponent rule', m, npow(a!.a!, nadd(a!.b!, b!)));
        if (a!.t === 'mul' && k) { put('Exponent rule', m, nmul(a!.a!, npow(a!.b!, b!))); put('Exponent rule', m, nmul(npow(a!.a!, b!), a!.b!)); }
        if (a!.t === 'div' && k) { put('Exponent rule', m, ndiv(npow(a!.a!, b!), a!.b!)); put('Exponent rule', m, ndiv(a!.a!, npow(a!.b!, b!))); }
        if (k && !varsOf(a!).size) put('Exponent rule', m, nmul(a!, b!));
        break;
      }
      case 'div': {
        if (a!.t === 'pow' && b!.t === 'pow' && same(a!.a!, b!.a!)) put('Exponent rule', m, npow(a!.a!, ndiv(a!.b!, b!.b!)));
        if (a!.t === 'div' && !a!.paren) put('Order of operations', m, ndiv(a!.a!, ndiv(a!.b!, b!)));
        if (b!.t === 'pow' && !b!.paren) put('Order of operations', m, npow(ndiv(a!, b!.a!), b!.b!));
        if (isSum(a!)) {
          const ts = termsOf(a!);
          ts.forEach((t, i) => {
            const others = ts.filter((_, j) => j !== i);
            if (same(t.n, b!)) { put('Cancelled a term', m, buildSum(others)); put('Cancelled a term', m, buildSum([{ n: num(ONE), sign: t.sign }, ...others])); }
            if (t.n.t === 'mul' && same(t.n.a!, b!)) put('Cancelled a term', m, buildSum(ts.map((u, j) => (j === i ? { n: t.n.b!, sign: u.sign } : u))));
            if (t.n.t === 'mul' && same(t.n.b!, b!)) put('Cancelled a term', m, buildSum(ts.map((u, j) => (j === i ? { n: t.n.a!, sign: u.sign } : u))));
            if (t.n.t === 'num' && b!.t === 'num') { const r = rdiv(t.n.q!, b!.q!); if (r) put('Cancelled a term', m, buildSum(ts.map((u, j) => (j === i ? { n: num(r), sign: u.sign } : u)))); }
          });
          if (isSum(b!)) {
            const tb = termsOf(b!);
            for (const t of ts) {
              const j = tb.findIndex((u) => same(u.n, t.n) && u.sign === t.sign);
              if (j >= 0) put('Cancelled a term', m, ndiv(buildSum(ts.filter((u) => u !== t)), buildSum(tb.filter((_, i) => i !== j))));
            }
          }
        } else if (isSum(b!)) {
          const tb = termsOf(b!);
          tb.forEach((t, i) => { if (same(t.n, a!)) put('Cancelled a term', m, ndiv(num(ONE), buildSum(tb.filter((_, j) => j !== i)))); });
        }
        break;
      }
      case 'fn': {
        const nm = m.name!;
        if ((nm === 'sqrt' || nm === 'root') && isSum(a!)) put('Root of a sum', m, buildSum(termsOf(a!).map((t) => ({ n: nfn(nm, t.n, b), sign: t.sign }))));
        if ((nm === 'sqrt' || nm === 'root') && a!.t === 'pow') put('Exponent rule', m, a!.a!);
        if ([...TRIG, ...LOGS, 'exp'].includes(nm) && isSum(a!)) put(LOGS.includes(nm) ? 'Log rule' : 'Not linear', m, buildSum(termsOf(a!).map((t) => ({ n: nfn(nm, t.n, b), sign: t.sign }))));
        if (TRIG.includes(nm) && a!.t === 'mul' && !varsOf(a!.a!).size) put('Not linear', m, nmul(a!.a!, nfn(nm, a!.b!)));
        if (LOGS.includes(nm) && a!.t === 'mul') put('Log rule', m, nmul(nfn(nm, a!.a!, b), nfn(nm, a!.b!, b)));
        if (LOGS.includes(nm) && a!.t === 'div') put('Log rule', m, ndiv(nfn(nm, a!.a!, b), nfn(nm, a!.b!, b)));
        if (LOGS.includes(nm) && a!.t === 'pow') put('Log rule', m, npow(nfn(nm, a!.a!, b), a!.b!));
        break;
      }
    }
  });
  return out;
}

interface EqMut { title: string; eqs: Eq[] }
function numsIn(n: Node): Rat[] {
  const out: Rat[] = [];
  walk(n, (m) => { if (m.t === 'num' && m.q!.n !== 0n && !req(m.q!, ONE)) out.push(m.q!); });
  return out;
}
function mutateEq(eq: Eq): EqMut[] {
  const first: EqMut[] = [], mid: EqMut[] = [], last: EqMut[] = [];
  const [L, R] = eq;
  for (const m of mutateExpr(L)) mid.push({ title: m.title, eqs: [[m.node, R]] });
  for (const m of mutateExpr(R)) mid.push({ title: m.title, eqs: [[L, m.node]] });
  const ks: Rat[] = [];
  for (const k0 of [...numsIn(L), ...numsIn(R)]) for (const k of [k0, rneg(k0)]) if (!ks.some((x) => req(x, k))) ks.push(k);
  for (const [side, other, flip] of [[L, R, false], [R, L, true]] as const) {
    const mk = (s: Node, o: Node): Eq[] => [flip ? [o, s] : [s, o]];
    const ts = termsOf(side);
    if (ts.length >= 2) {
      ts.forEach((t, i) => {
        const rest = buildSum(ts.filter((_, j) => j !== i));
        first.push({ title: 'Sign error', eqs: mk(rest, t.sign > 0 ? nadd(other, t.n) : nsub(other, t.n)) });
      });
    }
    if (side.t === 'mul') {
      for (const [k, x] of [[side.a!, side.b!], [side.b!, side.a!]]) {
        first.push({ title: 'Inverse operation', eqs: mk(x, nmul(other, k)) });
        first.push({ title: 'Inverse operation', eqs: mk(x, nsub(other, k)) });
        first.push({ title: 'Inverse operation', eqs: mk(x, ndiv(k, other)) });
      }
    }
    if (side.t === 'div') {
      first.push({ title: 'Inverse operation', eqs: mk(side.a!, ndiv(other, side.b!)) });
      first.push({ title: 'Inverse operation', eqs: mk(side.a!, nsub(other, side.b!)) });
    }
    if (side.t === 'pow' && constRat(side.b!)) {
      first.push({ title: 'Inverse operation', eqs: mk(side.a!, ndiv(other, side.b!)) });
      first.push({ title: 'Inverse operation', eqs: mk(side.a!, nmul(other, side.b!)) });
    }
    if (side.t === 'fn' && side.name === 'sqrt') first.push({ title: 'Inverse operation', eqs: mk(side.a!, nfn('sqrt', other)) });
    for (const k of ks) {
      const kn = num(k);
      if (ts.length >= 2) ts.forEach((_, i) => last.push({ title: 'Divided only one term', eqs: mk(buildSum(ts.map((u, j) => (j === i ? { n: ndiv(u.n, kn), sign: u.sign } : u))), ndiv(other, kn)) }));
      last.push({ title: 'Divided only one side', eqs: mk(ndiv(side, kn), other) });
      last.push({ title: 'Multiplied only one side', eqs: mk(nmul(side, kn), other) });
    }
  }
  return [...first, ...mid, ...last];
}

// ---- findings and explanations --------------------------------------------------------------------

interface Finding {
  verdict: Verdict;
  title?: string;
  detail?: string;
  hint?: string;
  fix?: string;
  span?: [number, number] | null;
  standalone?: boolean;
  step?: boolean; // the error is about the step from the previous line (not a false fact inside the line)
}
const NONE: Finding = { verdict: 'none' };
const OK: Finding = { verdict: 'ok' };
const rankV: Record<Verdict, number> = { error: 4, unsure: 3, ok: 2, none: 1, pending: 0 };
function combine(fs: Finding[]): Finding {
  let best: Finding = NONE;
  for (const f of fs) if (rankV[f.verdict] > rankV[best.verdict]) best = f;
  return best;
}

const HINTS: Record<string, string> = {
  'Arithmetic slip': 'Recompute this part slowly, one operation at a time.',
  'Not a solution': 'Substitute your value back into the line before and check both sides.',
  'Sign error': 'Check the signs: moving a term across the equals sign, or a minus in front of brackets, flips the sign.',
  'Distributed to one term': 'The factor in front of the brackets multiplies every term inside them.',
  'Squared term by term': 'Write the square as a product, e.g. $(a+b)(a+b)$, and multiply it out.',
  'Root of a sum': 'A root does not split over a sum; simplify inside the root first.',
  'Exponent rule': 'Recall $x^a\\cdot x^b = x^{a+b}$, $(x^a)^b = x^{ab}$ and $(xy)^n = x^n y^n$.',
  'Adding fractions': 'Bring the fractions to a common denominator before adding the numerators.',
  'Cancelled a term': 'Only common factors cancel. Factor the numerator first, then cancel.',
  'Order of operations': 'Powers first, then multiplication and division, then addition and subtraction.',
  'Divided only one side': 'Whatever you do to one side, do to the whole other side as well.',
  'Multiplied only one side': 'Whatever you do to one side, do to the whole other side as well.',
  'Divided only one term': 'When you divide, divide every term on both sides.',
  'Inverse operation': 'Undo each operation with its inverse: multiplication with division, powers with roots.',
  'Not linear': 'Functions like $\\sin$ do not split over sums or pull out factors.',
  'Log rule': 'Recall $\\ln(ab) = \\ln a + \\ln b$ and $\\ln(a^n) = n\\ln a$.',
  'Inequality sign': 'Multiplying or dividing by a negative number reverses the inequality.',
  'Power rule': 'Bring the exponent down as a factor and lower the exponent by one.',
  'Derivative slip': 'Differentiate term by term and check each rule you used.',
  'Dropped a term': 'Compare term by term with the line before; one term went missing.',
  'Like terms': 'Adding like terms adds the coefficients; the power stays the same.',
  'Extra term': 'Compare term by term with the line before; one term does not belong.',
  'Not equivalent': 'Check what you did to both sides in this step.',
  'Lost a solution': 'Dividing by an expression that can be zero can lose solutions. Factor instead.',
  'May add solutions': 'Squaring or multiplying by an expression can add solutions; check them at the end.',
  'Missing a solution': 'Is there another value that also works?',
  'Holds for positive values': 'This is only true under an assumption such as $x \\ge 0$.',
  'Check the endpoint': 'Is the endpoint itself a solution?',
  'Check the reading': 'Was this meant as a power?',
  'Percent notation': 'Write the percentage as a factor to make it unambiguous.',
  "Couldn't verify": 'The checker could not decide this step on the device.',
};
const DETAILS: Record<string, string> = {
  'Sign error': 'A sign went wrong in this step.',
  'Distributed to one term': 'The factor in front of the brackets was applied to only one term.',
  'Squared term by term': 'Squaring a sum does not square each term: $(a+b)^2 \\neq a^2+b^2$.',
  'Root of a sum': 'A root of a sum is not the sum of roots: $\\sqrt{a+b} \\neq \\sqrt{a}+\\sqrt{b}$.',
  'Exponent rule': 'An exponent rule was applied incorrectly.',
  'Adding fractions': 'Fractions are not added by adding numerators and denominators separately.',
  'Cancelled a term': 'A term of a sum was cancelled, but only common factors may cancel.',
  'Order of operations': 'The operations were done in the wrong order.',
  'Divided only one side': 'Only one side of the equation was divided.',
  'Multiplied only one side': 'Only one side of the equation was multiplied.',
  'Divided only one term': 'Only one term was divided, not the whole side.',
  'Inverse operation': 'The operation was undone with the wrong inverse.',
  'Not linear': 'This function does not distribute: $\\sin(a+b) \\neq \\sin a + \\sin b$.',
  'Log rule': 'A logarithm rule was applied incorrectly.',
  'Inequality sign': 'The direction of the inequality is wrong.',
  'Power rule': 'The power rule was applied incorrectly.',
  'Derivative slip': 'This derivative is not correct.',
  'Dropped a term': 'A term from the previous line is missing.',
  'Like terms': 'Like terms were combined incorrectly: $2x+3x = 5x$, and $x\cdot x = x^2$.',
  'Extra term': 'A term appeared that should not be here.',
  'Lost a solution': 'This step can lose a solution of the previous line.',
  'May add solutions': 'This step can introduce solutions the previous line does not have.',
  'Missing a solution': 'The previous line has another solution that is not listed.',
  'Holds for positive values': 'This holds for positive values but not for all values.',
  'Check the endpoint': 'The endpoint is included on one line and excluded on the other.',
  'Check the reading': 'This line is right if it was meant as a power, e.g. $2^3$.',
  'Percent notation': 'Read as a calculator-style percentage, e.g. $50+20\\% = 50\\cdot 1.2$.',
  "Couldn't verify": 'This step could not be verified automatically.',
};

function texNode(n: Node): string { return tex({ ...n, paren: undefined }, 0); }
function texEqs(eqs: Eq[]): string { return eqs.map(([l, r]) => `${texNode(l)} = ${texNode(r)}`).join(' \\;\\text{or}\\; '); }

function unsure(title: string, span: [number, number] | null = null, extra?: string): Finding {
  return { verdict: 'unsure', title, detail: extra ?? DETAILS[title] ?? '', hint: HINTS[title], span };
}

// ---- localisation ---------------------------------------------------------------------------------

interface Fix { kind: 'flip' | 'lit' | 'del' | 'op' | 'coef'; varSide?: boolean; span: [number, number]; text: string; tau?: Rat; target: Node; sign?: boolean }

/** owned nodes of the current line with parent / term info */
function catalogue(parts: Node[]) {
  const lits: { n: Node; parent: Node | null }[] = [];
  const terms: Term[] = [];
  for (const p of parts) {
    if (p.s < 0) continue;
    walk(p, (m, parent) => {
      if (m.s < 0) return;
      if (m.t === 'num') lits.push({ n: m, parent });
      const chainRoot = isSum(m) && !(parent && isSum(parent) && !m.paren);
      if (chainRoot) for (const t of termsOf(m)) if (t.n.s >= 0) terms.push(t);
    });
    if (!isSum(p)) terms.push({ n: p, sign: 1, os: null });
  }
  return { lits, terms };
}
function fmtRat(r: Rat): string {
  if (r.d === 1n) return r.n.toString();
  const x = rnum(r);
  const dec = r.d === 2n || r.d === 4n || r.d === 5n || r.d === 8n || r.d === 10n || r.d === 20n || r.d === 25n || r.d === 100n;
  return dec ? String(Math.round(x * 1e6) / 1e6) : `(${r.n})/(${r.d})`;
}
function splice(text: string, s: number, e: number, rep: string) { return text.slice(0, s) + rep + text.slice(e); }

/**
 * Find the smallest written part whose correction makes `test` pass. `tauFns` builds residual
 * functions g(τ) for a literal replaced by the placeholder variable "__t" (g = 0 when right).
 */
function localize(text: string, parts: Node[], test: (parts: Node[]) => boolean, tauFns: (parts: Node[]) => ((t: number) => number)[], prefer: 'copied' | 'computed' | null = null): Fix | null {
  const { lits, terms } = catalogue(parts);
  const fixes: Fix[] = [];
  const rebuild = (target: Node, rep: Node) => parts.map((p) => replaceIn(p, target, rep));
  let budget = 60;
  // sign flips of terms
  for (const t of terms) {
    if (--budget < 0) break;
    if (test(rebuild(t.n, nneg(t.n)))) {
      let span: [number, number], txt: string;
      if (t.os !== null) { span = [t.os, t.n.e]; const o = text[t.os]; txt = splice(text, t.os, t.os + 1, o === '+' ? '-' : '+'); }
      else if (t.n.t === 'neg') { span = [t.n.s, t.n.e]; txt = splice(text, t.n.s, t.n.a!.s, ''); }
      else { span = [t.n.s, t.n.e]; txt = splice(text, t.n.s, t.n.s, '-'); }
      fixes.push({ kind: 'flip', span, text: txt, target: t.n });
    }
  }
  // literal values
  for (const { n, parent } of lits) {
    if (--budget < 0) break;
    const ph = N('var', { name: '__t' });
    const probe = rebuild(n, ph);
    const taus = new Set<string>();
    for (const g of tauFns(probe)) {
      const t = secant(g, rnum(n.q!));
      const q = t === null ? null : nice(t, 100);
      if (!q || req(q, n.q!) || taus.has(ratText(q))) continue;
      taus.add(ratText(q));
      if (!test(rebuild(n, num(q)))) continue;
      const sign = req(q, rneg(n.q!));
      let span: [number, number] = [n.s, n.e];
      let txt: string;
      const prevCh = text.slice(0, n.s).trimEnd();
      const opIdx = prevCh.length - 1;
      if (sign && parent?.t === 'neg' && parent.s >= 0) { span = [parent.s, n.e]; txt = splice(text, parent.s, n.s, ''); }
      else if (q.n < 0n && (text[opIdx] === '+' || text[opIdx] === '-' || text[opIdx] === '−')) {
        span = sign ? [opIdx, n.e] : span;
        txt = splice(splice(text, n.s, n.e, fmtRat(rneg(q))), opIdx, opIdx + 1, text[opIdx] === '+' ? '-' : '+');
      } else if (q.n < 0n && /[\^·×*/÷(]$/.test(prevCh)) txt = splice(text, n.s, n.e, `(${fmtRat(q)})`);
      else txt = splice(text, n.s, n.e, fmtRat(q));
      fixes.push({ kind: 'lit', span, text: txt, tau: q, target: n, sign });
    }
  }
  // a missing or wrong coefficient on a term without one ("x" for "2x")
  for (const t of terms) {
    if (--budget < 0) break;
    if (t.n.t === 'num' || (t.n.t === 'mul' && (t.n.a!.t === 'num' || t.n.b!.t === 'num')) || t.n.t === 'neg') continue;
    const ph = N('var', { name: '__t' });
    const probe = rebuild(t.n, nmul(ph, t.n));
    for (const g of tauFns(probe)) {
      const v = secant(g, 1);
      const q = v === null ? null : nice(v, 100);
      if (!q || req(q, ONE) || q.n === 0n) continue;
      if (!test(rebuild(t.n, nmul(num(q), t.n)))) continue;
      const sign = req(q, rneg(ONE));
      const txt = splice(text, t.n.s, t.n.s, sign ? '-' : q.d === 1n ? q.n.toString() : `(${fmtRat(q)})`);
      fixes.push({ kind: 'coef', span: [t.n.s, t.n.e], text: txt, tau: q, target: t.n, sign });
      break;
    }
  }
  // extra terms
  for (const t of terms) {
    if (--budget < 0) break;
    if (t.n.s < 0) continue;
    const isTop = parts.includes(t.n);
    if (isTop && termsOf(t.n).length < 2) continue;
    if (test(rebuild(t.n, num(ZERO)))) {
      const span: [number, number] = t.os !== null ? [t.os, t.n.e] : [t.n.s, t.n.e];
      let txt = splice(text, span[0], span[1], '');
      if (t.os === null) txt = txt.slice(0, span[0]) + txt.slice(span[0]).replace(/^\s*\+\s*/, '');
      fixes.push({ kind: 'del', span, text: txt, target: t.n });
    }
  }
  if (!fixes.length) return null;
  for (const f of fixes) { const part = parts.find((p) => p.s <= f.span[0] && f.span[1] <= p.e); f.varSide = !!part && hasVars(part); }
  const order = { flip: 0, lit: 0.2, op: 0.2, del: 2, coef: 100 };
  const score = (f: Fix) =>
    order[f.kind] +
    (prefer === 'copied' ? Number(!f.varSide) * 10 : prefer === 'computed' ? Number(!!f.varSide) * 10 : 0) +
    (f.tau && f.tau.d !== 1n ? 5 : 0) +
    (f.kind === 'flip' || f.sign ? -1 : 0) +
    (f.kind === 'flip' && f.target.t === 'var' ? 1.5 : 0) +
    0.1 * (f.span[1] - f.span[0]);
  fixes.sort((x, y) => score(x) - score(y));
  return fixes[0];
}
function secant(g: (t: number) => number, t0: number): number | null {
  let a = t0, b = t0 + 1;
  let fa = g(a), fb = g(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) { a = t0 + 0.5; fa = g(a); if (!Number.isFinite(fa)) return null; }
  for (let i = 0; i < 60; i++) {
    if (!Number.isFinite(fb)) return null;
    if (Math.abs(fb) < 1e-13 * Math.max(1, Math.abs(b))) return b;
    if (fb === fa) return null;
    const c = b - (fb * (b - a)) / (fb - fa);
    a = b; fa = fb; b = c; fb = g(b);
  }
  return Math.abs(fb) < 1e-9 ? b : null;
}

// ---- line semantics -------------------------------------------------------------------------------

function pmBranches(rel: Rel): Node[][] {
  const has = rel.parts.some((p) => hasKind(p, 'pm'));
  if (!has) return [rel.parts];
  const br = (sign: number) => rel.parts.map((p) => mapNodes(p, (m) => {
    if (m.t !== 'pm') return null;
    const s = m.mp ? -sign : sign;
    const b = mapNodes(m.b!, () => null);
    return m.a ? N(s > 0 ? 'add' : 'sub', { a: mapNodes(m.a, () => null), b, s: m.s, e: m.e, os: m.os }) : s > 0 ? b : N('neg', { a: b, s: m.s, e: m.e });
  }));
  return [br(1), br(-1)];
}
const isRelIneq = (op: RelOp) => op === '<' || op === '>' || op === '<=' || op === '>=';
const hasVars = (n: Node) => varsOf(n).size > 0;

type Eff = { k: 'eq'; eqs: Eq[] } | { k: 'ineq'; conds: Cond[] } | { k: 'ident' } | { k: 'expr'; e: Node } | { k: 'num' } | { k: 'other' };
function effOf(s: Stmt): Eff {
  if (s.rels.length === 1 && !s.rels[0].ops.length) return { k: 'expr', e: s.rels[0].parts[0] };
  const ops = s.rels.flatMap((r) => r.ops);
  const anyVars = s.rels.some((r) => r.parts.some(hasVars));
  if (!anyVars) return { k: 'num' };
  if (ops.every((o) => o === '=')) {
    const eqs: Eq[] = [];
    let ident = true;
    for (const r of s.rels) for (const parts of pmBranches(r)) {
      const c = compareExpr(parts[0], parts[parts.length - 1]);
      if (c !== 'equal') ident = false;
      eqs.push([parts[0], parts[parts.length - 1]]);
    }
    return ident ? { k: 'ident' } : { k: 'eq', eqs };
  }
  if (s.rels.length === 1 && ops.every(isRelIneq) && !s.rels[0].parts.some((p) => hasKind(p, 'pm'))) {
    const p = s.rels[0].parts;
    return { k: 'ineq', conds: s.rels[0].ops.map((o, i) => [p[i], o, p[i + 1]] as Cond) };
  }
  return { k: 'other' };
}

interface Ctx { text: string; defs: Map<string, { param: string; body: Node }> }

/** numeric fact A op B; W (new side) is where a slip is located */
function numericPair(A: Node, B: Node, op: RelOp, ctx: Ctx, newIsA: boolean): Finding {
  const E = newIsA ? B : A, W = newIsA ? A : B;
  if (op === '!=') return compareConst(A, B) === 'different' ? OK : NONE;
  if (isRelIneq(op)) {
    const [a] = fval(A, {}), [b] = fval(B, {});
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NONE;
    const holds = op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
    if (holds) return OK;
    if (Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))) return NONE;
    return { verdict: 'error', title: 'Arithmetic slip', detail: `$${texNode(A)} ${texRel(op)} ${texNode(B)}$ is false.`, hint: HINTS['Arithmetic slip'], span: [W.s, W.e] };
  }
  const c = compareConst(E, W);
  if (c === 'equal') return OK;
  const decimals = W.t === 'num' && W.txt && /[.,]/.test(W.txt) ? W.txt.split(/[.,]/)[1].length : W.t === 'neg' && W.a!.t === 'num' && W.a!.txt && /[.,]/.test(W.a!.txt) ? W.a!.txt.split(/[.,]/)[1].length : -1;
  const [ev] = fval(E, {}), [wv] = fval(W, {});
  if (decimals >= 0 && Number.isFinite(ev)) {
    const tol = 0.5 * Math.pow(10, -decimals);
    if (Math.abs(ev - wv) <= tol * 1.0001) return op === '~' ? OK : OK; // rounded result written with '='
    if (Math.abs(ev - wv) <= 2 * tol) return unsure('Arithmetic slip', [W.s, W.e], `Check the rounding of $${texNode(W)}$.`);
  }
  if (op === '~') {
    if (!Number.isFinite(ev) || !Number.isFinite(wv)) return NONE;
    const rel = Math.abs(ev - wv) / Math.max(Math.abs(ev), 1e-12);
    if (rel <= 0.01 || Math.abs(ev - wv) <= 0.05) return OK;
    if (rel < 0.1) return unsure('Arithmetic slip', [W.s, W.e], `$${texNode(W)}$ is only a rough approximation.`);
  }
  if (c !== 'different') return c === 'unknown' ? NONE : unsure("Couldn't verify");
  return identityError(E, W, ctx, 'numeric');
}
const texRel = (op: RelOp) => ({ '=': '=', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '!=': '\\ne', '~': '\\approx' })[op];

/** E and W should be the same expression and are not: classify, locate, explain */
function identityError(E: Node, W: Node, ctx: Ctx, mode: 'numeric' | 'identity'): Finding {
  const text = ctx.text;
  let title = '';
  let detail = '';
  for (const m of mutateExpr(E)) { const c = compareExpr(m.node, W); if (c === 'equal' || c === 'domain') { title = m.title; break; } }
  const p0 = points([...varsOf(E)], false, 3);
  const loc = localize(text, [W], (ps) => compareExpr(E, ps[0]) === 'equal', (ps) => p0.map((p) => {
    const env = toEnv(p);
    const [ev] = fval(E, env);
    return (t: number) => { env.__t = t; const [wv] = fval(ps[0], env); return ev - wv; };
  }));
  const isDeriv = hasKind(E, 'deriv') || E.fv === 'd';
  if (!title) {
    if (isDeriv && (loc?.kind === 'flip' || loc?.sign)) title = 'Sign error';
    else if (isDeriv) {
      title = loc?.kind === 'lit' && W.s >= 0 && isExponent(W, loc.target) ? 'Power rule' : 'Derivative slip';
    } else if (loc?.kind === 'flip' || loc?.sign) title = 'Sign error';
    else if (loc?.kind === 'del') title = 'Extra term';
    else if (loc) title = 'Arithmetic slip';
    else {
      const pe = toPoly(E), pw = toPoly(W);
      const d = pe && pw ? padd(pe, pw, -1) : null;
      title = d && d.size === 1 && !pw!.has([...d.keys()][0]) ? 'Dropped a term' : 'Arithmetic slip';
    }
  }
  if (mode === 'numeric' && title === 'Arithmetic slip') detail = `$${texNode(E)}$ does not equal $${texNode(W)}$.`;
  else detail = DETAILS[title] ?? `$${texNode(W)}$ is not equal to $${texNode(E)}$.`;
  let span: [number, number] = [W.s, W.e];
  if (loc) span = loc.span;
  if (title === 'Adding fractions' && W.t === 'div' && W.b!.s >= 0) span = [W.b!.s, W.b!.e];
  let fix: string | undefined;
  const val = !varsOf(E).size ? ex(E, {}) : null;
  if (loc && !(val && loc.kind === 'lit' && loc.tau!.d !== 1n)) fix = latexOrNull(loc.text);
  else if (W.s >= 0) {
    const pe = toPoly(E);
    const rep = val ? fmtRat(val) : pe && pe.size <= 8 ? polyText(pe) : null;
    if (rep) fix = latexOrNull(splice(text, W.s, W.e, rep));
  }
  return { verdict: 'error', title, detail, hint: HINTS[title], fix, span };
}
function isExponent(root: Node, target: Node): boolean {
  let f = false;
  walk(root, (m) => { if (m.t === 'pow' && m.b === target) f = true; });
  return f;
}
function latexOrNull(text: string): string | undefined {
  const v = parseVariants(text);
  return v.length ? texParsed(v[0]) : undefined;
}

function identityPair(A: Node, B: Node, ctx: Ctx): Finding {
  const c = compareExpr(A, B);
  if (c === 'equal') return OK;
  if (c === 'domain') return unsure('Holds for positive values', [B.s, B.e]);
  if (c === 'unknown') return unsure("Couldn't verify", null);
  return identityError(A, B, ctx, 'identity');
}

/** checks inside one statement: chains, arithmetic facts, derivative lines */
function internalChecks(s: Stmt, ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  for (const rel of s.rels) {
    if (!rel.ops.length) continue;
    for (const parts of pmBranches(rel)) {
      const idMode = rel.ops.length >= 2 && rel.ops[0] === '=' && rel.ops[1] === '=' && hasVars(parts[0]) && compareExpr(parts[0], parts[1]) === 'equal';
      for (let k = 0; k < rel.ops.length; k++) {
        const A = parts[k], B = parts[k + 1], op = rel.ops[k];
        const vA = hasVars(A), vB = hasVars(B);
        if (!vA && !vB) {
          const single = rel.ops.length === 1 && !s.lead;
          const newIsA = single && size(A) < size(B);
          out.push(numericPair(A, B, op, ctx, newIsA));
          continue;
        }
        if (op !== '=') continue;
        const deriv = hasKind(A, 'deriv') || hasKind(B, 'deriv') || !!A.fv || !!B.fv;
        const required = k >= 1 || (s.lead !== null && k === 0) || idMode || deriv;
        if (!required) continue;
        if (vA !== vB) continue; // substitution "y = 2x+3 = 2·3+3", or an equation "f'(x) = 0"
        if (B.s < 0) continue;
        // "a = v'", "m = y' = 2": a new name for a derivative is a definition, not an identity in a
        if (k === 0 && A.t === 'var' && !A.name!.endsWith("'") && !A.fv && !hasVar(B, A.name!) && (B.fv || hasKind(B, 'deriv'))) continue;
        if ((hasKind(B, 'deriv') && !hasKind(A, 'deriv')) || (B.fv && !A.fv)) out.push(identityPair(B, A, ctx));
        else out.push(identityPair(A, B, ctx));
      }
    }
  }
  return out;
}

function stmtVars(s: Stmt): Set<string> {
  const v = new Set<string>();
  for (const r of s.rels) for (const p of r.parts) varsOf(p, v);
  return v;
}
function numbersOf(s: Stmt): string[] {
  const out: string[] = [];
  for (const r of s.rels) for (const p of r.parts) walk(p, (m) => { if (m.t === 'num') out.push(ratText(m.q!)); });
  return out;
}
function subtreeKeys(s: Stmt): Set<string> {
  const out = new Set<string>();
  for (const r of s.rels) for (const p of r.parts) walk(p, (m) => { if (size(m) >= 2 && m.t !== 'neg') out.add(key(m)); });
  return out;
}
const plainNumber = (n: Node) => n.t === 'num' || (n.t === 'neg' && n.a!.t === 'num');
/** is C plausibly the next step of P (and not the start of a new problem)? */
function continuous(P: Stmt, C: Stmt, Pe: Eq[], Ce: Eq[]): boolean {
  if (Pe.every((e) => isSolvedEq(e) && (plainNumber(e[0]) || plainNumber(e[1])))) return false; // after a final answer
  if (Ce.every((e) => isSolvedEq(e))) return true;
  const pk = subtreeKeys(P);
  for (const k of subtreeKeys(C)) if (pk.has(k)) return true;
  const a = numbersOf(P), b = numbersOf(C);
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sb].filter((x) => sa.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni > 0 && inter / uni >= 0.5;
}

function renameSubscripts(C: Stmt, pv: Set<string>): Stmt {
  return mapStmt(C, (x) => mapNodes(x, (m) => {
    if (m.t !== 'var' || pv.has(m.name!) || !m.name!.includes('_')) return null;
    const base = m.name!.split('_')[0];
    return pv.has(base) ? { ...m, name: base } : null;
  }));
}

/** the misconception whose result matches C, preferring one whose sides match C's sides exactly */
function bestTemplate(eq: Eq, Ce: Eq[]): string {
  let best = '', bestScore = -1;
  const polys = Ce.length === 1 ? [toPoly(Ce[0][0]), toPoly(Ce[0][1])] : [null, null];
  const peq = (a: Poly | null, b: Poly | null) => !!a && !!b && a.size === b.size && [...a].every(([k, c]) => { const d = b.get(k); return !!d && req(c, d); });
  for (const m of mutateEq(eq)) {
    if (compareEqs(m.eqs, Ce) !== 'equiv') continue;
    let sc = 0;
    if (m.eqs.length === 1) {
      const [a, b] = [toPoly(m.eqs[0][0]), toPoly(m.eqs[0][1])];
      sc = Math.max(Number(peq(a, polys[0])) + Number(peq(b, polys[1])), Number(peq(a, polys[1])) + Number(peq(b, polys[0])));
    }
    if (sc > bestScore) { best = m.title; bestScore = sc; }
    if (sc === 2) break;
  }
  return best;
}

/**
 * The precision a written answer claims, and whether rounding to it is unambiguous:
 * 2.33 → 0.01, 3.3·10^-4 → 10^-5, 1158 → 1. Small whole numbers (2 for 2.4) and trailing zeros
 * (1200: exact, or rounded to 2 significant figures?) are ambiguous. null: not a plain number.
 */
function precisionOf(n: Node): { u: number; clear: boolean } | null {
  const t = n.t === 'neg' ? n.a! : n;
  if (t.t === 'num' && t.txt) {
    const [int, frac] = t.txt.split(/[.,]/);
    if (frac !== undefined) return { u: Math.pow(10, -frac.length), clear: true };
    const zeros = /0*$/.exec(int)![0].length;
    if (zeros && zeros < int.length) return { u: Math.pow(10, zeros), clear: false };
    return { u: 1, clear: Math.abs(Number(int)) >= 10 };
  }
  // scientific notation m·10^k
  if (t.t === 'mul' && t.b?.t === 'pow' && t.b.a?.t === 'num' && t.b.a.txt === '10' && t.b.b) {
    const m = precisionOf(t.a!);
    const [k] = fval(t.b.b, {});
    if (m && Number.isInteger(k)) return { u: m.u * Math.pow(10, k), clear: m.clear || m.u < 1 };
  }
  return null;
}
/**
 * "3x=7" then "x=2.33", "A=π·25" then "A=79", "x=1/3000" then "x=3.3·10^-4", "sin(x)=0.5" then
 * "x=30": a solved value written rounded is right when the exact solution rounds to exactly what
 * is written, at the precision written. A value one rounding step off (truncated, 1.99 for 2) is
 * 'unsure', never right; ambiguous roundings are 'unsure'. Returns OK, an 'unsure', or null.
 */
function roundedAnswer(P: Eq[], C: Eq[]): Finding | null {
  if (!C.length || !C.every((e) => isSolvedEq(e))) return null;
  const vs = new Set([...P, ...C].flatMap((e) => [...varsOf(e[0]), ...varsOf(e[1])]));
  if (vs.size !== 1) return null;
  const v = [...vs][0];
  const trig = P.some((e) => [e[0], e[1]].some((x) => { let f = false; walk(x, (m) => { if (m.t === 'fn' && TRIG_ALL.includes(m.name!) && hasVar(m.a!, v)) f = true; }); return f; }));
  const f = (x: number) => { let best = Infinity; for (const e of P) { const [l, s1] = fval(e[0], { [v]: x }), [r, s2] = fval(e[1], { [v]: x }); if (Number.isFinite(l) && Number.isFinite(r)) best = Math.min(best, Math.abs(l - r) / Math.max(s1, s2)); } return best; };
  const sgn = (x: number) => { for (const e of P) { const l = fval(e[0], { [v]: x })[0] - fval(e[1], { [v]: x })[0]; if (Number.isFinite(l)) return Math.sign(l); } return NaN; };
  /** P has a root in [lo, hi] (exactly at an end counts) */
  const near = (lo: number, hi: number) => {
    if (f(lo) <= 1e-12 || f(hi) <= 1e-12 || f((lo + hi) / 2) <= 1e-12) return true;
    const a = sgn(lo), b = sgn(hi);
    return Number.isFinite(a) && Number.isFinite(b) && a !== b && f((lo + hi) / 2) < 0.5;
  };
  const vals: number[] = [];
  let doubt = '';
  for (const e of C) {
    const c = e[0].t === 'var' ? e[1] : e[0];
    const [cv] = fval(c, {});
    if (!Number.isFinite(cv)) return null;
    const p = precisionOf(c);
    if (!p && !trig) return null;
    const deg = Math.PI / 180;
    // a small whole number (x=3 for 3.33) is an answer, not a rounding
    if (p && !p.clear && p.u === 1 && !trig) return null;
    if (p && !(p.u === 1 && !p.clear)) {
      // half a unit either side, widened by float noise only (never by a whole unit)
      const half = p.u / 2 + 1e-9 * Math.max(1, Math.abs(cv));
      // trig solutions repeat every turn: a whole-number angle of 7 or more is degrees (as in live
      // results), and radian rounding only counts within one turn, or x=30 would "round" 30.37 rad
      const radians = !trig || (Math.abs(cv) <= 2 * Math.PI + 0.5 && !(p.u === 1 && Math.abs(cv) >= 7));
      if (radians && near(cv - half, cv + half)) {
        if (!p.clear) doubt = 'Check the rounding';
        vals.push(cv);
        continue;
      }
      if (trig && near((cv - half) * deg, (cv + half) * deg)) {
        vals.push(cv * deg);
        continue;
      }
      // one rounding step off a decimal (truncated, or 1.99 for 2): not right, but not proven wrong
      if (radians && p.u < 1 && near(cv - p.u - 1e-9 * Math.max(1, Math.abs(cv)), cv + p.u + 1e-9 * Math.max(1, Math.abs(cv)))) {
        doubt = 'Check the rounding';
        vals.push(cv);
        continue;
      }
      return null;
    }
    // a whole-number angle for a trig equation: degrees
    const d = 1e-9 * Math.max(1, Math.abs(cv));
    if (trig && near((cv - d) * deg, (cv + d) * deg)) {
      vals.push(cv * deg);
      continue;
    }
    return null;
  }
  if (doubt) return unsure(doubt);
  if (trig) return OK;
  const roots = P.flatMap((e) => rootsOf(e, v, {}));
  const missing = roots.some((r) => !vals.some((x) => Math.abs(x - r.x) <= 0.5 * Math.max(1e-6, Math.abs(r.x) * 1e-2, 0.1)));
  return missing ? unsure('Missing a solution') : OK;
}

/** some solution of P is also a solution of C (a partly right step, not a new problem) */
function sharedRoot(P: Eq[], C: Eq[], v: string): boolean {
  return P.flatMap((eq) => rootsOf(eq, v, {})).some((r) => satisfies(C, r, v, {}) === 'yes');
}

/** C is the statement after P: same solution set? */
function stepCheck(P: Stmt, C: Stmt, ctx: Ctx): Finding {
  const pv = stmtVars(P);
  C = renameSubscripts(C, pv);
  const ep = effOf(P), ec = effOf(C);
  const cv = stmtVars(C);
  if (ep.k === 'expr' && ec.k === 'expr') {
    if (!hasVars(ep.e) && !hasVars(ec.e)) return compareConst(ep.e, ec.e) === 'equal' ? OK : NONE;
    return compareExpr(ep.e, ec.e) === 'equal' ? OK : NONE;
  }
  if (ec.k === 'ident' || ec.k === 'num' || ec.k === 'expr' || ec.k === 'other') return NONE;
  if (ep.k === 'num' || ep.k === 'expr' || ep.k === 'other') return NONE;
  for (const v of cv) if (!pv.has(v)) return NONE; // a new variable: a new problem or a substitution
  if (cv.size < pv.size) return NONE;
  const multi = pv.size > 1;
  if (ep.k === 'ident') return NONE; // e.g. a factorisation fact followed by an equation to solve
  if (ep.k === 'eq' && ec.k === 'eq') {
    const r = compareEqs(ep.eqs, ec.eqs);
    if (r === 'equiv') return OK;
    // a final answer "x = 2" ends the problem: what follows is a new problem, not a step
    if (ep.eqs.every((e) => isSolvedEq(e) && (plainNumber(e[0]) || plainNumber(e[1])))) return NONE;
    const rounded = roundedAnswer(ep.eqs, ec.eqs);
    if (rounded) return rounded;
    let title = '';
    if ((r === 'diff' || (multi && r === 'unknown')) && ep.eqs.length === 1) title = bestTemplate(ep.eqs[0], ec.eqs);
    // a known misconception is proof this is a step; otherwise it could be a new problem
    if (!title && !continuous(P, C, ep.eqs, ec.eqs) && !(r === 'diff' && !multi && sharedRoot(ep.eqs, ec.eqs, [...pv][0]))) return NONE;
    if (r === 'superset') return unsure('May add solutions');
    if (r === 'subset') {
      const lost = ec.eqs.every((e) => isSolvedEq(e)) ? 'Missing a solution' : 'Lost a solution';
      return unsure(lost);
    }
    if (r !== 'diff' || (multi && !title)) return multi ? NONE : unsure("Couldn't verify");
    return { ...eqError(ep.eqs, C, ec.eqs, title, ctx), step: true };
  }
  if (ep.k === 'ineq' && ec.k === 'ineq') {
    const r = compareIneqs(ep.conds, ec.conds);
    const strict = (cs: Cond[]) => cs.map((c) => c[1] === '<' || c[1] === '>').sort().join();
    if (r === 'equiv') return strict(ep.conds) === strict(ec.conds) ? OK : unsure('Check the endpoint');
    if (r === 'domain') return unsure('Holds for positive values');
    if (r !== 'diff') return unsure("Couldn't verify");
    if (multi) return NONE;
    // flipped inequality?
    const rel = C.rels[0];
    for (let i = 0; i < rel.ops.length; i++) {
      const flipped = ec.conds.map((c, j) => (j === i ? [c[0], flipOp(c[1]), c[2]] as Cond : c));
      if (compareIneqs(ep.conds, flipped) === 'equiv' && rel.opSpans[i][0] >= 0) {
        const [s, e] = rel.opSpans[i];
        return { step: true, verdict: 'error', title: 'Inequality sign', detail: DETAILS['Inequality sign'], hint: HINTS['Inequality sign'], span: [s, e], fix: latexOrNull(splice(ctx.text, s, e, opText(flipOp(rel.ops[i])))) };
      }
    }
    const parts = ec.conds.flatMap((c) => [c[0], c[2]]);
    const rebuildConds = (ps: Node[]) => ec.conds.map((c, i) => [ps[2 * i], c[1], ps[2 * i + 1]] as Cond);
    const bound = ep.conds.map((c) => [c[0], c[2]] as Eq);
    const v = [...pv][0];
    const roots = bound.flatMap((eq) => rootsOf(eq, v, {})).slice(0, 4);
    const loc = localize(ctx.text, parts, (ps) => compareIneqs(ep.conds, rebuildConds(ps)) === 'equiv', (ps) => {
      const cs = rebuildConds(ps);
      return roots.flatMap((r) => cs.map((c) => (t: number) => { const env: Env = { [v]: r.x, __t: t }; return fval(c[0], env)[0] - fval(c[2], env)[0]; }));
    }, 'computed');
    let title = '';
    if (ep.conds.length === 1 && ec.conds.length === 1) {
      const [L, op, R] = ep.conds[0];
      for (const m of mutateEq([L, R])) {
        const mc = m.eqs.map((e) => [e[0], op, e[1]] as Cond);
        if (compareIneqs(mc, ec.conds) === 'equiv') { title = m.title; break; }
      }
    }
    if (!title) title = loc?.kind === 'flip' || loc?.sign ? 'Sign error' : loc?.kind === 'del' ? 'Extra term' : 'Not equivalent';
    return { step: true, verdict: 'error', title, detail: title === 'Not equivalent' ? `This line is not equivalent to $${texConds(ep.conds)}$.` : DETAILS[title], hint: HINTS[title], span: loc ? loc.span : null, fix: loc ? latexOrNull(loc.text) : undefined };
  }
  return NONE;
}
const flipOp = (o: RelOp): RelOp => (o === '<' ? '>' : o === '>' ? '<' : o === '<=' ? '>=' : o === '>=' ? '<=' : o);
const opText = (o: RelOp) => ({ '<': '<', '>': '>', '<=': '≤', '>=': '≥', '=': '=', '!=': '≠', '~': '≈' })[o];
const texConds = (cs: Cond[]) => cs.map((c, i) => (i ? '' : texNode(c[0])) + ` ${texRel(c[1])} ${texNode(c[2])}`).join('');

function eqError(Pe: Eq[], C: Stmt, Ce: Eq[], title: string, ctx: Ctx): Finding {
  const vs = [...new Set(Pe.flatMap((e) => [...varsOf(e[0]), ...varsOf(e[1])]))];
  const v = pickVar(Pe, Ce, vs);
  const others = vs.filter((x) => x !== v);
  const base = others.length ? points(others, false, 1, 1)[0] : {};
  const roots = Pe.flatMap((eq) => rootsOf(eq, v, base)).slice(0, 4);
  const parts = Ce.flatMap((e) => [e[0], e[1]]);
  const rebuild = (ps: Node[]) => Ce.map((_, i) => [ps[2 * i], ps[2 * i + 1]] as Eq);
  const loc = localize(ctx.text, parts, (ps) => compareEqs(Pe, rebuild(ps)) === 'equiv', (ps) => {
    const eqs = rebuild(ps);
    const fb = toEnv(base);
    return roots.flatMap((r) => eqs.filter((e) => hasVar(e[0], '__t') || hasVar(e[1], '__t')).map((e) => (t: number) => {
      const env: Env = { ...fb, [v]: r.x, __t: t };
      return fval(e[0], env)[0] - fval(e[1], env)[0];
    }));
  }, ['Divided only one term', 'Distributed to one term', 'Cancelled a term'].includes(title) ? 'copied' : 'computed');
  const solved = Ce.every((e) => isSolvedEq(e, v));
  if (!title) {
    if (loc?.kind === 'flip' || loc?.sign) title = 'Sign error';
    else if (loc?.kind === 'del') title = 'Extra term';
    else if (solved) title = 'Not a solution';
    else if (loc) title = 'Arithmetic slip';
    else title = 'Not equivalent';
  }
  let detail: string;
  if (title === 'Not a solution' || (solved && title === 'Arithmetic slip')) detail = `$${texEqs(Ce)}$ does not satisfy $${texEqs(Pe)}$.`;
  else if (title === 'Not equivalent' || title === 'Arithmetic slip') detail = `This line is not equivalent to $${texEqs(Pe)}$.`;
  else detail = DETAILS[title] ?? '';
  let fix = loc ? latexOrNull(loc.text) : undefined;
  if (!fix && solved && Ce.length === 1) {
    const good = roots.filter((r) => r.q).map((r) => r.q!);
    if (good.length) fix = good.map((q) => `${texVar(v)} = ${texRat(q)}`).join(' \\;\\text{or}\\; ');
  }
  let span: [number, number] | null = loc ? loc.span : null;
  if (!span && Ce.length === 1) {
    const [l, r] = Ce[0];
    const c = l.t === 'var' && !hasVar(r, l.name!) ? r : r.t === 'var' && !hasVar(l, r.name!) ? l : null;
    if (c && c.s >= 0) span = [c.s, c.e];
  }
  void C;
  return { verdict: 'error', title, detail, hint: HINTS[title], fix, span };
}

/** a single line that matches a known misconception, e.g. "(a+b)^2 = a^2+b^2" */
function standaloneCheck(s: Stmt, ctx: Ctx, afterLine = false): Finding {
  if (s.rels.length !== 1 || s.rels[0].ops.length !== 1 || s.rels[0].ops[0] !== '=') return NONE;
  const [L, R] = s.rels[0].parts;
  if (!hasVars(L) && !hasVars(R)) return NONE;
  if (compareExpr(L, R) !== 'different') return NONE;
  for (const [E, W] of [[L, R], [R, L]] as const) {
    for (const m of mutateExpr(E)) {
      if (compareExpr(m.node, W) !== 'equal') continue;
      const f = identityError(E, W, ctx, 'identity');
      f.title = m.title; f.detail = DETAILS[m.title]; f.hint = HINTS[m.title];
      const strong = afterLine || new Set([...varsOf(L), ...varsOf(R)]).size >= 2;
      return strong ? { ...f, standalone: true } : { ...f, verdict: 'unsure', standalone: true };
    }
  }
  return NONE;
}

/** substitute user functions and derivative notation (f(2), f'(x), f''(1), y', y'') from earlier definitions */
/** set by resolveCalls when it read a user function's angle in degrees */
let resolvedInDegrees = false;
function resolveCalls(s: Stmt, defs: Ctx['defs'], radians = false): Stmt | null {
  let bad = false;
  const nth = (name: string): { body: Node; param: string; primes: number } | null => {
    const primes = (name.match(/'+$/) ?? [''])[0].length;
    const d = defs.get(name.slice(0, name.length - primes));
    if (!d) return null;
    let body: Node | null = d.body;
    for (let i = 0; i < primes && body; i++) body = D(body, d.param);
    return body ? { body, param: d.param, primes } : null;
  };
  const out = mapStmt(s, (x) => mapNodes(x, (m) => {
    if (m.t === 'var' && m.name!.endsWith("'")) {
      const r = nth(m.name!);
      if (!r) { bad = true; return null; }
      return { ...mapNodes(r.body, () => null), s: m.s, e: m.e, paren: '(', fv: 'd' };
    }
    if (m.t !== 'call') return null;
    const r = nth(m.name!);
    if (!r) { bad = true; return null; }
    const arg = mapNodes(m.a!, () => null);
    // f(x) = sin(x) then f(30): the angle-mode rule applies inside the function too (degreeArg)
    const deg = !radians && !varsOf(arg).size && degreeArg(arg, {});
    if (deg) resolvedInDegrees = true;
    const put = (k: Node) => (k.t === 'var' && k.name === r.param ? { ...arg, paren: '(' } : null);
    const body = mapNodes(r.body, (k) => (deg && k.t === 'fn' && TRIG_ALL.includes(k.name!) && hasVar(k.a!, r.param) ? { ...k, a: nmul(mapNodes(k.a!, put), ndiv(N('const', { name: 'pi' }), num(rq(180)))) } : put(k)));
    return { ...body, s: m.s, e: m.e, paren: undefined, fv: r.primes ? 'd' : true };
  }));
  return bad ? null : out;
}
function definitionOf(s: Stmt): [string, string, Node] | null {
  if (s.rels.length !== 1 || s.rels[0].ops.length !== 1 || s.rels[0].ops[0] !== '=') return null;
  const [L, R] = s.rels[0].parts;
  if (L.t === 'call' && !L.name!.endsWith("'") && L.a!.t === 'var') return [L.name!, L.a!.name!, R];
  return null;
}
/** "y = x^2": y as a function of one variable, for y' and y'' (also still an ordinary equation) */
function yDefinitionOf(s: Stmt): [string, string, Node] | null {
  if (s.rels.length !== 1 || s.rels[0].ops.length !== 1 || s.rels[0].ops[0] !== '=') return null;
  const [L, R] = s.rels[0].parts;
  const vs = [...varsOf(R)];
  if (L.t === 'var' && !L.name!.endsWith("'") && vs.length === 1 && vs[0] !== L.name && !hasKind(R, 'call')) return [L.name!, vs[0], R];
  return null;
}

function mergeLead(P: Stmt | null, C: Stmt): Stmt | null {
  if (!C.lead) return C;
  if (!P || P.rels.length !== 1 || C.rels.length !== 1) return null;
  const last = P.rels[0].parts[P.rels[0].parts.length - 1];
  const prevLast = mapNodes(last, (m) => ({ ...mapNodes({ ...m }, () => null) }));
  const strip = (n: Node): Node => ({ ...n, s: -1, e: -1, a: n.a && strip(n.a), b: n.b && strip(n.b) });
  const r = C.rels[0];
  return { lead: C.lead, rels: [{ parts: [strip(prevLast), ...r.parts], ops: [C.lead, ...r.ops], opSpans: [[-1, -1], ...r.opSpans] }] };
}

/** L - R of a single equation when it is the same constant everywhere (no solution / all values) */
function constDiff(s: Stmt): Rat | null {
  const e = effOf(s);
  if (e.k !== 'eq' || e.eqs.length !== 1) return null;
  const d = diffNode(e.eqs[0]);
  const pe = toPoly(d);
  if (pe) return pe.size === 0 ? ZERO : pe.size === 1 && pe.has('') ? pe.get('')! : null;
  return null;
}

function judgeStmt(P: Stmt | null, C: Stmt, ctx: Ctx, label: boolean): Finding {
  let fs = internalChecks(C, ctx);
  if (P && !C.lead && effOf(C).k === 'num' && C.rels.length === 1 && C.rels[0].ops.length === 1 && C.rels[0].ops[0] === '=') {
    // "2x+3 = 2x+5" then "3 = 5": a false numeric line is the right conclusion when P has no solution
    const pc = constDiff(P);
    const [A, B] = C.rels[0].parts;
    const cc = compareConst(A, B);
    if (pc && ((pc.n !== 0n && cc === 'different') || (pc.n === 0n && cc === 'equal'))) fs = [OK];
  }
  const ec = effOf(C);
  if (ec.k === 'ident' && !fs.some((f) => f.verdict === 'error' || f.verdict === 'unsure')) fs.push(OK);
  let step: Finding = NONE;
  if (P && !C.lead && !label) step = stepCheck(P, C, ctx);
  fs.push(step);
  if (step.verdict === 'none' && !C.lead && ec.k === 'eq') {
    const internal = combine(fs);
    if (internal.verdict === 'none' || internal.verdict === 'ok') fs.push(standaloneCheck(C, ctx, P !== null));
  }
  return combine(fs);
}

interface LineOut { f: Finding; last: Stmt | null }
function judgeLine(prev: Stmt | null, cur: Parsed, defs: Ctx['defs']): LineOut {
  const ctx: Ctx = { text: cur.text, defs };
  let p = prev;
  const fs: Finding[] = [];
  for (const seg0 of cur.segs) {
    if (definitionOf(seg0)) { fs.push(NONE); p = null; continue; }
    resolvedInDegrees = false;
    const seg = resolveCalls(seg0, defs);
    const inDegrees = resolvedInDegrees;
    const merged = seg && mergeLead(p, seg);
    if (!merged) { fs.push(NONE); p = null; continue; }
    let f = judgeStmt(p, merged, ctx, cur.label && seg0 === cur.segs[0]);
    // degrees inside a user function is the primary reading; radians may turn a red into 'unsure'
    if (f.verdict === 'error' && inDegrees) {
      const rad = resolveCalls(seg0, defs, true);
      const mr = rad && mergeLead(p, rad);
      if (inDegrees && mr && judgeStmt(p, mr, ctx, cur.label && seg0 === cur.segs[0]).verdict !== 'error') f = unsure('Degrees or radians?', null);
    }
    fs.push(f);
    p = merged;
  }
  return { f: combine(fs), last: p };
}

// ---- public API -----------------------------------------------------------------------------------

/** "x = 2" or "x = 2 or x = 3": a line that states final values */
function isFinalAnswer(s: Stmt): boolean {
  const e = effOf(s);
  return e.k === 'eq' && e.eqs.every((q) => isSolvedEq(q) && (plainNumber(q[0]) || plainNumber(q[1])));
}

function answerValues(s: Stmt): string[] {
  const e = effOf(s);
  if (e.k !== 'eq') return [];
  return e.eqs.map((q) => { const c = plainNumber(q[0]) ? q[0] : q[1]; const v = ex(c, {}); return v ? ratText(v) : '?'; });
}

/** a plausible reading of one line (the primary text or a recogniser alternate with p >= 0.1) */
interface Reading { parsed: Parsed; p: number; primary: boolean }
const MIN_READING_P = 0.1;
function readingsOf(line: LineRecognition, primary: Parsed[]): Reading[] {
  const out: Reading[] = primary.slice(0, 1).map((parsed) => ({ parsed, p: line.confidence ?? 1, primary: true }));
  (line.alternates ?? []).slice(0, 5).forEach((text, i) => {
    const p = line.alternateProbs?.[i] ?? MIN_READING_P; // unknown probability: assume plausible
    if (p < MIN_READING_P) return;
    const v = parseVariants(text);
    if (v.length) out.push({ parsed: v[0], p, primary: false });
  });
  return out;
}
const lastSeg = (p: Parsed): Stmt | null => { const s = p.segs[p.segs.length - 1]; return s.lead ? null : s; };

interface Hist { last: Stmt | null; lasts: (Stmt | null)[]; verdict: Verdict; rec: LineRecognition; readings: Reading[]; noted: boolean[]; shaky: boolean }

const MISCONCEPTION: Record<string, string> = {
  'Sign error': 'sign-move', 'Distributed to one term': 'distribute-first-term', 'Squared term by term': 'square-of-sum',
  'Cancelled a term': 'cancel-terms', 'Divided only one side': 'divide-one-side', 'Multiplied only one side': 'divide-one-side',
  'Divided only one term': 'divide-one-side', 'Root of a sum': 'sqrt-of-sum', 'Exponent rule': 'exponent-product',
  'Adding fractions': 'fraction-add-denominators', 'Order of operations': 'order-of-operations', 'Arithmetic slip': 'arithmetic',
  'Not a solution': 'arithmetic', 'Inverse operation': 'inverse-operation', 'Inequality sign': 'inequality-flip',
  'Power rule': 'power-rule', 'Derivative slip': 'derivative', 'Log rule': 'log-rule', 'Not linear': 'function-linearity',
  'Dropped a term': 'dropped-term', 'Extra term': 'extra-term', 'Like terms': 'like-terms',
};

/**
 * Check consecutive lines. Red needs: the CAS proves the step wrong on every plausible reading of
 * both lines (beam x beam, p >= 0.1), line confidence >= MIN_ERROR_CONFIDENCE, and a localised span.
 * After an error, later lines are checked against the (wrong) line before them; those that follow
 * correctly are 'ok' with carried = true and get no issue.
 */
export function checkSteps(lines: LineRecognition[]): { lines: LineCheck[]; issues: Issue[] } {
  const defs: Ctx['defs'] = new Map();
  const checks: LineCheck[] = [];
  const hist: Hist[] = [];
  const findings: (Finding | null)[] = [];
  let prev: Hist | null = null;
  let inError = false; // a line of the current chain was wrong: later sound steps are carried
  let anchor: Stmt | null = null; // the last equation of the chain that is not a final answer
  let listed = new Set<string>(); // values already stated as final answers since the anchor
  for (const line of lines) {
    if (line.kind !== 'math') { checks.push({ lineId: line.lineId, verdict: 'none' }); findings.push(null); continue; }
    const variants = parseVariants(line.text);
    if (!variants.length) { checks.push({ lineId: line.lineId, verdict: 'none' }); findings.push(null); prev = null; inError = false; anchor = null; continue; }
    const prevLasts = prev ? prev.lasts : [null];
    const res = judgeLineSafe(prevLasts[0], variants[0], defs);
    let f = res.f;
    const lasts: (Stmt | null)[] = [res.last];
    for (const v of variants.slice(1)) lasts.push(judgeLineSafe(prevLasts[0], v, defs).last);
    const readings = readingsOf(line, variants);
    // "x^2-5x+6=0", "x=2", "x=4": a second final answer is checked against the equation it answers
    let corrected = false;
    let rescuedByNote = false;
    if (f.verdict === 'none' && anchor && prev?.last && isFinalAnswer(prev.last) && res.last && isFinalAnswer(res.last) && !answerValues(res.last).every((v) => listed.has(v))) {
      const r = judgeLineSafe(anchor, variants[0], defs).f;
      // candidates of a root / log / |…| equation may be extraneous: never red there
      const domain = anchor.rels.some((rl) => rl.parts.some((x) => { let d = false; walk(x, (m) => { if (m.t === 'fn' && ['sqrt', 'root', 'abs', 'ln', 'log10', 'logb'].includes(m.name!)) d = true; }); return d; }));
      f = r.verdict === 'error' ? (domain ? { ...r, verdict: 'unsure' } : r) : r.verdict === 'none' ? f : OK;
      if (f.verdict === 'ok' && prev.verdict === 'error') corrected = true;
    }
    if (f.verdict === 'error') {
      // parse ambiguity (decimal comma, 1/2x, log base, degrees): any sound parse wins
      let best: Finding | null = null;
      let bestNoted = false;
      for (const [pi, pl] of prevLasts.entries()) for (const v of variants) {
        if (pl === prevLasts[0] && v === variants[0]) continue;
        const r = judgeLineSafe(pl, v, defs);
        let rf = r.f;
        // a reading that only works as a working note (on this line or the one before) is never 'ok'
        const noted = v.note ?? (prev?.noted[pi] ? 'ann' : undefined);
        if (noted && rf.verdict !== 'error') rf = unsure(noted === 'pct' ? 'Percent notation' : 'Check the reading', null);
        if (rf.verdict !== 'error' && (!best || rankV[rf.verdict] < rankV[best.verdict] || (best.verdict === 'none' && rf.verdict === 'ok'))) { best = rf; bestNoted = !!noted; }
      }
      if (best) f = best.verdict === 'none' && prevLasts[0] ? { ...f, verdict: 'unsure' } : best;
      rescuedByNote = !!best && bestNoted;
    }
    if (f.verdict === 'error') {
      // misread? every plausible reading of the previous line x every plausible reading of this one
      const prevReadings: { last: Stmt | null; p: number }[] = prev
        ? [{ last: prevLasts[0], p: prev.rec.confidence ?? 1 }, ...prev.readings.filter((r) => !r.primary).map((r) => ({ last: lastSeg(r.parsed), p: r.p }))]
        : [{ last: null, p: 1 }];
      let rescue = 0;
      for (const pr of prevReadings) for (const cr of readings) {
        if (pr === prevReadings[0] && cr.primary) continue;
        const v = judgeLineSafe(pr.last, cr.parsed, defs).f.verdict;
        if (v === 'ok' || v === 'unsure') rescue = Math.max(rescue, Math.min(pr.p, cr.p));
      }
      if (rescue >= 0.4) f = NONE; // a likely alternate reading is fine: say nothing
      else if (rescue > 0) f = { ...f, verdict: 'unsure', detail: `${f.detail} (This may also be a misread.)` };
    }
    if (((f.verdict === 'error' && f.step) || (f.verdict === 'none' && prev?.verdict === 'error')) && hist.length > 1) {
      // a rewrite that agrees with an earlier line (e.g. the student corrected a wrong step)
      for (let k = hist.length - 2; k >= Math.max(0, hist.length - 6); k--) {
        const h = hist[k];
        if (!h.last) continue;
        if (judgeLineSafe(h.last, variants[0], defs).f.verdict === 'ok') { f = h.verdict !== 'error' ? OK : { ...f, verdict: 'unsure' }; corrected = true; break; }
      }
    }
    const conf = Math.min(line.confidence ?? 1, prev?.rec.confidence ?? 1);
    if (f.verdict === 'error' && conf < MIN_ERROR_CONFIDENCE) f = { ...f, verdict: 'unsure', detail: `${f.detail} (The handwriting reading is uncertain.)` };
    if (f.verdict === 'error' && !(f.span && f.span[0] >= 0 && f.span[1] > f.span[0])) f = { ...f, verdict: 'unsure' }; // not localised
    // register definitions after judging, so "f(x)=..." itself is 'none'
    for (const st of variants[0].segs) { const d = definitionOf(st) ?? yDefinitionOf(st); if (d) defs.set(d[0], { param: d[1], body: d[2] }); }
    if (res.last && !isFinalAnswer(res.last) && effOf(res.last).k === 'eq') { anchor = res.last; listed = new Set(); }
    else if (!res.last) anchor = null;
    if (res.last && isFinalAnswer(res.last)) for (const v of answerValues(res.last)) listed.add(v);
    // after a line read only through a working note, the next line cannot be confirmed either
    if (f.verdict === 'ok' && prev?.shaky) f = unsure('Check the reading', null);
    const h: Hist = { last: res.last, lasts, verdict: f.verdict, rec: line, readings, noted: variants.map((v) => v.note === 'ann'), shaky: rescuedByNote && f.verdict === 'unsure' };
    hist.push(h);
    prev = h;
    const check: LineCheck = { lineId: line.lineId, verdict: f.verdict };
    if (corrected) inError = false;
    else if (f.verdict === 'ok' && inError) check.carried = true;
    if (f.verdict === 'error') inError = true;
    checks.push(check);
    findings.push(f);
  }
  // a misconception-looking line that the next line then solves as an equation was a problem statement
  for (let i = 0; i < lines.length; i++) {
    const f = findings[i];
    if (!f?.standalone) continue;
    const j = lines.findIndex((l, k) => k > i && findings[k]);
    if (j > 0 && checks[j].verdict === 'ok') {
      checks[i] = { lineId: checks[i].lineId, verdict: 'none' };
      findings[i] = NONE;
      for (let k = i + 1; k < lines.length && checks[k].carried; k++) delete checks[k].carried;
    }
  }
  const issues: Issue[] = [];
  lines.forEach((line, i) => {
    const f = findings[i];
    if (!f || (f.verdict !== 'error' && f.verdict !== 'unsure') || !f.title) return;
    const prevConf = i > 0 ? lines[i - 1].confidence ?? 1 : 1;
    const issue: Issue = {
      lineId: line.lineId,
      span: f.span && f.span[0] >= 0 && f.span[1] > f.span[0] ? f.span : null,
      severity: f.verdict,
      title: f.title,
      detail: f.detail ?? '',
      hint: f.hint,
      fix: f.fix,
      source: 'local-cas',
      confidence: Math.round(Math.min(line.confidence ?? 1, prevConf) * (f.verdict === 'error' ? 1 : 0.5) * 100) / 100,
    };
    if (MISCONCEPTION[f.title]) issue.misconception = MISCONCEPTION[f.title];
    issues.push(issue);
  });
  return { lines: checks, issues };
}
function judgeLineSafe(prev: Stmt | null, cur: Parsed, defs: Ctx['defs']): LineOut {
  try { return judgeLine(prev, cur, defs); } catch { return { f: NONE, last: null }; }
}

// ---- LaTeX ----------------------------------------------------------------------------------------

const GREEK_TEX: Record<string, string> = { α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', ο: 'o', σ: '\\sigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi', χ: '\\chi', ψ: '\\psi', ω: '\\omega', Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega' };
const FN_TEX: Record<string, string> = { sin: '\\sin', cos: '\\cos', tan: '\\tan', cot: '\\cot', sec: '\\sec', csc: '\\csc', asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan', sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', ln: '\\ln', log: '\\log', log10: '\\lg', exp: '\\exp' };
function texVar(name: string): string {
  const [b, sub] = name.split('_');
  const base = GREEK_TEX[b] ?? b;
  return sub ? `${base}_{${sub}}` : base;
}
function texRat(r: Rat): string {
  if (r.d === 1n) return r.n.toString();
  const neg = r.n < 0n;
  return `${neg ? '-' : ''}\\frac{${babs(r.n)}}{${r.d}}`;
}
const PREC: Partial<Record<Kind, number>> = { add: 1, sub: 1, pm: 1, mul: 2, div: 2, neg: 2, pow: 4 };
function wrap(n: Node, s: string): string {
  if (!n.paren) return s;
  return n.paren === '[' ? `\\left[${s}\\right]` : n.paren === '{' ? `\\left\\{${s}\\right\\}` : `\\left(${s}\\right)`;
}
function tex(n: Node, ctx: number): string {
  const inner = tex0(n);
  if (n.paren) return wrap(n, inner);
  const p = PREC[n.t] ?? 5;
  return p < ctx ? `\\left(${inner}\\right)` : inner;
}
const bare = (n: Node) => tex({ ...n, paren: undefined }, 0);
function tex0(n: Node): string {
  switch (n.t) {
    case 'num': return n.txt ? n.txt.replace(',', '{,}') : texRat(n.q!);
    case 'var': return texVar(n.name!);
    case 'const': return n.name === 'pi' ? '\\pi' : 'e';
    case 'neg': return `-${tex(n.a!, 2)}`;
    case 'add': return `${tex(n.a!, 1)} + ${tex(n.b!, 1)}`;
    case 'sub': return `${tex(n.a!, 1)} - ${tex(n.b!, 2)}`;
    case 'pm': return n.a ? `${tex(n.a, 1)} ${n.mp ? '\\mp' : '\\pm'} ${tex(n.b!, 2)}` : `${n.mp ? '\\mp' : '\\pm'} ${tex(n.b!, 2)}`;
    case 'mul': {
      const l = tex(n.a!, 2), r = tex(n.b!, 2);
      if (n.sym === '') {
        const needDot = /[\d}]$/.test(l) && /^[\d.]/.test(r);
        return needDot ? `${l} \\cdot ${r}` : `${l}${/\\[A-Za-z]+$/.test(l) && /^[A-Za-z]/.test(r) ? ' ' : ''}${r}`;
      }
      return `${l} ${n.sym === '×' ? '\\times' : '\\cdot'} ${r}`;
    }
    case 'div':
      if (n.sym === '÷') return `${tex(n.a!, 2)} \\div ${tex(n.b!, 3)}`;
      if (n.sym === ':') return `${tex(n.a!, 2)} : ${tex(n.b!, 3)}`;
      return `\\frac{${bare(n.a!)}}{${bare(n.b!)}}`;
    case 'pow': {
      const b = n.a!;
      const base = b.t === 'fn' && FN_TEX[b.name!] && !b.paren ? `${FN_TEX[b.name!]}^{${bare(n.b!)}}${fnArg(b.a!)}` : null;
      if (base) return base;
      return `${tex(b, 5)}^{${bare(n.b!)}}`;
    }
    case 'fn': {
      const a = n.a!;
      switch (n.name) {
        case 'sqrt': return `\\sqrt{${bare(a)}}`;
        case 'root': return `\\sqrt[${bare(n.b!)}]{${bare(a)}}`;
        case 'abs': return `\\left|${bare(a)}\\right|`;
        case 'fact': return `${tex(a, 5)}!`;
        case 'pct': return `${tex(a, 5)}\\%`;
        case 'logb': return `\\log_{${bare(n.b!)}}${fnArg(a)}`;
        default: return `${FN_TEX[n.name!] ?? `\\operatorname{${n.name}}`}${fnArg(a)}`;
      }
    }
    case 'deriv': return n.v === '?' ? `${tex(n.a!, 5)}'` : `\\frac{d}{d${n.v}}${n.a!.paren ? tex(n.a!, 0) : `\\left(${bare(n.a!)}\\right)`}`;
    case 'call': return `${n.name}${tex({ ...n.a!, paren: '(' }, 0)}`;
  }
}
const fnArg = (a: Node) => (a.paren ? tex(a, 0) : (PREC[a.t] ?? 5) >= 5 && a.t !== 'fn' ? ` ${tex(a, 0)}` : `\\left(${bare(a)}\\right)`);
function texStmt(s: Stmt): string {
  const rels = s.rels.map((r, i) => {
    let out = '';
    r.parts.forEach((p, k) => {
      if (k > 0) out += ` ${texRel(r.ops[k - 1])} `;
      out += tex(p, 0);
    });
    return i === 0 && s.lead ? `${texRel(s.lead)} ${out}` : out;
  });
  return rels.join(' \\quad\\text{or}\\quad ');
}
function texParsed(p: Parsed): string { return p.segs.map(texStmt).join(' \\;\\Rightarrow\\; '); }

/** linear recogniser text to LaTeX; falls back to a symbol-by-symbol transliteration */
export function toLatex(text: string): string {
  const v = parseOne(text, /\d,\d/.test(text) && !/\d,\s/.test(text), false);
  if (v) return texParsed(v);
  return text
    .replace(/\\/g, '\\backslash ')
    .replace(/[{}#$&_%]/g, (c) => `\\${c}`)
    .replace(/·|⋅/g, ' \\cdot ').replace(/×/g, ' \\times ').replace(/÷/g, ' \\div ')
    .replace(/≤/g, ' \\le ').replace(/≥/g, ' \\ge ').replace(/≠/g, ' \\ne ').replace(/≈/g, ' \\approx ')
    .replace(/±/g, ' \\pm ').replace(/π/g, '\\pi ').replace(/√/g, '\\sqrt ').replace(/−/g, '-')
    .replace(/⇒/g, ' \\Rightarrow ')
    .replace(/[α-ωΓ-Ω]/g, (c) => (GREEK_TEX[c] ? GREEK_TEX[c] + ' ' : c));
}

// ---- live results ("2a+1=" -> 7) -----------------------------------------------------------------

/** a value as linear text and LaTeX: integers, short decimals, small fractions, else 10 significant digits */
function formatValue(q: Rat | null, x: number): { value: string; latex: string } | null {
  if (q) {
    if (q.d === 1n) return { value: q.n.toString(), latex: q.n.toString() };
    let d = q.d;
    while (d % 2n === 0n) d /= 2n;
    while (d % 5n === 0n) d /= 5n;
    if (d === 1n) { const s = String(rnum(q)); if (!s.includes('e') && s.length <= 12) return { value: s, latex: s }; }
    if (q.d <= 1000n && babs(q.n) < 1000000n) return { value: `${q.n}/${q.d}`, latex: texRat(q) };
  }
  if (!Number.isFinite(x)) return null;
  if (Math.abs(x) < 1e-12) return { value: '0', latex: '0' };
  if (x !== 0 && (Math.abs(x) >= 1e10 || Math.abs(x) < 1e-6)) {
    const [m, e] = x.toExponential(6).split('e');
    const mm = String(Number(m));
    return { value: `${mm}e${Number(e)}`, latex: `${mm} \\times 10^{${Number(e)}}` };
  }
  const s = String(Number(x.toPrecision(10)));
  return { value: s, latex: s };
}

/** Math Notes style: the value of every math line ending in "=", using variables assigned earlier ("a=3") */
export function evaluate(lines: LineRecognition[], vars?: ReadonlyMap<string, string>): { lineId: string; value: string; latex: string }[] {
  const q: QEnv = {}, f: Env = {};
  const assign = (name: string, n: Node) => {
    const v = ex(n, q);
    const [x] = fval(n, f);
    if (v) { q[name] = v; f[name] = rnum(v); }
    else if (Number.isFinite(x)) { delete q[name]; f[name] = x; }
  };
  const known = (n: Node) => [...varsOf(n)].every((v) => v in f);
  for (const [name, text] of vars ?? []) {
    const p = parseOne(text, /\d,\d/.test(text), false);
    const r = p?.segs[0]?.rels[0];
    if (r && !r.ops.length && known(r.parts[0])) assign(name, r.parts[0]);
  }
  const out: { lineId: string; value: string; latex: string }[] = [];
  const rebound = new Set<string>(); // "e = 5", "pi = 3": the name is a variable from then on
  const cd = (x: string) => /\d,\d/.test(x) && !/\d,\s/.test(x);
  const prep = (p: Parsed | null): Parsed | null => p && {
    ...p,
    segs: p.segs.map((st) => mapStmt(st, (x) => mapNodes(x, (m) => {
      if (m.t === 'const' && rebound.has(m.name!)) return { ...m, t: 'var' };
      // one rule shared with checkSteps (degreeArg), using the values of earlier variables, and one
      // mode for the whole line: sin(7)+sin(6) is two angles in degrees, not one of each
      if (m.t === 'fn' && TRIG_ALL.includes(m.name!) && degLine) {
        let pi = false;
        walk(m.a!, (k) => { if (k.t === 'const' && k.name === 'pi') pi = true; });
        if (!pi) return { ...m, a: nmul({ ...m.a! }, ndiv(N('const', { name: 'pi' }), num(rq(180)))) };
      }
      return null;
    }))),
  };
  let degLine = false;
  const decideMode = (p: Parsed | null) => {
    degLine = !!p && anyNode(p, (m) => m.t === 'fn' && TRIG_ALL.includes(m.name!) && [...varsOf(m.a!)].every((v) => v in f) && degreeArg(m.a!, f));
    return p;
  };
  for (const line of lines) {
    if (line.kind !== 'math') continue;
    const t = line.text.trimEnd();
    try {
      if (/=$/.test(t) && !/[<>!≤≥]=$|==$/.test(t)) {
        const body = t.slice(0, -1);
        // "50+20%=": 50.2 by the letter, 60 on a calculator. Ambiguous, so no result rather than a guess
        if (/[+\-−]\s*[\d.,]+\s*%/.test(body)) continue;
        const p = prep(decideMode(parseOne(body, cd(body), false)));
        const st = p?.segs[p.segs.length - 1];
        const rel = st?.rels.length === 1 ? st.rels[0] : null;
        if (!rel) continue;
        const e = rel.parts[rel.parts.length - 1];
        if (!known(e) || rel.ops.some((o) => o !== '=')) continue;
        const v = ex(e, q);
        const [x] = fval(e, f);
        const fm = formatValue(v, x);
        if (fm) out.push({ lineId: line.lineId, ...fm });
        continue;
      }
      // assignments: "a = 3", "b = 2a+1", "e = 5"
      const p = prep(decideMode(parseOne(t, cd(t), false)));
      const r = p?.segs.length === 1 && p.segs[0].rels.length === 1 ? p.segs[0].rels[0] : null;
      if (r && r.ops.length === 1 && r.ops[0] === '=' && r.parts[0].t === 'const' && known(r.parts[1])) { rebound.add(r.parts[0].name!); assign(r.parts[0].name!, r.parts[1]); continue; }
      if (r && r.ops.length === 1 && r.ops[0] === '=' && r.parts[0].t === 'var' && !hasVar(r.parts[1], r.parts[0].name!) && known(r.parts[1])) assign(r.parts[0].name!, r.parts[1]);
    } catch {
      // unparsable line: no live result
    }
  }
  return out;
}

// ---- same problem, new numbers ----------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return (a >>> 0) / 4294967296; };
}

/** the verified answer of a parsed problem, or null if it has none or it is not nice */
/** a root as an answer: integers, or terminating decimals (<= 4 places) when the problem has decimals */
function niceRoot(q: Rat, dec: boolean): string | null {
  if (q.d === 1n) return q.n.toString();
  if (!dec || 10000n % q.d !== 0n) return null;
  return String(rnum(q));
}
function answerOf(p: Parsed, dec = false): string | null {
  if (p.segs.length !== 1) return null;
  const st = p.segs[0];
  const e = effOf(st);
  if (e.k === 'expr') {
    if (varsOf(e.e).size) { const pe = toPoly(e.e); return pe && pe.size <= 6 ? polyText(pe) : null; }
    const v = ex(e.e, {});
    return v && v.d === 1n ? v.n.toString() : null;
  }
  if (e.k === 'eq' && e.eqs.length === 1) {
    const vs = [...varsOf(e.eqs[0][1], varsOf(e.eqs[0][0]))];
    if (vs.length !== 1) return null;
    const v = vs[0];
    const roots = rootsOf(e.eqs[0], v, {});
    if (!roots.length || roots.some((r) => !r.q || niceRoot(r.q, dec) === null)) return null;
    // verify each root exactly in the problem itself
    for (const r of roots) { const env = { [v]: r.q! }; const a = ex(e.eqs[0][0], env), b = ex(e.eqs[0][1], env); if (!a || !b || !req(a, b)) return null; }
    return roots.map((r) => `${v}=${niceRoot(r.q!, dec)}`).sort().join(' or ');
  }
  if (e.k === 'ineq' && e.conds.length === 1) {
    const [L, op, R] = e.conds[0];
    const vs = [...varsOf(R, varsOf(L))];
    if (vs.length !== 1) return null;
    const pr = polyRoots([L, R], vs[0], {});
    if (!pr || pr.length !== 1 || !pr[0].q || pr[0].q.d !== 1n) return null;
    const b = pr[0].q;
    const env: Env = { [vs[0]]: rnum(b) + 1 };
    const above = truth([[L, op, R]], env);
    if (above === null) return null;
    const strict = op === '<' || op === '>';
    return `${vs[0]}${above ? (strict ? '>' : '≥') : strict ? '<' : '≤'}${b.n}`;
  }
  return null;
}

/** an isomorphic problem with new numbers whose answer the CAS has verified, or null */
export function variant(problem: string, seed: number): { problem: string; answer: string } | null {
  const trailingEq = /=\s*$/.test(problem.trim());
  const text = problem.trim().replace(/=\s*$/, '');
  const parsed = parseOne(text, false, false);
  if (!parsed) return null;
  // keep the shape: same kind of answer (identities and unsolvable problems have none), same number of roots
  const hasDec = /\d\.\d/.test(text);
  const orig = answerOf(parsed, true);
  if (orig === null) return null;
  const shape = (a: string) => `${a.split(' or ').length}:${/[=<>≤≥]/.test(a) ? 'rel' : /[a-z]/.test(a) ? 'poly' : 'num'}`;
  // the literals we may change: not exponents, not roots' indices, not 0 or 1
  const lits: Node[] = [];
  for (const st of parsed.segs) for (const r of st.rels) for (const part of r.parts) walk(part, (m, parent) => {
    if (m.t !== 'num' || m.s < 0) return;
    if (parent && ((parent.t === 'pow' && parent.b === m) || (parent.t === 'fn' && parent.b === m))) return;
    if (m.q!.n === 0n || req(m.q!, ONE)) return;
    lits.push(m);
  });
  if (!lits.length) return null;
  lits.sort((a, b) => b.s - a.s);
  const rand = rng(seed * 2654435761 + 12345);
  for (let attempt = 0; attempt < 400; attempt++) {
    let t = text;
    for (const m of lits) {
      const v = rnum(m.q!);
      const decimals = m.txt && /\./.test(m.txt) ? m.txt.split('.')[1].length : 0;
      const mag = Math.abs(v);
      const lo = Math.max(decimals ? 0.1 : 2, Math.round(mag / 2)), hi = Math.max(lo + 3, Math.round(mag * 2) + 2);
      let nv = lo + rand() * (hi - lo);
      nv = decimals ? Math.round(nv * 10 ** decimals) / 10 ** decimals : Math.round(nv);
      if (decimals && Number.isInteger(nv)) nv += (1 + Math.floor(rand() * 9)) / 10 ** decimals; // decimals stay decimals
      nv = decimals ? Number(nv.toFixed(decimals)) : nv;
      if (nv === 1 || nv === 0) nv = 2;
      t = splice(t, m.s, m.e, String(nv));
    }
    if (t === text) continue;
    const p = parseOne(t, false, false);
    if (!p) continue;
    const ans = answerOf(p, hasDec);
    if (ans === null || shape(ans) !== shape(orig)) continue;
    // nice answers: small, and not the trivial 0 / ±1 unless nothing else turns up
    const ns = (ans.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const isPoly = /[a-z]\^?\d*[a-z]?[+-]/.test(ans) && !/=|<|>|≤|≥/.test(ans);
    if (!isPoly && ns.some((n) => Math.abs(n) > (/[=<>≤≥]/.test(ans) ? 20 : 1000))) continue;
    if (attempt < 300 && /[=<>≤≥]/.test(ans) && ns.every((n) => Math.abs(n) <= 1)) continue;
    return { problem: trailingEq && !t.includes('=') ? `${t}=` : t, answer: ans };
  }
  return null;
}

export const math: MathModule = { checkSteps, toLatex, evaluate, variant };
export default math;
