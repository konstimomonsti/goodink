// Find sources: search the web, Wikipedia and YouTube for a topic or for what a notebook covers,
// let the AI pick the best results, and add them to Study's resources.
import { lazy, Suspense, useRef, useState } from 'react';
import { ExternalLink, Eye, FileText, Globe, MonitorPlay, Search, Sparkles } from 'lucide-react';
import { useApp, toast, getSession, addLink, createFolder, folderPath, showSection } from '../lib/store';
import { FolderSelect } from '../library/LinkDialogs';
import { api } from '../lib/api';
import { Button, Field, IconButton, Modal, Segmented, Spinner } from '../ui/primitives';
const VideoView = lazy(() => import('../library/LinkView').then((m) => ({ default: m.VideoView })));
const WebPreview = lazy(() => import('../library/WebPreview').then((m) => ({ default: m.WebPreview })));
import { aiError, choiceFrom, rankSources, readyProviders, suggestSearch, PROVIDERS, type AiChoice, type PageImage } from '../lib/ai';
import { ModelPicker, Working, pageImage, useAi } from '../editor/AiDialogs';
import { findSources, type Found } from './search';

type Phase =
  | { t: 'setup' }
  | { t: 'working'; msg: string }
  | { t: 'results'; topic: string; found: Found[]; why: Map<number, string> | null; failed: string[]; queries: string[] };

/** Pages of a notebook the AI reads to know what to search for. */
const READ_PAGES = 20;

const KIND_ICON = { web: <Globe size={16} />, wikipedia: <FileText size={16} />, youtube: <MonitorPlay size={16} /> };

/** notebookId: search for what it covers; topic: start with this text; folderId: where results go (else the notebook's folder). */
export function FindSourcesDialog({ notebookId, topic: initialTopic, folderId, onClose }: { notebookId?: string; topic?: string; folderId?: string | null; onClose: () => void }) {
  const ai = useAi();
  const ready = readyProviders(ai);
  const notebooks = useApp((s) => s.library.notebooks);
  const links = useApp((s) => s.library.links);
  const usable = notebooks.filter((n) => !n.deletedAt && !n.lock && n.kind !== 'flashcards');
  const [mode, setMode] = useState<'topic' | 'notebook'>(notebookId ? 'notebook' : 'topic');
  const [topic, setTopic] = useState(initialTopic ?? '');
  const startFolder = folderId !== undefined ? folderId : (notebooks.find((n) => n.id === notebookId)?.folderId ?? useApp.getState().folderId);
  const [target, setTarget] = useState<string>(startFolder ?? '');
  const [nbId, setNbId] = useState(notebookId ?? usable[0]?.id ?? '');
  const [kinds, setKinds] = useState({ web: true, wikipedia: true, youtube: true });
  const [rank, setRank] = useState(true);
  const [choice, setChoice] = useState<AiChoice>(() => choiceFrom(ai, ready.includes(ai.provider) ? ai.provider : ready[0] ?? ai.provider));
  const [showModel, setShowModel] = useState(false);
  const [phase, setPhase] = useState<Phase>({ t: 'setup' });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // a result opens right here, before it is saved: reader view for pages, the player for videos
  const [preview, setPreview] = useState<number | null>(null);
  const runId = useRef(0);
  const have = new Set((links ?? []).filter((x) => !x.deletedAt).map((r) => r.url));
  const useAiNow = ready.length > 0;

  const run = async () => {
    const my = ++runId.current;
    const set = (ph: Phase) => runId.current === my && setPhase(ph);
    const say = (msg: string) => set({ t: 'working', msg });
    try {
      let queries: string[];
      let subject: string;
      let lang = (navigator.language || 'en').slice(0, 2);
      if (mode === 'notebook') {
        if (!useAiNow) throw new Error('Searching for a notebook needs AI to read it. Set up AI in Settings, or search for a topic instead.');
        const s = await getSession(nbId);
        const imgs: PageImage[] = [];
        const n = Math.min(READ_PAGES, s.pages.length);
        for (let i = 0; i < n; i++) {
          say(`Reading page ${i + 1} of ${n}…`);
          imgs.push(await pageImage(s, s.pages[i], i + 1));
        }
        say(`Working out what to search for… ${PROVIDERS[choice.provider].label}`);
        const sug = await suggestSearch(choice, s.meta.title, imgs, say);
        queries = sug.queries;
        subject = sug.topic;
        lang = sug.language || lang;
      } else {
        subject = topic.trim();
        if (!subject) return toast('Type a topic first.', { kind: 'error' });
        queries = [subject];
      }
      const { found, failed } = await findSources(queries, { ...kinds, lang }, say);
      if (!found.length) throw new Error(failed.length ? `The search did not answer (${failed.join(', ')}). Check your internet connection and try again.` : 'Nothing was found. Try other words.');
      let why: Map<number, string> | null = null;
      if (rank && useAiNow) {
        say(`Choosing the best of ${found.length} results… ${PROVIDERS[choice.provider].label}`);
        const picks = await rankSources(choice, subject, found, say).catch(() => null);
        if (picks?.length) why = new Map(picks.map((p) => [p.i, p.why]));
      }
      // AI picks first, in its order; the rest follow
      const order = why ? [...why.keys(), ...found.map((_, i) => i).filter((i) => !why!.has(i))] : found.map((_, i) => i);
      const sorted = order.map((i) => found[i]);
      const sortedWhy = why ? new Map([...why.entries()].map(([i, w]) => [order.indexOf(i), w])) : null;
      if (runId.current !== my) return;
      setPicked(new Set(sortedWhy ? [...sortedWhy.keys()] : sorted.slice(0, 8).map((_, i) => i)));
      set({ t: 'results', topic: subject, found: sorted, why: sortedWhy, failed, queries });
    } catch (e) {
      set({ t: 'setup' });
      toast(aiError(e), { kind: 'error', ms: 9000 });
    }
  };

  const add = () => {
    if (phase.t !== 'results') return;
    let n = 0;
    // "new" makes a folder named after the topic, inside the folder this was started from
    const dest = target === 'new' ? createFolder(phase.topic.slice(0, 60), startFolder ?? null) : target || null;
    for (const i of [...picked].sort((a, b) => a - b)) {
      const f = phase.found[i];
      if (have.has(f.url)) continue;
      addLink(f.kind === 'youtube' ? { kind: 'youtube', title: f.title, url: f.url, author: f.source, folderId: dest } : { kind: 'link', title: f.title, url: f.url, folderId: dest });
      n++;
    }
    const where = folderPath(dest).map((x) => x.title).join(' / ') || 'Home';
    toast(n ? `Saved ${n} source${n === 1 ? '' : 's'} to ${where}` : 'Those sources are already in your library', { kind: n ? 'success' : 'info', action: n ? { label: 'Show', run: () => showSection(useApp.getState().section === 'study' ? 'study' : 'all', dest) } : undefined });
    onClose();
  };

  const footer =
    phase.t === 'setup' ? (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void run()} disabled={(mode === 'topic' ? !topic.trim() : !nbId) || !(kinds.web || kinds.wikipedia || kinds.youtube)}>
          <Search size={16} /> Search
        </Button>
      </>
    ) : phase.t === 'results' ? (
      <>
        <Button variant="ghost" onClick={() => setPhase({ t: 'setup' })}>Back</Button>
        <Button variant="primary" disabled={!picked.size} onClick={add}>
          Save {picked.size} to folder
        </Button>
      </>
    ) : undefined;

  return (
    <Modal title="Find sources" size="lg" onClose={onClose} footer={footer} className="ai-dialog">
      {phase.t === 'setup' && (
        <div className="fs-setup">
          <Segmented label="Search for" value={mode} onChange={setMode} options={[{ value: 'topic', label: 'A topic' }, { value: 'notebook', label: 'A notebook' }]} />
          {mode === 'topic' ? (
            <Field label="Topic" hint="For example: “SN1 and SN2 reactions”, “French Revolution causes”, “eigenvalues explained”.">
              <input className="input" data-autofocus value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && topic.trim() && void run()} />
            </Field>
          ) : (
            <Field label="Notebook" hint={`The AI reads the first ${READ_PAGES} pages, including handwriting, and searches for what they cover.`}>
              <select className="input" value={nbId} onChange={(e) => setNbId(e.target.value)}>
                {usable.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <fieldset className="fs-kinds">
            <legend className="field-label">Look in</legend>
            {(['web', 'wikipedia', 'youtube'] as const).map((k) => (
              <label key={k} className="sub-check">
                <input type="checkbox" checked={kinds[k]} onChange={(e) => setKinds({ ...kinds, [k]: e.target.checked })} />
                {k === 'web' ? 'Websites' : k === 'wikipedia' ? 'Wikipedia' : 'YouTube'}
              </label>
            ))}
          </fieldset>
          {useAiNow ? (
            <>
              <label className="sub-check">
                <input type="checkbox" checked={rank} onChange={(e) => setRank(e.target.checked)} />
                Let the AI pick the best results and say why
              </label>
              <button type="button" className="ask-model" aria-expanded={showModel} onClick={() => setShowModel(!showModel)}>
                {PROVIDERS[choice.provider].label} · {choice.model}
              </button>
              {showModel && <ModelPicker providers={ready} value={choice} onChange={setChoice} />}
            </>
          ) : (
            <p className="field-hint">Without AI the results are shown as the search engines return them. Set up the free AI in Settings to get the best ones picked for you, or to search for a notebook.</p>
          )}
        </div>
      )}
      {phase.t === 'working' && <Working title="Finding sources…" msg={phase.msg} onCancel={() => { runId.current++; setPhase({ t: 'setup' }); }} />}
      {phase.t === 'results' && (
        <div className="fs-results">
          <Field label="Save to">
            <FolderSelect value={target} onChange={setTarget} label="Save to folder" extra={<option value="new">New folder: {phase.topic.slice(0, 60)}</option>} />
          </Field>
          <p className="muted small">
            {phase.why ? `${phase.why.size} picked by the AI for “${phase.topic}”` : `Results for “${phase.topic}”`} · searched: {phase.queries.map((q) => `“${q}”`).join(', ')}
            {phase.failed.length ? ` · ${phase.failed.join(', ')} did not answer` : ''}
          </p>
          <div className="fs-tools">
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(phase.found.map((_, i) => i)))}>Select all</Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Select none</Button>
          </div>
          <ul className="fs-list">
            {phase.found.map((f, i) => {
              const why = phase.why?.get(i);
              const added = have.has(f.url);
              return (
                <li key={f.url} className={`${why ? 'is-pick' : ''} ${added ? 'is-added' : ''}`}>
                  <label className="fs-check">
                    <input
                      type="checkbox"
                      disabled={added}
                      checked={picked.has(i) && !added}
                      aria-label={`Select ${f.title}`}
                      onChange={(e) => {
                        const s = new Set(picked);
                        if (e.target.checked) s.add(i);
                        else s.delete(i);
                        setPicked(s);
                      }}
                    />
                  </label>
                  <span className={`fs-kind k-${f.kind}`} aria-label={f.kind}>{KIND_ICON[f.kind]}</span>
                  <span className="fs-main">
                    <span className="fs-title">{f.title}</span>
                    <span className="muted small">
                      {f.source}
                      {f.duration ? ` · ${f.duration}` : ''}
                      {added ? ' · already in Resources' : ''}
                    </span>
                    {why ? (
                      <span className="fs-why">
                        <Sparkles size={13} /> {why}
                      </span>
                    ) : (
                      f.snippet && <span className="fs-snippet">{f.snippet}</span>
                    )}
                  </span>
                  <span className="fs-open">
                    <Button size="sm" variant={preview === i ? 'secondary' : 'ghost'} aria-expanded={preview === i} onClick={() => setPreview(preview === i ? null : i)}>
                      <Eye size={15} /> {preview === i ? 'Close' : 'Preview'}
                    </Button>
                    <IconButton label={`Open ${f.title} in the browser`} onClick={() => void api.openUrl(f.url)}>
                      <ExternalLink size={15} />
                    </IconButton>
                  </span>
                  {preview === i && (
                    <div className="fs-preview">
                      <Suspense fallback={<Spinner size={18} />}>{f.kind === 'youtube' ? <VideoView url={f.url} /> : <WebPreview url={f.url} />}</Suspense>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}
