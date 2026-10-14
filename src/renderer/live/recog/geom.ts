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

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

/**
 * Typical glyph height ("unit") of a set of strokes, and the flat/dot flags relative to it.
 * The unit is about the height of a digit; dots and bars are judged against it.
 */
export function classify(inks: Ink[]): number {
  const size = inks.map((k) => Math.max(k.w, k.h));
  const rough = median(size) || 10;
  const tall = inks.filter((k) => k.h > rough * 0.35).map((k) => k.h);
  const unit = Math.max(2, median(tall) || rough);
  for (const k of inks) {
    k.dot = Math.max(k.w, k.h) < unit * 0.28;
    k.flat = !k.dot && k.w > unit * 0.3 && k.h < k.w * 0.28 && k.straight > 0.85;
  }
  return unit;
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
  const bars = inks.filter((k) => k.flat && k.w > unit * 0.55).sort((a, b) => b.w - a.w);
  for (const bar of bars) {
    if (used.has(bar)) continue;
    const span0 = bar.x0 - bar.w * 0.08, span1 = bar.x1 + bar.w * 0.08;
    const inSpan = (k: Ink) => k !== bar && !used.has(k) && k.cx >= span0 && k.cx <= span1;
    let num = inks.filter((k) => inSpan(k) && k.cy < bar.cy && k.y1 <= bar.cy + unit * 0.12 && k.y1 >= bar.cy - unit * 1.6);
    let den = inks.filter((k) => inSpan(k) && k.cy > bar.cy && k.y0 >= bar.cy - unit * 0.12 && k.y0 <= bar.cy + unit * 1.6);
    // the parts must start close to the bar
    const near = (set: Ink[], above: boolean) => set.some((k) => !k.flat && !k.dot && (above ? bar.cy - k.y1 : k.y0 - bar.cy) < unit * 0.75);
    if (!near(num, true) || !near(den, false)) continue;
    // "=" is two flat strokes; a stacked "=" under a numerator-like digit is still not a fraction
    // if the only ink below is another flat stroke
    if (!den.some((k) => !k.flat && !k.dot) || !num.some((k) => !k.flat && !k.dot)) continue;
    // grow each part with ink stacked on it (tall numerators, exponents inside)
    const grow = (set: Ink[], above: boolean) => {
      const s = new Set(set);
      let changed = true;
      while (changed) {
        changed = false;
        for (const k of inks) {
          if (s.has(k) || k === bar || used.has(k) || k.cx < span0 || k.cx > span1) continue;
          if (above ? k.cy > bar.cy : k.cy < bar.cy) continue;
          for (const m of s) {
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
      if (gap > maxRowGap) continue;
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
    let best = -1, bestD = Infinity;
    rows.forEach((o, j) => {
      if (j === i || o.units.length <= r.units.length) return;
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
  // a blank line's worth of space starts a new block; line spacing scales with the writing size
  const maxGap = Math.max(unitH * 2.6, median(lines.map((l) => l.bbox[3] - l.bbox[1])) * 2);
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
