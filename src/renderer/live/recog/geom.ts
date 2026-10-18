// Stroke geometry for live recognition: per-stroke features, symbols (strokes that form one glyph),
// fraction groups, and the page-level grouping of pen ink into lines and blocks. Pure and fast:
// grouping a 500-stroke page takes well under 2 ms. Page coordinates, y grows downwards.
import type { BBox, InkBlock, InkLine, Stroke } from '../contract';

/** A pen stroke with the features the grouping and layout passes need. */
export interface Ink {
  id: string;
  pts: ArrayLike<number>; // x, y, pressure triples
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** chord / path length: 1 = a straight line */
  straight: number;
  /** a (nearly) horizontal straight line: minus, fraction bar, half of "=" */
  flat: boolean;
  /** tiny: dots of i/j, decimal points, ÷ dots */
  dot: boolean;
}

/** One glyph: strokes that touch or belong together (x, +, =, i with its dot). */
export interface Sym {
  ink: Ink[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  flat: boolean;
  dot: boolean;
}

/** A fraction: a bar with a numerator above and a denominator below. */
export interface Frac {
  bar: Ink;
  num: Ink[];
  den: Ink[];
}

/** pen strokes that can be writing (not highlighter, tape or snapped shapes) */
export const isWriting = (s: Stroke) => s.kind === 'pen' && !s.shape;

export function inkOf(s: { id: string; pts: ArrayLike<number> }): Ink {
  const p = s.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (i) {
      const dx = x - p[i - 3], dy = y - p[i - 2];
      len += Math.sqrt(dx * dx + dy * dy);
    }
  }
  const n = p.length;
  const chord = n >= 6 ? Math.hypot(p[n - 3] - p[0], p[n - 2] - p[1]) : 0;
  const w = x1 - x0, h = y1 - y0;
  const straight = len > 0 ? chord / len : 1;
  return { id: s.id, pts: p, x0, y0, x1, y1, w, h, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, straight, flat: false, dot: false };
}

const median = (a: ArrayLike<number>) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort(); // typed sort: numeric and fast
  return s[s.length >> 1];
};

/**
 * Typical glyph height ("unit") of a set of strokes, and the flat/dot flags relative to it.
 * The unit is about the height of a digit; dots and bars are judged against it.
 */
export function classify(inks: Ink[]): number {
  const size = new Float64Array(inks.length);
  for (let i = 0; i < inks.length; i++) size[i] = Math.max(inks[i].w, inks[i].h);
  const rough = median(size) || 10;
  const tall: number[] = [];
  for (const k of inks) if (k.h > rough * 0.35) tall.push(k.h);
  const unit = Math.max(2, median(tall) || rough);
  for (const k of inks) {
    k.dot = Math.max(k.w, k.h) < unit * 0.28;
    k.flat = !k.dot && k.w > unit * 0.3 && k.h < k.w * 0.28 && k.straight > 0.85;
  }
  return unit;
}

/** Total turning of a stroke around its box centre, in radians (a closed loop is about 2π). */
function winding(k: Ink): number {
  const p = k.pts;
  let total = 0, prev = NaN;
  for (let i = 0; i < p.length; i += 3) {
    const a = Math.atan2(p[i + 1] - k.cy, p[i] - k.cx);
    if (!Number.isNaN(prev)) {
      let d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    prev = a;
  }
  return Math.abs(total);
}

/**
 * A loop drawn around other ink: circling a result, or the "ask about this" gesture. It is not
 * writing, and treated as writing it glues the lines it touches together (a circle passed for a Σ
 * whose "limits" were the line above). It goes most of the way round its centre (a √ or ∫ does
 * not) and encloses the centre of other ink.
 */
export function enclosingLoops(inks: readonly Ink[], unit: number): Set<Ink> {
  const loops = new Set<Ink>();
  for (const k of inks) {
    if (k.w < unit * 2.2 || k.h < unit * 1.4) continue;
    if (winding(k) < Math.PI * 1.65) continue;
    let inside = 0;
    for (const o of inks) if (o !== k && o.cx > k.x0 && o.cx < k.x1 && o.cy > k.y0 && o.cy < k.y1 && o.w < k.w && o.h < k.h) inside++;
    if (inside >= 1) loops.add(k);
  }
  return loops;
}

/** Smallest distance between two strokes' points, cut short once below `limit`. */
function inkDist(a: Ink, b: Ink, limit: number): number {
  const p = a.pts, q = b.pts;
  let best = Infinity;
  const l2 = limit * limit;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (x < b.x0 - limit || x > b.x1 + limit || y < b.y0 - limit || y > b.y1 + limit) continue;
    for (let j = 0; j < q.length; j += 3) {
      const dx = q[j] - x, dy = q[j + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        if (best < l2) return Math.sqrt(best);
      }
    }
  }
  return Math.sqrt(best);
}

/** inkDist, remembered per stroke pair (strokes never change, and grouping reruns on every settle) */
const distCache = new WeakMap<Ink, Map<Ink, [number, number]>>();
function pairDist(a: Ink, b: Ink, limit: number): number {
  let m = distCache.get(a);
  const hit = m?.get(b);
  if (hit && hit[1] === limit) return hit[0];
  const d = inkDist(a, b, limit);
  if (!m) distCache.set(a, (m = new Map()));
  m.set(b, [d, limit]);
  return d;
}

function find(parent: Int32Array, i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}
function union(parent: Int32Array, a: number, b: number) {
  const ra = find(parent, a), rb = find(parent, b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

/**
 * Fraction bars: a flat stroke with written ink right above and right below it, both within its
 * span. Returns the fractions and the strokes they own.
 */
export function findFractions(inks: Ink[], unit: number): Frac[] {
  const out: Frac[] = [];
  const used = new Set<Ink>();
  // widest bars first, so a bar inside a numerator doesn't steal its parent's ink
  // a bar may be a little curved or tilted when written quickly; such a bar needs real glyphs on
  // both sides (a dash under it would make it one bar of an "=")
  const dashy = (k: Ink) => k.w >= k.h * 1.3 && k.h < unit * 0.4;
  const barLike = (k: Ink) => k.flat || (k.w > unit * 0.55 && k.h <= k.w * 0.5 && k.straight > 0.7);
  const bars = inks.filter((k) => barLike(k) && k.w > unit * 0.55).sort((a, b) => b.w - a.w);
  if (!bars.length) return out;
  // strokes by centre x, so each bar only looks at the strokes over its span
  const byX = inks.slice().sort((a, b) => a.cx - b.cx);
  const cxs = Float64Array.from(byX, (k) => k.cx);
  const lower = (v: number) => {
    let lo = 0, hi = cxs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cxs[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  for (const bar of bars) {
    if (used.has(bar)) continue;
    const span0 = bar.x0 - bar.w * 0.08, span1 = bar.x1 + bar.w * 0.08;
    let num: Ink[] = [], den: Ink[] = [];
    // ink with row-mates beside it at its own height, outside the bar's span, belongs to that row
    // (the "1" ending "3x = 1" right above the numerator of "x = 1/3")
    // (a glyph over a wider bar is itself part of a fraction, not a row-mate: 3/4 + 1/4)
    const stacked = (o: Ink) => bars.some((b2) => b2 !== o && b2.w > o.w * 1.2 && o.cx >= b2.x0 && o.cx <= b2.x1 && Math.abs(o.cy - b2.cy) < unit * 1.6);
    // (ink level with the bar is the fraction's own line, its "=" or "x": never a reason to drop a
    // part, or an inline denominator next to the "=" would be lost: x = 1/3)
    const inRow = (k: Ink) =>
      inks.some(
        (o) => o !== k && o !== bar && (o.cx < span0 || o.cx > span1) && Math.abs(o.cy - k.cy) < unit * 0.45 && Math.abs(o.cy - bar.cy) > unit * 0.75 && Math.max(o.x0 - k.x1, k.x0 - o.x1) < unit * 2 && !stacked(o),
      );
    for (let i = lower(span0); i < byX.length && cxs[i] <= span1; i++) {
      const k = byX[i];
      if (k === bar || used.has(k) || inRow(k)) continue;
      if (k.cy < bar.cy && k.y1 <= bar.cy + unit * 0.12 && k.y1 >= bar.cy - unit * 1.6) num.push(k);
      else if (k.cy > bar.cy && k.y0 >= bar.cy - unit * 0.12 && k.y0 <= bar.cy + unit * 1.6) den.push(k);
    }
    // the parts must start close to the bar
    const glyph = (k: Ink) => !k.flat && !k.dot && (bar.flat || !dashy(k));
    // handwriting leaves some air between the bar and its parts (a numerator ending ~0.8 unit above)
    const near = (set: Ink[], above: boolean) => set.some((k) => glyph(k) && (above ? bar.cy - k.y1 : k.y0 - bar.cy) < unit * 1.0);
    if (!near(num, true) || !near(den, false)) continue;
    // "=" is two flat strokes; a stacked "=" under a numerator-like digit is still not a fraction
    // if the only ink below is another flat stroke
    if (!den.some(glyph) || !num.some(glyph)) continue;
    // grow each part with ink stacked on it (tall numerators, exponents inside)
    const grow = (set: Ink[], above: boolean) => {
      const s = new Set(set);
      let changed = true;
      while (changed) {
        changed = false;
        for (const k of inks) {
          if (s.has(k) || k === bar || used.has(k) || k.cx < span0 || k.cx > span1) continue;
          if (above ? k.cy > bar.cy : k.cy < bar.cy) continue;
          // small ink (an exponent, a dot) joins by touching; a full-size glyph must overlap a part
          // vertically, or the line above or below would be swallowed (the "1" of "3x = 1" stacked on
          // the numerator of "x = 1/3")
          const small = Math.max(k.w, k.h) < unit * 0.7;
          for (const m of s) {
            const vOverlap = Math.min(k.y1, m.y1) - Math.max(k.y0, m.y0);
            if (!small && vOverlap < Math.min(k.h, m.h) * 0.3) continue;
            if (k.x1 >= m.x0 - unit * 0.2 && k.x0 <= m.x1 + unit * 0.2 && k.y1 >= m.y0 - unit * 0.4 && k.y0 <= m.y1 + unit * 0.4) {
              s.add(k);
              changed = true;
              break;
            }
          }
        }
      }
      return [...s];
    };
    num = grow(num, true);
    den = grow(den, false);
    const wn = Math.max(...num.map((k) => k.x1)) - Math.min(...num.map((k) => k.x0));
    const wd = Math.max(...den.map((k) => k.x1)) - Math.min(...den.map((k) => k.x0));
    if (bar.w < Math.max(wn, wd) * 0.6) continue;
    for (const k of [bar, ...num, ...den]) used.add(k);
    out.push({ bar, num, den });
  }
  return out;
}

export const symOf = (ink: Ink[]): Sym => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of ink) {
    x0 = Math.min(x0, k.x0);
    y0 = Math.min(y0, k.y0);
    x1 = Math.max(x1, k.x1);
    y1 = Math.max(y1, k.y1);
  }
  const flat = ink.every((k) => k.flat);
  const dot = ink.every((k) => k.dot);
  return { ink, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, flat, dot };
};

/**
 * Strokes -> glyphs: strokes that touch or cross (x, +, 4, t), the two bars of "=", dots over
 * their stem (i, j) or bar (÷). Fraction bars are kept on their own. Sorted left to right.
 */
export function symbols(inks: Ink[], unit: number, keepApart: ReadonlySet<Ink> = new Set()): Sym[] {
  const n = inks.length;
  const order = inks.map((_, i) => i).sort((a, b) => inks[a].x0 - inks[b].x0);
  const parent = new Int32Array(n).map((_, i) => i);
  const touch = unit * 0.09;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi], a = inks[i];
    if (keepApart.size && keepApart.has(a)) continue;
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj], b = inks[j];
      if (b.x0 > a.x1 + unit * 0.5) break;
      if (b.y0 > a.y1 + unit || b.y1 < a.y0 - unit) continue; // another line in the same columns
      if (keepApart.size && keepApart.has(b)) continue;
      const xo = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const yGap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1); // < 0: overlapping
      // "=" written small or quick: two short dashes, wider than tall, one over the other. They can
      // fall below the flat-bar size or curve a little; two round dots (":") are not dashes
      const dash = (k: Ink) => k.w >= Math.max(k.h * 1.3, unit * 0.1) && k.h < unit * 0.4 && k.w < unit * 1.6;
      // the flag of a 5 (or the top of a 7) written as a stroke of its own: a short dash on the glyph's
      // top that starts over its right part and runs right. An accent bar (x̄) is centred: not a flag
      const flagOf = (d: Ink, g: Ink) =>
        dash(d) && !dash(g) && !g.flat && !g.dot && d.y1 <= g.y0 + unit * 0.25 && g.y0 - d.y1 < unit * 0.35 && d.x0 >= g.x0 + g.w * 0.2 && d.x0 <= g.cx + g.w * 0.25 && d.x1 > g.cx && d.w <= g.w * 1.8 + unit * 0.3;
      if (flagOf(a, b) || flagOf(b, a)) {
        union(parent, i, j);
        continue;
      }
      if (dash(a) && dash(b) && !(a.flat && b.flat)) {
        if (xo > Math.min(a.w, b.w) * 0.4 && yGap > -unit * 0.05 && yGap < unit * 0.6) {
          union(parent, i, j);
          continue;
        }
      }
      if (a.flat && b.flat) {
        // "=": two bars over each other, close
        if (xo > Math.min(a.w, b.w) * 0.55 && yGap < unit * 0.6 && yGap > 0) union(parent, i, j);
        continue;
      }
      if (a.dot || b.dot) {
        // the dot of i/j sits above a narrow stem; ÷ has dots over and under a bar
        const d = a.dot ? a : b, o = a.dot ? b : a;
        if (o.dot) continue;
        const above = d.y1 <= o.y0 + unit * 0.1 && o.y0 - d.y1 < unit * 0.7;
        const below = o.flat && d.y0 >= o.y1 - unit * 0.1 && d.y0 - o.y1 < unit * 0.6;
        const narrow = o.flat || o.w < unit * 0.45;
        if (narrow && (above || below) && d.cx >= o.x0 - unit * 0.25 && d.cx <= o.x1 + unit * 0.25) union(parent, i, j);
        continue;
      }
      if (xo < -touch || yGap > touch) continue;
      if (pairDist(a, b, touch) <= touch) union(parent, i, j);
    }
  }
  const groups = new Map<number, Ink[]>();
  for (let i = 0; i < n; i++) {
    const r = find(parent, i);
    const g = groups.get(r);
    if (g) g.push(inks[i]);
    else groups.set(r, [inks[i]]);
  }
  return [...groups.values()].map(symOf).sort((a, b) => a.x0 - b.x0);
}

// ---- page grouping --------------------------------------------------------------------------------

/** 53-bit string hash (cyrb53) in base 36. */
export function hashId(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface Unit {
  ink: Ink[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cy: number;
  small: boolean;
}

interface Row {
  units: Unit[];
  x0: number;
  x1: number;
  centers: number[]; // centres of the last normal-size units (the line's running midline)
  mid: number;
}

const unitOf = (ink: Ink[], cy: number, unitH: number): Unit => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of ink) {
    x0 = Math.min(x0, k.x0);
    y0 = Math.min(y0, k.y0);
    x1 = Math.max(x1, k.x1);
    y1 = Math.max(y1, k.y1);
  }
  return { ink, x0, y0, x1, y1, cy, small: Math.max(x1 - x0, y1 - y0) < unitH * 0.95 || ink.every((k) => k.flat) };
};

const boxOf = (ink: Ink[]): BBox => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of ink) {
    x0 = Math.min(x0, k.x0);
    y0 = Math.min(y0, k.y0);
    x1 = Math.max(x1, k.x1);
    y1 = Math.max(y1, k.y1);
  }
  return [x0, y0, x1, y1];
};

const inkCache = new WeakMap<Stroke, Ink>();

/**
 * 2-D structures become one unit, so the row chaining below cannot split them:
 * - tall delimiters (brackets, braces, bars, integral signs) own what sits inside their vertical
 *   span up to their matching delimiter, or up to a wide gap without one: matrix and vector
 *   entries, the lines of a cases brace, an integral's limits and integrand;
 * - stacks: small glyphs right above or below a big one (limits of Σ, Π, lim) and accents
 *   (bar, hat, dot, arrow) right above a glyph.
 * Merges in place; a compound keeps the midline of its biggest glyph.
 */
function compound(units: Unit[], unitH: number) {
  const n = units.length;
  if (n < 2) return;
  const parent = new Int32Array(n).map((_, i) => i);
  const h = (u: Unit) => u.y1 - u.y0, w = (u: Unit) => u.x1 - u.x0;
  let maxW = 0;
  for (const u of units) maxW = Math.max(maxW, w(u));
  const tall = (u: Unit) => u.ink.length <= 2 && h(u) >= unitH * 1.75 && w(u) <= h(u) * 0.7;
  for (let i = 0; i < n; i++) {
    const t = units[i];
    if (!tall(t)) continue;
    // inside: centred within the span and mostly covered by it (handwritten entries poke out)
    const inside = (u: Unit) => {
      const c = (u.y0 + u.y1) / 2;
      return c > t.y0 && c < t.y1 && Math.min(u.y1, t.y1) - Math.max(u.y0, t.y0) >= h(u) * 0.5;
    };
    // the matching delimiter: the next tall glyph to the right covering most of the same span
    let close = -1;
    for (let j = i + 1; j < n && units[j].x0 < t.x1 + unitH * 14; j++) {
      const u = units[j];
      const ov = Math.min(u.y1, t.y1) - Math.max(u.y0, t.y0);
      if (tall(u) && ov > Math.min(h(u), h(t)) * 0.6) {
        close = j;
        break;
      }
    }
    const members: number[] = [];
    // an unpaired sign (integral, cases brace) also owns what sits at its corners: the limits
    const corner = (u: Unit) => close < 0 && h(u) < unitH * 1.2 && u.x0 < t.x1 + unitH * 1.2 && u.x1 > t.x0 - unitH * 0.3 && (u.y0 + u.y1) / 2 > t.y0 - unitH * 0.6 && (u.y0 + u.y1) / 2 < t.y1 + unitH * 0.6;
    for (let j = i - 1; j >= 0 && units[j].x0 > t.x0 - maxW; j--) if (corner(units[j])) members.push(j);
    let lastX = t.x1;
    for (let j = i + 1; j < n; j++) {
      const u = units[j];
      if (close >= 0 ? j > close : u.x0 - lastX > unitH * 2.5) break;
      if (!inside(u) && !corner(u) && j !== close) continue;
      members.push(j);
      lastX = Math.max(lastX, u.x1);
    }
    // only a real span: content on two levels (matrix rows, cases) or something past a lone sign
    if (!members.length) continue;
    for (const j of members) union(parent, i, j);
  }
  /** Does v's own row of glyphs (same level, close together) reach far past big on either side? */
  const overhangs = (v: Unit, big: Unit) => {
    let x0 = v.x0, x1 = v.x1;
    for (let grew = true; grew; ) {
      grew = false;
      for (const u of units) {
        if (Math.abs(u.cy - v.cy) > unitH * 0.45 || u.x1 < x0 - unitH * 2 || u.x0 > x1 + unitH * 2) continue;
        if (u.x0 < x0 || u.x1 > x1) {
          x0 = Math.min(x0, u.x0);
          x1 = Math.max(x1, u.x1);
          grew = true;
        }
      }
    }
    const allow = Math.max(w(big), unitH * 2.5);
    return big.x0 - x0 > allow || x1 - big.x1 > allow;
  };
  const limits: number[] = [];
  for (let i = 0; i < n; i++) {
    const big = units[i];
    if (big.ink.every((k) => k.flat || k.dot)) continue;
    const isBig = h(big) >= unitH * 1.3 || w(big) >= unitH * 1.3;
    // units are sorted by x0: only neighbours that can overlap big horizontally
    let j0 = i;
    while (j0 > 0 && units[j0 - 1].x0 >= big.x0 - maxW) j0--;
    for (let j = j0; j < n && units[j].x0 <= big.x1 + unitH * 0.5; j++) {
      if (j === i) continue;
      const v = units[j];
      if (v.y0 > big.y1 + unitH || v.y1 < big.y0 - unitH) continue;
      const xo = Math.min(v.x1, big.x1) - Math.max(v.x0, big.x0);
      const vc = (v.x0 + v.x1) / 2;
      if (xo < w(v) * 0.5 && !(isBig && vc > big.x0 - unitH * 0.3 && vc < big.x1 + unitH * 0.3)) continue;
      const above = big.y0 - v.y1, below = v.y0 - big.y1;
      const accent = (v.ink.every((k) => k.flat || k.dot) || Math.max(w(v), h(v)) < unitH * 0.6) && above > -unitH * 0.1 && above < unitH * 0.45;
      // a limit is about as wide as its operator (k=1 under Σ, x→0 under lim); the end of a whole
      // line that happens to sit under a tall digit ("2" of "x = 2" under the "6" of "3x = 6") is not
      const near = (above > -unitH * 0.1 && above < unitH) || (below > -unitH * 0.1 && below < unitH);
      const limit = isBig && h(v) < h(big) * 0.8 && near && !overhangs(v, big);
      if (limit) limits.push(j);
      if (accent || limit) {
        union(parent, i, j);
      }
    }
  }
  // a limit is often wider than its operator ("k=1" under Σ): its neighbours on that level join too
  for (let k = 0; k < limits.length; k++) {
    const v = units[limits[k]];
    for (let j = Math.max(0, limits[k] - 3); j < Math.min(n, limits[k] + 4); j++) {
      const u = units[j];
      if (find(parent, j) === find(parent, limits[k]) || h(u) > unitH * 1.2) continue;
      const gap = Math.max(u.x0 - v.x1, v.x0 - u.x1);
      if (gap < unitH * 0.5 && Math.abs((u.y0 + u.y1) / 2 - (v.y0 + v.y1) / 2) < unitH * 0.35) {
        union(parent, j, limits[k]);
        limits.push(j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(parent, i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  if (groups.size === n) return;
  const out: Unit[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(units[g[0]]);
      continue;
    }
    // the compound keeps the midline of its biggest glyph (the bracket, Σ, ∫, or an accent's base)
    const a = units[g.reduce((b, k) => (h(units[k]) > h(units[b]) ? k : b), g[0])];
    out.push(unitOf(g.flatMap((k) => units[k].ink), a.cy, unitH));
  }
  out.sort((a, b) => a.x0 - b.x0);
  units.splice(0, n, ...out);
}

/** Splits one page's writing into lines (left-to-right chains along a midline) and blocks. */
export function groupStrokes(pageId: string, strokes: readonly Stroke[]): InkBlock[] {
  const inks: Ink[] = [];
  for (const s of strokes) {
    if (!isWriting(s) || s.pts.length < 3) continue;
    // strokes are immutable: their features are computed once (grouping runs on every settle)
    let k = inkCache.get(s);
    if (!k) inkCache.set(s, (k = inkOf(s)));
    inks.push(k);
  }
  if (!inks.length) return [];
  const unitH = classify(inks);
  // not writing: loops drawn around other ink, and lone taps far from everything
  const loops = enclosingLoops(inks, unitH);
  const near = (k: Ink, r: number) => inks.some((o) => o !== k && !loops.has(o) && o.x0 < k.x1 + r && o.x1 > k.x0 - r && o.y0 < k.y1 + r && o.y1 > k.y0 - r);
  for (let i = inks.length - 1; i >= 0; i--) if (loops.has(inks[i]) || (inks[i].dot && !near(inks[i], unitH * 4))) inks.splice(i, 1);
  if (!inks.length) return [];

  // units: fractions (bar + numerator + denominator) and glyphs
  const fracs = findFractions(inks, unitH);
  const inFrac = new Set<Ink>();
  const units: Unit[] = [];
  for (const f of fracs) {
    const all = [f.bar, ...f.num, ...f.den];
    for (const k of all) inFrac.add(k);
    units.push(unitOf(all, f.bar.cy, unitH));
  }
  for (const s of symbols(inks.filter((k) => !inFrac.has(k)), unitH)) units.push(unitOf(s.ink, s.cy, unitH));
  units.sort((a, b) => a.x0 - b.x0);
  compound(units, unitH);

  // bands: a clear strip of empty space across the page is a line boundary that no row may cross
  // (fractions, limits and matrices are single units by now, so they never span a strip). Lines
  // written close together then stay apart even when one is written smaller than the rest
  const band = new Map<Unit, number>();
  {
    const byTop = [...units].sort((a, b) => a.y0 - b.y0);
    let b = -1, end = -Infinity;
    for (const u of byTop) {
      if (u.y0 > end + unitH * 0.12) b++;
      end = Math.max(end, u.y1);
      band.set(u, b);
    }
  }
  const bandOf = (r: Row) => band.get(r.units[0]) ?? -1;

  // chain units into rows: each joins the open row whose midline is closest, if near enough
  const rows: Row[] = [];
  const maxRowGap = unitH * 3.2;
  const dots: Unit[] = [];
  for (const u of units) {
    if (u.ink.every((k) => k.dot)) {
      dots.push(u); // decided once the rows exist
      continue;
    }
    let best: Row | null = null, bestCost = Infinity;
    for (const r of rows) {
      const gap = u.x0 - r.x1;
      if (gap > maxRowGap || bandOf(r) !== band.get(u)) continue;
      const dy = Math.abs(u.cy - r.mid);
      const tol = u.small ? unitH * 1.05 : unitH * 0.72;
      if (dy > tol) continue;
      const cost = dy / unitH + Math.max(0, gap) / unitH * 0.15;
      if (cost < bestCost) {
        bestCost = cost;
        best = r;
      }
    }
    if (!best) {
      rows.push({ units: [u], x0: u.x0, x1: u.x1, centers: u.small ? [] : [u.cy], mid: u.cy });
      continue;
    }
    best.units.push(u);
    best.x1 = Math.max(best.x1, u.x1);
    if (!u.small) {
      best.centers.push(u.cy);
      if (best.centers.length > 6) best.centers.shift();
      best.mid = median(best.centers);
    }
  }
  // dots (i/j dots that didn't touch, decimal points, stray taps) join the nearest row
  for (const d of dots) {
    let best: Row | null = null, bestD = Infinity;
    for (const r of rows) {
      if (d.x0 > r.x1 + unitH || d.x1 < r.x0 - unitH) continue;
      const dy = Math.abs(d.cy - r.mid);
      if (dy < bestD && dy < unitH * 1.3) {
        bestD = dy;
        best = r;
      }
    }
    if (best) best.units.push(d);
    else rows.push({ units: [d], x0: d.x0, x1: d.x1, centers: [], mid: d.cy });
  }

  // satellites: a row of a few small glyphs hugging another row (an exponent written before its
  // base, a subscript, a late dot) joins that row
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.units.length > 4 || !r.units.every((u) => u.small || Math.max(u.x1 - u.x0, u.y1 - u.y0) < unitH * 1.4)) continue;
    // an equation of its own ("x = 2" written small under "3x = 6") is a line, never a satellite
    if (r.units.some((u) => u.ink.length === 2 && u.ink.every((k) => k.flat))) continue;
    let best = -1, bestD = Infinity;
    rows.forEach((o, j) => {
      if (j === i || o.units.length <= r.units.length) return;
      // a superscript or subscript sits at the side of its base, not under or over the whole row
      const overlap = Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0);
      if (bandOf(o) !== bandOf(r) && overlap > (r.x1 - r.x0) * 0.5) return;
      const gap = Math.max(o.x0 - r.x1, r.x0 - o.x1);
      const dy = Math.abs(o.mid - median(r.units.map((u) => u.cy)));
      if (gap < unitH * 0.8 && dy < unitH * 1.25 && dy < bestD) [best, bestD] = [j, dy];
    });
    if (best >= 0) {
      const o = rows[best];
      o.units.push(...r.units);
      o.x0 = Math.min(o.x0, r.x0);
      o.x1 = Math.max(o.x1, r.x1);
      rows.splice(i, 1);
    }
  }

  const lines: InkLine[] = rows.map((r) => {
    const ink = r.units.flatMap((u) => u.ink);
    const ids = ink.map((k) => k.id).sort();
    return { id: 'l' + hashId(ids.join('|')), pageId, strokeIds: ids, bbox: boxOf(ink) };
  });

  // lines -> blocks: stacked lines with a small vertical gap and some horizontal overlap
  lines.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const n = lines.length;
  const parent = new Int32Array(n).map((_, i) => i);
  // a blank line's worth of space starts a new block. With a few lines to go by, "blank" is judged
  // against this writer's own line spacing (a separate problem 17 units above steps 2–7 units apart);
  // otherwise against the writing size
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i].bbox[1] - lines[i - 1].bbox[3];
    if (g > -unitH * 0.6) gaps.push(Math.max(0, g));
  }
  const fixedGap = Math.max(unitH * 2.6, median(lines.map((l) => l.bbox[3] - l.bbox[1])) * 2);
  const maxGap = gaps.length >= 3 ? Math.min(fixedGap, Math.max(unitH * 1.2, median(gaps) * 2.2)) : fixedGap;
  for (let i = 0; i < n; i++) {
    const a = lines[i].bbox;
    for (let j = i + 1; j < n; j++) {
      const b = lines[j].bbox;
      const vGap = b[1] - a[3];
      if (vGap > maxGap) break; // sorted by top: later lines are further down
      const xOverlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const sameColumn = xOverlap > 0 || Math.abs(a[0] - b[0]) < unitH * 6;
      const stacked = vGap > -unitH * 0.6; // not side by side on one row
      if (sameColumn && stacked) union(parent, i, j);
    }
  }
  const byRoot = new Map<number, InkLine[]>();
  for (let i = 0; i < n; i++) {
    const r = find(parent, i);
    const g = byRoot.get(r);
    if (g) g.push(lines[i]);
    else byRoot.set(r, [lines[i]]);
  }
  const blocks: InkBlock[] = [];
  for (const ls of byRoot.values()) {
    ls.sort((a, b) => (a.bbox[1] + a.bbox[3]) / 2 - (b.bbox[1] + b.bbox[3]) / 2);
    let bb: BBox = [...ls[0].bbox];
    for (const l of ls) bb = [Math.min(bb[0], l.bbox[0]), Math.min(bb[1], l.bbox[1]), Math.max(bb[2], l.bbox[2]), Math.max(bb[3], l.bbox[3])];
    blocks.push({ id: 'b' + hashId(ls.map((l) => l.id).join('|')), pageId, lines: ls, bbox: bb });
  }
  blocks.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return blocks;
}
