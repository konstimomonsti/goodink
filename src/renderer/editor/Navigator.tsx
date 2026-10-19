import { useEffect, useRef, useState } from 'react';
import { Bookmark, Plus, Copy, Trash2, RotateCw, LayoutTemplate, FileImage, ArrowUpToLine, ArrowDownToLine, ArrowUp, ArrowDown, ListTree, X, Link2, CornerDownLeft } from 'lucide-react';
import type { NotebookSession } from '../engine/session';
import type { PageMeta } from '../../shared/types';
import { displaySize, renderPageToCanvas } from '../engine/render';
import { Menu, Segmented, IconButton, menuPoint, type MenuItem } from '../ui/primitives';
import { addPage, deletePages, duplicatePages, movePages, rotatePages, toggleBookmark } from './pageOps';
import { backlinksTo, jumpToNote, openDialog, setPageLinks, useApp } from '../lib/store';
import { uid } from '../lib/util';
import { whenIdle } from '../lib/idle';

const thumbCache = new Map<string, string>();
const THUMB_W = 150;

function thumbKey(s: NotebookSession, p: PageMeta) {
  return `${s.id}|${p.id}|${s.version(p.id)}|${p.template.kind}|${p.template.paper}|${p.rotation}`;
}

async function makeThumb(s: NotebookSession, p: PageMeta): Promise<string> {
  const key = thumbKey(s, p);
  const have = thumbCache.get(key);
  if (have) return have;
  const c = await s.ensure(p.id);
  const canvas = await renderPageToCanvas(p, c, THUMB_W * Math.min(2, window.devicePixelRatio || 1), s);
  const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
  thumbCache.set(key, url);
  if (thumbCache.size > 600) {
    const [k, v] = thumbCache.entries().next().value as [string, string];
    thumbCache.delete(k);
    URL.revokeObjectURL(v);
  }
  return url;
}

function Thumb({ s, page, index, current, picked, touchDrop, dragging, onClick, onMenu, onDrop }: { s: NotebookSession; page: PageMeta; index: number; current: boolean; picked: boolean; touchDrop: 'before' | 'after' | null; dragging: boolean; onClick: (e: React.MouseEvent) => void; onMenu: (e: React.MouseEvent) => void; onDrop: (from: number[], to: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const [ver, setVer] = useState(0);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '400px' });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);
  useEffect(
    () =>
      s.on((e) => {
        if ((e.type === 'page' && e.pageId === page.id) || e.type === 'doc') setVer((v) => v + 1);
      }),
    [s, page.id],
  );
  useEffect(() => {
    if (!visible) return;
    let live = true;
    const cancel = whenIdle(() => void makeThumb(s, page).then((u) => live && setUrl(u)), ver ? 900 : 0);
    return () => {
      live = false;
      cancel();
    };
  }, [visible, s, page, ver]);
  const d = displaySize(page);
  return (
    <div
      ref={ref}
      className={`thumb ${current ? 'is-current' : ''} ${picked ? 'is-picked' : ''} ${dragging ? 'is-dragging' : ''} ${(drop ?? touchDrop) ? `drop-${drop ?? touchDrop}` : ''}`}
      data-index={index}
      draggable
      // a finger uses the hold-and-drag in Navigator; the browser's own touch drag would cancel it
      onPointerDown={(e) => {
        if (ref.current) ref.current.draggable = e.pointerType !== 'touch';
      }}
      onDragStart={(e) => e.dataTransfer.setData('application/x-goodink-page', String(index))}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-goodink-page')) return;
        e.preventDefault();
        const r = ref.current!.getBoundingClientRect();
        setDrop(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        const from = +e.dataTransfer.getData('application/x-goodink-page');
        onDrop([from], drop === 'after' ? index + 1 : index);
        setDrop(null);
      }}
    >
      <button className="thumb-hit" onClick={onClick} onContextMenu={onMenu} aria-label={`Page ${index + 1}`} aria-current={current}>
        <div className="thumb-img" style={{ aspectRatio: `${d.w} / ${d.h}` }}>
          {/* only thumbnails in view are decoded; scrolled-away ones give their memory back */}
          {url && visible ? <img src={url} alt="" draggable={false} decoding="async" /> : <div className="thumb-skeleton" />}
          {page.bookmarked && <Bookmark className="thumb-bm" size={16} fill="currentColor" />}
        </div>
        <span className="thumb-no">{index + 1}</span>
      </button>
    </div>
  );
}

export function Navigator({ s, current, onGo }: { s: NotebookSession; current: number; onGo: (i: number) => void }) {
  const [tab, setTab] = useState<'pages' | 'bookmarks' | 'outline' | 'links'>('pages');
  const [, force] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // keyboard range selection starts here (Shift+arrows)
  const anchor = useRef<number | null>(null);
  // touch: hold a thumbnail, then drag it (HTML drag and drop only works with a mouse or pen)
  const [touchDrag, setTouchDrag] = useState<{ from: number; to: number | null; where: 'before' | 'after' } | null>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; id: number; from: number } | null>(null);
  const dragRef = useRef(touchDrag);
  dragRef.current = touchDrag;
  const swallowMenu = useRef(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // while a thumbnail is being dragged the list must not scroll under the finger
    const stop = (e: TouchEvent) => dragRef.current && e.preventDefault();
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, [tab]);
  useEffect(() => s.on((e) => (e.type === 'pages' || e.type === 'doc') && force((n) => n + 1)), [s]);
  useEffect(() => {
    const el = listRef.current?.querySelector('.thumb.is-current');
    el?.scrollIntoView({ block: 'nearest' });
  }, [current, tab]);

  const move = (sel: number[], to: number) => {
    movePages(s, sel, to);
    setPicked([]);
  };

  const pageMenu = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (performance.now() - swallowMenu.current < 800) return; // the long-press that started a touch drag
    const at = menuPoint(e);
    const sel = picked.includes(i) && picked.length > 1 ? picked : [i];
    const n = sel.length;
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        { label: 'Move up', icon: <ArrowUp size={15} />, shortcut: 'Alt+↑', disabled: Math.min(...sel) === 0, run: () => move(sel, Math.min(...sel) - 1) },
        { label: 'Move down', icon: <ArrowDown size={15} />, shortcut: 'Alt+↓', disabled: Math.max(...sel) >= s.pages.length - 1, run: () => move(sel, Math.max(...sel) + 2) },
        { separator: true, label: '' },
        { label: 'Add page before', icon: <ArrowUpToLine size={15} />, run: () => onGo(addPage(s, i, 'before')) },
        { label: 'Add page after', icon: <ArrowDownToLine size={15} />, run: () => onGo(addPage(s, i, 'after')) },
        { label: n > 1 ? `Duplicate ${n} pages` : 'Duplicate', icon: <Copy size={15} />, run: () => void duplicatePages(s, sel).then(onGo) },
        { separator: true, label: '' },
        { label: s.pages[i].bookmarked ? 'Remove bookmark' : 'Bookmark', icon: <Bookmark size={15} />, run: () => toggleBookmark(s, i) },
        { label: 'Add to outline', icon: <ListTree size={15} />, run: () => s.patchDoc({ outline: [...s.doc.outline, { id: uid(), title: `Page ${i + 1}`, pageId: s.pages[i].id }] }) },
        { label: 'Page layout & template…', icon: <LayoutTemplate size={15} />, run: () => openDialog({ type: 'template', nbId: s.id, scope: 'page' }) },
        { label: n > 1 ? `Rotate ${n} pages` : 'Rotate', icon: <RotateCw size={15} />, run: () => rotatePages(s, sel) },
        { label: 'Export page…', icon: <FileImage size={15} />, run: () => openDialog({ type: 'export', nbId: s.id, pageIndex: i }) },
        { separator: true, label: '' },
        { label: n > 1 ? `Delete ${n} pages` : 'Delete page', icon: <Trash2 size={15} />, danger: true, disabled: s.pages.length <= n, run: () => deletePages(s, sel) && setPicked([]) },
      ],
    });
  };

  const bookmarks = s.pages.map((p, i) => ({ p, i })).filter((x) => x.p.bookmarked);

  return (
    <aside className="navigator" aria-label="Pages">
      <div className="nav-tabs">
        <Segmented
          label="Navigator view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pages', label: 'Pages' },
            { value: 'bookmarks', label: 'Marks' },
            { value: 'outline', label: 'Outline' },
            { value: 'links', label: 'Links' },
          ]}
        />
      </div>
      {tab === 'pages' && (
        <div
          className="nav-list"
          ref={listRef}
          tabIndex={0}
          aria-label="Pages. Arrows go to a page; Shift+arrows or Space select pages; Alt+arrows move the selected pages; Ctrl+A selects all; Delete deletes."
          onPointerDown={(e) => {
            if (e.pointerType !== 'touch') return;
            const th = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
            if (!th) return;
            const from = +th.dataset.index!;
            const id = e.pointerId;
            hold.current = {
              x: e.clientX,
              y: e.clientY,
              id,
              from,
              timer: setTimeout(() => {
                swallowMenu.current = performance.now();
                navigator.vibrate?.(15);
                setTouchDrag({ from, to: null, where: 'before' });
              }, 380),
            };
          }}
          onPointerMove={(e) => {
            const h = hold.current;
            if (!h || e.pointerId !== h.id) return;
            if (!dragRef.current) {
              if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) {
                clearTimeout(h.timer);
                hold.current = null; // it was a scroll
              }
              return;
            }
            const list = listRef.current!.getBoundingClientRect();
            if (e.clientY < list.top + 40) listRef.current!.scrollBy(0, -12);
            else if (e.clientY > list.bottom - 40) listRef.current!.scrollBy(0, 12);
            const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.thumb');
            if (!over) return;
            const r = over.getBoundingClientRect();
            setTouchDrag({ from: h.from, to: +over.dataset.index!, where: e.clientY < r.top + r.height / 2 ? 'before' : 'after' });
          }}
          onPointerUp={(e) => {
            const h = hold.current;
            if (!h || e.pointerId !== h.id) return;
            clearTimeout(h.timer);
            hold.current = null;
            const d = dragRef.current;
            setTouchDrag(null);
            if (d && d.to !== null && d.to !== d.from) {
              const sel = picked.length > 1 && picked.includes(d.from) ? picked : [d.from];
              move(sel, d.where === 'after' ? d.to + 1 : d.to);
            }
          }}
          onPointerCancel={() => {
            if (hold.current) clearTimeout(hold.current.timer);
            hold.current = null;
            setTouchDrag(null);
          }}
          onKeyDown={(e) => {
            const n = s.pages.length;
            const range = (x: number, y: number) => Array.from({ length: Math.abs(y - x) + 1 }, (_, k) => Math.min(x, y) + k);
            const extendTo = (to: number) => {
              anchor.current ??= current;
              setPicked(range(anchor.current, to));
              onGo(to);
            };
            const block = (picked.length ? [...picked] : [current]).sort((x, y) => x - y);
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              // move the selected pages (or the current one) together
              const up = e.key === 'ArrowUp';
              const lo = block[0], hi = block[block.length - 1];
              if (up ? lo === 0 : hi === n - 1) return e.preventDefault();
              movePages(s, block, up ? lo - 1 : hi + 2);
              const start = up ? lo - 1 : hi + 2 - block.length;
              const moved = block.map((_, k) => start + k);
              if (picked.length) setPicked(moved);
              anchor.current = picked.length ? moved[0] : null;
              onGo(up ? moved[0] : moved[moved.length - 1]);
            } else if (e.shiftKey && e.key === 'ArrowDown') extendTo(Math.min(n - 1, current + 1));
            else if (e.shiftKey && e.key === 'ArrowUp') extendTo(Math.max(0, current - 1));
            else if (e.shiftKey && e.key === 'Home') extendTo(0);
            else if (e.shiftKey && e.key === 'End') extendTo(n - 1);
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
              anchor.current = null;
              onGo(e.key === 'ArrowDown' ? Math.min(n - 1, current + 1) : e.key === 'ArrowUp' ? Math.max(0, current - 1) : e.key === 'Home' ? 0 : n - 1);
            } else if (e.key === ' ') {
              // Space adds the current page to the selection or takes it out
              anchor.current = current;
              setPicked(picked.includes(current) ? picked.filter((x) => x !== current) : [...picked, current].sort((x, y) => x - y));
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
              setPicked(range(0, n - 1));
            } else if (e.key === 'Escape' && picked.length) {
              anchor.current = null;
              setPicked([]);
            } else if (e.key === 'Delete') deletePages(s, picked.length ? picked : [current]) && setPicked([]);
            else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              const el = listRef.current?.querySelector<HTMLElement>('.thumb.is-current .thumb-hit');
              if (!el) return;
              const r = el.getBoundingClientRect();
              pageMenu(current, { preventDefault() {}, clientX: r.left + 20, clientY: r.top + 30, currentTarget: el } as unknown as React.MouseEvent);
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <span className="sr-only" aria-live="polite">{picked.length > 1 ? `${picked.length} pages selected` : ''}</span>
          {s.pages.map((p, i) => (
            <Thumb
              key={p.id}
              s={s}
              page={p}
              index={i}
              current={i === current}
              picked={picked.includes(i)}
              dragging={touchDrag?.from === i}
              touchDrop={touchDrag && touchDrag.to === i && touchDrag.to !== touchDrag.from ? touchDrag.where : null}
              onClick={(e) => {
                if (e.ctrlKey) setPicked(picked.includes(i) ? picked.filter((x) => x !== i) : [...picked, i]);
                else if (e.shiftKey) {
                  const a = Math.min(current, i), b = Math.max(current, i);
                  setPicked(Array.from({ length: b - a + 1 }, (_, k) => a + k));
                } else {
                  setPicked([]);
                  onGo(i);
                }
              }}
              onMenu={(e) => pageMenu(i, e)}
              onDrop={(from, to) => movePages(s, picked.length > 1 && picked.includes(from[0]) ? picked : from, to)}
            />
          ))}
          <button className="nav-add" onClick={() => onGo(addPage(s, s.pages.length - 1, 'end'))}>
            <Plus size={18} /> Add page
          </button>
        </div>
      )}
      {tab === 'links' && <LinksTab s={s} current={current} onGo={onGo} />}
      {tab === 'bookmarks' && (
        <div className="nav-text">
          {bookmarks.length === 0 && <p className="muted small pad">Bookmark a page with Ctrl+B or the ribbon in the toolbar. Bookmarked pages are listed here.</p>}
          {bookmarks.map(({ i }) => (
            <button key={i} className={`nav-row ${i === current ? 'is-on' : ''}`} onClick={() => onGo(i)}>
              <Bookmark size={14} fill="currentColor" /> Page {i + 1}
            </button>
          ))}
        </div>
      )}
      {tab === 'outline' && (
        <div className="nav-text">
          {s.doc.outline.length === 0 && <p className="muted small pad">No outline yet. Add the current page to build your own table of contents.</p>}
          {s.doc.outline.map((o) => {
            const i = s.pageIndex(o.pageId);
            if (i < 0) return null;
            return (
              <div key={o.id} className={`nav-row outline-row ${i === current ? 'is-on' : ''}`}>
                {editing === o.id ? (
                  <input
                    className="input outline-input"
                    autoFocus
                    defaultValue={o.title}
                    onBlur={(e) => {
                      const t = e.currentTarget.value.trim();
                      if (t) s.patchDoc({ outline: s.doc.outline.map((x) => (x.id === o.id ? { ...x, title: t } : x)) });
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                    }}
                  />
                ) : (
                <button className="outline-go" onClick={() => onGo(i)} onDoubleClick={() => setEditing(o.id)} title="Double-click to rename">
                  <span className="ellipsis" style={{ whiteSpace: 'pre' }}>{o.title}</span>
                  <span className="muted small">{i + 1}</span>
                </button>
                )}
                <IconButton label="Remove from outline" onClick={() => s.patchDoc({ outline: s.doc.outline.filter((x) => x.id !== o.id) })}>
                  <X size={13} />
                </IconButton>
              </div>
            );
          })}
          <button className="nav-add" onClick={() => s.patchDoc({ outline: [...s.doc.outline, { id: uid(), title: `Page ${current + 1}`, pageId: s.pages[current].id }] })}>
            <Plus size={16} /> Add this page
          </button>
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/**
 * Links of the page you are on: what it links to (open or remove), and every page in the library
 * that links here ("Linked from", like Obsidian's backlinks).
 */
function LinksTab({ s, current, onGo }: { s: NotebookSession; current: number; onGo: (index: number) => void }) {
  const notebooks = useApp((st) => st.library.notebooks);
  useApp((st) => st.library.noteLinks); // re-render when links change
  const page = s.pages[Math.min(current, s.pages.length - 1)];
  const titleOf = (nb: string) => notebooks.find((n) => n.id === nb)?.title ?? 'A deleted note';
  const go = (nb: string, pageId?: string) => {
    if (nb === s.id && pageId) {
      const i = s.pageIndex(pageId);
      if (i >= 0) return onGo(i);
    }
    void jumpToNote(nb, pageId);
  };
  const out = page?.links ?? [];
  const where = (nb: string, pageId?: string) => (nb === s.id ? (pageId ? `Page ${s.pageIndex(pageId) + 1}` : 'This notebook') : `${titleOf(nb)}${pageId ? ' · a page' : ''}`);
  const remove = (id: string) => {
    const pages = s.pages.map((p) => (p.id === page.id ? { ...p, links: (p.links ?? []).filter((l) => l.id !== id) } : p));
    s.setPages(pages);
    setPageLinks(s.id, page.id, 'area', (pages.find((p) => p.id === page.id)?.links ?? []).map((l) => ({ nb: l.nb, page: l.page })));
  };
  const back = page ? backlinksTo(s.id, page.id) : [];
  return (
    <div className="nav-text">
      <p className="nav-section-label">On this page</p>
      {!out.length && <p className="muted small pad">Select something with the lasso and choose Link, or type [[Notebook name]] or [[#3]] (page 3) in a text box.</p>}
      {out.map((l) => (
        <div key={l.id} className="nav-row link-row">
          <button type="button" className="link-row-go" onClick={() => go(l.nb, l.page)}>
            <Link2 size={14} /> {where(l.nb, l.page)}
          </button>
          <IconButton label="Remove link" onClick={() => remove(l.id)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <p className="nav-section-label">Linked from</p>
      {!back.length && <p className="muted small pad">No page links here yet.</p>}
      {back.map((r, k) => (
        <button key={k} type="button" className="nav-row" onClick={() => go(r.fromNb, r.fromPage)}>
          <CornerDownLeft size={14} /> {r.fromNb === s.id ? `Page ${s.pageIndex(r.fromPage) + 1}` : titleOf(r.fromNb)}
        </button>
      ))}
    </div>
  );
}
