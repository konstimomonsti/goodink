// AI features: the Settings → AI section, the model picker, and the dialog that turns notebook
// pages into flashcards (studied with the Anki scheduler) or a summary.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles, Trash2, Copy, KeyRound, SquarePen, X, SendHorizontal, Check, ExternalLink, SlidersHorizontal } from 'lucide-react';
import type { PageMeta } from '../../shared/types';
import { closeDialog, getSession, openDialog, toast, updateSettings, useApp } from '../lib/store';
import { api } from '../lib/api';
import { uid } from '../lib/util';
import type { NotebookSession } from '../engine/session';
import { renderPageToCanvas, displaySize } from '../engine/render';
import { contentFromJSON } from '../engine/model';
import { parseRange } from './pageOps';
import { extractDisplay, mathParts, mathToPlain, MathHtml, renderParts, RichText, hasMath } from '../ui/Math';
import { Button, Field, IconButton, Modal, Segmented, Spinner } from '../ui/primitives';
import { LiveSettingsSection } from '../live/ui/StatusPill';
import {
  PROVIDERS, PROVIDER_IDS, DEFAULT_AI, FREE_PROVIDER, FREE_KEY_URL, withDefaults, PAGES_PER_REQUEST, choiceFrom, readyProviders, listModels, saveKey, removeKey, savedKeys, aiError, generateSummary, chat, ASK_SYSTEM, MAX_ASK_PAGES,
  type AiChoice, type AiSettings, type Card, type PageImage, type ProviderId, type Turn,
} from '../lib/ai';

/** AI settings with the free preset filled in (memoised: a new object each render would loop the store). */
export const useAi = (): AiSettings => {
  const raw = useApp((st) => st.settings.ai);
  return useMemo(() => withDefaults(raw), [raw]);
};
const setAi = (patch: Partial<AiSettings>) => updateSettings({ ai: { ...withDefaults(useApp.getState().settings.ai), ...patch } });

// ---- model picker -------------------------------------------------------------------------------

const modelCache = new Map<string, string[]>();

function useModels(c: AiChoice, enabled: boolean) {
  const key = `${c.provider}|${c.baseURL ?? ''}`;
  const [models, setModels] = useState<string[]>(modelCache.get(key) ?? PROVIDERS[c.provider].models);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = (force = false) => {
    if (!enabled || (!force && modelCache.has(key))) {
      setModels(modelCache.get(key) ?? PROVIDERS[c.provider].models);
      return;
    }
    setLoading(true);
    setError('');
    listModels(c)
      .then((m) => {
        const list = m.length ? m : PROVIDERS[c.provider].models;
        modelCache.set(key, list);
        setModels(list);
      })
      .catch((e) => setError(aiError(e)))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [key, enabled]);
  return { models, loading, error, refresh: () => load(true) };
}

const effortLabel = (e: string) => (e ? e[0].toUpperCase() + e.slice(1) : 'Default');

/** Remember a model choice until the user changes it again. */
export function rememberChoice(c: AiChoice) {
  const ai = withDefaults(useApp.getState().settings.ai);
  setAi({ provider: c.provider, models: { ...ai.models, [c.provider]: c.model }, efforts: { ...ai.efforts, [c.provider]: c.effort } });
}

export function ModelPicker({ value, onChange: set, providers }: { value: AiChoice; onChange: (c: AiChoice) => void; providers: ProviderId[] }) {
  const ai = useAi();
  const onChange = (c: AiChoice) => {
    rememberChoice(c);
    set(c);
  };
  const p = PROVIDERS[value.provider];
  const { models, loading, error, refresh } = useModels(value, providers.includes(value.provider));
  const listId = `models-${value.provider}`;
  return (
    <div className="ai-picker">
      <Field label="Provider">
        <select className="input" value={value.provider} onChange={(e) => onChange(choiceFrom(ai, e.target.value as ProviderId))}>
          {providers.map((id) => (
            <option key={id} value={id}>
              {PROVIDERS[id].label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model" hint={error || (loading ? 'Loading the provider’s models…' : `${models.length} model${models.length === 1 ? '' : 's'} available. You can also type a model ID.`)}>
        <span className="ai-model-row">
          <input className="input" list={listId} value={value.model} placeholder="Model ID" onChange={(e) => onChange({ ...value, model: e.target.value.trim() })} spellCheck={false} />
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <IconButton label="Reload model list" onClick={refresh} disabled={loading}>
            {loading ? <Spinner size={14} /> : <RefreshCw size={16} />}
          </IconButton>
        </span>
      </Field>
      {p.efforts.length > 0 && (
        <Field label="Effort" hint="How hard the model thinks. Higher is slower and costs more, and is better for dense or messy notes.">
          <select className="input" value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
            <option value="">Default</option>
            {p.efforts.map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

// ---- settings section ---------------------------------------------------------------------------

/** Free Gemini in two steps: get a key in the browser, paste it. Shown wherever AI is not set up yet. */
export function FreeAiSetup({ compact = false }: { compact?: boolean }) {
  const ai = useAi();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = ai.keys.includes(FREE_PROVIDER);
  const save = async () => {
    setBusy(true);
    try {
      await saveKey(FREE_PROVIDER, key);
      const cur = withDefaults(useApp.getState().settings.ai);
      setAi({ keys: [...new Set([...cur.keys, FREE_PROVIDER])], provider: FREE_PROVIDER, models: { ...cur.models, [FREE_PROVIDER]: DEFAULT_AI.models[FREE_PROVIDER] }, efforts: { ...cur.efforts, [FREE_PROVIDER]: DEFAULT_AI.efforts[FREE_PROVIDER] } });
      setKey('');
      await listModels(choiceFrom(withDefaults(useApp.getState().settings.ai), FREE_PROVIDER))
        .then(() => toast('Free AI is ready', { kind: 'success' }))
        .catch((e) => toast(`Key saved, but Google did not accept it: ${aiError(e)}`, { kind: 'error', ms: 9000 }));
    } catch (e) {
      toast(aiError(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  if (ready) {
    return (
      <div className="ai-quick is-ready">
        <Check size={18} />
        <span>
          <strong>Free AI is ready</strong>
          <span className="muted small">Google Gemini · {DEFAULT_AI.models[FREE_PROVIDER]} · effort {effortLabel(DEFAULT_AI.efforts[FREE_PROVIDER] ?? '')}</span>
        </span>
      </div>
    );
  }
  return (
    <div className={`ai-quick ${compact ? 'is-compact' : ''}`}>
      <div className="ai-quick-head">
        <Sparkles size={18} />
        <strong>Free AI with Google Gemini</strong>
      </div>
      <p className="muted small">
        Uses Gemini Flash (newest) with medium effort. All it needs is a free key from your Google account; no card is needed. On the free tier Google may use what you send to improve its products.
      </p>
      <ol className="ai-quick-steps">
        <li>
          <Button onClick={() => void api.openUrl(FREE_KEY_URL)}>
            <ExternalLink size={15} /> Get a free key
          </Button>
          <span className="muted small">Sign in, then “Create API key” and copy it.</span>
        </li>
        <li>
          <span className="ai-model-row">
            <input className="input" type="password" autoComplete="off" value={key} placeholder="Paste the key here" aria-label="Google AI key" onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save()} />
            <Button variant="primary" disabled={!key.trim() || busy} onClick={() => void save()}>
              {busy ? <Spinner size={14} /> : <KeyRound size={15} />} Save
            </Button>
          </span>
        </li>
      </ol>
    </div>
  );
}

export function AiSettingsSection() {
  const ai = useAi();
  const [custom, setCustom] = useState(() => ai.keys.some((k) => k !== FREE_PROVIDER));
  const [provider, setProvider] = useState<ProviderId>(ai.provider);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const p = PROVIDERS[provider];
  const hasKey = ai.keys.includes(provider);

  // the key list in settings is a cache; the Credential Manager is the truth
  useEffect(() => {
    void savedKeys().then((keys) => setAi({ keys: [...keys, ...withDefaults(useApp.getState().settings.ai).keys.filter((k) => !PROVIDERS[k].needsKey)] }));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await saveKey(provider, key);
      setAi({ keys: [...new Set([...ai.keys, provider])] });
      setKey('');
      // check the key right away by listing the models
      await listModels(choiceFrom(withDefaults(useApp.getState().settings.ai), provider))
        .then(() => toast(`${p.label} key saved and working`, { kind: 'success' }))
        .catch((e) => toast(`Key saved, but the check failed: ${aiError(e)}`, { kind: 'error', ms: 8000 }));
    } catch (e) {
      toast(aiError(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await removeKey(provider);
    setAi({ keys: ai.keys.filter((k) => k !== provider) });
    toast(`${p.label} key removed`);
  };

  const ready = readyProviders(ai);
  const def = choiceFrom(ai);
  return (
    <section>
      <h3>AI</h3>
      <p className="field-hint ai-intro">Make flashcards and summaries and ask questions about your notes. Pages are sent as images to the AI provider, and its model reads your handwriting. Keys are stored in Windows Credential Manager, not in your library.</p>
      <FreeAiSetup />
      <LiveSettingsSection />
      <div className="ai-custom-toggle">
        <Button variant={custom ? 'secondary' : 'ghost'} aria-expanded={custom} onClick={() => setCustom(!custom)}>
          <SlidersHorizontal size={15} /> {custom ? 'Hide custom setup' : 'Customize: use your own API key'}
        </Button>
      </div>
      {custom && (
        <div className="ai-custom">
          <Field label="Provider to set up" hint="Anthropic (Claude), OpenAI, Google, xAI, Mistral, DeepSeek, Groq, OpenRouter, Ollama on this PC, or any OpenAI-compatible server.">
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                  {ai.keys.includes(id) ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </Field>
          {p.editableURL && (
            <Field label="Server address" hint={provider === 'ollama' ? 'Ollama’s OpenAI-compatible address on this PC.' : 'The base URL, for example https://example.com/v1'}>
              <input className="input" value={ai.baseURLs[provider] ?? p.baseURL} placeholder={p.baseURL || 'https://…/v1'} spellCheck={false} onChange={(e) => setAi({ baseURLs: { ...ai.baseURLs, [provider]: e.target.value.trim() } })} />
            </Field>
          )}
          {!p.needsKey && (
            <Field label="Use this provider" hint="Needs Ollama running on this PC with a vision model, for example one you pulled with “ollama pull”.">
              <span className="ai-model-row">
                <Button variant={hasKey ? 'secondary' : 'primary'} onClick={() => setAi({ keys: hasKey ? ai.keys.filter((k) => k !== provider) : [...ai.keys, provider] })}>
                  {hasKey ? 'Turn off' : 'Turn on'}
                </Button>
              </span>
            </Field>
          )}
          {p.needsKey && (
            <Field label="API key" hint={hasKey ? 'A key is saved. Paste a new one to replace it.' : p.keyHint ? `Get one at ${p.keyHint}.` : undefined}>
              <span className="ai-model-row">
                <input className="input" type="password" autoComplete="off" value={key} placeholder={hasKey ? '•••••••••••• saved' : 'Paste your API key'} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save()} />
                <Button variant="primary" disabled={!key.trim() || busy} onClick={() => void save()}>
                  {busy ? <Spinner size={14} /> : <KeyRound size={15} />} Save
                </Button>
                {hasKey && (
                  <Button variant="ghost" onClick={() => void remove()}>
                    Remove
                  </Button>
                )}
              </span>
            </Field>
          )}
          <h3 className="ai-sub">Model used by default</h3>
          {ready.length === 0 ? (
            <p className="field-hint">Save a key for at least one provider to choose a model.</p>
          ) : (
            <ModelPicker providers={ready} value={ready.includes(def.provider) ? def : choiceFrom(ai, ready[0])} onChange={() => undefined} />
          )}
        </div>
      )}
    </section>
  );
}

// ---- page images --------------------------------------------------------------------------------

const LONG_EDGE = 1568; // larger images are scaled down by the providers anyway

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function pageImage(s: NotebookSession, p: PageMeta, n: number): Promise<PageImage> {
  const d = displaySize(p);
  const width = d.w >= d.h ? LONG_EDGE : Math.round((LONG_EDGE * d.w) / d.h);
  const c = await renderPageToCanvas(p, await s.ensure(p.id), width, s);
  const out = new OffscreenCanvas(c.width, c.height);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  return { page: n, mime: 'image/jpeg', data: b64(new Uint8Array(await blob.arrayBuffer())) };
}

// ---- markdown → page text -----------------------------------------------------------------------

function plain(md: string) {
  return md
    .split('\n')
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*[-*+]\s+/, (m) => `${m.match(/^\s*/)![0]}• `)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1'),
    )
    .join('\n');
}

/** Split text into page-sized chunks for typed text boxes. */
function paginate(text: string, w: number, h: number, size: number) {
  const perLine = Math.max(20, Math.floor((w - 96) / (size * 0.52)));
  const perPage = Math.max(10, Math.floor((h - 112) / (size * 1.45)));
  const pages: string[][] = [[]];
  let used = 0;
  for (const line of text.split('\n')) {
    const n = Math.max(1, Math.ceil(line.length / perLine));
    if (used + n > perPage && pages[pages.length - 1].length) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(line);
    used += n;
  }
  return pages.map((p) => p.join('\n').trim()).filter(Boolean);
}

// ---- the summary dialog -------------------------------------------------------------------------

type Phase = { t: 'setup' } | { t: 'working'; msg: string } | { t: 'summary'; text: string; notes: string[] };

/** Pick a page set of a notebook: all, the current page, or a typed range. */
export function PageScope({ count, current, value, onChange }: { count: number; current?: number; value: { scope: 'all' | 'current' | 'range'; range: string }; onChange: (v: { scope: 'all' | 'current' | 'range'; range: string }) => void }) {
  const pages = resolvePages(count, current, value);
  return (
    <>
      <Field label="Pages" hint={`${pages.length} of ${count} page${count === 1 ? '' : 's'}${pages.length > PAGES_PER_REQUEST ? ` · sent in ${Math.ceil(pages.length / PAGES_PER_REQUEST)} parts` : ''}`}>
        <Segmented
          label="Pages"
          value={value.scope}
          onChange={(scope) => onChange({ ...value, scope })}
          options={[{ value: 'all', label: 'All' }, ...(current !== undefined ? [{ value: 'current' as const, label: 'This page' }] : []), { value: 'range', label: 'Range' }]}
        />
      </Field>
      {value.scope === 'range' && (
        <Field label="Page range">
          <input className="input" value={value.range} placeholder="e.g. 1-5, 8" onChange={(e) => onChange({ ...value, range: e.target.value })} autoFocus />
        </Field>
      )}
    </>
  );
}

export function resolvePages(count: number, current: number | undefined, v: { scope: 'all' | 'current' | 'range'; range: string }) {
  if (v.scope === 'current' && current !== undefined) return [Math.min(current, count - 1)];
  if (v.scope === 'range') return parseRange(v.range, count);
  return [...Array(count).keys()];
}

export const batch = <T,>(items: T[], size = PAGES_PER_REQUEST) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export function AiDialog({ nbId, pageIndex }: { nbId: string; pageIndex?: number }) {
  const ai = useAi();
  const ready = readyProviders(ai);
  const [s, setS] = useState<NotebookSession | null>(null);
  const [choice, setChoice] = useState<AiChoice>(() => choiceFrom(ai, ready.includes(ai.provider) ? ai.provider : ready[0] ?? ai.provider));
  const [pagesSel, setPagesSel] = useState<{ scope: 'all' | 'current' | 'range'; range: string }>({ scope: 'all', range: '' });
  const [length, setLength] = useState<'short' | 'medium' | 'detailed'>('medium');
  const [focus, setFocus] = useState('');
  const [phase, setPhase] = useState<Phase>({ t: 'setup' });
  const runId = useRef(0);

  useEffect(() => {
    void getSession(nbId).then(setS);
  }, [nbId]);

  if (!s) return null;
  const title = 'Summarize with AI';
  if (!ready.length) return <ConnectFirst title={title} />;
  const pages = resolvePages(s.pages.length, pageIndex, pagesSel);

  const run = async () => {
    // a cancelled run keeps going in the background but may no longer change the dialog
    const my = ++runId.current;
    const set = (ph: Parameters<typeof setPhase>[0]) => runId.current === my && setPhase(ph);
    if (!pages.length) return toast('Choose at least one page.', { kind: 'error' });
    try {
      const imgs: PageImage[] = [];
      for (const [k, i] of pages.entries()) {
        set({ t: 'working', msg: `Preparing page ${k + 1} of ${pages.length}…` });
        imgs.push(await pageImage(s, s.pages[i], i + 1));
      }
      const progress = (msg: string) => set({ t: 'working', msg: `${msg} ${PROVIDERS[choice.provider].label} · ${choice.model}` });
      const r = await generateSummary(choice, s.meta.title, batch(imgs), { length, focus }, progress);
      set({ t: 'summary', text: r.text, notes: r.notes });
    } catch (e) {
      set({ t: 'setup' });
      toast(aiError(e), { kind: 'error', ms: 9000 });
    }
  };

  const addSummaryPages = async (text: string) => {
    const last = s.pages[s.pages.length - 1];
    const { w, h } = last.infinite ? { w: 595.28, h: 841.89 } : { w: last.w, h: last.h };
    const size = 11;
    // typed text on a page cannot show typeset math, so formulas become readable Unicode
    const chunks = paginate(`Summary\n\n${plain(mathToPlain(text))}`, w, h, size);
    const added: PageMeta[] = chunks.map(() => ({ id: uid(), w, h, template: { kind: 'blank', paper: 'white' }, rotation: 0 }));
    s.setPages([...s.pages, ...added], { focus: added[0].id });
    for (const [i, p] of added.entries()) {
      s.commit(p.id, contentFromJSON({ v: 1, strokes: [], objects: [{ id: uid(), type: 'text', x: 48, y: 56, w: w - 96, h: h - 112, rot: 0, text: chunks[i], font: 'sans', size, color: '#1c1f26', align: 'left' }] }), { record: false });
    }
    closeDialog();
    toast(`Added the summary as ${added.length} page${added.length === 1 ? '' : 's'} at the end`, { kind: 'success' });
  };

  const footer =
    phase.t === 'setup' ? (
      <>
        <Button variant="ghost" onClick={closeDialog}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void run()} disabled={!choice.model || !pages.length}>
          <Sparkles size={16} /> Summarize
        </Button>
      </>
    ) : phase.t === 'summary' ? (
      <>
        <Button variant="ghost" onClick={() => setPhase({ t: 'setup' })}>
          Back
        </Button>
        <Button onClick={() => void navigator.clipboard.writeText(phase.text).then(() => toast('Summary copied'))}>
          <Copy size={15} /> Copy
        </Button>
        <Button variant="primary" onClick={() => void addSummaryPages(phase.text)}>
          Add to notebook as pages
        </Button>
      </>
    ) : undefined;

  return (
    <Modal title={title} size="lg" onClose={closeDialog} footer={footer} className="ai-dialog">
      {phase.t === 'setup' && (
        <div className="ai-setup">
          <div className="ai-col">
            <ModelPicker providers={ready} value={choice} onChange={setChoice} />
          </div>
          <div className="ai-col">
            <PageScope count={s.pages.length} current={pageIndex} value={pagesSel} onChange={setPagesSel} />
            <Field label="Length">
              <Segmented label="Length" value={length} onChange={setLength} options={[{ value: 'short', label: 'Short' }, { value: 'medium', label: 'Medium' }, { value: 'detailed', label: 'Detailed' }]} />
            </Field>
            <Field label="Focus (optional)" hint="For example: “exam topics only”.">
              <textarea className="input ai-focus" rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} />
            </Field>
          </div>
        </div>
      )}
      {phase.t === 'working' && <Working title="Summarizing…" msg={phase.msg} onCancel={() => { runId.current++; setPhase({ t: 'setup' }); }} />}
      {phase.t === 'summary' && (
        <div className="ai-summary">
          {phase.notes.map((n) => (
            <p key={n} className="lib-note">
              {n}
            </p>
          ))}
          <Markdown text={phase.text} />
        </div>
      )}
    </Modal>
  );
}

export function Working({ title, msg, onCancel }: { title: string; msg: string; onCancel?: () => void }) {
  // a visible clock, so a slow model never looks like a frozen app
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="empty" aria-live="polite">
      <Spinner size={28} />
      <h2>{title}</h2>
      <p>{msg}</p>
      <p className="muted small">{secs} s{secs > 40 ? ' · long notes and videos can take a minute or two' : ''}</p>
      {onCancel && (
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

export function ConnectFirst({ title }: { title: string }) {
  return (
    <Modal title={title} size="md" onClose={closeDialog}>
      <div className="empty">
        <Sparkles size={28} />
        <h2>Set up AI first</h2>
        <FreeAiSetup compact />
        <div className="empty-actions">
          <Button variant="ghost" onClick={() => openDialog({ type: 'settings' })}>
            Use your own API key…
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Editable list of generated cards, shown before they are added. */
export function CardDrafts({ cards, onChange }: { cards: Card[]; onChange: (cards: Card[]) => void }) {
  return (
    <ol className="ai-card-list">
      {cards.map((c, i) => (
        <li key={i} className="ai-card">
          <textarea className="input" rows={2} aria-label={`Card ${i + 1} front`} value={c.front} onChange={(e) => onChange(cards.map((x, j) => (j === i ? { ...x, front: e.target.value } : x)))} />
          <textarea className="input" rows={2} aria-label={`Card ${i + 1} back`} value={c.back} onChange={(e) => onChange(cards.map((x, j) => (j === i ? { ...x, back: e.target.value } : x)))} />
          <IconButton label={`Remove card ${i + 1}`} onClick={() => onChange(cards.filter((_, j) => j !== i))}>
            <Trash2 size={16} />
          </IconButton>
          {(hasMath(c.front) || hasMath(c.back)) && (
            <div className="ai-card-preview">
              <span><RichText text={c.front} /></span>
              <span><RichText text={c.back} /></span>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Just enough Markdown for summaries: headings, bullets, bold. Rendered as React text, never as HTML. */
export function Markdown({ text, onPage }: { text: string; onPage?: (page: number) => void }) {
  // page references like (p. 3) become links to that page
  const refs = (t: string, k: number) =>
    !onPage
      ? t
      : t.split(/(\bpp?\.\s?\d+)/g).map((part, i) => {
          const m = /^pp?\.\s?(\d+)$/.exec(part);
          return m ? <button key={`${k}-${i}`} type="button" className="page-ref" onClick={() => onPage(+m[1])}>{part}</button> : part;
        });
  const words = (t: string) => t.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{refs(part.slice(2, -2), i)}</strong> : refs(part, i)));
  // display math may span lines, so it is taken out before the text is split into lines
  const { text: src, blocks } = extractDisplay(text);
  const inline = (t: string) => renderParts(mathParts(t, blocks), words);
  return (
    <div className="md">
      {src.split('\n').map((line, i) => {
        const only = /^\s*\u0000(\d+)\u0000\s*$/.exec(line);
        if (only) return <div key={i} className="md-math"><MathHtml tex={blocks[+only[1]]} display /></div>;
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) return h[1].length <= 2 ? <h3 key={i}>{inline(h[2])}</h3> : <h4 key={i}>{inline(h[2])}</h4>;
        const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (b) return <p key={i} className="md-li" style={{ paddingLeft: 14 + b[1].length * 8 }}>• {inline(b[2])}</p>;
        if (!line.trim()) return <div key={i} className="md-gap" />;
        return <p key={i}>{inline(line)}</p>;
      })}
    </div>
  );
}

// ---- ask about the notebook ---------------------------------------------------------------------

/** Rendered page images, reused across questions until the page changes. */
const imageCache = new WeakMap<NotebookSession, Map<string, PageImage>>();

async function cachedImage(s: NotebookSession, i: number): Promise<PageImage> {
  const p = s.pages[i];
  let m = imageCache.get(s);
  if (!m) imageCache.set(s, (m = new Map()));
  const key = `${p.id}:${s.version(p.id)}`;
  const have = m.get(key);
  if (have) return { ...have, page: i + 1 };
  const img = await pageImage(s, p, i + 1);
  m.set(key, img);
  return img;
}

type Msg = { role: 'user' | 'assistant'; text: string; error?: boolean; note?: string };
type AskScope = 'page' | 'near' | 'all';

const SUGGESTIONS = ['Summarize this in 5 bullet points', 'Quiz me with 5 questions', 'Explain the hardest part simply', 'What did I miss or get wrong?'];

export function AskPanel({ s, current, onGo, onClose }: { s: NotebookSession; current: number; onGo: (index: number) => void; onClose: () => void }) {
  const ai = useAi();
  const ready = readyProviders(ai);
  const [choice, setChoice] = useState<AiChoice>(() => choiceFrom(ai, ready.includes(ai.provider) ? ai.provider : ready[0] ?? ai.provider));
  const [scope, setScope] = useState<AskScope>(s.pages.length <= MAX_ASK_PAGES ? 'all' : 'near');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [showModel, setShowModel] = useState(false);
  // a conversation keeps the pages it started with, so the cached prefix stays valid
  const pinned = useRef<number[] | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);
  useEffect(() => input.current?.focus(), []);

  const n = s.pages.length;
  const pagesFor = (sc: AskScope) => {
    if (sc === 'page') return [Math.min(current, n - 1)];
    if (sc === 'near') {
      const out: number[] = [];
      for (let i = Math.max(0, current - 5); i <= Math.min(n - 1, current + 5); i++) out.push(i);
      return out;
    }
    return [...Array(Math.min(n, MAX_ASK_PAGES)).keys()];
  };
  const reset = () => {
    pinned.current = null;
    setMsgs([]);
    input.current?.focus();
  };
  const changeScope = (sc: AskScope) => {
    setScope(sc);
    reset();
  };

  const send = async (override?: string) => {
    const text = (override ?? q).trim();
    if (!text || busy) return;
    const pages = pinned.current ?? pagesFor(scope);
    pinned.current = pages;
    const next: Msg[] = [...msgs, { role: 'user', text }];
    setMsgs(next);
    setQ('');
    try {
      const imgs: PageImage[] = [];
      for (const [k, i] of pages.entries()) {
        setBusy(pages.length > 1 ? `Reading page ${k + 1} of ${pages.length}…` : 'Reading the page…');
        imgs.push(await cachedImage(s, i));
      }
      setBusy('Thinking…');
      const turns: Turn[] = next.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
      const r = await chat(choice, ASK_SYSTEM, imgs, turns, setBusy);
      setMsgs([...next, { role: 'assistant', text: r.text.trim() || 'The model returned an empty answer.', note: r.note ?? (r.truncated ? 'The answer was cut off at the length limit.' : undefined) }]);
    } catch (e) {
      setMsgs([...next, { role: 'assistant', text: aiError(e), error: true }]);
    } finally {
      setBusy('');
    }
  };

  const scopeText = pinned.current
    ? pinned.current.length === 1
      ? `page ${pinned.current[0] + 1}`
      : `pages ${pinned.current[0] + 1}–${pinned.current[pinned.current.length - 1] + 1}`
    : scope === 'page'
      ? `page ${Math.min(current, n - 1) + 1}`
      : scope === 'near'
        ? 'the pages around this one'
        : n > MAX_ASK_PAGES
          ? `the first ${MAX_ASK_PAGES} pages`
          : 'the whole notebook';

  return (
    <aside className="panel ask-panel" aria-label="Ask AI">
      <header className="panel-head">
        <Sparkles size={16} className="ask-icon" />
        <span className="panel-title">Ask AI</span>
        {msgs.length > 0 && (
          <IconButton label="New chat" onClick={reset}>
            <SquarePen size={16} />
          </IconButton>
        )}
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {!ready.length ? (
        <div className="panel-body ask-empty">
          <FreeAiSetup compact />
          <Button variant="ghost" onClick={() => openDialog({ type: 'settings' })}>
            Use your own API key…
          </Button>
        </div>
      ) : (
        <>
          <div className="ask-opts">
            <Segmented
              label="Pages to include"
              value={scope}
              onChange={changeScope}
              options={[
                { value: 'page', label: 'This page' },
                { value: 'near', label: '±5 pages', title: 'This page and up to 5 pages before and after it' },
                { value: 'all', label: 'Notebook', title: n > MAX_ASK_PAGES ? `The first ${MAX_ASK_PAGES} pages` : 'Every page' },
              ]}
            />
            <button type="button" className="ask-model" aria-expanded={showModel} onClick={() => setShowModel(!showModel)} title="Change model">
              {PROVIDERS[choice.provider].label} · {choice.model || 'choose a model'}
              {choice.effort ? ` · ${choice.effort}` : ''}
            </button>
            {showModel && <ModelPicker providers={ready} value={choice} onChange={setChoice} />}
          </div>
          <div className="ask-list" ref={list} aria-live="polite">
            {msgs.length === 0 && (
              <div className="ask-hint">
                <p>Ask anything about {scopeText}. The model reads your handwriting from the page images.</p>
                <div className="ask-suggest">
                  {SUGGESTIONS.map((t) => (
                    <button key={t} type="button" className="chip" onClick={() => void send(t)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="ask-msg is-user">
                  {m.text}
                </div>
              ) : (
                <div key={i} className={`ask-msg is-ai ${m.error ? 'is-error' : ''}`}>
                  {m.error ? m.text : <Markdown text={m.text} onPage={(p) => p >= 1 && p <= n && onGo(p - 1)} />}
                  {m.note && <p className="lib-note">{m.note}</p>}
                </div>
              ),
            )}
            {busy && (
              <div className="ask-msg is-ai ask-busy">
                <Spinner size={14} /> {busy}
              </div>
            )}
          </div>
          <form
            className="ask-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={input}
              className="input"
              rows={2}
              value={q}
              placeholder={msgs.length ? 'Ask a follow-up…' : 'Ask about your notes…'}
              aria-label="Your question"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="submit" className="btn btn-primary ask-send" aria-label="Send" disabled={!q.trim() || !!busy || !choice.model}>
              <SendHorizontal size={16} />
            </button>
          </form>
          {msgs.length > 0 && <p className="ask-scope">Using {scopeText}</p>}
        </>
      )}
    </aside>
  );
}
