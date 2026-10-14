// Anki's Add window, in goodink's design: note type and deck choosers, Fields… and Cards… (the note
// type's fields, card templates and styling with a live preview), the note editor, tags, and
// Add / History / Close / Help, with Anki's shortcuts. Also the note editing used by Browse and Review.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, History, CircleHelp, ChevronDown, ArrowUp, ArrowDown, Pencil, Trash2, Copy, Eye, LayoutTemplate, ListTree, Settings2, BookOpen } from 'lucide-react';
import { Button, IconButton, Menu, Modal, Field, type MenuItem } from '../ui/primitives';
import { toast, confirmDialog, openNotebook } from '../lib/store';
import { uid } from '../lib/util';
import {
  useStudy, addNote, updateNote, setNoteDeck, setAddPrefs, duplicatesOf, saveNoteType, deleteNoteType, createDeck, deckTree, changeNoteType, cardName, noteOf, typeOf,
  type Deck, type Note, type NoteType, type StudyCard,
} from './model';
import { STOCK_TYPES, DEFAULT_CSS, cardOrdinals, htmlToText, renderSide, type TemplateDef } from './notetypes';
import { NoteEditor, TagEditor, type NoteEditorHandle } from './NoteEditor';
import { CardHtml } from './CardHtml';

const isEmptyHtml = (h: string) => !htmlToText(h).trim() && !/<(img|audio)\b/i.test(h);

/** Map fields to a new type by name, then by position (like Anki when the type changes in Add). */
function carryFields(from: NoteType, to: NoteType, values: string[]) {
  return to.fields.map((f, i) => {
    const j = from.fields.findIndex((g) => g.name.toLowerCase() === f.name.toLowerCase());
    return values[j >= 0 ? j : i] ?? '';
  });
}

function useAllTags() {
  const notes = useStudy((s) => s.data.notes);
  return useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].sort((a, b) => a.localeCompare(b)), [notes]);
}

// ---- Add ----------------------------------------------------------------------------------------

export function AddWindow({ initialDeck, onClose, onBrowse }: { initialDeck?: string; onClose: () => void; onBrowse: (query: string) => void }) {
  const data = useStudy((s) => s.data);
  const { noteTypes, decks, prefs } = data;
  const type = noteTypes.find((t) => t.id === prefs.typeId) ?? noteTypes[0];
  const deckOf = (t: NoteType) => [initialDeck, prefs.deckByType[t.id], prefs.deckId].find((id) => id && decks.some((d) => d.id === id)) ?? decks[0].id;
  const [deckId, setDeckId] = useState(() => deckOf(type));
  const [fields, setFields] = useState<string[]>(() => type.fields.map((_, i) => prefs.sticky[type.id]?.[i] ?? ''));
  const [tags, setTags] = useState<string[]>([]);
  const sticky = useMemo(() => Object.fromEntries(type.fields.map((f, i) => [i, !!f.sticky])), [type]);
  const [dlg, setDlg] = useState<null | 'type' | 'deck' | 'fields' | 'cards' | 'help' | 'preview' | 'types'>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const editor = useRef<NoteEditorHandle>(null);
  const tagInput = useRef<HTMLInputElement>(null);
  const allTags = useAllTags();
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];
  const dups = useMemo(() => duplicatesOf(type.id, fields[0] ?? '', undefined, data), [type.id, fields, data]);

  // a type changed elsewhere (Fields…): keep the values in step with its fields
  const lastType = useRef(type);
  useEffect(() => {
    if (lastType.current === type) return;
    const prev = lastType.current;
    lastType.current = type;
    setFields((v) => (prev.id === type.id && prev.fields.length !== type.fields.length ? carryFields(prev, type, v) : v.length === type.fields.length ? v : carryFields(prev, type, v)));
  }, [type]);

  useEffect(() => {
    editor.current?.focusField(0);
  }, []);

  const setField = useCallback((i: number, html: string) => setFields((v) => v.map((x, j) => (j === i ? html : x))), []);

  const chooseType = (t: NoteType) => {
    setFields((v) => carryFields(type, t, v));
    lastType.current = t;
    setAddPrefs({ typeId: t.id }); // the deck stays, like Anki's default
    setDlg(null);
    requestAnimationFrame(() => editor.current?.focusField(0));
  };
  const chooseDeck = (id: string) => {
    setDeckId(id);
    setDlg(null);
    requestAnimationFrame(() => editor.current?.focusField(0));
  };
  const toggleSticky = (i: number) => saveNoteType({ ...type, fields: type.fields.map((f, j) => (j === i ? { ...f, sticky: !f.sticky } : f)) });

  const add = () => {
    if (fields.every(isEmptyHtml)) return toast('The note is empty. Type something into its fields first.', { kind: 'error' });
    const probe: Note = { id: '', typeId: type.id, fields, tags, created: 0, modified: 0 };
    if (!cardOrdinals(type, probe).length) {
      return toast(
        type.kind === 'cloze'
          ? 'There are no cloze deletions yet. Select a word and press Ctrl+Shift+C (or the [ ] button) to hide it.'
          : `No card would be made: “${type.templates.map((t) => t.name).join('”, “')}” would show an empty question. Fill in the field its front shows.`,
        { kind: 'error', ms: 6000 },
      );
    }
    const made = addNote({ typeId: type.id, deckId, fields, tags });
    const keep: Record<number, string> = {};
    type.fields.forEach((f, i) => f.sticky && (keep[i] = fields[i]));
    setAddPrefs({ typeId: type.id, deckId, deckByType: { ...useStudy.getState().data.prefs.deckByType, [type.id]: deckId }, sticky: { ...useStudy.getState().data.prefs.sticky, [type.id]: keep } });
    setFields(type.fields.map((f, i) => (f.sticky ? fields[i] : '')));
    toast(`Added ${made.length} card${made.length === 1 ? '' : 's'} to ${deck.name}`, { kind: 'success' });
    requestAnimationFrame(() => editor.current?.focusField(type.fields.findIndex((f) => !f.sticky) === -1 ? 0 : type.fields.findIndex((f) => !f.sticky)));
  };

  const close = () => {
    const typed = type.fields.some((f, i) => !f.sticky && !isEmptyHtml(fields[i] ?? ''));
    if (typed) confirmDialog('Discard the current note?', 'What you typed is not added.', 'Discard', onClose);
    else onClose();
  };

  const history = (e: { currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const notes = prefs.history.map((id) => data.notes.find((n) => n.id === id)).filter(Boolean) as Note[];
    setMenu({
      x: r.left,
      y: r.top - 8 - Math.min(10, Math.max(1, notes.length)) * 36,
      items: notes.length
        ? notes.slice(0, 10).map((n) => ({ label: `${typeOf(n, data).name}: ${htmlToText(n.fields.find((f) => !isEmptyHtml(f)) ?? '').replace(/\s+/g, ' ').slice(0, 48) || '(picture or sound)'}`, run: () => onBrowse(`nid:${n.id}`) }))
        : [{ label: 'Nothing added yet', disabled: true }],
    });
  };

  // Anki's Add window shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dlg || document.querySelector('.modal, .menu, .popover')) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      let run: (() => void) | undefined;
      if (ctrl && e.key === 'Enter') run = add;
      else if (ctrl && !e.shiftKey && k === 'n') run = () => setDlg('type');
      else if (ctrl && !e.shiftKey && k === 'd') run = () => setDlg('deck');
      else if (ctrl && e.shiftKey && k === 'f') run = () => setDlg('fields');
      else if (ctrl && !e.shiftKey && k === 'l') run = () => setDlg('cards');
      else if (ctrl && e.shiftKey && k === 't') run = () => tagInput.current?.focus();
      else if (ctrl && e.shiftKey && k === 'p') run = () => setDlg('preview');
      else if (ctrl && e.shiftKey && k === 'h') run = () => history({ currentTarget: document.querySelector('.add-history') ?? document.body });
      else if (e.key === 'F1') run = () => setDlg('help');
      else if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('.ne-tags')) run = close;
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    // capture: before goodink's own Ctrl+N (new notebook) and friends
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="add-win">
      <div className="add-head">
        <div className="add-pick">
          <span className="add-pick-label" id="add-type-label">Type</span>
          <button type="button" className="add-chooser" aria-labelledby="add-type-label" aria-haspopup="dialog" title="Choose note type (Ctrl+N)" onClick={() => setDlg('type')}>
            <span className="ellipsis">{type.name}</span>
            <ChevronDown size={14} />
          </button>
        </div>
        <div className="add-pick">
          <span className="add-pick-label" id="add-deck-label">Deck</span>
          <button type="button" className="add-chooser" aria-labelledby="add-deck-label" aria-haspopup="dialog" title="Choose deck (Ctrl+D)" onClick={() => setDlg('deck')}>
            <span className="ellipsis">{deck.name}</span>
            <ChevronDown size={14} />
          </button>
        </div>
        <span className="add-spacer" />
        <Button variant="ghost" size="sm" onClick={() => setDlg('fields')} title="Fields of this note type (Ctrl+Shift+F)"><ListTree size={15} /> Fields…</Button>
        <Button variant="ghost" size="sm" onClick={() => setDlg('cards')} title="Card templates and styling (Ctrl+L)"><LayoutTemplate size={15} /> Cards…</Button>
        <Button variant="ghost" size="sm" onClick={() => setDlg('preview')} title="Preview the cards (Ctrl+Shift+P)"><Eye size={15} /> Preview</Button>
        <IconButton label="Manage note types" onClick={() => setDlg('types')}><Settings2 size={16} /></IconButton>
      </div>

      <div className="add-body">
        <NoteEditor
          ref={editor}
          type={type}
          fields={fields}
          onField={setField}
          sticky={sticky}
          onSticky={toggleSticky}
          duplicate={dups.length ? (
            <div className="ne-dup" role="status">
              This note is a duplicate.
              <button type="button" className="link-btn" onClick={() => onBrowse(`nid:${dups.map((n) => n.id).join(',')}`)}>Show duplicates</button>
            </div>
          ) : undefined}
        />
        <TagEditor ref={tagInput} tags={tags} all={allTags} onChange={setTags} />
      </div>

      <footer className="add-foot">
        <Button variant="ghost" onClick={() => setDlg('help')} title="Help (F1)"><CircleHelp size={15} /> Help</Button>
        <span className="add-spacer" />
        <Button variant="ghost" onClick={close} title="Close (Esc)">Close</Button>
        <Button variant="ghost" className="add-history" onClick={history} title="Notes added recently (Ctrl+Shift+H)"><History size={15} /> History <ChevronDown size={13} /></Button>
        <Button variant="primary" onClick={add} title="Add (Ctrl+Enter)"><Plus size={16} /> Add <kbd>Ctrl+Enter</kbd></Button>
      </footer>

      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {dlg === 'type' && <ChooseTypeDialog current={type.id} onChoose={chooseType} onManage={() => setDlg('types')} onClose={() => setDlg(null)} />}
      {dlg === 'deck' && <ChooseDeckDialog current={deckId} onChoose={chooseDeck} onClose={() => setDlg(null)} />}
      {dlg === 'fields' && <FieldsDialog type={type} onClose={() => setDlg(null)} />}
      {dlg === 'cards' && <CardsDialog type={type} sample={fields} onClose={() => setDlg(null)} />}
      {dlg === 'preview' && <PreviewDialog type={type} fields={fields} tags={tags} deck={deck} onClose={() => setDlg(null)} />}
      {dlg === 'types' && <NoteTypesDialog onClose={() => setDlg(null)} />}
      {dlg === 'help' && <HelpDialog onClose={() => setDlg(null)} />}
    </div>
  );
}

// ---- choosers -----------------------------------------------------------------------------------

/** A filterable list: type to narrow, arrows to move, Enter to choose (Anki's chooser windows). */
function FilterList<T>({ items, label, text, current, onChoose, empty }: { items: T[]; label: string; text: (t: T) => string; current?: (t: T) => boolean; onChoose: (t: T) => void; empty?: string }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => items.filter((x) => text(x).toLowerCase().includes(q.trim().toLowerCase())), [items, q, text]);
  const [hi, setHi] = useState(() => Math.max(0, items.findIndex((x) => current?.(x))));
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => setHi((h) => (q ? 0 : Math.min(h, Math.max(0, shown.length - 1)))), [q, shown.length]);
  useEffect(() => {
    list.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi]);
  return (
    <div className="flist">
      <input
        className="input"
        data-autofocus
        aria-label={`Filter ${label}`}
        placeholder="Filter…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHi((h) => Math.min(shown.length - 1, h + 1));
          else if (e.key === 'ArrowUp') setHi((h) => Math.max(0, h - 1));
          else if (e.key === 'Enter' && shown.length) onChoose(shown[Math.min(hi, shown.length - 1)]);
          else return;
          e.preventDefault();
        }}
      />
      <ul ref={list} className="flist-items" role="listbox" aria-label={label}>
        {shown.map((x, i) => (
          <li key={i} role="option" aria-selected={i === hi} className={`${i === hi ? 'is-hi' : ''} ${current?.(x) ? 'is-cur' : ''}`} onClick={() => onChoose(x)} onMouseMove={() => setHi(i)}>
            {text(x)}
          </li>
        ))}
        {!shown.length && <li className="muted">{empty ?? 'Nothing matches.'}</li>}
      </ul>
    </div>
  );
}

function ChooseTypeDialog({ current, onChoose, onManage, onClose }: { current: string; onChoose: (t: NoteType) => void; onManage: () => void; onClose: () => void }) {
  const types = useStudy((s) => s.data.noteTypes);
  return (
    <Modal title="Choose note type" onClose={onClose} footer={<><Button variant="ghost" onClick={onManage}>Manage…</Button><Button onClick={onClose}>Cancel</Button></>}>
      <FilterList items={types} label="Note types" text={(t) => t.name} current={(t) => t.id === current} onChoose={onChoose} />
    </Modal>
  );
}

export function ChooseDeckDialog({ current, onChoose, onClose, title = 'Choose deck' }: { current: string; onChoose: (id: string) => void; onClose: () => void; title?: string }) {
  const decks = useStudy((s) => s.data.decks);
  const tree = useMemo(() => deckTree(decks), [decks]);
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        adding === null ? (
          <>
            <Button variant="ghost" onClick={() => setAdding('')}><Plus size={15} /> Add deck</Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        ) : undefined
      }
    >
      {adding === null ? (
        <FilterList items={tree} label="Decks" text={(d: Deck) => d.name} current={(d) => d.id === current} onChoose={(d) => onChoose(d.id)} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.trim()) onChoose(createDeck(adding.trim()).id);
          }}
        >
          <Field label="New deck name" hint="Use Parent::Child to make a subdeck.">
            <input className="input" autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} />
          </Field>
          <div className="st-actions">
            <Button variant="ghost" onClick={() => setAdding(null)}>Back</Button>
            <Button variant="primary" type="submit" disabled={!adding.trim()}>Add and choose</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---- note types ---------------------------------------------------------------------------------

function NoteTypesDialog({ onClose }: { onClose: () => void }) {
  const types = useStudy((s) => s.data.noteTypes);
  const notes = useStudy((s) => s.data.notes);
  const [sel, setSel] = useState(types[0]?.id);
  const [sub, setSub] = useState<null | 'fields' | 'cards' | 'add' | 'rename'>(null);
  const [name, setName] = useState('');
  const [base, setBase] = useState('stock:nt-basic');
  const t = types.find((x) => x.id === sel) ?? types[0];
  const count = (id: string) => notes.filter((n) => n.typeId === id).length;
  if (sub === 'fields') return <FieldsDialog type={t} onClose={() => setSub(null)} />;
  if (sub === 'cards') return <CardsDialog type={t} onClose={() => setSub(null)} />;
  if (sub === 'add' || sub === 'rename') {
    const save = () => {
      const n = name.trim();
      if (!n) return;
      if (sub === 'rename') saveNoteType({ ...t, name: n });
      else {
        const [kind, id] = base.split(':');
        const from = (kind === 'stock' ? STOCK_TYPES : types).find((x) => x.id === id) ?? STOCK_TYPES[0];
        const made: NoteType = { ...structuredClone(from), id: `nt-${uid()}`, name: n };
        saveNoteType(made);
        setSel(made.id);
      }
      setSub(null);
    };
    return (
      <Modal title={sub === 'add' ? 'Add note type' : 'Rename note type'} onClose={() => setSub(null)} footer={<><Button variant="ghost" onClick={() => setSub(null)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={save}>{sub === 'add' ? 'Add' : 'Rename'}</Button></>}>
        {sub === 'add' && (
          <Field label="Start from">
            <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
              <optgroup label="Add">
                {STOCK_TYPES.map((x) => <option key={x.id} value={`stock:${x.id}`}>Add: {x.name}</option>)}
              </optgroup>
              <optgroup label="Clone">
                {types.map((x) => <option key={x.id} value={`clone:${x.id}`}>Clone: {x.name}</option>)}
              </optgroup>
            </select>
          </Field>
        )}
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </Field>
      </Modal>
    );
  }
  return (
    <Modal title="Note types" size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="nt-manage">
        <ul className="flist-items nt-list" role="listbox" aria-label="Note types">
          {types.map((x) => (
            <li key={x.id} role="option" tabIndex={0} aria-selected={x.id === t.id} className={x.id === t.id ? 'is-hi' : ''} onClick={() => setSel(x.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(x.id))}>
              <span>{x.name}</span>
              <span className="muted small">{count(x.id)} note{count(x.id) === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ul>
        <div className="nt-actions">
          <Button onClick={() => { setName(''); setSub('add'); }}><Plus size={15} /> Add</Button>
          <Button onClick={() => { setName(t.name); setSub('rename'); }}><Pencil size={15} /> Rename</Button>
          <Button onClick={() => setSub('fields')}><ListTree size={15} /> Fields…</Button>
          <Button onClick={() => setSub('cards')}><LayoutTemplate size={15} /> Cards…</Button>
          <Button
            variant="danger"
            disabled={types.length < 2}
            onClick={() => confirmDialog(`Delete “${t.name}”?`, count(t.id) ? `Its ${count(t.id)} note${count(t.id) === 1 ? '' : 's'} and all their cards are deleted too. This cannot be undone.` : 'No notes use it.', 'Delete', () => { deleteNoteType(t.id); setSel(''); })}
          >
            <Trash2 size={15} /> Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Rename references in templates when a field is renamed ({{Old}}, {{#Old}}, {{type:Old}}, …). */
function renameInTemplates(templates: TemplateDef[], from: string, to: string) {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\{\\{([#^/]?)((?:\\w+:)*)\\s*${esc}\\s*\\}\\}`, 'g');
  const fix = (s: string) => s.replace(re, (_, sig: string, filters: string) => `{{${sig}${filters}${to}}}`);
  return templates.map((t) => ({ ...t, front: fix(t.front), back: fix(t.back) }));
}

export function FieldsDialog({ type, onClose }: { type: NoteType; onClose: () => void }) {
  const notes = useStudy((s) => s.data.notes);
  const used = notes.filter((n) => n.typeId === type.id).length;
  const [rows, setRows] = useState(() => type.fields.map((f, i) => ({ ...f, from: i as number | null, key: uid() })));
  const [sel, setSel] = useState(0);
  const [templates, setTemplates] = useState(type.templates);
  const [renaming, setRenaming] = useState<string | null>(null);
  const row = rows[sel];
  const names = rows.map((r) => r.name.toLowerCase());
  const move = (d: number) => {
    const j = sel + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[sel], next[j]] = [next[j], next[sel]];
    setRows(next);
    setSel(j);
  };
  const addField = () => {
    let n = 'Field';
    for (let i = rows.length + 1; names.includes(n.toLowerCase()); i++) n = `Field ${i}`;
    setRows([...rows, { name: n, from: null, key: uid() }]);
    setSel(rows.length);
    setRenaming(n);
  };
  const commitRename = () => {
    const n = (renaming ?? '').trim().replace(/[{}:#^/"]/g, '');
    if (!n || names.some((x, i) => x === n.toLowerCase() && i !== sel)) {
      toast(n ? 'Another field already has that name.' : 'A field needs a name.', { kind: 'error' });
      return;
    }
    setTemplates(renameInTemplates(templates, row.name, n));
    setRows(rows.map((r, i) => (i === sel ? { ...r, name: n } : r)));
    setRenaming(null);
  };
  const save = () => {
    const removed = type.fields.length - rows.filter((r) => r.from !== null).length;
    const apply = () => {
      saveNoteType({ ...type, fields: rows.map(({ name, sticky }) => ({ name, sticky })), templates }, rows.map((r) => r.from));
      onClose();
    };
    if (removed > 0 && used) confirmDialog('Remove fields?', `The content of ${removed} removed field${removed === 1 ? '' : 's'} is deleted from ${used} note${used === 1 ? '' : 's'}. This cannot be undone.`, 'Remove', apply);
    else apply();
  };
  return (
    <Modal title={`Fields for ${type.name}`} size="md" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="nt-manage">
        <ol className="flist-items nt-list" role="listbox" aria-label="Fields">
          {rows.map((r, i) => (
            <li key={r.key} role="option" tabIndex={0} aria-selected={i === sel} className={i === sel ? 'is-hi' : ''} onClick={() => { setSel(i); setRenaming(null); }}
              onKeyDown={(e) => {
                if (e.altKey && e.key === 'ArrowUp') move(-1);
                else if (e.altKey && e.key === 'ArrowDown') move(1);
                else if (e.key === 'ArrowUp') setSel(Math.max(0, i - 1));
                else if (e.key === 'ArrowDown') setSel(Math.min(rows.length - 1, i + 1));
                else if (e.key === 'F2') setRenaming(r.name);
                else return;
                e.preventDefault();
              }}
            >
              <span>{i + 1}: {r.name}</span>
              {r.sticky && <span className="muted small">pinned</span>}
            </li>
          ))}
        </ol>
        <div className="nt-actions">
          <Button onClick={addField}><Plus size={15} /> Add</Button>
          <Button onClick={() => setRenaming(row.name)}><Pencil size={15} /> Rename</Button>
          <Button onClick={() => move(-1)} disabled={sel === 0}><ArrowUp size={15} /> Up</Button>
          <Button onClick={() => move(1)} disabled={sel === rows.length - 1}><ArrowDown size={15} /> Down</Button>
          <Button variant="danger" disabled={rows.length < 2 || (type.kind === 'cloze' && sel === 0)} onClick={() => { setRows(rows.filter((_, i) => i !== sel)); setSel(Math.max(0, sel - 1)); }}><Trash2 size={15} /> Delete</Button>
        </div>
      </div>
      {renaming !== null && (
        <Field label={`Rename “${row.name}”`}>
          <div className="row-gap">
            <input className="input" autoFocus aria-label="Field name" value={renaming} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} />
            <Button onClick={commitRename}>OK</Button>
          </div>
        </Field>
      )}
      <label className="check-row">
        <input type="checkbox" checked={!!row.sticky} onChange={(e) => setRows(rows.map((r, i) => (i === sel ? { ...r, sticky: e.target.checked } : r)))} />
        Remember last input when adding (pin “{row.name}”)
      </label>
      <p className="field-hint">Renaming a field also renames it in the card templates. Reorder with the buttons or Alt+↑/↓.</p>
    </Modal>
  );
}

/** Example values for previews: the note being added, or the field names. */
const sampleNote = (type: NoteType, sample?: string[]): Note => ({
  id: 'preview',
  typeId: type.id,
  fields: type.fields.map((f, i) => (sample && !isEmptyHtml(sample[i] ?? '') ? sample[i] : type.kind === 'cloze' && i === 0 ? `This is a {{c1::${f.name}}} example.` : `(${f.name})`)),
  tags: [],
  created: 0,
  modified: 0,
});

export function CardsDialog({ type, sample, onClose }: { type: NoteType; sample?: string[]; onClose: () => void }) {
  const [templates, setTemplates] = useState(() => type.templates.map((t, i) => ({ ...t, from: i as number | null })));
  const [css, setCss] = useState(type.css);
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState<'front' | 'back' | 'css'>('front');
  const [side, setSide] = useState<'q' | 'a'>('q');
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [naming, setNaming] = useState<{ mode: 'add' | 'rename'; value: string } | null>(null);
  const notes = useStudy((s) => s.data.notes);
  const used = notes.filter((n) => n.typeId === type.id).length;
  const draft: NoteType = { ...type, templates: templates.map(({ from: _f, ...t }) => t), css };
  const note = sampleNote(draft, sample);
  const ord = type.kind === 'cloze' ? (cardOrdinals(draft, note)[0] ?? 1) : sel;
  const html = renderSide(draft, note, ord, side, { deck: 'Preview', card: cardName(draft, ord) });
  const cur = templates[sel];
  const edit = (v: string) => (tab === 'css' ? setCss(v) : setTemplates(templates.map((t, i) => (i === sel ? { ...t, [tab]: v } : t))));
  const value = tab === 'css' ? css : cur[tab];

  const options = (e: { currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Add card type…', icon: <Plus size={15} />, disabled: type.kind === 'cloze', run: () => setNaming({ mode: 'add', value: `Card ${templates.length + 1}` }) },
        { label: 'Rename card type…', icon: <Pencil size={15} />, disabled: type.kind === 'cloze', run: () => setNaming({ mode: 'rename', value: cur.name }) },
        { label: 'Reposition: earlier', icon: <ArrowUp size={15} />, disabled: sel === 0, run: () => { const n = [...templates]; [n[sel - 1], n[sel]] = [n[sel], n[sel - 1]]; setTemplates(n); setSel(sel - 1); } },
        { label: 'Reposition: later', icon: <ArrowDown size={15} />, disabled: sel === templates.length - 1, run: () => { const n = [...templates]; [n[sel + 1], n[sel]] = [n[sel], n[sel + 1]]; setTemplates(n); setSel(sel + 1); } },
        { separator: true, label: '' },
        { label: 'Remove card type', icon: <Trash2 size={15} />, danger: true, disabled: templates.length < 2, run: () => { setTemplates(templates.filter((_, i) => i !== sel)); setSel(Math.max(0, sel - 1)); } },
        { separator: true, label: '' },
        { label: 'Restore default styling', icon: <Copy size={15} />, run: () => setCss(DEFAULT_CSS) },
      ],
    });
  };

  const save = () => {
    const apply = () => {
      saveNoteType(draft, undefined, templates.map((t) => t.from));
      onClose();
    };
    const removed = type.templates.length - templates.filter((t) => t.from !== null).length;
    if (removed > 0 && used) confirmDialog('Remove card types?', `Cards of the ${removed} removed card type${removed === 1 ? '' : 's'} are deleted from ${used} note${used === 1 ? '' : 's'}, with their review history. This cannot be undone.`, 'Remove', apply);
    else apply();
  };

  return (
    <Modal title={`Card types for ${type.name}`} size="lg" className="cards-dlg" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="cards-top">
        <label className="add-pick">
          <span className="add-pick-label">Card type</span>
          <select className="input" value={sel} onChange={(e) => setSel(+e.target.value)} disabled={type.kind === 'cloze'}>
            {templates.map((t, i) => <option key={i} value={i}>{i + 1}: {t.name}</option>)}
          </select>
        </label>
        <Button variant="ghost" onClick={options}>Options <ChevronDown size={13} /></Button>
        {naming && (
          <form
            className="row-gap"
            onSubmit={(e) => {
              e.preventDefault();
              const v = naming.value.trim();
              if (!v) return;
              if (naming.mode === 'add') {
                const base = templates[sel];
                setTemplates([...templates, { name: v, front: base.front, back: base.back, from: null }]);
                setSel(templates.length);
              } else setTemplates(templates.map((t, i) => (i === sel ? { ...t, name: v } : t)));
              setNaming(null);
            }}
          >
            <input className="input" autoFocus aria-label="Card type name" value={naming.value} onChange={(e) => setNaming({ ...naming, value: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(null))} />
            <Button type="submit" variant="primary">{naming.mode === 'add' ? 'Add' : 'Rename'}</Button>
          </form>
        )}
      </div>
      <div className="cards-grid">
        <section className="cards-edit">
          <div className="segmented" role="tablist" aria-label="Template">
            {(['front', 'back', 'css'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`${tab === k ? 'is-on' : ''}`} onClick={() => { setTab(k); if (k !== 'css') setSide(k === 'front' ? 'q' : 'a'); }}>
                {k === 'front' ? 'Front template' : k === 'back' ? 'Back template' : 'Styling'}
              </button>
            ))}
          </div>
          <textarea className="cards-code" spellCheck={false} aria-label={tab === 'css' ? 'Styling (CSS)' : `${tab === 'front' ? 'Front' : 'Back'} template`} value={value} onChange={(e) => edit(e.target.value)} />
          <p className="field-hint">
            Fields: {type.fields.map((f) => `{{${f.name}}}`).join(' ')} · also {'{{FrontSide}}'}, {'{{Tags}}'}, {'{{Deck}}'}, {'{{Card}}'}, {'{{type:Field}}'}, {'{{hint:Field}}'}, {'{{text:Field}}'}{type.kind === 'cloze' ? `, {{cloze:${type.fields[0]?.name}}}` : ''}, and {'{{#Field}}…{{/Field}}'} to show something only when a field has content.
          </p>
        </section>
        <section className="cards-preview" aria-label="Preview">
          <div className="segmented" role="tablist" aria-label="Preview side">
            <button type="button" role="tab" aria-selected={side === 'q'} className={`${side === 'q' ? 'is-on' : ''}`} onClick={() => setSide('q')}>Front preview</button>
            <button type="button" role="tab" aria-selected={side === 'a'} className={`${side === 'a' ? 'is-on' : ''}`} onClick={() => setSide('a')}>Back preview</button>
          </div>
          <div className="cards-preview-face">
            <CardHtml html={html} css={css} label={`${side === 'q' ? 'Front' : 'Back'} preview`} />
          </div>
        </section>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </Modal>
  );
}

function PreviewDialog({ type, fields, tags, deck, onClose }: { type: NoteType; fields: string[]; tags: string[]; deck: Deck; onClose: () => void }) {
  const note: Note = { id: 'preview', typeId: type.id, fields, tags, created: 0, modified: 0 };
  const ords = cardOrdinals(type, note);
  const [i, setI] = useState(0);
  const [side, setSide] = useState<'q' | 'a'>('q');
  const ord = ords[Math.min(i, ords.length - 1)];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') setSide((s) => (s === 'q' ? 'a' : 'q'));
      else if (e.key === 'ArrowRight') { setI((x) => Math.min(ords.length - 1, x + 1)); setSide('q'); }
      else if (e.key === 'ArrowLeft') { setI((x) => Math.max(0, x - 1)); setSide('q'); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ords.length]);
  return (
    <Modal
      title="Preview"
      size="md"
      onClose={onClose}
      footer={
        ords.length ? (
          <>
            <span className="muted small">{cardName(type, ord)} · {Math.min(i, ords.length - 1) + 1} of {ords.length}</span>
            <span className="add-spacer" />
            <Button variant="ghost" disabled={i === 0} onClick={() => { setI(i - 1); setSide('q'); }}>Previous</Button>
            <Button variant="ghost" disabled={i >= ords.length - 1} onClick={() => { setI(i + 1); setSide('q'); }}>Next</Button>
            <Button variant="primary" onClick={() => setSide(side === 'q' ? 'a' : 'q')}>{side === 'q' ? 'Show back' : 'Show front'}</Button>
          </>
        ) : <Button onClick={onClose}>Close</Button>
      }
    >
      {ords.length ? (
        <div className="cards-preview-face is-big">
          <CardHtml html={renderSide(type, note, ord, side, { deck: deck.name, card: cardName(type, ord) })} css={type.css} label={side === 'q' ? 'Front' : 'Back'} />
        </div>
      ) : (
        <p className="field-hint">This note makes no cards yet: the front of every card type would be empty.</p>
      )}
    </Modal>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Add the note', 'Ctrl+Enter'],
    ['Choose note type / deck', 'Ctrl+N / Ctrl+D'],
    ['Fields… / Cards…', 'Ctrl+Shift+F / Ctrl+L'],
    ['Preview the cards', 'Ctrl+Shift+P'],
    ['History', 'Ctrl+Shift+H'],
    ['Tags', 'Ctrl+Shift+T'],
    ['Next / previous field', 'Tab / Shift+Tab'],
    ['Bold, italic, underline', 'Ctrl+B, Ctrl+I, Ctrl+U'],
    ['Superscript / subscript', 'Ctrl+Shift+= / Ctrl+='],
    ['Text colour / choose colour', 'F7 / F8'],
    ['Clear formatting', 'Ctrl+R'],
    ['Cloze deletion (new / same number)', 'Ctrl+Shift+C / Ctrl+Alt+Shift+C'],
    ['MathJax inline / block / chemistry', 'Ctrl+M, M / Ctrl+M, E / Ctrl+M, C'],
    ['Attach pictures or sound / record', 'F3 / F5'],
    ['HTML editor of the field', 'Ctrl+Shift+X'],
    ['Paste without formatting', 'Ctrl+Shift+V'],
    ['Close', 'Esc'],
  ];
  return (
    <Modal title="Adding notes" size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <p className="field-hint">
        A note holds fields; its note type turns them into one or more cards. “Basic” makes one card, “Basic (and reversed card)” two, “Cloze” one per deletion. Pin a field to keep its content for the next note. Formulas: \(x^2\) inline, \[\frac{'{a}{b}'}\] on their own line, \(\ce{'{H2O}'}\) for chemistry; $…$ works too.
      </p>
      <table className="help-keys">
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}><td>{a}</td><td><kbd>{b}</kbd></td></tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

// ---- editing a note (Browse, Review's Edit) -------------------------------------------------------

/** Edit an existing note; changes are saved as you type (like Anki's browser), or on Save in a dialog. */
export function NoteEdit({ card, autosave, onDone }: { card: StudyCard; autosave?: boolean; onDone?: () => void }) {
  const data = useStudy((s) => s.data);
  const note = noteOf(card, data);
  const type = typeOf(note, data);
  const [fields, setFields] = useState(note?.fields ?? []);
  const [tags, setTags] = useState(note?.tags ?? []);
  const [deckDlg, setDeckDlg] = useState(false);
  const [typeDlg, setTypeDlg] = useState<null | 'fields' | 'cards' | 'change'>(null);
  const allTags = useAllTags();
  const dirty = !!note && (fields.join('\u0000') !== note.fields.join('\u0000') || tags.join(' ') !== note.tags.join(' '));
  const dups = useMemo(() => (note ? duplicatesOf(type.id, fields[0] ?? '', note.id, data) : []), [note, type.id, fields, data]);
  const setField = useCallback((i: number, html: string) => setFields((v) => v.map((x, j) => (j === i ? html : x))), []);

  // a different type (Change note type…) or fields reordered: start again from the stored note
  useEffect(() => {
    if (note && note.fields.length !== fields.length) setFields(note.fields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.typeId, note?.fields.length]);

  useEffect(() => {
    if (!autosave || !dirty || !note) return;
    const t = setTimeout(() => updateNote(note.id, { fields, tags }), 500);
    return () => clearTimeout(t);
  }, [autosave, dirty, fields, tags, note]);
  // nothing typed is lost when the selection moves on
  const latest = useRef({ fields, tags, dirty });
  latest.current = { fields, tags, dirty };
  useEffect(() => () => {
    if (autosave && latest.current.dirty && note) updateNote(note.id, { fields: latest.current.fields, tags: latest.current.tags });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!note) return <p className="field-hint">This note no longer exists.</p>;
  const deck = data.decks.find((d) => d.id === card.deckId);
  if (note.page) {
    return (
      <div className="note-edit">
        <p className="field-hint">This card is a handwritten notebook page. Edit it in its notebook.</p>
        <div className="st-actions">
          <Button onClick={() => void openNotebook(note.page!.nb)}><BookOpen size={15} /> Open notebook</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="note-edit">
      <div className="add-head">
        <div className="add-pick">
          <span className="add-pick-label">Type</span>
          <button type="button" className="add-chooser" onClick={() => setTypeDlg('change')} title="Change note type"><span className="ellipsis">{type.name}</span><ChevronDown size={14} /></button>
        </div>
        <div className="add-pick">
          <span className="add-pick-label">Deck</span>
          <button type="button" className="add-chooser" onClick={() => setDeckDlg(true)} title="Change deck"><span className="ellipsis">{deck?.name}</span><ChevronDown size={14} /></button>
        </div>
        <span className="add-spacer" />
        <Button variant="ghost" size="sm" onClick={() => setTypeDlg('fields')}><ListTree size={15} /> Fields…</Button>
        <Button variant="ghost" size="sm" onClick={() => setTypeDlg('cards')}><LayoutTemplate size={15} /> Cards…</Button>
      </div>
      <NoteEditor
        type={type}
        fields={fields}
        onField={setField}
        duplicate={dups.length ? <div className="ne-dup" role="status">Another note has the same {type.fields[0]?.name ?? 'first field'}.</div> : undefined}
      />
      <TagEditor tags={tags} all={allTags} onChange={setTags} />
      {!autosave && (
        <div className="st-actions">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button variant="primary" onClick={() => { if (dirty) updateNote(note.id, { fields, tags }); onDone?.(); }}>Save</Button>
        </div>
      )}
      {deckDlg && <ChooseDeckDialog title="Change deck" current={card.deckId} onChoose={(id) => { setNoteDeck(note.id, id); setDeckDlg(false); }} onClose={() => setDeckDlg(false)} />}
      {typeDlg === 'fields' && <FieldsDialog type={type} onClose={() => setTypeDlg(null)} />}
      {typeDlg === 'cards' && <CardsDialog type={type} sample={fields} onClose={() => setTypeDlg(null)} />}
      {typeDlg === 'change' && (
        <ChangeTypeDialog
          from={type}
          onChoose={(t) => {
            setTypeDlg(null);
            if (t.id === type.id) return;
            if (dirty) updateNote(note.id, { fields, tags });
            confirmDialog(`Change to “${t.name}”?`, 'Fields are kept by position. Cards that the new type does not make are deleted with their review history.', 'Change', () => changeNoteType([note.id], t.id));
          }}
          onClose={() => setTypeDlg(null)}
        />
      )}
    </div>
  );
}

function ChangeTypeDialog({ from, onChoose, onClose }: { from: NoteType; onChoose: (t: NoteType) => void; onClose: () => void }) {
  const types = useStudy((s) => s.data.noteTypes);
  return (
    <Modal title="Change note type" onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
      <FilterList items={types} label="Note types" text={(t) => t.name} current={(t) => t.id === from.id} onChoose={onChoose} />
    </Modal>
  );
}
