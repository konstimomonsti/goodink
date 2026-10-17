// Synthetic handwriting for Live Ink scenarios: writes words and 2-D math as slightly messy,
// mostly single-stroke glyphs through real pen pointer events (pointerType 'pen', with pressure).
//
//   import { newNotebook, writeText, pageStrokes } from './live/handwriting.mjs';
//   await newNotebook(win);
//   await writeText(win, '2x+3=7', { x: 80, y: 120, size: 26, jitter: 0.5, seed: 1 });
//
// Text syntax: plain characters, `x^2` / `x^{n+1}` (raised, smaller), `x_1` (lowered),
// `\frac{a}{b}` (stacked fraction with a bar), `\sqrt{x}` or `√x` (radical with overbar),
// `−` or `-`, `×`, `÷`, `·`. x, y = left end of the baseline in page units; size = em in page
// units (x-height is half of it). jitter 0 = clean, 1 = messy. Glyph coords: y up, baseline 0.

// ---- deterministic randomness -------------------------------------------------------------------

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}

// ---- glyphs -------------------------------------------------------------------------------------

const arc = (cx, cy, rx, ry, a0, a1, n = 0) => {
  const steps = n || Math.max(6, Math.round(Math.abs(a1 - a0) / 15));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
};
const dot = (x, y) => [[x, y], [x + 0.012, y - 0.012]];
const cat = (...parts) => parts.flat();

/** char -> { w: advance width, s: strokes (arrays of [x, y]) } */
const G = {
  '∫': { w: 0.42, s: [[[0.44, 1.12], [0.38, 1.19], [0.3, 1.14], [0.26, 0.95], [0.22, 0.4], [0.18, -0.2], [0.13, -0.33], [0.05, -0.36], [0.0, -0.3]]] },
  a: { w: 0.42, s: [cat(arc(0.2, 0.25, 0.19, 0.24, 50, 375), [[0.39, 0.5], [0.39, 0.06], [0.44, 0]])] },
  b: { w: 0.4, s: [cat([[0.02, 0.82], [0.02, 0]], arc(0.2, 0.24, 0.18, 0.24, 200, -170))] },
  c: { w: 0.36, s: [arc(0.2, 0.25, 0.19, 0.25, 40, 320)] },
  d: { w: 0.42, s: [cat(arc(0.2, 0.25, 0.19, 0.24, 10, 350), [[0.39, 0.82], [0.39, 0.04], [0.43, 0]])] },
  e: { w: 0.38, s: [cat([[0.03, 0.25], [0.37, 0.27]], arc(0.2, 0.25, 0.18, 0.25, 20, 320))] },
  f: { w: 0.3, s: [cat(arc(0.27, 0.66, 0.12, 0.14, 30, 180), [[0.15, 0]]), [[0.02, 0.45], [0.3, 0.46]]] },
  g: { w: 0.42, s: [cat(arc(0.2, 0.27, 0.19, 0.23, 50, 375), [[0.39, 0.5], [0.39, -0.12]], arc(0.22, -0.12, 0.17, 0.13, 0, -170))] },
  h: { w: 0.4, s: [cat([[0.02, 0.82], [0.02, 0], [0.02, 0.28]], arc(0.2, 0.28, 0.17, 0.2, 170, 0), [[0.37, 0]])] },
  i: { w: 0.14, s: [[[0.06, 0.5], [0.05, 0.02], [0.09, 0]], dot(0.06, 0.7)] },
  j: { w: 0.22, s: [cat([[0.14, 0.5], [0.14, -0.13]], arc(0.02, -0.13, 0.12, 0.12, 0, -160)), dot(0.14, 0.7)] },
  k: { w: 0.36, s: [[[0.02, 0.82], [0.02, 0]], [[0.32, 0.5], [0.04, 0.22], [0.34, 0]]] },
  l: { w: 0.14, s: [[[0.06, 0.82], [0.05, 0.05], [0.1, 0]]] },
  m: { w: 0.62, s: [cat([[0.02, 0.5], [0.02, 0], [0.02, 0.3]], arc(0.16, 0.3, 0.14, 0.18, 170, 0), [[0.3, 0], [0.3, 0.3]], arc(0.44, 0.3, 0.14, 0.18, 170, 0), [[0.58, 0]])] },
  n: { w: 0.4, s: [cat([[0.02, 0.5], [0.02, 0], [0.02, 0.3]], arc(0.19, 0.3, 0.17, 0.18, 170, 0), [[0.36, 0]])] },
  o: { w: 0.4, s: [arc(0.2, 0.25, 0.19, 0.25, 100, 460)] },
  p: { w: 0.42, s: [cat([[0.02, 0.5], [0.02, -0.3], [0.02, 0.22]], arc(0.2, 0.26, 0.18, 0.23, 180, -170))] },
  q: { w: 0.42, s: [cat(arc(0.2, 0.26, 0.19, 0.23, 50, 375), [[0.39, 0.5], [0.39, -0.3], [0.46, -0.24]])] },
  r: { w: 0.3, s: [cat([[0.02, 0.5], [0.02, 0], [0.02, 0.3]], arc(0.2, 0.28, 0.17, 0.2, 160, 60))] },
  s: { w: 0.34, s: [[[0.31, 0.44], [0.22, 0.5], [0.08, 0.48], [0.04, 0.37], [0.15, 0.28], [0.28, 0.21], [0.31, 0.1], [0.22, 0.01], [0.08, 0], [0.01, 0.06]]] },
  t: { w: 0.3, s: [[[0.12, 0.74], [0.12, 0.06], [0.2, 0], [0.27, 0.03]], [[0.0, 0.48], [0.28, 0.49]]] },
  u: { w: 0.4, s: [cat([[0.02, 0.5], [0.02, 0.16]], arc(0.18, 0.17, 0.16, 0.17, 180, 360), [[0.35, 0.5], [0.35, 0.03], [0.39, 0]])] },
  v: { w: 0.38, s: [[[0.0, 0.5], [0.18, 0], [0.36, 0.5]]] },
  w: { w: 0.54, s: [[[0.0, 0.5], [0.12, 0], [0.25, 0.38], [0.38, 0], [0.52, 0.5]]] },
  x: { w: 0.38, s: [[[0.02, 0.5], [0.36, 0]], [[0.36, 0.5], [0.02, 0]]] },
  y: { w: 0.4, s: [[[0.0, 0.5], [0.19, 0.04]], [[0.36, 0.5], [0.2, 0.08], [0.12, -0.12], [0.04, -0.3]]] },
  z: { w: 0.38, s: [[[0.02, 0.5], [0.34, 0.5], [0.02, 0.01], [0.37, 0.01]]] },

  A: { w: 0.52, s: [[[0.0, 0], [0.25, 0.75], [0.5, 0]], [[0.12, 0.3], [0.38, 0.3]]] },
  B: { w: 0.44, s: [[[0.02, 0.75], [0.02, 0]], cat([[0.02, 0.75]], arc(0.2, 0.57, 0.18, 0.18, 90, -90), arc(0.22, 0.2, 0.2, 0.2, 90, -90), [[0.02, 0]])] },
  C: { w: 0.48, s: [arc(0.28, 0.37, 0.27, 0.37, 45, 315)] },
  D: { w: 0.48, s: [[[0.02, 0.75], [0.02, 0]], cat([[0.02, 0.75]], arc(0.08, 0.375, 0.38, 0.375, 90, -90), [[0.02, 0]])] },
  E: { w: 0.4, s: [[[0.38, 0.75], [0.02, 0.75], [0.02, 0], [0.38, 0]], [[0.02, 0.38], [0.3, 0.38]]] },
  F: { w: 0.38, s: [[[0.36, 0.75], [0.02, 0.75], [0.02, 0]], [[0.02, 0.4], [0.28, 0.4]]] },
  G: { w: 0.5, s: [cat(arc(0.27, 0.37, 0.26, 0.37, 45, 350), [[0.33, 0.3]])] },
  H: { w: 0.48, s: [[[0.02, 0.75], [0.02, 0]], [[0.44, 0.75], [0.44, 0]], [[0.02, 0.38], [0.44, 0.38]]] },
  I: { w: 0.14, s: [[[0.06, 0.75], [0.06, 0]]] },
  J: { w: 0.36, s: [cat([[0.3, 0.75], [0.3, 0.18]], arc(0.16, 0.18, 0.14, 0.18, 0, -170))] },
  K: { w: 0.42, s: [[[0.02, 0.75], [0.02, 0]], [[0.38, 0.75], [0.04, 0.33], [0.4, 0]]] },
  L: { w: 0.36, s: [[[0.02, 0.75], [0.02, 0], [0.34, 0]]] },
  M: { w: 0.62, s: [[[0.02, 0], [0.04, 0.75], [0.3, 0.2], [0.56, 0.75], [0.58, 0]]] },
  N: { w: 0.5, s: [[[0.02, 0], [0.02, 0.75], [0.46, 0], [0.46, 0.75]]] },
  O: { w: 0.54, s: [arc(0.27, 0.375, 0.26, 0.375, 100, 460)] },
  P: { w: 0.42, s: [cat([[0.02, 0], [0.02, 0.75]], arc(0.18, 0.56, 0.18, 0.19, 90, -90), [[0.02, 0.37]])] },
  Q: { w: 0.54, s: [arc(0.27, 0.375, 0.26, 0.375, 100, 460), [[0.3, 0.15], [0.52, -0.05]]] },
  R: { w: 0.44, s: [cat([[0.02, 0], [0.02, 0.75]], arc(0.18, 0.56, 0.18, 0.19, 90, -90), [[0.02, 0.37], [0.4, 0]])] },
  S: { w: 0.42, s: [[[0.38, 0.66], [0.26, 0.75], [0.1, 0.73], [0.03, 0.6], [0.12, 0.45], [0.3, 0.35], [0.39, 0.2], [0.32, 0.04], [0.16, 0], [0.01, 0.08]]] },
  T: { w: 0.46, s: [[[0.0, 0.75], [0.46, 0.75]], [[0.23, 0.75], [0.23, 0]]] },
  U: { w: 0.48, s: [cat([[0.02, 0.75], [0.02, 0.22]], arc(0.23, 0.22, 0.21, 0.22, 180, 360), [[0.44, 0.75]])] },
  V: { w: 0.48, s: [[[0.0, 0.75], [0.23, 0], [0.46, 0.75]]] },
  W: { w: 0.7, s: [[[0.0, 0.75], [0.16, 0], [0.34, 0.6], [0.52, 0], [0.68, 0.75]]] },
  X: { w: 0.46, s: [[[0.02, 0.75], [0.44, 0]], [[0.44, 0.75], [0.02, 0]]] },
  Y: { w: 0.46, s: [[[0.0, 0.75], [0.23, 0.38]], [[0.46, 0.75], [0.23, 0.38], [0.23, 0]]] },
  Z: { w: 0.44, s: [[[0.02, 0.75], [0.42, 0.75], [0.02, 0], [0.44, 0]]] },

  0: { w: 0.4, s: [arc(0.19, 0.35, 0.18, 0.35, 95, 460)] },
  1: { w: 0.26, s: [[[0.04, 0.54], [0.17, 0.7], [0.17, 0]]] },
  2: { w: 0.4, s: [cat(arc(0.19, 0.5, 0.17, 0.19, 160, -20), [[0.01, 0], [0.38, 0.01]])] },
  3: { w: 0.38, s: [cat(arc(0.17, 0.53, 0.16, 0.17, 150, -90), arc(0.16, 0.19, 0.19, 0.19, 90, -150))] },
  4: { w: 0.4, s: [[[0.26, 0.7], [0.01, 0.22], [0.38, 0.22]], [[0.28, 0.46], [0.28, 0]]] },
  5: { w: 0.38, s: [cat([[0.33, 0.7], [0.06, 0.7], [0.04, 0.42]], arc(0.17, 0.22, 0.18, 0.21, 125, -165))] },
  6: { w: 0.38, s: [cat([[0.3, 0.7], [0.13, 0.56], [0.03, 0.28]], arc(0.18, 0.2, 0.16, 0.2, 180, 540))] },
  7: { w: 0.38, s: [[[0.01, 0.7], [0.36, 0.7], [0.13, 0]]] },
  8: { w: 0.38, s: [Array.from({ length: 33 }, (_, i) => { const t = (i / 32) * Math.PI * 2; return [0.19 - 0.16 * Math.sin(2 * t) * 0.95, 0.35 + 0.35 * Math.cos(t)]; })] },
  9: { w: 0.38, s: [cat(arc(0.18, 0.5, 0.17, 0.19, 10, 370), [[0.35, 0.5], [0.31, 0]])] },

  '+': { w: 0.42, s: [[[0.02, 0.3], [0.4, 0.3]], [[0.21, 0.12], [0.21, 0.5]]] },
  '-': { w: 0.36, s: [[[0.02, 0.3], [0.34, 0.3]]] },
  '−': { w: 0.36, s: [[[0.02, 0.3], [0.34, 0.3]]] },
  '=': { w: 0.4, s: [[[0.02, 0.4], [0.38, 0.4]], [[0.02, 0.2], [0.38, 0.2]]] },
  '×': { w: 0.36, s: [[[0.04, 0.46], [0.32, 0.14]], [[0.32, 0.46], [0.04, 0.14]]] },
  '÷': { w: 0.4, s: [[[0.02, 0.3], [0.38, 0.3]], dot(0.2, 0.47), dot(0.2, 0.13)] },
  '·': { w: 0.16, s: [dot(0.08, 0.3)] },
  '(': { w: 0.22, s: [arc(0.3, 0.3, 0.24, 0.48, 125, 235)] },
  ')': { w: 0.22, s: [arc(-0.08, 0.3, 0.24, 0.48, 55, -55)] },
  '|': { w: 0.14, s: [[[0.06, 0.8], [0.06, -0.15]]] },
  '[': { w: 0.2, s: [[[0.18, 0.8], [0.04, 0.8], [0.04, -0.18], [0.18, -0.18]]] },
  ']': { w: 0.2, s: [[[0.02, 0.8], [0.16, 0.8], [0.16, -0.18], [0.02, -0.18]]] },
  '/': { w: 0.34, s: [[[0.32, 0.76], [0.02, -0.06]]] },
  '.': { w: 0.14, s: [dot(0.06, 0.02)] },
  ',': { w: 0.14, s: [[[0.08, 0.05], [0.04, -0.1]]] },
  ':': { w: 0.14, s: [dot(0.06, 0.42), dot(0.06, 0.06)] },
  '<': { w: 0.36, s: [[[0.34, 0.5], [0.02, 0.3], [0.34, 0.1]]] },
  '>': { w: 0.36, s: [[[0.02, 0.5], [0.34, 0.3], [0.02, 0.1]]] },
  '?': { w: 0.34, s: [cat(arc(0.16, 0.56, 0.15, 0.16, 160, -60), [[0.16, 0.22]]), dot(0.16, 0.02)] },
  "'": { w: 0.1, s: [[[0.05, 0.78], [0.04, 0.6]]] },
};

// ---- layout: text -> positioned glyphs and bars, in writing order -----------------------------------

function parse(src) {
  const items = [];
  let i = 0;
  const group = () => {
    if (src[i] === '{') {
      let depth = 1, j = i + 1;
      while (j < src.length && depth) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const inner = src.slice(i + 1, j - 1);
      i = j;
      return parse(inner);
    }
    if (src.startsWith('\\', i)) {
      const sub = [];
      const one = parseOne();
      if (one) sub.push(one);
      return sub;
    }
    return [{ t: 'ch', c: src[i++] }];
  };
  const parseOne = () => {
    if (src.startsWith('\\frac', i)) {
      i += 5;
      return { t: 'frac', num: group(), den: group() };
    }
    if (src.startsWith('\\int', i)) {
      i += 4;
      let lo = null, hi = null;
      for (let k = 0; k < 2; k++) {
        if (src[i] === '_') { i++; lo = group(); }
        else if (src[i] === '^') { i++; hi = group(); }
      }
      return { t: 'int', lo, hi };
    }
    if (src.startsWith('\\sqrt', i)) {
      i += 5;
      return { t: 'sqrt', body: group() };
    }
    const c = src[i];
    if (c === '√') {
      i++;
      return { t: 'sqrt', body: group() };
    }
    if (c === '^') {
      i++;
      return { t: 'sup', body: group() };
    }
    if (c === '_') {
      i++;
      return { t: 'sub', body: group() };
    }
    i++;
    return { t: 'ch', c };
  };
  while (i < src.length) items.push(parseOne());
  return items;
}

const GAP = 0.1;

/** Lays out items at scale k from x (em units, baseline y). Returns marks in writing order. */
function layout(items, k, x, y, marks) {
  for (const it of items) {
    if (it.t === 'ch') {
      if (it.c === ' ') {
        x += 0.45 * k;
        continue;
      }
      const g = G[it.c];
      if (!g) throw new Error(`handwriting: no glyph for ${JSON.stringify(it.c)}`);
      marks.push({ kind: 'glyph', c: it.c, x, y, k });
      x += (g.w + GAP) * k;
    } else if (it.t === 'sup') {
      x = layout(it.body, k * 0.62, x + 0.02 * k, y + 0.42 * k, marks);
    } else if (it.t === 'sub') {
      x = layout(it.body, k * 0.62, x + 0.02 * k, y - 0.16 * k, marks);
    } else if (it.t === 'frac') {
      const kk = k * 0.85;
      const wn = measure(it.num, kk), wd = measure(it.den, kk);
      const w = Math.max(wn, wd) + 0.16 * k;
      const bar = y + 0.3 * k;
      layout(it.num, kk, x + (w - wn) / 2, bar + 0.13 * k, marks);
      marks.push({ kind: 'bar', x0: x, x1: x + w, y: bar, k });
      layout(it.den, kk, x + (w - wd) / 2, bar - 0.13 * k - 0.7 * kk, marks);
      x += w + GAP * k;
    } else if (it.t === 'int') {
      // the sign first, then its upper and lower limit, as people write them
      marks.push({ kind: 'glyph', c: '∫', x, y, k });
      const kl = k * 0.55;
      const xh = it.hi ? layout(it.hi, kl, x + 0.4 * k, y + 0.95 * k, marks) : x;
      const xl = it.lo ? layout(it.lo, kl, x + 0.02 * k, y - 0.62 * k, marks) : x;
      x = Math.max(x + (G['∫'].w + GAP) * k, xh + GAP * k, xl + GAP * k);
    } else if (it.t === 'sqrt') {
      const wb = measure(it.body, k);
      marks.push({ kind: 'radical', x, y, k, w: wb + 0.1 * k });
      x = layout(it.body, k, x + 0.36 * k, y, marks) + 0.04 * k;
    }
  }
  return x;
}

function measure(items, k) {
  const m = [];
  return layout(items, k, 0, 0, m) - GAP * k;
}

// ---- rendering: marks -> jittered page-space strokes -------------------------------------------------

function smooth(poly, step) {
  // Catmull-Rom through the control points, resampled roughly every `step`
  const out = [];
  const P = (i) => poly[Math.max(0, Math.min(poly.length - 1, i))];
  for (let i = 0; i < poly.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(poly[poly.length - 1]);
  return out;
}

/**
 * Pure generator: page-space strokes for `text`, in writing order.
 * Returns [{ pts: [[x, y, pressure], ...], mark: 'a' | 'bar' | 'radical', glyph: index of the glyph }].
 */
export function strokesFor(text, { x = 80, y = 120, size = 24, jitter = 0.4, slant = 0.12, seed = 1 } = {}) {
  const rnd = rng(seed * 7919 + text.length * 31 + 17);
  const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5; // ~normal-ish in [-1, 1]
  const marks = [];
  layout(parse(text), 1, 0, 0, marks);
  const out = [];
  let drift = 0;
  const toPage = (ex, ey, m) => {
    // y up in em -> y down on the page; shear for slant; slow baseline drift
    const sx = ex + ey * slant;
    return [x + sx * size, y - (ey + m.dy) * size];
  };
  const pushStroke = (poly, m, label) => {
    const amp = 0.012 * jitter;
    const ph = rnd() * 6.28, fr = 4 + rnd() * 6;
    const dense = smooth(poly, 0.035);
    const pts = dense.map(([px, py], i) => {
      const t = i / Math.max(1, dense.length - 1);
      const wob = Math.sin(ph + t * fr) * amp;
      const [qx, qy] = toPage(px + wob + g() * amp * 0.3, py + Math.cos(ph + t * fr * 0.7) * amp + g() * amp * 0.3, m);
      const pressure = Math.min(0.95, 0.35 + 0.35 * Math.sin(Math.PI * Math.min(1, t * 1.6 + 0.1)) + g() * 0.04);
      return [qx, qy, Math.max(0.1, pressure)];
    });
    out.push({ pts, mark: label, glyph: marks.indexOf(m) });
  };
  for (const m of marks) {
    drift += g() * 0.006 * jitter;
    m.dy = drift + g() * 0.03 * jitter;
    if (m.kind === 'glyph') {
      const gl = G[m.c];
      const sc = m.k * (1 + g() * 0.07 * jitter);
      const rot = g() * 0.05 * jitter;
      const ox = m.x + g() * 0.02 * jitter;
      for (const s of gl.s) {
        const poly = s.map(([px, py]) => {
          const rx = px * Math.cos(rot) - py * Math.sin(rot), ry = px * Math.sin(rot) + py * Math.cos(rot);
          return [ox + rx * sc, m.y + ry * sc];
        });
        pushStroke(poly, m, m.c);
      }
    } else if (m.kind === 'bar') {
      const tilt = g() * 0.02 * jitter;
      pushStroke([[m.x0 + g() * 0.03 * jitter, m.y], [(m.x0 + m.x1) / 2, m.y + tilt / 2 + g() * 0.01 * jitter], [m.x1 + g() * 0.03 * jitter, m.y + tilt]], m, 'bar');
    } else if (m.kind === 'radical') {
      const k = m.k;
      pushStroke([[m.x, m.y + 0.3 * k], [m.x + 0.07 * k, m.y + 0.36 * k], [m.x + 0.16 * k, m.y - 0.02 * k], [m.x + 0.3 * k, m.y + 0.82 * k], [m.x + 0.3 * k + m.w, m.y + 0.82 * k + g() * 0.02 * jitter]], m, 'radical');
    }
  }
  return out;
}

export const glyphChars = () => Object.keys(G);

// ---- driving the app ----------------------------------------------------------------------------

/** Creates a blank A4 notebook and waits for its first page. */
export async function newNotebook(win, title = 'Live ink') {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate((t) => window.__goodink.createNotebook({ title: t, folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false }), title);
  await win.locator('.gi-page').first().waitFor();
  await win.waitForTimeout(800);
}

/** Client position of the current page's origin and the zoom (client px per page unit). */
export async function pageOrigin(win) {
  return win.evaluate(() => {
    const vp = window.__editor.vp;
    const i = vp.pageIndexNow;
    const page = vp.session.pages[i];
    const el = [...document.querySelectorAll('.gi-page')].find((e) => e.getBoundingClientRect().height > 0) ?? document.querySelector('.gi-page');
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, zoom: vp.zoom, pageId: page.id, ox: page.ox ?? 0, oy: page.oy ?? 0 };
  });
}

/**
 * Writes `text` with real pen pointer events at page position (x, y) (baseline start).
 * Returns { strokes: number of strokes written, bbox: page-space [x0, y0, x1, y1], marks }.
 */
export async function writeText(win, text, opts = {}) {
  const strokes = strokesFor(text, opts);
  const o = await pageOrigin(win);
  const client = strokes.map((s) => s.pts.map(([x, y, p]) => [o.left + (x - o.ox) * o.zoom, o.top + (y - o.oy) * o.zoom, p]));
  await win.evaluate(async (all) => {
    const sc = document.querySelector('.gi-scroller');
    const fire = (type, x, y, buttons, pressure) =>
      sc.dispatchEvent(new PointerEvent(type, { pointerId: 2, pointerType: 'pen', clientX: x, clientY: y, buttons, button: type === 'pointermove' ? -1 : 0, pressure, bubbles: true, cancelable: true, isPrimary: true }));
    for (const s of all) {
      const [x0, y0] = s[0];
      fire('pointermove', x0, y0, 0, 0); // hover in
      fire('pointerdown', x0, y0, 1, s[0][2]);
      // like a real digitiser: a raw update and a move per sample (the viewport inks from either)
      for (let i = 1; i < s.length; i++) {
        fire('pointerrawupdate', s[i][0], s[i][1], 1, s[i][2]);
        fire('pointermove', s[i][0], s[i][1], 1, s[i][2]);
      }
      const l = s[s.length - 1];
      fire('pointerup', l[0], l[1], 0, 0);
    }
    await new Promise((r) => requestAnimationFrame(() => r()));
  }, client);
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) for (const [x, y] of s.pts) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return { strokes: strokes.length, bbox: b, marks: strokes.map((s) => s.mark) };
}

/** The current page's strokes as plain data ({ id, kind, pts: number[], bbox }). */
export async function pageStrokes(win) {
  return win.evaluate(async () => {
    const g = window.__goodink;
    const vp = window.__editor.vp;
    const s = await g.getSession(g.useApp.getState().active);
    const page = s.pages[vp.pageIndexNow];
    return { pageId: page.id, strokes: (s.content(page.id)?.strokes ?? []).map((st) => ({ id: st.id, kind: st.kind, pts: [...st.pts], bbox: st.bbox })) };
  });
}

/** Removes every stroke on the current page (between eval items). */
export async function clearPage(win) {
  await win.evaluate(async () => {
    const g = window.__goodink;
    const vp = window.__editor.vp;
    const s = await g.getSession(g.useApp.getState().active);
    const id = s.pages[vp.pageIndexNow].id;
    const c = s.content(id) ?? { strokes: [], objects: [] };
    s.commit(id, { ...c, strokes: [] });
  });
}
