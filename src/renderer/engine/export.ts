// Export: PDF with ink as vector paths (original PDF pages are copied, not rasterised),
// PNG per page, and page images for printing.
import { PDFDocument, rgb, StandardFonts, degrees, BlendMode, type PDFPage, type PDFFont, LineCapStyle } from 'pdf-lib';
import type { PageMeta, TextObject, ImageObject } from '../../shared/types';
import { penRuns, runSvg, polylineSvg, HIGHLIGHT_ALPHA } from './ink';
import { cachedPrims, worldPrims, PAPER } from './templates';
import { renderPageToCanvas, wrapText, lineTop, pdfFamily } from './render';
import type { NotebookSession } from './session';
import { canvasToPng } from '../lib/util';

function hexRgb(hex: string) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export interface ExportOptions {
  pages: number[]; // indices
  includeAnnotations: boolean;
  includeTemplates: boolean;
  onProgress?(done: number, total: number): void;
}

export async function exportPdf(session: NotebookSession, opts: ExportOptions): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle(session.meta.title);
  out.setCreator('goodink');
  out.setProducer('goodink');
  const fonts: Record<string, PDFFont> = {};
  const font = async (o: TextObject) => {
    const fam = pdfFamily(o.font);
    const key = `${fam}${o.bold ? 'B' : ''}${o.italic ? 'I' : ''}`;
    const map: Record<string, StandardFonts> = {
      sans: StandardFonts.Helvetica, sansB: StandardFonts.HelveticaBold, sansI: StandardFonts.HelveticaOblique, sansBI: StandardFonts.HelveticaBoldOblique,
      serif: StandardFonts.TimesRoman, serifB: StandardFonts.TimesRomanBold, serifI: StandardFonts.TimesRomanItalic, serifBI: StandardFonts.TimesRomanBoldItalic,
      mono: StandardFonts.Courier, monoB: StandardFonts.CourierBold, monoI: StandardFonts.CourierOblique, monoBI: StandardFonts.CourierBoldOblique,
    };
    return (fonts[key] ??= await out.embedFont(map[key]));
  };
  const srcDocs = new Map<string, PDFDocument>();
  const embeddedPdfPages = new Map<string, Awaited<ReturnType<PDFDocument['embedPdf']>>[number]>();
  const embeddedImages = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();

  let done = 0;
  for (const idx of opts.pages) {
    const p = session.pages[idx];
    const content = await session.ensure(p.id);
    let page: PDFPage;
    let ox = 0, oy = 0; // crop box origin of copied PDF pages
    if (p.bg?.type === 'pdf') {
      let src = srcDocs.get(p.bg.asset);
      if (!src) {
        src = await PDFDocument.load(await session.assetBytes(p.bg.asset), { ignoreEncryption: true, updateMetadata: false });
        srcDocs.set(p.bg.asset, src);
      }
      [page] = await out.copyPages(src, [p.bg.page]);
      out.addPage(page);
      const cb = page.getCropBox();
      ox = cb.x;
      oy = cb.y;
    } else {
      page = out.addPage([p.w, p.h]);
      const paper = PAPER[p.template.paper];
      page.drawRectangle({ x: 0, y: 0, width: p.w, height: p.h, color: hexRgb(paper.bg) });
      if (p.bg?.type === 'image') {
        const img = await embedAsset(out, session, p.bg.asset, embeddedImages);
        if (img) page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
      }
    }

    // Our coordinates are top-left based in the page's *displayed* orientation for PDFs with /Rotate.
    const srcRot = (page.getRotation().angle % 360 + 360) % 360;
    const W = p.bg?.type === 'pdf' ? (srcRot === 90 || srcRot === 270 ? page.getCropBox().height : page.getCropBox().width) : p.w;
    const H = p.bg?.type === 'pdf' ? (srcRot === 90 || srcRot === 270 ? page.getCropBox().width : page.getCropBox().height) : p.h;
    // map displayed (x,y-down) to unrotated PDF user space
    // infinite canvases have a moving origin: page content is in world coordinates
    const WX = p.ox ?? 0, WY = p.oy ?? 0;
    const toPdf = (x: number, y: number): [number, number] => {
      x -= WX;
      y -= WY;
      switch (srcRot) {
        case 90:
          return [ox + y, oy + x];
        case 180:
          return [ox + W - x, oy + y];
        case 270:
          return [ox + H - y, oy + W - x];
        default:
          return [ox + x, oy + H - y];
      }
    };
    // SVG paths are drawn y-down from an origin; rotation handled by pdf-lib's rotate option.
    const svgAt = () => {
      const [x, y] = toPdf(0, 0);
      return { x, y, rotate: degrees(-srcRot) };
    };

    if (opts.includeTemplates && (!p.bg || p.template.kind !== 'blank')) {
      for (const pr of p.infinite ? worldPrims(p.template, WX, WY, WX + p.w, WY + p.h, 400_000) : cachedPrims(p.template, p.w, p.h)) {
        if (pr.t === 'line') {
          const [x1, y1] = toPdf(pr.x1, pr.y1), [x2, y2] = toPdf(pr.x2, pr.y2);
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: pr.w, color: hexRgb(pr.c), dashArray: pr.dash });
        } else if (pr.t === 'dot') {
          const [x, y] = toPdf(pr.x, pr.y);
          page.drawCircle({ x, y, size: pr.r, color: hexRgb(pr.c) });
        } else if (pr.t === 'rect') {
          page.drawSvgPath(`M${pr.x} ${pr.y}h${pr.w}v${pr.h}h${-pr.w}Z`, { ...svgAt(), borderColor: hexRgb(pr.c), borderWidth: pr.lw });
        } else if (pr.t === 'text') {
          const [x, y] = toPdf(pr.x, pr.y);
          page.drawText(pr.str, { x, y, size: pr.s, color: hexRgb(pr.c), font: await font({ font: 'sans', bold: true } as TextObject), rotate: degrees(-srcRot) });
        }
      }
    }

    if (opts.includeAnnotations) {
      for (const o of content.objects) {
        if (o.type !== 'pdf') continue;
        // placed PDF pages go in as real vector PDF content
        const key = `${o.asset}|${o.page}`;
        let emb = embeddedPdfPages.get(key);
        if (!emb) {
          [emb] = await out.embedPdf(await session.assetBytes(o.asset), [o.page]);
          embeddedPdfPages.set(key, emb);
        }
        const [x, y] = toPdf(o.x, o.y + o.h);
        page.drawPage(emb, { x, y, width: o.w, height: o.h, rotate: degrees(-srcRot - (o.rot * 180) / Math.PI) });
      }
      for (const o of content.objects) {
        if (o.type !== 'image') continue;
        const img = await embedImageObject(out, session, o, embeddedImages);
        if (!img) continue;
        const [x, y] = toPdf(o.x, o.y + o.h);
        page.drawImage(img, { x, y, width: o.w, height: o.h, rotate: degrees(-srcRot - (o.rot * 180) / Math.PI) });
      }
      for (const s of content.strokes) {
        if (s.kind === 'highlighter') {
          page.drawSvgPath(polylineSvg(s.pts, s.closed), {
            ...svgAt(), borderColor: hexRgb(s.color), borderWidth: s.width, borderOpacity: Math.min(1, HIGHLIGHT_ALPHA + 0.25),
            borderLineCap: s.shape ? LineCapStyle.Butt : LineCapStyle.Round, blendMode: BlendMode.Multiply,
          });
        }
      }
      for (const s of content.strokes) {
        if (s.kind !== 'pen') continue;
        if (s.shape) page.drawSvgPath(polylineSvg(s.pts, s.closed), { ...svgAt(), borderColor: hexRgb(s.color), borderWidth: s.width, borderLineCap: LineCapStyle.Round });
        else for (const r of penRuns(s)) page.drawSvgPath(runSvg(r), { ...svgAt(), borderColor: hexRgb(s.color), borderWidth: r.w, borderLineCap: LineCapStyle.Round });
      }
      for (const o of content.objects) {
        if (o.type !== 'text') continue;
        const f = await font(o);
        const lines = wrapText(o);
        const rect = (x: number, y: number, w: number, h: number) => `M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h} Z`;
        if (o.bgColor) page.drawSvgPath(rect(o.x - 2, o.y - 2, o.w + 4, o.h + 4), { ...svgAt(), color: hexRgb(o.bgColor), borderWidth: 0 });
        lines.forEach((text, li) => {
          // characters outside WinAnsi (the standard fonts' encoding: emoji, Greek …) cannot be
          // measured or drawn: they become '?' rather than failing the whole export
          let line = text;
          let lw: number;
          try {
            lw = f.widthOfTextAtSize(line, o.size);
          } catch {
            line = line.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
            lw = f.widthOfTextAtSize(line, o.size);
          }
          const lx = o.align === 'left' ? o.x + 2 : o.align === 'center' ? o.x + (o.w - lw) / 2 : o.x + o.w - 2 - lw;
          const top = lineTop(o, li) + o.size * 0.08;
          const t = Math.max(0.8, o.size / 14);
          if (line && o.underline) page.drawSvgPath(rect(lx, top + o.size * 0.9, lw, t), { ...svgAt(), color: hexRgb(o.color), borderWidth: 0 });
          if (line && o.strike) page.drawSvgPath(rect(lx, top + o.size * 0.52, lw, t), { ...svgAt(), color: hexRgb(o.color), borderWidth: 0 });
          const [x, y] = toPdf(lx, top + o.size * 0.84);
          try {
            page.drawText(line, { x, y, size: o.size, font: f, color: hexRgb(o.color), rotate: degrees(-srcRot) });
          } catch {
            // characters outside WinAnsi: fall back to drawing what we can
            page.drawText(line.replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), { x, y, size: o.size, font: f, color: hexRgb(o.color), rotate: degrees(-srcRot) });
          }
        });
      }
      for (const s of content.strokes) {
        if (s.kind === 'tape' && !s.revealed) page.drawSvgPath(polylineSvg(s.pts), { ...svgAt(), borderColor: hexRgb(s.color), borderWidth: s.width, borderLineCap: LineCapStyle.Butt });
      }
    }
    if (p.rotation) page.setRotation(degrees((srcRot + p.rotation) % 360));
    opts.onProgress?.(++done, opts.pages.length);
  }
  return out.save();
}

async function embedAsset(out: PDFDocument, session: NotebookSession, assetId: string, cache: Map<string, any>) {
  const key = `asset:${assetId}`;
  if (cache.has(key)) return cache.get(key);
  const ext = session.doc.assets[assetId]?.ext ?? 'png';
  let img = null;
  try {
    const bytes = await session.assetBytes(assetId);
    if (ext === 'png') img = await out.embedPng(bytes);
    else if (ext === 'jpg' || ext === 'jpeg') img = await out.embedJpg(bytes);
    else img = await out.embedPng(await rasterize(session, key));
  } catch {
    img = null;
  }
  cache.set(key, img);
  return img;
}

async function rasterize(session: NotebookSession, src: string, w = 1200): Promise<Uint8Array> {
  const img = (await session.loadImage(src)) as HTMLImageElement | ImageBitmap;
  const iw = img.width || w, ih = img.height || w;
  const f = Math.max(1, w / iw);
  const c = new OffscreenCanvas(Math.round(iw * f), Math.round(ih * f));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return canvasToPng(c);
}

async function embedImageObject(out: PDFDocument, session: NotebookSession, o: ImageObject, cache: Map<string, any>) {
  if (o.src.startsWith('asset:')) return embedAsset(out, session, o.src.slice(6), cache);
  if (cache.has(o.src)) return cache.get(o.src);
  const img = await out.embedPng(await rasterize(session, o.src, 600)).catch(() => null);
  cache.set(o.src, img);
  return img;
}

export async function exportPagePng(session: NotebookSession, idx: number, widthPx = 2400): Promise<Uint8Array> {
  const p = session.pages[idx];
  const c = await session.ensure(p.id);
  return canvasToPng(await renderPageToCanvas(p, c, widthPx, session));
}

export async function pageDataUrl(session: NotebookSession, idx: number, widthPx: number, mime = 'image/jpeg'): Promise<string> {
  const p: PageMeta = session.pages[idx];
  const c = await session.ensure(p.id);
  const canvas = await renderPageToCanvas(p, c, widthPx, session);
  const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
}
