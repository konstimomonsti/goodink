// Live check marks drawn as vector paths in an SVG layer on each page (docs/live-ink/ARCHITECTURE.md §B):
//   error   soft hand-drawn red wave, 1.5 px at 100% (scaled with zoom), 70%, draws in once
//   unsure  amber dotted line, 55% opacity scaled by confidence
//   ok      small green tick (≤ 10 px, 40%)
//   fixed   a one-off green tick fade where a wrong step was just fixed
//   result  the live answer after a trailing "=", drawn as ghost ink in the pen colour
//   more    "+n" dot in the margin when a page has more red than it should show
//   ring    1 px focus ring around the block a voice question refers to
// Paths are built in screen pixels for the zoom on screen (crisp at every DPR), and the layer is only
// scaled by CSS while a zoom gesture runs. New kinds register in MARK_PAINTERS; the viewport needs
// no change.
import { apply, type Mat } from '../../engine/geometry';
import type { UiDecoration } from './engineApi';
import { LIVE_TUNING as T } from './tuning';
import { ghostPaths, ghostText, ghostable } from './ghostInk';

const NS = 'http://www.w3.org/2000/svg';
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Deterministic 0..1 noise from a string seed, so a rebuilt mark never changes shape. */
function seedOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: string) {
  let h = seedOf(seed);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * Screen geometry of a mark (CSS px): it runs under the marked tokens, clear of their lowest ink by
 * max(3 px, 0.12 line height), 3 px past each side and never shorter than max(14 px, 0.8 line height).
 */
function geom(d: UiDecoration, m: Mat, zoom: number) {
  const U = T.under;
  const [ux0, uy0] = apply(m, d.underline.x1, d.underline.y);
  const [ux1, uy1] = apply(m, d.underline.x2, d.underline.y);
  const l0 = Math.hypot(ux1 - ux0, uy1 - uy0);
  const ux = l0 > 0.01 ? (ux1 - ux0) / l0 : 1, uy = l0 > 0.01 ? (uy1 - uy0) / l0 : 0;
  const nx = -uy, ny = ux;
  const lineH = Math.max(8, (d.bbox[3] - d.bbox[1]) * zoom);
  // the token box in the line's frame: along = ux/uy, across = nx/ny (down)
  const c = [apply(m, d.bbox[0], d.bbox[1]), apply(m, d.bbox[2], d.bbox[1]), apply(m, d.bbox[2], d.bbox[3]), apply(m, d.bbox[0], d.bbox[3])];
  let a0 = Infinity, a1 = -Infinity, low = -Infinity;
  for (const [x, y] of c) {
    const along = (x - ux0) * ux + (y - uy0) * uy, across = (x - ux0) * nx + (y - uy0) * ny;
    a0 = Math.min(a0, along);
    a1 = Math.max(a1, along);
    low = Math.max(low, across);
  }
  // the engine's underline span if it is wider than the token box
  a0 = Math.min(a0, 0) - U.padPx;
  a1 = Math.max(a1, l0) + U.padPx;
  const minLen = Math.max(U.minPx, U.minPerLineH * lineH);
  if (a1 - a0 < minLen) {
    const grow = (minLen - (a1 - a0)) / 2;
    a0 -= grow;
    a1 += grow;
  }
  const off = Math.max(0, low + Math.max(U.gapPx, U.gapPerLineH * lineH));
  const ax = ux0 + ux * a0 + nx * off, ay = uy0 + uy * a0 + ny * off;
  const len = a1 - a0;
  return { ax, ay, bx: ax + ux * len, by: ay + uy * len, len, ux, uy, nx, ny, lineH };
}

/** Soft wave: amplitude breathes a little along the line, ends taper, baseline drifts a hair. */
export function wavePath(d: UiDecoration, m: Mat, zoom: number) {
  const W = T.wave;
  const g = geom(d, m, zoom);
  const r = rng(d.id);
  // amplitude 1.75 px and wavelength 6 px at 100%, with at least three full periods
  const A0 = clamp(W.ampAt100 * zoom, W.ampMin, W.ampMax);
  const lambda = Math.max(A0 * 2.4, Math.min(W.lambdaAt100 * zoom, g.len / W.minPeriods));
  const halves = Math.max(W.minPeriods * 2, Math.round(g.len / (lambda / 2)));
  const step = g.len / halves;
  const phase = r() * Math.PI * 2;
  const drift = (t: number) => A0 * W.drift * Math.sin(t * Math.PI * 1.3 + phase);
  const pt = (s: number, off: number): [number, number] => [g.ax + g.ux * s + g.nx * off, g.ay + g.uy * s + g.ny * off];
  let [x, y] = pt(0, drift(0));
  let p = `M${f(x)} ${f(y)}`;
  for (let k = 0; k < halves; k++) {
    const s0 = k * step, s1 = (k + 1) * step, sm = (s0 + s1) / 2;
    const taper = Math.min(1, (k + 0.6) / 1.6, (halves - k - 0.4) / 1.6);
    const amp = A0 * (1 - W.ampJitter * 0.6 + W.ampJitter * r()) * clamp(taper, 0.45, 1);
    const sign = k % 2 ? -1 : 1;
    // quadratic control at twice the peak height puts the crest at `amp`
    const [cx, cy] = pt(sm, drift(sm / g.len) + sign * amp * 2);
    [x, y] = pt(s1, drift(s1 / g.len));
    p += ` Q${f(cx)} ${f(cy)} ${f(x)} ${f(y)}`;
  }
  return { d: p, width: clamp(W.widthAt100 * zoom, W.widthMin, W.widthMax), len: g.len };
}

export function dottedPath(d: UiDecoration, m: Mat, zoom: number) {
  const g = geom(d, m, zoom);
  const D = T.dots;
  const width = clamp(D.widthAt100 * zoom, D.widthMin, D.widthMax);
  // confidence is in the spacing, not the opacity: surer = denser dots
  const conf = clamp(d.confidence ?? 1, 0, 1);
  return { d: `M${f(g.ax)} ${f(g.ay)} L${f(g.bx)} ${f(g.by)}`, width, gap: width * (D.gapMin + (D.gapMax - D.gapMin) * (1 - conf)) };
}

export function tickPath(d: UiDecoration, m: Mat, zoom: number) {
  // at the end of the line, vertically centred on the ink
  const [ex, ey] = apply(m, d.bbox[2], (d.bbox[1] + d.bbox[3]) / 2);
  const g = geom(d, m, zoom);
  const K = T.tick;
  const s = clamp(g.lineH * K.sizePerLineH, K.sizeMin, K.sizeMax);
  const x = ex + g.ux * (s * 0.6 + 4), y = ey + g.uy * (s * 0.6 + 4);
  const P = (a: number, b: number) => `${f(x + g.ux * a + g.nx * b)} ${f(y + g.uy * a + g.ny * b)}`;
  return { d: `M${P(-s * 0.48, -s * 0.02)} L${P(-s * 0.14, s * 0.32)} L${P(s * 0.5, -s * 0.38)}`, width: clamp(K.widthAt100 * Math.sqrt(zoom), 1.1, 2) };
}

/** Context a painter may need beyond the mark itself. */
export interface PaintCtx {
  m: Mat;
  zoom: number;
  isNew: boolean;
  /** pen colour and median stroke width (page units) of the ink under a box: ghost ink matches it */
  colorAt: (bbox: UiDecoration['bbox']) => string;
  widthAt: (bbox: UiDecoration['bbox']) => number;
  /** where a "+n" badge can sit next to a line without touching any ink (page units) */
  badgeAt: (bbox: UiDecoration['bbox']) => [number, number];
}

export type MarkPainter = (g: SVGGElement, d: UiDecoration, c: PaintCtx) => void;

const path = (g: SVGGElement, d: string, width: number, cls?: string) => {
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('stroke-width', f(width));
  if (cls) p.setAttribute('class', cls);
  g.append(p);
  return p;
};

/** Hairline focus ring around a mark's ink and its underline (shown with keyboard focus). */
function focusRing(g: SVGGElement, d: UiDecoration, m: Mat, zoom: number) {
  const c = [apply(m, d.bbox[0], d.bbox[1]), apply(m, d.bbox[2], d.bbox[3])];
  const w = geom(d, m, zoom);
  const amp = clamp(T.wave.ampAt100 * zoom, T.wave.ampMin, T.wave.ampMax);
  const x0 = Math.min(c[0][0], c[1][0], w.ax, w.bx) - 5, y0 = Math.min(c[0][1], c[1][1]) - 5;
  const x1 = Math.max(c[0][0], c[1][0], w.ax, w.bx) + 5, y1 = Math.max(c[0][1], c[1][1], w.ay + amp, w.by + amp) + 4;
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('class', 'gi-live-focus');
  r.setAttribute('x', f(x0));
  r.setAttribute('y', f(y0));
  r.setAttribute('width', f(x1 - x0));
  r.setAttribute('height', f(y1 - y0));
  r.setAttribute('rx', '6');
  g.append(r);
}

export const MARK_PAINTERS: Record<string, MarkPainter> = {
  error: (g, d, c) => {
    focusRing(g, d, c.m, c.zoom);
    const w = wavePath(d, c.m, c.zoom);
    path(g, w.d, w.width).setAttribute('pathLength', '1');
  },
  unsure: (g, d, c) => {
    focusRing(g, d, c.m, c.zoom);
    const w = dottedPath(d, c.m, c.zoom);
    path(g, w.d, w.width).setAttribute('stroke-dasharray', `0 ${f(w.gap)}`);
  },
  ok: (g, d, c) => {
    const w = tickPath(d, c.m, c.zoom);
    path(g, w.d, w.width);
  },
  fixed: (g, d, c) => {
    const w = tickPath(d, c.m, c.zoom);
    path(g, w.d, w.width * 1.15);
  },
  result: (g, d, c) => {
    const R = T.result;
    const lineH = d.bbox[3] - d.bbox[1];
    const text = ghostText(d.text ?? '');
    if (!text) return;
    // baseline-left just after the "=", in the line's frame (handles turned pages)
    const ox = d.bbox[2] + lineH * R.gapPerLineH, oy = d.bbox[3] - lineH * 0.04;
    const h = lineH * R.heightPerLineH;
    const color = c.colorAt(d.bbox);
    g.style.setProperty('--mk-ink', color);
    if (ghostable(text)) {
      const gp = ghostPaths(text, h, seedOf(d.id), (x, y) => apply(c.m, ox + x, oy + y));
      // drawn with the writer's own stroke width, so it reads as ink, not as a font
      const p = path(g, gp.d, clamp(c.widthAt(d.bbox) * c.zoom, 1, 6));
      p.setAttribute('pathLength', '1');
    } else {
      const [x, y] = apply(c.m, ox, oy);
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', f(x));
      t.setAttribute('y', f(y));
      t.setAttribute('font-size', f(h * c.zoom));
      t.textContent = text;
      g.append(t);
    }
  },
  more: (g, d, c) => {
    // an outlined margin note at the start of the hidden mark's own line, clear of all ink
    const [bx, by] = c.badgeAt(d.bbox);
    const [x, y] = apply(c.m, bx, by);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', f(x));
    circle.setAttribute('cy', f(y));
    circle.setAttribute('r', '8');
    g.append(circle);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', f(x));
    t.setAttribute('y', f(y));
    t.textContent = d.text ?? '';
    g.append(t);
  },
  ring: (g, d, c) => {
    const a = apply(c.m, d.bbox[0], d.bbox[1]), b = apply(c.m, d.bbox[2], d.bbox[3]);
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', f(Math.min(a[0], b[0]) - 8));
    r.setAttribute('y', f(Math.min(a[1], b[1]) - 8));
    r.setAttribute('width', f(Math.abs(b[0] - a[0]) + 16));
    r.setAttribute('height', f(Math.abs(b[1] - a[1]) + 16));
    r.setAttribute('rx', '8');
    g.append(r);
  },
};

const FOCUSABLE = new Set(['error', 'unsure', 'more']);

/**
 * Rebuild a page's mark layer. Ids seen before do not animate again (zoom and scroll rebuild the
 * layer often); `animate` is off with reduced motion.
 */
export function renderDecorations(svg: SVGSVGElement, decos: readonly UiDecoration[], c: Omit<PaintCtx, 'isNew'>, seen: Set<string>, animate: boolean) {
  const frag = document.createDocumentFragment();
  // keep keyboard focus on the same mark across a rebuild
  const focused = (svg.querySelector(':focus') as SVGGElement | null)?.dataset.id;
  for (const d of decos) {
    const paint = MARK_PAINTERS[d.kind];
    if (!paint) continue;
    const isNew = animate && !seen.has(d.id);
    seen.add(d.id);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `gi-live-mark is-${d.kind}${isNew ? ' is-new' : ''}${d.transient ? ' is-transient' : ''}`);
    g.dataset.id = d.id;
    if (FOCUSABLE.has(d.kind)) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', d.kind === 'more' ? `${d.text} more possible mistakes on this page` : `${d.kind === 'error' ? 'Possible mistake' : 'Unsure'}: ${d.title ?? 'open details'}. Press Enter for details.`);
    }
    paint(g, d, { ...c, isNew });
    frag.append(g);
  }
  svg.replaceChildren(frag);
  if (focused) (svg.querySelector(`[data-id="${CSS.escape(focused)}"]`) as SVGGElement | null)?.focus({ preventScroll: true });
}

/** Is a page point (in CSS px of the page element) on a mark? Returns the mark. */
export function hitDecoration(decos: readonly UiDecoration[], m: Mat, zoom: number, px: number, py: number): UiDecoration | null {
  let best: UiDecoration | null = null;
  let bestD = Infinity;
  for (const d of decos) {
    if (d.kind !== 'error' && d.kind !== 'unsure') continue;
    const g = geom(d, m, zoom);
    // distance along / across the underline, with a forgiving band that also covers the ink above
    const vx = px - g.ax, vy = py - g.ay;
    const along = vx * g.ux + vy * g.uy;
    const across = vx * g.nx + vy * g.ny;
    if (along < -6 || along > g.len + 6) continue;
    if (across > 9 || across < -Math.max(12, g.lineH + 4)) continue;
    const dist = Math.abs(across);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/** Where the hover tip points: the middle of the underline, in page-element CSS px. */
export function tipAnchor(d: UiDecoration, m: Mat, zoom: number) {
  const g = geom(d, m, zoom);
  return { x: (g.ax + g.bx) / 2, y: (g.ay + g.by) / 2 };
}
