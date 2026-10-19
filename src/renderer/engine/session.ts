// One open notebook: manifest, lazily loaded page contents, undo/redo, autosave, assets,
// search index and background OCR. The editor UI and the canvas viewport both talk to this.
import type { NotebookDoc, NotebookIndex, NotebookMeta, PageMeta, SearchWord } from '../../shared/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api } from '../lib/api';
import { canvasToPng } from '../lib/util';
import { contentFromJSON, contentToJSON, EMPTY_CONTENT, type PageContent, type Stroke } from './model';
import { cachedPdf, dropPdf } from './pdf';
import { renderPageToCanvas, type Sources } from './render';
import { drawStroke } from './ink';
import { whenIdle } from '../lib/idle';

export type SessionEvent =
  | { type: 'page'; pageId: string; change: 'append' | 'full'; stroke?: Stroke }
  | { type: 'pages' }
  | { type: 'history' }
  | { type: 'doc' }
  | { type: 'saved' };

type Cmd = { t: 'page'; pageId: string; before: PageContent; after: PageContent } | { t: 'pages'; before: PageMeta[]; after: PageMeta[]; focus?: string };

export interface SessionHooks {
  onSaved?(s: NotebookSession, info: { pageCount: number; firstPage: { w: number; h: number }; thumb: boolean }): void;
}

export const sessionHooks: SessionHooks = {};

const MAX_HISTORY = 300;

export class NotebookSession implements Sources {
  readonly id: string;
  doc: NotebookDoc;
  index: NotebookIndex = { pages: {} };
  private contents = new Map<string, PageContent>();
  private loading = new Map<string, Promise<PageContent>>();
  private versions = new Map<string, number>();
  private undoStack: Cmd[] = [];
  private redoStack: Cmd[] = [];
  private listeners = new Set<(e: SessionEvent) => void>();
  private dirtyPages = new Set<string>();
  private docDirty = false;
  private indexDirty = false;
  private thumbDirty = false;
  private saveTimer: (() => void) | undefined;
  private ocrTimer: (() => void) | undefined;
  private ocrQueue = new Set<string>();
  private images = new Map<string, CanvasImageSource>();
  private imageLoads = new Map<string, Promise<CanvasImageSource | null>>();
  ocrEnabled = true;
  closed = false;

  private constructor(public meta: NotebookMeta, doc: NotebookDoc) {
    this.id = meta.id;
    this.doc = doc;
  }

  static async open(meta: NotebookMeta): Promise<NotebookSession> {
    const doc = await api.loadNotebook(meta.id);
    if (!doc) throw new Error('This notebook could not be found on disk.');
    doc.outline ??= [];
    doc.recordings ??= [];
    doc.assets ??= {};
    const s = new NotebookSession(meta, doc);
    s.index = await api.loadIndex(meta.id);
    return s;
  }

  on(fn: (e: SessionEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(e: SessionEvent) {
    for (const l of this.listeners) l(e);
  }

  // ---- pages --------------------------------------------------------------------------------

  get pages() {
    return this.doc.pages;
  }

  pageIndex(id: string) {
    return this.doc.pages.findIndex((p) => p.id === id);
  }

  page(id: string): PageMeta | undefined {
    return this.doc.pages.find((p) => p.id === id);
  }

  content(id: string): PageContent | undefined {
    return this.contents.get(id);
  }

  version(id: string) {
    return this.versions.get(id) ?? 0;
  }

  ensure(id: string): Promise<PageContent> {
    const have = this.contents.get(id);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(id);
    if (!p) {
      p = api
        .loadPage(this.id, id)
        .then((j) => {
          const c = contentFromJSON(j);
          if (!this.contents.has(id)) this.contents.set(id, c);
          return this.contents.get(id)!;
        })
        .catch(() => {
          this.contents.set(id, EMPTY_CONTENT);
          return EMPTY_CONTENT;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /** Replace a page's content. `record` adds an undo step (default). */
  commit(pageId: string, next: PageContent, opts: { record?: boolean; change?: 'append' | 'full'; stroke?: Stroke; before?: PageContent } = {}) {
    const before = opts.before ?? this.contents.get(pageId) ?? EMPTY_CONTENT;
    this.contents.set(pageId, next);
    this.versions.set(pageId, this.version(pageId) + 1);
    if (opts.record !== false && before !== next) this.push({ t: 'page', pageId, before, after: next });
    this.markDirty(pageId);
    this.emit({ type: 'page', pageId, change: opts.change ?? 'full', stroke: opts.stroke });
    const p = this.page(pageId);
    if (p?.infinite) this.growToFit(p, next, opts.stroke);
  }

  /**
   * Infinite canvas: keep at least GROW_MARGIN of empty paper on every side of the content. The page
   * grows left/up by moving its origin (ox, oy), so content coordinates never change and undo stays exact.
   */
  private growToFit(p: PageMeta, c: PageContent, added?: Stroke) {
    const GROW_MARGIN = 900, GROW_STEP = 1500;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const take = (a: number, b: number, cc: number, d: number) => {
      x0 = Math.min(x0, a);
      y0 = Math.min(y0, b);
      x1 = Math.max(x1, cc);
      y1 = Math.max(y1, d);
    };
    if (added) take(added.bbox[0], added.bbox[1], added.bbox[2], added.bbox[3]);
    else {
      for (const s of c.strokes) take(s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]);
      for (const o of c.objects) take(o.x, o.y, o.x + o.w, o.y + o.h);
    }
    if (x0 === Infinity) return;
    let ox = p.ox ?? 0, oy = p.oy ?? 0, w = p.w, h = p.h;
    if (x0 < ox + GROW_MARGIN) {
      const d = Math.ceil(ox + GROW_MARGIN - x0 + GROW_STEP);
      ox -= d;
      w += d;
    }
    if (y0 < oy + GROW_MARGIN) {
      const d = Math.ceil(oy + GROW_MARGIN - y0 + GROW_STEP);
      oy -= d;
      h += d;
    }
    if (x1 > ox + w - GROW_MARGIN) w = Math.ceil(x1 - ox + GROW_STEP);
    if (y1 > oy + h - GROW_MARGIN) h = Math.ceil(y1 - oy + GROW_STEP);
    if (ox === (p.ox ?? 0) && oy === (p.oy ?? 0) && w === p.w && h === p.h) return;
    this.setPages(this.doc.pages.map((x) => (x.id === p.id ? { ...x, ox, oy, w, h } : x)), { record: false });
  }

  /** Change the page list (add/delete/reorder/template/rotate/bookmark). */
  setPages(next: PageMeta[], opts: { record?: boolean; focus?: string } = {}) {
    if (next.length === 0) return;
    const before = this.doc.pages;
    this.doc = { ...this.doc, pages: next };
    if (opts.record !== false) this.push({ t: 'pages', before, after: next, focus: opts.focus });
    this.docDirty = true;
    if (before[0]?.id !== next[0]?.id || before[0] !== next[0]) this.thumbDirty = true;
    this.scheduleSave();
    this.emit({ type: 'pages' });
  }

  patchDoc(patch: Partial<NotebookDoc>) {
    this.doc = { ...this.doc, ...patch };
    this.docDirty = true;
    this.scheduleSave();
    this.emit({ type: 'doc' });
  }

  // ---- history ------------------------------------------------------------------------------

  private push(c: Cmd) {
    this.undoStack.push(c);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.emit({ type: 'history' });
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Returns the page id the change happened on, so the view can scroll to it. */
  undo(): string | undefined {
    const c = this.undoStack.pop();
    if (!c) return;
    this.redoStack.push(c);
    return this.applyCmd(c, 'before');
  }

  redo(): string | undefined {
    const c = this.redoStack.pop();
    if (!c) return;
    this.undoStack.push(c);
    return this.applyCmd(c, 'after');
  }

  private applyCmd(c: Cmd, side: 'before' | 'after'): string | undefined {
    if (c.t === 'page') {
      this.commit(c.pageId, c[side], { record: false });
      this.emit({ type: 'history' });
      return c.pageId;
    }
    this.setPages(c[side], { record: false });
    this.emit({ type: 'history' });
    return c.focus;
  }

  // ---- saving -------------------------------------------------------------------------------

  private markDirty(pageId: string) {
    this.dirtyPages.add(pageId);
    this.indexDirty = true;
    if (this.doc.pages[0]?.id === pageId) this.thumbDirty = true;
    this.ocrQueue.add(pageId);
    this.scheduleSave();
  }

  private scheduleSave() {
    this.saveTimer?.();
    this.saveTimer = whenIdle(() => void this.flush(), 450);
    this.ocrTimer?.();
    this.ocrTimer = whenIdle(() => void this.runOcr(), 3500);
  }

  private flushing: Promise<void> | null = null;

  async flush(): Promise<void> {
    this.saveTimer?.();
    this.saveTimer = undefined;
    while (this.flushing) await this.flushing;
    if (!this.dirtyPages.size && !this.docDirty && !this.indexDirty && !this.thumbDirty) return;
    this.flushing = (async () => {
      const pages = [...this.dirtyPages];
      this.dirtyPages.clear();
      const writeDoc = this.docDirty;
      this.docDirty = false;
      await Promise.all(pages.map((id) => api.savePage(this.id, id, contentToJSON(this.contents.get(id) ?? EMPTY_CONTENT))));
      if (writeDoc) await api.saveNotebook(this.id, this.doc);
      if (this.indexDirty) {
        this.indexDirty = false;
        for (const id of pages) this.updateTypedIndex(id);
        await api.saveIndex(this.id, this.index);
      }
      let thumb = false;
      if (this.thumbDirty) {
        this.thumbDirty = false;
        thumb = await this.saveThumb();
      }
      const first = this.doc.pages[0];
      sessionHooks.onSaved?.(this, { pageCount: this.doc.pages.length, firstPage: { w: first.w, h: first.h }, thumb });
      this.emit({ type: 'saved' });
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async saveThumb(): Promise<boolean> {
    try {
      const p = this.doc.pages[0];
      const c = await this.ensure(p.id);
      const canvas = await renderPageToCanvas(p, c, 360, this, { hideTape: false });
      await api.saveThumb(this.id, await canvasToPng(canvas));
      return true;
    } catch {
      return false;
    }
  }

  requestThumb() {
    this.thumbDirty = true;
    this.scheduleSave();
  }

  async close() {
    this.closed = true;
    await this.flush();
    this.ocrTimer?.();
    for (const id of Object.keys(this.doc.assets))
      if (this.doc.assets[id].ext === 'pdf') {
        dropPdf(this.pdfKey(id));
        dropPdf(`${this.pdfKey(id)}#preview`);
      }
    for (const img of this.images.values()) if (img instanceof ImageBitmap) img.close();
    this.images.clear();
  }

  // ---- search index -------------------------------------------------------------------------

  private updateTypedIndex(pageId: string) {
    const c = this.contents.get(pageId);
    if (!c) return;
    const typed: SearchWord[] = [];
    for (const o of c.objects) if (o.type === 'text') for (const w of o.text.split(/\s+/)) if (w) typed.push({ t: w, b: [o.x, o.y, o.w, o.h] });
    const cur = this.index.pages[pageId] ?? { typed: [], pdf: [], ocr: [], ocrStamp: -1 };
    this.index.pages[pageId] = { ...cur, typed };
  }

  setPdfIndex(pageId: string, words: SearchWord[]) {
    const cur = this.index.pages[pageId] ?? { typed: [], pdf: [], ocr: [], ocrStamp: -1 };
    this.index.pages[pageId] = { ...cur, pdf: words };
    this.indexDirty = true;
    this.scheduleSave();
  }

  private async runOcr() {
    if (!this.ocrEnabled || this.closed) return;
    const ids = [...this.ocrQueue];
    this.ocrQueue.clear();
    let changed = false;
    for (const id of ids) {
      const p = this.page(id);
      const c = this.contents.get(id);
      if (!p || !c) continue;
      const ver = this.version(id);
      const ink = c.strokes.filter((s) => s.kind === 'pen');
      let words: SearchWord[] = [];
      if (ink.length) {
        const sc = 2;
        const canvas = new OffscreenCanvas(Math.ceil(p.w * sc), Math.ceil(p.h * sc));
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(sc, 0, 0, sc, 0, 0);
        for (const s of ink) drawStroke(ctx, { ...s, color: '#000000' });
        const res = await api.ocr(await canvasToPng(canvas)).catch(() => []);
        words = res.map((w) => ({ t: w.text, b: [w.x / sc, w.y / sc, w.w / sc, w.h / sc] as [number, number, number, number] }));
      }
      if (this.closed) return;
      const cur = this.index.pages[id] ?? { typed: [], pdf: [], ocr: [], ocrStamp: -1 };
      this.index.pages[id] = { ...cur, ocr: words, ocrStamp: ver };
      changed = true;
    }
    if (changed) {
      this.indexDirty = true;
      this.saveTimer?.();
      this.saveTimer = whenIdle(() => void this.flush(), 450);
    }
  }

  /** Words on a page matching a query, for highlighting search hits. */
  findOnPage(pageId: string, q: string): [number, number, number, number][] {
    const pi = this.index.pages[pageId];
    if (!pi || !q) return [];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out: [number, number, number, number][] = [];
    for (const w of [...pi.typed, ...pi.pdf, ...pi.ocr]) if (terms.some((t) => w.t.toLowerCase().includes(t))) out.push(w.b);
    return out;
  }

  /**
   * Every occurrence of the query on a page, in reading order: the query's words as consecutive
   * words ("dual system" matches only where "dual" is followed by "system"), each occurrence one
   * match with the boxes of its words.
   */
  findMatches(pageId: string, q: string): [number, number, number, number][][] {
    const pi = this.index.pages[pageId];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!pi || !terms.length) return [];
    const norm = (t: string) => t.toLowerCase();
    const out: [number, number, number, number][][] = [];
    for (const words of [pi.typed, pi.pdf, pi.ocr]) {
      for (let i = 0; i + terms.length <= words.length; i++) {
        let ok = true;
        for (let j = 0; j < terms.length && ok; j++) {
          const w = norm(words[i + j].t);
          // inner words must match whole (minus punctuation); the ends may be partial ("ink" in "goodink")
          ok = terms.length === 1 ? w.includes(terms[0]) : j === 0 ? w.endsWith(terms[j]) || w.replace(/\W+$/, '').endsWith(terms[j]) : j === terms.length - 1 ? w.startsWith(terms[j]) : w.replace(/^\W+|\W+$/g, '') === terms[j];
        }
        if (ok) out.push(words.slice(i, i + terms.length).map((w) => w.b));
      }
    }
    return out;
  }

  searchDoc(q: string): { pageId: string; pageNumber: number; snippet: string; source: string }[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out: { pageId: string; pageNumber: number; snippet: string; source: string }[] = [];
    this.doc.pages.forEach((p, i) => {
      const pi = this.index.pages[p.id];
      if (!pi) return;
      for (const src of ['typed', 'pdf', 'ocr'] as const) {
        const text = pi[src].map((w) => w.t).join(' ');
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) {
          const from = Math.max(0, at - 30);
          out.push({ pageId: p.id, pageNumber: i + 1, snippet: (from ? '…' : '') + text.slice(from, at + needle.length + 50), source: src });
          break;
        }
      }
    });
    return out;
  }

  // ---- assets (Sources) ---------------------------------------------------------------------

  async addAsset(bytes: Uint8Array, ext: string, name?: string): Promise<string> {
    const id = await api.putAsset(this.id, bytes, ext);
    if (!this.doc.assets[id]) this.patchDoc({ assets: { ...this.doc.assets, [id]: { ext, name, bytes: bytes.byteLength } } });
    return id;
  }

  assetBytes(id: string): Promise<Uint8Array> {
    const a = this.doc.assets[id];
    return api.getAsset(this.id, id, a?.ext ?? 'bin');
  }

  pdfKey(assetId: string) {
    return `${this.id}/${assetId}`;
  }

  pdf(assetId: string): Promise<PDFDocumentProxy> {
    return cachedPdf(this.pdfKey(assetId), () => api.assetUrl(this.id, assetId, 'pdf'));
  }

  previewPdf(assetId: string): Promise<PDFDocumentProxy> {
    // its own pdf.js worker; streamed by byte ranges, so the second instance costs little memory
    return cachedPdf(`${this.pdfKey(assetId)}#preview`, () => api.assetUrl(this.id, assetId, 'pdf'));
  }

  image(src: string): CanvasImageSource | null {
    const img = this.images.get(src);
    if (!img && !this.imageLoads.has(src)) void this.loadImage(src);
    return img ?? null;
  }

  loadImage(src: string): Promise<CanvasImageSource | null> {
    const have = this.images.get(src);
    if (have) return Promise.resolve(have);
    let p = this.imageLoads.get(src);
    if (!p) {
      p = (async () => {
        try {
          let img: CanvasImageSource;
          if (src.startsWith('asset:')) {
            const id = src.slice(6);
            const ext = this.doc.assets[id]?.ext ?? 'png';
            // streamed from disk by the backend; no copy of the file passes through IPC
            const url = api.assetUrl(this.id, id, ext);
            if (ext === 'svg') img = await htmlImage(url);
            else {
              // Photos are kept at a size the screen can use (export still uses the original file).
              const full = await createImageBitmap(await (await fetch(url)).blob());
              const max = 2560;
              if (full.width > max || full.height > max) {
                const f = max / Math.max(full.width, full.height);
                img = await createImageBitmap(full, { resizeWidth: Math.round(full.width * f), resizeHeight: Math.round(full.height * f), resizeQuality: 'high' });
                full.close();
              } else img = full;
            }
          } else img = await htmlImage(src);
          this.images.set(src, img);
          this.emit({ type: 'doc' }); // repaint pages waiting on this image
          return img;
        } catch {
          return null;
        } finally {
          this.imageLoads.delete(src);
        }
      })();
      this.imageLoads.set(src, p);
    }
    return p;
  }
}

function htmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });
}
