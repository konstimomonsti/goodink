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

/** Screen geometry of a mark: start/end of the underline in CSS px, unit direction, normal, line height. */
function geom(d: UiDecoration, m: Mat, zoom: number) {
  let [ax, ay] = apply(m, d.underline.x1, d.underline.y);
  let [bx, by] = apply(m, d.underline.x2, d.underline.y);
  let len = Math.hypot(bx - ax, by - ay);
  const ux = len > 0.01 ? (bx - ax) / len : 1, uy = len > 0.01 ? (by - ay) / len : 0;
  if (len < T.minMarkPx) {
    // a mark under a single thin symbol still gets a readable width
    const grow = (T.minMarkPx - len) / 2;
    ax -= ux * grow;
    ay -= uy * grow;
    bx += ux * grow;
    by += uy * grow;
    len = T.minMarkPx;
  }
  const lineH = Math.max(6, (d.bbox[3] - d.bbox[1]) * zoom);
  return { ax, ay, bx, by, len, ux, uy, nx: -uy, ny: ux, lineH };
}

/** Soft wave: amplitude breathes a little along the line, ends taper, baseline drifts a hair. */
export function wavePath(d: UiDecoration, m: Mat, zoom: number) {
  const W = T.wave;
  const g = geom(d, m, zoom);
  const r = rng(d.id);
  const A0 = clamp(g.lineH * W.ampPerLineH, W.ampMin, W.ampMax);
  const lambda = clamp(A0 * W.lambdaPerAmp, W.lambdaMin, W.lambdaMax);
  const halves = Math.max(2, Math.round(g.len / (lambda / 2)));
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
  return { d: `M${f(g.ax)} ${f(g.ay)} L${f(g.bx)} ${f(g.by)}`, width, gap: width * D.gapPerWidth };
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
  /** pen colour of the ink under a box (ghost-ink results are written in it) */
  colorAt: (bbox: UiDecoration['bbox']) => string;
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

/** Hairline focus ring around a mark's ink (shown when the mark has keyboard focus). */
function focusRing(g: SVGGElement, d: UiDecoration, m: Mat) {
  const c = [apply(m, d.bbox[0], d.bbox[1]), apply(m, d.bbox[2], d.bbox[3])];
  const x = Math.min(c[0][0], c[1][0]) - 5, y = Math.min(c[0][1], c[1][1]) - 5;
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('class', 'gi-live-focus');
  r.setAttribute('x', f(x));
  r.setAttribute('y', f(y));
  r.setAttribute('width', f(Math.abs(c[1][0] - c[0][0]) + 10));
  r.setAttribute('height', f(Math.abs(c[1][1] - c[0][1]) + 14));
  r.setAttribute('rx', '6');
  g.append(r);
}

export const MARK_PAINTERS: Record<string, MarkPainter> = {
  error: (g, d, c) => {
    focusRing(g, d, c.m);
    const w = wavePath(d, c.m, c.zoom);
    path(g, w.d, w.width).setAttribute('pathLength', '1');
  },
  unsure: (g, d, c) => {
    focusRing(g, d, c.m);
    const w = dottedPath(d, c.m, c.zoom);
    path(g, w.d, w.width).setAttribute('stroke-dasharray', `0 ${f(w.gap)}`);
    const conf = clamp(d.confidence ?? 1, 0, 1);
    g.style.setProperty('--mk-o', f(T.dots.opacity * (T.dots.minOpacityFactor + (1 - T.dots.minOpacityFactor) * conf)));
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
      const p = path(g, gp.d, clamp(lineH * R.widthPerLineH * c.zoom, 1.2, 4.5));
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
    // a small red badge in the margin, level with the first hidden mark
    const [x, y] = apply(c.m, d.underline.x1, (d.bbox[1] + d.bbox[3]) / 2);
    const cx = Math.max(12, x);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', f(cx));
    circle.setAttribute('cy', f(y));
    circle.setAttribute('r', '9');
    g.append(circle);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', f(cx));
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
