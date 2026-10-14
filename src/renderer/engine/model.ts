// Runtime document model. Strokes and objects are immutable: every edit creates new objects, so
// undo history can hold cheap references to previous arrays and render caches can key on identity.
import type { ImageObject, PageJSON, PageObject, PenKind, StrokeJSON, StrokeKind, TextObject } from '../../shared/types';
import { apply, bboxOfPoints, det, type BBox, type Mat, cornersBBox, rectCorners } from './geometry';

export interface Stroke {
  readonly id: string;
  readonly kind: StrokeKind;
  readonly pen?: PenKind;
  readonly color: string;
  readonly width: number;
  /** x, y, pressure triples in page units */
  readonly pts: Float32Array;
  readonly bbox: BBox;
  readonly shape?: boolean;
  readonly closed?: boolean;
  readonly revealed?: boolean;
}

export interface PageContent {
  readonly strokes: readonly Stroke[];
  readonly objects: readonly PageObject[];
}

export const EMPTY_CONTENT: PageContent = { strokes: [], objects: [] };

export function makeStroke(s: Omit<Stroke, 'bbox'>): Stroke {
  const b = bboxOfPoints(s.pts);
  const pad = s.kind === 'tape' ? s.width / 2 : s.kind === 'pen' && !s.shape ? s.width * 1.1 : s.width;
  return { ...s, bbox: [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] };
}

// ---- (de)serialisation --------------------------------------------------------------------------

function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

function b64ToF32(b64: string): Float32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function strokeToJSON(s: Stroke): StrokeJSON {
  const j: StrokeJSON = { id: s.id, k: s.kind, c: s.color, w: s.width, pts: f32ToB64(s.pts) };
  if (s.pen) j.pen = s.pen;
  if (s.shape) j.shape = 1;
  if (s.closed) j.closed = 1;
  if (s.revealed) j.rev = 1;
  return j;
}

export function strokeFromJSON(j: StrokeJSON): Stroke {
  return makeStroke({ id: j.id, kind: j.k, pen: j.pen, color: j.c, width: j.w, pts: b64ToF32(j.pts), shape: !!j.shape, closed: !!j.closed, revealed: !!j.rev });
}

export function contentToJSON(c: PageContent): PageJSON {
  return { v: 1, strokes: c.strokes.map(strokeToJSON), objects: c.objects as PageObject[] };
}

export function contentFromJSON(j: PageJSON | null): PageContent {
  if (!j) return EMPTY_CONTENT;
  return { strokes: j.strokes.map(strokeFromJSON), objects: j.objects ?? [] };
}

// ---- transforms ---------------------------------------------------------------------------------

export function transformStroke(s: Stroke, m: Mat, newId?: string): Stroke {
  const pts = new Float32Array(s.pts.length);
  for (let i = 0; i < s.pts.length; i += 3) {
    const [x, y] = apply(m, s.pts[i], s.pts[i + 1]);
    pts[i] = x;
    pts[i + 1] = y;
    pts[i + 2] = s.pts[i + 2];
  }
  const k = Math.sqrt(Math.abs(det(m)));
  return makeStroke({ ...s, id: newId ?? s.id, pts, width: Math.max(0.2, s.width * k) });
}

/** Objects store x,y,w,h,rot. Apply an affine (translate/uniform-ish scale/rotate) to them. */
export function transformObject<T extends PageObject>(o: T, m: Mat, newId?: string): T {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const [ncx, ncy] = apply(m, cx, cy);
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const rot = o.rot + Math.atan2(m[1], m[0]);
  const w = o.w * sx, h = o.h * sy;
  const out: any = { ...o, id: newId ?? o.id, x: ncx - w / 2, y: ncy - h / 2, w, h, rot };
  if (o.type === 'text') out.size = Math.max(4, (o as TextObject).size * Math.sqrt(sx * sy));
  return out as T;
}

export function objectBBox(o: PageObject): BBox {
  return cornersBBox(rectCorners(o.x, o.y, o.w, o.h, o.rot));
}

export function recolorStroke(s: Stroke, color: string): Stroke {
  return { ...s, color };
}

export function isImage(o: PageObject): o is ImageObject {
  return o.type === 'image';
}
