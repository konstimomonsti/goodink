// 2-D math layout of one handwritten line: fraction bars with numerator/denominator, square roots,
// exponents (raised, smaller) and subscripts. The result is a tree of runs; each run's own glyphs
// are recognised as one piece of writing, and the tree turns the readings into linear text/LaTeX.
import { classify, findFractions, inkOf, symbols, type Ink, type Sym } from './geom';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cy: number;
  h: number;
}

export type Item =
  | { t: 'sym'; sym: Sym; x0: number }
  | { t: 'sup' | 'sub'; run: Run; x0: number }
  | { t: 'frac'; bar: Ink; num: Run; den: Run; x0: number; box: Box }
  | { t: 'sqrt'; radical: Ink; body: Run; x0: number; box: Box };

const boxOfInks = (ink: Ink[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of ink) {
    x0 = Math.min(x0, k.x0);
    y0 = Math.min(y0, k.y0);
    x1 = Math.max(x1, k.x1);
    y1 = Math.max(y1, k.y1);
  }
  return { x0, y0, x1, y1, cy: (y0 + y1) / 2, h: y1 - y0 };
};

export interface Run {
  items: Item[]; // left to right
  syms: Sym[]; // this run's own glyphs, left to right (what gets recognised as one group)
  /** midline and typical glyph height of the run */
  mid: number;
  hh: number;
  /** baseline (bottom of normal glyphs) */
  base: number;
}

export interface Layout {
  root: Run;
  unit: number;
  /** true when there is any 2-D structure (fraction, root, script) */
  structured: boolean;
  inks: Ink[];
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** A √ written in one stroke: a tick on the left and a long horizontal stretch along the top. */
function isRadical(k: Ink, unit: number): boolean {
  if (k.flat || k.dot || k.w < unit * 0.9 || k.h < unit * 0.6) return false;
  const p = k.pts;
  const band = k.y0 + k.h * 0.2;
  let run0 = Infinity, run1 = -Infinity, best = 0, lowLeft = false;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (y <= band) {
      run0 = Math.min(run0, x);
      run1 = Math.max(run1, x);
      best = Math.max(best, run1 - run0);
    } else {
      run0 = Infinity;
      run1 = -Infinity;
    }
    if (x < k.x0 + k.w * 0.4 && y > k.y1 - k.h * 0.25) lowLeft = true;
  }
  return lowLeft && best > k.w * 0.45;
}

function layoutInks(inks: Ink[], unit: number, depth: number): Run {
  const items: Item[] = [];
  let rest = inks;
  if (depth < 4) {
    // fractions first (they own the ink above and below their bar)
    const fracs = findFractions(rest, unit);
    const used = new Set<Ink>();
    for (const f of fracs) {
      for (const k of [f.bar, ...f.num, ...f.den]) used.add(k);
      items.push({ t: 'frac', bar: f.bar, num: layoutInks(f.num, unit, depth + 1), den: layoutInks(f.den, unit, depth + 1), x0: f.bar.x0, box: boxOfInks([f.bar, ...f.num, ...f.den]) });
    }
    rest = rest.filter((k) => !used.has(k));
    // square roots own the ink under their overbar
    for (const r of rest.filter((k) => isRadical(k, unit))) {
      if (used.has(r)) continue;
      const body = rest.filter((k) => k !== r && !used.has(k) && k.cx > r.x0 + r.w * 0.28 && k.cx < r.x1 + unit * 0.15 && k.y0 >= r.y0 - unit * 0.1 && k.y1 <= r.y1 + unit * 0.35);
      if (!body.length) continue;
      used.add(r);
      for (const k of body) used.add(k);
      items.push({ t: 'sqrt', radical: r, body: layoutInks(body, unit, depth + 1), x0: r.x0, box: boxOfInks([r, ...body]) });
    }
    rest = rest.filter((k) => !used.has(k));
  }
  const syms = symbols(rest, unit, new Set());
  // the run's midline and glyph size, from its normal-size glyphs
  const normal = syms.filter((s) => !s.dot && !s.flat && s.h >= unit * 0.45);
  const ref = normal.length ? normal : syms;
  const mid = ref.length ? median(ref.map((s) => s.cy)) : inks.length ? median(inks.map((k) => k.cy)) : 0;
  const hh = Math.max(unit * 0.5, normal.length ? median(normal.map((s) => s.h)) : unit);
  const base = normal.length ? median(normal.map((s) => s.y1)) : mid + hh / 2;

  // scripts: glyphs raised above (or dropped below) the writing line right after a base. The
  // line's midline and baseline start from the run's medians and follow the normal-size glyphs
  // left to right, so a drifting line keeps working.
  const seq: Item[] = [...items, ...syms.map((sym): Item => ({ t: 'sym', sym, x0: sym.x0 }))].sort((a, b) => a.x0 - b.x0);
  const out: Item[] = [];
  const boxOf = (it: Item): Box | null => (it.t === 'sym' ? it.sym : it.t === 'frac' || it.t === 'sqrt' ? it.box : null);
  // a run never starts with a script: a normal-size first glyph anchors the line (x^{n+1})
  const f0 = seq[0]?.t === 'sym' ? seq[0].sym : null;
  const others = syms.filter((g) => g !== f0 && !g.flat && !g.dot);
  const anchor = !!f0 && !f0.flat && !f0.dot && f0.h >= hh && f0.h <= hh * 1.35 && others.filter((g) => g.y1 < f0.cy && g.h < f0.h * 0.9).length * 2 > others.length;
  const mids: number[] = [anchor ? f0!.cy : mid];
  const bases: number[] = [anchor ? f0!.y1 : base];
  let refMid = mids[0], refBase = bases[0];
  const track = (g: Sym) => {
    if (g.flat || g.dot || g.h < hh * 0.6 || g.h > hh * 1.35 || g.y1 > refBase + hh * 0.25) return;
    mids.push(g.cy);
    bases.push(g.y1);
    if (mids.length > 4) mids.shift(), bases.shift();
    refMid = median(mids);
    refBase = median(bases);
  };
  for (let i = 0; i < seq.length; i++) {
    const it = seq[i];
    const prev = out[out.length - 1];
    const b = prev && boxOf(prev);
    if (it.t === 'sym' && b && !(prev.t === 'sym' && (prev.sym.flat || prev.sym.dot)) && it.sym.x0 - b.x1 < hh * 0.9) {
      const s = it.sym;
      const size = Math.max(hh, b.h);
      // raised: bottom above the midline, centre in the base's upper part, not bigger than the base
      const up = (g: Sym) => !g.dot && g.y1 < refMid - hh * 0.04 && g.cy < refMid - hh * 0.3 && g.cy < b.y0 + b.h * 0.4 && g.h < size * (g.y1 < refMid - hh * 0.15 ? 1.05 : 0.9);
      // lowered: top under the midline, bottom under the baseline; not after a descender (g, y)
      const down = (g: Sym) => !g.dot && !g.flat && prev.t === 'sym' && b.y1 < refBase + hh * 0.15 && g.y0 > refMid - hh * 0.2 && g.y1 > refBase + hh * 0.2 && g.h < size * 0.95;
      const next = seq[i + 1];
      // x^-1: a raised minus counts when a raised glyph follows it
      const minusUp = s.flat && s.cy < refMid - hh * 0.4 && next?.t === 'sym' && up(next.sym);
      const kind = up(s) || minusUp ? 'sup' : down(s) ? 'sub' : null;
      if (kind) {
        const group: Ink[] = [...s.ink];
        let j = i + 1;
        let lastX = s.x1;
        for (; j < seq.length; j++) {
          const g = seq[j].t === 'sym' ? (seq[j] as { sym: Sym }).sym : null;
          if (!g || g.x0 - lastX > hh * 0.6 || g.h > size * 0.95) break;
          const ok = kind === 'sup' ? g.cy < refMid - hh * 0.25 && g.y1 < refMid + hh * 0.05 : g.cy > refMid + hh * 0.2 && (g.flat || g.y1 > refBase + hh * 0.05);
          if (!ok) break;
          group.push(...g.ink);
          lastX = g.x1;
        }
        out.push({ t: kind, run: layoutInks(group, unit, depth + 1), x0: s.x0 });
        i = j - 1;
        continue;
      }
    }
    if (it.t === 'sym') track(it.sym);
    out.push(it);
  }
  return { items: out, syms: out.flatMap((it) => (it.t === 'sym' ? [it.sym] : [])), mid, hh, base };
}

export function layoutLine(strokes: { id: string; pts: ArrayLike<number> }[]): Layout {
  const inks = strokes.filter((s) => s.pts.length >= 3).map(inkOf);
  const unit = classify(inks);
  const root = layoutInks(inks, unit, 0);
  return { root, unit, structured: root.items.some((it) => it.t !== 'sym'), inks };
}

/** Every run of the tree, the root first (recognition groups). */
export function runsOf(run: Run, out: Run[] = []): Run[] {
  out.push(run);
  for (const it of run.items) {
    if (it.t === 'sup' || it.t === 'sub') runsOf(it.run, out);
    else if (it.t === 'frac') {
      runsOf(it.num, out);
      runsOf(it.den, out);
    } else if (it.t === 'sqrt') runsOf(it.body, out);
  }
  return out;
}
