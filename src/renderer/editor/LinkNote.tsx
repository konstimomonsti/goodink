// "Link to…": pick the note a selection links to, a whole notebook or one of its pages (like linking
// notes in Obsidian or Goodnotes). Notebooks are searched by title; pages are read from the notebook.
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, FileText, Search } from 'lucide-react';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import { Button, Modal } from '../ui/primitives';

export function LinkNoteDialog({ fromNb, onPick, onClose }: { fromNb: string; onPick: (nb: string, page?: string) => void; onClose: () => void }) {
  const notebooks = useApp((s) => s.library.notebooks);
  const [q, setQ] = useState('');
  const [nb, setNb] = useState<string | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [page, setPage] = useState<string | undefined>();

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return notebooks
      .filter((n) => !n.deletedAt && (n.kind ?? 'notebook') !== 'flashcards' && (!k || n.title.toLowerCase().includes(k)))
      .sort((a, b) => Number(b.id === fromNb) - Number(a.id === fromNb) || b.openedAt - a.openedAt)
      .slice(0, 60);
  }, [notebooks, q, fromNb]);

  // the chosen notebook's pages, to link one of them
  useEffect(() => {
    setPages(null);
    setPage(undefined);
    if (!nb) return;
    let on = true;
    void api.loadNotebook(nb).then((d) => on && setPages(d?.pages.map((p) => p.id) ?? []));
    return () => {
      on = false;
    };
  }, [nb]);

  const title = notebooks.find((n) => n.id === nb)?.title;
  return (
    <Modal
      title="Link to a note"
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!nb} onClick={() => nb && onPick(nb, page)}>
            Link
          </Button>
        </>
      }
    >
      <div className="link-note">
        <label className="lib-search link-note-search">
          <Search size={15} />
          <input placeholder="Find a notebook" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a notebook" />
        </label>
        <ul className="link-note-list" role="listbox" aria-label="Notebooks">
          {list.map((n) => (
            <li key={n.id}>
              <button type="button" role="option" aria-selected={nb === n.id} className={nb === n.id ? 'is-on' : ''} onClick={() => setNb(n.id)}>
                <BookOpen size={15} />
                <span className="link-note-title">{n.title}</span>
                {n.id === fromNb && <span className="link-note-tag">this notebook</span>}
                <span className="link-note-meta">{n.pageCount} {n.pageCount === 1 ? 'page' : 'pages'}</span>
              </button>
            </li>
          ))}
          {!list.length && <li className="muted small pad">No notebook with that name.</li>}
        </ul>
        {nb && (
          <div className="link-note-pages">
            <span className="field-label">Where in {title}</span>
            <div className="link-note-chips">
              <button type="button" className={!page ? 'is-on' : ''} onClick={() => setPage(undefined)}>
                <BookOpen size={13} /> Whole notebook
              </button>
              {(pages ?? []).map((id, i) => (
                <button key={id} type="button" className={page === id ? 'is-on' : ''} onClick={() => setPage(id)}>
                  <FileText size={13} /> Page {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
