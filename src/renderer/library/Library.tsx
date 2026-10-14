import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BookOpen, Star, Clock, Trash2, Folder as FolderIcon, FolderPlus, Plus, Search, Settings as SettingsIcon, Upload, LayoutGrid, List, ArrowUpDown,
  MoreHorizontal, FileUp, Pencil, Copy, FolderInput, Archive, Lock, Unlock, RotateCcw, XCircle, FileDown, Palette, Zap, ChevronRight, X, ScrollText, GraduationCap, Link as LinkIcon, MonitorPlay, ExternalLink, Sparkles, Globe, Play,
  File as FileIcon, FileText, FileImage, FileVideo, FileAudio, FileArchive, FileSpreadsheet, FileCode, Presentation, FolderOpen, Files,
} from 'lucide-react';
import type { FileItem, Folder, LinkItem, NotebookMeta, SearchHit } from '../../shared/types';
import {
  useApp, showSection, openNotebook, openDialog, toggleFavorite, trashItems, restoreItems, deleteForever, duplicateNotebook, exportBackup, pickAndImport,
  quickNote, pickPdfs, makeCardsFrom, findSourcesFor, openLink, studyFolder, createFolder, moveItems, sortNotebooks, updateSettings, emptyTrash, confirmDialog, setLock, removeLock, askPassword, toast, type Section,
  FILE_ID, openLibraryFile, pickFiles, importImageFiles, filePath,
} from '../lib/store';
import { api } from '../lib/api';
import { formatDate } from '../lib/util';
import { domainOf } from '../lib/web';
import { youtubeId } from '../study/youtube';
import { AddLinkDialog } from './LinkDialogs';
import { CoverArt } from './CoverArt';
import { Button, IconButton, Menu, Segmented, Spinner, menuPoint, type MenuItem } from '../ui/primitives';
// Study (Anki-style flashcards) loads on first use
const StudyApp = lazy(() => import('../study/StudyApp').then((m) => ({ default: m.StudyApp })));
const FindSourcesDialog = lazy(() => import('../study/FindSources').then((m) => ({ default: m.FindSourcesDialog })));

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'all', label: 'Files', icon: <FolderIcon size={17} /> },
  { id: 'favorites', label: 'Favourites', icon: <Star size={17} /> },
  { id: 'recents', label: 'Recents', icon: <Clock size={17} /> },
  { id: 'study', label: 'Study', icon: <GraduationCap size={17} /> },
  { id: 'trash', label: 'Trash', icon: <Trash2 size={17} /> },
];

export function Library() {
  const section = useApp((st) => st.section);
  return (
    <div className="library">
      <TopBar />
      {section === 'study' ? (
        <Suspense fallback={<div className="editor-msg"><Spinner size={22} /></div>}>
          <StudyApp />
        </Suspense>
      ) : (
        <>
          <FolderStrip />
          <LibraryMain />
        </>
      )}
    </div>
  );
}

function TopBar() {
  const { section, folderId, library, query } = useApp();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [adding, setAdding] = useState<'link' | 'sources' | null>(null);
  const trashCount = library.notebooks.filter((n) => n.deletedAt).length + (library.links ?? []).filter((x) => x.deletedAt).length + library.folders.filter((f) => f.deletedAt).length;
  const newMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 220,
      y: r.bottom + 6,
      items: [
        { label: 'Notebook…', icon: <BookOpen size={15} />, shortcut: 'Ctrl+N', run: () => openDialog({ type: 'new-notebook', folderId }) },
        { label: 'Quick note', icon: <Zap size={15} />, shortcut: 'Ctrl+Shift+N', run: () => void quickNote() },
        { label: 'Folder', icon: <FolderPlus size={15} />, run: () => {
          const id = createFolder('New folder');
          openDialog({ type: 'rename', kind: 'folder', id });
        } },
        { separator: true, label: '' },
        { label: 'Import PDF or images…', icon: <Upload size={15} />, shortcut: 'Ctrl+O', run: () => void pickAndImport() },
        { label: 'Link or YouTube video…', icon: <LinkIcon size={15} />, run: () => setAdding('link') },
        { label: 'Add files…', icon: <Files size={15} />, run: () => void pickFiles() },
        { separator: true, label: '' },
        { label: 'Find sources…', icon: <Sparkles size={15} />, run: () => setAdding('sources') },
      ],
    });
  };
  return (
    <header className="lib-top">
      <div className="lib-brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 28 28" width="26" height="26">
            <rect width="28" height="28" rx="8" fill="var(--c-text)" />
            <path d="M8 19c3-1 4-9 7-9s1 7 5 6" stroke="var(--c-surface)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          </svg>
        </span>
        <span className="brand-name">goodink</span>
      </div>
      <nav className="lib-tabs" aria-label="Library">
        {SECTIONS.map((s) => (
          <button key={s.id} className={`lib-tab ${section === s.id && !query ? 'is-active' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => showSection(s.id, s.id === 'all' || s.id === 'study' ? folderId : null)}>
            {s.icon}
            <span>{s.label}</span>
            {s.id === 'trash' && trashCount > 0 && <span className="lib-tab-count">{trashCount}</span>}
          </button>
        ))}
      </nav>
      {section !== 'study' && (
      <div className="lib-search">
        <Search size={16} />
        <input
          id="lib-search"
          placeholder="Search notebooks, links, typed text, PDFs and handwriting"
          value={query}
          onChange={(e) => useApp.setState({ query: e.target.value })}
          onKeyDown={(e) => e.key === 'Escape' && useApp.setState({ query: '' })}
        />
        {query ? (
          <IconButton label="Clear search" onClick={() => useApp.setState({ query: '' })}>
            <X size={14} />
          </IconButton>
        ) : (
          <kbd>Ctrl F</kbd>
        )}
      </div>
      )}
      <div className="lib-actions">
        {section !== 'study' && (
          <>
            <Button onClick={() => void pickPdfs()} title="Import one or more PDFs as notebooks (Ctrl+O)">
              <FileUp size={16} /> Import PDF
            </Button>
            <Button variant="primary" onClick={newMenu}>
              <Plus size={16} /> New
            </Button>
          </>
        )}
        <IconButton label="Settings" onClick={() => openDialog({ type: 'settings' })}>
          <SettingsIcon size={18} />
        </IconButton>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {adding === 'link' && <AddLinkDialog folderId={folderId} onClose={() => setAdding(null)} />}
      {adding === 'sources' && (
        <Suspense fallback={null}>
          <FindSourcesDialog folderId={folderId} onClose={() => setAdding(null)} />
        </Suspense>
      )}
    </header>
  );
}

function FolderStrip() {
  const { section, folderId, library, query } = useApp();
  if (section !== 'all' || query) return null;
  const roots = library.folders.filter((f) => !f.parentId && !f.deletedAt).sort((a, b) => a.title.localeCompare(b.title));
  let top = library.folders.find((f) => f.id === folderId);
  while (top?.parentId) top = library.folders.find((f) => f.id === top!.parentId);
  const total = library.notebooks.filter((n) => !n.deletedAt).length + (library.links ?? []).filter((x) => !x.deletedAt).length;
  return (
    <div className="folder-strip" role="toolbar" aria-label="Folders">
      <span className="folder-strip-label">Folders</span>
      <button className={`chip ${!folderId ? 'is-active' : ''}`} aria-pressed={!folderId} onClick={() => showSection('all')}>
        All<span className="chip-count">{total}</span>
      </button>
      {roots.map((f) => (
        <FolderChip key={f.id} folder={f} active={top?.id === f.id} />
      ))}
      <button
        className="chip chip-add"
        onClick={() => {
          const id = createFolder('New folder', folderId);
          openDialog({ type: 'rename', kind: 'folder', id });
        }}
      >
        <FolderPlus size={14} /> Folder
      </button>
    </div>
  );
}

function FolderChip({ folder, active }: { folder: Folder; active: boolean }) {
  const { library } = useApp();
  const [over, setOver] = useState(false);
  const count = library.notebooks.filter((n) => n.folderId === folder.id && !n.deletedAt).length + (library.links ?? []).filter((x) => x.folderId === folder.id && !x.deletedAt).length;
  return (
    <button
      className={`chip ${active ? 'is-active' : ''} ${over ? 'is-drop' : ''}`}
      aria-pressed={active}
      onClick={() => showSection('all', folder.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-goodink')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const ids = (JSON.parse(e.dataTransfer.getData('application/x-goodink') || '[]') as string[]).filter((x) => x !== folder.id);
        moveItems(ids, folder.id);
      }}
    >
      <span className="chip-dot" style={{ background: folder.color }} />
      <span className="ellipsis">{folder.title}</span>
      {count > 0 && <span className="chip-count">{count}</span>}
    </button>
  );
}

function ContinueCard({ nb }: { nb: NotebookMeta }) {
  const thumb = nb.thumbVersion ? api.thumbUrl(nb.id, nb.thumbVersion) : undefined;
  const folder = useApp((st) => st.library.folders.find((f) => f.id === nb.folderId));
  return (
    <section className="continue" aria-labelledby="continue-title">
      <button className="continue-cover" onClick={() => void openNotebook(nb.id)} aria-label={`Open ${nb.title}`}>
        <CoverArt cover={nb.cover} title={nb.title} thumb={thumb} ratio={Math.max(0.6, Math.min(1.5, nb.firstPage.w / nb.firstPage.h))} kind={nb.kind} />
      </button>
      <div className="continue-body">
        <span className="continue-kicker">Continue where you left off</span>
        <h2 id="continue-title">{nb.title}</h2>
        <span className="muted">
          {nb.pageCount} page{nb.pageCount === 1 ? '' : 's'} · edited {formatDate(nb.updatedAt)}
          {folder ? ` · ${folder.title}` : ''}
        </span>
        <div className="continue-actions">
          <Button variant="primary" onClick={() => void openNotebook(nb.id)}>
            <Pencil size={16} /> Continue writing
          </Button>
        </div>
      </div>
    </section>
  );
}

function LibraryMain() {
  const { section, folderId, library, settings, query, picked } = useApp();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [find, setFind] = useState<string | null | undefined>(undefined);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      setHits(await api.search(query));
      setSearching(false);
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  const folder = library.folders.find((f) => f.id === folderId);
  const crumbs: Folder[] = [];
  for (let f = folder; f; f = library.folders.find((x) => x.id === f!.parentId)) crumbs.unshift(f);

  const showFiles = settings.filesView === 'all';
  const { folders, notebooks, links, files } = useMemo(() => {
    const allFiles = settings.filesView === 'all' ? library.files ?? [] : [];
    let fls: FileItem[] = [];
    const live = library.notebooks.filter((n) => !n.deletedAt);
    const allLinks = library.links ?? [];
    const liveLinks = allLinks.filter((x) => !x.deletedAt);
    let lks: LinkItem[] = [];
    let nbs: NotebookMeta[] = [];
    let fds: Folder[] = [];
    if (query.trim()) {
      const q = query.toLowerCase();
      nbs = live.filter((n) => n.title.toLowerCase().includes(q));
      lks = liveLinks.filter((x) => x.title.toLowerCase().includes(q) || x.url.toLowerCase().includes(q) || (x.author ?? '').toLowerCase().includes(q));
      fds = library.folders.filter((f) => !f.deletedAt && f.title.toLowerCase().includes(q));
      fls = allFiles.filter((f) => f.name.toLowerCase().includes(q));
    } else if (section === 'all') {
      fls = allFiles.filter((f) => f.folderId === folderId);
      nbs = live.filter((n) => n.folderId === folderId);
      // "Notebooks" shows only what you write in; links and other files come with "All files"
      lks = settings.filesView === 'all' ? liveLinks.filter((x) => x.folderId === folderId) : [];
      fds = library.folders.filter((f) => f.parentId === folderId && !f.deletedAt);
    } else if (section === 'favorites') {
      nbs = live.filter((n) => n.favorite);
      lks = liveLinks.filter((x) => x.favorite);
    } else if (section === 'recents') {
      nbs = sortNotebooks(live, 'opened').slice(0, 24);
      lks = liveLinks.filter((x) => x.openedAt).sort((a, b) => b.openedAt - a.openedAt).slice(0, 12);
    } else if (section === 'trash') {
      nbs = library.notebooks.filter((n) => n.deletedAt);
      lks = allLinks.filter((x) => x.deletedAt);
      fds = library.folders.filter((f) => f.deletedAt && !library.folders.find((p) => p.id === f.parentId)?.deletedAt);
    }
    return {
      folders: fds.sort((a, b) => a.title.localeCompare(b.title)),
      notebooks: section === 'recents' && !query ? nbs : sortNotebooks(nbs, settings.sort),
      links: section === 'recents' && !query ? lks : [...lks].sort((a, b) => (settings.sort === 'title' ? a.title.localeCompare(b.title) : settings.sort === 'opened' ? b.openedAt - a.openedAt : settings.sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt)),
      files: [...fls].sort((a, b) => (settings.sort === 'title' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : b.modified - a.modified)),
    };
  }, [library, section, folderId, query, settings.sort, settings.filesView]);

  const title = query ? `Results for “${query}”` : folder ? folder.title : SECTIONS.find((s) => s.id === section)?.label ?? 'Files';
  const inTrash = section === 'trash' && !query;

  const pick = (id: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      useApp.setState({ picked: picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id] });
      return true;
    }
    if (e.shiftKey && picked.length) {
      const order = [...folders.map((f) => f.id), ...notebooks.map((n) => n.id), ...links.map((k) => k.id), ...files.map((f) => FILE_ID + f.rel)];
      const a = order.indexOf(picked[picked.length - 1]), b = order.indexOf(id);
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      useApp.setState({ picked: [...new Set([...picked, ...range])] });
      return true;
    }
    return false;
  };

  const notebookMenu = (n: NotebookMeta, x: number, y: number) => {
    const items: MenuItem[] = inTrash
      ? [
          { label: 'Restore', icon: <RotateCcw size={15} />, run: () => restoreItems([n.id]) },
          { separator: true, label: '' },
          { label: 'Delete forever', icon: <XCircle size={15} />, danger: true, run: () => confirmDialog(`Delete “${n.title}” forever?`, 'It will be removed from this PC. This cannot be undone.', 'Delete forever', () => void deleteForever([n.id])) },
        ]
      : [
          { label: 'Open', icon: <BookOpen size={15} />, run: () => void openNotebook(n.id) },
          { label: n.favorite ? 'Remove from Favourites' : 'Add to Favourites', icon: <Star size={15} />, run: () => toggleFavorite(n.id) },
          { separator: true, label: '' },
          { label: 'Show in Explorer', icon: <FolderOpen size={15} />, run: () => void api.reveal({ id: n.id }) },
          { label: 'Rename', icon: <Pencil size={15} />, shortcut: 'F2', run: () => openDialog({ type: 'rename', kind: 'notebook', id: n.id }) },
          { label: 'Change cover', icon: <Palette size={15} />, run: () => openDialog({ type: 'cover', nbId: n.id }) },
          { label: 'Duplicate', icon: <Copy size={15} />, run: () => void duplicateNotebook(n.id) },
          { label: 'Move to…', icon: <FolderInput size={15} />, run: () => openDialog({ type: 'move', ids: picked.includes(n.id) ? picked : [n.id] }) },
          { separator: true, label: '' },
          { label: 'Make flashcards in Study…', icon: <GraduationCap size={15} />, run: () => makeCardsFrom(n.id) },
          { label: 'Find sources for this notebook…', icon: <Search size={15} />, run: () => findSourcesFor(n.id) },
          { label: 'Summarize with AI…', icon: <ScrollText size={15} />, run: () => openDialog({ type: 'ai', nbId: n.id }) },
          { separator: true, label: '' },
          { label: 'Export as PDF…', icon: <FileDown size={15} />, run: () => openDialog({ type: 'export', nbId: n.id }) },
          { label: 'Back up (.gink)…', icon: <Archive size={15} />, run: () => void exportBackup(n.id) },
          n.lock
            ? { label: 'Remove lock', icon: <Unlock size={15} />, run: () => void unlock(n) }
            : { label: 'Lock with password…', icon: <Lock size={15} />, run: () => void lock(n) },
          { separator: true, label: '' },
          { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, shortcut: 'Del', run: () => trashItems(picked.includes(n.id) ? picked : [n.id]) },
        ];
    setMenu({ x, y, items });
  };

  const linkMenu = (k: LinkItem, x: number, y: number) => {
    const items: MenuItem[] = inTrash
      ? [
          { label: 'Restore', icon: <RotateCcw size={15} />, run: () => restoreItems([k.id]) },
          { separator: true, label: '' },
          { label: 'Delete forever', icon: <XCircle size={15} />, danger: true, run: () => confirmDialog(`Delete “${k.title}” forever?`, 'The link is removed from your library. Flashcards made from it stay.', 'Delete forever', () => void deleteForever([k.id])) },
        ]
      : [
          { label: 'Open', icon: k.kind === 'youtube' ? <MonitorPlay size={15} /> : <LinkIcon size={15} />, run: () => openLink(k.id) },
          { label: 'Open in browser', icon: <ExternalLink size={15} />, run: () => void api.openUrl(k.url) },
          { label: k.favorite ? 'Remove from Favourites' : 'Add to Favourites', icon: <Star size={15} />, run: () => toggleFavorite(k.id) },
          { separator: true, label: '' },
          { label: 'Make flashcards in Study…', icon: <GraduationCap size={15} />, run: () => makeCardsFrom(k.id) },
          { separator: true, label: '' },
          { label: 'Show in Explorer', icon: <FolderOpen size={15} />, run: () => void api.reveal({ id: k.id }) },
          { label: 'Rename', icon: <Pencil size={15} />, shortcut: 'F2', run: () => openDialog({ type: 'rename', kind: 'link', id: k.id }) },
          { label: 'Move to…', icon: <FolderInput size={15} />, run: () => openDialog({ type: 'move', ids: picked.includes(k.id) ? picked : [k.id] }) },
          { separator: true, label: '' },
          { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, shortcut: 'Del', run: () => trashItems(picked.includes(k.id) ? picked : [k.id]) },
        ];
    setMenu({ x, y, items });
  };

  const folderMenu = (f: Folder, x: number, y: number) => {
    const items: MenuItem[] = inTrash
      ? [
          { label: 'Restore', icon: <RotateCcw size={15} />, run: () => restoreItems([f.id, ...library.notebooks.filter((n) => n.folderId === f.id).map((n) => n.id)]) },
          { label: 'Delete forever', icon: <XCircle size={15} />, danger: true, run: () => void deleteForever([f.id, ...library.notebooks.filter((n) => n.folderId === f.id).map((n) => n.id)]) },
        ]
      : [
          { label: 'Open', icon: <FolderIcon size={15} />, run: () => showSection('all', f.id) },
          { label: 'Study this folder', icon: <GraduationCap size={15} />, run: () => studyFolder(f.id) },
          { label: 'Find sources into this folder…', icon: <Sparkles size={15} />, run: () => setFind(f.id) },
          { label: 'Show in Explorer', icon: <FolderOpen size={15} />, run: () => void api.reveal({ id: f.id }) },
          { label: 'Rename', icon: <Pencil size={15} />, run: () => openDialog({ type: 'rename', kind: 'folder', id: f.id }) },
          { label: 'Move to…', icon: <FolderInput size={15} />, run: () => openDialog({ type: 'move', ids: [f.id] }) },
          { separator: true, label: '' },
          { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, run: () => trashItems([f.id]) },
        ];
    setMenu({ x, y, items });
  };

  const fileMenu = (f: FileItem, x: number, y: number) => {
    const id = FILE_ID + f.rel;
    const ids = picked.includes(id) ? picked : [id];
    const pdf = /\.pdf$/i.test(f.name);
    const img = /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
    setMenu({
      x,
      y,
      items: [
        { label: pdf ? 'Open in goodink to write on' : 'Open', icon: pdf ? <BookOpen size={15} /> : <ExternalLink size={15} />, run: () => void openLibraryFile(f) },
        ...(pdf ? [{ label: 'Open in its usual app', icon: <ExternalLink size={15} />, run: () => void api.fileOpen(f.rel) }] : []),
        ...(img ? [{ label: 'Make a notebook from it', icon: <BookOpen size={15} />, run: () => void importImageFiles([filePath(f.rel)], f.folderId) }] : []),
        { label: 'Show in Explorer', icon: <FolderOpen size={15} />, run: () => void api.reveal({ rel: f.rel }) },
        { separator: true, label: '' },
        { label: 'Rename', icon: <Pencil size={15} />, shortcut: 'F2', run: () => openDialog({ type: 'rename', kind: 'file', id: f.rel }) },
        { label: 'Move to…', icon: <FolderInput size={15} />, run: () => openDialog({ type: 'move', ids }) },
        { separator: true, label: '' },
        { label: 'Move to the Recycle Bin', icon: <Trash2 size={15} />, danger: true, shortcut: 'Del', run: () => trashItems(ids) },
      ],
    });
  };

  const sortMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const opt = (label: string, v: typeof settings.sort): MenuItem => ({ label, checked: settings.sort === v, run: () => updateSettings({ sort: v }) });
    setMenu({ x: r.left, y: r.bottom + 6, items: [opt('Date modified', 'modified'), opt('Date created', 'created'), opt('Last opened', 'opened'), opt('Name', 'title')] });
  };

  const lock = async (n: NotebookMeta) => {
    const pw = await askPassword(`Set a password for “${n.title}”`);
    if (pw) {
      await setLock(n.id, pw);
      toast('Notebook locked. You will need the password to open it.', { kind: 'success' });
    }
  };
  const unlock = async (n: NotebookMeta) => {
    const pw = await askPassword(`Enter the password for “${n.title}”`);
    if (pw == null) return;
    if (await removeLock(n.id, pw)) toast('Lock removed');
    else toast('That password is not right.', { kind: 'error' });
  };

  const empty = !folders.length && !notebooks.length && !links.length && !files.length && !hits.length;
  const recent = section === 'all' && !folderId && !query ? sortNotebooks(library.notebooks.filter((n) => !n.deletedAt && n.openedAt > 0), 'opened')[0] : undefined;

  return (
    <main
      className="lib-main"
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lib-scroll')) useApp.setState({ picked: [] });
      }}
    >
      <header className="lib-head">
        <div className="lib-title">
          {crumbs.length > 0 && !query ? (
            <nav className="crumbs" aria-label="Folder path">
              <button onClick={() => showSection('all')}>Files</button>
              {crumbs.map((c, i) => (
                <span key={c.id}>
                  <ChevronRight size={14} />
                  {i === crumbs.length - 1 ? <strong>{c.title}</strong> : <button onClick={() => showSection('all', c.id)}>{c.title}</button>}
                </span>
              ))}
            </nav>
          ) : (
            <h1>{title}</h1>
          )}
        </div>
        <div className="lib-actions">
          {section === 'all' && (
            <Segmented
              label="Show"
              value={showFiles ? 'all' : 'notebooks'}
              onChange={(v) => updateSettings({ filesView: v })}
              options={[
                { value: 'notebooks', label: 'Notebooks', title: 'Only notebooks and PDFs to write on' },
                { value: 'all', label: 'All files', title: 'Also links and every other file in these folders on your PC' },
              ]}
            />
          )}
          {section === 'all' && !query && (
            <>
              <IconButton label="Show in Explorer" onClick={() => void api.reveal(folderId ? { id: folderId } : {})}>
                <FolderOpen size={17} />
              </IconButton>
              <Button variant="ghost" onClick={() => setFind(folderId)} title="Search the web and YouTube and save the best sources here">
                <Sparkles size={16} /> Find sources
              </Button>
              <Button variant="ghost" onClick={() => studyFolder(folderId)} title="This folder's items and deck in Study">
                <GraduationCap size={16} /> Study{folder ? ' this folder' : ''}
              </Button>
            </>
          )}
          <IconButton label="Sort" onClick={sortMenu}>
            <ArrowUpDown size={17} />
          </IconButton>
          <IconButton label={settings.view === 'grid' ? 'List view' : 'Grid view'} onClick={() => updateSettings({ view: settings.view === 'grid' ? 'list' : 'grid' })}>
            {settings.view === 'grid' ? <List size={17} /> : <LayoutGrid size={17} />}
          </IconButton>
          {inTrash && (
            <Button variant="danger" onClick={emptyTrash}>
              Empty Trash
            </Button>
          )}
        </div>
      </header>

      {picked.length > 0 && (
        <div className="pick-bar" role="toolbar" aria-label="Selection">
          <span>{picked.length} selected</span>
          {inTrash ? (
            <>
              <Button size="sm" onClick={() => { restoreItems(picked); useApp.setState({ picked: [] }); }}>Restore</Button>
              <Button size="sm" variant="danger" onClick={() => void deleteForever(picked).then(() => useApp.setState({ picked: [] }))}>Delete forever</Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => openDialog({ type: 'move', ids: picked })}>Move to…</Button>
              <Button size="sm" variant="danger" onClick={() => trashItems(picked)}>Move to Trash</Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => useApp.setState({ picked: [] })}>Done</Button>
        </div>
      )}

      <div className="lib-scroll" onClick={(e) => e.target === e.currentTarget && useApp.setState({ picked: [] })}>
        {inTrash && (notebooks.length > 0 || folders.length > 0) && <p className="lib-note">Items in Trash are deleted after 30 days.</p>}
        {recent && <ContinueCard nb={recent} />}
        {empty && !searching && <EmptyState section={query ? 'search' : section} inFolder={!!folderId} />}
        <div className={settings.view === 'grid' ? 'grid' : 'rows'}>
          {folders.map((f) => (
            <FolderCard
              key={f.id}
              folder={f}
              count={library.notebooks.filter((n) => n.folderId === f.id && !n.deletedAt).length + (showFiles ? (library.links ?? []).filter((x) => x.folderId === f.id && !x.deletedAt).length : 0) + library.folders.filter((x) => x.parentId === f.id && !x.deletedAt).length + (showFiles ? (library.files ?? []).filter((x) => x.folderId === f.id).length : 0)}
              picked={picked.includes(f.id)}
              onOpen={(e) => !pick(f.id, e) && !inTrash && showSection('all', f.id)}
              onMenu={(x, y) => folderMenu(f, x, y)}
            />
          ))}
          {notebooks.map((n) => (
            <NotebookCard key={n.id} nb={n} picked={picked.includes(n.id)} onOpen={(e) => !pick(n.id, e) && !inTrash && void openNotebook(n.id)} onMenu={(x, y) => notebookMenu(n, x, y)} />
          ))}
          {links.map((k) => (
            <LinkCard key={k.id} link={k} picked={picked.includes(k.id)} onOpen={(e) => !pick(k.id, e) && !inTrash && openLink(k.id)} onMenu={(x, y) => linkMenu(k, x, y)} />
          ))}
          {files.map((f) => (
            <FileCard key={f.rel} file={f} picked={picked.includes(FILE_ID + f.rel)} onOpen={(e) => !pick(FILE_ID + f.rel, e) && void openLibraryFile(f)} onMenu={(x, y) => fileMenu(f, x, y)} />
          ))}
        </div>
        {hits.filter((h) => h.source !== 'title').length > 0 && (
          <section className="hits">
            <h2>Inside your notebooks</h2>
            <ul>
              {hits
                .filter((h) => h.source !== 'title')
                .map((h, i) => (
                  <li key={i}>
                    <button
                      onClick={async () => {
                        await openNotebook(h.notebookId);
                        window.dispatchEvent(new CustomEvent('goodink:goto', { detail: { nbId: h.notebookId, pageId: h.pageId, query } }));
                      }}
                    >
                      <span className="hit-title">
                        {h.notebookTitle} <span className="muted">· page {h.pageNumber}</span>
                        <span className={`hit-src src-${h.source}`}>{h.source === 'ocr' ? 'handwriting' : h.source === 'pdf' ? 'PDF text' : 'typed'}</span>
                      </span>
                      <span className="hit-snippet">{h.snippet}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {find !== undefined && (
        <Suspense fallback={null}>
          <FindSourcesDialog folderId={find} onClose={() => setFind(undefined)} />
        </Suspense>
      )}
    </main>
  );
}

function EmptyState({ section, inFolder }: { section: Section; inFolder: boolean }) {
  const copy: Record<Section, { t: string; b: string }> = {
    all: inFolder ? { t: 'This folder is empty', b: 'Drag notebooks here, or create a new one inside it.' } : { t: 'Your shelf is empty', b: 'Start a notebook, or bring in a PDF to write on.' },
    favorites: { t: 'No favourites yet', b: 'Star a notebook from its ⋯ menu and it will wait for you here.' },
    recents: { t: 'Nothing opened yet', b: 'Notebooks you open appear here, newest first.' },
    trash: { t: 'Trash is empty', b: 'Deleted notebooks stay here for 30 days before they are removed.' },
    study: { t: '', b: '' },
    search: { t: 'No matches', b: 'Try a different word. Handwriting becomes searchable a few seconds after you write it.' },
  };
  const c = copy[section];
  return (
    <div className="empty">
      <svg viewBox="0 0 120 90" width="120" height="90" aria-hidden>
        <rect x="22" y="12" width="56" height="70" rx="6" fill="var(--c-surface)" stroke="var(--c-border)" strokeWidth="2" />
        <rect x="38" y="6" width="56" height="70" rx="6" fill="var(--c-surface)" stroke="var(--c-border-input)" strokeWidth="2" />
        <path d="M48 26h36M48 36h36M48 46h24" stroke="var(--c-border)" strokeWidth="3" strokeLinecap="round" />
        <path d="M54 62c6-10 14-14 24-20" stroke="var(--c-accent)" strokeWidth="3" strokeLinecap="round" fill="none" />
      </svg>
      <h2>{c.t}</h2>
      <p>{c.b}</p>
      {section === 'all' && (
        <div className="empty-actions">
          <Button variant="primary" onClick={() => openDialog({ type: 'new-notebook', folderId: useApp.getState().folderId })}>
            <Plus size={16} /> New notebook
          </Button>
          <Button onClick={() => void pickPdfs()}>
            <Upload size={16} /> Import PDF
          </Button>
        </div>
      )}
    </div>
  );
}

function dragStart(e: React.DragEvent, id: string) {
  const picked = useApp.getState().picked;
  e.dataTransfer.setData('application/x-goodink', JSON.stringify(picked.includes(id) ? picked : [id]));
  e.dataTransfer.effectAllowed = 'move';
}

function FolderCard({ folder, count, picked, onOpen, onMenu }: { folder: Folder; count: number; picked: boolean; onOpen: (e: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`card folder-card ${picked ? 'is-picked' : ''} ${over ? 'is-drop' : ''}`}
      draggable
      onDragStart={(e) => dragStart(e, folder.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-goodink')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const ids = (JSON.parse(e.dataTransfer.getData('application/x-goodink') || '[]') as string[]).filter((x) => x !== folder.id);
        moveItems(ids, folder.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = menuPoint(e);
        onMenu(at.x, at.y);
      }}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open folder ${folder.title}`}>
        <div className="folder-art" style={{ ['--fc' as string]: folder.color }}>
          <svg viewBox="0 0 120 90" aria-hidden>
            <path d="M6 18a8 8 0 0 1 8-8h30l10 10h52a8 8 0 0 1 8 8v48a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="var(--fc)" opacity=".85" />
            <path d="M6 32a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v44a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="var(--fc)" />
            <path d="M6 32a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v4H6z" fill="#fff" opacity=".18" />
          </svg>
        </div>
      </button>
      <div className="card-meta">
        <div className="card-title" title={folder.title}>
          {folder.title}
        </div>
        <div className="card-sub">
          {count} item{count === 1 ? '' : 's'}
          <IconButton label="More" className="card-more" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(r.left, r.bottom + 4);
          }}>
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

const FILE_KINDS: [RegExp, string, typeof FileIcon][] = [
  [/\.pdf$/i, 'PDF', FileText],
  [/\.(png|jpe?g|webp|gif|bmp|svg|heic|tiff?)$/i, 'Picture', FileImage],
  [/\.(mp4|mov|mkv|avi|webm|wmv)$/i, 'Video', FileVideo],
  [/\.(mp3|wav|m4a|flac|ogg|aac)$/i, 'Sound', FileAudio],
  [/\.(zip|rar|7z|tar|gz)$/i, 'Archive', FileArchive],
  [/\.(xlsx?|csv|ods|numbers)$/i, 'Spreadsheet', FileSpreadsheet],
  [/\.(pptx?|odp|key)$/i, 'Presentation', Presentation],
  [/\.(docx?|odt|rtf|txt|md|pages)$/i, 'Document', FileText],
  [/\.(js|ts|py|java|c|cpp|cs|html|css|json|xml|ipynb|m|r)$/i, 'Code', FileCode],
];

const fileKind = (name: string) => FILE_KINDS.find(([re]) => re.test(name)) ?? [null, (/\.([^.]+)$/.exec(name)?.[1] ?? 'File').toUpperCase(), FileIcon] as const;

function fileSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A file in the folder that goodink did not make: it opens with its usual app (PDFs in goodink). */
function FileCard({ file, picked, onOpen, onMenu }: { file: FileItem; picked: boolean; onOpen: (e: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const [, label, Icon] = fileKind(file.name);
  const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toUpperCase() ?? '';
  return (
    <div
      className={`card file-card ${picked ? 'is-picked' : ''}`}
      draggable
      onDragStart={(e) => dragStart(e, FILE_ID + file.rel)}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = menuPoint(e);
        onMenu(at.x, at.y);
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') openDialog({ type: 'rename', kind: 'file', id: file.rel });
        if (e.key === 'Delete') trashItems([FILE_ID + file.rel]);
      }}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${file.name}`}>
        <div className="cover-wrap">
          <div className="file-tile" data-kind={label}>
            <Icon size={34} strokeWidth={1.5} />
            {ext && <span className="file-ext">{ext}</span>}
          </div>
        </div>
      </button>
      <div className="card-meta">
        <div className="card-title" title={file.name}>
          {file.name}
        </div>
        <div className="card-sub">
          <span>{label} · {fileSize(file.size)} · {formatDate(file.modified)}</span>
          <IconButton label="More" className="card-more" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(r.left, r.bottom + 4);
          }}>
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function LinkCard({ link, picked, onOpen, onMenu }: { link: LinkItem; picked: boolean; onOpen: (e: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const vid = link.kind === 'youtube' ? youtubeId(link.url) : null;
  return (
    <div
      className={`card link-card ${picked ? 'is-picked' : ''}`}
      draggable
      onDragStart={(e) => dragStart(e, link.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = menuPoint(e);
        onMenu(at.x, at.y);
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') openDialog({ type: 'rename', kind: 'link', id: link.id });
        if (e.key === 'Delete') trashItems([link.id]);
      }}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${link.title}`}>
        <div className="cover-wrap">
          <div className={`link-tile ${vid ? 'is-video' : ''}`}>
            {vid ? (
              <>
                <img src={`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`} alt="" loading="lazy" />
                <span className="link-play" aria-hidden>
                  <Play size={22} fill="currentColor" />
                </span>
              </>
            ) : (
              <>
                <Globe size={30} />
                <span className="link-domain">{domainOf(link.url)}</span>
              </>
            )}
          </div>
        </div>
      </button>
      <div className="card-meta">
        <div className="card-title" title={link.title}>
          {link.favorite && <Star size={13} className="fav" fill="currentColor" />}
          {link.title}
        </div>
        <div className="card-sub">
          <span>{link.kind === 'youtube' ? `Video${link.author ? ` · ${link.author}` : ''}` : `Web page · ${domainOf(link.url)}`}</span>
          <IconButton label="More" className="card-more" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(r.left, r.bottom + 4);
          }}>
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function NotebookCard({ nb, picked, onOpen, onMenu }: { nb: NotebookMeta; picked: boolean; onOpen: (e: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const thumb = nb.thumbVersion ? api.thumbUrl(nb.id, nb.thumbVersion) : undefined;
  const ratio = nb.firstPage.w / nb.firstPage.h;
  return (
    <div
      className={`card nb-card ${picked ? 'is-picked' : ''}`}
      draggable
      onDragStart={(e) => dragStart(e, nb.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = menuPoint(e);
        onMenu(at.x, at.y);
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') openDialog({ type: 'rename', kind: 'notebook', id: nb.id });
        if (e.key === 'Delete') trashItems([nb.id]);
      }}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${nb.title}`}>
        <div className="cover-wrap">
          <CoverArt cover={nb.cover} title={nb.title} thumb={thumb} ratio={Math.max(0.6, Math.min(1.5, ratio))} kind={nb.kind} />
          {nb.lock && (
            <span className="cover-lock" aria-label="Locked">
              <Lock size={14} />
            </span>
          )}
        </div>
      </button>
      <div className="card-meta">
        <div className="card-title" title={nb.title}>
          {nb.favorite && <Star size={13} className="fav" fill="currentColor" />}
          {nb.title}
        </div>
        <div className="card-sub">
          <span>
            {formatDate(nb.updatedAt)} · {nb.pageCount} page{nb.pageCount === 1 ? '' : 's'}
          </span>
          <IconButton label="More" className="card-more" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(r.left, r.bottom + 4);
          }}>
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
