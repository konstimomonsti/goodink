// The editor surface. Imperative on purpose: pen input and painting never go through React.
//
// Layers per page:  bg (paper/template/PDF + images) → hl (highlighter, multiply) → ink (pen, text, tape)
// One overlay canvas over the whole viewport draws wet ink, lasso, selection and the laser, with a
// low-latency (desynchronized) context.
import type { PageMeta, PageObject, PenKind, TextObject, TextStyle, ImageObject, PdfObject } from '../../shared/types';

/** Images and PDF pages sit on the page; only right-click or long-press picks them up. */
const isPlaced = (o: PageObject) => o.type === 'image' || o.type === 'pdf';
/** Picked up by a long press or right-click with any tool: placed media and text boxes. */
const isGrabbable = (o: PageObject) => isPlaced(o) || o.type === 'text';
import { uid, clamp } from '../lib/util';
import { markInput, isBusy } from '../lib/idle';
import { about, apply, bboxHit, bboxOverlap, bboxUnion, distToSegSq, invert, mul, pointInPolygon, rotate, scale, translate, type BBox, type Mat, IDENTITY, isIdentity, rectCorners } from './geometry';
import { curvePressure, drawStroke, velocityPressure } from './ink';
import { makeStroke, objectBBox, transformObject, transformStroke, recolorStroke, type PageContent, type Stroke } from './model';
import { displaySize, drawBackground, drawHighlights, drawImages, drawPdfObjects, ensurePdfPreview, ensureObjectPreviews, preparePdfObjects, drawInk, drawTape, drawTexts, fontCss, loadPdfBackground, loadPdfRegion, pageMatrix, setPageTransform, textHeight, lineStep, type PageRect } from './render';
import { recognizeShape } from './shapes';
import type { NotebookSession, SessionEvent } from './session';
import { renderDecorations, hitDecoration, tipAnchor } from '../live/ui/decorations';
import type { UiDecoration } from '../live/ui/engineApi';
import { LIVE_TUNING } from '../live/ui/tuning';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape' | 'text' | 'image' | 'tape' | 'laser' | 'ai';

/** A loop drawn with the AI selector: polygon in page units (flat x, y pairs) and its box. */
export interface AiRegion {
  pageId: string;
  pts: number[];
  bbox: BBox;
}

/** A loop drawn past its start leaves a tail inside: cut the path where it comes back to the start. */
function trimLoopTail(pts: number[], diag: number) {
  const n = pts.length / 2;
  if (n < 12) return;
  const sx = pts[0], sy = pts[1];
  let best = -1, bestD = Infinity;
  for (let k = Math.floor(n * 0.6); k < n; k++) {
    const d = Math.hypot(pts[k * 2] - sx, pts[k * 2 + 1] - sy);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best > 0 && best < n - 1 && bestD < diag * 0.12) pts.length = (best + 1) * 2;
}

export interface ToolState {
  tool: Tool;
  penKind: PenKind;
  penColor: string;
  penWidth: number;
  hlColor: string;
  hlWidth: number;
  straightHighlighter: boolean;
  eraserWidth: number;
  eraserMode: 'stroke' | 'precise';
  eraserHlOnly: boolean;
  eraserAutoDeselect: boolean;
  tapeColor: string;
  tapeWidth: number;
  holdToShape: boolean;
  holdDelay: number;
  pressure: boolean;
  stylusMode: 'auto' | 'penOnly' | 'touch';
  laserMode: 'dot' | 'trail';
  laserColor: string;
  text: TextStyle;
}

export interface Selection {
  pageId: string;
  strokeIds: Set<string>;
  objectIds: Set<string>;
  bbox: BBox;
}

export interface ViewportCallbacks {
  onPageChange(index: number): void;
  onZoom(zoom: number, fitWidth: number): void;
  onSelection(sel: Selection | null, anchor: DOMRect | null): void;
  onTextEdit(obj: TextObject | null): void;
  onRequestImage(pageId: string, x: number, y: number): void;
  onTempTool(tool: Tool | null): void;
  onEraseEnd(): void;
  onLaser(page: number, pts: { x: number; y: number; t: number }[]): void;
  onToast(msg: string): void;
  /** first pen contact (smart pen detection) */
  onPenSeen?(): void;
  /** right-click, pen barrel click or touch long-press on handwriting (page units + client px) */
  onInkContext?(pageId: string, x: number, y: number, clientX: number, clientY: number): void;
  /** the AI selector closed a loop (null: tapped without drawing, the region was cleared) */
  onAiRegion?(region: AiRegion | null): void;
  /** pen (or finger) down/up with an ink tool at a page point; called twice per stroke, never per move */
  onPenActivity?(pageId: string, x: number, y: number, down: boolean): void;
}

type Clip = { strokes: Stroke[]; objects: PageObject[]; bbox: BBox; pageId: string };
let clipboard: Clip | null = null;
export const hasClipboard = () => !!clipboard;

const PAD = 28;
const GAP = 22;
const MAX_CANVAS_PX = 9_000_000;
const HANDLE = 9;

interface Action {
  /** true: this action draws ink and takes raw (un-throttled) pointer updates */
  raw?: boolean;
  move(e: PointerEvent): void;
  up(e: PointerEvent): void;
  cancel(): void;
}

/**
 * One page on screen. Memory is the budget here, so a page holds:
 *  - bg:   paper, template, PDF page, images and placed PDFs (changes rarely)
 *  - ink:  highlighter underneath, pen strokes and text on top, blended onto the paper with
 *          multiply (so highlighter never hides PDF text and ink reads like ink on paper)
 *  - tape: only created for pages that actually have tape (it must cover, not blend)
 * Pages near but outside the window are kept at quarter resolution.
 */
class PageView {
  el: HTMLDivElement;
  bg: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  tape: HTMLCanvasElement | null = null;
  marks: HTMLDivElement;
  scale = 0;
  dirtyBg = true;
  dirtyInk = true;
  /** geometry the canvases currently show */
  geomKey = '';
  /** async PDF raster for a geometry, prepared before the swap so nothing ever flashes */
  jobKey = '';
  readyKey = '';
  readyBmp: ImageBitmap | null = null;
  pdfBmp: ImageBitmap | null = null;
  pdfRect: PageRect | undefined;
  /** Part of the page (page units) the canvases cover; the whole page unless zoomed far in. */
  region: PageRect | null = null;
  /** The same area in display units (after page rotation). */
  disp: PageRect = { x: 0, y: 0, w: 0, h: 0 };
  full = true;
  pdfObjJob: Promise<unknown> | null = null;
  previewJob: Promise<unknown> | null = null;
  objPreviewsDone = false;
  /** placed-PDF rasters for the zoom level on screen (held by the page, not the shared cache) */
  objBmps: Map<string, ImageBitmap> | null = null;
  readyObjBmps: Map<string, ImageBitmap> | null = null;
  objectsRef: unknown = null;
  /** live check marks (vector), built for the zoom in liveZoom */
  live: SVGSVGElement | null = null;
  liveZoom = 0;
  livePage: PageMeta | null = null;
  /** diagnostics: PDF content visible at all / at final sharpness */
  rasterOk = false;
  sharp = false;

  /** Device-pixel offset for drawing into a partial-page canvas. */
  base(): Mat {
    return [1, 0, 0, 1, -this.disp.x * this.scale, -this.disp.y * this.scale];
  }

  layers(): HTMLCanvasElement[] {
    return this.tape ? [this.bg, this.ink, this.tape] : [this.bg, this.ink];
  }

  /** pixel size the layers should have; the ink layer only takes it once the page has ink */
  cw = 1;
  ch = 1;

  /** Allocate (or release) the ink layer. Pages without any ink or text keep it empty. */
  sizeInk(has: boolean) {
    const w = has ? this.cw : 0, h = has ? this.ch : 0;
    if (this.ink.width !== w || this.ink.height !== h) {
      this.ink.width = w;
      this.ink.height = h;
    }
  }

  styleLayers(zoom: number) {
    for (const c of this.layers()) {
      c.style.left = `${this.disp.x * zoom}px`;
      c.style.top = `${this.disp.y * zoom}px`;
      c.style.width = `${this.disp.w * zoom}px`;
      c.style.height = `${this.disp.h * zoom}px`;
    }
  }

  constructor(public page: PageMeta) {
    this.el = document.createElement('div');
    this.el.className = 'gi-page';
    this.bg = this.layer('gi-bg');
    this.ink = this.layer('gi-ink');
    this.marks = document.createElement('div');
    this.marks.className = 'gi-marks';
    this.el.append(this.bg, this.ink, this.marks);
    this.applyBlend();
  }

  private layer(cls: string) {
    const c = document.createElement('canvas');
    c.className = cls;
    return c;
  }

  get dark() {
    return !this.page.bg && this.page.template.paper === 'dark';
  }

  /** page has highlighter strokes / is on or near the screen (set by the viewport) */
  hasHl = false;
  near = true;

  /**
   * Multiply makes highlighter sit under PDF text like real ink. It costs the GPU an extra surface
   * per page, so it is only used where it is visible: on-screen pages that actually have highlights.
   */
  get blend(): boolean {
    return this.hasHl && this.near && !this.dark;
  }

  /** returns true when the blend changed (the ink layer must then be redrawn) */
  applyBlend(): boolean {
    const want = this.blend ? 'multiply' : 'normal';
    if (this.ink.style.mixBlendMode === want) return false;
    this.ink.style.mixBlendMode = want;
    return true;
  }

  /** highlighter opacity: opaque under multiply, translucent when layered normally */
  get hlAlpha() {
    return this.blend ? 0.92 : this.dark ? 0.5 : 0.42;
  }

  /** Create or drop the tape layer to match the page content. */
  ensureTape(want: boolean) {
    if (want && !this.tape) {
      this.tape = this.layer('gi-tape');
      this.el.insertBefore(this.tape, this.marks);
      this.tape.width = this.ink.width;
      this.tape.height = this.ink.height;
      this.tape.style.cssText = this.ink.style.cssText;
      this.tape.style.mixBlendMode = 'normal';
    } else if (!want && this.tape) {
      this.tape.width = this.tape.height = 0;
      this.tape.remove();
      this.tape = null;
    }
  }

  setPage(p: PageMeta) {
    if (p !== this.page) {
      const bgChanged = p.template !== this.page.template || p.bg !== this.page.bg || p.rotation !== this.page.rotation || p.w !== this.page.w || p.h !== this.page.h || p.ox !== this.page.ox || p.oy !== this.page.oy;
      this.page = p;
      this.dirtyInk = true;
      if (bgChanged) {
        this.dirtyBg = true;
        this.pdfBmp = null;
        this.readyBmp = null;
        this.readyKey = this.jobKey = this.geomKey = '';
        this.region = null;
      }
      if (this.applyBlend()) this.dirtyInk = true;
    }
  }

  destroy() {
    for (const c of this.layers()) c.width = c.height = 0;
    this.pdfBmp = this.readyBmp = null;
    this.objBmps = this.readyObjBmps = null;
    this.el.remove();
  }
}

export class Viewport {
  readonly root: HTMLDivElement;
  readonly scroller: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private views = new Map<string, PageView>();
  private rects: { x: number; y: number; w: number; h: number }[] = [];
  zoom = 1;
  private zoomSettle: ReturnType<typeof setTimeout> | undefined;
  private zooming = false;
  private rafPending = false;
  private action: Action | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
  /** set from Windows' digitizer info at startup; also turns on at the first pen contact */
  penSeen = false;
  private penHover: { x: number; y: number } | null = null;
  private spaceDown = false;
  private tempActive = false;
  private needsFit = true;
  private currentPage = -1;
  private hidden = new Set<string>(); // ids hidden from page layers while transformed / edited
  private hiddenPage: string | null = null;
  private wet: { pageId: string; stroke: Stroke } | null = null;
  private lassoPath: { pageId: string; pts: number[] } | null = null;
  private eraserCursor: { x: number; y: number; r: number } | null = null;
  private laser: { page: number; pts: { x: number; y: number; t: number }[] } | null = null;
  private laserRaf = 0;
  sel: Selection | null = null;
  private selMatrix: Mat = IDENTITY;
  private textCaret: Range | null = null;
  private textEdit: { pageId: string; obj: TextObject; isNew: boolean; el: HTMLDivElement; before: PageContent } | null = null;
  private highlights: { pageId: string; boxes: [number, number, number, number][] } | null = null;
  private unsub: () => void;
  private ro: ResizeObserver;
  scrollDir: 'vertical' | 'horizontal' = 'vertical';
  /** live check marks per page, and the ids already shown once (they animate in only the first time) */
  private liveDecos = new Map<string, UiDecoration[]>();
  private liveSeen = new Set<string>();
  /** marks that arrived while the pen was down: applied when it lifts */
  private livePending = new Map<string, UiDecoration[]>();
  private actPage = '';
  private actX = 0;
  private actY = 0;
  private actT = 0;
  private actOX = 0;
  private actOY = 0;
  private actInv: Mat = IDENTITY;
  private liveTip: HTMLDivElement | null = null;
  private liveTipId = '';
  private liveTipTimer: ReturnType<typeof setTimeout> | undefined;
  /** AI selector: the loop being drawn (open) or the settled region (closed) */
  private aiPath: { pageId: string; pts: number[]; closed: boolean; t0: number; busy: boolean } | null = null;
  private aiRaf = 0;
  private viewFns = new Set<() => void>();
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  constructor(
    host: HTMLElement,
    public session: NotebookSession,
    public tools: ToolState,
    private cb: ViewportCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'gi-viewport';
    this.scroller = document.createElement('div');
    this.scroller.className = 'gi-scroller';
    this.scroller.tabIndex = 0;
    this.content = document.createElement('div');
    this.content.className = 'gi-content';
    this.scroller.append(this.content);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'gi-overlay';
    this.root.append(this.scroller, this.overlay);
    host.append(this.root);
    // Not `desynchronized`: on many Windows GPU drivers that path flashes uninitialised (black)
    // tiles when the canvas is cleared. Raw pointer updates give us the latency instead.
    this.octx = this.overlay.getContext('2d', { alpha: true })!;

    this.scroller.addEventListener('pointerdown', this.onDown);
    this.scroller.addEventListener('pointermove', this.onMove);
    this.scroller.addEventListener('pointerrawupdate' as 'pointermove', this.onRawMove);
    this.scroller.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'pen') this.setPenHover(null);
      this.hideLiveTip();
    });
    this.scroller.addEventListener('pointerup', this.onUp);
    this.scroller.addEventListener('pointercancel', this.onCancel);
    this.scroller.addEventListener('lostpointercapture', this.onLostCapture);
    this.scroller.addEventListener('wheel', this.onWheel, { passive: false });
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroller.addEventListener('dblclick', this.onDblClick);
    this.scroller.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    this.unsub = this.session.on(this.onSession);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.root);
    this.resize();
    void this.prefetchPreviews();
    window.addEventListener('goodink:trim', this.onTrim);
  }

  /** Idle trim: pages that are not on screen drop to half resolution (pixels scaled, no re-render). */
  private onTrim = () => {
    const sl = this.scroller.scrollLeft, st = this.scroller.scrollTop;
    for (const v of this.views.values()) {
      const r = this.rects[this.session.pageIndex(v.page.id)];
      const onScreen = r && r.y + r.h > st && r.y < st + this.vh && r.x + r.w > sl && r.x < sl + this.vw;
      if (onScreen || !v.full || !v.rasterOk || v.scale === 0) continue;
      const half = Math.max(0.25, v.scale / 2);
      if (half < v.scale) this.downscaleInPlace(v, half, `trim|${half}`);
    }
    this.requestRender();
  };

  private destroyed = false;

  /**
   * Prepare the small preview of every PDF page in the background, nearest pages first, so that no
   * page is ever blank when it scrolls into view. Pauses while the pen is writing.
   */
  private async prefetchPreviews() {
    const order = () => {
      const cur = this.pageIndexNow;
      return this.session.pages.map((p, i) => ({ p, d: Math.abs(i - cur) })).sort((a, b) => a.d - b.d).map((x) => x.p);
    };
    await new Promise((r) => setTimeout(r, 300)); // let the first screen render first
    for (const p of order()) {
      if (this.destroyed) return;
      if (p.bg?.type !== 'pdf') continue;
      while (isBusy(150) && !this.destroyed) await new Promise((r) => setTimeout(r, 200));
      await ensurePdfPreview(p, this.session).catch(() => false);
    }
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener('goodink:trim', this.onTrim);
    this.commitTextEdit();
    this.unsub();
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    cancelAnimationFrame(this.laserRaf);
    cancelAnimationFrame(this.aiRaf);
    if (this.liveTipTimer) clearTimeout(this.liveTipTimer);
    this.viewFns.clear();
    this.root.remove();
  }

  // ---- layout -------------------------------------------------------------------------------

  private get vw() {
    return this.scroller.clientWidth;
  }
  private get vh() {
    return this.scroller.clientHeight;
  }

  private resize() {
    if (!this.root.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.overlayAwake) {
      this.overlay.width = Math.round(this.root.clientWidth * dpr);
      this.overlay.height = Math.round(this.root.clientHeight * dpr);
    }
    this.overlay.style.width = `${this.root.clientWidth}px`;
    this.overlay.style.height = `${this.root.clientHeight}px`;
    this.layout();
    if (this.needsFit) {
      this.needsFit = false;
      this.fitWidth(true);
    }
    this.cb.onZoom(this.zoom, this.fitWidthZoom());
    this.emitView();
  }

  private layout() {
    const pages = this.session.pages;
    const z = this.zoom;
    const sizes = pages.map((p) => displaySize(p));
    this.rects = [];
    if (this.scrollDir === 'vertical') {
      const maxW = Math.max(...sizes.map((s) => s.w * z));
      const cw = Math.max(this.vw, maxW + PAD * 2);
      let y = PAD;
      for (const s of sizes) {
        const w = s.w * z, h = s.h * z;
        this.rects.push({ x: (cw - w) / 2, y, w, h });
        y += h + GAP;
      }
      this.content.style.width = `${cw}px`;
      this.content.style.height = `${y - GAP + PAD + 80}px`;
    } else {
      const maxH = Math.max(...sizes.map((s) => s.h * z));
      const ch = Math.max(this.vh, maxH + PAD * 2);
      let x = PAD;
      for (const s of sizes) {
        const w = s.w * z, h = s.h * z;
        this.rects.push({ x, y: (ch - h) / 2, w, h });
        x += w + GAP;
      }
      this.content.style.width = `${x - GAP + PAD + 80}px`;
      this.content.style.height = `${ch}px`;
    }
    for (const v of this.views.values()) this.placeView(v);
    this.updateVisible();
    if (this.textEdit) this.positionTextEditor();
    this.renderHighlights();
    this.renderLive();
  }

  private placeView(v: PageView) {
    const i = this.session.pageIndex(v.page.id);
    const r = this.rects[i];
    if (!r) return;
    v.el.style.transform = `translate(${r.x}px, ${r.y}px)`;
    v.el.style.width = `${r.w}px`;
    v.el.style.height = `${r.h}px`;
    v.styleLayers(this.zoom);
  }

  /** Visible part of page i in page units, grown by `grow` (fraction of the viewport). */
  private visiblePageRect(i: number, grow: number): PageRect | null {
    const r = this.rects[i];
    const p = this.session.pages[i];
    const mx = this.vw * grow, my = this.vh * grow;
    const x0 = Math.max(0, this.scroller.scrollLeft - mx - r.x), y0 = Math.max(0, this.scroller.scrollTop - my - r.y);
    const x1 = Math.min(r.w, this.scroller.scrollLeft + this.vw + mx - r.x), y1 = Math.min(r.h, this.scroller.scrollTop + this.vh + my - r.y);
    if (x1 <= x0 || y1 <= y0) return null;
    const inv = invert(pageMatrix(p, this.zoom));
    const a = apply(inv, x0, y0), b = apply(inv, x1, y1);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  }

  fitWidthZoom() {
    const p = this.session.pages[Math.max(0, this.currentPage)] ?? this.session.pages[0];
    const d = displaySize(p);
    if (this.scrollDir === 'horizontal') return Math.min((this.vh - PAD * 2) / d.h, (this.vw - PAD * 2) / d.w);
    return Math.min((this.vw - PAD * 2) / d.w, 4);
  }

  fitWidth(initial = false) {
    const first = this.session.pages[0];
    if (initial && first?.infinite) {
      // an infinite canvas opens at 100% with its starting point (world 0,0) near the top-left,
      // and paper to scroll to in every direction
      this.setZoom(1);
      const r = this.rects[0];
      this.scroller.scrollLeft = Math.max(0, r.x + (0 - (first.ox ?? 0)) - 80);
      this.scroller.scrollTop = Math.max(0, r.y + (0 - (first.oy ?? 0)) - 80);
      this.onScroll();
      return;
    }
    const z = this.fitWidthZoom();
    // Very wide windows would blow a portrait page up past readable; cap first open at 1.6x.
    this.setZoom(initial ? Math.min(z, 1.6) : z);
    if (initial) {
      this.scroller.scrollTop = 0;
      this.scroller.scrollLeft = Math.max(0, (this.scroller.scrollWidth - this.vw) / 2);
      this.onScroll();
    }
  }

  fitPage() {
    const p = this.session.pages[Math.max(0, this.currentPage)];
    const d = displaySize(p);
    this.setZoom(Math.min((this.vw - PAD * 2) / d.w, (this.vh - PAD * 2) / d.h));
    this.scrollToPage(Math.max(0, this.currentPage), false);
  }

  setScrollDir(dir: 'vertical' | 'horizontal') {
    if (dir === this.scrollDir) return;
    const cur = Math.max(0, this.currentPage);
    this.scrollDir = dir;
    this.layout();
    this.scrollToPage(cur, false);
  }

  /** Zoom keeping the page point under (vx, vy) fixed. vx/vy are viewport-local px. */
  setZoom(z: number, anchor?: { vx: number; vy: number }) {
    z = clamp(z, 0.15, 8);
    if (Math.abs(z - this.zoom) < 1e-4 && this.rects.length) return;
    const ax = anchor?.vx ?? this.vw / 2, ay = anchor?.vy ?? this.vh / 2;
    const cx = this.scroller.scrollLeft + ax, cy = this.scroller.scrollTop + ay;
    const i = this.rects.length ? this.pageAt(cx, cy, true) : -1;
    let local: [number, number] | null = null;
    if (i >= 0) {
      const r = this.rects[i];
      local = [(cx - r.x) / this.zoom, (cy - r.y) / this.zoom];
    }
    this.zoom = z;
    this.layout();
    if (i >= 0 && local) {
      const r = this.rects[i];
      this.scroller.scrollLeft = r.x + local[0] * z - ax;
      this.scroller.scrollTop = r.y + local[1] * z - ay;
    }
    this.zooming = true;
    if (this.zoomSettle) clearTimeout(this.zoomSettle);
    this.zoomSettle = setTimeout(() => {
      this.zooming = false;
      this.renderLive();
      this.requestRender();
    }, 140);
    this.requestRender();
    this.cb.onZoom(z, this.fitWidthZoom());
    this.emitSelection();
    this.emitView();
  }

  zoomBy(f: number) {
    this.setZoom(this.zoom * f);
  }

  scrollToPage(i: number, smooth = true, pageY?: number) {
    const r = this.rects[clamp(i, 0, this.rects.length - 1)];
    if (!r) return;
    if (this.scrollDir === 'vertical') {
      const top = pageY != null ? r.y + pageY * this.zoom - this.vh / 3 : r.y - PAD / 2;
      this.scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    } else this.scroller.scrollTo({ left: r.x - PAD / 2, behavior: smooth ? 'smooth' : 'auto' });
    if (!smooth) this.onScroll();
  }

  get pageIndexNow() {
    return Math.max(0, this.currentPage);
  }

  /** Index of the page containing content point (x, y); with `nearest`, the closest page. */
  private pageAt(x: number, y: number, nearest = false): number {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
      if (nearest) {
        const d = this.scrollDir === 'vertical' ? Math.abs(y - (r.y + r.h / 2)) : Math.abs(x - (r.x + r.w / 2));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }

  private updateVisible() {
    const sl = this.scroller.scrollLeft, st = this.scroller.scrollTop;
    const margin = (this.scrollDir === 'vertical' ? this.vh : this.vw) * 1.5;
    const want = new Set<string>();
    let bestI = -1, bestArea = 0;
    this.rects.forEach((r, i) => {
      const vis = r.x + r.w > sl - margin && r.x < sl + this.vw + margin && r.y + r.h > st - margin && r.y < st + this.vh + margin;
      if (vis) want.add(this.session.pages[i].id);
      const ix = Math.max(0, Math.min(r.x + r.w, sl + this.vw) - Math.max(r.x, sl));
      const iy = Math.max(0, Math.min(r.y + r.h, st + this.vh) - Math.max(r.y, st));
      if (ix * iy > bestArea) {
        bestArea = ix * iy;
        bestI = i;
      }
    });
    for (const [id, v] of this.views) {
      if (!want.has(id)) {
        v.destroy();
        this.views.delete(id);
      }
    }
    for (const id of want) {
      if (this.views.has(id)) continue;
      const p = this.session.page(id)!;
      const v = new PageView(p);
      this.views.set(id, v);
      this.placeView(v);
      this.content.append(v.el);
      if (this.liveDecos.get(id)?.length) this.renderLivePage(v);
      void this.session.ensure(id).then(() => {
        v.dirtyInk = true;
        this.requestRender();
      });
    }
    if (this.highlights && this.views.has(this.highlights.pageId) && !this.views.get(this.highlights.pageId)!.marks.childElementCount) this.renderHighlights();
    if (bestI >= 0 && bestI !== this.currentPage) {
      this.currentPage = bestI;
      this.cb.onPageChange(bestI);
    }
    this.requestRender();
  }

  // ---- painting -----------------------------------------------------------------------------

  requestRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.paint();
    });
  }

  /** Is page i on screen (or within a quarter screen of it)? Off-screen pages render at low resolution. */
  /** Diagnostics for the flash test: visible PDF pages that are blank or not yet sharp. */
  debugFrameStats() {
    let blank = 0, blurry = 0, visible = 0;
    const reasons: string[] = [];
    const target = this.zoom * (window.devicePixelRatio || 1);
    const sl = this.scroller.scrollLeft, st = this.scroller.scrollTop;
    for (const v of this.views.values()) {
      const r = this.rects[this.session.pageIndex(v.page.id)];
      const hasPdf = v.page.bg?.type === 'pdf' || !!this.session.content(v.page.id)?.objects.some((o) => o.type === 'pdf');
      if (!r || r.y + r.h < st || r.y > st + this.vh || r.x + r.w < sl || r.x > sl + this.vw || !hasPdf) continue;
      visible++;
      if (!v.rasterOk || v.scale === 0) blank++;
      else if (!v.sharp || v.scale < target * 0.98) {
        blurry++;
        reasons.push(`${!v.sharp ? 'not-sharp' : 'low-scale'} sc=${v.scale.toFixed(2)}/${target.toFixed(2)} job=${v.jobKey ? 'pending' : '-'} ready=${v.readyKey ? 'y' : 'n'} near=${v.near}`);
      }
    }
    return { visible, blank, blurry, reasons };
  }

  private nearScreen(i: number): boolean {
    const r = this.rects[i];
    if (!r) return false;
    // half a screen ahead: at reading speed that is ~250 ms to render (a render takes ~50 ms)
    const mx = this.vw * 0.5, my = this.vh * 0.5;
    const sl = this.scroller.scrollLeft, st = this.scroller.scrollTop;
    return r.x + r.w > sl - mx && r.x < sl + this.vw + mx && r.y + r.h > st - my && r.y < st + this.vh + my;
  }

  /** Scale and covered area a page should have right now. */
  private wantedGeometry(v: PageView, i: number) {
    const p = v.page;
    const dpr = window.devicePixelRatio || 1;
    const target = this.zoom * dpr;
    const fullFits = p.w * p.h * target * target <= MAX_CANVAS_PX;
    if (fullFits) {
      // quarter resolution (1/16 of the memory) until the page comes near the window
      const sc = this.nearScreen(i) ? target : Math.max(0.25, target / 2);
      return { sc, region: { x: p.ox ?? 0, y: p.oy ?? 0, w: p.w, h: p.h } as PageRect, full: true };
    }
    // zoomed far in: cover only what is on screen (plus a margin) at full sharpness
    const core = this.visiblePageRect(i, 0);
    const cur = v.region;
    const covered = !!core && !!cur && !v.full && Math.abs(target - v.scale) / target < 0.02 && core.x >= cur.x - 0.5 && core.y >= cur.y - 0.5 && core.x + core.w <= cur.x + cur.w + 0.5 && core.y + core.h <= cur.y + cur.h + 0.5;
    // smaller margin on high-DPI screens: each extra screen-width costs 4x the pixels there
    const region = covered ? cur : this.visiblePageRect(i, dpr >= 1.75 ? 0.15 : 0.4);
    return { sc: target, region, full: false };
  }

  private applyGeometry(v: PageView, sc: number, region: PageRect, full: boolean, key: string) {
    const m1 = pageMatrix(v.page, 1);
    const a = apply(m1, region.x, region.y), b = apply(m1, region.x + region.w, region.y + region.h);
    v.disp = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    v.region = region;
    v.full = full;
    const W = Math.max(1, Math.round(v.disp.w * sc)), H = Math.max(1, Math.round(v.disp.h * sc));
    v.cw = W;
    v.ch = H;
    for (const c of v.layers()) {
      if (c === v.ink) continue; // sized in paintInk, only when the page has ink
      c.width = W;
      c.height = H;
    }
    v.ink.width = v.ink.height = 0;
    v.styleLayers(this.zoom);
    v.scale = sc;
    v.geomKey = key;
    v.dirtyBg = v.dirtyInk = true;
  }

  /** Start rendering the PDF background for a geometry; the swap happens when it is ready. */
  private preparePdf(v: PageView, key: string, sc: number, region: PageRect, full: boolean) {
    if (v.jobKey === key || v.page.bg?.type !== 'pdf') return;
    v.jobKey = key;
    const p = v.page;
    const job = full ? loadPdfBackground(p, sc, this.session) : loadPdfRegion(p, sc, region, this.session);
    void job.then((bmp) => {
      if (v.jobKey !== key) return;
      v.jobKey = '';
      v.readyKey = key;
      v.readyBmp = bmp;
      this.requestRender();
    });
  }

  /**
   * Shrink a page that moved away from the window without any PDF work: its current pixels are
   * scaled onto a smaller canvas (instant), the vector ink is simply redrawn.
   */
  private downscaleInPlace(v: PageView, sc: number, key: string) {
    const W = Math.max(1, Math.round(v.disp.w * sc)), H = Math.max(1, Math.round(v.disp.h * sc));
    const nb = document.createElement('canvas');
    nb.className = v.bg.className;
    nb.width = W;
    nb.height = H;
    nb.getContext('2d')!.drawImage(v.bg, 0, 0, W, H);
    v.bg.replaceWith(nb);
    v.bg.width = v.bg.height = 0;
    v.bg = nb;
    v.cw = W;
    v.ch = H;
    v.scale = sc;
    v.geomKey = key;
    v.sharp = false;
    v.styleLayers(this.zoom);
    v.dirtyInk = true;
  }

  private paint() {
    // nearest pages first: their sharp renders are requested (and finish) before the others
    const cy = this.scroller.scrollTop + this.vh / 2, cx = this.scroller.scrollLeft + this.vw / 2;
    const dist = (v: PageView) => {
      const r = this.rects[this.session.pageIndex(v.page.id)];
      return r ? Math.abs(r.y + r.h / 2 - cy) + Math.abs(r.x + r.w / 2 - cx) : Infinity;
    };
    for (const v of [...this.views.values()].sort((a, b) => dist(a) - dist(b))) {
      const p = v.page;
      const content = this.session.content(p.id);
      const i = this.session.pageIndex(p.id);
      const isPdf = p.bg?.type === 'pdf';
      if (!isPdf && !v.previewJob && content?.objects.some((o) => o.type === 'pdf') && !v.objPreviewsDone) {
        v.previewJob = ensureObjectPreviews(content.objects, this.session)
          .then((made) => {
            v.objPreviewsDone = true;
            if (made) {
              v.dirtyBg = true;
              this.requestRender();
            }
          })
          .finally(() => (v.previewJob = null));
      }
      if (isPdf && !v.previewJob && !v.rasterOk) {
        v.previewJob = ensurePdfPreview(p, this.session)
          .then((made) => {
            if (made && !v.sharp) {
              v.dirtyBg = true;
              this.requestRender();
            }
          })
          .finally(() => (v.previewJob = null));
      }
      const near = this.nearScreen(i);
      if (near !== v.near) {
        v.near = near;
        if (v.applyBlend()) v.dirtyInk = true;
      }
      if (!this.zooming || v.scale === 0) {
        const g = this.wantedGeometry(v, i);
        if (!g.region) {
          if (v.region) for (const c of v.layers()) c.width = c.height = 1;
          v.region = null;
          v.geomKey = '';
          continue;
        }
        const key = `${g.sc.toFixed(4)}|${g.region.x.toFixed(1)},${g.region.y.toFixed(1)},${g.region.w.toFixed(1)},${g.region.h.toFixed(1)}`;
        if (key !== v.geomKey) {
          const sameScale = v.scale > 0 && Math.abs(g.sc - v.scale) / g.sc <= 0.02 && v.full && g.full;
          if (sameScale) {
            v.geomKey = key; // a tiny zoom change: keep the current pixels
          } else if (isPdf && v.full && g.full && g.sc < v.scale && v.rasterOk) {
            this.downscaleInPlace(v, g.sc, key); // moving away: no PDF re-render
          } else if (!isPdf && v.scale > 0 && content?.objects.some((o) => o.type === 'pdf')) {
            // placed PDFs: keep the current picture until they are rendered for the new zoom
            if (v.readyKey === key) {
              this.applyGeometry(v, g.sc, g.region, g.full, key);
              v.objBmps = v.readyObjBmps;
              v.readyObjBmps = null;
              v.readyKey = '';
            } else if (v.jobKey !== key) {
              v.jobKey = key;
              void preparePdfObjects(content.objects, this.session, g.sc, g.region).then((held) => {
                if (v.jobKey !== key) return;
                v.jobKey = '';
                v.readyKey = key;
                v.readyObjBmps = held;
                this.requestRender();
              });
            }
          } else if (!isPdf || v.scale === 0) {
            this.applyGeometry(v, g.sc, g.region, g.full, key);
            if (isPdf) this.preparePdf(v, key, g.sc, g.region, g.full);
          } else if (v.readyKey === key) {
            // the sharper PDF raster is ready: swap in one frame
            this.applyGeometry(v, g.sc, g.region, g.full, key);
            v.pdfBmp = v.readyBmp;
            v.pdfRect = g.region;
            v.readyBmp = null;
            v.readyKey = '';
          } else {
            this.preparePdf(v, key, g.sc, g.region, g.full); // keep showing the old pixels meanwhile
          }
        }
      }
      if (!v.region) continue;
      // a sharp raster finished for the geometry already on screen: draw it now
      if (isPdf && v.readyBmp && v.readyKey === v.geomKey) v.dirtyBg = true;
      const base = v.base();
      const exclude = this.hiddenPage === p.id ? this.hidden : undefined;
      if (content && content.objects !== v.objectsRef) {
        v.objectsRef = content.objects;
        v.objPreviewsDone = false;
        v.dirtyBg = true;
      }
      if (v.dirtyBg) {
        if (isPdf && !v.pdfBmp) {
          // need the PDF raster again (objects moved, template changed…): fetch it, keep old pixels
          if (v.readyKey === v.geomKey && v.readyBmp) {
            v.pdfBmp = v.readyBmp;
            v.pdfRect = v.region;
            v.readyBmp = null;
            v.readyKey = '';
          } else if (v.bg.width > 1 && v.geomKey && v.rasterOk) {
            this.preparePdf(v, v.geomKey, v.scale, v.region, v.full);
            if (v.jobKey) {
              if (v.dirtyInk) this.paintInk(v, content, base, exclude);
              continue;
            }
          }
        }
        const ctx = v.bg.getContext('2d')!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, v.bg.width, v.bg.height);
        const bgComplete = drawBackground(ctx, p, v.scale, this.session, v.pdfBmp, base, v.full ? undefined : v.pdfRect, v.full ? undefined : v.region);
        v.rasterOk = !isPdf || bgComplete;
        v.sharp = !isPdf || !!v.pdfBmp;
        let imgsDone = true;
        if (content) {
          setPageTransform(ctx, p, v.scale, base);
          imgsDone = drawImages(ctx, content.objects, this.session, exclude);
          const pdfDone = drawPdfObjects(ctx, content.objects, this.session, v.scale, exclude, (job) => {
            if (v.pdfObjJob) return;
            v.pdfObjJob = job.finally(() => {
              v.pdfObjJob = null;
              v.dirtyBg = true;
              this.requestRender();
            });
          }, v.objBmps ?? undefined, v.full ? undefined : v.region);
          imgsDone = imgsDone && (pdfDone || !!v.pdfObjJob);
          if (!pdfDone) v.rasterOk = false; // a placed PDF is still an empty box
        }
        v.dirtyBg = !imgsDone;
        // the pixels are in the canvas now; the raster itself is not kept per page
        if (isPdf && v.pdfBmp) v.pdfBmp = null;
      }
      if (v.dirtyInk) this.paintInk(v, content, base, exclude);
    }
    this.paintOverlay();
  }

  private paintInk(v: PageView, content: PageContent | undefined, base: Mat, exclude?: Set<string>) {
    if (!content) return;
    const p = v.page;
    v.ensureTape(content.strokes.some((s) => s.kind === 'tape'));
    v.hasHl = content.strokes.some((s) => s.kind === 'highlighter');
    v.applyBlend();
    const hasInk = content.strokes.some((s) => s.kind !== 'tape') || content.objects.some((o) => o.type === 'text');
    v.sizeInk(hasInk);
    if (!hasInk) {
      v.dirtyInk = false;
      if (v.tape) this.paintTape(v, content, base, exclude);
      return;
    }
    const ctx = v.ink.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, v.ink.width, v.ink.height);
    setPageTransform(ctx, p, v.scale, base);
    ctx.save();
    ctx.globalAlpha = v.hlAlpha;
    drawHighlights(ctx, content.strokes, true, exclude);
    ctx.restore();
    drawInk(ctx, content.strokes, exclude);
    drawTexts(ctx, content.objects, exclude);
    if (v.tape) this.paintTape(v, content, base, exclude);
    v.dirtyInk = false;
  }

  private paintTape(v: PageView, content: PageContent, base: Mat, exclude?: Set<string>) {
    const t = v.tape!;
    if (t.width !== v.cw || t.height !== v.ch) {
      t.width = v.cw;
      t.height = v.ch;
    }
    const ctx = t.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, t.width, t.height);
    setPageTransform(ctx, v.page, v.scale, base);
    drawTape(ctx, content.strokes, exclude);
  }

  /** Append one finished stroke to the page layers without repainting the page. */
  private appendStroke(pageId: string, s: Stroke) {
    const v = this.views.get(pageId);
    const c = this.session.content(pageId);
    if (!v || v.scale === 0 || !v.region) return;
    if (s.kind === 'tape') {
      v.dirtyInk = true;
      this.requestRender();
      return;
    }
    if (!v.ink.width) {
      // first ink on this page: allocate the layer and draw everything now, in this frame
      this.paintInk(v, c, v.base(), this.hiddenPage === pageId ? this.hidden : undefined);
      return;
    }
    const ctx = v.ink.getContext('2d')!;
    setPageTransform(ctx, v.page, v.scale, v.base());
    if (s.kind === 'highlighter' && !v.hasHl) {
      // first highlight on this page switches the layer to multiply: redraw it once
      v.dirtyInk = true;
      this.requestRender();
      return;
    }
    if (s.kind === 'highlighter') {
      // slide the new highlight underneath the ink that is already there
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.globalAlpha = v.hlAlpha;
      drawStroke(ctx, s, { highlightBlend: true });
      ctx.restore();
    } else drawStroke(ctx, s, { highlightBlend: true });
  }

  private onSession = (e: SessionEvent) => {
    if (e.type === 'page') {
      const v = this.views.get(e.pageId);
      if (!v) return;
      if (e.change === 'append' && e.stroke) this.appendStroke(e.pageId, e.stroke);
      else {
        // paint() compares the objects array: when only strokes changed, the paper layer stays
        v.dirtyInk = true;
        this.requestRender();
      }
      if (this.sel?.pageId === e.pageId) this.revalidateSelection();
      if (this.highlights?.pageId === e.pageId) this.renderHighlights();
    } else if (e.type === 'pages') {
      let dx = 0, dy = 0;
      for (const [id, v] of this.views) {
        const p = this.session.page(id);
        if (!p) {
          v.destroy();
          this.views.delete(id);
        } else {
          if (p.id === this.session.pages[this.pageIndexNow]?.id) {
            dx = ((v.page.ox ?? 0) - (p.ox ?? 0)) * this.zoom;
            dy = ((v.page.oy ?? 0) - (p.oy ?? 0)) * this.zoom;
          }
          v.setPage(p);
        }
      }
      if (this.sel && !this.session.page(this.sel.pageId)) this.clearSelection();
      this.layout();
      if (dx || dy) {
        // the infinite page grew to the left/top: scroll by the same amount so nothing moves on screen
        this.scroller.scrollLeft += dx;
        this.scroller.scrollTop += dy;
        this.onScroll();
      }
    } else if (e.type === 'doc') {
      for (const v of this.views.values()) v.dirtyBg = true;
      this.requestRender();
    }
  };

  // ---- overlay ------------------------------------------------------------------------------

  /** Page units → overlay device pixels. */
  private overlayMatrix(pageIndex: number): Mat {
    const dpr = window.devicePixelRatio || 1;
    const r = this.rects[pageIndex];
    const p = this.session.pages[pageIndex];
    const m = pageMatrix(p, this.zoom);
    return mul([dpr, 0, 0, dpr, 0, 0], mul(translate(r.x - this.scroller.scrollLeft, r.y - this.scroller.scrollTop), m));
  }

  // The overlay (live ink, lasso, selection, laser) is a full-window canvas. It only holds memory
  // while something is drawn on it, and wakes on pen hover/down before the first stroke frame.
  private overlayAwake = false;
  private overlaySleep: ReturnType<typeof setTimeout> | undefined;

  private wakeOverlay() {
    if (this.overlaySleep) clearTimeout(this.overlaySleep);
    this.overlaySleep = undefined;
    if (this.overlayAwake) return;
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(this.root.clientWidth * dpr);
    this.overlay.height = Math.round(this.root.clientHeight * dpr);
    this.overlayAwake = true;
  }

  private paintOverlay() {
    const busy = !!(this.wet || this.sel || this.lassoPath || this.eraserCursor || this.laser || this.penHover || this.aiPath);
    if (busy) this.wakeOverlay();
    else if (!this.overlayAwake) return;
    else if (!this.overlaySleep)
      this.overlaySleep = setTimeout(() => {
        this.overlaySleep = undefined;
        if (this.wet || this.sel || this.lassoPath || this.eraserCursor || this.laser || this.aiPath) return;
        this.overlay.width = this.overlay.height = 1;
        this.overlayAwake = false;
      }, 4000);
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const dpr = window.devicePixelRatio || 1;

    if (this.wet) {
      const i = this.session.pageIndex(this.wet.pageId);
      if (i >= 0) {
        const m = this.overlayMatrix(i);
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        drawStroke(ctx, this.wet.stroke, this.wet.stroke.kind === 'highlighter' ? { alpha: 1, highlightBlend: false } : {});
      }
    }

    if (this.sel) {
      const i = this.session.pageIndex(this.sel.pageId);
      const c = this.session.content(this.sel.pageId);
      if (i >= 0 && c) {
        const m = mul(this.overlayMatrix(i), this.selMatrix);
        if (!isIdentity(this.selMatrix) || this.hiddenPage === this.sel.pageId) {
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          const objs = c.objects.filter((o) => this.sel!.objectIds.has(o.id));
          drawImages(ctx, objs, this.session);
          drawPdfObjects(ctx, objs, this.session, this.zoom * (window.devicePixelRatio || 1));
          const strokes = c.strokes.filter((s) => this.sel!.strokeIds.has(s.id));
          for (const s of strokes) if (s.kind === 'highlighter') drawStroke(ctx, s);
          drawInk(ctx, strokes);
          drawTexts(ctx, objs);
          drawTape(ctx, strokes);
        }
        // selection frame
        const [x0, y0, x1, y1] = this.sel.bbox;
        const corners = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--c-accent') || '#2f5b8a';
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.beginPath();
        corners.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        for (const [x, y] of this.handlePoints(corners)) {
          ctx.beginPath();
          ctx.rect(x - (HANDLE / 2) * dpr, y - (HANDLE / 2) * dpr, HANDLE * dpr, HANDLE * dpr);
          ctx.fill();
          ctx.stroke();
        }
        const [rx, ry] = this.rotateHandle(corners);
        ctx.beginPath();
        ctx.moveTo((corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2);
        ctx.lineTo(rx, ry);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rx, ry, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    if (this.lassoPath && this.lassoPath.pts.length > 2) {
      const i = this.session.pageIndex(this.lassoPath.pageId);
      const m = this.overlayMatrix(i);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = '#2f5b8a';
      ctx.fillStyle = 'rgba(43, 89, 217, 0.06)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineDashOffset = -performance.now() / 40;
      ctx.beginPath();
      for (let k = 0; k < this.lassoPath.pts.length; k += 2) {
        const [x, y] = apply(m, this.lassoPath.pts[k], this.lassoPath.pts[k + 1]);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.aiPath && this.aiPath.pts.length > 2) this.paintAiPath(ctx, dpr);

    if (this.penHover && !this.wet) {
      // tip preview: a dot the size and colour of the stroke you are about to make
      const hl = this.tools.tool === 'highlighter';
      const w = (hl ? this.tools.hlWidth : this.tools.penWidth) * this.zoom;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = hl ? 0.45 : 0.85;
      ctx.fillStyle = hl ? this.tools.hlColor : this.tools.penColor;
      ctx.beginPath();
      ctx.arc(this.penHover.x * dpr, this.penHover.y * dpr, Math.max(1.5, w / 2) * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = dpr;
      ctx.stroke();
    }

    if (this.eraserCursor) {
      const { x, y, r } = this.eraserCursor;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = 'rgba(80,80,90,.8)';
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, Math.max(3, r) * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (this.laser && this.laser.pts.length) {
      const now = performance.now();
      const m = this.overlayMatrix(this.laser.page);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const pts = this.laser.pts;
      const col = this.tools.laserColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (this.tools.laserMode === 'trail') {
        for (let k = 1; k < pts.length; k++) {
          const age = (now - pts[k].t) / 900;
          if (age >= 1) continue;
          const [ax, ay] = apply(m, pts[k - 1].x, pts[k - 1].y);
          const [bx, by] = apply(m, pts[k].x, pts[k].y);
          ctx.globalAlpha = 1 - age;
          ctx.strokeStyle = col;
          ctx.shadowColor = col;
          ctx.shadowBlur = 12 * dpr;
          ctx.lineWidth = 5 * dpr;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
      const last = pts[pts.length - 1];
      if (now - last.t < 900) {
        const [lx, ly] = apply(m, last.x, last.y);
        ctx.globalAlpha = 1;
        ctx.shadowColor = col;
        ctx.shadowBlur = 16 * dpr;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(lx, ly, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(lx, ly, 2.2 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  private handlePoints(c: [number, number][]): [number, number][] {
    const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return [c[0], mid(c[0], c[1]), c[1], mid(c[1], c[2]), c[2], mid(c[2], c[3]), c[3], mid(c[3], c[0])];
  }

  private rotateHandle(c: [number, number][]): [number, number] {
    const dpr = window.devicePixelRatio || 1;
    const top = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    const bottom = [(c[3][0] + c[2][0]) / 2, (c[3][1] + c[2][1]) / 2];
    const dx = top[0] - bottom[0], dy = top[1] - bottom[1];
    const len = Math.hypot(dx, dy) || 1;
    return [top[0] + (dx / len) * 26 * dpr, top[1] + (dy / len) * 26 * dpr];
  }

  // ---- coordinates --------------------------------------------------------------------------

  private toContent(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.scroller.getBoundingClientRect();
    return [e.clientX - r.left + this.scroller.scrollLeft, e.clientY - r.top + this.scroller.scrollTop];
  }

  private toPage(i: number, cx: number, cy: number): [number, number] {
    const r = this.rects[i];
    const m = invert(pageMatrix(this.session.pages[i], this.zoom));
    return apply(m, cx - r.x, cy - r.y);
  }

  private pagePointFromEvent(i: number, e: { clientX: number; clientY: number }): [number, number] {
    const [cx, cy] = this.toContent(e);
    return this.toPage(i, cx, cy);
  }

  // ---- input --------------------------------------------------------------------------------

  private effectiveTool(e: PointerEvent): Tool {
    if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0)) return 'eraser';
    return this.tools.tool;
  }

  private touchDraws() {
    return this.tools.stylusMode === 'touch' || (this.tools.stylusMode === 'auto' && !this.penSeen);
  }

  /** The pointer that owns the current action; every other pointer is ignored until it lifts. */
  private actionPointer = -1;
  private actionType = '';
  private penNearAt = -1e9;

  private onDown = (e: PointerEvent) => {
    this.wakeOverlay();
    // Palm rejection: while the pen is writing or hovering, touches are resting hands, not input.
    if (e.pointerType === 'touch' && ((this.action && this.actionType === 'pen') || performance.now() - this.penNearAt < 500)) return;
    const had = this.action;
    this.downImpl(e);
    if (this.action && this.action !== had) {
      this.actionPointer = e.pointerId;
      this.actionType = e.pointerType;
      markInput(true);
    }
  };

  private downImpl(e: PointerEvent) {
    this.scroller.focus({ preventScroll: true });
    if (e.pointerType === 'pen') {
      if (!this.penSeen) this.cb.onPenSeen?.();
      this.penSeen = true;
      this.penNearAt = performance.now();
      this.setPenHover(null);
    }
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.capture(e.pointerId);
      if (this.touches.size === 2) {
        this.action?.cancel();
        this.action = null;
        this.startPinch();
        return;
      }
      if (!this.touchDraws() || this.touches.size > 1) {
        // fingers scroll here, but a finger on the selection still moves it, and holding a finger
        // still on a placed PDF page or image picks it up, just like the pen and mouse can
        if (this.touches.size === 1) {
          const [cx, cy] = this.toContent(e);
          const i = this.pageAt(cx, cy);
          if (i >= 0) {
            const pageId = this.session.pages[i].id;
            const hit = this.sel && this.sel.pageId === pageId ? this.hitSelection(e) : null;
            if (hit) {
              e.preventDefault();
              this.action = this.transformAction(e, i, hit);
              return;
            }
            this.armLongPress(e, i, pageId);
          }
        }
        this.action = this.panAction(e);
        return;
      }
    }
    if (this.action) return;
    if (e.button === 1 || this.spaceDown) {
      e.preventDefault();
      this.capture(e.pointerId);
      this.action = this.panAction(e);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const tool = this.effectiveTool(e);
    if (tool !== this.tools.tool) {
      this.tempActive = true;
      this.cb.onTempTool(tool);
    }
    if (this.textEdit) {
      const inside = (e.target as HTMLElement).closest?.('.gi-text-editor');
      if (inside) return;
      const was = this.textEdit.obj.id;
      this.commitTextEdit();
      if (tool === 'text') {
        // straight into another text box (or drag it); a click on empty paper only ends the edit
        const [px, py] = this.toContent(e);
        const k = this.pageAt(px, py);
        const [x, y] = k < 0 ? [0, 0] : this.toPage(k, px, py);
        const t = k < 0 ? undefined : this.textAt(this.session.pages[k].id, x, y);
        if (!t || t.id === was) return;
      }
    }
    const [cx, cy] = this.toContent(e);
    const i = this.pageAt(cx, cy);
    if (i < 0) {
      if (this.sel && tool === 'lasso') this.clearSelection();
      return;
    }
    e.preventDefault();
    this.capture(e.pointerId);
    const pageId = this.session.pages[i].id;
    if (this.sel && this.sel.pageId === pageId && tool !== 'eraser') {
      const hit = this.hitSelection(e);
      if (hit) {
        this.action = this.transformAction(e, i, hit);
        return;
      }
    }
    if (this.sel && tool !== 'lasso' && tool !== 'text') this.clearSelection();
    this.armLongPress(e, i, pageId);
    if (this.cb.onPenActivity && (tool === 'pen' || tool === 'shape' || tool === 'eraser')) {
      // the live check holds red marks near where you are writing (numbers only, no allocation later)
      const [px, py] = this.pagePointFromEvent(i, e);
      this.actPage = pageId;
      this.actX = px;
      this.actY = py;
      // cached so moves can report the pen position with plain arithmetic (no allocation)
      const sr = this.scroller.getBoundingClientRect(), r = this.rects[i];
      this.actInv = invert(pageMatrix(this.session.pages[i], this.zoom));
      this.actOX = sr.left - this.scroller.scrollLeft + r.x;
      this.actOY = sr.top - this.scroller.scrollTop + r.y;
      this.actT = e.timeStamp;
      this.cb.onPenActivity(pageId, px, py, true);
    }
    switch (tool) {
      case 'pen':
      case 'highlighter':
      case 'shape':
        this.action = this.inkAction(e, i, pageId, tool);
        break;
      case 'eraser':
        this.action = this.eraserAction(e, i, pageId);
        break;
      case 'lasso':
      case 'image':
        this.action = this.lassoAction(e, i, pageId, tool === 'image');
        break;
      case 'text':
        this.action = this.textClick(e, i, pageId);
        break;
      case 'tape':
        this.action = this.tapeAction(e, i, pageId);
        break;
      case 'laser':
        this.action = this.laserAction(e, i);
        break;
      case 'ai':
        this.action = this.aiAction(e, i, pageId);
        break;
    }
  }

  private capture(id: number) {
    try {
      this.scroller.setPointerCapture(id);
    } catch {
      /* pointer already gone (e.g. lifted before we got here) */
    }
  }

  // ---- placed media (images, PDF pages): right-click or long-press to pick up ---------------

  private longPress: ReturnType<typeof setTimeout> | undefined;

  /** Topmost image or PDF object under a page point. */
  private placedAt(pageId: string, x: number, y: number, also = false): PageObject | undefined {
    const c = this.session.content(pageId);
    return c ? [...c.objects].reverse().find((o) => (also ? isGrabbable(o) : isPlaced(o)) && bboxHit(objectBBox(o), x, y)) : undefined;
  }

  private textAt(pageId: string, x: number, y: number): TextObject | undefined {
    const c = this.session.content(pageId);
    return c ? ([...c.objects].reverse().find((o) => o.type === 'text' && bboxHit(objectBBox(o), x, y, 2)) as TextObject | undefined) : undefined;
  }

  private selectPlaced(pageId: string, o: PageObject) {
    this.setSelection({ pageId, strokeIds: new Set(), objectIds: new Set([o.id]), bbox: objectBBox(o) });
  }

  private armLongPress(e: PointerEvent, i: number, pageId: string) {
    if (this.longPress) clearTimeout(this.longPress);
    const [x, y] = this.pagePointFromEvent(i, e);
    // the text tool moves text by dragging it, no need to hold
    const target = this.placedAt(pageId, x, y, this.tools.tool !== 'text');
    if (!target) {
      if (e.pointerType === 'touch' && this.cb.onInkContext && this.inkNear(pageId, x, y)) this.armInkPress(e, pageId, x, y);
      return;
    }
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let lastX = sx, lastY = sy;
    const track = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (Math.hypot(lastX - sx, lastY - sy) > 8) stop();
    };
    const stop = () => {
      if (this.longPress) clearTimeout(this.longPress);
      this.longPress = undefined;
      this.scroller.removeEventListener('pointermove', track);
      this.scroller.removeEventListener('pointerup', stop);
    };
    this.scroller.addEventListener('pointermove', track);
    this.scroller.addEventListener('pointerup', stop);
    this.longPress = setTimeout(() => {
      stop();
      // held still on a placed PDF/image: drop whatever the tool started and pick the object up
      this.action?.cancel();
      this.action = null;
      this.selectPlaced(pageId, target);
      const fake = { clientX: lastX, clientY: lastY, pointerId: pid } as PointerEvent;
      this.action = this.transformAction(fake, i, { kind: 'move' });
      this.actionPointer = pid;
      navigator.vibrate?.(15);
    }, 480);
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const [cx, cy] = this.toContent(e);
    const i = this.pageAt(cx, cy);
    if (i < 0) return;
    const pageId = this.session.pages[i].id;
    const [x, y] = this.toPage(i, cx, cy);
    const o = this.placedAt(pageId, x, y, true);
    if (o) {
      if (this.textEdit) this.commitTextEdit();
      this.action?.cancel();
      this.action = null;
      this.selectPlaced(pageId, o);
      return;
    }
    // a click inside the current selection keeps the selection (and its menu)
    if (this.sel && this.sel.pageId === pageId && this.hitSelection(e as PointerEvent)) return;
    if (this.cb.onInkContext && this.inkNear(pageId, x, y)) {
      // a pen barrel click arrives as a (temporary) eraser touch first: undo whatever it started
      this.action?.cancel();
      this.action = null;
      if (this.tempActive) {
        this.tempActive = false;
        this.cb.onTempTool(null);
      }
      this.hideLiveTip();
      this.cb.onInkContext(pageId, x, y, e.clientX, e.clientY);
    }
  };

  /** Handwriting (pen strokes) at or right next to a page point. */
  private inkNear(pageId: string, x: number, y: number): boolean {
    const c = this.session.content(pageId);
    if (!c) return false;
    const pad = 10 / this.zoom + 2;
    for (const s of c.strokes) if (s.kind === 'pen' && bboxHit(s.bbox, x, y, pad)) return true;
    return false;
  }

  /** Touch held still on handwriting: open its insight after 450 ms, with a small pulse. */
  private armInkPress(e: PointerEvent, pageId: string, x: number, y: number) {
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    const track = (ev: PointerEvent) => {
      if (ev.pointerId === pid && Math.hypot(ev.clientX - sx, ev.clientY - sy) > LIVE_TUNING.longPressSlopPx) stop();
    };
    const stop = () => {
      if (this.longPress) clearTimeout(this.longPress);
      this.longPress = undefined;
      this.scroller.removeEventListener('pointermove', track);
      this.scroller.removeEventListener('pointerup', stop);
      this.scroller.removeEventListener('pointercancel', stop);
    };
    this.scroller.addEventListener('pointermove', track);
    this.scroller.addEventListener('pointerup', stop);
    this.scroller.addEventListener('pointercancel', stop);
    this.longPress = setTimeout(() => {
      stop();
      if (this.touches.size > 1 || this.pinch) return;
      // drop the pan (or the dot a drawing finger started) and open the card
      this.action?.cancel();
      this.action = null;
      this.pulseAt(sx, sy);
      navigator.vibrate?.(12);
      this.cb.onInkContext?.(pageId, x, y, sx, sy);
    }, LIVE_TUNING.longPressMs);
  }

  /** A soft ring under the finger, the visual stand-in for a haptic tick. */
  pulseAt(clientX: number, clientY: number) {
    const r = this.root.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'gi-live-pulse';
    d.style.left = `${clientX - r.left}px`;
    d.style.top = `${clientY - r.top}px`;
    this.root.append(d);
    const done = () => d.remove();
    d.addEventListener('animationend', done);
    setTimeout(done, 700);
  }

  /** Place PDF pages onto a page as objects, stacked top to bottom from `at` (page units). */
  placePdfPages(pageId: string, assetId: string, sizes: { w: number; h: number }[], at?: [number, number], fit = false) {
    const i = this.session.pageIndex(pageId);
    const p = this.session.pages[i];
    const ox = p.ox ?? 0, oy = p.oy ?? 0;
    let [x, y] = at ?? this.visibleTopLeft(i);
    const objs: PdfObject[] = [];
    sizes.forEach((sz, k) => {
      let w = sz.w, h = sz.h;
      if (fit) {
        const f = Math.min((p.w * 0.9) / w, (p.h * 0.9) / h, 1);
        w *= f;
        h *= f;
        x = ox + (p.w - w) / 2;
        y = oy + (p.h - h) / 2;
      }
      objs.push({ id: uid(), type: 'pdf', x, y, w, h, rot: 0, asset: assetId, page: k, pw: sz.w, ph: sz.h });
      y += h + 40;
    });
    const c = this.session.content(pageId) ?? { strokes: [], objects: [] };
    this.session.commit(pageId, { ...c, objects: [...c.objects, ...objs] });
    return objs;
  }

  private visibleTopLeft(i: number): [number, number] {
    const r = this.rects[i];
    const cx = clamp(this.scroller.scrollLeft + 60, r.x, r.x + r.w);
    const cy = clamp(this.scroller.scrollTop + 60, r.y, r.y + r.h);
    return this.toPage(i, cx, cy);
  }

  private rawSeen = false;

  /** pointerrawupdate fires as soon as the digitiser reports, not once per frame. */
  /** pen hovering above the screen: show where (and how thick, which colour) ink would land */
  private setPenHover(e: PointerEvent | null) {
    const inkTool = this.tools.tool === 'pen' || this.tools.tool === 'highlighter' || this.tools.tool === 'shape';
    if (e && inkTool && !this.action) {
      const r = this.scroller.getBoundingClientRect();
      this.penHover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.scroller.style.cursor = 'none';
    } else {
      if (!this.penHover) return;
      this.penHover = null;
      this.scroller.style.cursor = '';
    }
    this.paintOverlay();
  }

  private onRawMove = (e: PointerEvent) => {
    this.rawSeen = true;
    if (e.pointerType === 'pen' && e.buttons === 0 && !this.action) this.setPenHover(e);
    else if (e.pointerType === 'mouse' && this.penHover) this.setPenHover(null);
    if (e.pointerType === 'pen' && !this.overlayAwake) this.wakeOverlay(); // pen hovering: about to write
    if (e.pointerType === 'pen') this.penNearAt = performance.now();
    if (this.action?.raw && e.pointerId === this.actionPointer) {
      markInput();
      this.action.move(e);
    }
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.penNearAt = performance.now();
    if (this.actPage && e.timeStamp - this.actT >= 16 && e.pointerId === this.actionPointer) {
      // the live check keeps red away from where the pen is busy: at most once a frame, numbers only
      const m = this.actInv, cx = e.clientX - this.actOX, cy = e.clientY - this.actOY;
      this.actT = e.timeStamp;
      this.actX = m[0] * cx + m[2] * cy + m[4];
      this.actY = m[1] * cx + m[3] * cy + m[5];
      this.cb.onPenActivity?.(this.actPage, this.actX, this.actY, true);
    }
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) return this.updatePinch();
    }
    if (this.action) {
      if (e.pointerId !== this.actionPointer) return;
      markInput();
      if (this.action.raw && this.rawSeen) return;
      this.action.move(e);
    } else if (e.pointerType !== 'touch' && (this.tools.tool === 'eraser' || this.effectiveTool(e) === 'eraser') && e.buttons === 0) {
      // hover cursor for the eraser
      const r = this.scroller.getBoundingClientRect();
      this.eraserCursor = { x: e.clientX - r.left, y: e.clientY - r.top, r: (this.tools.eraserWidth / 2) * this.zoom };
      this.paintOverlay();
    } else if (this.eraserCursor) {
      this.eraserCursor = null;
      this.paintOverlay();
    }
    if (!this.action && e.buttons === 0 && e.pointerType !== 'touch' && (this.liveTipId || this.liveDecos.size)) this.liveHover(e);
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinch && this.touches.size < 2) {
        this.pinch = null;
        if (this.touches.size === 1) {
          const [id, t] = [...this.touches][0];
          this.action = this.panAction({ clientX: t.x, clientY: t.y, pointerId: id } as PointerEvent);
          this.actionPointer = id;
          this.actionType = 'touch';
        }
        return;
      }
    }
    if (!this.action || e.pointerId !== this.actionPointer) return;
    markInput(false);
    const a = this.action;
    this.action = null;
    a?.up(e);
    if (this.livePending.size) this.flushLive();
    if (this.actPage) {
      this.cb.onPenActivity?.(this.actPage, this.actX, this.actY, false);
      this.actPage = '';
    }
    if (this.tempActive) {
      this.tempActive = false;
      this.cb.onTempTool(null);
    }
  };

  private onCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.action && e.pointerId !== this.actionPointer) return;
    markInput(false);
    this.action?.cancel();
    this.action = null;
    this.pinch = null;
    if (this.livePending.size) this.flushLive();
  };

  private onLostCapture = (e: PointerEvent) => {
    if (this.action && e.pointerType !== 'touch' && e.pointerId === this.actionPointer) {
      markInput(false);
      // Some pen drivers drop capture at the end of a stroke instead of sending pointerup.
      const a = this.action;
      this.action = null;
      a.up(e);
      if (this.livePending.size) this.flushLive();
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = this.scroller.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.setZoom(this.zoom * Math.exp(-dy * 0.0022), { vx: e.clientX - r.left, vy: e.clientY - r.top });
    } else if (this.scrollDir === 'horizontal' && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.scroller.scrollHeight <= this.scroller.clientHeight + 2) {
      e.preventDefault();
      this.scroller.scrollLeft += e.deltaY;
    }
  };

  private onScroll = () => {
    this.updateVisible();
    this.requestRender();
    this.emitSelection();
    if (this.textEdit) this.positionTextEditor();
    this.hideLiveTip();
    this.emitView();
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !(e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable]')) {
      this.spaceDown = e.type === 'keydown';
      this.scroller.classList.toggle('gi-grab', this.spaceDown);
    }
  };

  private onDblClick = (e: MouseEvent) => {
    const [cx, cy] = this.toContent(e);
    const i = this.pageAt(cx, cy);
    if (i < 0) return;
    const [x, y] = this.toPage(i, cx, cy);
    const pageId = this.session.pages[i].id;
    const c = this.session.content(pageId);
    const t = c && [...c.objects].reverse().find((o) => o.type === 'text' && bboxHit(objectBBox(o), x, y));
    if (t && (this.tools.tool === 'lasso' || this.tools.tool === 'text')) {
      this.clearSelection();
      this.editText(pageId, t as TextObject, false);
    }
  };

  private panAction(e: PointerEvent): Action {
    let lx = e.clientX, ly = e.clientY;
    const id = e.pointerId;
    const sx = e.clientX, sy = e.clientY;
    let far = false;
    this.scroller.classList.add('gi-grabbing');
    return {
      move: (ev) => {
        if (ev.pointerId !== id) return;
        this.scroller.scrollLeft -= ev.clientX - lx;
        this.scroller.scrollTop -= ev.clientY - ly;
        lx = ev.clientX;
        ly = ev.clientY;
        if (Math.hypot(lx - sx, ly - sy) > 10) far = true;
      },
      up: () => {
        this.scroller.classList.remove('gi-grabbing');
        // a finger tap next to a selection (or a picked-up PDF page) puts it down, like a pen tap does
        if (e.pointerType === 'touch' && !far && this.sel) this.clearSelection();
      },
      cancel: () => this.scroller.classList.remove('gi-grabbing'),
    };
  }

  private startPinch() {
    const [a, b] = [...this.touches.values()];
    const r = this.scroller.getBoundingClientRect();
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
  }

  private updatePinch() {
    if (!this.pinch || this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()];
    const r = this.scroller.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    this.scroller.scrollLeft -= cx - this.pinch.cx;
    this.scroller.scrollTop -= cy - this.pinch.cy;
    this.pinch.cx = cx;
    this.pinch.cy = cy;
    this.setZoom(this.pinch.zoom * (d / this.pinch.dist), { vx: cx, vy: cy });
  }

  // ---- ink ----------------------------------------------------------------------------------

  private inkAction(e: PointerEvent, i: number, pageId: string, tool: 'pen' | 'highlighter' | 'shape'): Action {
    const t = this.tools;
    const isHl = tool === 'highlighter';
    const kind = isHl ? 'highlighter' : 'pen';
    const color = isHl ? t.hlColor : t.penColor;
    const width = isHl ? t.hlWidth : t.penWidth;
    const pts: number[] = [];
    let prev: { x: number; y: number; t: number } | null = null;
    let prevP = 0.5;
    const id = uid();
    let locked: { pts: Float32Array; closed: boolean; kind: string } | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let lastMoveAt = { x: e.clientX, y: e.clientY };
    const page = this.session.pages[i];
    const pointerType = e.pointerType;
    const minDist = 0.35 / this.zoom;

    const add = (ev: PointerEvent, into: number[]) => {
      let [x, y] = this.pagePointFromEvent(i, ev);
      x = clamp(x, (page.ox ?? 0) - 20, (page.ox ?? 0) + page.w + 20);
      y = clamp(y, (page.oy ?? 0) - 20, (page.oy ?? 0) + page.h + 20);
      let p: number;
      if (pointerType === 'pen' && t.pressure && ev.pressure > 0) p = curvePressure(ev.pressure);
      else if (pointerType === 'pen') p = 0.55;
      else {
        p = velocityPressure(prev, x, y, ev.timeStamp, prevP);
        prevP = p;
      }
      if (into === pts) {
        if (prev && Math.hypot(x - prev.x, y - prev.y) < minDist) return;
        prev = { x, y, t: ev.timeStamp };
      }
      into.push(x, y, p);
    };

    const straight = () => isHl && t.straightHighlighter;
    const build = (arr: number[], last: boolean): Stroke => {
      let use = arr;
      if (straight() && arr.length >= 6) use = [arr[0], arr[1], 0.5, arr[arr.length - 3], arr[arr.length - 2], 0.5];
      if (locked) return makeStroke({ id, kind, pen: t.penKind, color, width, pts: locked.pts, shape: true, closed: locked.closed });
      void last;
      return makeStroke({ id, kind, pen: t.penKind, color, width, pts: new Float32Array(use), shape: isHl && straight() ? true : undefined });
    };

    const tryLock = () => {
      if (locked || pts.length < 12) return;
      if (isHl) {
        // highlighter: hold → straight line
        locked = { pts: new Float32Array([pts[0], pts[1], 0.5, pts[pts.length - 3], pts[pts.length - 2], 0.5]), closed: false, kind: 'line' };
      } else {
        const r = recognizeShape(new Float32Array(pts));
        if (!r) return;
        locked = { pts: r.pts, closed: r.closed, kind: r.kind };
      }
      this.wet = { pageId, stroke: build(pts, false) };
      this.paintOverlay();
    };

    const armHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (tool === 'shape' || !t.holdToShape) return;
      holdTimer = setTimeout(tryLock, t.holdDelay);
    };

    // Points are collected and drawn on every (raw) pointer update.
    let predicted: number[] = [];
    let raf = 0;
    const paintWet = () => {
      raf = 0;
      if (!this.wet) return;
      this.wet = { pageId, stroke: build(predicted.length ? pts.concat(predicted) : pts, false) };
      this.paintOverlay();
    };
    // Draw right away on every pen sample (not once per frame): a sample that arrives just after a
    // frame started still makes it into the next one, instead of waiting a whole extra frame.
    const schedule = () => paintWet();

    add(e, pts);
    this.wet = { pageId, stroke: build(pts, false) };
    this.paintOverlay();
    armHold();

    return {
      raw: true,
      move: (ev) => {
        if (locked) {
          // after a snap, a straight line keeps following the pen like a rubber band
          if (locked.kind === 'line') {
            const [x, y] = this.pagePointFromEvent(i, ev);
            locked.pts = new Float32Array([locked.pts[0], locked.pts[1], 0.5, x, y, 0.5]);
            schedule();
          }
          return;
        }
        const evs = ev.getCoalescedEvents?.() ?? [];
        for (const ce of evs.length ? evs : [ev]) add(ce, pts);
        predicted = [];
        for (const pe of ev.getPredictedEvents?.() ?? []) add(pe, predicted);
        schedule();
        if (Math.hypot(ev.clientX - lastMoveAt.x, ev.clientY - lastMoveAt.y) > 2.5) {
          lastMoveAt = { x: ev.clientX, y: ev.clientY };
          armHold();
        }
      },
      up: (ev) => {
        if (holdTimer) clearTimeout(holdTimer);
        cancelAnimationFrame(raf);
        if (!locked && ev && ev.clientX != null) {
          // the lift point itself, with the last real pressure (pressure reads 0 on lift)
          const [x, y] = this.pagePointFromEvent(i, ev);
          const n = pts.length;
          if (n >= 3 && Math.hypot(x - pts[n - 3], y - pts[n - 2]) >= minDist) pts.push(clamp(x, (page.ox ?? 0) - 20, (page.ox ?? 0) + page.w + 20), clamp(y, (page.oy ?? 0) - 20, (page.oy ?? 0) + page.h + 20), pts[n - 1]);
        }
        if (tool === 'shape' && !locked) {
          const r = pts.length >= 12 ? recognizeShape(new Float32Array(pts)) : null;
          if (r) locked = { pts: r.pts, closed: r.closed, kind: r.kind };
        }
        let stroke = build(pts, true);
        if (pts.length === 3) {
          // a tap: make a dot
          stroke = makeStroke({ ...stroke, pts: new Float32Array([pts[0], pts[1], pts[2], pts[0] + 0.01, pts[1] + 0.01, pts[2]]) });
        }
        this.wet = null;
        const c = this.session.content(pageId) ?? { strokes: [], objects: [] };
        this.session.commit(pageId, { ...c, strokes: [...c.strokes, stroke] }, { change: 'append', stroke });
        this.paintOverlay();
      },
      cancel: () => {
        if (holdTimer) clearTimeout(holdTimer);
        cancelAnimationFrame(raf);
        this.wet = null;
        this.paintOverlay();
      },
    };
  }

  // ---- eraser -------------------------------------------------------------------------------

  private eraserAction(e: PointerEvent, i: number, pageId: string): Action {
    const t = this.tools;
    const before = this.session.content(pageId) ?? { strokes: [], objects: [] };
    let cur = before;
    let last = this.pagePointFromEvent(i, e);
    const r = t.eraserWidth / 2;
    let changed = false;
    let raf = 0;

    const hits = (s: Stroke, ax: number, ay: number, bx: number, by: number) => {
      const rr = r + s.width / 2;
      const sb: BBox = [Math.min(ax, bx) - rr, Math.min(ay, by) - rr, Math.max(ax, bx) + rr, Math.max(ay, by) + rr];
      if (!bboxOverlap(s.bbox, sb)) return false;
      const p = s.pts;
      if (p.length === 3) return distToSegSq(p[0], p[1], ax, ay, bx, by) <= rr * rr;
      for (let k = 3; k < p.length; k += 3) {
        // distance from eraser segment to stroke segment, approximated by both endpoints + midpoint
        const mx = (p[k - 3] + p[k]) / 2, my = (p[k - 2] + p[k + 1]) / 2;
        if (distToSegSq(p[k], p[k + 1], ax, ay, bx, by) <= rr * rr || distToSegSq(mx, my, ax, ay, bx, by) <= rr * rr || distToSegSq(p[k - 3], p[k - 2], ax, ay, bx, by) <= rr * rr) return true;
      }
      return false;
    };

    const densify = (s: Stroke): Float32Array => {
      const out: number[] = [];
      const p = s.pts;
      const step = Math.max(0.8, r / 3);
      for (let k = 0; k < p.length; k += 3) {
        if (k) {
          const dx = p[k] - p[k - 3], dy = p[k + 1] - p[k - 2];
          const n = Math.floor(Math.hypot(dx, dy) / step);
          for (let j = 1; j < n; j++) out.push(p[k - 3] + (dx * j) / n, p[k - 2] + (dy * j) / n, p[k + 2]);
        }
        out.push(p[k], p[k + 1], p[k + 2]);
      }
      return new Float32Array(out);
    };

    const split = (s: Stroke, ax: number, ay: number, bx: number, by: number): Stroke[] => {
      const p = s.shape ? densify(s) : s.pts;
      const rr = r + s.width * 0.35;
      const out: Stroke[] = [];
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 6) out.push(makeStroke({ ...s, id: uid(), pts: new Float32Array(run), closed: false }));
        run = [];
      };
      for (let k = 0; k < p.length; k += 3) {
        if (distToSegSq(p[k], p[k + 1], ax, ay, bx, by) <= rr * rr) flush();
        else run.push(p[k], p[k + 1], p[k + 2]);
      }
      flush();
      return out;
    };

    // the pen's barrel button erases while dragging; a barrel click without moving is a right-click
    // (it opens the insight card), so it must not erase what it clicked on
    let armed = !(e.pointerType === 'pen' && this.tools.tool !== 'eraser');
    const sx = e.clientX, sy = e.clientY;
    const step = (ev: PointerEvent) => {
      if (!armed && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) armed = true;
      if (!armed) {
        const rr = this.scroller.getBoundingClientRect();
        this.eraserCursor = { x: ev.clientX - rr.left, y: ev.clientY - rr.top, r: r * this.zoom };
        this.paintOverlay();
        return;
      }
      const [x, y] = this.pagePointFromEvent(i, ev);
      const [ax, ay] = last;
      last = [x, y];
      const next: Stroke[] = [];
      let any = false;
      for (const s of cur.strokes) {
        if ((t.eraserHlOnly && s.kind !== 'highlighter') || !hits(s, ax, ay, x, y)) {
          next.push(s);
          continue;
        }
        any = true;
        if (t.eraserMode === 'precise' && s.kind !== 'tape') next.push(...split(s, ax, ay, x, y));
      }
      if (any) {
        cur = { ...cur, strokes: next };
        changed = true;
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            this.session.commit(pageId, cur, { record: false });
          });
      }
      const rr = this.scroller.getBoundingClientRect();
      this.eraserCursor = { x: ev.clientX - rr.left, y: ev.clientY - rr.top, r: r * this.zoom };
      this.paintOverlay();
    };
    step(e);
    return {
      move: (ev) => {
        for (const ce of ev.getCoalescedEvents?.() ?? [ev]) step(ce);
      },
      up: () => {
        cancelAnimationFrame(raf);
        if (changed) this.session.commit(pageId, cur, { before });
        if (t.eraserAutoDeselect && this.tools.tool === 'eraser') this.cb.onEraseEnd();
        this.eraserCursor = null;
        this.paintOverlay();
      },
      cancel: () => {
        cancelAnimationFrame(raf);
        if (changed) this.session.commit(pageId, before, { record: false });
        this.eraserCursor = null;
        this.paintOverlay();
      },
    };
  }

  // ---- lasso & selection --------------------------------------------------------------------

  private selectionCorners(): [number, number][] | null {
    if (!this.sel) return null;
    const i = this.session.pageIndex(this.sel.pageId);
    if (i < 0) return null;
    const m = mul(this.overlayMatrix(i), this.selMatrix);
    const [x0, y0, x1, y1] = this.sel.bbox;
    const dpr = window.devicePixelRatio || 1;
    return [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)].map(([x, y]) => [x / dpr, y / dpr]) as [number, number][];
  }

  private hitSelection(e: PointerEvent): { kind: 'move' | 'rotate' | 'scale'; handle?: number } | null {
    const c = this.selectionCorners();
    if (!c || !this.sel) return null;
    const r = this.scroller.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const dpr = window.devicePixelRatio || 1;
    const [rx, ry] = this.rotateHandle(c.map(([a, b]) => [a * dpr, b * dpr]) as [number, number][]).map((v) => v / dpr);
    if (Math.hypot(x - rx, y - ry) < 12) return { kind: 'rotate' };
    const hp = this.handlePoints(c);
    for (let k = 0; k < hp.length; k++) if (Math.abs(x - hp[k][0]) < 10 && Math.abs(y - hp[k][1]) < 10) return { kind: 'scale', handle: k };
    if (pointInPolygon(x, y, c.flat())) return { kind: 'move' };
    return null;
  }

  private lassoAction(e: PointerEvent, i: number, pageId: string, imageTool: boolean): Action {
    const hit = this.sel && this.sel.pageId === pageId ? this.hitSelection(e) : null;
    if (hit) return this.transformAction(e, i, hit);
    this.clearSelection();
    const start = this.pagePointFromEvent(i, e);
    const startClient = { x: e.clientX, y: e.clientY };
    const pts: number[] = [...start];
    let moved = false;
    let anim = 0;
    if (!imageTool) {
      this.lassoPath = { pageId, pts };
      const tick = () => {
        this.paintOverlay();
        anim = requestAnimationFrame(tick);
      };
      anim = requestAnimationFrame(tick);
    }
    return {
      move: (ev) => {
        if (Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) > 4) moved = true;
        if (imageTool) return;
        for (const ce of ev.getCoalescedEvents?.() ?? [ev]) pts.push(...this.pagePointFromEvent(i, ce));
      },
      up: () => {
        cancelAnimationFrame(anim);
        this.lassoPath = null;
        const c = this.session.content(pageId);
        if (!c) return this.paintOverlay();
        if (!moved) {
          // tap: select the object under the point
          const [x, y] = start;
          const obj = imageTool ? undefined : [...c.objects].reverse().find((o) => !isPlaced(o) && bboxHit(objectBBox(o), x, y));
          if (obj) this.setSelection({ pageId, strokeIds: new Set(), objectIds: new Set([obj.id]), bbox: objectBBox(obj) });
          else if (imageTool && !this.placedAt(pageId, x, y)) this.cb.onRequestImage(pageId, x, y);
          else this.paintOverlay();
          return;
        }
        if (imageTool) return this.paintOverlay();
        const strokeIds = new Set<string>();
        const objectIds = new Set<string>();
        let bbox: BBox | null = null;
        for (const s of c.strokes) {
          let inside = 0;
          const n = s.pts.length / 3;
          const stepN = Math.max(1, Math.floor(n / 40));
          let tested = 0;
          for (let k = 0; k < n; k += stepN) {
            tested++;
            if (pointInPolygon(s.pts[k * 3], s.pts[k * 3 + 1], pts)) inside++;
          }
          if (tested && inside / tested >= 0.5) {
            strokeIds.add(s.id);
            bbox = bboxUnion(bbox, s.bbox);
          }
        }
        for (const o of c.objects) {
          if (isPlaced(o)) continue;
          const b = objectBBox(o);
          if (pointInPolygon((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, pts)) {
            objectIds.add(o.id);
            bbox = bboxUnion(bbox, b);
          }
        }
        if (bbox) this.setSelection({ pageId, strokeIds, objectIds, bbox });
        else this.paintOverlay();
      },
      cancel: () => {
        cancelAnimationFrame(anim);
        this.lassoPath = null;
        this.paintOverlay();
      },
    };
  }

  private transformAction(e: PointerEvent, i: number, hit: { kind: 'move' | 'rotate' | 'scale'; handle?: number }): Action {
    const sel = this.sel!;
    const start = this.pagePointFromEvent(i, e);
    const [x0, y0, x1, y1] = sel.bbox;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    this.hidden = new Set([...sel.strokeIds, ...sel.objectIds]);
    this.hiddenPage = sel.pageId;
    const v = this.views.get(sel.pageId);
    if (v) {
      v.dirtyInk = v.dirtyBg = true;
      this.requestRender();
    }
    this.cb.onSelection(null, null);
    const anchors: [number, number][] = [
      [x1, y1], [cx, y1], [x0, y1], [x0, cy], [x0, y0], [cx, y0], [x1, y0], [x1, cy],
    ];
    const finish = (commit: boolean) => {
      const m = this.selMatrix;
      this.hidden = new Set();
      this.hiddenPage = null;
      if (commit && !isIdentity(m)) {
        const c = this.session.content(sel.pageId)!;
        const next: PageContent = {
          strokes: c.strokes.map((s) => (sel.strokeIds.has(s.id) ? transformStroke(s, m) : s)),
          objects: c.objects.map((o) => (sel.objectIds.has(o.id) ? transformObject(o, m) : o)),
        };
        this.selMatrix = IDENTITY;
        this.session.commit(sel.pageId, next);
        this.revalidateSelection();
      } else {
        this.selMatrix = IDENTITY;
        if (v) v.dirtyInk = v.dirtyBg = true;
        this.requestRender();
        this.emitSelection();
      }
    };
    return {
      move: (ev) => {
        const [x, y] = this.pagePointFromEvent(i, ev);
        if (hit.kind === 'move') this.selMatrix = translate(x - start[0], y - start[1]);
        else if (hit.kind === 'rotate') {
          let a = Math.atan2(y - cy, x - cx) - Math.atan2(start[1] - cy, start[0] - cx);
          const snap = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
          if (Math.abs(a - snap) < 0.05) a = snap;
          this.selMatrix = about(rotate(a), cx, cy);
        } else {
          const h = hit.handle!;
          const [ax, ay] = anchors[h];
          const corner = h % 2 === 0;
          const sx0 = start[0] - ax, sy0 = start[1] - ay;
          let sx = Math.abs(sx0) > 0.5 ? (x - ax) / sx0 : 1;
          let sy = Math.abs(sy0) > 0.5 ? (y - ay) / sy0 : 1;
          if (corner) sx = sy = Math.max(0.05, (sx + sy) / 2);
          else if (h === 1 || h === 5) sx = 1;
          else sy = 1;
          sx = Math.max(0.05, sx);
          sy = Math.max(0.05, sy);
          this.selMatrix = about(scale(sx, sy), ax, ay);
        }
        this.paintOverlay();
      },
      up: () => finish(true),
      cancel: () => finish(false),
    };
  }

  setSelection(sel: Selection | null) {
    this.sel = sel;
    this.selMatrix = IDENTITY;
    this.paintOverlay();
    this.emitSelection();
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.selMatrix = IDENTITY;
    this.paintOverlay();
    this.cb.onSelection(null, null);
  }

  private revalidateSelection() {
    if (!this.sel) return;
    const c = this.session.content(this.sel.pageId);
    if (!c) return this.clearSelection();
    let bbox: BBox | null = null;
    const strokeIds = new Set<string>(), objectIds = new Set<string>();
    for (const s of c.strokes)
      if (this.sel.strokeIds.has(s.id)) {
        strokeIds.add(s.id);
        bbox = bboxUnion(bbox, s.bbox);
      }
    for (const o of c.objects)
      if (this.sel.objectIds.has(o.id)) {
        objectIds.add(o.id);
        bbox = bboxUnion(bbox, objectBBox(o));
      }
    if (!bbox) return this.clearSelection();
    this.sel = { ...this.sel, strokeIds, objectIds, bbox };
    this.paintOverlay();
    this.emitSelection();
  }

  private emitSelection() {
    if (!this.sel || !isIdentity(this.selMatrix)) return;
    const c = this.selectionCorners();
    if (!c) return;
    const r = this.scroller.getBoundingClientRect();
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const rect = new DOMRect(r.left + Math.min(...xs), r.top + Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    this.cb.onSelection(this.sel, rect);
  }

  selectAll() {
    const pageId = this.session.pages[this.pageIndexNow].id;
    const c = this.session.content(pageId);
    if (!c) return;
    let bbox: BBox | null = null;
    for (const s of c.strokes) bbox = bboxUnion(bbox, s.bbox);
    for (const o of c.objects) bbox = bboxUnion(bbox, objectBBox(o));
    if (bbox) this.setSelection({ pageId, strokeIds: new Set(c.strokes.map((s) => s.id)), objectIds: new Set(c.objects.map((o) => o.id)), bbox });
  }

  // ---- selection commands -------------------------------------------------------------------

  private selected(): { strokes: Stroke[]; objects: PageObject[] } | null {
    if (!this.sel) return null;
    const c = this.session.content(this.sel.pageId);
    if (!c) return null;
    return { strokes: c.strokes.filter((s) => this.sel!.strokeIds.has(s.id)), objects: c.objects.filter((o) => this.sel!.objectIds.has(o.id)) };
  }

  deleteSelection() {
    if (!this.sel) return;
    const sel = this.sel;
    const c = this.session.content(sel.pageId)!;
    this.clearSelection();
    this.session.commit(sel.pageId, { strokes: c.strokes.filter((s) => !sel.strokeIds.has(s.id)), objects: c.objects.filter((o) => !sel.objectIds.has(o.id)) });
  }

  copySelection() {
    const s = this.selected();
    if (!s || !this.sel) return false;
    clipboard = { ...s, bbox: this.sel.bbox, pageId: this.sel.pageId };
    void this.selectionPng().then((png) => png && window.gink.clipboardWriteImage(png));
    return true;
  }

  cutSelection() {
    if (this.copySelection()) this.deleteSelection();
  }

  duplicateSelection() {
    const s = this.selected();
    if (!s || !this.sel) return;
    this.insertItems(this.sel.pageId, s.strokes, s.objects, translate(18, 18));
  }

  /** Paste the internal clipboard (or an image from the system clipboard) onto the current page. */
  async paste(): Promise<boolean> {
    const i = this.pageIndexNow;
    const page = this.session.pages[i];
    if (clipboard) {
      const [x0, y0, x1, y1] = clipboard.bbox;
      let m: Mat;
      if (clipboard.pageId === page.id) m = translate(18, 18);
      else {
        const [vx, vy] = this.visibleCenter(i);
        m = translate(vx - (x0 + x1) / 2, vy - (y0 + y1) / 2);
      }
      this.insertItems(page.id, clipboard.strokes, clipboard.objects, m);
      // successive pastes cascade
      clipboard = { ...clipboard, bbox: [x0 + 18, y0 + 18, x1 + 18, y1 + 18], pageId: page.id, strokes: clipboard.strokes.map((s) => transformStroke(s, translate(18, 18))), objects: clipboard.objects.map((o) => transformObject(o, translate(18, 18))) };
      return true;
    }
    const png = await window.gink.clipboardReadImage();
    if (png) {
      await this.insertImageBytes(page.id, png, 'png');
      return true;
    }
    return false;
  }

  insertItems(pageId: string, strokes: Stroke[], objects: PageObject[], m: Mat) {
    const c = this.session.content(pageId) ?? { strokes: [], objects: [] };
    const ns = strokes.map((s) => transformStroke(s, m, uid()));
    const no = objects.map((o) => transformObject(o, m, uid()));
    this.session.commit(pageId, { strokes: [...c.strokes, ...ns], objects: [...c.objects, ...no] });
    let bbox: BBox | null = null;
    for (const s of ns) bbox = bboxUnion(bbox, s.bbox);
    for (const o of no) bbox = bboxUnion(bbox, objectBBox(o));
    if (bbox) this.setSelection({ pageId, strokeIds: new Set(ns.map((s) => s.id)), objectIds: new Set(no.map((o) => o.id)), bbox });
  }

  recolorSelection(color: string) {
    if (!this.sel) return;
    const sel = this.sel;
    const c = this.session.content(sel.pageId)!;
    this.session.commit(sel.pageId, {
      strokes: c.strokes.map((s) => (sel.strokeIds.has(s.id) && s.kind !== 'tape' ? recolorStroke(s, color) : s)),
      objects: c.objects.map((o) => (sel.objectIds.has(o.id) && o.type === 'text' ? { ...o, color } : o)),
    });
  }

  resizeSelection(f: number) {
    if (!this.sel) return;
    const [x0, y0, x1, y1] = this.sel.bbox;
    const sel = this.sel;
    const m = about(scale(f, f), (x0 + x1) / 2, (y0 + y1) / 2);
    const c = this.session.content(sel.pageId)!;
    this.session.commit(sel.pageId, {
      strokes: c.strokes.map((s) => (sel.strokeIds.has(s.id) ? transformStroke(s, m) : s)),
      objects: c.objects.map((o) => (sel.objectIds.has(o.id) ? transformObject(o, m) : o)),
    });
  }

  arrangeSelection(dir: 'front' | 'back') {
    if (!this.sel) return;
    const sel = this.sel;
    const c = this.session.content(sel.pageId)!;
    const order = <T extends { id: string }>(arr: readonly T[], ids: Set<string>) => {
      const a = arr.filter((x) => ids.has(x.id)), b = arr.filter((x) => !ids.has(x.id));
      return dir === 'front' ? [...b, ...a] : [...a, ...b];
    };
    this.session.commit(sel.pageId, { strokes: order(c.strokes, sel.strokeIds), objects: order(c.objects, sel.objectIds) });
  }

  selectionItems() {
    return this.selected();
  }

  async selectionPng(scaleF = 3): Promise<Uint8Array | null> {
    const s = this.selected();
    if (!s || !this.sel) return null;
    const [x0, y0, x1, y1] = this.sel.bbox;
    const pad = 6;
    const w = Math.ceil((x1 - x0 + pad * 2) * scaleF), h = Math.ceil((y1 - y0 + pad * 2) * scaleF);
    const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(scaleF, 0, 0, scaleF, (-x0 + pad) * scaleF, (-y0 + pad) * scaleF);
    await Promise.all(s.objects.filter((o) => o.type === 'image').map((o) => this.session.loadImage((o as ImageObject).src)));
    drawImages(ctx, s.objects, this.session);
    drawPdfObjects(ctx, s.objects, this.session, scaleF);
    for (const st of s.strokes) if (st.kind === 'highlighter') drawStroke(ctx, st);
    drawInk(ctx, s.strokes);
    drawTexts(ctx, s.objects);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Replace the selected handwriting with a text box containing the recognised words. */
  async convertSelectionToText(): Promise<string | null> {
    const s = this.selected();
    if (!s || !this.sel || !s.strokes.length) return null;
    const sel = this.sel;
    const [x0, y0, x1, y1] = sel.bbox;
    const sc = 3;
    const canvas = new OffscreenCanvas(Math.ceil((x1 - x0 + 20) * sc), Math.ceil((y1 - y0 + 20) * sc));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(sc, 0, 0, sc, (-x0 + 10) * sc, (-y0 + 10) * sc);
    for (const st of s.strokes) if (st.kind === 'pen') drawStroke(ctx, { ...st, color: '#000' });
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const words = await window.gink.ocr(new Uint8Array(await blob.arrayBuffer()));
    if (!words.length) return null;
    // rebuild lines from word boxes
    const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: (typeof words)[] = [];
    for (const w of sorted) {
      const line = lines.find((l) => Math.abs(l[0].y + l[0].h / 2 - (w.y + w.h / 2)) < l[0].h * 0.6);
      if (line) line.push(w);
      else lines.push([w]);
    }
    const text = lines.map((l) => l.sort((a, b) => a.x - b.x).map((w) => w.text).join(' ')).join('\n');
    const avgH = words.reduce((a, w) => a + w.h, 0) / words.length / sc;
    const color = s.strokes.find((st) => st.kind === 'pen')?.color ?? '#1b1b1f';
    const obj: TextObject = { id: uid(), type: 'text', x: x0, y: y0, w: Math.max(80, x1 - x0), h: 10, rot: 0, text, font: 'sans', size: clamp(Math.round(avgH * 0.9), 9, 48), color, align: 'left' };
    obj.h = textHeight(obj);
    const c = this.session.content(sel.pageId)!;
    this.clearSelection();
    this.session.commit(sel.pageId, { strokes: c.strokes.filter((st) => !sel.strokeIds.has(st.id)), objects: [...c.objects, obj] });
    return text;
  }

  // ---- images -------------------------------------------------------------------------------

  private visibleCenter(i: number): [number, number] {
    const r = this.rects[i];
    const p = this.session.pages[i];
    const cx = clamp(this.scroller.scrollLeft + this.vw / 2, r.x, r.x + r.w);
    const cy = clamp(this.scroller.scrollTop + this.vh / 2, r.y, r.y + r.h);
    const [x, y] = this.toPage(i, cx, cy);
    return [clamp(x, p.ox ?? 0, (p.ox ?? 0) + p.w), clamp(y, p.oy ?? 0, (p.oy ?? 0) + p.h)];
  }

  async insertImageBytes(pageId: string, bytes: Uint8Array, ext: string, at?: [number, number]) {
    const assetId = await this.session.addAsset(bytes, ext);
    const src = `asset:${assetId}`;
    const img = await this.session.loadImage(src);
    const iw = (img as ImageBitmap | HTMLImageElement | null)?.width || 300;
    const ih = (img as ImageBitmap | HTMLImageElement | null)?.height || 200;
    this.insertImageObject(pageId, src, iw, ih, at);
  }

  insertImageObject(pageId: string, src: string, iw: number, ih: number, at?: [number, number]) {
    const i = this.session.pageIndex(pageId);
    const p = this.session.pages[i];
    const maxW = Math.min(p.w * 0.6, p.infinite ? 600 : Infinity), maxH = Math.min(p.h * 0.5, p.infinite ? 600 : Infinity);
    const f = Math.min(1, maxW / iw, maxH / ih);
    const w = iw * f, h = ih * f;
    const [cx, cy] = at ?? this.visibleCenter(i);
    const ox = p.ox ?? 0, oy = p.oy ?? 0;
    const obj: ImageObject = { id: uid(), type: 'image', x: clamp(cx - w / 2, ox, ox + p.w - w), y: clamp(cy - h / 2, oy, oy + p.h - h), w, h, rot: 0, src };
    const c = this.session.content(pageId) ?? { strokes: [], objects: [] };
    // placed straight onto the page; right-click or long-press it to move it
    this.session.commit(pageId, { ...c, objects: [...c.objects, obj] });
  }

  insertElement(strokes: Stroke[], objects: PageObject[], bbox: BBox) {
    const i = this.pageIndexNow;
    const [cx, cy] = this.visibleCenter(i);
    this.insertItems(this.session.pages[i].id, strokes, objects, translate(cx - (bbox[0] + bbox[2]) / 2, cy - (bbox[1] + bbox[3]) / 2));
  }

  // ---- text ---------------------------------------------------------------------------------

  private textClick(e: PointerEvent, i: number, pageId: string): Action | null {
    const [x, y] = this.pagePointFromEvent(i, e);
    const existing = this.textAt(pageId, x, y);
    if (existing) {
      // tap: edit it; drag: move it
      this.editText(pageId, existing, false, false);
      const sx = e.clientX, sy = e.clientY;
      let dragging = false;
      const drag = this.textDrag(sx, sy);
      return {
        move: (ev) => {
          if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          dragging = true;
          this.textEdit?.el.classList.add('is-moving');
          drag(ev.clientX, ev.clientY);
        },
        up: (ev) => {
          if (dragging) this.commitTextEdit();
          else this.focusTextAt(ev.clientX, ev.clientY);
        },
        cancel: () => this.commitTextEdit(),
      };
    }
    const p = this.session.pages[i];
    const t: TextStyle = this.tools.text;
    const w = Math.min(260, (p.ox ?? 0) + p.w - x - 12);
    const obj: TextObject = { id: uid(), type: 'text', x, y: y - lineStep(t) / 2 - 2, w: Math.max(60, w), h: lineStep(t) + 4, rot: 0, text: '', ...t, align: t.align ?? 'left' };
    this.editText(pageId, obj, true);
    return null;
  }

  /** Moving the box being edited by the pointer: returns the move handler. */
  private textDrag(sx: number, sy: number) {
    const o0 = this.textEdit!.obj;
    const page = this.session.pages[this.session.pageIndex(this.textEdit!.pageId)];
    const turn = ((page.rotation ?? 0) * Math.PI) / 180;
    return (cx: number, cy: number) => {
      if (!this.textEdit) return;
      // screen -> page units (pages may be shown turned)
      const dx = (cx - sx) / this.zoom, dy = (cy - sy) / this.zoom;
      const c = Math.cos(-turn), s = Math.sin(-turn);
      this.textEdit.obj = { ...this.textEdit.obj, x: o0.x + dx * c - dy * s, y: o0.y + dx * s + dy * c };
      this.positionTextEditor();
    };
  }

  /** Put the caret where the pointer is in the text being edited. */
  private focusTextAt(cx: number, cy: number) {
    const ed = this.textEdit?.el.querySelector('.gi-text-editor') as HTMLElement | undefined;
    if (!ed) return;
    ed.focus();
    const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
    const pos = doc.caretPositionFromPoint?.(cx, cy);
    if (!pos || !ed.contains(pos.offsetNode)) return;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  editText(pageId: string, obj: TextObject, isNew: boolean, focus = true) {
    this.commitTextEdit();
    const el = document.createElement('div');
    el.className = 'gi-text-editor';
    el.contentEditable = 'plaintext-only';
    el.spellcheck = true;
    el.textContent = obj.text;
    const grip = document.createElement('div');
    grip.className = 'gi-text-grip';
    grip.contentEditable = 'false';
    const handle = document.createElement('div');
    handle.className = 'gi-text-move';
    handle.contentEditable = 'false';
    handle.title = 'Drag to move';
    handle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>';
    const wrap = document.createElement('div');
    wrap.className = 'gi-text-wrap';
    wrap.append(handle, el, grip);
    this.content.append(wrap);
    const before = this.session.content(pageId) ?? { strokes: [], objects: [] };
    this.textEdit = { pageId, obj, isNew, el: wrap, before };
    if (!isNew) {
      this.hidden = new Set([obj.id]);
      this.hiddenPage = pageId;
      const v = this.views.get(pageId);
      if (v) v.dirtyInk = v.dirtyBg = true;
      this.requestRender();
    }
    this.styleTextEditor();
    this.positionTextEditor();
    el.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') this.commitTextEdit();
      // the formatting shortcuts of every word processor (for the whole box)
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && this.textEdit) {
        const k = ev.key.toLowerCase();
        const o = this.textEdit.obj;
        const patch = k === 'b' ? { bold: !o.bold } : k === 'i' ? { italic: !o.italic } : k === 'u' ? { underline: !o.underline } : null;
        if (patch) {
          ev.preventDefault();
          this.updateEditingText(patch);
        }
      }
    });
    const keepCaret = () => {
      const sel = window.getSelection();
      if (sel?.rangeCount && el.contains(sel.anchorNode)) this.textCaret = sel.getRangeAt(0).cloneRange();
    };
    el.addEventListener('keyup', keepCaret);
    el.addEventListener('pointerup', keepCaret);
    el.addEventListener('blur', keepCaret);
    el.addEventListener('input', () => {
      if (this.textEdit) this.textEdit.obj = { ...this.textEdit.obj, text: el.innerText.replace(/\n$/, '') };
    });
    grip.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      const sx = ev.clientX;
      const w0 = this.textEdit!.obj.w;
      const mv = (m: PointerEvent) => {
        if (!this.textEdit) return;
        this.textEdit.obj = { ...this.textEdit.obj, w: Math.max(40, w0 + (m.clientX - sx) / this.zoom) };
        this.styleTextEditor();
      };
      const upH = () => {
        grip.removeEventListener('pointermove', mv);
        grip.removeEventListener('pointerup', upH);
      };
      grip.addEventListener('pointermove', mv);
      grip.addEventListener('pointerup', upH);
    });
    handle.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      wrap.classList.add('is-moving');
      const drag = this.textDrag(ev.clientX, ev.clientY);
      const mv = (m: PointerEvent) => drag(m.clientX, m.clientY);
      const upH = () => {
        wrap.classList.remove('is-moving');
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', upH);
        handle.removeEventListener('pointercancel', upH);
        el.focus();
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', upH);
      handle.addEventListener('pointercancel', upH);
    });
    // focus right away: letters typed straight after the click must not go to the tool shortcuts
    const caretToEnd = () => {
      if (this.textEdit?.el !== wrap) return;
      el.focus({ preventScroll: true });
      if (el.contains(window.getSelection()?.anchorNode ?? null)) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
    };
    if (focus) {
      caretToEnd();
      requestAnimationFrame(caretToEnd);
    }
    this.cb.onTextEdit(obj);
  }

  private styleTextEditor() {
    if (!this.textEdit) return;
    const { obj, el } = this.textEdit;
    const ed = el.querySelector('.gi-text-editor') as HTMLDivElement;
    ed.style.font = fontCss(obj);
    ed.style.lineHeight = `${lineStep(obj)}px`;
    ed.style.textDecoration = [obj.underline && 'underline', obj.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
    ed.style.color = obj.color;
    ed.style.textAlign = obj.align;
    ed.style.width = `${obj.w}px`;
    ed.style.minHeight = `${lineStep(obj)}px`;
    ed.style.background = obj.bgColor ?? 'transparent';
  }

  private positionTextEditor() {
    if (!this.textEdit) return;
    const i = this.session.pageIndex(this.textEdit.pageId);
    const r = this.rects[i];
    if (!r) return;
    const m = mul(pageMatrix(this.session.pages[i], this.zoom), about(rotate(this.textEdit.obj.rot), this.textEdit.obj.x + this.textEdit.obj.w / 2, this.textEdit.obj.y + this.textEdit.obj.h / 2));
    const el = this.textEdit.el;
    // handles keep their size on screen at any zoom
    el.style.setProperty('--inv', String(1 / this.zoom));
    el.style.transform = `translate(${r.x}px, ${r.y}px) matrix(${m.join(',')}) translate(${this.textEdit.obj.x}px, ${this.textEdit.obj.y}px)`;
  }

  updateEditingText(patch: Partial<TextObject>) {
    if (!this.textEdit) return;
    this.textEdit.obj = { ...this.textEdit.obj, ...patch };
    this.styleTextEditor();
    this.positionTextEditor();
    this.cb.onTextEdit(this.textEdit.obj);
    const ed = this.textEdit.el.querySelector('.gi-text-editor') as HTMLElement;
    if (document.activeElement === ed) return;
    // back from a toolbar field: caret where it was, or at the end
    ed.focus();
    const sel = window.getSelection();
    if (this.textCaret && ed.contains(this.textCaret.startContainer)) {
      sel?.removeAllRanges();
      sel?.addRange(this.textCaret);
    } else if (sel && !ed.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  get isEditingText() {
    return !!this.textEdit;
  }

  commitTextEdit() {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    this.textCaret = null;
    const text = (te.el.querySelector('.gi-text-editor') as HTMLElement).innerText.replace(/\n$/, '');
    te.el.remove();
    this.hidden = new Set();
    this.hiddenPage = null;
    const obj: TextObject = { ...te.obj, text };
    obj.h = textHeight(obj);
    const c = this.session.content(te.pageId) ?? { strokes: [], objects: [] };
    let objects: PageObject[];
    if (!text.trim()) objects = c.objects.filter((o) => o.id !== obj.id);
    else if (te.isNew) objects = [...c.objects, obj];
    else objects = c.objects.map((o) => (o.id === obj.id ? obj : o));
    const changed = te.isNew ? !!text.trim() : JSON.stringify(c.objects.find((o) => o.id === obj.id)) !== JSON.stringify(obj);
    if (changed) this.session.commit(te.pageId, { ...c, objects }, { before: te.before });
    else {
      const v = this.views.get(te.pageId);
      if (v) v.dirtyInk = v.dirtyBg = true;
      this.requestRender();
    }
    this.cb.onTextEdit(null);
  }

  // ---- tape ---------------------------------------------------------------------------------

  private tapeAction(e: PointerEvent, i: number, pageId: string): Action {
    const start = this.pagePointFromEvent(i, e);
    const t = this.tools;
    let end = start;
    let moved = false;
    const id = uid();
    const build = () => makeStroke({ id, kind: 'tape', color: t.tapeColor, width: t.tapeWidth, pts: new Float32Array([start[0], start[1], 0.5, end[0], end[1], 0.5]), shape: true });
    return {
      move: (ev) => {
        end = this.pagePointFromEvent(i, ev);
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) * this.zoom > 4) moved = true;
        if (moved) {
          this.wet = { pageId, stroke: build() };
          this.paintOverlay();
        }
      },
      up: () => {
        this.wet = null;
        const c = this.session.content(pageId) ?? { strokes: [], objects: [] };
        if (!moved) {
          // tap toggles the tape under the pen
          const hit = [...c.strokes].reverse().find((s) => s.kind === 'tape' && distToSegSq(start[0], start[1], s.pts[0], s.pts[1], s.pts[3], s.pts[4]) <= (s.width / 2) ** 2);
          if (hit) this.session.commit(pageId, { ...c, strokes: c.strokes.map((s) => (s === hit ? { ...s, revealed: !s.revealed } : s)) });
          this.paintOverlay();
          return;
        }
        const s = build();
        this.session.commit(pageId, { ...c, strokes: [...c.strokes, s] });
        this.paintOverlay();
      },
      cancel: () => {
        this.wet = null;
        this.paintOverlay();
      },
    };
  }

  setAllTape(revealed: boolean) {
    const pageId = this.session.pages[this.pageIndexNow].id;
    const c = this.session.content(pageId);
    if (!c || !c.strokes.some((s) => s.kind === 'tape')) return;
    this.session.commit(pageId, { ...c, strokes: c.strokes.map((s) => (s.kind === 'tape' ? { ...s, revealed } : s)) });
  }

  // ---- laser --------------------------------------------------------------------------------

  private laserAction(e: PointerEvent, i: number): Action {
    const p = this.session.pages[i];
    const push = (ev: PointerEvent) => {
      const [x, y] = this.pagePointFromEvent(i, ev);
      if (!this.laser || this.laser.page !== i) this.laser = { page: i, pts: [] };
      this.laser.pts.push({ x, y, t: performance.now() });
      if (this.laser.pts.length > 400) this.laser.pts.splice(0, this.laser.pts.length - 400);
      this.cb.onLaser(i, this.laser.pts.slice(-60).map((q) => ({ x: q.x / p.w, y: q.y / p.h, t: q.t })));
    };
    push(e);
    const loop = () => {
      this.paintOverlay();
      const last = this.laser?.pts[this.laser.pts.length - 1];
      if (last && performance.now() - last.t < 1000) this.laserRaf = requestAnimationFrame(loop);
      else {
        this.laser = null;
        this.paintOverlay();
      }
    };
    cancelAnimationFrame(this.laserRaf);
    this.laserRaf = requestAnimationFrame(loop);
    return {
      move: (ev) => {
        for (const ce of ev.getCoalescedEvents?.() ?? [ev]) push(ce);
        cancelAnimationFrame(this.laserRaf);
        this.laserRaf = requestAnimationFrame(loop);
      },
      up: () => undefined,
      cancel: () => undefined,
    };
  }

  // ---- live check marks ---------------------------------------------------------------------

  /**
   * Show the live check marks of a page (an empty list clears them). Never touches the page while
   * the pen is down: marks that arrive mid-stroke are applied when it lifts.
   */
  setLiveDecorations(pageId: string, decos: UiDecoration[]) {
    if (this.wet || this.action?.raw) {
      this.livePending.set(pageId, decos);
      return;
    }
    this.applyLive(pageId, decos);
  }

  private flushLive() {
    const pending = [...this.livePending];
    this.livePending.clear();
    for (const [id, d] of pending) this.applyLive(id, d);
  }

  private applyLive(pageId: string, decos: UiDecoration[]) {
    const before = this.liveDecos.get(pageId);
    if (decos.length) this.liveDecos.set(pageId, decos);
    else this.liveDecos.delete(pageId);
    // a mark that went away (erased, fixed) animates again if it ever comes back
    if (before) for (const d of before) if (!decos.some((n) => n.id === d.id)) this.liveSeen.delete(d.id);
    const v = this.views.get(pageId);
    if (v) this.renderLivePage(v, true);
    if (this.liveTipId && !decos.some((d) => d.id === this.liveTipId) && before?.some((d) => d.id === this.liveTipId)) this.hideLiveTip();
  }

  /** Keep the mark layers in step with zoom: scaled by CSS while a gesture runs, rebuilt after. */
  private renderLive() {
    for (const v of this.views.values()) {
      if (!v.live && !this.liveDecos.has(v.page.id)) continue;
      if (this.zooming && v.live && v.liveZoom) v.live.style.transform = `scale(${this.zoom / v.liveZoom})`;
      else if (v.liveZoom !== this.zoom || v.livePage !== v.page) this.renderLivePage(v);
    }
  }

  private renderLivePage(v: PageView, animate = false) {
    const decos = this.liveDecos.get(v.page.id);
    if (!decos?.length) {
      v.live?.remove();
      v.live = null;
      v.liveZoom = 0;
      return;
    }
    if (!v.live) {
      const svg = (v.live = document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      svg.setAttribute('class', 'gi-live');
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', 'Live check marks');
      // marks are focusable: Enter (or Space) opens the insight card for that mark
      svg.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const g = (e.target as Element).closest?.('.gi-live-mark') as SVGGElement | null;
        const d = g && this.liveDecos.get(v.page.id)?.find((x) => x.id === g.dataset.id);
        if (!d || !g) return;
        e.preventDefault();
        e.stopPropagation();
        const r = g.getBoundingClientRect();
        this.cb.onInkContext?.(v.page.id, (d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2, r.left + r.width / 2, r.top + r.height / 2);
      });
      v.el.append(svg);
    }
    v.live.classList.toggle('is-dark-paper', v.dark);
    v.live.style.transform = '';
    v.liveZoom = this.zoom;
    v.livePage = v.page;
    const pageId = v.page.id;
    renderDecorations(v.live, decos, { m: pageMatrix(v.page, this.zoom), zoom: this.zoom, colorAt: (b) => this.inkColorAt(pageId, b) }, this.liveSeen, animate && !this.reducedMotion?.matches);
  }

  /** Pen colour of the ink under a page box (ghost-ink results are drawn in it). */
  private inkColorAt(pageId: string, b: BBox): string {
    const c = this.session.content(pageId);
    const counts = new Map<string, number>();
    for (const s of c?.strokes ?? []) if (s.kind === 'pen' && bboxOverlap(s.bbox, b)) counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
    let best = this.tools.penColor, n = 0;
    for (const [col, k] of counts) if (k > n) [best, n] = [col, k];
    return best;
  }

  /** Mouse or pen hovering over a mark: a small tip with the issue title. */
  private liveHover(e: PointerEvent) {
    const [cx, cy] = this.toContent(e);
    const i = this.pageAt(cx, cy);
    let hit: UiDecoration | null = null;
    if (i >= 0) {
      const decos = this.liveDecos.get(this.session.pages[i].id);
      const r = this.rects[i];
      if (decos) hit = hitDecoration(decos, pageMatrix(this.session.pages[i], this.zoom), this.zoom, cx - r.x, cy - r.y);
    }
    if (!hit?.title && !hit?.tip) {
      if (this.liveTipId) this.hideLiveTip();
      return;
    }
    if (hit.id === this.liveTipId) return;
    this.hideLiveTip();
    this.liveTipId = hit.id;
    const d = hit;
    this.liveTipTimer = setTimeout(() => this.showLiveTip(i, d), LIVE_TUNING.tipDelayMs);
  }

  private showLiveTip(i: number, d: UiDecoration) {
    if (this.liveTipId !== d.id || this.action) return;
    let tip = this.liveTip;
    if (!tip) {
      tip = this.liveTip = document.createElement('div');
      tip.className = 'gi-live-tip';
      tip.setAttribute('role', 'tooltip');
      tip.append(document.createElement('i'), document.createElement('b'), document.createElement('span'));
      (tip.lastChild as HTMLElement).textContent = 'Right-click for details';
      this.root.append(tip);
    }
    tip.dataset.kind = d.kind;
    (tip.children[1] as HTMLElement).textContent = d.tip ?? d.title ?? '';
    const r = this.rects[i];
    const m = pageMatrix(this.session.pages[i], this.zoom);
    const a = tipAnchor(d, m, this.zoom);
    const x = r.x + a.x - this.scroller.scrollLeft, y = r.y + a.y - this.scroller.scrollTop;
    tip.classList.remove('is-on', 'is-above');
    tip.style.left = '0px';
    tip.style.top = '0px';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    let top = y + 10;
    if (top + h > H - 8) {
      // no room under the line: above the ink instead
      const [, ty] = apply(m, d.bbox[0], d.bbox[1]);
      top = r.y + ty - this.scroller.scrollTop - h - 10;
      tip.classList.add('is-above');
    }
    tip.style.left = `${Math.round(clamp(x - w / 2, 8, W - w - 8))}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.setProperty('--ax', `${Math.round(clamp(x - clamp(x - w / 2, 8, W - w - 8), 12, w - 12))}px`);
    tip.classList.add('is-on');
  }

  private hideLiveTip() {
    if (this.liveTipTimer) clearTimeout(this.liveTipTimer);
    this.liveTipTimer = undefined;
    this.liveTipId = '';
    this.liveTip?.classList.remove('is-on');
  }

  // ---- view geometry for floating UI ---------------------------------------------------------

  /** Called after every scroll, zoom or resize (for cards anchored to the page). */
  onView(fn: () => void): () => void {
    this.viewFns.add(fn);
    return () => this.viewFns.delete(fn);
  }

  private emitView() {
    for (const f of this.viewFns) f();
  }

  /** A box in page units as a client rect (null when the page is not laid out). */
  pageRectToClient(pageId: string, b: BBox): DOMRect | null {
    const i = this.session.pageIndex(pageId);
    const r = this.rects[i];
    if (i < 0 || !r) return null;
    const m = pageMatrix(this.session.pages[i], this.zoom);
    const sr = this.scroller.getBoundingClientRect();
    const ox = sr.left + r.x - this.scroller.scrollLeft, oy = sr.top + r.y - this.scroller.scrollTop;
    const c = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[2], b[3]), apply(m, b[0], b[3])];
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return new DOMRect(ox + x0, oy + y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
  }

  /** The visible canvas area in client px (cards stay inside it). */
  viewClientRect(): DOMRect {
    return this.scroller.getBoundingClientRect();
  }

  // ---- AI selector ----------------------------------------------------------------------------

  private aiAction(e: PointerEvent, i: number, pageId: string): Action {
    const start = this.pagePointFromEvent(i, e);
    const sx = e.clientX, sy = e.clientY;
    const minD = 1.2 / this.zoom;
    let moved = false;
    const pts: number[] = [start[0], start[1]];
    cancelAnimationFrame(this.aiRaf);
    this.aiPath = { pageId, pts, closed: false, t0: performance.now(), busy: false };
    const tick = () => {
      this.paintOverlay();
      this.aiRaf = requestAnimationFrame(tick);
    };
    this.aiRaf = requestAnimationFrame(tick);
    let far = 0;
    let done = false;
    const act: Action = {
      move: (ev) => {
        const away = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (!moved && away > 4) moved = true;
        if (away > far) far = away;
        for (const ce of ev.getCoalescedEvents?.() ?? [ev]) {
          const [x, y] = this.pagePointFromEvent(i, ce);
          const n = pts.length;
          if (Math.abs(x - pts[n - 2]) + Math.abs(y - pts[n - 1]) >= minD) pts.push(x, y);
        }
        // the loop closes by itself once its end comes back near the start (no need to lift)
        if (far > LIVE_TUNING.ai.closePx * 2.5 && away < LIVE_TUNING.ai.closePx && pts.length > 24 && this.action === act) {
          this.action = null;
          markInput(false);
          act.up(ev);
        }
      },
      up: () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(this.aiRaf);
        let bbox: BBox = [pts[0], pts[1], pts[0], pts[1]];
        for (let k = 2; k < pts.length; k += 2) bbox = [Math.min(bbox[0], pts[k]), Math.min(bbox[1], pts[k + 1]), Math.max(bbox[2], pts[k]), Math.max(bbox[3], pts[k + 1])];
        const big = (bbox[2] - bbox[0]) * this.zoom > 14 && (bbox[3] - bbox[1]) * this.zoom > 14;
        if (!moved || pts.length < 8 || !big) {
          this.aiPath = null;
          this.paintOverlay();
          this.cb.onAiRegion?.(null);
          return;
        }
        trimLoopTail(pts, Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]));
        this.aiPath = { pageId, pts, closed: true, t0: performance.now(), busy: false };
        this.animateAi();
        this.cb.onAiRegion?.({ pageId, pts: pts.slice(), bbox });
      },
      cancel: () => {
        done = true;
        cancelAnimationFrame(this.aiRaf);
        this.aiPath = null;
        this.paintOverlay();
      },
    };
    return act;
  }

  /** Run the region's glow animation while it settles or while an answer streams. */
  private animateAi() {
    cancelAnimationFrame(this.aiRaf);
    const step = () => {
      this.paintOverlay();
      const a = this.aiPath;
      if (!a || this.reducedMotion?.matches) return;
      if (a.busy || performance.now() - a.t0 < LIVE_TUNING.ai.animateMs) this.aiRaf = requestAnimationFrame(step);
    };
    this.aiRaf = requestAnimationFrame(step);
  }

  /** The region shimmers while the AI works on it. */
  setAiBusy(busy: boolean) {
    if (!this.aiPath || this.aiPath.busy === busy) return;
    this.aiPath.busy = busy;
    this.animateAi();
  }

  clearAiRegion() {
    if (!this.aiPath) return;
    cancelAnimationFrame(this.aiRaf);
    this.aiPath = null;
    this.paintOverlay();
  }

  get hasAiRegion() {
    return !!this.aiPath?.closed;
  }

  private paintAiPath(ctx: CanvasRenderingContext2D, dpr: number) {
    const a = this.aiPath!;
    const i = this.session.pageIndex(a.pageId);
    if (i < 0) return;
    const m = this.overlayMatrix(i);
    const now = performance.now();
    const still = !!this.reducedMotion?.matches;
    const n = a.pts.length / 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const trace = () => {
      ctx.beginPath();
      let [px, py] = apply(m, a.pts[0], a.pts[1]);
      ctx.moveTo(px, py);
      for (let k = 1; k < n; k++) {
        const [x, y] = apply(m, a.pts[k * 2], a.pts[k * 2 + 1]);
        // midpoint smoothing: the loop reads as one confident line, not a jittery polyline
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x;
        py = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      ctx.lineTo(px, py);
      if (a.closed) ctx.closePath();
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    trace();
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const T = LIVE_TUNING.ai;
    const angle = still ? 0.6 : ((now / T.spinMs) % 1) * Math.PI * 2;
    const grad = ctx.createConicGradient(angle, cx, cy);
    const hues = ['#ff9a5c', '#ff6f91', '#c86bff', '#7f8cff', '#4cc9f0', '#7ee0b5', '#ffc46b', '#ff9a5c'];
    hues.forEach((c, k) => grad.addColorStop(k / (hues.length - 1), c));
    const dark = document.documentElement.dataset.theme === 'dark';
    if (a.closed) {
      // the page outside the loop dims a little, so the region reads as "selected"
      const k = still ? 1 : Math.min(1, (now - a.t0) / T.dimInMs);
      ctx.save();
      ctx.fillStyle = dark ? `rgba(0, 0, 0, ${T.dimDark * k})` : `rgba(18, 22, 34, ${T.dimLight * k})`;
      const outer = new Path2D();
      outer.rect(0, 0, this.overlay.width, this.overlay.height);
      const inner = new Path2D();
      let [px, py] = apply(m, a.pts[0], a.pts[1]);
      inner.moveTo(px, py);
      for (let j = 1; j < n; j++) {
        const [x, y] = apply(m, a.pts[j * 2], a.pts[j * 2 + 1]);
        inner.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x;
        py = y;
      }
      inner.closePath();
      outer.addPath(inner);
      ctx.fill(outer, 'evenodd');
      ctx.restore();
      trace();
    }
    // soft coloured glow under a crisp line
    const settle = a.closed && !still ? Math.max(0, 1 - (now - a.t0) / T.settleMs) : 0;
    const breathe = a.closed && a.busy && !still ? 0.5 + 0.5 * Math.sin(now / 320) : 0;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = grad;
    ctx.filter = `blur(${Math.round((5 + settle * 6 + breathe * 2) * dpr)}px)`;
    ctx.globalAlpha = a.closed ? 0.62 + settle * 0.3 + breathe * 0.15 : 0.5;
    ctx.lineWidth = (T.glowPx + settle * 8 + breathe * 3) * dpr;
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = grad;
    ctx.lineWidth = T.lineWidthPx * dpr;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The drawn region as a PNG: what is on screen for that part of the page (paper, PDF, images,
   * highlighter, ink, tape) at the current zoom, clipped to the loop, on white.
   */
  async captureRegion(pageId: string, pts: number[], maxEdge = 1280): Promise<{ png: Uint8Array; w: number; h: number } | null> {
    const v = this.views.get(pageId);
    if (!v || !v.region || v.scale === 0 || pts.length < 6) return null;
    const M = mul(v.base(), pageMatrix(v.page, v.scale));
    const cp: number[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const [x, y] = apply(M, pts[k], pts[k + 1]);
      cp.push(x, y);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const pad = 4 * (window.devicePixelRatio || 1);
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(v.bg.width, Math.ceil(x1 + pad));
    y1 = Math.min(v.bg.height, Math.ceil(y1 + pad));
    const bw = x1 - x0, bh = y1 - y0;
    if (bw < 2 || bh < 2) return null;
    const f = Math.min(1, maxEdge / Math.max(bw, bh));
    const w = Math.max(1, Math.round(bw * f)), h = Math.max(1, Math.round(bh * f));
    const out = new OffscreenCanvas(w, h);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(f, 0, 0, f, -x0 * f, -y0 * f);
    ctx.beginPath();
    for (let k = 0; k < cp.length; k += 2) (k ? ctx.lineTo(cp[k], cp[k + 1]) : ctx.moveTo(cp[k], cp[k + 1]));
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(v.bg, 0, 0);
    if (v.ink.width) {
      ctx.globalCompositeOperation = v.blend ? 'multiply' : 'source-over';
      ctx.drawImage(v.ink, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (v.tape) ctx.drawImage(v.tape, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    return { png: new Uint8Array(await blob.arrayBuffer()), w, h };
  }

  // ---- search highlights --------------------------------------------------------------------

  setHighlights(pageId: string | null, boxes: [number, number, number, number][]) {
    this.highlights = pageId ? { pageId, boxes } : null;
    this.renderHighlights();
  }

  private renderHighlights() {
    for (const v of this.views.values()) v.marks.replaceChildren();
    if (!this.highlights) return;
    const v = this.views.get(this.highlights.pageId);
    if (!v) return;
    const m = pageMatrix(v.page, this.zoom);
    for (const [x, y, w, h] of this.highlights.boxes) {
      const corners = rectCorners(x, y, w, h, 0).map(([a, b]) => apply(m, a, b));
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      const d = document.createElement('div');
      d.className = 'gi-mark';
      d.style.left = `${Math.min(...xs) - 2}px`;
      d.style.top = `${Math.min(...ys) - 2}px`;
      d.style.width = `${Math.max(...xs) - Math.min(...xs) + 4}px`;
      d.style.height = `${Math.max(...ys) - Math.min(...ys) + 4}px`;
      v.marks.append(d);
    }
  }
}
