// Stroke geometry and drawing. Pen strokes are drawn along their centre line as runs of
// round-capped segments whose width follows pressure. Unlike a filled outline, this can never
// self-fill when the pen loops back over itself (the bowl of a "b", an "e", a spiral).
// Highlighters, shapes and tape are constant-width polylines.
import type { PenKind } from '../../shared/types';
import type { Stroke } from './model';

/** Width multiplier for a pressure value, per pen. */
const PEN_CURVE: Record<PenKind, (p: number) => number> = {
  ball: (p) => 0.86 + 0.28 * p,
  fountain: (p) => 0.38 + 1.25 * p,
  brush: (p) => 0.18 + 1.9 * Math.pow(p, 1.15),
};

/** Max width multiplier for each pen (used for bounding boxes and hit tests). */
export const PEN_MAX = 2.1;

export interface PenRun {
  w: number;
  pts: number[]; // x,y pairs, smoothed centre line for this run
}

function smoothCentre(src: Float32Array): { x: number[]; y: number[]; p: number[] } {
  const n = src.length / 3;
  const x = new Array<number>(n), y = new Array<number>(n), p = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    x[i] = src[i * 3];
    y[i] = src[i * 3 + 1];
    p[i] = src[i * 3 + 2];
  }
  if (n < 4) return { x, y, p };
  // one light 1-2-1 pass removes digitiser jitter without rounding corners away
  const sx = x.slice(), sy = y.slice(), sp = p.slice();
  for (let i = 1; i < n - 1; i++) {
    sx[i] = (x[i - 1] + 2 * x[i] + x[i + 1]) / 4;
    sy[i] = (y[i - 1] + 2 * y[i] + y[i + 1]) / 4;
    sp[i] = (p[i - 1] + 2 * p[i] + p[i + 1]) / 4;
  }
  return { x: sx, y: sy, p: sp };
}

/** Centre line split into runs of (quantised) equal width. */
export function penRuns(s: Pick<Stroke, 'pts' | 'pen' | 'width'>): PenRun[] {
  const { x, y, p } = smoothCentre(s.pts);
  const n = x.length;
  const curve = PEN_CURVE[s.pen ?? 'ball'];
  const base = s.width;
  if (n === 0) return [];
  if (n === 1) return [{ w: base * curve(p[0]), pts: [x[0], y[0], x[0] + 0.01, y[0]] }];
  // arc length for end tapers
  const len = [0];
  for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
  const total = len[n - 1] || 1;
  // Only the brush tapers, and only where the stroke starts: the end of a stroke is wherever
  // the pen is right now, so tapering it makes the live tip look thin and behind the pen.
  const taper = s.pen === 'brush' ? Math.min(total * 0.18, base * 6) : 0;
  const widthAt = (i: number) => {
    let w = base * curve(p[i]);
    if (taper > 0 && len[i] < taper) w *= 0.35 + 0.65 * Math.sin(((len[i] / taper) * Math.PI) / 2);
    return w;
  };
  const step = Math.max(0.04, base * 0.06); // quantisation step in page units
  const runs: PenRun[] = [];
  let cur: PenRun | null = null;
  for (let i = 1; i < n; i++) {
    const w = Math.max(0.15, Math.round(((widthAt(i - 1) + widthAt(i)) / 2) / step) * step);
    if (!cur || Math.abs(cur.w - w) > 1e-6) {
      cur = { w, pts: [x[i - 1], y[i - 1]] };
      runs.push(cur);
    }
    cur.pts.push(x[i], y[i]);
  }
  return runs;
}

function runPath(r: PenRun): Path2D {
  const p = new Path2D();
  const a = r.pts;
  p.moveTo(a[0], a[1]);
  if (a.length === 4) {
    p.lineTo(a[2], a[3]);
    return p;
  }
  // quadratic through midpoints keeps the line smooth between samples
  for (let i = 2; i < a.length - 2; i += 2) p.quadraticCurveTo(a[i], a[i + 1], (a[i] + a[i + 2]) / 2, (a[i + 1] + a[i + 3]) / 2);
  p.lineTo(a[a.length - 2], a[a.length - 1]);
  return p;
}

export function runSvg(r: PenRun): string {
  const f = (v: number) => v.toFixed(2);
  const a = r.pts;
  let d = `M${f(a[0])} ${f(a[1])}`;
  for (let i = 2; i < a.length - 2; i += 2) d += `Q${f(a[i])} ${f(a[i + 1])} ${f((a[i] + a[i + 2]) / 2)} ${f((a[i + 1] + a[i + 3]) / 2)}`;
  return d + `L${f(a[a.length - 2])} ${f(a[a.length - 1])}`;
}

export function polylineSvg(pts: Float32Array, closed?: boolean): string {
  let d = '';
  for (let i = 0; i < pts.length; i += 3) d += `${i ? 'L' : 'M'}${pts[i].toFixed(2)} ${pts[i + 1].toFixed(2)}`;
  return closed ? d + 'Z' : d;
}

function polylinePath(pts: Float32Array, closed?: boolean): Path2D {
  const p = new Path2D();
  for (let i = 0; i < pts.length; i += 3) (i ? p.lineTo : p.moveTo).call(p, pts[i], pts[i + 1]);
  if (closed) p.closePath();
  return p;
}

const pathCache = new WeakMap<Stroke, Path2D>();
const runCache = new WeakMap<Stroke, { w: number; path: Path2D }[]>();

export function pathOf(s: Stroke): Path2D {
  let p = pathCache.get(s);
  if (!p) {
    p = polylinePath(s.pts, s.closed);
    pathCache.set(s, p);
  }
  return p;
}

function penPaths(s: Stroke): { w: number; path: Path2D }[] {
  let r = runCache.get(s);
  if (!r) {
    r = penRuns(s).map((run) => ({ w: run.w, path: runPath(run) }));
    runCache.set(s, r);
  }
  return r;
}

export const HIGHLIGHT_ALPHA = 0.42;

let tapePattern: CanvasPattern | null = null;
function tapeFill(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, color: string) {
  // Diagonal stripes so tape reads as a physical strip, not as a highlighter.
  const c = new OffscreenCanvas(12, 12);
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 12, 12);
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(-3, 15);
  g.lineTo(15, -3);
  g.moveTo(-3, 3);
  g.lineTo(3, -3);
  g.moveTo(9, 15);
  g.lineTo(15, 9);
  g.stroke();
  tapePattern = ctx.createPattern(c, 'repeat');
  return tapePattern ?? color;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draw one stroke. The context transform must already map page units to pixels. */
export function drawStroke(ctx: Ctx, s: Stroke, opts: { highlightBlend?: boolean; alpha?: number } = {}) {
  ctx.save();
  if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
  ctx.strokeStyle = s.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (s.kind === 'pen') {
    if (s.shape) {
      ctx.lineWidth = s.width;
      ctx.stroke(pathOf(s));
    } else {
      for (const r of penPaths(s)) {
        ctx.lineWidth = r.w;
        ctx.stroke(r.path);
      }
    }
  } else if (s.kind === 'highlighter') {
    // On the highlighter layer we draw opaque and let the layer's multiply blend do the rest.
    ctx.globalAlpha *= opts.highlightBlend ? 1 : HIGHLIGHT_ALPHA;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = s.shape ? 'butt' : 'round';
    ctx.stroke(pathOf(s));
  } else {
    ctx.lineWidth = s.width;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    if (s.revealed) {
      ctx.globalAlpha *= 0.22;
      ctx.strokeStyle = s.color;
      ctx.stroke(pathOf(s));
    } else {
      const m = ctx.getTransform();
      ctx.strokeStyle = tapeFill(ctx, s.color);
      if (tapePattern) tapePattern.setTransform(new DOMMatrix().scale(1 / Math.max(0.2, m.a / 2)));
      ctx.stroke(pathOf(s));
    }
  }
  ctx.restore();
}

/** Simulated pressure for mice: slower = heavier, like ink pooling. */
export function velocityPressure(prev: { x: number; y: number; t: number } | null, x: number, y: number, t: number, prevP: number): number {
  if (!prev) return 0.5;
  const dt = Math.max(1, t - prev.t);
  const v = Math.hypot(x - prev.x, y - prev.y) / dt; // page units per ms
  const target = Math.max(0.2, Math.min(0.75, 0.75 - v * 0.35));
  return prevP + (target - prevP) * 0.3;
}

export function curvePressure(p: number): number {
  return Math.pow(Math.max(0.02, Math.min(1, p)), 0.85);
}
