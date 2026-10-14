// Study: an Anki-style flashcard environment inside goodink. Decks → Overview → Review, Add, Browse,
// Stats, plus Resources (notebooks, links, PDFs) that the AI turns into cards.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Settings2, Plus, Search, Trash2, Link as LinkIcon, MonitorPlay, ChevronRight, FolderPlus, FolderOpen, Folder as FolderIcon, BookOpen, Sparkles, ChevronLeft, MoreHorizontal, Flag, Undo2, Pencil, Upload, GraduationCap, Lock,
} from 'lucide-react';
import { useApp, toast, openNotebook, getSession, confirmDialog, showSection, folderPath, findLink, openLink, importPdfFile, createFolder, openDialog } from '../lib/store';
import { api } from '../lib/api';
import { Button, Field, IconButton, Menu, Modal, Spinner, type MenuItem } from '../ui/primitives';
import { dayNumber, formatDays, formatSecs, nextCard, normalize, previews, ANKI_DEFAULTS, type Grade, type SrsConfig } from '../engine/srs';
import { renderPageToCanvas } from '../engine/render';
import { aiError, choiceFrom, generateCards, generateCardsFromText, generateCardsFromVideo, readyProviders, PROVIDERS, type AiChoice, type Card, type PageImage } from '../lib/ai';
import { CardDrafts, FreeAiSetup, ModelPicker, PageScope, Working, batch, pageImage, resolvePages, useAi } from '../editor/AiDialogs';
import { youtubeId, youtubeTranscript, youtubeUrl } from './youtube';
import { fetchPage, domainOf } from '../lib/web';
import { AddLinkDialog } from '../library/LinkDialogs';
import { FindSourcesDialog } from './FindSources';
import {
  useStudy, loadStudy, deckTree, deckLeaf, deckDepth, deckQueue, deckConfig, subdeckIds, createDeck, renameDeck, deleteDeck, setDeckOptions, addBasic, updateCards,
  deleteCards, forgetCards, buryCards, answerCard, undoAnswer, cardHtml, plainSides, searchCards, isAvailable, folderDeck, noteOf, typeOf, cardName,
  type Deck, type StudyCard,
} from './model';
import { CardHtml } from './CardHtml';
import { AddWindow, NoteEdit } from './AddNote';

type View =
  | { t: 'decks' }
  | { t: 'overview'; deck: string }
  | { t: 'review'; deck: string }
  | { t: 'add'; deck?: string }
  | { t: 'browse'; query?: string }
  | { t: 'stats' }
  | { t: 'folders' };

type MakeSource = { kind: 'notebook'; id: string } | { kind: 'link' | 'youtube'; id: string };

export function StudyApp() {
  const ready = useStudy((s) => s.ready);
  // Study opens on the decks, like Anki; "Study this folder" opens the folders view instead
  const [view, setView] = useState<View>({ t: 'decks' });
  const [make, setMake] = useState<MakeSource | null>(null);
  const [find, setFind] = useState<{ notebookId?: string; topic?: string; folderId?: string | null } | null>(null);
  const request = useApp((s) => s.studyRequest);

  useEffect(() => {
    void loadStudy();
  }, []);
  // "Make flashcards in Study…" from a notebook menu
  useEffect(() => {
    if (!request || !ready) return;
    setView({ t: 'folders' });
    if (request.kind === 'folder') return void useApp.setState({ studyRequest: null });
    const link = findLink(request.id);
    if (request.kind === 'sources') setFind(link ? { topic: link.title, folderId: link.folderId } : { notebookId: request.id });
    else setMake(link ? { kind: link.kind, id: link.id } : { kind: 'notebook', id: request.id });
    useApp.setState({ studyRequest: null });
  }, [request, ready]);

  if (!ready) return <div className="editor-msg"><Spinner size={22} /></div>;
  const tab = view.t === 'overview' || view.t === 'review' ? 'decks' : view.t;
  const tabs: { id: View['t']; label: string }[] = [
    { id: 'decks', label: 'Decks' },
    { id: 'folders', label: 'Folders' },
    { id: 'add', label: 'Add' },
    { id: 'browse', label: 'Browse' },
    { id: 'stats', label: 'Stats' },
  ];
  return (
    <div className="study-app">
      {view.t !== 'review' && (
        <nav className="st-nav" aria-label="Study">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={`st-tab ${tab === t.id ? 'is-active' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setView({ t: t.id } as View)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <div className="st-body">
        {view.t === 'decks' && <DecksView open={(deck) => setView({ t: 'overview', deck })} go={setView} />}
        {view.t === 'overview' && <Overview deckId={view.deck} go={setView} />}
        {view.t === 'review' && <Review deckId={view.deck} done={() => setView({ t: 'overview', deck: view.deck })} />}
        {view.t === 'add' && <AddWindow key={view.deck ?? ''} initialDeck={view.deck} onClose={() => setView({ t: 'decks' })} onBrowse={(query) => setView({ t: 'browse', query })} />}
        {view.t === 'browse' && <BrowseView initialQuery={view.query ?? ''} />}
        {view.t === 'stats' && <StatsView />}
        {view.t === 'folders' && <FoldersView go={setView} onMake={setMake} onFind={(o) => setFind(o)} />}
      </div>
      {make && <MakeCardsDialog source={make} onClose={() => setMake(null)} />}
      {find && <FindSourcesDialog notebookId={find.notebookId} topic={find.topic} folderId={find.folderId} onClose={() => setFind(null)} />}
    </div>
  );
}

// ---- decks --------------------------------------------------------------------------------------

function useDeckCounts() {
  const data = useStudy((s) => s.data);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => new Map(data.decks.map((d) => [d.id, deckQueue(d.id, now).counts])), [data, now]);
}

function todayStats() {
  const { revlog } = useStudy.getState().data;
  const t = dayNumber(Date.now());
  const today = revlog.filter((r) => dayNumber(r.t) === t);
  return { count: today.length, again: today.filter((r) => r.grade === 1).length };
}

function DecksView({ open, go }: { open: (deck: string) => void; go: (v: View) => void }) {
  const decks = useStudy((s) => s.data.decks);
  const counts = useDeckCounts();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<{ t: 'new' } | { t: 'rename'; deck: Deck } | { t: 'options'; deck: Deck } | null>(null);
  const stats = todayStats();
  const tree = deckTree(decks);
  const gear = (d: Deck, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 200,
      y: r.bottom + 4,
      items: [
        { label: 'Rename', icon: <Pencil size={15} />, run: () => setDialog({ t: 'rename', deck: d }) },
        { label: 'Options', icon: <Settings2 size={15} />, run: () => setDialog({ t: 'options', deck: d }) },
        { label: 'Browse cards', icon: <Search size={15} />, run: () => go({ t: 'browse', query: `deck:"${d.name}"` }) },
        { separator: true, label: '' },
        { label: 'Delete', icon: <Trash2 size={15} />, danger: true, run: () => confirmDialog(`Delete “${d.name}”?`, 'The deck, its subdecks and all their cards will be deleted. This cannot be undone.', 'Delete', () => deleteDeck(d.id)) },
      ],
    });
  };
  return (
    <div className="st-page">
      <table className="st-decks">
        <thead>
          <tr>
            <th scope="col">Deck</th>
            <th scope="col" className="num">New</th>
            <th scope="col" className="num">Learn</th>
            <th scope="col" className="num">Due</th>
            <th scope="col" aria-label="Deck options" />
          </tr>
        </thead>
        <tbody>
          {tree.map((d) => {
            const c = counts.get(d.id);
            return (
              <tr key={d.id}>
                <td>
                  <button type="button" className="st-deck-name" style={{ paddingLeft: 8 + deckDepth(d) * 20 }} onClick={() => open(d.id)}>
                    {deckLeaf(d)}
                  </button>
                </td>
                <Count n={c?.new ?? 0} kind="new" />
                <Count n={c?.learning ?? 0} kind="learn" />
                <Count n={c?.review ?? 0} kind="review" />
                <td className="st-gear">
                  <IconButton label={`Options for ${d.name}`} onClick={(e) => gear(d, e)}>
                    <Settings2 size={16} />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="st-today">{stats.count ? `Studied ${stats.count} card${stats.count === 1 ? '' : 's'} today${stats.count ? ` · ${Math.round(((stats.count - stats.again) / stats.count) * 100)}% correct` : ''}.` : 'No cards studied today.'}</p>
      <div className="st-actions">
        <Button onClick={() => setDialog({ t: 'new' })}>
          <Plus size={16} /> Create deck
        </Button>
        <Button onClick={() => go({ t: 'folders' })}>
          <Sparkles size={16} /> Make cards from resources
        </Button>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {dialog?.t === 'new' && <NameDialog title="Create deck" initial="" hint="Use “::” for a subdeck, for example Chemistry::Organic." onSave={(n) => createDeck(n)} onClose={() => setDialog(null)} />}
      {dialog?.t === 'rename' && <NameDialog title="Rename deck" initial={dialog.deck.name} onSave={(n) => renameDeck(dialog.deck.id, n)} onClose={() => setDialog(null)} />}
      {dialog?.t === 'options' && <DeckOptions deck={dialog.deck} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Count({ n, kind }: { n: number; kind: 'new' | 'learn' | 'review' }) {
  return <td className={`num st-count c-${kind} ${n ? '' : 'is-zero'}`}>{n}</td>;
}

function NameDialog({ title, initial, hint, onSave, onClose }: { title: string; initial: string; hint?: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const save = () => {
    if (!name.trim()) return;
    onSave(name.trim());
    onClose();
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={save}>Save</Button></>}>
      <Field label="Name" hint={hint}>
        <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </Field>
    </Modal>
  );
}

// ---- deck options (Anki's options screen, the fields that matter) ------------------------------

const stepsText = (s: number[]) => s.map((m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join(' ');
function parseSteps(t: string): number[] | null {
  const out: number[] = [];
  for (const part of t.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(part);
    if (!m) return null;
    const v = +m[1];
    out.push(m[2] === 's' ? v / 60 : m[2] === 'h' ? v * 60 : m[2] === 'd' ? v * 1440 : v);
  }
  return out;
}

function DeckOptions({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const [o, setO] = useState<SrsConfig>(deckConfig(deck));
  const [learn, setLearn] = useState(stepsText(o.learnSteps));
  const [relearn, setRelearn] = useState(stepsText(o.relearnSteps));
  const num = (k: keyof SrsConfig, label: string, hint: string, step = 1, scale = 1) => (
    <Field label={label} hint={hint}>
      <input className="input" type="number" step={step} value={+((o[k] as number) * scale).toFixed(2)} onChange={(e) => setO({ ...o, [k]: +e.target.value / scale })} />
    </Field>
  );
  const save = () => {
    const ls = parseSteps(learn), rs = parseSteps(relearn);
    if (!ls || !rs) return toast('Write steps like “1m 10m” or “10m 1d”.', { kind: 'error' });
    const full = { ...o, learnSteps: ls, relearnSteps: rs };
    // store only what differs from Anki's defaults
    const diff = Object.fromEntries(Object.entries(full).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(ANKI_DEFAULTS[k as keyof SrsConfig]))) as Partial<SrsConfig>;
    setDeckOptions(deck.id, diff);
    onClose();
  };
  return (
    <Modal
      title={`Options · ${deck.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => { setO(ANKI_DEFAULTS); setLearn(stepsText(ANKI_DEFAULTS.learnSteps)); setRelearn(stepsText(ANKI_DEFAULTS.relearnSteps)); }}>Restore Anki defaults</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="st-options">
        <section>
          <h3>Daily limits</h3>
          {num('newPerDay', 'New cards/day', 'How many new cards to introduce each day.')}
          {num('reviewsPerDay', 'Maximum reviews/day', 'Reviews beyond this wait for the next day.')}
        </section>
        <section>
          <h3>New cards</h3>
          <Field label="Learning steps" hint="Delays before a new card graduates, e.g. 1m 10m.">
            <input className="input" value={learn} onChange={(e) => setLearn(e.target.value)} />
          </Field>
          {num('graduatingGood', 'Graduating interval (days)', 'Interval after the last learning step.')}
          {num('graduatingEasy', 'Easy interval (days)', 'Interval when you press Easy on a new card.')}
        </section>
        <section>
          <h3>Lapses</h3>
          <Field label="Relearning steps" hint="Delays after you forget a review card.">
            <input className="input" value={relearn} onChange={(e) => setRelearn(e.target.value)} />
          </Field>
          {num('minLapseInterval', 'Minimum interval (days)', 'Shortest interval after relearning.')}
          {num('leechThreshold', 'Leech threshold', 'Lapses before a card is tagged as a leech.')}
        </section>
        <section>
          <h3>Advanced</h3>
          {num('maxInterval', 'Maximum interval (days)', 'Longest a card can wait.')}
          {num('initialEase', 'Starting ease (%)', 'Ease of a new card when it graduates.', 1, 100)}
          {num('easyBonus', 'Easy bonus (%)', 'Extra growth when you press Easy.', 1, 100)}
          {num('intervalModifier', 'Interval modifier (%)', 'Scales every review interval.', 1, 100)}
          {num('hardMultiplier', 'Hard interval (%)', 'Growth when you press Hard.', 1, 100)}
          {num('lapseMultiplier', 'New interval (%)', 'Share of the old interval kept after a lapse.', 1, 100)}
        </section>
      </div>
    </Modal>
  );
}

// ---- overview & review --------------------------------------------------------------------------

function Overview({ deckId, go }: { deckId: string; go: (v: View) => void }) {
  const deck = useStudy((s) => s.data.decks.find((d) => d.id === deckId));
  useStudy((s) => s.data.cards);
  const [opts, setOpts] = useState(false);
  if (!deck) return null;
  const q = deckQueue(deckId);
  const c = q.counts;
  const any = c.new + c.learning + c.review > 0;
  return (
    <div className="st-page st-overview">
      <button type="button" className="st-back" onClick={() => go({ t: 'decks' })}>
        <ChevronLeft size={16} /> Decks
      </button>
      <h1>{deck.name}</h1>
      <table className="st-ov-counts">
        <tbody>
          <tr><th scope="row">New</th><Count n={c.new} kind="new" /></tr>
          <tr><th scope="row">Learning</th><Count n={c.learning} kind="learn" /></tr>
          <tr><th scope="row">To review</th><Count n={c.review} kind="review" /></tr>
        </tbody>
      </table>
      {any ? (
        <Button variant="primary" size="lg" data-autofocus onClick={() => go({ t: 'review', deck: deckId })}>
          Study now
        </Button>
      ) : (
        <p className="st-congrats">{q.nextLearnAt ? `Congratulations! A learning card comes back in ${formatSecs(Math.max(60, (q.nextLearnAt - Date.now()) / 1000))}.` : 'Congratulations! You have finished this deck for now.'}</p>
      )}
      <div className="st-actions">
        <Button variant="ghost" onClick={() => setOpts(true)}><Settings2 size={16} /> Options</Button>
        <Button variant="ghost" onClick={() => go({ t: 'add', deck: deckId })}><Plus size={16} /> Add cards</Button>
        <Button variant="ghost" onClick={() => go({ t: 'browse', query: `deck:"${deck.name}"` })}><Search size={16} /> Browse</Button>
      </div>
      {opts && <DeckOptions deck={deck} onClose={() => setOpts(false)} />}
    </div>
  );
}

function Review({ deckId, done }: { deckId: string; done: () => void }) {
  const data = useStudy((s) => s.data);
  const [now, setNow] = useState(Date.now());
  const [shown, setShown] = useState(false);
  const typed = useRef('');
  const [edit, setEdit] = useState<StudyCard | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const queue = useMemo(() => deckQueue(deckId, now), [deckId, now, data]);
  const card = nextCard(queue) as StudyCard | null;
  const full = card ? data.cards.find((c) => c.id === card.id) ?? null : null;
  const deck = data.decks.find((d) => d.id === deckId);
  const labels = useMemo(() => (full ? previews(full, now, deckConfig(deck)) : []), [full, now, deck]);

  useEffect(() => {
    setShown(false);
    typed.current = '';
  }, [full?.id, full?.reps]);
  useEffect(() => {
    if (full || !queue.nextLearnAt) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(1000, queue.nextLearnAt - Date.now() - deckConfig(deck).learnAheadMins * 60_000));
    return () => clearTimeout(t);
  }, [full, queue.nextLearnAt, deck]);
  // toasts move above the answer bar while reviewing
  useEffect(() => {
    document.body.classList.add('is-reviewing');
    return () => document.body.classList.remove('is-reviewing');
  }, []);

  const rate = (g: Grade) => {
    if (!full) return;
    const t = Date.now();
    const r = answerCard(deckId, full, g, t);
    if (r.leechNow) toast('This card is a leech: you keep forgetting it. It was tagged “leech”; consider rewriting it.', { kind: 'error', ms: 7000 });
    setNow(t);
  };
  const undo = () => {
    if (undoAnswer()) setNow(Date.now());
    else toast('Nothing to undo');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the type-in-the-answer box lives in the card's shadow root: look at the real target
      const target = (e.composedPath()[0] ?? e.target) as HTMLElement;
      if (edit || menu || target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') return e.preventDefault(), undo();
      if (e.ctrlKey || e.altKey || e.metaKey || !full) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!shown) setShown(true);
        else rate(3);
      } else if (shown && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        rate(+e.key as Grade);
      } else if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setEdit(full);
      } else if (e.key === '-') {
        buryCards([full.id]);
        setNow(Date.now());
      } else if (e.key === '@') {
        updateCards([full.id], { suspended: true });
        setNow(Date.now());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const more = (e: React.MouseEvent) => {
    if (!full) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const flag = (n: number, label: string): MenuItem => ({ label, checked: (full.flag ?? 0) === n, run: () => updateCards([full.id], { flag: (full.flag ?? 0) === n ? 0 : n }) });
    setMenu({
      x: r.right - 220,
      y: r.top - 8 - 300,
      items: [
        flag(1, 'Red flag'), flag(2, 'Orange flag'), flag(3, 'Green flag'), flag(4, 'Blue flag'),
        { separator: true, label: '' },
        { label: 'Bury card', shortcut: '-', run: () => { buryCards([full.id]); setNow(Date.now()); } },
        { label: 'Suspend card', shortcut: '@', run: () => { updateCards([full.id], { suspended: true }); setNow(Date.now()); } },
        { label: 'Delete note', danger: true, run: () => { deleteCards([full.id]); setNow(Date.now()); } },
        { separator: true, label: '' },
        { label: 'Undo last answer', shortcut: 'Ctrl+Z', icon: <Undo2 size={15} />, run: undo },
      ],
    });
  };

  return (
    <div className="st-review">
      <header className="st-rv-head">
        <button type="button" className="st-back" onClick={done}>
          <ChevronLeft size={16} /> {deck?.name}
        </button>
        {full?.flag ? <Flag size={16} className={`st-flag f-${full.flag}`} aria-label="Flagged" /> : null}
      </header>
      <div className="st-rv-card">
        {full ? (
          <CardFace card={full} answer={shown} typed={typed.current} onTyped={(v) => (typed.current = v)} onTypeEnter={(v) => { typed.current = v; setShown(true); }} />
        ) : (
          <div className="empty">
            <GraduationCap size={30} />
            <h2>Congratulations! You have finished this deck for now.</h2>
            <p>{queue.nextLearnAt ? `A learning card comes back in ${formatSecs(Math.max(60, (queue.nextLearnAt - now) / 1000))}. Keep this open and it will appear.` : 'Come back tomorrow for the next reviews.'}</p>
            <Button onClick={done}>Back to the deck</Button>
          </div>
        )}
      </div>
      {full && (
        <footer className="st-rv-bar">
          <Button variant="ghost" onClick={() => setEdit(full)} title="Edit (E)"><Pencil size={15} /> Edit</Button>
          <div className="st-rv-center">
            <div className="st-rv-counts" aria-label="Cards left">
              <span className={`c-new ${normalize(full).state === 'new' ? 'is-cur' : ''}`}>{queue.counts.new}</span>
              <span className={`c-learn ${['learning', 'relearning'].includes(normalize(full).state) ? 'is-cur' : ''}`}>{queue.counts.learning}</span>
              <span className={`c-review ${normalize(full).state === 'review' ? 'is-cur' : ''}`}>{queue.counts.review}</span>
            </div>
            {!shown ? (
              <Button variant="primary" size="lg" onClick={() => setShown(true)} data-autofocus>
                Show answer <kbd>Space</kbd>
              </Button>
            ) : (
              <div className="study-rate">
                {(['Again', 'Hard', 'Good', 'Easy'] as const).map((label, i) => (
                  <button key={label} type="button" className={`study-grade g-${i + 1}`} onClick={() => rate((i + 1) as Grade)} title={`${label} (${i + 1})`}>
                    <span className="study-ivl">{labels[i]}</span>
                    <span className="study-label">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button variant="ghost" onClick={more}><MoreHorizontal size={16} /> More</Button>
        </footer>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {edit && <EditNote card={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** A card side as its note type shows it. Handwritten cards carried over from notebook decks show their page. */
function CardFace({ card, answer, typed, onTyped, onTypeEnter }: { card: StudyCard; answer: boolean; typed?: string; onTyped?: (v: string) => void; onTypeEnter?: (v: string) => void }) {
  const data = useStudy((s) => s.data);
  const { html, css, note } = useMemo(() => cardHtml(card, answer ? 'a' : 'q', { typed }, data), [card, answer, typed, data]);
  if (note?.page) return <PageFace nb={note.page.nb} page={note.page.page} answer={answer} />;
  return (
    <div className="st-face">
      <CardHtml html={html} css={css} autoplay onTyped={onTyped} onTypeEnter={onTypeEnter} label={answer ? 'Answer' : 'Question'} />
      {answer && note?.source && <div className="st-src">From {note.source.label}</div>}
    </div>
  );
}

const pageImageCache = new Map<string, string>();

function PageFace({ nb, page, answer }: { nb: string; page: string; answer: boolean }) {
  const [src, setSrc] = useState<string | null>(pageImageCache.get(`${nb}:${page}`) ?? null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const key = `${nb}:${page}`;
    if (pageImageCache.has(key)) return setSrc(pageImageCache.get(key)!);
    let live = true;
    getSession(nb)
      .then(async (s) => {
        const p = s.page(page);
        if (!p) throw new Error('gone');
        const c = await renderPageToCanvas(p, await s.ensure(p.id), 900, s);
        const url = URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
        pageImageCache.set(key, url);
        if (live) setSrc(url);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [nb, page]);
  if (missing) return <div className="st-face"><p className="muted">This card’s notebook page is no longer available.</p></div>;
  return <div className={`study-card st-page-card ${answer ? 'is-shown' : ''}`}>{src ? <img src={src} alt="Handwritten card" /> : <Spinner size={24} />}</div>;
}

function EditNote({ card, onClose }: { card: StudyCard; onClose: () => void }) {
  return (
    <Modal title="Edit note" size="lg" onClose={onClose}>
      <NoteEdit card={card} onDone={onClose} />
    </Modal>
  );
}

// ---- add ----------------------------------------------------------------------------------------

function DeckSelect({ decks, value, onChange, extra }: { decks: Deck[]; value: string; onChange: (id: string) => void; extra?: ReactNode }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {deckTree(decks).map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
      {extra}
    </select>
  );
}

// ---- browse -------------------------------------------------------------------------------------

function dueText(c: StudyCard) {
  const n = normalize(c);
  if (c.suspended) return 'Suspended';
  if (n.state === 'new') return 'New';
  if (n.state === 'learning' || n.state === 'relearning') return 'Learning';
  return new Date(c.due).toLocaleDateString();
}

function BrowseView({ initialQuery }: { initialQuery: string }) {
  const data = useStudy((s) => s.data);
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const results = useMemo(() => searchCards(data, query), [data, query]);
  const card = data.cards.find((c) => c.id === sel) ?? null;
  const tags = useMemo(() => [...new Set(data.notes.flatMap((n) => n.tags))].sort(), [data.notes]);
  const deckName = (id: string) => data.decks.find((d) => d.id === id)?.name ?? '';
  const targets = checked.size ? [...checked] : sel ? [sel] : [];
  const side = (label: string, q: string) => (
    <button key={q} type="button" className={`st-side-item ${query === q ? 'is-on' : ''}`} onClick={() => setQuery(q)}>
      {label}
    </button>
  );
  return (
    <div className="st-browse">
      <aside className="st-side" aria-label="Filters">
        {side('All cards', '')}
        {side('Due today', 'is:due')}
        <h4>Decks</h4>
        {deckTree(data.decks).map((d) => side(deckLeaf(d), `deck:"${d.name}"`))}
        <h4>Card state</h4>
        {side('New', 'is:new')}
        {side('Learning', 'is:learn')}
        {side('Review', 'is:review')}
        {side('Suspended', 'is:suspended')}
        {side('Buried', 'is:buried')}
        {side('Leeches', 'is:leech')}
        <h4>Flags</h4>
        {['Red', 'Orange', 'Green', 'Blue'].map((f, i) => side(f, `flag:${i + 1}`))}
        {tags.length > 0 && <h4>Tags</h4>}
        {tags.map((t) => side(t, `tag:${t}`))}
      </aside>
      <section className="st-browse-main">
        <div className="st-search">
          <Search size={16} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder='Search: words, deck:"Name", tag:x, is:due, is:new, flag:1, -word' aria-label="Search cards" />
          <span className="muted small">{results.length} card{results.length === 1 ? '' : 's'}</span>
        </div>
        <div className="st-bulk" role="toolbar" aria-label="Card actions">
          <span className="muted small">{targets.length ? `${targets.length} selected` : 'Select cards to change them'}</span>
          <Button size="sm" disabled={!targets.length} onClick={() => { const all = targets.every((id) => data.cards.find((c) => c.id === id)?.suspended); updateCards(targets, { suspended: !all }); }}>Suspend / unsuspend</Button>
          <Button size="sm" disabled={!targets.length} onClick={() => forgetCards(targets)}>Forget</Button>
          <select className="input input-sm" aria-label="Move to deck" disabled={!targets.length} value="" onChange={(e) => e.target.value && updateCards(targets, { deckId: e.target.value })}>
            <option value="">Change deck…</option>
            {deckTree(data.decks).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <Button size="sm" variant="danger" disabled={!targets.length} onClick={() => confirmDialog(`Delete ${targets.length} card${targets.length === 1 ? '' : 's'}?`, 'Their notes and all cards of those notes are deleted. This cannot be undone.', 'Delete', () => { deleteCards(targets); setChecked(new Set()); setSel(null); })}>Delete</Button>
        </div>
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th scope="col"><input type="checkbox" aria-label="Select all" checked={!!results.length && results.every((c) => checked.has(c.id))} onChange={(e) => setChecked(e.target.checked ? new Set(results.map((c) => c.id)) : new Set())} /></th>
                <th scope="col">Question</th>
                <th scope="col">Answer</th>
                <th scope="col">Card</th>
                <th scope="col">Deck</th>
                <th scope="col">Due</th>
                <th scope="col" className="num">Interval</th>
                <th scope="col" className="num">Ease</th>
                <th scope="col" className="num">Reviews</th>
                <th scope="col" className="num">Lapses</th>
              </tr>
            </thead>
            <tbody>
              {results.slice(0, 1000).map((c) => {
                const p = plainSides(c, data);
                const nt = typeOf(noteOf(c, data), data);
                const n = normalize(c);
                return (
                  <tr
                    key={c.id}
                    className={`${sel === c.id ? 'is-sel' : ''} ${c.suspended ? 'is-susp' : ''} ${c.flag ? `flag-${c.flag}` : ''}`}
                    tabIndex={0}
                    aria-selected={sel === c.id}
                    onClick={() => setSel(c.id)}
                    onKeyDown={(e) => {
                      // keyboard: Enter/Space select, arrows walk the list, Space with Ctrl ticks the box
                      const rows = results.slice(0, 1000);
                      const k = rows.findIndex((x) => x.id === c.id);
                      const go = (j: number) => {
                        const next = rows[Math.max(0, Math.min(rows.length - 1, j))];
                        setSel(next.id);
                        (e.currentTarget.parentElement?.children[rows.indexOf(next)] as HTMLElement | undefined)?.focus();
                      };
                      if (e.key === 'ArrowDown') go(k + 1);
                      else if (e.key === 'ArrowUp') go(k - 1);
                      else if (e.key === ' ' && e.ctrlKey) {
                        const s2 = new Set(checked);
                        if (s2.has(c.id)) s2.delete(c.id);
                        else s2.add(c.id);
                        setChecked(s2);
                      } else if (e.key === 'Enter' || e.key === ' ') setSel(c.id);
                      else if (e.key === 'Delete') confirmDialog('Delete this card?', 'Its note and all cards of that note are deleted. This cannot be undone.', 'Delete', () => { deleteCards([c.id]); setSel(null); });
                      else return;
                      e.preventDefault();
                    }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Select card" checked={checked.has(c.id)} onChange={(e) => { const s = new Set(checked); if (e.target.checked) s.add(c.id); else s.delete(c.id); setChecked(s); }} />
                    </td>
                    <td className="ellipsis">{p.q || <i className="muted">{noteOf(c, data)?.page ? 'handwritten page' : '(empty)'}</i>}</td>
                    <td className="ellipsis">{p.a}</td>
                    <td className="ellipsis">{nt.name}: {cardName(nt, c.ord)}</td>
                    <td className="ellipsis">{deckName(c.deckId)}</td>
                    <td>{dueText(c)}</td>
                    <td className="num">{n.state === 'review' || n.state === 'relearning' ? formatDays(n.interval) : '–'}</td>
                    <td className="num">{n.state === 'new' ? '–' : `${Math.round(n.ease * 100)}%`}</td>
                    <td className="num">{n.reps}</td>
                    <td className="num">{n.lapses}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {results.length > 1000 && <p className="muted small st-more">Showing the first 1000 cards. Narrow the search to see more.</p>}
        </div>
        {card && <BrowseEditor key={card.id} card={card} />}
      </section>
    </div>
  );
}

function BrowseEditor({ card }: { card: StudyCard }) {
  return (
    <div className="st-editor">
      <NoteEdit card={card} autosave />
    </div>
  );
}

// ---- stats --------------------------------------------------------------------------------------

function StatsView() {
  const data = useStudy((s) => s.data);
  const [deck, setDeck] = useState('');
  const ids = useMemo(() => new Set(deck ? subdeckIds(data.decks, deck) : data.decks.map((d) => d.id)), [data.decks, deck]);
  const cards = data.cards.filter((c) => ids.has(c.deckId));
  const log = data.revlog.filter((r) => ids.has(r.deck));
  const now = Date.now();
  const t = dayNumber(now);
  const st = cards.map((c) => normalize(c));
  const counts = {
    New: st.filter((c) => c.state === 'new').length,
    Learning: st.filter((c) => c.state === 'learning' || c.state === 'relearning').length,
    Young: st.filter((c) => c.state === 'review' && c.interval < 21).length,
    Mature: st.filter((c) => c.state === 'review' && c.interval >= 21).length,
    Suspended: cards.filter((c) => c.suspended).length,
  };
  const today = log.filter((r) => dayNumber(r.t) === t);
  const correct = today.length ? Math.round((today.filter((r) => r.grade > 1).length / today.length) * 100) : null;
  const matureLog = log.filter((r) => r.kind === 'review' && r.lastIvl >= 21);
  const retention = matureLog.length ? Math.round((matureLog.filter((r) => r.grade > 1).length / matureLog.length) * 100) : null;
  const forecast = [...Array(30).keys()].map((i) => ({ label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `In ${i} days`, v: cards.filter((c) => isAvailable(c) && normalize(c).state !== 'new' && Math.max(t, dayNumber(c.due)) === t + i).length }));
  const history = [...Array(30).keys()].reverse().map((i) => ({ label: i === 0 ? 'Today' : `${i} day${i === 1 ? '' : 's'} ago`, v: log.filter((r) => dayNumber(r.t) === t - i).length }));
  const buttons = (['Again', 'Hard', 'Good', 'Easy'] as const).map((l, i) => ({ l, n: log.filter((r) => r.grade === i + 1).length }));
  return (
    <div className="st-page st-stats">
      <div className="st-add-row">
        <Field label="Deck">
          <select className="input" value={deck} onChange={(e) => setDeck(e.target.value)}>
            <option value="">All decks</option>
            {deckTree(data.decks).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
      <section>
        <h3>Today</h3>
        <div className="st-tiles">
          <Tile v={String(today.length)} l="Cards studied" />
          <Tile v={correct === null ? '–' : `${correct}%`} l="Correct" />
          <Tile v={retention === null ? '–' : `${retention}%`} l="Mature retention (all time)" />
          <Tile v={String(forecast[0].v)} l="Due today" />
        </div>
      </section>
      <section>
        <h3>Card counts</h3>
        <div className="st-tiles">
          {Object.entries(counts).map(([l, v]) => <Tile key={l} v={String(v)} l={l} />)}
        </div>
      </section>
      <BarChart title="Due in the next 30 days" data={forecast} unit="card" />
      <BarChart title="Reviews in the last 30 days" data={history} unit="review" />
      <section>
        <h3>Answer buttons (all time)</h3>
        <div className="st-tiles">
          {buttons.map((b) => <Tile key={b.l} v={String(b.n)} l={`${b.l}${log.length ? ` · ${Math.round((b.n / log.length) * 100)}%` : ''}`} />)}
        </div>
      </section>
    </div>
  );
}

function Tile({ v, l }: { v: string; l: string }) {
  return (
    <div className="st-tile">
      <span className="st-tile-v">{v}</span>
      <span className="st-tile-l">{l}</span>
    </div>
  );
}

/** One series: bars in the accent colour, a hover tooltip per bar, and the numbers as a table for screen readers. */
function BarChart({ title, data, unit }: { title: string; data: { label: string; v: number }[]; unit: string }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  const total = data.reduce((s, d) => s + d.v, 0);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <section className="st-chart">
      <h3>
        {title} <span className="muted small">· {total} {unit}{total === 1 ? '' : 's'}</span>
      </h3>
      <div className="st-bars" aria-hidden onMouseLeave={() => setHover(null)}>
        <span className="st-axis-max">{max}</span>
        {data.map((d, i) => (
          <div key={i} className={`st-bar-hit ${hover === i ? 'is-hover' : ''}`} onMouseEnter={() => setHover(i)}>
            <div className="st-bar" style={{ height: `${(d.v / max) * 100}%` }} />
          </div>
        ))}
        {hover !== null && (
          <div className="st-tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}>
            <strong>{data[hover].v}</strong> {unit}{data[hover].v === 1 ? '' : 's'} · {data[hover].label}
          </div>
        )}
      </div>
      <div className="st-bars-axis" aria-hidden>
        <span>{data[0].label}</span>
        <span>{data[data.length - 1].label}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}><th scope="row">{d.label}</th><td>{d.v}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- resources ----------------------------------------------------------------------------------

// ---- folders: the same folders as Files, with each folder's deck --------------------------------

function FoldersView({ go, onMake, onFind }: { go: (v: View) => void; onMake: (s: MakeSource) => void; onFind: (opts: { folderId: string | null }) => void }) {
  const folderId = useApp((s) => s.folderId);
  const library = useApp((s) => s.library);
  const data = useStudy((s) => s.data);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState(false);
  const folder = library.folders.find((f) => f.id === folderId && !f.deletedAt);
  const here = folder ? folder.id : null;
  const crumbs = folderPath(here);
  const sub = library.folders.filter((f) => f.parentId === here && !f.deletedAt).sort((a, b) => a.title.localeCompare(b.title));
  const notebooks = library.notebooks.filter((n) => n.folderId === here && !n.deletedAt && n.kind !== 'flashcards').sort((a, b) => b.updatedAt - a.updatedAt);
  const links = (library.links ?? []).filter((x) => x.folderId === here && !x.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const deck = here ? data.decks.find((d) => d.folderId === here) : undefined;
  const counts = deck ? deckQueue(deck.id).counts : null;
  const made = (id: string) => {
    const notes = new Set(data.notes.filter((n) => n.source?.id === id).map((n) => n.id));
    return data.cards.filter((c) => notes.has(c.noteId)).length;
  };
  const deckOf = (id: string) => data.decks.find((d) => d.folderId === id);
  const go2 = (id: string | null) => showSection('study', id);

  const importPdfs = async () => {
    const files = await api.openDialog({ title: 'Add PDF', filters: [{ name: 'PDF', extensions: ['pdf'] }], multi: true });
    for (const f of files) await importPdfFile(f, here, false);
  };

  return (
    <div className="st-page st-folders">
      <nav className="crumbs st-crumbs" aria-label="Folder path">
        <button type="button" onClick={() => go2(null)}>All folders</button>
        {crumbs.map((c, i) => (
          <span key={c.id}>
            <ChevronRight size={14} />
            {i === crumbs.length - 1 ? <strong>{c.title}</strong> : <button type="button" onClick={() => go2(c.id)}>{c.title}</button>}
          </span>
        ))}
      </nav>

      {folder && (
        <section className="st-folder-deck" aria-label="This folder's deck">
          <GraduationCap size={22} />
          <div className="st-fd-main">
            <strong>{deck ? deck.name : `No cards in “${folder.title}” yet`}</strong>
            {counts ? (
              <span className="st-fd-counts">
                <span className="c-new">{counts.new} new</span> · <span className="c-learn">{counts.learning} learning</span> · <span className="c-review">{counts.review} to review</span>
              </span>
            ) : (
              <span className="muted small">Make flashcards from the notebooks, pages and videos below; they are collected in this folder’s deck.</span>
            )}
          </div>
          {deck && (
            <>
              <Button variant="primary" onClick={() => go({ t: 'overview', deck: deck.id })}>Study now</Button>
              <Button variant="ghost" onClick={() => go({ t: 'add', deck: deck.id })}><Plus size={16} /> Add card</Button>
            </>
          )}
        </section>
      )}

      <div className="st-actions">
        <Button variant="primary" onClick={() => onFind({ folderId: here })}><Sparkles size={16} /> Find sources</Button>
        <Button onClick={() => setAdding(true)}><LinkIcon size={16} /> Add link or video</Button>
        <Button onClick={() => void importPdfs()}><Upload size={16} /> Add PDF</Button>
        <Button onClick={() => openDialog({ type: 'new-notebook', folderId: here })}><Plus size={16} /> Notebook</Button>
        <Button variant="ghost" onClick={() => setNaming(true)}><FolderPlus size={16} /> Folder</Button>
        <Button variant="ghost" onClick={() => showSection('all', here)}><FolderOpen size={16} /> Show in Files</Button>
      </div>

      {sub.length > 0 && (
        <section>
          <h3>Folders</h3>
          <ul className="st-res-list">
            {sub.map((f) => {
              const d = deckOf(f.id);
              const c = d ? deckQueue(d.id).counts : null;
              const n = library.notebooks.filter((x) => x.folderId === f.id && !x.deletedAt).length + (library.links ?? []).filter((x) => x.folderId === f.id && !x.deletedAt).length;
              return (
                <li key={f.id}>
                  <span className="st-res-icon" style={{ color: f.color }}><FolderIcon size={18} /></span>
                  <button type="button" className="st-res-main st-res-open" onClick={() => go2(f.id)}>
                    <span className="st-res-title ellipsis">{f.title}</span>
                    <span className="muted small">{n} item{n === 1 ? '' : 's'}{c ? ` · ${c.new + c.learning + c.review} cards to study` : ''}</span>
                  </button>
                  <ChevronRight size={18} className="muted" />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h3>{folder ? `In “${folder.title}”` : 'Not in a folder'}</h3>
        {!notebooks.length && !links.length && <p className="muted">Nothing here yet. Add a link, a video or a PDF, start a notebook, or let “Find sources” search for you.</p>}
        <ul className="st-res-list">
          {notebooks.map((n) => (
            <li key={n.id}>
              <span className="st-res-icon"><BookOpen size={18} /></span>
              <button type="button" className="st-res-main st-res-open" onClick={() => void openNotebook(n.id)} title="Open">
                <span className="st-res-title ellipsis">{n.title}</span>
                <span className="muted small">{n.kind === 'pdf' ? 'PDF' : 'Notebook'} · {n.pageCount} page{n.pageCount === 1 ? '' : 's'}{made(n.id) ? ` · ${made(n.id)} card${made(n.id) === 1 ? '' : 's'}` : ''}</span>
              </button>
              {n.lock ? <span className="muted small st-locked"><Lock size={14} /> Locked</span> : <Button size="sm" variant="primary" onClick={() => onMake({ kind: 'notebook', id: n.id })}><Sparkles size={14} /> Make flashcards</Button>}
            </li>
          ))}
          {links.map((k) => (
            <li key={k.id}>
              <span className="st-res-icon">{k.kind === 'youtube' ? <MonitorPlay size={18} /> : <LinkIcon size={18} />}</span>
              <button type="button" className="st-res-main st-res-open" onClick={() => openLink(k.id)} title="Open">
                <span className="st-res-title ellipsis">{k.title}</span>
                <span className="muted small ellipsis">{k.kind === 'youtube' ? `Video${k.author ? ` · ${k.author}` : ''}` : `Web page · ${domainOf(k.url)}`}{made(k.id) ? ` · ${made(k.id)} card${made(k.id) === 1 ? '' : 's'}` : ''}</span>
              </button>
              <Button size="sm" variant="primary" onClick={() => onMake({ kind: k.kind, id: k.id })}><Sparkles size={14} /> Make flashcards</Button>
            </li>
          ))}
        </ul>
      </section>
      {adding && <AddLinkDialog folderId={here} onClose={() => setAdding(false)} />}
      {naming && <NameDialog title="New folder" initial="" onSave={(name) => createFolder(name, here)} onClose={() => setNaming(false)} />}
    </div>
  );
}

type MakePhase = { t: 'setup' } | { t: 'working'; msg: string } | { t: 'cards'; cards: Card[]; notes: string[] };

function MakeCardsDialog({ source, onClose }: { source: MakeSource; onClose: () => void }) {
  const ai = useAi();
  const ready = readyProviders(ai);
  const decks = useStudy((s) => s.data.decks);
  const resource = useApp((s) => (source.kind === 'notebook' ? undefined : s.library.links?.find((r) => r.id === source.id)));
  const nb = useApp((s) => (source.kind === 'notebook' ? s.library.notebooks.find((n) => n.id === source.id) : undefined));
  const title = nb?.title ?? resource?.title ?? 'Source';
  const pageCount = nb?.pageCount ?? 0;
  const itemFolder = (nb ?? resource)?.folderId ?? null;
  const folderName = folderPath(itemFolder).map((f) => f.title).join(' / ');
  const existingFolderDeck = itemFolder ? decks.find((d) => d.folderId === itemFolder) : undefined;
  const [choice, setChoice] = useState<AiChoice>(() => choiceFrom(ai, ready.includes(ai.provider) ? ai.provider : ready[0] ?? ai.provider));
  // cards from a folder's item go to that folder's deck unless the user picks another
  const [deckSel, setDeckSel] = useState<string>(() => existingFolderDeck?.id ?? (itemFolder ? 'folder' : decks.find((d) => d.name.toLowerCase() === title.toLowerCase())?.id ?? 'new'));
  const [newName, setNewName] = useState(title.replace(/::/g, ':'));
  const [pagesSel, setPagesSel] = useState<{ scope: 'all' | 'current' | 'range'; range: string }>({ scope: 'all', range: '' });
  const [count, setCount] = useState('');
  const [focus, setFocus] = useState('');
  const [phase, setPhase] = useState<MakePhase>({ t: 'setup' });
  const runId = useRef(0);

  if (!ready.length) {
    return (
      <Modal title="Make flashcards" size="md" onClose={onClose}>
        <div className="empty">
          <Sparkles size={28} />
          <h2>Set up AI first</h2>
          <FreeAiSetup compact />
        </div>
      </Modal>
    );
  }

  const run = async () => {
    // a cancelled run keeps going in the background but may no longer change the dialog
    const my = ++runId.current;
    const set = (ph: Parameters<typeof setPhase>[0]) => runId.current === my && setPhase(ph);
    const progress = (msg: string) => set({ t: 'working', msg: `${msg} ${PROVIDERS[choice.provider].label} · ${choice.model}` });
    try {
      let r: { cards: Card[]; notes: string[] };
      if (source.kind === 'link') {
        set({ t: 'working', msg: 'Loading the page…' });
        const page = await fetchPage(resource!.url!);
        r = await generateCardsFromText(choice, title, page.text, { count: +count || undefined, focus }, progress);
      } else if (source.kind === 'youtube') {
        set({ t: 'working', msg: 'Reading the video’s captions…' });
        const id = youtubeId(resource!.url!)!;
        const tr = await youtubeTranscript(id).catch(() => null);
        if (tr) {
          r = await generateCardsFromText(choice, `${title} (YouTube video transcript${tr.automatic ? ', automatic captions' : ''})`, tr.text, { count: +count || undefined, focus }, progress);
        } else {
          r = await generateCardsFromVideo(choice, title, youtubeUrl(id), { count: +count || undefined, focus }, progress);
          r.notes.unshift('This video has no readable captions, so Gemini watched the video itself.');
        }
      } else {
        const pages = resolvePages(pageCount, undefined, pagesSel);
        if (!pages.length) return toast('Choose at least one page.', { kind: 'error' });
        let imgs: PageImage[];
        if (source.kind === 'notebook') {
          const s = await getSession(source.id);
          imgs = [];
          for (const [k, i] of pages.entries()) {
            set({ t: 'working', msg: `Preparing page ${k + 1} of ${pages.length}…` });
            imgs.push(await pageImage(s, s.pages[i], i + 1));
          }
        } else return;
        r = await generateCards(choice, title, batch(imgs), { count: +count || undefined, focus }, progress);
      }
      if (!r.cards.length) throw new Error('The model found nothing to turn into flashcards.');
      set({ t: 'cards', cards: r.cards, notes: r.notes });
    } catch (e) {
      set({ t: 'setup' });
      toast(aiError(e), { kind: 'error', ms: 9000 });
    }
  };

  const save = (cards: Card[]) => {
    const deckId = deckSel === 'new' ? createDeck(newName).id : deckSel === 'folder' && itemFolder ? folderDeck(itemFolder, true)!.id : deckSel;
    const src = { kind: source.kind, id: source.id, label: title } as const;
    for (const c of cards) addBasic(deckId, c.front, c.back, ['ai'], src);
    const name = useStudy.getState().data.decks.find((d) => d.id === deckId)?.name;
    toast(`Added ${cards.length} card${cards.length === 1 ? '' : 's'} to “${name}”`, { kind: 'success' });
    onClose();
  };

  const footer =
    phase.t === 'setup' ? (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void run()} disabled={!choice.model || (deckSel === 'new' && !newName.trim())}>
          <Sparkles size={16} /> Make flashcards
        </Button>
      </>
    ) : phase.t === 'cards' ? (
      <>
        <Button variant="ghost" onClick={() => setPhase({ t: 'setup' })}>Back</Button>
        <Button variant="primary" disabled={!phase.cards.length} onClick={() => save(phase.cards)}>
          Add {phase.cards.length} card{phase.cards.length === 1 ? '' : 's'}
        </Button>
      </>
    ) : undefined;

  return (
    <Modal title={`Make flashcards · ${title}`} size="lg" onClose={onClose} footer={footer} className="ai-dialog">
      {phase.t === 'setup' && (
        <div className="ai-setup">
          <div className="ai-col">
            <ModelPicker providers={ready} value={choice} onChange={setChoice} />
          </div>
          <div className="ai-col">
            <Field label="Add to deck">
              <DeckSelect decks={decks} value={deckSel} onChange={setDeckSel} extra={<>{itemFolder && !existingFolderDeck && <option value="folder">Deck of the folder “{folderName}” (new)</option>}<option value="new">New deck…</option></>} />
            </Field>
            {deckSel === 'new' && (
              <Field label="New deck name" hint="Use “::” for a subdeck.">
                <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
            )}
            {source.kind === 'notebook' && <PageScope count={pageCount} value={pagesSel} onChange={setPagesSel} />}
            <Field label="Number of cards" hint="Leave empty and the model makes as many as it needs to cover everything.">
              <input className="input" type="number" min={1} max={500} value={count} placeholder="Automatic" onChange={(e) => setCount(e.target.value)} />
            </Field>
            <Field label="Focus (optional)" hint="For example: “only the reaction mechanisms”, or “cards in English”.">
              <textarea className="input ai-focus" rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} />
            </Field>
          </div>
        </div>
      )}
      {phase.t === 'working' && <Working title="Making flashcards…" msg={phase.msg} onCancel={() => { runId.current++; setPhase({ t: 'setup' }); }} />}
      {phase.t === 'cards' && (
        <div className="ai-cards">
          {phase.notes.map((n) => <p key={n} className="lib-note">{n}</p>)}
          <p className="field-hint">Edit or remove cards, then add them. They become Basic notes tagged “ai” and are scheduled like Anki.</p>
          <CardDrafts cards={phase.cards} onChange={(cards) => setPhase({ ...phase, cards })} />
        </div>
      )}
    </Modal>
  );
}

