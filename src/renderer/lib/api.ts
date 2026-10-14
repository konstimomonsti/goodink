// The bridge between the UI and the Rust backend (Tauri). Same surface the app always used, so no
// screen or engine code knows which shell it runs in. Binary data travels as raw IPC bodies.
import { invoke } from '@tauri-apps/api/core';
import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow, availableMonitors, primaryMonitor } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getVersion } from '@tauri-apps/api/app';
import { documentDir, join } from '@tauri-apps/api/path';
import { open as openDlg, save as saveDlg } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { writeImage, readImage } from '@tauri-apps/plugin-clipboard-manager';
import type { Library, NotebookDoc, NotebookIndex, OcrWord, PageJSON, SavedElement, SearchHit, Settings, DiskScan, ThemePref } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';

type Filter = { name: string; extensions: string[] };

/** Files served straight from disk by the backend (gink:// protocol; Range requests supported). */
const FILES = 'http://gink.localhost';
type Channel = 'app:flush' | 'app:open-files' | 'present:frame' | 'present:laser' | 'present:closed';

const parse = <T>(text: string | null, fallback: T): T => {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};
const bytes = async (p: Promise<ArrayBuffer>) => new Uint8Array(await p);
const enc = (s: string) => encodeURIComponent(s);

async function pngFromClipboardImage(): Promise<Uint8Array | null> {
  try {
    const img = await readImage();
    const { width, height } = await img.size();
    const rgba = await img.rgba();
    const c = new OffscreenCanvas(width, height);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    return null; // nothing image-like on the clipboard
  }
}

/** Print page images through the WebView's own print dialog, from a hidden frame. */
function printImages(pages: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      `<!doctype html><html><head><style>@page{margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always}</style></head><body>${pages
        .map((src) => `<img src="${src}">`)
        .join('')}</body></html>`,
    );
    doc.close();
    const imgs = [...doc.images];
    Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => (i.onload = i.onerror = r))))).then(() => {
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
      setTimeout(() => {
        frame.remove();
        resolve(true);
      }, 500);
    });
  });
}

export interface BootData {
  library: Library;
  settings: Settings;
  elements: SavedElement[];
  info: { path: string; chosen: boolean };
  pending: string[];
  devices: { pen: boolean; touch: boolean; maxTouches: number };
  timeline: Record<string, number>;
}

/** On-device handwriting recognition (Windows ink stack, src-tauri/src/ink.rs). Boxes in page units. */
export interface InkWordOut { text: string; alternates: string[]; strokes: number[]; bbox: [number, number, number, number] }
export interface InkLineOut { group: number; text: string; words: InkWordOut[]; strokes: number[]; bbox: [number, number, number, number] }
export interface InkAnalysis { engine: 'analyzer' | 'recognizer'; lines: InkLineOut[]; drawings: number[]; ms: number }

export interface HmerOptions { model?: string; topK?: number; beam?: number; ep?: 'cpu' | 'dml'; xh?: number; pen?: number; square?: boolean; maxLen?: number; debugPng?: boolean }
export interface HmerResult { hyps: { latex: string; logp: number; prob: number; tokens: number }[]; model: string; ep: string; ms: number; renderMs: number; encMs: number; decMs: number; steps: number; loadMs: number; debugPng?: number[] | null }
export interface HmerStatus { models: { id: string; installed: boolean; bytes: number; loaded: boolean }[]; defaultModel: string; runtime: { Ok: string } | { Err: string } | null; dir: string }

export const api = {
  /** Everything the library screen needs, in one round trip. */
  boot: async (): Promise<BootData> => {
    type Raw = { library: string | null; settings: string | null; elements: string | null; info: { path: string; chosen: boolean }; pending: string[]; devices: { pen: boolean; touch: boolean; maxTouches: number }; timeline: Record<string, number> };
    // started by an inline script in index.html, so it overlaps loading this code
    const w = window as unknown as { __bootP?: Promise<Raw> };
    const early = w.__bootP;
    w.__bootP = undefined;
    const r = await (early ?? invoke<Raw>('boot'));
    return {
      library: parse(r.library, { version: 1, folders: [], notebooks: [] } as Library),
      settings: { ...DEFAULT_SETTINGS, ...parse(r.settings, {}) },
      elements: parse(r.elements, []),
      info: r.info,
      pending: r.pending,
      devices: r.devices ?? { pen: false, touch: false, maxTouches: 0 },
      timeline: r.timeline,
    };
  },
  assetUrl: (nb: string, id: string, ext: string) => `${FILES}/asset/${nb}/${id}.${ext}`,
  thumbUrl: (nb: string, version: number) => `${FILES}/thumb/${nb}?v=${version}`,
  loadLibrary: async (): Promise<Library> => parse(await invoke<string | null>('doc_read', { name: 'library.json' }), { version: 1, folders: [], notebooks: [] } as Library),
  /** saves the library and moves folders/notebooks/links on disk to match; returns what is on disk */
  saveLibrary: (lib: Library): Promise<DiskScan> => invoke('library_save', { json: JSON.stringify({ ...lib, files: undefined }) }),
  scanLibrary: (): Promise<DiskScan> => invoke('library_scan'),
  fileOpen: (rel: string): Promise<void> => invoke('file_open', { rel }),
  fileRename: (rel: string, name: string): Promise<string> => invoke('file_rename', { rel, name }),
  fileMove: (rel: string, folder: string | null): Promise<string> => invoke('file_move', { rel, folder }),
  fileImport: (paths: string[], folder: string | null): Promise<string[]> => invoke('file_import', { paths, folder }),
  fileTrash: (rel: string): Promise<void> => invoke('file_trash', { rel }),
  /** show a library file (by path) or a folder/notebook/link (by id) in Explorer */
  reveal: (what: { rel?: string; id?: string }): Promise<void> => invoke('item_reveal', { rel: what.rel ?? null, id: what.id ?? null }),
  loadSettings: async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...parse(await invoke<string | null>('doc_read', { name: 'settings.json' }), {}) }),
  saveSettings: (s: Settings): Promise<void> => invoke('doc_write', { name: 'settings.json', json: JSON.stringify(s, null, 1) }),
  loadElements: async (): Promise<SavedElement[]> => parse(await invoke<string | null>('doc_read', { name: 'elements.json' }), []),
  saveElements: (els: SavedElement[]): Promise<void> => invoke('doc_write', { name: 'elements.json', json: JSON.stringify(els) }),
  loadNotebook: async (id: string): Promise<NotebookDoc | null> => parse(await invoke<string | null>('nb_load', { id }), null),
  saveNotebook: (id: string, doc: NotebookDoc): Promise<void> => invoke('nb_save', { id, json: JSON.stringify(doc) }),
  deleteNotebook: (id: string): Promise<void> => invoke('nb_delete', { id }),
  duplicateNotebook: (from: string, to: string): Promise<void> => invoke('nb_duplicate', { from, to }),
  saveThumb: (id: string, png: Uint8Array): Promise<void> => invoke('thumb_save', png, { headers: { nb: id } }),
  getThumb: async (id: string): Promise<Uint8Array | null> => {
    const b = await bytes(invoke<ArrayBuffer>('thumb_get', { nb: id }));
    return b.byteLength ? b : null;
  },
  loadIndex: async (id: string): Promise<NotebookIndex> => parse(await invoke<string | null>('index_load', { id }), { pages: {} }),
  saveIndex: (id: string, idx: NotebookIndex): Promise<void> => invoke('index_save', { id, json: JSON.stringify(idx) }),
  loadPage: async (nb: string, page: string): Promise<PageJSON | null> => parse(await invoke<string | null>('page_load', { nb, page }), null),
  savePage: (nb: string, page: string, data: PageJSON): Promise<void> => invoke('page_save', { nb, page, json: JSON.stringify(data) }),
  putAsset: (nb: string, data: Uint8Array, ext: string): Promise<string> => invoke('asset_put', data, { headers: { nb, ext } }),
  getAsset: (nb: string, id: string, ext: string): Promise<Uint8Array> => bytes(invoke<ArrayBuffer>('asset_get', { nb, id, ext })),
  search: (q: string): Promise<SearchHit[]> => invoke('search', { q }),
  ocr: (png: Uint8Array): Promise<OcrWord[]> => invoke<OcrWord[]>('ocr', png).catch(() => []),
  /** strokes: x, y, pressure triples in page units; each group (stroke indices) is recognised on its own; no strokes = warm up */
  /** Local handwritten-math model (src-tauri/src/hmer.rs): a line's strokes -> top-k LaTeX readings. */
  hmerRecognize: (strokes: ArrayLike<number>[], opts: HmerOptions = {}): Promise<HmerResult> =>
    invoke<HmerResult>('hmer_recognize', { req: { strokes: strokes.map((p) => ({ pts: Array.from(p) })), ...opts } }),
  hmerStatus: (probe = false): Promise<HmerStatus> => invoke<HmerStatus>('hmer_status', { probe }),
  /** downloads the model (sha256 checked); progress arrives as `hmer://progress` events */
  hmerInstall: async (model?: string, onProgress?: (p: { model: string; file: string; received: number; total: number }) => void): Promise<void> => {
    const un = onProgress ? await listen<{ model: string; file: string; received: number; total: number }>('hmer://progress', (e) => onProgress(e.payload)) : null;
    try {
      await invoke('hmer_install', { model });
    } finally {
      un?.();
    }
  },
  inkAnalyze: (strokes: ArrayLike<number>[], opts: { groups?: number[][]; engine?: 'analyzer' | 'recognizer' } = {}): Promise<InkAnalysis> =>
    invoke<InkAnalysis>('ink_analyze', { req: { strokes: strokes.map((p) => ({ pts: Array.from(p) })), groups: opts.groups ?? [], engine: opts.engine } }),
  /**
   * On-device dictation (Windows speech recogniser, src-tauri/src/speech.rs). Partial text streams
   * to onPartial; stop() returns the final text. Rejects with a readable reason when Windows
   * settings block it (online speech recognition off, no speech language, microphone blocked).
   */
  speechStart: async (onPartial: (text: string) => void): Promise<{ stop(): Promise<string> }> => {
    const un = await listen<string>('speech:partial', (e) => onPartial(e.payload));
    try {
      await invoke('speech_start');
    } catch (e) {
      un();
      throw new Error(String(e));
    }
    let done: Promise<string> | null = null;
    return {
      stop: () =>
        (done ??= invoke<string>('speech_stop').finally(un)),
    };
  },
  openDialog: async (opts: { title?: string; filters: Filter[]; multi?: boolean }): Promise<string[]> => {
    const r = await openDlg({ title: opts.title, filters: opts.filters, multiple: !!opts.multi, directory: false });
    return r == null ? [] : Array.isArray(r) ? r : [r];
  },
  saveDialog: async (opts: { title?: string; defaultPath: string; filters: Filter[] }): Promise<string | null> =>
    (await saveDlg({ title: opts.title, defaultPath: await join(await documentDir(), opts.defaultPath), filters: opts.filters })) ?? null,
  folderDialog: async (): Promise<string | null> => {
    const r = await openDlg({ directory: true, multiple: false });
    return typeof r === 'string' ? r : null;
  },
  readFile: (p: string): Promise<Uint8Array> => bytes(invoke<ArrayBuffer>('file_read', { path: p })),
  writeFile: (p: string, data: Uint8Array): Promise<void> => invoke('file_write', data, { headers: { path: enc(p) } }),
  revealFile: (p: string): Promise<void> => revealItemInDir(p),
  /** open a web page in the user's browser (https only) */
  openUrl: (url: string): Promise<void> => (/^https:\/\//.test(url) ? openUrl(url) : Promise.resolve()),
  /** Dropped files arrive as bytes; the backend parks them in a temp file and returns its path. */
  pathForFile: async (f: File): Promise<string> => invoke<string>('temp_file', new Uint8Array(await f.arrayBuffer()), { headers: { name: enc(f.name) } }),
  clipboardWriteImage: (png: Uint8Array): Promise<void> => writeImage(png),
  clipboardReadImage: (): Promise<Uint8Array | null> => pngFromClipboardImage(),
  setTheme: async (t: ThemePref): Promise<boolean> => {
    const w = getCurrentWindow();
    await w.setTheme(t === 'system' ? null : t).catch(() => undefined);
    const dark = t === 'dark' || (t === 'system' && (await w.theme()) === 'dark');
    await w.setBackgroundColor(dark ? '#121214' : '#f2f2f5').catch(() => undefined);
    return dark;
  },
  libraryPath: async (): Promise<string> => (await invoke<{ path: string }>('library_info')).path,
  libraryInfo: (): Promise<{ path: string; chosen: boolean }> => invoke('library_info'),
  chooseLibrary: (folder: string | null): Promise<{ relaunch?: boolean; path?: string; error?: string }> => invoke('library_choose', { folder }),
  /**
   * Show a web page in a goodink window (a separate browser window inside the app). The window gets
   * no app permissions: it is listed in no capability, so the page cannot reach goodink or your files.
   */
  openWebWindow: async (url: string, title: string): Promise<void> => {
    if (!/^https?:\/\//.test(url)) return;
    const label = `web-${[...url].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7).toString(36).replace('-', 'n')}`;
    await invoke('web_window_open', { label, url, title });
  },
  /** a web page laid over the main window (see WebPreview) */
  webPreviewCreate: (label: string, url: string, r: { x: number; y: number; width: number; height: number }) => invoke<void>('web_preview_create', { label, url, ...r }),
  presentOpen: async (): Promise<void> => {
    const existing = await WebviewWindow.getByLabel('present');
    if (existing) {
      await existing.setFocus();
      return;
    }
    const [mons, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
    const external = mons.find((m) => m.name !== primary?.name);
    const target = external ?? primary;
    const scale = target?.scaleFactor ?? 1;
    await invoke('present_open', {
      x: target ? target.position.x / scale : null,
      y: target ? target.position.y / scale : null,
      width: external ? external.size.width / scale : 1280,
      height: external ? external.size.height / scale : 800,
      fullscreen: !!external,
    });
    const w = await WebviewWindow.getByLabel('present');
    void w?.once('tauri://destroyed', () => void getCurrentWindow().emit('present:closed'));
  },
  presentClose: async (): Promise<void> => {
    await (await WebviewWindow.getByLabel('present'))?.destroy();
  },
  presentFrame: (frame: { src: string; w: number; h: number }) => void emitTo('present', 'present:frame', frame).catch(() => undefined),
  presentLaser: (pts: { x: number; y: number; t: number }[]) => void emitTo('present', 'present:laser', pts).catch(() => undefined),
  print: (pages: string[]): Promise<boolean> => printImages(pages),
  backupExport: (nbId: string, meta: unknown, target: string): Promise<void> => invoke('backup_export', { nb: nbId, meta, target }),
  backupImport: (file: string, newId: string): Promise<any> => invoke('backup_import', { file, newId }),
  pendingOpen: (): Promise<string[]> => invoke('pending_open'),
  version: (): Promise<string> => getVersion(),
  flushed: (): Promise<void> => invoke('app_flushed'),
  toggleFullscreen: async (): Promise<void> => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  },
  devtools: (): Promise<void> => invoke('devtools'),
  isTest: (): Promise<boolean> => invoke('is_test'),
  on(channel: Channel, fn: (...args: any[]) => void): () => void {
    let un: UnlistenFn | null = null;
    let dead = false;
    void listen(channel, (e) => fn(e.payload)).then((u) => (dead ? u() : (un = u)));
    return () => {
      dead = true;
      un?.();
    };
  },
};

export type GinkApi = typeof api;

declare global {
  interface Window {
    gink: GinkApi;
  }
}

// a few engine paths (clipboard, OCR) and the test suite reach the bridge through window.gink
window.gink = api;
