import { create } from 'zustand';
import type { LinkRef, Cover, DiskScan, FileItem, Folder, Library, LinkItem, NotebookDoc, NotebookIndex, NotebookMeta, PageMeta, PdfObject, SavedElement, SearchWord, Settings, Template } from '../../shared/types';
import { DEFAULT_SETTINGS, PAGE_SIZES } from '../../shared/types';
import { api } from './api';
import { startMemoryManager } from './memory';
import { baseName, debounce, extOf, uid } from './util';
import type { Tool, ToolState } from '../engine/viewport';
import type { NotebookSession, SessionHooks } from '../engine/session';

// The PDF engine and the notebook engine load on demand, so the library appears without them.
const pdfEngine = () => import('../engine/pdf');

export type Section = 'all' | 'favorites' | 'recents' | 'trash' | 'search' | 'study';

export type Dialog =
  | { type: 'new-notebook'; folderId: string | null }
  | { type: 'settings' }
  | { type: 'export'; nbId: string; pageIndex?: number }
  | { type: 'rename'; kind: 'notebook' | 'folder' | 'link' | 'file'; id: string }
  | { type: 'move'; ids: string[] }
  | { type: 'cover'; nbId: string }
  | { type: 'template'; nbId: string; scope: 'page' | 'new-page' }
  | { type: 'shortcuts' }
  | { type: 'confirm'; title: string; body: string; danger?: boolean; ok: string; run: () => void }
  | { type: 'password'; title: string; resolve: (pw: string | null) => void }
  | { type: 'ai'; nbId: string; pageIndex?: number }
  | null;

export interface Toast {
  id: string;
  msg: string;
  kind?: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
  progress?: number;
}

interface AppState {
  ready: boolean;
  library: Library;
  settings: Settings;
  elements: SavedElement[];
  tabs: string[];
  active: string | null;
  section: Section;
  folderId: string | null;
  query: string;
  picked: string[];
  /** Study should open its card maker for this source (set by "Make flashcards in Study…") */
  studyRequest: { kind: 'notebook' | 'sources' | 'folder'; id: string; at: number } | null;
  tools: ToolState;
  tempTool: Tool | null;
  toasts: Toast[];
  dialog: Dialog;
  dark: boolean;
  pageOf: Record<string, number>;
  askStorage: boolean;
  /** a link was followed: the editor of this notebook scrolls to the page, then clears it */
  /** page: a page id, or a 1-based page number ([[Name#3]]) */
  jump: { nb: string; page?: string | number; at: number } | null;
}

function toolsFrom(s: Settings): ToolState {
  return {
    tool: 'pen',
    penKind: s.penKind,
    penColor: s.penColors[0],
    penWidth: s.penSizes[1],
    hlColor: s.hlColors[0],
    hlWidth: s.hlSizes[1],
    straightHighlighter: s.straightHighlighter,
    eraserWidth: 12,
    eraserMode: s.eraserMode,
    eraserHlOnly: s.eraserHighlighterOnly,
    eraserAutoDeselect: s.eraserAutoDeselect,
    tapeColor: '#7d9cff',
    tapeWidth: 18,
    holdToShape: s.holdToShape,
    holdDelay: s.holdDelayMs,
    pressure: s.pressure,
    stylusMode: s.stylusMode,
    laserMode: s.laserMode,
    laserColor: '#ff3b30',
    text: { font: 'sans', size: 14, color: '#1b1b1f', align: 'left', ...s.textStyle },
  };
}

export const useApp = create<AppState>(() => ({
  ready: false,
  library: { version: 1, folders: [], notebooks: [] },
  settings: DEFAULT_SETTINGS,
  elements: [],
  tabs: [],
  active: null,
  section: 'all',
  folderId: null,
  query: '',
  studyRequest: null,
  picked: [],
  tools: toolsFrom(DEFAULT_SETTINGS),
  tempTool: null,
  toasts: [],
  dialog: null,
  dark: false,
  pageOf: {},
  jump: null,
  askStorage: false,
}));

const set = useApp.setState;
const get = useApp.getState;

// ---- sessions -----------------------------------------------------------------------------------

/** a pen is known on this PC (digitizer reported by Windows, or seen before) */
export let penKnown = false;

/** first pen contact on this PC: remember it so fingers scroll from the next launch on */
export function notePenUsed() {
  penKnown = true;
  if (!get().settings.penDevice) updateSettings({ penDevice: true });
}

export const sessions = new Map<string, NotebookSession>();
const opening = new Map<string, Promise<NotebookSession>>();

export function getSession(id: string): Promise<NotebookSession> {
  const have = sessions.get(id);
  if (have) return Promise.resolve(have);
  let p = opening.get(id);
  if (!p) {
    const meta = get().library.notebooks.find((n) => n.id === id);
    if (!meta) return Promise.reject(new Error('Notebook not found'));
    p = import('../engine/session')
      .then(({ NotebookSession, sessionHooks }) => {
        installHooks(sessionHooks);
        return NotebookSession.open(meta);
      })
      .then((s) => {
        s.ocrEnabled = get().settings.ocrEnabled;
        sessions.set(id, s);
        return s;
      })
      .finally(() => opening.delete(id));
    opening.set(id, p);
  }
  return p;
}

let hooksInstalled = false;
function installHooks(sessionHooks: SessionHooks) {
  if (hooksInstalled) return;
  hooksInstalled = true;
  sessionHooks.onSaved = (s, info) => {
  patchNotebook(s.id, { pageCount: info.pageCount, firstPage: info.firstPage, updatedAt: Date.now(), ...(info.thumb ? { thumbVersion: (s.meta.thumbVersion ?? 0) + 1 } : {}) });
  const meta = get().library.notebooks.find((n) => n.id === s.id);
  if (meta) s.meta = meta;
  };
}

/** Extra stores that must be written before the app closes (Study). */
export const flushHooks: (() => Promise<void>)[] = [];

export async function flushAll() {
  await Promise.all([...sessions.values()].map((s) => s.flush()));
  await Promise.all(flushHooks.map((f) => f().catch(() => undefined)));
  await persistLibrary();
}

/** Save everything, then point the app at another notebooks folder (null = keep the current one). */
export async function changeLibraryFolder(folder: string | null): Promise<boolean> {
  await Promise.all([...sessions.values()].map((s) => s.flush()));
  saveLibrarySoon.cancel();
  await api.saveLibrary(get().library);
  await api.saveSettings(get().settings);
  const r = await api.chooseLibrary(folder);
  if (r.error) {
    toast(`Could not use that folder: ${r.error}`, { kind: 'error', ms: 8000 });
    return false;
  }
  if (!r.relaunch) set({ askStorage: false });
  // when the folder changed, the main process reloads the window with the new library
  return true;
}

// ---- boot ---------------------------------------------------------------------------------------

export async function boot() {
  performance.mark('gi-boot-call');
  const { library, settings, elements, info, pending, timeline, devices } = await api.boot();
  // smart pen detection: Windows reports a pen digitizer, or a pen was used here before
  penKnown = devices.pen || !!settings.penDevice;
  performance.mark('gi-boot-data');
  (window as unknown as { __timeline: unknown }).__timeline = { ...timeline, navigation: Math.round(performance.timeOrigin), bootData: Date.now() };
  // the window already started in the right colours (the backend read settings.json); just match it
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  void api.setTheme(settings.theme);
  libraryRoot = info.path;
  set({ library, settings, elements, tools: toolsFrom(settings), ready: true, dark });
  applyTheme(dark);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    const d = await api.setTheme(get().settings.theme);
    set({ dark: d });
    applyTheme(d);
  });
  startMemoryManager(() => {
    void pdfEngine().then((m) => m.trimPdfCaches());
    window.dispatchEvent(new Event('goodink:trim'));
  });
  if (!info.chosen) set({ askStorage: true });
  // warm the editor and PDF engine while the user looks at the library: opening is then instant
  requestIdleCallback(() => {
    void import('../engine/session');
    void pdfEngine();
  }, { timeout: 3000 });
  // purge trash older than 30 days
  const cutoff = Date.now() - 30 * 86400_000;
  for (const nb of library.notebooks.filter((n) => n.deletedAt && n.deletedAt < cutoff)) void deleteForever([nb.id], true);
  if (pending.length) void openFiles(pending);
  // the folders on disk are the library: read them now and whenever goodink comes back to the front
  void refreshFromDisk();
  window.addEventListener('focus', () => void refreshFromDisk());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refreshFromDisk());
  api.on('app:open-files', (files: string[]) => void openFiles(files));
  api.on('app:flush', async () => {
    await flushAll().catch(() => undefined);
    await api.flushed();
  });
}

function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ---- settings -----------------------------------------------------------------------------------

const saveSettingsSoon = debounce((s: Settings) => void api.saveSettings(s), 300);

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  saveSettingsSoon(settings);
  if (patch.theme) void api.setTheme(patch.theme).then((d) => {
    set({ dark: d });
    applyTheme(d);
  });
  const t = get().tools;
  set({
    tools: {
      ...t,
      holdToShape: settings.holdToShape,
      holdDelay: settings.holdDelayMs,
      pressure: settings.pressure,
      stylusMode: settings.stylusMode,
      eraserMode: settings.eraserMode,
      eraserHlOnly: settings.eraserHighlighterOnly,
      eraserAutoDeselect: settings.eraserAutoDeselect,
      straightHighlighter: settings.straightHighlighter,
      laserMode: settings.laserMode,
      penKind: patch.penKind ?? t.penKind,
    },
  });
  if (patch.ocrEnabled != null) for (const s of sessions.values()) s.ocrEnabled = patch.ocrEnabled;
}

export function setTools(patch: Partial<ToolState>) {
  set({ tools: { ...get().tools, ...patch } });
  if (patch.penKind) updateSettings({ penKind: patch.penKind });
  if (patch.text) updateSettings({ textStyle: patch.text });
}

// ---- toasts -------------------------------------------------------------------------------------

export function toast(msg: string, opts: Omit<Toast, 'id' | 'msg'> & { ms?: number } = {}): string {
  const id = uid();
  set({ toasts: [...get().toasts.slice(-3), { id, msg, kind: opts.kind, action: opts.action, progress: opts.progress }] });
  if (opts.progress == null) setTimeout(() => dismissToast(id), opts.ms ?? 4200);
  return id;
}

export function updateToast(id: string, patch: Partial<Toast>) {
  set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

export function dismissToast(id: string) {
  set({ toasts: get().toasts.filter((t) => t.id !== id) });
}

export function openDialog(d: Dialog) {
  set({ dialog: d });
}

export function closeDialog() {
  set({ dialog: null });
}

export function confirmDialog(title: string, body: string, ok: string, run: () => void, danger = true) {
  openDialog({ type: 'confirm', title, body, ok, run, danger });
}

export function askPassword(title: string): Promise<string | null> {
  return new Promise((resolve) => openDialog({ type: 'password', title, resolve }));
}

// ---- library persistence ------------------------------------------------------------------------

// The library's folders are real folders on disk. Every save also moves folders, notebook folders and
// .url files into place (backend: tree.rs) and answers with what is on disk, so changes made in
// Explorer (new folders, files dropped in, things renamed or deleted) come back into goodink.

let saving: Promise<void> = Promise.resolve();
let unsaved = false;

function persistLibrary(): Promise<void> {
  saveLibrarySoon.cancel();
  unsaved = false;
  saving = saving.then(async () => {
    try {
      applyDisk(await api.saveLibrary(get().library));
    } catch (e) {
      console.warn('saving the library failed', e);
    }
  });
  return saving;
}
const saveLibrarySoon = debounce(() => void persistLibrary(), 250);
function saveLibraryNow() {
  void persistLibrary();
}

function setLibrary(fn: (l: Library) => Library) {
  set({ library: fn(get().library) });
  unsaved = true;
  saveLibrarySoon();
}

/** Look at the disk again (goodink came back to the front): pending changes are saved first. */
export function refreshFromDisk(): Promise<void> {
  if (unsaved) return persistLibrary();
  saving = saving.then(async () => {
    try {
      applyDisk(await api.scanLibrary());
    } catch (e) {
      console.warn('reading the library folder failed', e);
    }
  });
  return saving;
}

/** A title as the file name it gets on disk (same rule as tree.rs file_name). */
export function diskName(title: string) {
  let s = [...title].map((c) => (c < ' ' || '<>:"/\\|?*'.includes(c) ? '_' : c)).join('').trim().replace(/[. ]+$/, '');
  if ([...s].length > 120) s = [...s].slice(0, 120).join('').replace(/[. ]+$/, '');
  if (!s || s.startsWith('.')) s = `Untitled${s}`;
  const stem = s.split('.')[0].toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL'].includes(stem) || /^(COM|LPT)\d$/.test(stem)) s += '_';
  return s;
}

/** Renamed in Explorer: the name on disk is not what goodink would have made from the title. */
const renamedOnDisk = (title: string, name: string) => name !== diskName(title) && name.replace(/ \(\d+\)$/, '') !== diskName(title);

/** Items made in the last moments may not be on disk yet: never drop those. */
const FRESH_MS = 20_000;

function applyDisk(scan: DiskScan) {
  const lib = get().library;
  const now = Date.now();
  const fresh = (t: number) => now - t < FRESH_MS;
  const trashed = new Set(scan.trashed);
  let changed = false;
  const gone: string[] = [];

  // folders
  const fd = new Map(scan.folders.map((f) => [f.id, f]));
  const folders: Folder[] = [];
  for (const f of lib.folders) {
    const d = fd.get(f.id);
    fd.delete(f.id);
    if (f.deletedAt) {
      if (d || trashed.has(f.id) || fresh(f.deletedAt)) folders.push(f);
      else changed = true;
      continue;
    }
    if (!d) {
      if (trashed.has(f.id) || fresh(f.createdAt)) folders.push(f);
      else changed = true;
      continue;
    }
    const title = renamedOnDisk(f.title, d.name) ? d.name : f.title;
    if (title !== f.title || d.parent !== f.parentId) {
      changed = true;
      folders.push({ ...f, title, parentId: d.parent, updatedAt: now });
    } else folders.push(f);
  }
  for (const d of fd.values()) {
    changed = true;
    folders.push({ id: d.id, title: d.name, parentId: d.parent, color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length], createdAt: d.created || now, updatedAt: now, deletedAt: null });
  }

  // notebooks
  const nd = new Map(scan.notebooks.map((n) => [n.id, n]));
  const notebooks: NotebookMeta[] = [];
  for (const n of lib.notebooks) {
    const d = nd.get(n.id);
    nd.delete(n.id);
    if (n.deletedAt) {
      if (d || trashed.has(n.id) || fresh(n.deletedAt)) notebooks.push(n);
      else {
        changed = true;
        gone.push(n.id);
      }
      continue;
    }
    if (!d) {
      if (trashed.has(n.id) || fresh(n.createdAt)) notebooks.push(n);
      else {
        changed = true;
        gone.push(n.id);
      }
      continue;
    }
    if (d.staged || d.name === undefined) {
      notebooks.push(n);
      continue;
    }
    const title = renamedOnDisk(n.title, d.name) ? d.name : n.title;
    if (title !== n.title || (d.parent ?? null) !== n.folderId) {
      changed = true;
      notebooks.push({ ...n, title, folderId: d.parent ?? null });
    } else notebooks.push(n);
  }
  for (const d of nd.values()) {
    if (d.staged || d.name === undefined) continue;
    changed = true;
    const meta = newMeta(d.name, d.parent ?? null, { style: 'solid', color: '#2f5b8a' }, 'notebook', { w: d.w ?? 595, h: d.h ?? 842 }, d.pages ?? 1);
    notebooks.push({ ...meta, id: d.id, openedAt: 0 });
  }

  // links
  const ld = new Map(scan.links.map((x) => [x.id, x]));
  const links: LinkItem[] = [];
  for (const x of lib.links ?? []) {
    const d = ld.get(x.id);
    ld.delete(x.id);
    if (x.deletedAt) {
      if (d || trashed.has(x.id) || fresh(x.deletedAt)) links.push(x);
      else changed = true;
      continue;
    }
    if (!d) {
      if (trashed.has(x.id) || fresh(x.createdAt)) links.push(x);
      else {
        changed = true;
        gone.push(x.id);
      }
      continue;
    }
    const title = renamedOnDisk(x.title, d.name) ? d.name : x.title;
    if (title !== x.title || d.parent !== x.folderId || d.url !== x.url) {
      changed = true;
      links.push({ ...x, title, folderId: d.parent, url: d.url, updatedAt: now });
    } else links.push(x);
  }
  for (const d of ld.values()) {
    changed = true;
    const kind: LinkItem['kind'] = d.kind === 'youtube' || /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(d.url) ? 'youtube' : 'link';
    links.push({ id: d.id, kind, title: d.name, url: d.url, author: d.author || undefined, folderId: d.parent, createdAt: d.modified || now, updatedAt: now, openedAt: 0, deletedAt: null });
  }

  const files = scan.files.map((f) => ({ rel: f.rel, name: f.name, folderId: f.parent, size: f.size, modified: f.modified }));
  const filesChanged = JSON.stringify(files) !== JSON.stringify(lib.files ?? []);
  if (!changed && !filesChanged) return;
  set({ library: { ...get().library, ...(changed ? { folders, notebooks, links } : {}), files } });
  for (const id of gone) if (get().tabs.includes(id)) void closeTab(id);
  // a folder that went away in Explorer: show the top level
  const at = get().folderId;
  if (at && !get().library.folders.some((f) => f.id === at && !f.deletedAt)) set({ folderId: null });
  if (changed) {
    unsaved = true;
    saveLibrarySoon();
  }
}

export function patchNotebook(id: string, patch: Partial<NotebookMeta>) {
  setLibrary((l) => ({ ...l, notebooks: l.notebooks.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
}

export function patchLink(id: string, patch: Partial<LinkItem>) {
  setLibrary((l) => ({ ...l, links: (l.links ?? []).map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)) }));
}

/** Add a web page or YouTube video to a folder (null = the top level). Returns its id. */
export function addLink(item: { kind: LinkItem['kind']; title: string; url: string; author?: string; folderId: string | null; id?: string }) {
  const now = Date.now();
  const link: LinkItem = { id: item.id ?? uid(), kind: item.kind, title: item.title.trim() || item.url, url: item.url, author: item.author, folderId: item.folderId, createdAt: now, updatedAt: now, openedAt: 0, deletedAt: null };
  setLibrary((l) => ({ ...l, links: [...(l.links ?? []), link] }));
  // a new link would be hidden by "Notebooks": show everything
  if (get().settings.filesView !== 'all') updateSettings({ filesView: 'all' });
  return link.id;
}

export const findLink = (id: string) => (get().library.links ?? []).find((x) => x.id === id);

/** Open a link or video in its own tab, next to open notebooks. */
export function openLink(id: string) {
  if (!findLink(id)) return;
  patchLink(id, { openedAt: Date.now() });
  const tabs = get().tabs.includes(id) ? get().tabs : [...get().tabs, id];
  set({ tabs, active: id });
}

/** Open whatever an id is: notebook or link. */
export function openItem(id: string) {
  if (findLink(id)) openLink(id);
  else void openNotebook(id);
}

/** The folder path from the top, e.g. ["Chemistry", "Organic"]. */
export function folderPath(folderId: string | null): Folder[] {
  const lib = get().library;
  const out: Folder[] = [];
  for (let f = lib.folders.find((x) => x.id === folderId); f; f = lib.folders.find((x) => x.id === f!.parentId)) out.unshift(f);
  return out;
}

export function patchFolder(id: string, patch: Partial<Folder>) {
  setLibrary((l) => ({ ...l, folders: l.folders.map((f) => (f.id === id ? { ...f, ...patch, updatedAt: Date.now() } : f)) }));
}


// ---- navigation ---------------------------------------------------------------------------------

export function showSection(section: Section, folderId: string | null = null) {
  set({ section, folderId, active: null, picked: [] });
}

export async function openNotebook(id: string) {
  const meta = get().library.notebooks.find((n) => n.id === id);
  if (!meta) return;
  if (meta.lock && !sessions.has(id)) {
    const pw = await askPassword(`Unlock “${meta.title}”`);
    if (pw == null) return;
    if (!(await checkPassword(meta.lock, pw))) {
      toast('That password is not right.', { kind: 'error' });
      return;
    }
  }
  patchNotebook(id, { openedAt: Date.now() });
  const tabs = get().tabs.includes(id) ? get().tabs : [...get().tabs, id];
  set({ tabs, active: id });
}

export async function closeTab(id: string) {
  const tabs = get().tabs.filter((t) => t !== id);
  const wasActive = get().active === id;
  const idx = get().tabs.indexOf(id);
  set({ tabs, active: wasActive ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : get().active });
  const s = sessions.get(id);
  if (s) {
    sessions.delete(id);
    await s.close();
  }
}

export function activateTab(id: string | null) {
  set({ active: id });
}

// ---- links between notes ----------------------------------------------------------------------------

/** Replace what one page links to (of one kind) in the library-wide index, for backlinks. */
export function setPageLinks(fromNb: string, fromPage: string, kind: LinkRef['kind'], targets: { nb: string; page?: string }[]) {
  const old = get().library.noteLinks ?? [];
  const kept = old.filter((r) => !(r.fromNb === fromNb && r.fromPage === fromPage && r.kind === kind));
  const next = [...kept, ...targets.map((t) => ({ fromNb, fromPage, toNb: t.nb, ...(t.page ? { toPage: t.page } : {}), kind }))];
  if (JSON.stringify(next) === JSON.stringify(old)) return;
  setLibrary((l) => ({ ...l, noteLinks: next }));
}

/** What links to this notebook (and page): links to the page, and links to the whole notebook. */
export function backlinksTo(nb: string, page?: string): LinkRef[] {
  const alive = new Set(get().library.notebooks.filter((n) => !n.deletedAt).map((n) => n.id));
  return (get().library.noteLinks ?? []).filter((r) => r.toNb === nb && alive.has(r.fromNb) && (!r.toPage || !page || r.toPage === page));
}

/** A notebook by name, for [[Name]] in typed text (case and spacing do not matter). */
export function notebookByName(name: string): string | null {
  const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
  const k = key(name);
  return get().library.notebooks.find((n) => !n.deletedAt && key(n.title) === k)?.id ?? null;
}

/** Follow a link: open the notebook (or bring its tab forward) at the page. */
export async function jumpToNote(nb: string, page?: string | number) {
  if (!get().library.notebooks.some((n) => n.id === nb && !n.deletedAt)) {
    toast('That note no longer exists.', { kind: 'error' });
    return;
  }
  set({ jump: { nb, page, at: Date.now() } });
  await openNotebook(nb);
}

// ---- creation -----------------------------------------------------------------------------------

function newMeta(title: string, folderId: string | null, cover: Cover, kind: NotebookMeta['kind'], first: { w: number; h: number }, pageCount: number): NotebookMeta {
  const now = Date.now();
  return { id: uid(), title, folderId, kind, cover, favorite: false, pageCount, firstPage: first, createdAt: now, updatedAt: now, openedAt: now, deletedAt: null, thumbVersion: 0 };
}

export function makePage(w: number, h: number, template: Template): PageMeta {
  return { id: uid(), w, h, template, rotation: 0 };
}

/** Starting size of an infinite canvas page (points); it grows from here. */
export const INFINITE_START = 3000;

export async function createNotebook(opts: { title: string; folderId: string | null; cover: Cover; template: Template; size: keyof typeof PAGE_SIZES; landscape: boolean; kind?: NotebookMeta['kind']; open?: boolean; infinite?: boolean }) {
  const sz = PAGE_SIZES[opts.size];
  const [w, h] = opts.infinite ? [INFINITE_START, INFINITE_START] : opts.landscape ? [sz.h, sz.w] : [sz.w, sz.h];
  const first = makePage(w, h, opts.template);
  if (opts.infinite) Object.assign(first, { infinite: true, ox: -INFINITE_START / 2, oy: -INFINITE_START / 2 });
  const meta = newMeta(opts.title.trim() || 'Untitled notebook', opts.folderId, opts.cover, opts.kind ?? 'notebook', { w, h }, 1);
  const doc: NotebookDoc = { id: meta.id, pages: [first], outline: [], recordings: [], assets: {}, flashcards: opts.kind === 'flashcards' ? [] : undefined };
  await api.saveNotebook(meta.id, doc);
  setLibrary((l) => ({ ...l, notebooks: [...l.notebooks, meta] }));
  saveLibraryNow();
  if (opts.open !== false) void openNotebook(meta.id);
  return meta.id;
}

/** Open Study on the library tab and start making flashcards from a notebook. */
export function makeCardsFrom(nbId: string) {
  set({ studyRequest: { kind: 'notebook', id: nbId, at: Date.now() } });
  activateTab(null);
  showSection('study');
}

/** Study a library folder: its items and deck (Study otherwise opens on the decks). */
export function studyFolder(folderId: string | null) {
  set({ studyRequest: { kind: 'folder', id: folderId ?? '', at: Date.now() } });
  activateTab(null);
  showSection('study', folderId);
}

/** Open Study's resources and search the web and YouTube for what a notebook covers. */
export function findSourcesFor(nbId: string) {
  set({ studyRequest: { kind: 'sources', id: nbId, at: Date.now() } });
  activateTab(null);
  showSection('study');
}

export async function quickNote() {
  const s = get().settings;
  const d = new Date();
  return createNotebook({
    title: `Quick note ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    folderId: get().folderId,
    cover: { style: 'none', color: '#ffffff' },
    template: s.defaultTemplate,
    size: s.defaultSize,
    landscape: s.defaultOrientation === 'landscape',
  });
}

export async function importPdfFile(path: string, folderId: string | null = get().folderId, open = true): Promise<string | null> {
  const { openPdf, pageWords, pdfOutline, pdfPageSizes, isPasswordError } = await pdfEngine();
  const tid = toast(`Importing ${baseName(path)}…`, { progress: 0 });
  try {
    const bytes = await api.readFile(path);
    let pdf;
    try {
      pdf = await openPdf(bytes);
    } catch (e) {
      if (!isPasswordError(e)) throw e;
      const pw = await askPassword(`“${baseName(path)}” is password protected`);
      if (pw == null) {
        dismissToast(tid);
        return null;
      }
      pdf = await openPdf(bytes, pw);
    }
    const sizes = await pdfPageSizes(pdf);
    const meta = newMeta(baseName(path), folderId, { style: 'none', color: '#ffffff' }, 'pdf', sizes[0], sizes.length);
    const assetId = await api.putAsset(meta.id, bytes, 'pdf');
    const pages: PageMeta[] = sizes.map((s, i) => ({ id: uid(), w: s.w, h: s.h, template: { kind: 'blank', paper: 'white' }, rotation: 0, bg: { type: 'pdf', asset: assetId, page: i } }));
    const outline = (await pdfOutline(pdf)).filter((o) => pages[o.pageIndex]).map((o) => ({ id: uid(), title: o.title, pageId: pages[o.pageIndex].id }));
    const doc: NotebookDoc = { id: meta.id, pages, outline, recordings: [], assets: { [assetId]: { ext: 'pdf', name: baseName(path), bytes: bytes.byteLength } } };
    await api.saveNotebook(meta.id, doc);
    // text index for search
    const index: NotebookIndex = { pages: {} };
    for (let i = 0; i < pages.length; i++) {
      const words = await pageWords(pdf, i).catch(() => []);
      index.pages[pages[i].id] = { typed: [], pdf: words, ocr: [], ocrStamp: -1 };
      if (i % 8 === 0) updateToast(tid, { progress: (i + 1) / pages.length });
    }
    await api.saveIndex(meta.id, index);
    await pdf.loadingTask.destroy();
    setLibrary((l) => ({ ...l, notebooks: [...l.notebooks, meta] }));
    saveLibraryNow();
    dismissToast(tid);
    toast(`Imported ${sizes.length} page${sizes.length === 1 ? '' : 's'}`, { kind: 'success' });
    if (open) await openNotebook(meta.id);
    // thumbnail
    void getSession(meta.id).then(async (s) => {
      s.requestThumb();
      await s.flush();
      if (!get().tabs.includes(meta.id)) {
        sessions.delete(meta.id);
        await s.close();
      }
    });
    return meta.id;
  } catch (e) {
    dismissToast(tid);
    toast(`Could not import ${baseName(path)}: ${(e as Error).message}`, { kind: 'error', ms: 7000 });
    return null;
  }
}


export async function importImageFiles(paths: string[], folderId: string | null = get().folderId) {
  const id = await createNotebook({ title: baseName(paths[0]), folderId, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: false });
  const s = await getSession(id);
  const pages: PageMeta[] = [];
  for (const p of paths) {
    const bytes = await api.readFile(p);
    const ext = extOf(p) === 'jpeg' ? 'jpg' : extOf(p);
    const assetId = await s.addAsset(bytes, ext);
    const img = (await s.loadImage(`asset:${assetId}`)) as ImageBitmap | null;
    const iw = img?.width ?? 1000, ih = img?.height ?? 1400;
    const scale = 595 / Math.max(iw, ih) * (iw > ih ? 842 / 595 : 1);
    pages.push({ id: uid(), w: iw * scale, h: ih * scale, template: { kind: 'blank', paper: 'white' }, rotation: 0, bg: { type: 'image', asset: assetId } });
  }
  s.setPages(pages, { record: false });
  s.requestThumb();
  await s.flush();
  await openNotebook(id);
}

export async function importBackup(path: string) {
  const newId = uid();
  try {
    const meta = (await api.backupImport(path, newId)) as NotebookMeta;
    const now = Date.now();
    const nm: NotebookMeta = { ...meta, id: newId, folderId: get().folderId, deletedAt: null, openedAt: now, updatedAt: now };
    setLibrary((l) => ({ ...l, notebooks: [...l.notebooks, nm] }));
    saveLibraryNow();
    toast(`Restored “${nm.title}”`, { kind: 'success' });
    await openNotebook(newId);
  } catch (e) {
    toast(`Could not open backup: ${(e as Error).message}`, { kind: 'error' });
  }
}

export async function openFiles(paths: string[]) {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
  const imgs = paths.filter((p) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p));
  const backups = paths.filter((p) => /\.gink$/i.test(p));
  const other = paths.filter((p) => !pdfs.includes(p) && !imgs.includes(p) && !backups.includes(p));
  for (const p of pdfs) await importPdfFile(p);
  if (imgs.length) await importImageFiles(imgs);
  for (const b of backups) await importBackup(b);
  if (other.length) await addFiles(other);
}

/** Copy files as they are into a folder of the library (any kind: Word, Excel, photos, PDFs …). */
export async function addFiles(paths: string[], folderId: string | null = get().folderId) {
  try {
    const added = await api.fileImport(paths, folderId);
    await refreshFromDisk();
    if (get().settings.filesView !== 'all') updateSettings({ filesView: 'all' });
    const where = folderId ? get().library.folders.find((f) => f.id === folderId)?.title : 'Files';
    toast(`Added ${added.length} file${added.length === 1 ? '' : 's'} to ${where}`, { kind: 'success' });
  } catch (e) {
    toast(`Could not add the files: ${e}`, { kind: 'error' });
  }
}

export async function pickFiles() {
  const files = await api.openDialog({ title: 'Add files', filters: [{ name: 'All files', extensions: ['*'] }], multi: true });
  if (files.length) await addFiles(files);
}

let libraryRoot = '';
/** Where a library file is on this PC. */
export const filePath = (rel: string) => `${libraryRoot.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`;

/**
 * Open a file of the library: a PDF opens in goodink to write on (a notebook next to it, made once),
 * everything else in its usual app.
 */
export async function openLibraryFile(f: FileItem) {
  if (/\.pdf$/i.test(f.name)) {
    const title = f.name.replace(/\.pdf$/i, '');
    const have = get().library.notebooks.find((n) => !n.deletedAt && n.kind === 'pdf' && n.folderId === f.folderId && n.title === title);
    if (have) return void openNotebook(have.id);
    await importPdfFile(filePath(f.rel), f.folderId);
    return;
  }
  await api.fileOpen(f.rel).catch((e) => toast(`Could not open ${f.name}: ${e}`, { kind: 'error' }));
}

export async function renameFile(rel: string, name: string) {
  try {
    await api.fileRename(rel, name);
    await refreshFromDisk();
  } catch (e) {
    toast(String(e), { kind: 'error' });
  }
}

export async function pickAndImport() {
  const files = await api.openDialog({
    title: 'Import',
    filters: [
      { name: 'Supported files', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'gink'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      { name: 'goodink backup', extensions: ['gink'] },
    ],
    multi: true,
  });
  if (files.length) await openFiles(files);
}

const PDF_FILTER = [{ name: 'PDF documents', extensions: ['pdf'] }];

/** Library button: pick one or more PDFs; each becomes its own notebook. */
export async function pickPdfs() {
  const files = await api.openDialog({ title: 'Import PDF', filters: PDF_FILTER, multi: true });
  for (const f of files) await importPdfFile(f, get().folderId, files.length === 1);
  if (files.length > 1) toast(`Imported ${files.length} PDFs`, { kind: 'success' });
}

/** Editor button: insert the pages of a PDF into an open notebook after page `after`. */
export type PlacePdf = (assetId: string, sizes: { w: number; h: number }[]) => PdfObject[] | null;

/**
 * Insert a PDF into an open notebook. `place` (from the editor) may put the PDF's pages straight onto
 * the current page as objects and return them; otherwise the PDF's pages are added as new pages.
 */
export async function insertPdfIntoNotebook(nbId: string, after: number, path?: string, place?: PlacePdf): Promise<number | null> {
  const { openPdf, pageWords, pdfOutline, pdfPageSizes, isPasswordError } = await pdfEngine();
  if (!path) {
    const files = await api.openDialog({ title: 'Insert PDF pages', filters: PDF_FILTER });
    if (!files.length) return null;
    path = files[0];
  }
  const s = await getSession(nbId);
  const tid = toast(`Adding ${baseName(path)}…`, { progress: 0 });
  try {
    const bytes = await api.readFile(path);
    let pdf;
    try {
      pdf = await openPdf(bytes);
    } catch (e) {
      if (!isPasswordError(e)) throw e;
      const pw = await askPassword(`“${baseName(path)}” is password protected`);
      if (pw == null) {
        dismissToast(tid);
        return null;
      }
      pdf = await openPdf(bytes, pw);
    }
    const sizes = await pdfPageSizes(pdf);
    const assetId = await s.addAsset(bytes, 'pdf', baseName(path));
    const placed = place?.(assetId, sizes);
    if (placed?.length) {
      // text of the placed pages becomes searchable at its position on the page
      const pageId = s.pages[after].id;
      const words: SearchWord[] = [...(s.index.pages[pageId]?.pdf ?? [])];
      for (const o of placed) {
        const k = o.w / o.pw;
        for (const w of await pageWords(pdf, o.page).catch(() => [])) words.push({ t: w.t, b: [o.x + w.b[0] * k, o.y + w.b[1] * k, w.b[2] * k, w.b[3] * k] });
      }
      s.setPdfIndex(pageId, words);
      await pdf.loadingTask.destroy();
      dismissToast(tid);
      toast(`Placed ${placed.length} PDF page${placed.length === 1 ? '' : 's'} on the page. Right-click or long-press to move.`, { kind: 'success', action: { label: 'Undo', run: () => s.undo() } });
      return after;
    }
    const added: PageMeta[] = sizes.map((sz, i) => ({ id: uid(), w: sz.w, h: sz.h, template: { kind: 'blank', paper: 'white' }, rotation: 0, bg: { type: 'pdf', asset: assetId, page: i } }));
    const pages = [...s.pages];
    pages.splice(after + 1, 0, ...added);
    s.setPages(pages, { focus: added[0].id });
    // carry over the PDF's own table of contents, and make its text searchable
    const outline = (await pdfOutline(pdf)).filter((o) => added[o.pageIndex]).map((o) => ({ id: uid(), title: o.title, pageId: added[o.pageIndex].id }));
    if (outline.length) s.patchDoc({ outline: [...s.doc.outline, ...outline] });
    for (let i = 0; i < added.length; i++) {
      s.setPdfIndex(added[i].id, await pageWords(pdf, i).catch(() => []));
      if (i % 8 === 0) updateToast(tid, { progress: (i + 1) / added.length });
    }
    await pdf.loadingTask.destroy();
    dismissToast(tid);
    toast(`Added ${added.length} page${added.length === 1 ? '' : 's'} from ${baseName(path)}`, { kind: 'success', action: { label: 'Undo', run: () => s.undo() } });
    return after + 1;
  } catch (e) {
    dismissToast(tid);
    toast(`Could not add ${baseName(path)}: ${(e as Error).message}`, { kind: 'error', ms: 7000 });
    return null;
  }
}

// ---- folders & organising -----------------------------------------------------------------------

export const FOLDER_COLORS = ['#6c8eb5', '#7fa38a', '#d2a24c', '#c98a62', '#a68dbf', '#6fa9b5', '#9aa1ad'];

export function createFolder(title: string, parentId: string | null = get().folderId) {
  const now = Date.now();
  const f: Folder = { id: uid(), title: title.trim() || 'New folder', parentId, color: FOLDER_COLORS[get().library.folders.length % FOLDER_COLORS.length], createdAt: now, updatedAt: now, deletedAt: null };
  setLibrary((l) => ({ ...l, folders: [...l.folders, f] }));
  return f.id;
}

/** Other files are picked, moved and deleted like notebooks; their ids are "file:<path>". */
export const FILE_ID = 'file:';
const fileRels = (ids: string[]) => ids.filter((id) => id.startsWith(FILE_ID)).map((id) => id.slice(FILE_ID.length));

export function moveItems(ids: string[], folderId: string | null) {
  const files = fileRels(ids);
  if (files.length) {
    void Promise.all(files.map((rel) => api.fileMove(rel, folderId).catch((e) => toast(`Could not move ${baseName(rel)}: ${e}`, { kind: 'error' })))).then(() => refreshFromDisk());
    ids = ids.filter((id) => !id.startsWith(FILE_ID));
  }
  const lib = get().library;
  // never move a folder into itself or its descendants
  const descendants = (id: string): string[] => [id, ...lib.folders.filter((f) => f.parentId === id).flatMap((f) => descendants(f.id))];
  setLibrary((l) => ({
    ...l,
    notebooks: l.notebooks.map((n) => (ids.includes(n.id) ? { ...n, folderId } : n)),
    links: (l.links ?? []).map((x) => (ids.includes(x.id) ? { ...x, folderId } : x)),
    folders: l.folders.map((f) => (ids.includes(f.id) && !(folderId && descendants(f.id).includes(folderId)) ? { ...f, parentId: folderId } : f)),
  }));
}

export function toggleFavorite(id: string) {
  const n = get().library.notebooks.find((x) => x.id === id);
  if (n) patchNotebook(id, { favorite: !n.favorite });
  const k = findLink(id);
  if (k) patchLink(id, { favorite: !k.favorite });
}

function folderTree(id: string): string[] {
  const lib = get().library;
  return [id, ...lib.folders.filter((f) => f.parentId === id).flatMap((f) => folderTree(f.id))];
}

export function trashItems(ids: string[]) {
  const files = fileRels(ids);
  if (files.length) {
    // files goodink did not make go to the Windows Recycle Bin, where Explorer can restore them
    void Promise.all(files.map((rel) => api.fileTrash(rel).then(() => 1, (e) => (toast(String(e), { kind: 'error' }), 0)))).then(async (r) => {
      await refreshFromDisk();
      const n = r.reduce<number>((a, b) => a + b, 0);
      if (n) toast(`Moved ${n} file${n === 1 ? '' : 's'} to the Recycle Bin`);
    });
    ids = ids.filter((id) => !id.startsWith(FILE_ID));
    set({ picked: [] });
    if (!ids.length) return;
  }
  const now = Date.now();
  const folderIds = new Set(ids.filter((id) => get().library.folders.some((f) => f.id === id)).flatMap(folderTree));
  const nbIds = new Set(ids.filter((id) => get().library.notebooks.some((n) => n.id === id)));
  for (const n of get().library.notebooks) if (n.folderId && folderIds.has(n.folderId)) nbIds.add(n.id);
  // links go with their folder, like notebooks
  for (const x of get().library.links ?? []) if (ids.includes(x.id) || (x.folderId && folderIds.has(x.folderId))) nbIds.add(x.id);
  for (const id of nbIds) if (get().tabs.includes(id)) void closeTab(id);
  setLibrary((l) => ({
    ...l,
    notebooks: l.notebooks.map((n) => (nbIds.has(n.id) ? { ...n, deletedAt: now } : n)),
    links: (l.links ?? []).map((x) => (nbIds.has(x.id) ? { ...x, deletedAt: now } : x)),
    folders: l.folders.map((f) => (folderIds.has(f.id) ? { ...f, deletedAt: now } : f)),
  }));
  set({ picked: [] });
  const count = nbIds.size;
  toast(`Moved ${count || ids.length} item${(count || ids.length) === 1 ? '' : 's'} to Trash`, { action: { label: 'Undo', run: () => restoreItems([...nbIds, ...folderIds]) } });
}

export function restoreItems(ids: string[]) {
  const lib = get().library;
  setLibrary((l) => ({
    ...l,
    notebooks: l.notebooks.map((n) => {
      if (!ids.includes(n.id)) return n;
      const parentGone = n.folderId && lib.folders.find((f) => f.id === n.folderId)?.deletedAt && !ids.includes(n.folderId);
      return { ...n, deletedAt: null, folderId: parentGone ? null : n.folderId };
    }),
    links: (l.links ?? []).map((x) => {
      if (!ids.includes(x.id)) return x;
      const parentGone = x.folderId && lib.folders.find((f) => f.id === x.folderId)?.deletedAt && !ids.includes(x.folderId);
      return { ...x, deletedAt: null, folderId: parentGone ? null : x.folderId };
    }),
    folders: l.folders.map((f) => (ids.includes(f.id) ? { ...f, deletedAt: null } : f)),
  }));
}

export async function deleteForever(ids: string[], silent = false) {
  const lib = get().library;
  const nbs = lib.notebooks.filter((n) => ids.includes(n.id));
  for (const n of nbs) {
    if (get().tabs.includes(n.id)) await closeTab(n.id);
    await api.deleteNotebook(n.id);
  }
  for (const id of ids) if (findLink(id) && get().tabs.includes(id)) await closeTab(id);
  setLibrary((l) => ({ ...l, notebooks: l.notebooks.filter((n) => !ids.includes(n.id)), links: (l.links ?? []).filter((x) => !ids.includes(x.id)), folders: l.folders.filter((f) => !ids.includes(f.id)) }));
  saveLibraryNow();
  if (!silent) toast(`Deleted ${ids.length} item${ids.length === 1 ? '' : 's'} permanently`);
}

export function emptyTrash() {
  const lib = get().library;
  const ids = [...lib.notebooks.filter((n) => n.deletedAt).map((n) => n.id), ...(lib.links ?? []).filter((x) => x.deletedAt).map((x) => x.id), ...lib.folders.filter((f) => f.deletedAt).map((f) => f.id)];
  if (!ids.length) return;
  const withFiles = lib.folders.some((f) => f.deletedAt);
  confirmDialog('Empty Trash?', `${ids.length} item${ids.length === 1 ? '' : 's'} will be deleted from this PC${withFiles ? ', with any other files that were in the deleted folders' : ''}. This cannot be undone.`, 'Delete forever', () => void deleteForever(ids));
}

export async function duplicateNotebook(id: string) {
  const n = get().library.notebooks.find((x) => x.id === id);
  if (!n) return;
  await sessions.get(id)?.flush();
  const nid = uid();
  await api.duplicateNotebook(id, nid);
  const now = Date.now();
  setLibrary((l) => ({ ...l, notebooks: [...l.notebooks, { ...n, id: nid, title: `${n.title} copy`, favorite: false, createdAt: now, updatedAt: now, openedAt: now }] }));
  saveLibraryNow();
  toast(`Duplicated “${n.title}”`);
}

export async function exportBackup(id: string) {
  const n = get().library.notebooks.find((x) => x.id === id);
  if (!n) return;
  await sessions.get(id)?.flush();
  const target = await api.saveDialog({ title: 'Back up notebook', defaultPath: `${n.title.replace(/[\\/:*?"<>|]/g, '_')}.gink`, filters: [{ name: 'goodink backup', extensions: ['gink'] }] });
  if (!target) return;
  await api.backupExport(id, n, target);
  toast('Backup saved', { kind: 'success', action: { label: 'Show', run: () => void api.revealFile(target) } });
}

// ---- elements -----------------------------------------------------------------------------------

export function saveElements(els: SavedElement[]) {
  set({ elements: els });
  void api.saveElements(els);
}

// ---- notebook lock ------------------------------------------------------------------------------

async function hashPw(salt: string, pw: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 210000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function checkPassword(lock: { salt: string; hash: string }, pw: string) {
  return (await hashPw(lock.salt, pw)) === lock.hash;
}

export async function removeLock(id: string, pw: string): Promise<boolean> {
  const meta = get().library.notebooks.find((n) => n.id === id);
  if (!meta?.lock || !(await checkPassword(meta.lock, pw))) return false;
  patchNotebook(id, { lock: null });
  return true;
}

export async function setLock(id: string, pw: string | null) {
  if (!pw) return patchNotebook(id, { lock: null });
  const salt = uid();
  patchNotebook(id, { lock: { salt, hash: await hashPw(salt, pw) } });
}

// ---- selectors ----------------------------------------------------------------------------------

export function sortNotebooks(list: NotebookMeta[], sort: Settings['sort']) {
  const by = {
    modified: (a: NotebookMeta, b: NotebookMeta) => b.updatedAt - a.updatedAt,
    created: (a: NotebookMeta, b: NotebookMeta) => b.createdAt - a.createdAt,
    opened: (a: NotebookMeta, b: NotebookMeta) => b.openedAt - a.openedAt,
    title: (a: NotebookMeta, b: NotebookMeta) => a.title.localeCompare(b.title, undefined, { numeric: true }),
  }[sort];
  return [...list].sort(by);
}
