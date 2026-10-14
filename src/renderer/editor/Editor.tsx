import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PenTool, Pen, Brush, Highlighter, Eraser, Lasso, Shapes, Sticker, ImagePlus, Type, Bandage, Pointer, Mic, Undo2, Redo2, PanelRight, Search, Bookmark,
  FilePlus2, MoreHorizontal, Scissors, Copy, Trash2, CopyPlus, Palette, Camera, ScanText, Save, ArrowUpToLine, ArrowDownToLine,
  Presentation, FileDown, Printer, LayoutTemplate, Maximize, ZoomIn, ZoomOut, Eye, EyeOff, BookOpenCheck, Home, Sparkles, ScrollText,
  ChevronLeft, ChevronRight, Keyboard, Square, Scaling, FileInput, X,
} from 'lucide-react';
import type { PenKind, TextObject } from '../../shared/types';
import { Viewport, hasClipboard, type Tool, type Selection } from '../engine/viewport';
import type { NotebookSession } from '../engine/session';
import { findSourcesFor, makeCardsFrom, useApp, getSession, setTools, updateSettings, openDialog, toast, activateTab, saveElements, insertPdfIntoNotebook, notePenUsed, penKnown } from '../lib/store';
import { api } from '../lib/api';
import { extOf, modKey, uid } from '../lib/util';
import { IconButton, Menu, Popover, Segmented, Swatch, Spinner, Button, type MenuItem } from '../ui/primitives';
import { Navigator } from './Navigator';
import { SearchPanel, ElementsPanel, AudioPanel } from './Panels';
import { addPage, toggleBookmark } from './pageOps';
import { printNotebook } from './EditorDialogs';
import { pageDataUrl } from '../engine/export';
import { TextFormat } from './TextFormat';
import { strokeToJSON, objectBBox } from '../engine/model';
import { bboxUnion, type BBox } from '../engine/geometry';
import type { LiveBridge } from '../live/ui/LiveLayer';

// the chat panel pulls in the AI provider SDKs, so it loads on first use
const AskPanel = lazy(() => import('./AiDialogs').then((m) => ({ default: m.AskPanel })));
// live checking, the insight card and the AI selector load after the page is on screen
const LiveLayer = lazy(() => import('../live/ui/LiveLayer'));

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: 'pen', label: 'Pen', key: 'P', icon: <PenTool size={19} /> },
  { id: 'highlighter', label: 'Highlighter', key: 'H', icon: <Highlighter size={19} /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <Eraser size={19} /> },
  { id: 'lasso', label: 'Lasso', key: 'L', icon: <Lasso size={19} /> },
  { id: 'shape', label: 'Shapes', key: 'S', icon: <Shapes size={19} /> },
  { id: 'text', label: 'Text', key: 'T', icon: <Type size={19} /> },
  { id: 'image', label: 'Image', key: 'I', icon: <ImagePlus size={19} /> },
  { id: 'tape', label: 'Tape', key: 'U', icon: <Bandage size={19} /> },
  { id: 'laser', label: 'Laser pointer', key: 'K', icon: <Pointer size={19} /> },
  { id: 'ai', label: 'AI selector', key: 'A', icon: <Sparkles size={19} /> },
];

const TAPE_COLORS = ['#7d9cff', '#5ad08f', '#ffb44a', '#ff8fb1', '#a0a0ab'];
const LASER_COLORS = ['#ff3b30', '#34c759', '#0a84ff'];
const ERASER_SIZES = [6, 14, 30];
const TAPE_SIZES = [12, 20, 32];

export function Editor({ nbId, active }: { nbId: string; active: boolean }) {
  const [s, setS] = useState<NotebookSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getSession(nbId)
      .then((x) => live && setS(x))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [nbId]);
  if (error)
    return (
      <div className="editor-msg">
        <p>{error}</p>
        <Button onClick={() => activateTab(null)}>Back to library</Button>
      </div>
    );
  if (!s)
    return (
      <div className="editor-msg">
        <Spinner size={22} />
      </div>
    );
  return <EditorInner s={s} active={active} />;
}

function EditorInner({ s, active }: { s: NotebookSession; active: boolean }) {
  const tools = useApp((st) => st.tools);
  const tempTool = useApp((st) => st.tempTool);
  const settings = useApp((st) => st.settings);
  const host = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [navOpen, setNavOpen] = useState(() => window.innerWidth > 1100);
  const [panel, setPanel] = useState<null | 'search' | 'elements' | 'audio' | 'ask'>(null);
  const [searchInit, setSearchInit] = useState<string | undefined>();
  const [sel, setSel] = useState<{ sel: Selection; anchor: DOMRect } | null>(null);
  const [textObj, setTextObj] = useState<TextObject | null>(null);
  const [hist, setHist] = useState({ undo: false, redo: false });
  const [, setPagesVer] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [pop, setPop] = useState<{ kind: string; anchor: DOMRect; index?: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const prevTool = useRef<Tool>('pen');
  const vpRef = useRef<Viewport | null>(null);
  const liveBridge = useRef<LiveBridge>({});
  const [liveSlot, setLiveSlot] = useState<HTMLSpanElement | null>(null);
  const presentingRef = useRef(false);
  presentingRef.current = presenting;

  // ---- viewport lifecycle ----
  useEffect(() => {
    const v = new Viewport(host.current!, s, { ...useApp.getState().tools }, {
      onPageChange: (i) => {
        setPage(i);
        useApp.setState({ pageOf: { ...useApp.getState().pageOf, [s.id]: i } });
      },
      onZoom: (z) => setZoom(z),
      onSelection: (sl, anchor) => setSel(sl && anchor ? { sel: sl, anchor } : null),
      onTextEdit: (o) => setTextObj(o),
      onRequestImage: (pageId, x, y) => void pickImage(v, pageId, [x, y]),
      onTempTool: (t) => useApp.setState({ tempTool: t }),
      onEraseEnd: () => setTools({ tool: prevTool.current === 'eraser' ? 'pen' : prevTool.current }),
      onLaser: (_i, pts) => presentingRef.current && api.presentLaser(pts),
      onToast: (m) => toast(m),
      onPenSeen: () => notePenUsed(),
      onInkContext: (pageId, x, y, cx, cy) => liveBridge.current.onInkContext?.(pageId, x, y, cx, cy),
      onAiRegion: (r) => liveBridge.current.onAiRegion?.(r),
      onPenActivity: (pageId, x, y, down) => liveBridge.current.onPenActivity?.(pageId, x, y, down),
    });
    v.penSeen = penKnown;
    v.scrollDir = useApp.getState().settings.scrollDir;
    vpRef.current = v;
    setVp(v);
    const off = s.on((e) => {
      if (e.type === 'history' || e.type === 'page' || e.type === 'pages') setHist({ undo: s.canUndo, redo: s.canRedo });
      if (e.type === 'pages') setPagesVer((n) => n + 1);
    });
    return () => {
      off();
      v.destroy();
      vpRef.current = null;
    };
  }, [s]);

  useEffect(() => {
    if (!vp) return;
    vp.tools = { ...tools, tool: tools.tool };
    if (tools.tool !== 'lasso' && tools.tool !== 'image' && tools.tool !== 'text') vp.clearSelection();
    if (tools.tool !== 'text' && vp.isEditingText) vp.commitTextEdit();
  }, [vp, tools]);

  useEffect(() => {
    if (tools.tool !== 'eraser') prevTool.current = tools.tool;
  }, [tools.tool]);

  useEffect(() => vp?.setScrollDir(settings.scrollDir), [vp, settings.scrollDir]);

  // jump requests from library search
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent).detail as { nbId: string; pageId: string; query: string };
      if (d.nbId !== s.id) return;
      const go = () => {
        const v = vpRef.current;
        if (!v) return setTimeout(go, 50);
        const i = s.pageIndex(d.pageId);
        if (i >= 0) v.scrollToPage(i, false);
        setSearchInit(d.query);
        setPanel('search');
      };
      setTimeout(go, 60);
    };
    window.addEventListener('goodink:goto', onGoto);
    return () => window.removeEventListener('goodink:goto', onGoto);
  }, [s]);

  // ---- presentation ----
  const sendFrame = useCallback(async () => {
    const v = vpRef.current;
    if (!v) return;
    const i = v.pageIndexNow;
    const p = s.pages[i];
    const src = await pageDataUrl(s, i, 1800);
    api.presentFrame({ src, w: p.w, h: p.h });
  }, [s]);
  useEffect(() => {
    if (!presenting) return;
    void sendFrame();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = s.on(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void sendFrame(), 250);
    });
    const offClosed = api.on('present:closed', () => setPresenting(false));
    return () => {
      off();
      offClosed();
      if (t) clearTimeout(t);
    };
  }, [presenting, page, s, sendFrame]);

  const togglePresent = async () => {
    if (presenting) {
      await api.presentClose();
      setPresenting(false);
    } else {
      await api.presentOpen();
      setPresenting(true);
      setTimeout(() => void sendFrame(), 700);
      if (tools.tool !== 'laser') setTools({ tool: 'laser' });
      toast('Presenting. Only the page shows on the other screen — use the laser pointer to point.');
    }
  };

  // ---- actions ----
  const go = (i: number) => vp?.scrollToPage(i);
  const newPage = () => {
    const i = addPage(s, vp?.pageIndexNow ?? page, 'after');
    setTimeout(() => vp?.scrollToPage(i), 30);
  };
  const undo = () => {
    vp?.commitTextEdit();
    const pid = s.undo();
    if (pid && vp) {
      const i = s.pageIndex(pid);
      if (i >= 0 && Math.abs(i - vp.pageIndexNow) > 0) vp.scrollToPage(i);
    }
  };
  const redo = () => {
    const pid = s.redo();
    if (pid && vp) {
      const i = s.pageIndex(pid);
      if (i >= 0 && Math.abs(i - vp.pageIndexNow) > 0) vp.scrollToPage(i);
    }
  };

  const pickTool = (t: Tool, e?: React.MouseEvent) => {
    if (t === tools.tool && e && ['pen', 'highlighter', 'eraser', 'shape', 'text', 'tape', 'laser'].includes(t)) {
      setPop({ kind: `tool-${t}`, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() });
      return;
    }
    if (t === 'image') {
      setTools({ tool: 'image' });
      if (vp) void pickImage(vp, s.pages[vp.pageIndexNow].id);
      return;
    }
    setTools({ tool: t });
  };

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 240,
      y: r.bottom + 6,
      items: [
        { label: 'Make flashcards in Study…', icon: <BookOpenCheck size={15} />, run: () => makeCardsFrom(s.id) },
        { label: 'Find sources for this notebook…', icon: <Search size={15} />, run: () => findSourcesFor(s.id) },
        { label: 'Summarize with AI…', icon: <ScrollText size={15} />, run: () => openDialog({ type: 'ai', nbId: s.id, pageIndex: page }) },
        { separator: true, label: '' },
        { label: 'Insert PDF pages…', icon: <FileInput size={15} />, shortcut: 'Ctrl+Shift+O', run: () => void insertPdf() },
        { label: 'Page layout & template…', icon: <LayoutTemplate size={15} />, run: () => openDialog({ type: 'template', nbId: s.id, scope: 'page' }) },
        { label: 'Export…', icon: <FileDown size={15} />, shortcut: 'Ctrl+E', run: () => openDialog({ type: 'export', nbId: s.id, pageIndex: page }) },
        { label: 'Print…', icon: <Printer size={15} />, shortcut: 'Ctrl+P', run: () => void printNotebook(s) },
        { label: presenting ? 'Stop presenting' : 'Present on another screen', icon: <Presentation size={15} />, shortcut: 'F5', run: () => void togglePresent() },
        { separator: true, label: '' },
        { label: 'Scroll vertically', checked: settings.scrollDir === 'vertical', run: () => updateSettings({ scrollDir: 'vertical' }) },
        { label: 'Scroll horizontally', checked: settings.scrollDir === 'horizontal', run: () => updateSettings({ scrollDir: 'horizontal' }) },
        { label: 'Full screen', icon: <Maximize size={15} />, shortcut: 'F11', run: () => void api.toggleFullscreen() },
        { separator: true, label: '' },
        { label: 'Keyboard shortcuts', icon: <Keyboard size={15} />, shortcut: 'Ctrl+/', run: () => openDialog({ type: 'shortcuts' }) },
      ],
    });
  };

  // ---- keyboard ----
  useEffect(() => {
    if (!active || !vp) return;
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().dialog) return;
      const tgt = e.target as HTMLElement;
      if (tgt?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      const mod = modKey(e);
      const k = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (mod) {
        if (k === 'z' && !e.shiftKey) return handled(), undo();
        if ((k === 'z' && e.shiftKey) || k === 'y') return handled(), redo();
        if (k === 'c') return vp.sel && (handled(), vp.copySelection());
        if (k === 'x') return vp.sel && (handled(), vp.cutSelection());
        if (k === 'v') return handled(), void vp.paste().then((ok) => ok && setTools({ tool: 'lasso' }));
        if (k === 'd') return vp.sel && (handled(), vp.duplicateSelection());
        if (k === 'a') return handled(), setTools({ tool: 'lasso' }), setTimeout(() => vp.selectAll());
        if (k === '=' || k === '+') return handled(), vp.zoomBy(1.2);
        if (k === '-') return handled(), vp.zoomBy(1 / 1.2);
        if (k === '0') return handled(), vp.setZoom(1);
        if (k === '1') return handled(), vp.fitWidth();
        if (k === '2') return handled(), vp.fitPage();
        if (k === 'enter') return handled(), newPage();
        if (k === 'b') return handled(), toggleBookmark(s, vp.pageIndexNow);
        if (k === 'f') return handled(), setPanel('search');
        if (k === 'j') return handled(), setPanel((p) => (p === 'ask' ? null : 'ask'));
        if (k === '\\') return handled(), setNavOpen((o) => !o);
        if (k === 'e') return handled(), openDialog({ type: 'export', nbId: s.id, pageIndex: vp.pageIndexNow });
        if (k === 'p') return handled(), void printNotebook(s);
        if (k === 'o' && e.shiftKey) return handled(), void insertPdf();
        return;
      }
      if (e.altKey) return;
      if (k === 'f5') return handled(), void togglePresent();
      if (k === 'escape') {
        if (vp.sel) return handled(), vp.clearSelection();
        if (panel) return handled(), setPanel(null);
        return;
      }
      if ((k === 'delete' || k === 'backspace') && vp.sel) return handled(), vp.deleteSelection();
      if (k === 'pagedown' || (k === 'arrowright' && settings.scrollDir === 'horizontal')) return handled(), vp.scrollToPage(vp.pageIndexNow + 1);
      if (k === 'pageup' || (k === 'arrowleft' && settings.scrollDir === 'horizontal')) return handled(), vp.scrollToPage(vp.pageIndexNow - 1);
      if (k === 'home') return handled(), vp.scrollToPage(0);
      if (k === 'end') return handled(), vp.scrollToPage(s.pages.length - 1);
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t) return handled(), pickTool(t.id);
      if (['1', '2', '3'].includes(k)) {
        const idx = +k - 1;
        handled();
        const st = useApp.getState();
        if (tools.tool === 'highlighter') setTools({ hlWidth: st.settings.hlSizes[idx] });
        else if (tools.tool === 'eraser') setTools({ eraserWidth: ERASER_SIZES[idx] });
        else if (tools.tool === 'tape') setTools({ tapeWidth: TAPE_SIZES[idx] });
        else setTools({ penWidth: st.settings.penSizes[idx] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!active || !vp) return;
    const onPhoto = (e: Event) => void vp.insertImageBytes(s.pages[vp.pageIndexNow].id, (e as CustomEvent<Uint8Array>).detail, 'jpg').then(() => setTools({ tool: 'lasso' }));
    window.addEventListener('goodink:photo', onPhoto);
    return () => window.removeEventListener('goodink:photo', onPhoto);
  }, [active, vp, s]);

  // automated tests drive the real insert path through this handle (only with ?test=1)
  useEffect(() => {
    if (active && new URLSearchParams(location.search).get('test') === '1') (window as unknown as { __editor: unknown }).__editor = { insertPdf: (p: string) => insertPdf(p), vp };
  });

  // paste images dropped onto the page
  const insertPdf = async (path?: string) => {
    const idx = vp?.pageIndexNow ?? page;
    const cur = s.pages[idx];
    // On an infinite canvas every PDF page is placed onto the canvas; on a fixed page a one-page
    // PDF is placed onto the page, longer PDFs come in as new pages after this one.
    const place = (assetId: string, sizes: { w: number; h: number }[]) => {
      const v = vpRef.current;
      if (!v || (!cur.infinite && sizes.length !== 1) || cur.bg) return null;
      return v.placePdfPages(cur.id, assetId, sizes, undefined, !cur.infinite);
    };
    const at = await insertPdfIntoNotebook(s.id, idx, path, place);
    if (at != null && at !== idx) setTimeout(() => vpRef.current?.scrollToPage(at), 60);
  };

  const onDrop = async (e: React.DragEvent) => {
    const pdfs = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name));
    if (pdfs.length) {
      e.preventDefault();
      e.stopPropagation();
      for (const f of pdfs) await insertPdf(await api.pathForFile(f));
      return;
    }
    const files = [...e.dataTransfer.files].filter((f) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name));
    if (!files.length || !vp) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of files) {
      const ext = extOf(f.name) === 'jpeg' ? 'jpg' : extOf(f.name);
      await vp.insertImageBytes(s.pages[vp.pageIndexNow].id, new Uint8Array(await f.arrayBuffer()), ext);
    }
  };

  const effTool = tempTool ?? tools.tool;
  const curPage = s.pages[Math.min(page, s.pages.length - 1)];

  return (
    <div className="editor" onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()} onDrop={(e) => void onDrop(e)}>
      <div className="toolbar" role="toolbar" aria-label="Notebook tools">
        <div className="tb-group">
          <IconButton label="Library" onClick={() => activateTab(null)}>
            <Home size={18} />
          </IconButton>
          <IconButton label="Page thumbnails" shortcut="Ctrl+\" active={navOpen} onClick={() => setNavOpen(!navOpen)}>
            <PanelRight size={18} />
          </IconButton>
          <span className="tb-sep" />
          <IconButton label="Undo" shortcut="Ctrl+Z" disabled={!hist.undo} onClick={undo}>
            <Undo2 size={18} />
          </IconButton>
          <IconButton label="Redo" shortcut="Ctrl+Y" disabled={!hist.redo} onClick={redo}>
            <Redo2 size={18} />
          </IconButton>
        </div>
        <div className="tb-tools" role="radiogroup" aria-label="Tool">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={effTool === t.id}
              aria-label={t.label}
              title={`${t.label} (${t.key})${effTool === t.id ? ' — click again for options' : ''}`}
              className={`tool-btn ${effTool === t.id ? 'is-active' : ''} ${t.id === 'pen' || t.id === 'highlighter' ? 'has-color' : ''}`}
              onClick={(e) => pickTool(t.id, e)}
              style={t.id === 'pen' ? { ['--tc' as string]: tools.penColor } : t.id === 'highlighter' ? { ['--tc' as string]: tools.hlColor } : undefined}
            >
              {t.icon}
            </button>
          ))}
          <span className="tb-sep" />
          <IconButton label="Elements and stickers" active={panel === 'elements'} onClick={() => setPanel(panel === 'elements' ? null : 'elements')}>
            <Sticker size={19} />
          </IconButton>
          <IconButton label="Record audio" active={panel === 'audio'} onClick={() => setPanel(panel === 'audio' ? null : 'audio')}>
            <Mic size={19} />
          </IconButton>
        </div>
        <div className="tb-group tb-right">
          {presenting && (
            <button className="present-pill" onClick={() => void togglePresent()}>
              <span className="rec-dot" /> Presenting · Stop
            </button>
          )}
          <span className="live-slot" ref={setLiveSlot} />
          <button type="button" className={`tb-ask ${panel === 'ask' ? 'is-active' : ''}`} title="Ask AI about this notebook (Ctrl+J)" aria-pressed={panel === 'ask'} onClick={() => setPanel(panel === 'ask' ? null : 'ask')}>
            <Sparkles size={16} /> Ask AI
          </button>
          <IconButton label="Find in notebook" shortcut="Ctrl+F" active={panel === 'search'} onClick={() => setPanel(panel === 'search' ? null : 'search')}>
            <Search size={18} />
          </IconButton>
          <IconButton label={curPage?.bookmarked ? 'Remove bookmark' : 'Bookmark page'} shortcut="Ctrl+B" active={!!curPage?.bookmarked} onClick={() => toggleBookmark(s, page)}>
            <Bookmark size={18} fill={curPage?.bookmarked ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton label="Insert PDF pages after this page" shortcut="Ctrl+Shift+O" onClick={() => void insertPdf()}>
            <FileInput size={18} />
          </IconButton>
          <IconButton label="Add page" shortcut="Ctrl+Enter" onClick={newPage}>
            <FilePlus2 size={18} />
          </IconButton>
          <IconButton label="More" onClick={moreMenu}>
            <MoreHorizontal size={18} />
          </IconButton>
        </div>
      </div>

      <SubBar vp={vp} tool={effTool} textObj={textObj} onPop={(kind, anchor, index) => setPop({ kind, anchor, index })} />

      <div className="ed-body">
        <div className="ed-canvas" ref={host} data-tool={effTool}>
          <div className="page-indicator" aria-live="polite">
            <IconButton label="Previous page" onClick={() => vp?.scrollToPage(page - 1)} disabled={page === 0}>
              <ChevronLeft size={15} />
            </IconButton>
            <span>
              {page + 1} / {s.pages.length}
            </span>
            <IconButton label="Next page" onClick={() => vp?.scrollToPage(page + 1)} disabled={page >= s.pages.length - 1}>
              <ChevronRight size={15} />
            </IconButton>
            <span className="tb-sep" />
            <IconButton label="Zoom out" shortcut="Ctrl+−" onClick={() => vp?.zoomBy(1 / 1.2)}>
              <ZoomOut size={15} />
            </IconButton>
            <button className="zoom-val" title="Fit width (Ctrl+1)" onClick={() => vp?.fitWidth()}>
              {Math.round(zoom * 100)}%
            </button>
            <IconButton label="Zoom in" shortcut="Ctrl+=" onClick={() => vp?.zoomBy(1.2)}>
              <ZoomIn size={15} />
            </IconButton>
          </div>
        </div>
        {panel === 'search' && <SearchPanel s={s} vp={vp} initial={searchInit} onClose={() => { setPanel(null); setSearchInit(undefined); }} />}
        {panel === 'elements' && <ElementsPanel vp={vp} onClose={() => setPanel(null)} />}
        {panel === 'audio' && <AudioPanel s={s} currentPageId={curPage.id} onClose={() => setPanel(null)} />}
        {panel === 'ask' && (
          <Suspense fallback={null}>
            <AskPanel s={s} current={page} onGo={go} onClose={() => setPanel(null)} />
          </Suspense>
        )}
        {navOpen && <Navigator s={s} current={page} onGo={go} />}
      </div>

      {sel && vp && active && <SelectionMenu vp={vp} sel={sel.sel} anchor={sel.anchor} />}
      {vp && active && (
        <Suspense fallback={null}>
          <LiveLayer vp={vp} s={s} slot={liveSlot} bridge={liveBridge} pageId={curPage.id} />
        </Suspense>
      )}
      {pop && <ToolPopover pop={pop} onClose={() => setPop(null)} />}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

async function pickImage(vp: Viewport, pageId: string, at?: [number, number]) {
  const files = await api.openDialog({ title: 'Insert image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }], multi: true });
  for (const f of files) {
    const ext = extOf(f) === 'jpeg' ? 'jpg' : extOf(f);
    await vp.insertImageBytes(pageId, await api.readFile(f), ext, at);
  }
}

// ---- sub toolbar ------------------------------------------------------------------------------

function SizeDots({ sizes, value, onPick, onEdit, scale = 1, max = 8 }: { sizes: number[]; value: number; onPick: (v: number) => void; onEdit?: (i: number, a: DOMRect) => void; scale?: number; max?: number }) {
  return (
    <div className="sizes" role="radiogroup" aria-label="Thickness">
      {sizes.map((w, i) => (
        <button
          key={i}
          role="radio"
          aria-checked={Math.abs(value - w) < 0.01}
          aria-label={`Thickness ${i + 1}`}
          title={`Thickness ${i + 1} (${i + 1})${onEdit ? ' — click again to adjust' : ''}`}
          className={`size-dot ${Math.abs(value - w) < 0.01 ? 'is-on' : ''}`}
          onClick={(e) => (Math.abs(value - w) < 0.01 && onEdit ? onEdit(i, (e.currentTarget as HTMLElement).getBoundingClientRect()) : onPick(w))}
        >
          <span style={{ width: Math.min(max * 2.6, Math.max(3, w * scale)), height: Math.min(max * 2.6, Math.max(3, w * scale)) }} />
        </button>
      ))}
    </div>
  );
}

function Colors({ colors, value, onPick, onEdit }: { colors: string[]; value: string; onPick: (c: string) => void; onEdit?: (i: number, a: DOMRect) => void }) {
  return (
    <div className="colors" role="radiogroup" aria-label="Colour">
      {colors.map((c, i) => (
        <Swatch
          key={i}
          color={c}
          selected={c.toLowerCase() === value.toLowerCase()}
          onClick={() => {
            if (c.toLowerCase() === value.toLowerCase() && onEdit) {
              const el = document.activeElement as HTMLElement;
              onEdit(i, el.getBoundingClientRect());
            } else onPick(c);
          }}
        />
      ))}
    </div>
  );
}

function SubBar({ vp, tool, textObj, onPop }: { vp: Viewport | null; tool: Tool; textObj: TextObject | null; onPop: (kind: string, anchor: DOMRect, index?: number) => void }) {
  const t = useApp((st) => st.tools);
  const settings = useApp((st) => st.settings);
  let body: ReactNode = null;
  if (textObj && vp) {
    const upd = (p: Partial<TextObject>) => {
      vp.updateEditingText(p);
      // the next text box looks like this one
      setTools({ text: { ...t.text, ...p } });
    };
    body = <TextFormat value={textObj} onChange={upd} />;
  } else if (tool === 'pen' || tool === 'shape') {
    body = (
      <>
        {tool === 'pen' && (
          <Segmented<PenKind>
            label="Pen type"
            value={t.penKind}
            onChange={(penKind) => setTools({ penKind })}
            options={[
              { value: 'fountain', label: <PenTool size={15} />, title: 'Fountain pen' },
              { value: 'ball', label: <Pen size={15} />, title: 'Ballpoint pen' },
              { value: 'brush', label: <Brush size={15} />, title: 'Brush pen' },
            ]}
          />
        )}
        {tool === 'shape' && <span className="sub-hint">Draw a rough line, circle, rectangle or triangle — it snaps clean.</span>}
        <span className="tb-sep" />
        <Colors colors={settings.penColors} value={t.penColor} onPick={(penColor) => setTools({ penColor })} onEdit={(i, a) => onPop('pen-color', a, i)} />
        <IconButton label="More colours" onClick={(e) => onPop('pen-color-new', (e.currentTarget as HTMLElement).getBoundingClientRect())}>
          <Palette size={16} />
        </IconButton>
        <span className="tb-sep" />
        <SizeDots sizes={settings.penSizes} value={t.penWidth} scale={2.2} onPick={(penWidth) => setTools({ penWidth })} onEdit={(i, a) => onPop('pen-size', a, i)} />
      </>
    );
  } else if (tool === 'highlighter') {
    body = (
      <>
        <Colors colors={settings.hlColors} value={t.hlColor} onPick={(hlColor) => setTools({ hlColor })} onEdit={(i, a) => onPop('hl-color', a, i)} />
        <span className="tb-sep" />
        <SizeDots sizes={settings.hlSizes} value={t.hlWidth} scale={0.55} onPick={(hlWidth) => setTools({ hlWidth })} onEdit={(i, a) => onPop('hl-size', a, i)} />
        <span className="tb-sep" />
        <label className="sub-check">
          <input type="checkbox" checked={settings.straightHighlighter} onChange={(e) => updateSettings({ straightHighlighter: e.target.checked })} /> Straight line
        </label>
      </>
    );
  } else if (tool === 'eraser') {
    body = (
      <>
        <SizeDots sizes={ERASER_SIZES} value={t.eraserWidth} scale={0.5} max={12} onPick={(eraserWidth) => setTools({ eraserWidth })} />
        <span className="tb-sep" />
        <Segmented label="Eraser mode" value={settings.eraserMode} onChange={(eraserMode) => updateSettings({ eraserMode })} options={[{ value: 'precise', label: 'Precise' }, { value: 'stroke', label: 'Whole stroke' }]} />
        <label className="sub-check">
          <input type="checkbox" checked={settings.eraserHighlighterOnly} onChange={(e) => updateSettings({ eraserHighlighterOnly: e.target.checked })} /> Highlighter only
        </label>
        <label className="sub-check">
          <input type="checkbox" checked={settings.eraserAutoDeselect} onChange={(e) => updateSettings({ eraserAutoDeselect: e.target.checked })} /> Switch back after use
        </label>
        <span className="tb-sep" />
        <Button size="sm" variant="ghost" onClick={() => {
          if (!vp) return;
          const pid = vp.session.pages[vp.pageIndexNow].id;
          const c = vp.session.content(pid);
          if (c && (c.strokes.length || c.objects.length)) {
            vp.session.commit(pid, { strokes: [], objects: [] });
            toast('Page cleared', { action: { label: 'Undo', run: () => vp.session.undo() } });
          }
        }}>
          Clear page
        </Button>
      </>
    );
  } else if (tool === 'lasso') {
    body = (
      <>
        <span className="sub-hint">Draw around ink, text or images to select them. Click an image or text box to pick it.</span>
        <Button size="sm" variant="ghost" onClick={() => vp?.selectAll()}>
          Select all
        </Button>
        {hasClipboard() && (
          <Button size="sm" variant="ghost" onClick={() => void vp?.paste()}>
            Paste
          </Button>
        )}
      </>
    );
  } else if (tool === 'text') {
    body = (
      <>
        <span className="sub-hint">Click to add text, drag text to move it.</span>
        <span className="tb-sep" />
        <TextFormat value={t.text} onChange={(p) => setTools({ text: { ...t.text, ...p } })} />
      </>
    );
  } else if (tool === 'image') {
    body = (
      <>
        <Button size="sm" onClick={() => vp && void pickImage(vp, vp.session.pages[vp.pageIndexNow].id)}>
          <ImagePlus size={15} /> Insert image…
        </Button>
        <Button size="sm" onClick={(e) => onPop('camera', (e.currentTarget as HTMLElement).getBoundingClientRect())}>
          <Camera size={15} /> Take photo
        </Button>
        <span className="sub-hint">Or paste (Ctrl+V) or drop image files onto the page.</span>
      </>
    );
  } else if (tool === 'tape') {
    body = (
      <>
        <Colors colors={TAPE_COLORS} value={t.tapeColor} onPick={(tapeColor) => setTools({ tapeColor })} />
        <span className="tb-sep" />
        <SizeDots sizes={TAPE_SIZES} value={t.tapeWidth} scale={0.45} max={10} onPick={(tapeWidth) => setTools({ tapeWidth })} />
        <span className="tb-sep" />
        <span className="sub-hint">Drag to cover answers. Click tape to peek.</span>
        <Button size="sm" variant="ghost" onClick={() => vp?.setAllTape(true)}>
          <Eye size={15} /> Reveal all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => vp?.setAllTape(false)}>
          <EyeOff size={15} /> Hide all
        </Button>
      </>
    );
  } else if (tool === 'ai') {
    body = (
      <>
        <Sparkles size={15} className="sub-ai-icon" />
        <span className="sub-hint">Draw a loop around anything on the page (handwriting, PDF, pictures) to ask AI about it.</span>
      </>
    );
  } else if (tool === 'laser') {
    body = (
      <>
        <Segmented label="Laser style" value={settings.laserMode} onChange={(laserMode) => updateSettings({ laserMode })} options={[{ value: 'trail', label: 'Trail' }, { value: 'dot', label: 'Dot' }]} />
        <span className="tb-sep" />
        <Colors colors={LASER_COLORS} value={t.laserColor} onPick={(laserColor) => setTools({ laserColor })} />
        <span className="sub-hint">Points without leaving a mark. Shows on the presentation screen too.</span>
      </>
    );
  }
  return (
    <div className="subbar" role="toolbar" aria-label="Tool options">
      {body}
    </div>
  );
}

// ---- popovers ----------------------------------------------------------------------------------

function ToolPopover({ pop, onClose }: { pop: { kind: string; anchor: DOMRect; index?: number }; onClose: () => void }) {
  const settings = useApp((st) => st.settings);
  const t = useApp((st) => st.tools);
  const [hex, setHex] = useState('');
  if (pop.kind === 'pen-color' || pop.kind === 'hl-color' || pop.kind === 'pen-color-new') {
    const hl = pop.kind === 'hl-color';
    const list = hl ? settings.hlColors : settings.penColors;
    const cur = pop.kind === 'pen-color-new' ? t.penColor : list[pop.index!];
    const apply = (c: string) => {
      if (!/^#[0-9a-f]{6}$/i.test(c)) return;
      if (pop.kind === 'pen-color-new') {
        updateSettings({ penColors: [...settings.penColors.filter((x) => x !== c), c].slice(-8) });
        setTools({ penColor: c });
        return;
      }
      const next = list.map((x, i) => (i === pop.index ? c : x));
      if (hl) {
        updateSettings({ hlColors: next });
        setTools({ hlColor: c });
      } else {
        updateSettings({ penColors: next });
        setTools({ penColor: c });
      }
    };
    const palette = hl
      ? ['#ffe066', '#ffd166', '#9ef0a8', '#7ee0c9', '#a6d8ff', '#c9b8ff', '#ffb3d1', '#ffb38a', '#d9d9de']
      : ['#1b1b1f', '#4b4b55', '#8a8a94', '#1f4fd1', '#3aa0e8', '#14a3a3', '#1d7f45', '#7bb03a', '#e2b00b', '#ef7d22', '#c8202f', '#d6336c', '#9b3bd4', '#6d4bb8', '#8b5a2b', '#ffffff'];
    return (
      <Popover anchor={pop.anchor} onClose={onClose} className="color-pop">
        <div className="palette">
          {palette.map((c) => (
            <Swatch key={c} color={c} size={26} selected={c.toLowerCase() === cur.toLowerCase()} onClick={() => apply(c)} />
          ))}
        </div>
        <div className="row">
          <input type="color" aria-label="Custom colour" value={cur} onChange={(e) => apply(e.target.value)} />
          <input className="input input-sm mono" aria-label="Hex colour" placeholder={cur} value={hex} onChange={(e) => setHex(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply(hex.startsWith('#') ? hex : `#${hex}`)} />
        </div>
      </Popover>
    );
  }
  if (pop.kind === 'pen-size' || pop.kind === 'hl-size') {
    const hl = pop.kind === 'hl-size';
    const sizes = hl ? settings.hlSizes : settings.penSizes;
    const val = sizes[pop.index!];
    const set = (v: number) => {
      const next = sizes.map((x, i) => (i === pop.index ? v : x)) as [number, number, number];
      if (hl) {
        updateSettings({ hlSizes: next });
        setTools({ hlWidth: v });
      } else {
        updateSettings({ penSizes: next });
        setTools({ penWidth: v });
      }
    };
    return (
      <Popover anchor={pop.anchor} onClose={onClose} className="size-pop">
        <label className="field">
          <span className="field-label">Thickness {val.toFixed(hl ? 0 : 1)} pt</span>
          <input type="range" min={hl ? 4 : 0.4} max={hl ? 40 : 12} step={hl ? 1 : 0.1} value={val} onChange={(e) => set(+e.target.value)} />
        </label>
      </Popover>
    );
  }
  if (pop.kind.startsWith('tool-')) {
    const tool = pop.kind.slice(5);
    return (
      <Popover anchor={pop.anchor} onClose={onClose} className="tool-pop">
        {tool === 'pen' && (
          <div className="stack">
            <Segmented<PenKind> label="Pen type" value={t.penKind} onChange={(penKind) => setTools({ penKind })} options={[{ value: 'fountain', label: 'Fountain' }, { value: 'ball', label: 'Ballpoint' }, { value: 'brush', label: 'Brush' }]} />
            <label className="sub-check">
              <input type="checkbox" checked={settings.pressure} onChange={(e) => updateSettings({ pressure: e.target.checked })} /> Pressure sensitivity
            </label>
            <label className="sub-check">
              <input type="checkbox" checked={settings.holdToShape} onChange={(e) => updateSettings({ holdToShape: e.target.checked })} /> Hold to snap shapes
            </label>
          </div>
        )}
        {tool !== 'pen' && <p className="muted small">Options for this tool are in the bar below the toolbar.</p>}
      </Popover>
    );
  }
  if (pop.kind === 'camera') return <CameraPopover anchor={pop.anchor} onClose={onClose} />;
  return null;
}

function CameraPopover({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 1920, height: 1080 } })
      .then((st) => {
        stream = st;
        if (video.current) {
          video.current.srcObject = st;
          void video.current.play();
        }
      })
      .catch(() => setErr('No camera available, or camera access is turned off in Windows privacy settings.'));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  const snap = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.92));
    window.dispatchEvent(new CustomEvent('goodink:photo', { detail: new Uint8Array(await blob.arrayBuffer()) }));
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} className="camera-pop">
      {err ? (
        <p className="muted small">{err}</p>
      ) : (
        <>
          <video ref={video} muted playsInline />
          <Button variant="primary" className="full" onClick={() => void snap()}>
            <Camera size={15} /> Capture
          </Button>
        </>
      )}
    </Popover>
  );
}

// ---- selection menu -----------------------------------------------------------------------------

function SelectionMenu({ vp, sel, anchor }: { vp: Viewport; sel: Selection; anchor: DOMRect }) {
  const [colors, setColors] = useState(false);
  const elements = useApp((st) => st.elements);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -999, top: -999 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let top = anchor.top - h - 16;
    if (top < 100) top = anchor.bottom + 16;
    if (top + h > window.innerHeight - 10) top = Math.max(100, anchor.top + 10);
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - w / 2, window.innerWidth - w - 8));
    setPos({ left, top });
  }, [anchor, colors]);
  const hasInk = sel.strokeIds.size > 0;
  const saveElement = () => {
    const items = vp.selectionItems();
    if (!items) return;
    const objects = items.objects.filter((o) => o.type !== 'pdf' && !(o.type === 'image' && o.src.startsWith('asset:')));
    let b: BBox | null = null;
    for (const st of items.strokes) b = bboxUnion(b, st.bbox);
    for (const o of objects) b = bboxUnion(b, objectBBox(o));
    if (!b) return;
    const [x0, y0] = b;
    saveElements([
      {
        id: uid(),
        title: 'Element',
        createdAt: Date.now(),
        w: b[2] - b[0],
        h: b[3] - b[1],
        strokes: items.strokes.map((st) => {
          const pts = st.pts.slice();
          for (let k = 0; k < pts.length; k += 3) {
            pts[k] -= x0;
            pts[k + 1] -= y0;
          }
          return strokeToJSON({ ...st, pts });
        }),
        objects: objects.map((o) => ({ ...o, x: o.x - x0, y: o.y - y0 })),
      },
      ...elements,
    ]);
    toast('Saved to My elements');
  };
  const btn = (label: string, icon: ReactNode, run: () => void, danger = false) => (
    <button className={`sel-btn ${danger ? 'is-danger' : ''}`} onClick={run} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <div ref={ref} className="sel-menu" style={pos} role="toolbar" aria-label="Selection" onPointerDown={(e) => e.stopPropagation()}>
      {colors ? (
        <div className="sel-colors">
          {['#1b1b1f', '#1f4fd1', '#c8202f', '#1d7f45', '#e2b00b', '#ef7d22', '#9b3bd4', '#8a8a94', '#ffe066', '#9ef0a8'].map((c) => (
            <Swatch key={c} color={c} onClick={() => vp.recolorSelection(c)} />
          ))}
          <button className="sel-btn" onClick={() => setColors(false)}>
            Done
          </button>
        </div>
      ) : (
        <>
          {btn('Cut', <Scissors size={16} />, () => vp.cutSelection())}
          {btn('Copy', <Copy size={16} />, () => {
            vp.copySelection();
            toast('Copied');
          })}
          {btn('Duplicate', <CopyPlus size={16} />, () => vp.duplicateSelection())}
          {btn('Delete', <Trash2 size={16} />, () => vp.deleteSelection(), true)}
          <span className="tb-sep" />
          {btn('Colour', <Palette size={16} />, () => setColors(true))}
          {btn('Bigger', <Scaling size={16} />, () => vp.resizeSelection(1.25))}
          {btn('Smaller', <Square size={14} />, () => vp.resizeSelection(0.8))}
          {btn('Front', <ArrowUpToLine size={16} />, () => vp.arrangeSelection('front'))}
          {btn('Back', <ArrowDownToLine size={16} />, () => vp.arrangeSelection('back'))}
          <span className="tb-sep" />
          {btn('Screenshot', <Camera size={16} />, async () => {
            const png = await vp.selectionPng();
            if (png) {
              await api.clipboardWriteImage(png);
              toast('Copied as an image');
            }
          })}
          {hasInk &&
            btn('To text', <ScanText size={16} />, async () => {
              const text = await vp.convertSelectionToText();
              toast(text ? 'Converted to text' : 'Could not read this handwriting. Try writing a little larger.', { kind: text ? 'success' : 'error', action: text ? { label: 'Undo', run: () => vp.session.undo() } : undefined });
            })}
          {btn('Save element', <Save size={16} />, saveElement)}
          <span className="tb-sep" />
          {btn('Done', <X size={16} />, () => vp.clearSelection())}
        </>
      )}
    </div>
  );
}
