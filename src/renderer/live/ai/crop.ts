// A tight, small image of one line for the AI judge: only that line's pen ink, black on white
// (grayscale content), scaled so the x-height is about 24 px, 12 px padding, long edge <= 1000 px.
// PNG: two-tone ink compresses to a few KB and stays sharp (tokens depend on pixels, not bytes).
// All numbers are in POLICY.crop.
import type { BBox, Stroke } from '../contract';
import { drawStroke } from '../../engine/ink';
import type { CropImage } from './check';
import { POLICY } from './policy';

export interface CropOpts {
  /** median height of the handwritten line(s) in page units */
  lineHeight: number;
  /** target x-height in output px */
  xHeightPx?: number;
  /** long edge cap in output px */
  maxLong?: number;
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** Size and scale of the crop for a box of ink (pure, testable). */
export function cropGeometry(bbox: BBox, o: CropOpts) {
  const P = POLICY.crop;
  const lh = Math.max(4, o.lineHeight);
  const bw = Math.max(1, bbox[2] - bbox[0]), bh = Math.max(1, bbox[3] - bbox[1]);
  const maxLong = o.maxLong ?? P.maxLong;
  let s = Math.min(P.maxScale, Math.max(P.minScale, (o.xHeightPx ?? P.xHeightPx) / (lh * P.xHeightRatio)));
  // a long line: keep the long edge within the cap (the x-height then shrinks a little)
  s = Math.min(s, (maxLong - 2 * P.padPx) / Math.max(bw, bh));
  const pad = P.padPx / s;
  return { x0: bbox[0] - pad, y0: bbox[1] - pad, s, pw: Math.max(16, Math.round(bw * s + 2 * P.padPx)), ph: Math.max(16, Math.round(bh * s + 2 * P.padPx)) };
}

export async function cropBlockImage(strokes: readonly Stroke[], bbox: BBox, o: CropOpts): Promise<CropImage> {
  const g = cropGeometry(bbox, o);
  const canvas = new OffscreenCanvas(g.pw, g.ph);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, g.pw, g.ph);
  ctx.setTransform(g.s, 0, 0, g.s, -g.x0 * g.s, -g.y0 * g.s);
  const x1 = g.x0 + g.pw / g.s, y1 = g.y0 + g.ph / g.s;
  for (const st of strokes) {
    if (st.kind !== 'pen') continue;
    const b = st.bbox;
    if (b[2] < g.x0 || b[0] > x1 || b[3] < g.y0 || b[1] > y1) continue;
    // thin pens get a minimum width so that small crops stay legible
    drawStroke(ctx, { ...st, color: '#000000', width: Math.max(st.width, POLICY.crop.minStrokePx / g.s) });
  }
  const mime = POLICY.crop.format;
  const blob = await canvas.convertToBlob(mime === 'image/jpeg' ? { type: mime, quality: 0.85 } : { type: mime });
  return { mime, data: b64(new Uint8Array(await blob.arrayBuffer())), w: g.pw, h: g.ph };
}
