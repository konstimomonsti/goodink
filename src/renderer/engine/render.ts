// Page compositing shared by the live editor layers, thumbnails, PNG export and presentation.
import type { PageMeta, PageObject, PdfObject, TextObject } from '../../shared/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { mul, type Mat } from './geometry';
import { cachedPrims, drawPrims, worldPrims, PAPER } from './templates';
import { drawStroke } from './ink';
import type { PageContent, Stroke } from './model';
import { anyCachedPage, hasPreview, loadPreview, renderPdfPage, renderPdfRegion } from './pdf';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Sources {
  pdf(assetId: string): Promise<PDFDocumentProxy>;
  /** a second engine instance for small previews, so they never wait behind sharp renders */
  previewPdf?(assetId: string): Promise<PDFDocumentProxy>;
  pdfKey(assetId: string): string;
  image(src: string): CanvasImageSource | null; // sync, null while loading
  loadImage(src: string): Promise<CanvasImageSource | null>;
}

export function displaySize(p: PageMeta) {
  return p.rotation === 90 || p.rotation === 270 ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** Page units → displayed pixels for scale s (px per pt), including page rotation. */
export function pageMatrix(p: PageMeta, s: number): Mat {
  const rot = rotationMatrix(p, s);
  return p.ox || p.oy ? mul(rot, [1, 0, 0, 1, -(p.ox ?? 0), -(p.oy ?? 0)]) : rot;
}

function rotationMatrix(p: PageMeta, s: number): Mat {
  switch (p.rotation) {
    case 90:
      return [0, s, -s, 0, p.h * s, 0];
    case 180:
      return [-s, 0, 0, -s, p.w * s, p.h * s];
    case 270:
      return [0, -s, s, 0, 0, p.w * s];
    default:
      return [s, 0, 0, s, 0, 0];
  }
}

/** `base` (optional) is applied after the page transform, e.g. to offset a partial-page canvas. */
export function setPageTransform(ctx: Ctx, p: PageMeta, s: number, base?: Mat) {
  const m = base ? mul(base, pageMatrix(p, s)) : pageMatrix(p, s);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

/** Paper colour + template, or the PDF/image background. Returns false if the PDF is still loading. */
export type PageRect = { x: number; y: number; w: number; h: number };

export function drawBackground(ctx: Ctx, p: PageMeta, s: number, src: Sources, pdfBmp?: ImageBitmap | null, base?: Mat, pdfRect?: PageRect, clip?: PageRect): boolean {
  setPageTransform(ctx, p, s, base);
  const paper = PAPER[p.template.paper];
  ctx.fillStyle = p.bg ? '#ffffff' : paper.bg;
  ctx.fillRect(p.ox ?? 0, p.oy ?? 0, p.w, p.h);
  let complete = true;
  if (p.bg?.type === 'pdf') {
    if (pdfBmp && pdfRect) ctx.drawImage(pdfBmp, pdfRect.x, pdfRect.y, pdfRect.w, pdfRect.h);
    else {
      const bmp = pdfBmp ?? anyCachedPage(src.pdfKey(p.bg.asset), p.bg.page);
      if (bmp) ctx.drawImage(bmp, 0, 0, p.w, p.h);
      else complete = false;
    }
  } else if (p.bg?.type === 'image') {
    const img = src.image(`asset:${p.bg.asset}`);
    if (img) ctx.drawImage(img, 0, 0, p.w, p.h);
    else complete = false;
  }
  if (p.infinite) {
    const r = clip ?? { x: p.ox ?? 0, y: p.oy ?? 0, w: p.w, h: p.h };
    drawPrims(ctx, worldPrims(p.template, r.x, r.y, r.x + r.w, r.y + r.h, clip ? 400_000 : 60_000));
  } else if (!p.bg || p.template.kind !== 'blank') drawPrims(ctx, cachedPrims(p.template, p.w, p.h), clip ? [clip.x, clip.y, clip.x + clip.w, clip.y + clip.h] : undefined);
  return complete;
}

export async function loadPdfBackground(p: PageMeta, s: number, src: Sources): Promise<ImageBitmap | null> {
  if (p.bg?.type !== 'pdf') return null;
  const doc = await src.pdf(p.bg.asset);
  return renderPdfPage(doc, src.pdfKey(p.bg.asset), p.bg.page, s);
}

/** Make sure the small preview of a PDF page exists (instant placeholder while scrolling). */
export async function ensurePdfPreview(p: PageMeta, src: Sources): Promise<boolean> {
  if (p.bg?.type !== 'pdf') return false;
  const key = src.pdfKey(p.bg.asset);
  if (hasPreview(key, p.bg.page)) return false;
  await loadPreview(await (src.previewPdf ?? src.pdf).call(src, p.bg.asset), key, p.bg.page);
  return true;
}

/** Render just part of a PDF page (page units) at scale s — used when zoomed far in. */
export async function loadPdfRegion(p: PageMeta, s: number, r: PageRect, src: Sources): Promise<ImageBitmap | null> {
  if (p.bg?.type !== 'pdf') return null;
  const doc = await src.pdf(p.bg.asset);
  return renderPdfRegion(doc, p.bg.page, s, r);
}

function withRotation(ctx: Ctx, o: PageObject, fn: () => void) {
  ctx.save();
  if (o.rot) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(o.rot);
    ctx.translate(-cx, -cy);
  }
  fn();
  ctx.restore();
}

export function drawImages(ctx: Ctx, objects: readonly PageObject[], src: Sources, exclude?: Set<string>): boolean {
  let complete = true;
  for (const o of objects) {
    if (o.type !== 'image' || exclude?.has(o.id)) continue;
    const img = src.image(o.src);
    if (!img) {
      complete = false;
      continue;
    }
    withRotation(ctx, o, () => ctx.drawImage(img, o.x, o.y, o.w, o.h));
  }
  return complete;
}

/**
 * PDF pages placed on a page. Draws the sharpest bitmap already rendered and asks for a sharper one
 * when needed (`want` is called with the work; repaint when it resolves). Returns false while any
 * PDF object is still missing.
 */
/** Resolution a placed PDF needs at pxPerPt (capped so one page raster stays below 16 Mpx). */
function pdfObjectScale(o: PdfObject, pxPerPt: number) {
  return Math.min(pxPerPt * (o.w / o.pw), Math.sqrt(16_000_000 / (o.pw * o.ph)));
}

/**
 * Render every placed PDF in `region` at the sharpness pxPerPt needs, all in parallel. The viewport
 * waits for this before it swaps in a new zoom level, so a placed PDF never shows as an empty box.
 */
export async function preparePdfObjects(objects: readonly PageObject[], src: Sources, pxPerPt: number, region?: PageRect): Promise<Map<string, ImageBitmap>> {
  // The rasters are returned to the caller and held by the page itself: a shared cache could
  // evict them before the swap (many placed PDFs at once), which would show empty boxes.
  const held = new Map<string, ImageBitmap>();
  const jobs: Promise<unknown>[] = [];
  for (const o of objects) {
    if (o.type !== 'pdf') continue;
    if (region && (o.x + o.w < region.x || o.x > region.x + region.w || o.y + o.h < region.y || o.y > region.y + region.h)) continue;
    const need = pdfObjectScale(o, pxPerPt);
    const key = src.pdfKey(o.asset);
    const have = anyCachedPage(key, o.page);
    if (have && have.width >= o.pw * need * 0.85) {
      held.set(o.id, have);
      continue;
    }
    jobs.push(
      src
        .pdf(o.asset)
        .then((doc) => renderPdfPage(doc, key, o.page, need))
        .then((b) => b && held.set(o.id, b))
        .catch(() => null),
    );
  }
  await Promise.all(jobs);
  return held;
}

/** Small previews of placed PDFs, so they show content instantly at any zoom. */
export async function ensureObjectPreviews(objects: readonly PageObject[], src: Sources): Promise<boolean> {
  let made = false;
  for (const o of objects) {
    if (o.type !== 'pdf') continue;
    const key = src.pdfKey(o.asset);
    if (hasPreview(key, o.page)) continue;
    await loadPreview(await (src.previewPdf ?? src.pdf).call(src, o.asset), key, o.page);
    made = true;
  }
  return made;
}

export function drawPdfObjects(ctx: Ctx, objects: readonly PageObject[], src: Sources, pxPerPt: number, exclude?: Set<string>, want?: (job: Promise<unknown>) => void, held?: Map<string, ImageBitmap>, clip?: PageRect): boolean {
  let complete = true;
  for (const o of objects) {
    if (o.type !== 'pdf' || exclude?.has(o.id)) continue;
    // only what the canvas actually covers (an infinite canvas can hold dozens of PDFs)
    if (clip && (o.x + o.w < clip.x || o.x > clip.x + clip.w || o.y + o.h < clip.y || o.y > clip.y + clip.h)) continue;
    const key = src.pdfKey(o.asset);
    const bmp = held?.get(o.id) ?? anyCachedPage(key, o.page);
    const need = pdfObjectScale(o, pxPerPt);
    if (want && (!bmp || bmp.width < o.pw * need * 0.85)) want(src.pdf(o.asset).then((doc) => renderPdfPage(doc, key, o.page, need)));
    withRotation(ctx, o, () => {
      if (bmp) ctx.drawImage(bmp, o.x, o.y, o.w, o.h);
      else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(o.x, o.y, o.w, o.h);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = Math.max(0.5, 1 / Math.max(0.01, pxPerPt));
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    });
    if (!bmp) complete = false;
  }
  return complete;
}

export const TEXT_FONTS: { id: string; label: string; css: string }[] = [
  { id: 'sans', label: 'Segoe UI', css: '"Segoe UI Variable Text", "Segoe UI", sans-serif' },
  { id: 'arial', label: 'Arial', css: 'Arial, "Segoe UI", sans-serif' },
  { id: 'calibri', label: 'Calibri', css: 'Calibri, Carlito, "Segoe UI", sans-serif' },
  { id: 'verdana', label: 'Verdana', css: 'Verdana, "Segoe UI", sans-serif' },
  { id: 'serif', label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { id: 'times', label: 'Times New Roman', css: '"Times New Roman", Times, serif' },
  { id: 'cambria', label: 'Cambria', css: 'Cambria, Georgia, serif' },
  { id: 'mono', label: 'Cascadia Code', css: '"Cascadia Code", Consolas, monospace' },
  { id: 'hand', label: 'Handwriting', css: '"Segoe Print", "Ink Free", cursive' },
  { id: 'round', label: 'Comic Sans', css: '"Comic Sans MS", "Segoe UI", sans-serif' },
];

/** Families the PDF export maps a font to (built-in PDF fonts). */
export const pdfFamily = (font: string): 'sans' | 'serif' | 'mono' => (font === 'serif' || font === 'times' || font === 'cambria' ? 'serif' : font === 'mono' ? 'mono' : 'sans');

export const fontCss = (o: Pick<TextObject, 'font' | 'size' | 'bold' | 'italic'>) =>
  `${o.italic ? 'italic ' : ''}${o.bold ? 700 : 400} ${o.size}px ${(TEXT_FONTS.find((f) => f.id === o.font) ?? TEXT_FONTS[0]).css}`;

export const LINE_HEIGHT = 1.3;

/** Distance between two lines of a text box. */
export const lineStep = (o: Pick<TextObject, 'size' | 'lineHeight'>) => o.size * (o.lineHeight ?? LINE_HEIGHT);
/** Where the glyphs of line i start (CSS centres them in their line box, so the editor and canvas agree). */
export const lineTop = (o: Pick<TextObject, 'y' | 'size' | 'lineHeight'>, i: number) => o.y + 2 + i * lineStep(o) + (lineStep(o) - o.size * LINE_HEIGHT) / 2;

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

export function wrapText(o: TextObject): string[] {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')!;
  measureCtx.font = fontCss(o);
  const out: string[] = [];
  for (const para of o.text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && measureCtx.measureText(test).width > o.w - 4) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

export function textHeight(o: TextObject) {
  return Math.max(lineStep(o), wrapText(o).length * lineStep(o)) + 4;
}

export function drawTexts(ctx: Ctx, objects: readonly PageObject[], exclude?: Set<string>) {
  for (const o of objects) {
    if (o.type !== 'text' || exclude?.has(o.id)) continue;
    withRotation(ctx, o, () => {
      if (o.bgColor) {
        ctx.fillStyle = o.bgColor;
        ctx.beginPath();
        ctx.roundRect(o.x - 2, o.y - 2, o.w + 4, o.h + 4, 3);
        ctx.fill();
      }
      ctx.font = fontCss(o);
      ctx.fillStyle = o.color;
      ctx.textBaseline = 'top';
      ctx.textAlign = o.align;
      const x = o.align === 'left' ? o.x + 2 : o.align === 'center' ? o.x + o.w / 2 : o.x + o.w - 2;
      const deco = o.underline || o.strike;
      wrapText(o).forEach((line, i) => {
        const top = lineTop(o, i) + o.size * 0.08;
        ctx.fillText(line, x, top);
        if (!deco || !line) return;
        const lw = ctx.measureText(line).width;
        const lx = o.align === 'left' ? x : o.align === 'center' ? x - lw / 2 : x - lw;
        const t = Math.max(0.8, o.size / 14);
        if (o.underline) ctx.fillRect(lx, top + o.size * 0.9, lw, t);
        if (o.strike) ctx.fillRect(lx, top + o.size * 0.52, lw, t);
      });
    });
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export function drawInk(ctx: Ctx, strokes: readonly Stroke[], exclude?: Set<string>) {
  for (const s of strokes) if (s.kind === 'pen' && !exclude?.has(s.id)) drawStroke(ctx, s);
}

export function drawHighlights(ctx: Ctx, strokes: readonly Stroke[], blend: boolean, exclude?: Set<string>) {
  for (const s of strokes) if (s.kind === 'highlighter' && !exclude?.has(s.id)) drawStroke(ctx, s, { highlightBlend: blend });
}

export function drawTape(ctx: Ctx, strokes: readonly Stroke[], exclude?: Set<string>) {
  for (const s of strokes) if (s.kind === 'tape' && !exclude?.has(s.id)) drawStroke(ctx, s);
}

/** Everything on one context, in z-order. Used for thumbnails, PNG export and presentation. */
export async function renderPageFlat(ctx: Ctx, p: PageMeta, c: PageContent, s: number, src: Sources, opts: { hideTape?: boolean } = {}) {
  const bmp = await loadPdfBackground(p, s, src).catch(() => null);
  if (p.bg?.type === 'image') await src.loadImage(`asset:${p.bg.asset}`);
  await Promise.all(c.objects.filter((o) => o.type === 'image').map((o) => src.loadImage((o as any).src)));
  const jobs: Promise<unknown>[] = [];
  drawPdfObjects(new OffscreenCanvas(1, 1).getContext('2d')!, c.objects, src, s, undefined, (j) => jobs.push(j));
  await Promise.all(jobs).catch(() => undefined);
  drawBackground(ctx, p, s, src, bmp);
  setPageTransform(ctx, p, s);
  drawImages(ctx, c.objects, src);
  drawPdfObjects(ctx, c.objects, src, s);
  ctx.save();
  if (!p.bg && p.template.paper !== 'dark') ctx.globalCompositeOperation = 'multiply';
  for (const st of c.strokes) if (st.kind === 'highlighter') drawStroke(ctx, st);
  ctx.restore();
  drawInk(ctx, c.strokes);
  drawTexts(ctx, c.objects);
  if (!opts.hideTape) drawTape(ctx, c.strokes);
}

export async function renderPageToCanvas(p: PageMeta, c: PageContent, widthPx: number, src: Sources, opts: { hideTape?: boolean } = {}): Promise<OffscreenCanvas> {
  const d = displaySize(p);
  const s = widthPx / d.w;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(d.w * s)), Math.max(1, Math.round(d.h * s)));
  const ctx = canvas.getContext('2d')!;
  await renderPageFlat(ctx, p, c, s, src, opts);
  return canvas;
}
