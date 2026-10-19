// PDF loading and rendering through pdf.js. Documents are cached per asset; rendered page
// bitmaps are cached LRU by (asset, page, resolution bucket).
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SearchWord } from '../../shared/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = new URL('./pdfjs/', document.baseURI).href;
const DOC_OPTS = {
  cMapUrl: base + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: base + 'standard_fonts/',
  wasmUrl: base + 'wasm/',
  iccUrl: base + 'iccs/',
  isEvalSupported: false,
};

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = pdfjs.getDocument({ ...DOC_OPTS, data: bytes.slice(), password });
  return task.promise;
}

export function isPasswordError(e: unknown) {
  return (e as { name?: string })?.name === 'PasswordException';
}

export async function pdfPageSizes(doc: PDFDocumentProxy): Promise<{ w: number; h: number }[]> {
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    out.push({ w: vp.width, h: vp.height });
  }
  return out;
}

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

/**
 * Open a PDF from a gink:// URL: pdf.js fetches only the byte ranges it needs (64 KB pieces) instead
 * of the whole file being copied into memory and then again into its worker.
 */
export function openPdfUrl(url: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ ...DOC_OPTS, url, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true }).promise;
}

export function cachedPdf(key: string, load: () => Promise<Uint8Array> | string): Promise<PDFDocumentProxy> {
  let p = docCache.get(key);
  if (!p) {
    const src = load();
    p = typeof src === 'string' ? openPdfUrl(src) : src.then((b) => openPdf(b));
    p.catch(() => docCache.delete(key));
    docCache.set(key, p);
  }
  return p;
}

export function dropPdf(key: string) {
  for (const [k, b] of previews) {
    if (k.startsWith(`${key}|`)) {
      previews.delete(k);
      previewBytes -= b.width * b.height * 4;
    }
  }
  // forget every rendered page of this document too
  for (const [k, e] of bmpCache) {
    if (k.startsWith(`${key}|`)) {
      bmpCache.delete(k);
      cacheBytes -= e.bytes;
    }
  }
  const p = docCache.get(key);
  if (p) {
    docCache.delete(key);
    void p.then((d) => d.loadingTask.destroy()).catch(() => undefined);
  }
}

// ---- rendering ----------------------------------------------------------------------------------

interface CacheEntry {
  bmp: ImageBitmap;
  bytes: number;
}
const bmpCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ImageBitmap | null>>();
let cacheBytes = 0;
// Page layers keep the pixels they show, so this cache only has to bridge re-draws and thumbnails.
const CACHE_LIMIT = 64 * 1024 * 1024;

function touch(key: string, e: CacheEntry) {
  bmpCache.delete(key);
  bmpCache.set(key, e);
}

function evict() {
  for (const [k, e] of bmpCache) {
    if (cacheBytes <= CACHE_LIMIT) break;
    bmpCache.delete(k);
    cacheBytes -= e.bytes;
    // not closed: a page may still be about to draw it; dropping the reference lets GC free it
  }
}

/** Nearest cached bitmap at any resolution — shown stretched while the sharp one renders. */
export function anyCachedPage(docKey: string, page: number): ImageBitmap | null {
  let best: ImageBitmap | null = null;
  for (const [k, e] of bmpCache) if (k.startsWith(`${docKey}|${page}|`) && (!best || e.bmp.width > best.width)) best = e.bmp;
  return best ?? previews.get(`${docKey}|${page}`) ?? null;
}

// ---- previews: a small image of every page, so a page is never blank while the sharp one renders --

const previews = new Map<string, ImageBitmap>();
const previewJobs = new Map<string, Promise<void>>();
let previewBytes = 0;
const PREVIEW_LIMIT = 48 * 1024 * 1024;
/** preview resolution: about 450 px across the long side of a page */
const PREVIEW_PX = 450;

export function hasPreview(docKey: string, page: number) {
  return previews.has(`${docKey}|${page}`);
}

export function loadPreview(doc: PDFDocumentProxy, docKey: string, pageIndex: number): Promise<void> {
  const key = `${docKey}|${pageIndex}`;
  if (previews.has(key)) return Promise.resolve();
  let job = previewJobs.get(key);
  if (!job) {
    job = (async () => {
      try {
        const page = await doc.getPage(pageIndex + 1);
        const v1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: PREVIEW_PX / Math.max(v1.width, v1.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        page.cleanup();
        const bmp = await createImageBitmap(canvas);
        canvas.width = canvas.height = 0;
        previews.set(key, bmp);
        previewBytes += bmp.width * bmp.height * 4;
        for (const [k] of previews) {
          if (previewBytes <= PREVIEW_LIMIT) break;
          const b = previews.get(k)!;
          previews.delete(k);
          previewBytes -= b.width * b.height * 4;
        }
      } catch {
        /* page could not be rendered */
      } finally {
        previewJobs.delete(key);
      }
    })();
    previewJobs.set(key, job);
  }
  return job;
}

export function renderPdfPage(doc: PDFDocumentProxy, docKey: string, pageIndex: number, pxPerPt: number): Promise<ImageBitmap | null> {
  // Bucket resolution so tiny zoom changes reuse the cached bitmap.
  const bucket = Math.max(0.25, Math.pow(2, Math.ceil(Math.log2(pxPerPt) * 4) / 4));
  const key = `${docKey}|${pageIndex}|${bucket.toFixed(3)}`;
  const hit = bmpCache.get(key);
  if (hit) {
    touch(key, hit);
    return Promise.resolve(hit.bmp);
  }
  let p = inflight.get(key);
  if (p) return p;
  p = (async () => {
    try {
      const page = await doc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: bucket });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp }).promise;
      page.cleanup(); // free pdf.js' decoded operators/images for this page
      const bmp = await createImageBitmap(canvas);
      canvas.width = canvas.height = 0;
      const entry = { bmp, bytes: bmp.width * bmp.height * 4 };
      bmpCache.set(key, entry);
      cacheBytes += entry.bytes;
      evict();
      return bmp;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export async function renderPdfRegion(doc: PDFDocumentProxy, pageIndex: number, s: number, r: { x: number; y: number; w: number; h: number }): Promise<ImageBitmap | null> {
  try {
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(r.w * s));
    canvas.height = Math.max(1, Math.ceil(r.h * s));
    await page.render({ canvas, viewport: vp, transform: [1, 0, 0, 1, -r.x * s, -r.y * s] }).promise;
    page.cleanup();
    const bmp = await createImageBitmap(canvas);
    canvas.width = canvas.height = 0;
    return bmp;
  } catch {
    return null;
  }
}

// ---- text & outline -----------------------------------------------------------------------------

export async function pageWords(doc: PDFDocumentProxy, pageIndex: number): Promise<SearchWord[]> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const out: SearchWord[] = [];
  // pdf.js gives a run of text (often a whole line) with its total width; each word's place in it is
  // measured with the run's font family (proportional, so "i" and "m" differ), scaled to that width
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  for (const it of tc.items as any[]) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || 10;
    const x = tx[4], y = tx[5] - fh;
    const totalW = (it.width || it.str.length * fh * 0.5) * vp.scale;
    const family = (tc.styles as Record<string, { fontFamily?: string }>)[it.fontName]?.fontFamily ?? 'sans-serif';
    if (ctx) ctx.font = `100px ${family}`;
    const full = ctx?.measureText(it.str).width || 0;
    const at = (n: number) => (full > 0 ? (ctx!.measureText(it.str.slice(0, n)).width / full) * totalW : (n / it.str.length) * totalW);
    let ci = 0;
    for (const word of it.str.split(/(\s+)/)) {
      if (word.trim()) {
        const x0 = at(ci), x1 = at(ci + word.length);
        out.push({ t: word, b: [x + x0, y, x1 - x0, fh * 1.15] });
      }
      ci += word.length;
    }
  }
  return out;
}

export interface PdfOutlineItem {
  title: string;
  pageIndex: number;
}

export async function pdfOutline(doc: PDFDocumentProxy): Promise<PdfOutlineItem[]> {
  const out: PdfOutlineItem[] = [];
  const items = await doc.getOutline().catch(() => null);
  if (!items) return out;
  const walk = async (list: any[], depth: number) => {
    for (const it of list) {
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const idx = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
          out.push({ title: `${'  '.repeat(depth)}${it.title}`, pageIndex: idx });
        }
      } catch {
        /* unresolvable destination */
      }
      if (it.items?.length && depth < 3) await walk(it.items, depth + 1);
    }
  };
  await walk(items, 0);
  return out;
}

/** Diagnostics for the memory benchmark. */
export function pdfCacheStats() {
  return { bitmaps: bmpCache.size, mb: Math.round(cacheBytes / 1048576), docs: docCache.size };
}

/** Idle trim: drop cached page rasters and let pdf.js free parsed fonts/objects of open documents. */
export function trimPdfCaches() {
  bmpCache.clear();
  cacheBytes = 0;
  for (const p of docCache.values()) void p.then((d) => d.cleanup()).catch(() => undefined);
}
