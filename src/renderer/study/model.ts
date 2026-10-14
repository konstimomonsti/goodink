// Study: an Anki-style flashcard collection that lives next to the library (study.json).
// Decks (with "Parent::Child" subdecks and per-deck options), notes that make one or more cards
// (made by note types: fields, card templates and styling, see notetypes.ts), the Anki v3 scheduler from engine/srs, a review log for
// statistics, and resources (notebooks, links, PDFs) to make cards from.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Flashcard } from '../../shared/types';
import { ANKI_DEFAULTS, answer, buildQueue, dayNumber, logAnswer, normalize, type Grade, type Queue, type SrsConfig, type StudyLog } from '../engine/srs';
import { api } from '../lib/api';
import { debounce, uid } from '../lib/util';
import { addLink, flushHooks, folderPath, importPdfFile, useApp } from '../lib/store';
import { STOCK_TYPES, TYPE_MARK, cardOrdinals, htmlToText, renderSide, textToHtml, type Note, type NoteType, type RenderCtx } from './notetypes';

export type { Note, NoteType } from './notetypes';

export interface Deck {
  id: string;
  name: string; // "Parent::Child" makes a subdeck, like Anki
  created: number;
  options: Partial<SrsConfig>;
  log?: StudyLog;
  description?: string;
  /** the library folder this deck belongs to: cards made from that folder's items land here */
  folderId?: string;
}

/** A card: one template (or cloze number) of a note, with its schedule. The content lives on the note. */
export interface StudyCard extends Flashcard {
  deckId: string;
  noteId: string;
  /** template index; for cloze notes the cloze number */
  ord: number;
  created: number;
  modified: number;
  suspended?: boolean;
  /** buried until the end of this Anki day */
  buriedUntil?: number;
  flag?: number; // 1 red, 2 orange, 3 green, 4 blue
}

/** Cards as goodink 2.6–2.9 stored them: the text on every card. */
interface LegacyCard extends StudyCard {
  type?: 'basic' | 'reversed' | 'cloze';
  front?: string;
  back?: string;
  tags?: string[];
  source?: Note['source'];
  page?: Note['page'];
}

export interface Resource {
  id: string;
  kind: 'link' | 'pdf' | 'youtube';
  title: string;
  url?: string;
  file?: { id: string; ext: 'pdf' };
  pages?: number;
  /** YouTube: the channel */
  author?: string;
  added: number;
}

/** One answer, like Anki's revlog: ivl in days (negative = seconds while learning). */
export interface RevEntry {
  card: string;
  deck: string;
  t: number;
  grade: Grade;
  ivl: number;
  lastIvl: number;
  ease: number;
  kind: 'learn' | 'review' | 'relearn';
}

/** What the Add window remembers, like Anki: the last note type and deck, and the notes added. */
export interface AddPrefs {
  typeId: string;
  deckId?: string;
  /** deck last used with each note type */
  deckByType: Record<string, string>;
  /** sticky (pinned) field values per note type */
  sticky: Record<string, Record<number, string>>;
  history: string[];
}

export interface StudyData {
  v: 2;
  decks: Deck[];
  noteTypes: NoteType[];
  notes: Note[];
  cards: StudyCard[];
  resources: Resource[];
  revlog: RevEntry[];
  /** notebook decks from older versions already carried over */
  imported: string[];
  prefs: AddPrefs;
}

const EMPTY: StudyData = { v: 2, decks: [], noteTypes: STOCK_TYPES, notes: [], cards: [], resources: [], revlog: [], imported: [], prefs: { typeId: 'nt-basic', deckByType: {}, sticky: {}, history: [] } };

interface UndoStep {
  card: StudyCard;
  deck: Deck;
  revlogLength: number;
}

interface StudyState {
  ready: boolean;
  data: StudyData;
  undo: UndoStep[];
}

export const useStudy = create<StudyState>(() => ({ ready: false, data: EMPTY, undo: [] }));
const get = () => useStudy.getState();

// ---- load / save --------------------------------------------------------------------------------

const write = async () => {
  await invoke('doc_write', { name: 'study.json', json: JSON.stringify(get().data) });
};
const saveSoon = debounce(() => void write(), 400);
flushHooks.push(async () => {
  if (!get().ready) return;
  saveSoon.cancel();
  await write();
});

let loading: Promise<void> | null = null;
export function loadStudy() {
  loading ??= (async () => {
    const text = await invoke<string | null>('doc_read', { name: 'study.json' });
    let data: StudyData = EMPTY;
    try {
      if (text) data = migrate({ ...EMPTY, ...(JSON.parse(text) as StudyData) });
    } catch {
      /* unreadable: start empty, the file is kept until the next save */
    }
    if (!data.decks.length) data = { ...data, decks: [{ id: uid(), name: 'Default', created: Date.now(), options: {} }] };
    useStudy.setState({ ready: true, data: await moveResourcesToLibrary(await importNotebookDecks(data)) });
    saveSoon();
  })();
  return loading;
}

export function mutate(fn: (d: StudyData) => StudyData) {
  useStudy.setState({ data: fn(get().data) });
  saveSoon();
}

/**
 * goodink 2.6–2.9 kept the text on the cards (Basic, Basic + reversed, Cloze). From 3.0 a note holds
 * the fields and its note type makes the cards, like Anki. Plain text becomes field HTML.
 */
function migrate(data: StudyData): StudyData {
  const types = [...STOCK_TYPES.filter((t) => !(data.noteTypes ?? []).some((x) => x.id === t.id)), ...(data.noteTypes ?? [])];
  const prefs = { ...EMPTY.prefs, ...(data.prefs ?? {}) };
  if (data.v === 2 && data.notes) return { ...data, noteTypes: types, prefs };
  const notes: Note[] = [];
  const seen = new Set<string>();
  const cards = (data.cards as LegacyCard[]).map((c) => {
    if (!seen.has(c.noteId)) {
      seen.add(c.noteId);
      const typeId = c.type === 'cloze' ? 'nt-cloze' : c.type === 'reversed' ? 'nt-basic-reversed' : 'nt-basic';
      notes.push({ id: c.noteId, typeId, fields: [textToHtml(c.front ?? ''), textToHtml(c.back ?? '')], tags: c.tags ?? [], created: c.created, modified: c.modified, source: c.source, page: c.page });
    }
    const { type: _t, front: _f, back: _b, tags: _g, source: _s, page: _p, ...card } = c;
    return card as StudyCard;
  });
  return { ...data, v: 2, noteTypes: types, notes, cards, prefs };
}

/** Decks made as notebooks by goodink 2.4/2.5 become Study decks; their pages stay handwritten cards. */
async function importNotebookDecks(data: StudyData): Promise<StudyData> {
  const old = useApp.getState().library.notebooks.filter((n) => n.kind === 'flashcards' && !n.deletedAt && !data.imported.includes(n.id));
  if (!old.length) return data;
  const decks = [...data.decks];
  const cards = [...data.cards];
  const notes = [...data.notes];
  for (const nb of old) {
    const doc = await api.loadNotebook(nb.id).catch(() => null);
    if (!doc) continue;
    const deck: Deck = { id: uid(), name: uniqueDeckName(decks, nb.title.replace(/::/g, ':')), created: Date.now(), options: {} };
    decks.push(deck);
    const sched = new Map((doc.flashcards ?? []).map((c) => [c.pageId, c]));
    const now = Date.now();
    for (const p of doc.pages) {
      const s = sched.get(p.id);
      const noteId = uid();
      notes.push({ id: noteId, typeId: 'nt-basic', fields: ['', ''], tags: ['handwritten'], created: now, modified: now, source: { kind: 'notebook', id: nb.id, label: nb.title }, page: { nb: nb.id, page: p.id } });
      cards.push({ ...(s ?? { ease: 2.5, interval: 0, due: 0, state: 'new' }), id: uid(), pageId: undefined, deckId: deck.id, noteId, ord: 0, created: now, modified: now });
    }
  }
  return { ...data, decks, notes, cards, imported: [...data.imported, ...old.map((n) => n.id)] };
}

// ---- decks --------------------------------------------------------------------------------------

export function uniqueDeckName(decks: Deck[], name: string) {
  const base = name.trim() || 'Deck';
  let n = base;
  for (let i = 2; decks.some((d) => d.name.toLowerCase() === n.toLowerCase()); i++) n = `${base} ${i}`;
  return n;
}

export const deckLeaf = (d: Deck) => d.name.split('::').pop()!;
export const deckDepth = (d: Deck) => d.name.split('::').length - 1;

/** Decks in tree order, with any missing parents implied by "A::B" names. */
export function deckTree(decks: Deck[]) {
  return [...decks].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export function subdeckIds(decks: Deck[], deckId: string) {
  const d = decks.find((x) => x.id === deckId);
  if (!d) return [];
  const prefix = `${d.name}::`.toLowerCase();
  return decks.filter((x) => x.id === d.id || x.name.toLowerCase().startsWith(prefix)).map((x) => x.id);
}

export const deckConfig = (d: Deck | undefined): SrsConfig => ({ ...ANKI_DEFAULTS, ...(d?.options ?? {}) });

export function createDeck(name: string) {
  const deck: Deck = { id: uid(), name: uniqueDeckName(get().data.decks, name), created: Date.now(), options: {} };
  mutate((d) => ({ ...d, decks: [...d.decks, deck] }));
  return deck;
}

export function renameDeck(id: string, name: string) {
  mutate((d) => {
    const deck = d.decks.find((x) => x.id === id);
    if (!deck) return d;
    const old = deck.name;
    // children follow their parent, like Anki
    return { ...d, decks: d.decks.map((x) => (x.id === id ? { ...x, name } : x.name.startsWith(`${old}::`) ? { ...x, name: name + x.name.slice(old.length) } : x)) };
  });
}

export function deleteDeck(id: string) {
  mutate((d) => {
    const ids = new Set(subdeckIds(d.decks, id));
    const decks = d.decks.filter((x) => !ids.has(x.id));
    return { ...d, decks: decks.length ? decks : [{ id: uid(), name: 'Default', created: Date.now(), options: {} }], cards: d.cards.filter((c) => !ids.has(c.deckId)) };
  });
}

export function setDeckOptions(id: string, options: Partial<SrsConfig>) {
  mutate((d) => ({ ...d, decks: d.decks.map((x) => (x.id === id ? { ...x, options } : x)) }));
}

// ---- notes & cards ------------------------------------------------------------------------------

const noteIndex = new WeakMap<Note[], Map<string, Note>>();
/** The note of a card (fast: one index per notes array). */
export function noteOf(card: Pick<StudyCard, 'noteId'>, data = get().data) {
  let m = noteIndex.get(data.notes);
  if (!m) noteIndex.set(data.notes, (m = new Map(data.notes.map((n) => [n.id, n]))));
  return m.get(card.noteId);
}
export const typeOf = (note: Note | undefined, data = get().data) => data.noteTypes.find((t) => t.id === note?.typeId) ?? data.noteTypes[0];

/** Name of a card: its template, or "Cloze 2". */
export function cardName(type: NoteType, ord: number) {
  return type.kind === 'cloze' ? `Cloze ${ord}` : type.templates[ord]?.name ?? `Card ${ord + 1}`;
}

/** One side of a card as (unsanitized) HTML, with the note type's styling. */
export function cardHtml(card: StudyCard, side: 'q' | 'a', ctx: RenderCtx = {}, data = get().data) {
  const note = noteOf(card, data);
  const type = typeOf(note, data);
  if (!note) return { html: '', css: type.css, note, type };
  const deck = data.decks.find((d) => d.id === card.deckId)?.name;
  return { html: renderSide(type, note, card.ord, side, { deck, card: cardName(type, card.ord), ...ctx }), css: type.css, note, type };
}

/** Question and answer as plain text, for lists. The answer leaves out the repeated question. */
export function plainSides(card: StudyCard, data = get().data) {
  const q = cardHtml(card, 'q', {}, data).html;
  const a = cardHtml(card, 'a', {}, data).html;
  const cut = a.search(/<hr id=["']?answer["']?\s*\/?>/i);
  const clean = (h: string) => htmlToText(h.split(TYPE_MARK).join('')).replace(/\s+/g, ' ').trim();
  return { q: clean(q), a: clean(cut >= 0 ? a.slice(cut).replace(/<hr[^>]*>/i, '') : a) };
}

function newCard(deckId: string, noteId: string, ord: number, now: number, d: StudyData): StudyCard {
  return { id: uid(), deckId, noteId, ord, created: now, modified: now, ease: deckConfig(d.decks.find((x) => x.id === deckId)).initialEase, interval: 0, due: 0, state: 'new' };
}

/** Add a note and make its cards. Returns the cards (none: nothing to ask, the note is not added). */
export function addNote(opts: { typeId: string; deckId: string; fields: string[]; tags?: string[]; source?: Note['source'] }): StudyCard[] {
  const d = get().data;
  const type = d.noteTypes.find((t) => t.id === opts.typeId) ?? d.noteTypes[0];
  const now = Date.now();
  const note: Note = { id: uid(), typeId: type.id, fields: type.fields.map((_, i) => opts.fields[i] ?? ''), tags: opts.tags ?? [], created: now, modified: now, source: opts.source };
  const cards = cardOrdinals(type, note).map((ord, i) => newCard(opts.deckId, note.id, ord, now + i, d));
  if (!cards.length) return cards;
  mutate((x) => ({ ...x, notes: [...x.notes, note], cards: [...x.cards, ...cards], prefs: { ...x.prefs, history: [note.id, ...x.prefs.history.filter((h) => h !== note.id)].slice(0, 30) } }));
  return cards;
}

/** A Basic note from plain text (the AI's cards). */
export const addBasic = (deckId: string, front: string, back: string, tags: string[] = [], source?: Note['source']) =>
  addNote({ typeId: 'nt-basic', deckId, fields: [textToHtml(front), textToHtml(back)], tags, source });

/** Cards a note should have after an edit: new ones are made; never-studied ones that no longer apply go. */
function syncCards(d: StudyData, note: Note, type: NoteType, now: number, deckId?: string): StudyCard[] {
  const mine = d.cards.filter((c) => c.noteId === note.id);
  const want = new Set(cardOrdinals(type, note));
  const deck = deckId ?? mine[0]?.deckId ?? d.prefs.deckId ?? d.decks[0].id;
  const keep = mine.filter((c) => want.has(c.ord) || c.state !== 'new' || (c.reps ?? 0) > 0);
  const have = new Set(keep.map((c) => c.ord));
  const extra = [...want].filter((o) => !have.has(o)).map((o, i) => newCard(deck, note.id, o, now + i, d));
  return [...d.cards.filter((c) => c.noteId !== note.id), ...keep, ...extra];
}

/** Edit a note's fields or tags: its cards follow (a new cloze number makes a new card). */
export function updateNote(noteId: string, patch: { fields?: string[]; tags?: string[] }) {
  mutate((d) => {
    const old = d.notes.find((n) => n.id === noteId);
    if (!old) return d;
    const now = Date.now();
    const note = { ...old, ...patch, modified: now };
    const next = { ...d, notes: d.notes.map((n) => (n.id === noteId ? note : n)) };
    return patch.fields ? { ...next, cards: syncCards(next, note, typeOf(note, d), now) } : next;
  });
}

/** Move every card of a note to a deck. */
export function setNoteDeck(noteId: string, deckId: string) {
  mutate((d) => ({ ...d, cards: d.cards.map((c) => (c.noteId === noteId ? { ...c, deckId, modified: Date.now() } : c)) }));
}

export function updateCards(ids: string[], patch: Partial<StudyCard> | ((c: StudyCard) => Partial<StudyCard>)) {
  const set = new Set(ids);
  mutate((d) => ({ ...d, cards: d.cards.map((c) => (set.has(c.id) ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch), modified: Date.now() } : c)) }));
}

export function tagNotes(noteIds: string[], add: string[], remove: string[] = []) {
  const set = new Set(noteIds);
  mutate((d) => ({ ...d, notes: d.notes.map((n) => (set.has(n.id) ? { ...n, tags: [...new Set([...n.tags.filter((t) => !remove.includes(t)), ...add])], modified: Date.now() } : n)) }));
}

export function deleteCards(ids: string[]) {
  // deleting a card deletes its note, like Anki
  const notes = new Set(get().data.cards.filter((c) => ids.includes(c.id)).map((c) => c.noteId));
  deleteNotes([...notes]);
}

export function deleteNotes(ids: string[]) {
  const notes = new Set(ids);
  mutate((d) => ({ ...d, notes: d.notes.filter((n) => !notes.has(n.id)), cards: d.cards.filter((c) => !notes.has(c.noteId)) }));
}

/** Anki "Forget": back to new. */
export const forgetCards = (ids: string[]) => updateCards(ids, (c) => ({ state: 'new', interval: 0, due: 0, ease: deckConfig(get().data.decks.find((d) => d.id === c.deckId)).initialEase, remaining: 0, lapses: 0, reps: 0, lastReview: 0, leech: false }));

/** Notes of the same type whose first field is the same text (Anki's duplicate check). */
export function duplicatesOf(typeId: string, first: string, exceptId?: string, data = get().data) {
  const key = htmlToText(first).trim().toLowerCase();
  if (!key) return [];
  return data.notes.filter((n) => n.typeId === typeId && n.id !== exceptId && htmlToText(n.fields[0] ?? '').trim().toLowerCase() === key);
}

export function setAddPrefs(patch: Partial<AddPrefs>) {
  mutate((d) => ({ ...d, prefs: { ...d.prefs, ...patch } }));
}

// ---- note types ---------------------------------------------------------------------------------

/**
 * Save a changed note type. `fieldMap[i]` is the old index of new field i (null: a new field);
 * `templateMap[i]` the old index of new template i. Notes are rewritten and cards follow:
 * cards of removed templates are deleted, new templates make new cards.
 */
export function saveNoteType(type: NoteType, fieldMap?: (number | null)[], templateMap?: (number | null)[]) {
  mutate((d) => {
    const exists = d.noteTypes.some((t) => t.id === type.id);
    let next: StudyData = { ...d, noteTypes: exists ? d.noteTypes.map((t) => (t.id === type.id ? type : t)) : [...d.noteTypes, type] };
    if (!exists) return next;
    const now = Date.now();
    const notes = next.notes.map((n) => (n.typeId === type.id && fieldMap ? { ...n, fields: fieldMap.map((o) => (o === null ? '' : n.fields[o] ?? '')), modified: now } : n));
    next = { ...next, notes };
    if (templateMap && type.kind === 'standard') {
      const ordMap = new Map(templateMap.flatMap((o, i) => (o === null ? [] : [[o, i] as const])));
      const ofType = new Set(notes.filter((n) => n.typeId === type.id).map((n) => n.id));
      next = { ...next, cards: next.cards.flatMap((c) => (!ofType.has(c.noteId) ? [c] : ordMap.has(c.ord) ? [{ ...c, ord: ordMap.get(c.ord)! }] : [])) };
    }
    for (const n of notes) if (n.typeId === type.id) next = { ...next, cards: syncCards(next, n, type, now) };
    return next;
  });
}

export function deleteNoteType(id: string) {
  mutate((d) => {
    const gone = new Set(d.notes.filter((n) => n.typeId === id).map((n) => n.id));
    const noteTypes = d.noteTypes.filter((t) => t.id !== id);
    if (!noteTypes.length) return d;
    return { ...d, noteTypes, notes: d.notes.filter((n) => !gone.has(n.id)), cards: d.cards.filter((c) => !gone.has(c.noteId)), prefs: d.prefs.typeId === id ? { ...d.prefs, typeId: noteTypes[0].id } : d.prefs };
  });
}

/** Change notes to another note type, fields kept by position (Anki's Change Note Type, simplified). */
export function changeNoteType(noteIds: string[], typeId: string) {
  mutate((d) => {
    const type = d.noteTypes.find((t) => t.id === typeId);
    if (!type) return d;
    const set = new Set(noteIds);
    const now = Date.now();
    let next = { ...d };
    for (const n of d.notes.filter((x) => set.has(x.id))) {
      const deckId = d.cards.find((c) => c.noteId === n.id)?.deckId;
      const note: Note = { ...n, typeId, fields: type.fields.map((_, i) => n.fields[i] ?? ''), modified: now };
      next = { ...next, notes: next.notes.map((x) => (x.id === n.id ? note : x)), cards: next.cards.filter((c) => c.noteId !== n.id) };
      next = { ...next, cards: syncCards(next, note, type, now, deckId) };
    }
    return next;
  });
}

// ---- studying -----------------------------------------------------------------------------------

const today = (now = Date.now()) => dayNumber(now);

export function isAvailable(c: StudyCard, now = Date.now()) {
  return !c.suspended && !(c.buriedUntil !== undefined && c.buriedUntil >= today(now));
}

export function deckQueue(deckId: string, now = Date.now()): Queue {
  const { decks, cards } = get().data;
  const ids = new Set(subdeckIds(decks, deckId));
  const deck = decks.find((d) => d.id === deckId);
  const mine = cards.filter((c) => ids.has(c.deckId) && isAvailable(c, now));
  return buildQueue(mine, mine.map((c) => c.id), deck?.log, now, deckConfig(deck));
}

export function answerCard(deckId: string, card: StudyCard, grade: Grade, now = Date.now()) {
  const { decks } = get().data;
  const deck = decks.find((d) => d.id === deckId)!;
  const cfg = deckConfig(deck);
  const before = normalize(card, cfg);
  const res = answer(card, grade, now, cfg);
  const next: StudyCard = { ...card, ...res.card, pageId: card.pageId };
  const entry: RevEntry = {
    card: card.id,
    deck: card.deckId,
    t: now,
    grade,
    ivl: res.days ?? -(res.secs ?? 0),
    lastIvl: before.state === 'review' || before.state === 'relearning' ? before.interval : 0,
    ease: next.ease,
    kind: before.state === 'review' ? 'review' : before.state === 'relearning' ? 'relearn' : 'learn',
  };
  useStudy.setState((st) => ({ undo: [...st.undo.slice(-30), { card, deck, revlogLength: st.data.revlog.length }] }));
  mutate((d) => ({
    ...d,
    cards: d.cards.map((c) => (c.id === card.id ? next : c)),
    decks: d.decks.map((x) => (x.id === deckId ? { ...x, log: logAnswer(x.log, card, now, cfg) } : x)),
    revlog: [...d.revlog, entry],
  }));
  if (next.leech && res.leechNow) tagNotes([card.noteId], ['leech']);
  return res;
}

/** Undo the last answer (Anki's Ctrl+Z while reviewing). */
export function undoAnswer() {
  const step = get().undo[get().undo.length - 1];
  if (!step) return null;
  useStudy.setState((st) => ({ undo: st.undo.slice(0, -1) }));
  mutate((d) => ({
    ...d,
    cards: d.cards.map((c) => (c.id === step.card.id ? step.card : c)),
    decks: d.decks.map((x) => (x.id === step.deck.id ? step.deck : x)),
    revlog: d.revlog.slice(0, step.revlogLength),
  }));
  return step.card;
}

export const buryCards = (ids: string[]) => updateCards(ids, { buriedUntil: today() });

// ---- browse search (a useful subset of Anki's syntax) --------------------------------------------

export function searchCards(data: StudyData, query: string, now = Date.now()): StudyCard[] {
  const tokens = query.match(/(-?\w+:"[^"]*"|-?\w+:\S+|"[^"]*"|\S+)/g) ?? [];
  const t = today(now);
  const textOf = new Map<string, string>();
  const note = (c: StudyCard) => noteOf(c, data);
  const text = (c: StudyCard) => {
    let v = textOf.get(c.noteId);
    if (v === undefined) textOf.set(c.noteId, (v = htmlToText((note(c)?.fields ?? []).join(' ')).toLowerCase()));
    return v;
  };
  const tags = (c: StudyCard) => note(c)?.tags ?? [];
  const tests = tokens.map((raw) => {
    const neg = raw.startsWith('-');
    const tok = (neg ? raw.slice(1) : raw).replace(/"/g, '');
    const [k, ...rest] = tok.split(':');
    const v = rest.join(':').toLowerCase();
    let f: (c: StudyCard) => boolean;
    if (rest.length && k === 'deck') {
      const ids = new Set(data.decks.filter((d) => d.name.toLowerCase() === v || d.name.toLowerCase().startsWith(`${v}::`) || (v.endsWith('*') && d.name.toLowerCase().startsWith(v.slice(0, -1)))).map((d) => d.id));
      f = (c) => ids.has(c.deckId);
    } else if (rest.length && k === 'tag') f = (c) => tags(c).some((x) => x.toLowerCase() === v || (v.endsWith('*') && x.toLowerCase().startsWith(v.slice(0, -1))));
    else if (rest.length && k === 'flag') f = (c) => (c.flag ?? 0) === +v;
    else if (rest.length && k === 'note') f = (c) => typeOf(note(c), data).name.toLowerCase() === v;
    else if (rest.length && k === 'card') f = (c) => (/^\d+$/.test(v) ? c.ord + (typeOf(note(c), data).kind === 'cloze' ? 0 : 1) === +v : cardName(typeOf(note(c), data), c.ord).toLowerCase() === v);
    else if (rest.length && k === 'nid') f = (c) => v.split(',').includes(c.noteId);
    else if (rest.length && k === 'added') f = (c) => c.created >= now - Math.max(1, +v || 1) * 86_400_000;
    else if (rest.length && k === 'is') {
      f = (c) => {
        const s = normalize(c).state;
        if (v === 'new') return s === 'new';
        if (v === 'learn') return s === 'learning' || s === 'relearning';
        if (v === 'review') return s === 'review' || s === 'relearning';
        if (v === 'due') return s !== 'new' && dayNumber(c.due) <= t;
        if (v === 'suspended') return !!c.suspended;
        if (v === 'buried') return c.buriedUntil !== undefined && c.buriedUntil >= t;
        if (v === 'leech') return !!c.leech;
        return false;
      };
    } else {
      const w = tok.toLowerCase();
      f = (c) => text(c).includes(w) || tags(c).some((x) => x.toLowerCase().includes(w));
    }
    return neg ? (c: StudyCard) => !f(c) : f;
  });
  return data.cards.filter((c) => tests.every((f) => f(c)));
}

// ---- resources ----------------------------------------------------------------------------------

/**
 * goodink 2.6–2.8 kept links, videos and PDFs in a list of their own. They now live in library folders
 * like notebooks: links and videos keep their ids (cards made from them still point at them), PDFs
 * become PDF notebooks.
 */
async function moveResourcesToLibrary(data: StudyData): Promise<StudyData> {
  if (!data.resources.length) return data;
  const app = useApp.getState();
  const have = new Set((app.library.links ?? []).map((x) => x.id));
  let notes = data.notes;
  for (const r of data.resources) {
    if ((r.kind === 'link' || r.kind === 'youtube') && r.url && !have.has(r.id)) {
      addLink({ id: r.id, kind: r.kind, title: r.title, url: r.url, author: r.author, folderId: null });
    } else if (r.kind === 'pdf' && r.file) {
      try {
        const bytes = await getStudyFile(r.file.id, r.file.ext);
        const path = await api.pathForFile(new File([bytes], `${r.title}.pdf`, { type: 'application/pdf' }));
        const nbId = await importPdfFile(path, null, false);
        if (nbId) notes = notes.map((n) => (n.source?.id === r.id ? { ...n, source: { kind: 'notebook', id: nbId, label: n.source.label } } : n));
      } catch {
        continue; // keep it in the old list; it is tried again next time
      }
    }
  }
  return { ...data, notes, resources: [] };
}

/** The deck of a library folder; made on first use, named after the folder path ("Chemistry::Organic"). */
export function folderDeck(folderId: string, create = false): Deck | undefined {
  const have = get().data.decks.find((d) => d.folderId === folderId);
  if (have || !create) return have;
  const name = folderPath(folderId).map((f) => f.title.replace(/::/g, ':')).join('::') || 'Folder';
  const existing = get().data.decks.find((d) => !d.folderId && d.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    mutate((d) => ({ ...d, decks: d.decks.map((x) => (x.id === existing.id ? { ...x, folderId } : x)) }));
    return { ...existing, folderId };
  }
  const deck: Deck = { id: uid(), name: uniqueDeckName(get().data.decks, name), created: Date.now(), options: {}, folderId };
  mutate((d) => ({ ...d, decks: [...d.decks, deck] }));
  return deck;
}

export const getStudyFile = async (id: string, ext: string) => new Uint8Array(await invoke<ArrayBuffer>('study_file_get', { id, ext }));
