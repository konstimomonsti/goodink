// AI providers: generate flashcards and summaries from notebook pages. Pages go to the model as
// images, so the model itself reads the handwriting, drawings and PDF text. Anthropic uses its
// official SDK; every other provider speaks the OpenAI-compatible API through the OpenAI SDK.
// All traffic runs through the Rust backend (ai_fetch), which inserts the saved API key, so keys
// never live in the web view.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Channel, invoke } from '@tauri-apps/api/core';

import type { AiSettings, ProviderId } from '../../shared/types';

export type { AiSettings, ProviderId };

export interface ProviderInfo {
  label: string;
  baseURL: string;
  /** false for local servers that take no key */
  needsKey: boolean;
  keyHint?: string;
  /** reasoning effort levels the provider accepts ('' = provider default) */
  efforts: string[];
  /** shown until the live model list loads */
  models: string[];
  editableURL?: boolean;
}

const FREE_MODEL = 'gemini-flash-latest';

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: { label: 'Anthropic (Claude)', baseURL: 'https://api.anthropic.com', needsKey: true, keyHint: 'console.anthropic.com → API keys', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', needsKey: true, keyHint: 'platform.openai.com → API keys', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], models: [] },
  google: { label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyHint: 'aistudio.google.com/apikey (free)', efforts: ['none', 'low', 'medium', 'high'], models: [FREE_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash-lite'] },
  xai: { label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', needsKey: true, keyHint: 'console.x.ai', efforts: ['low', 'high'], models: [] },
  mistral: { label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', needsKey: true, keyHint: 'console.mistral.ai → API keys', efforts: [], models: [] },
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', needsKey: true, keyHint: 'platform.deepseek.com → API keys', efforts: [], models: [] },
  groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', needsKey: true, keyHint: 'console.groq.com → API keys', efforts: ['none', 'low', 'medium', 'high'], models: [] },
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', needsKey: true, keyHint: 'openrouter.ai → Keys', efforts: ['minimal', 'low', 'medium', 'high'], models: [] },
  ollama: { label: 'Ollama (on this PC)', baseURL: 'http://localhost:11434/v1', needsKey: false, efforts: ['low', 'medium', 'high'], models: [], editableURL: true },
  custom: { label: 'Custom (OpenAI-compatible)', baseURL: '', needsKey: true, keyHint: 'any server with an OpenAI-compatible /chat/completions endpoint', efforts: ['low', 'medium', 'high'], models: [], editableURL: true },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** The free default: Google's Gemini Flash on its free tier ("latest" follows Google's newest Flash model). */
export const FREE_PROVIDER: ProviderId = 'google';
export const FREE_KEY_URL = 'https://aistudio.google.com/apikey';

export const DEFAULT_AI: AiSettings = {
  provider: FREE_PROVIDER,
  models: { google: FREE_MODEL, anthropic: 'claude-opus-5-5' },
  efforts: { google: 'medium', anthropic: 'high' },
  baseURLs: {},
  keys: [],
};

/** Saved settings on top of the defaults; with no provider set up yet, the free preset is the choice. */
export function withDefaults(ai: AiSettings | undefined): AiSettings {
  if (!ai) return DEFAULT_AI;
  const merged = { ...DEFAULT_AI, ...ai, models: { ...DEFAULT_AI.models, ...ai.models }, efforts: { ...DEFAULT_AI.efforts, ...ai.efforts } };
  return ai.keys.length ? merged : { ...merged, provider: FREE_PROVIDER };
}

export interface AiChoice {
  provider: ProviderId;
  model: string;
  effort: string; // '' = provider default
  baseURL?: string;
}

/** Model IDs never contain whitespace; a stray space ("gemini- 3.5-flash-lite") makes the provider reject the request. */
export const cleanModel = (m: string) => m.replace(/\s+/g, '');

export const choiceFrom = (ai: AiSettings, provider = ai.provider): AiChoice => ({
  provider,
  model: cleanModel(ai.models[provider] ?? PROVIDERS[provider].models[0] ?? ''),
  effort: ai.efforts[provider] ?? '',
  baseURL: ai.baseURLs[provider],
});

/** Providers that can be used right now. */
// keyless providers (Ollama) count once the user switched them on, which also puts them in `keys`
export const readyProviders = (ai: AiSettings) => PROVIDER_IDS.filter((p) => ai.keys.includes(p) && (p !== 'custom' || !!ai.baseURLs.custom));

// ---- keys ----------------------------------------------------------------------------------------

export const saveKey = (p: ProviderId, key: string) => invoke<void>('secret_set', { name: p, value: key });
export const removeKey = (p: ProviderId) => invoke<void>('secret_delete', { name: p });
export const savedKeys = () => invoke<ProviderId[]>('secret_has', { names: PROVIDER_IDS });

// ---- transport ----------------------------------------------------------------------------------

const SECRET_MARK = '__GOODINK_SECRET__';

type StreamEvent = { type: 'head'; status: number; headers: [string, string][] } | { type: 'chunk'; text: string } | { type: 'end' } | { type: 'error'; message: string };

/** null = not tried yet; false = this backend has no ai_fetch_stream (older build) */
let streamingBackend: boolean | null = null;
let streamSeq = 0;

/**
 * The request through the backend's ai_fetch_stream: the Response resolves as soon as the status
 * and headers arrive, and its body streams the provider's bytes as they come (real token streaming
 * for SSE). Aborting cancels the backend task, which drops the connection to the provider.
 * Resolves null when the backend cannot stream (then ai_fetch is used).
 */
function streamFetch(req: { url: string; method: string; headers: [string, string][]; body?: string; secret: ProviderId | null }, signal?: AbortSignal | null): Promise<Response | null> {
  const id = (streamSeq = (streamSeq + 1) % 0x7fffffff);
  const enc = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let done = false;
  const bodyStream = new ReadableStream<Uint8Array>({
    start: (c) => void (ctl = c),
    cancel: () => {
      // the SDK stopped reading (e.g. it aborted): stop the backend too
      if (!done) void invoke('ai_fetch_cancel', { id }).catch(() => undefined);
    },
  });
  return new Promise<Response | null>((resolve, reject) => {
    let headSeen = false;
    const fail = (e: unknown) => {
      done = true;
      if (!headSeen) reject(e);
      else
        try {
          ctl?.error(e);
        } catch {
          /* already closed */
        }
    };
    const onAbort = () => {
      void invoke('ai_fetch_cancel', { id }).catch(() => undefined);
      fail(new DOMException('The request was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const ch = new Channel<StreamEvent>();
    ch.onmessage = (ev) => {
      if (done) return;
      if (ev.type === 'head') {
        headSeen = true;
        const empty = ev.status === 204 || ev.status === 304;
        resolve(new Response(empty ? null : bodyStream, { status: ev.status, headers: ev.headers }));
      } else if (ev.type === 'chunk') ctl?.enqueue(enc.encode(ev.text));
      else if (ev.type === 'end') {
        done = true;
        signal?.removeEventListener('abort', onAbort);
        try {
          ctl?.close();
        } catch {
          /* already closed */
        }
      } else {
        signal?.removeEventListener('abort', onAbort);
        fail(new Error(ev.message));
      }
    };
    invoke('ai_fetch_stream', { id, req, onEvent: ch }).then(
      () => void (streamingBackend = true),
      (e) => {
        signal?.removeEventListener('abort', onAbort);
        // an older backend without the command: use the plain ai_fetch from now on
        if (streamingBackend === null && /ai_fetch_stream|not found|unknown command/i.test(String(e))) {
          streamingBackend = false;
          done = true;
          return resolve(null);
        }
        fail(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** A fetch for the SDKs that runs the request in the backend, which adds the key. */
function backendFetch(secret: ProviderId | null): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: [string, string][] = [];
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => headers.push([k, v]));
    const body = init?.body == null ? undefined : typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    const req = { url, method: init?.method ?? 'GET', headers, body, secret };
    if (streamingBackend !== false) {
      const r = await streamFetch(req, signal);
      if (r) return r;
    }
    const call = invoke<{ status: number; headers: [string, string][]; body: string }>('ai_fetch', { req });
    // the SDK's time limit aborts the signal; stop waiting then (the backend request is left to finish)
    const r = signal
      ? await Promise.race([call, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('The request took too long.', 'AbortError')), { once: true }))])
      : await call;
    const empty = r.status === 204 || r.status === 304;
    return new Response(empty ? null : r.body, { status: r.status, headers: r.headers });
  };
}

/** One attempt may take this long; retries are done by withRetry, where the user can see them. */
const REQUEST_TIMEOUT = 150_000;

const baseURL = (c: AiChoice) => (c.baseURL?.trim() || PROVIDERS[c.provider].baseURL).replace(/\/+$/, '');

function anthropicClient(c: AiChoice) {
  return new Anthropic({ apiKey: SECRET_MARK, baseURL: baseURL(c), fetch: backendFetch('anthropic'), dangerouslyAllowBrowser: true, maxRetries: 0, timeout: REQUEST_TIMEOUT });
}

function openaiClient(c: AiChoice) {
  const p = PROVIDERS[c.provider];
  if (!baseURL(c)) throw new Error('Set the server address for this provider in Settings → AI.');
  return new OpenAI({ apiKey: p.needsKey ? SECRET_MARK : 'local', baseURL: baseURL(c), fetch: backendFetch(p.needsKey ? c.provider : null), dangerouslyAllowBrowser: true, maxRetries: 0, timeout: REQUEST_TIMEOUT });
}

// ---- models -------------------------------------------------------------------------------------

const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|audio|realtime|transcribe|image|imagen|veo|aqa|search|davinci|babbage|rerank|ocr|guard|lyria/i;

/** The provider's live model list (chat models only). */
export async function listModels(c: AiChoice): Promise<string[]> {
  if (c.provider === 'anthropic') {
    const out: string[] = [];
    for await (const m of anthropicClient(c).models.list()) out.push(m.id);
    return out;
  }
  const out: string[] = [];
  for await (const m of openaiClient(c).models.list()) {
    const id = m.id.replace(/^models\//, '');
    if (!NOT_CHAT.test(id)) out.push(id);
  }
  return out.sort();
}

// ---- requests -----------------------------------------------------------------------------------

export interface PageImage {
  /** 1-based page number in the notebook */
  page: number;
  mime: 'image/jpeg' | 'image/png';
  data: string; // base64
}

export interface AiResult {
  text: string;
  truncated: boolean;
  note?: string;
}

/** Claude models that take adaptive thinking and an effort level. */
const claudeAdaptive = (m: string) => /^claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/.test(m);
/** Claude models that should carry Anthropic's server-side refusal fallback. */
const claudeFallback = (m: string) => /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(m);

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

async function chatAnthropic(c: AiChoice, system: string, images: PageImage[], turns: Turn[]): Promise<AiResult> {
  const client = anthropicClient(c);
  const pages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  for (const img of images) {
    pages.push({ type: 'text', text: `Page ${img.page}:` });
    pages.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
  }
  // the pages are the same on every turn of a conversation: cache them
  const last = pages[pages.length - 1];
  if (last && turns.length > 1) last.cache_control = { type: 'ephemeral' };
  const messages: Anthropic.MessageParam[] = turns.map((t, i) => (i === 0 ? { role: 'user', content: [...pages, { type: 'text', text: t.text }] } : { role: t.role, content: t.text }));
  const params: Anthropic.MessageCreateParamsNonStreaming = { model: c.model, max_tokens: 64000, system, messages };
  if (claudeAdaptive(c.model)) {
    params.thinking = { type: 'adaptive' };
    if (c.effort) params.output_config = { effort: c.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  }
  const msg = claudeFallback(c.model)
    ? // server-side fallback: if the model declines, Anthropic retries on a suitable model in the same call
      await client.beta.messages.stream({ ...(params as Anthropic.Beta.MessageCreateParamsNonStreaming), betas: ['server-side-fallback-2026-07-01'], ...({ fallbacks: 'default' } as object) }).finalMessage()
    : await client.messages.stream(params).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to process these pages. Try a different model.');
  const blocks: { type: string; text?: string }[] = msg.content;
  const out = blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  return { text: out, truncated: msg.stop_reason === 'max_tokens' };
}

async function chatOpenAI(c: AiChoice, system: string, images: PageImage[], turns: Turn[]): Promise<AiResult> {
  const client = openaiClient(c);
  const pages: OpenAI.Chat.ChatCompletionContentPart[] = [];
  for (const img of images) {
    pages.push({ type: 'text', text: `Page ${img.page}:` });
    pages.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}`, detail: 'high' } });
  }
  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: c.model,
    messages: [
      { role: 'system', content: system },
      ...turns.map((t, i): OpenAI.Chat.ChatCompletionMessageParam => (i === 0 ? { role: 'user', content: [...pages, { type: 'text', text: t.text }] } : { role: t.role, content: t.text })),
    ],
  };
  const withEffort = c.effort
    ? c.provider === 'openrouter'
      ? ({ ...body, reasoning: { effort: c.effort } } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)
      : { ...body, reasoning_effort: c.effort as OpenAI.ReasoningEffort }
    : body;
  let note: string | undefined;
  let res: OpenAI.Chat.ChatCompletion;
  try {
    res = await client.chat.completions.create(withEffort);
  } catch (e) {
    // not every model of a provider takes a reasoning effort; run it once more without
    if (!c.effort || !(e instanceof OpenAI.BadRequestError) || !/reason|effort/i.test(e.message)) throw e;
    res = await client.chat.completions.create(body);
    note = `${c.model} does not take an effort setting, so it ran with its default.`;
  }
  const choice = res.choices[0];
  return { text: choice?.message?.content ?? '', truncated: choice?.finish_reason === 'length', note };
}

/** Busy, rate-limited, timed out or unreachable: worth trying again. */
function retryable(e: unknown) {
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return true; // includes time-outs
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return [408, 409, 429, 500, 502, 503, 504, 529].includes(e.status ?? 0);
  return e instanceof DOMException && e.name === 'AbortError';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS = [3000, 8000, 15000];
/** The free preset's lighter sibling, used when Google reports the main model as overloaded. */
const FREE_FALLBACK = 'gemini-flash-lite-latest';

export type OnWait = (msg: string) => void;

/** Try a request a few times, telling the user what is happening; the free preset falls back to Flash-Lite. */
async function withRetry(c: AiChoice, run: (c: AiChoice) => Promise<AiResult>, onWait?: OnWait): Promise<AiResult> {
  const name = PROVIDERS[c.provider].label;
  let last: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await run(c);
    } catch (e) {
      if (!retryable(e)) throw e;
      last = e;
      if (attempt === RETRY_DELAYS.length) break;
      const d = RETRY_DELAYS[attempt];
      const why = e instanceof DOMException || e instanceof Anthropic.APIConnectionTimeoutError || e instanceof OpenAI.APIConnectionTimeoutError ? 'is taking very long' : 'is busy';
      onWait?.(`${name} ${why}. Trying again in ${d / 1000} s (attempt ${attempt + 2} of ${RETRY_DELAYS.length + 1})…`);
      await sleep(d);
    }
  }
  if (c.provider === FREE_PROVIDER && c.model === DEFAULT_AI.models[FREE_PROVIDER]) {
    onWait?.('Gemini Flash is overloaded right now. Switching to Gemini Flash-Lite…');
    const r = await run({ ...c, model: FREE_FALLBACK });
    return { ...r, note: [r.note, 'Gemini Flash was overloaded, so the lighter Gemini Flash-Lite answered.'].filter(Boolean).join(' ') };
  }
  throw last;
}

/** A conversation about some pages: the pages go with the first user turn. */
export function chat(c: AiChoice, system: string, images: PageImage[], turns: Turn[], onWait?: OnWait): Promise<AiResult> {
  if (!c.model) throw new Error('Choose a model first.');
  return withRetry(c, (cc) => (cc.provider === 'anthropic' ? chatAnthropic(cc, system, images, turns) : chatOpenAI(cc, system, images, turns)), onWait);
}

export function ask(c: AiChoice, system: string, text: string, images: PageImage[], onWait?: OnWait): Promise<AiResult> {
  return chat(c, system, images, [{ role: 'user', text }], onWait);
}

export const ASK_SYSTEM = `You answer a learner's questions about their notebook.
The notebook pages arrive as images, each labelled with its page number. They may be handwritten, typed, drawn, or PDF pages: read everything carefully, including handwriting, diagrams, tables and formulas.
Answer from the notes first and say which page you used, written exactly like (p. 3). If the notes do not cover the question, say so plainly, then you may answer from general knowledge, clearly marked as not from the notes.
Be concise and clear. Use Markdown for structure when it helps. Write math, physics and chemistry in LaTeX: $...$ inline and $$...$$ on its own line; chemical formulas and reactions with mhchem, e.g. $\\ce{H2SO4}$ or $\\ce{A + B -> C}$. Never use LaTeX for ordinary words. Reply in the language of the question.`;

/** How many pages one question may include. */
export const MAX_ASK_PAGES = 50;

/** A readable message for any provider error. */
export function aiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) return 'The API key was rejected. Check it in Settings → AI.';
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof OpenAI.PermissionDeniedError) return 'This API key may not use that model.';
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError) return 'The provider does not know that model. Pick another one.';
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) return 'The provider is rate limiting this key, or it is out of credit. Try again in a minute.';
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return `The provider returned an error: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// ---- tasks --------------------------------------------------------------------------------------

/** Pages per request: keeps every request well inside each provider's image limits. */
export const PAGES_PER_REQUEST = 20;

const CARDS_SYSTEM = `You turn a learner's notebook pages into flashcards for spaced repetition (Anki-style review).
The pages arrive as images. They may be handwritten, typed, drawn, or PDF pages: read everything carefully, including handwriting, labels in diagrams, tables and formulas.
Goal: if the learner memorizes every card, they know everything important on these pages.
Rules:
- One fact per card (minimum information principle). Split lists and long explanations into several cards.
- Front: a precise question or prompt that has exactly one correct answer. Back: the short answer, then at most one line of context if it helps.
- Cover every definition, term, formula, date, name, cause/effect, step of a process and relationship that appears. Include cloze-style cards where wording matters.
- Only use what is on the pages. Do not add outside facts. Skip anything you cannot read.
- Write in the same language as the notes. Write math, physics and chemistry in LaTeX: $...$ inline and $$...$$ on its own line; chemical formulas and reactions with mhchem, e.g. $\\ce{H2SO4}$ or $\\ce{A + B -> C}$. Keep JSON valid: escape every backslash as \\\\ inside JSON strings.
- No duplicates.
Reply with JSON only, no other text: {"cards":[{"front":"...","back":"..."}]}`;

const SUMMARY_SYSTEM = `You summarize a learner's notebook pages so they can review the material quickly.
The pages arrive as images. They may be handwritten, typed, drawn, or PDF pages: read everything carefully, including handwriting, labels in diagrams, tables and formulas.
Write a faithful summary in Markdown: short headings that follow the structure of the notes, bullet points, **bold** key terms. Write math, physics and chemistry in LaTeX: $...$ inline and $$...$$ on its own line; chemical formulas and reactions with mhchem, e.g. $\\ce{H2SO4}$ or $\\ce{A + B -> C}$. Never use LaTeX for ordinary words. Keep every important definition, formula, and result.
Only use what is on the pages; do not add outside facts. If part of a page is unreadable, say so briefly.
Write in the same language as the notes. Reply with the summary only.`;

export interface Card {
  front: string;
  back: string;
}

// LaTeX commands that start like a JSON escape (\b \f \n \r \t \u): written with one backslash they would
// silently turn into control characters, so these are recognised by name
const TEX_BFNRTU = new Set('beta bar bf binom big bigg bigl bigr boldsymbol bot bullet backslash frac forall flat nabla ne neq nu not ni neg nleq ngeq nolimits rho rightarrow Rightarrow rangle rm rceil rfloor theta tau times text textbf textit textrm to top tilde triangle tan tanh therefore underline uparrow upsilon'.split(' '));

/** Models often write LaTeX in JSON with single backslashes; double those so they survive JSON.parse. */
export function repairLatexEscapes(json: string) {
  return json.replace(/\\\\|\\([A-Za-z]+)/g, (m, name: string | undefined) => {
    if (!name) return m; // an already escaped backslash
    return !'bfnrtu'.includes(name[0]) || TEX_BFNRTU.has(name) ? `\\\\${name}` : m;
  });
}

export function parseCards(text: string): Card[] {
  text = repairLatexEscapes(text);
  const start = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let raw: unknown;
  try {
    raw = start >= 0 && (arrStart < 0 || start < arrStart) ? JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) : JSON.parse(text.slice(arrStart, text.lastIndexOf(']') + 1));
  } catch {
    throw new Error('The model did not reply with readable flashcards. Try again or pick another model.');
  }
  const list = Array.isArray(raw) ? raw : (raw as { cards?: unknown }).cards;
  if (!Array.isArray(list)) throw new Error('The model did not reply with readable flashcards. Try again or pick another model.');
  return list
    .map((c) => ({ front: String((c as Card).front ?? '').trim(), back: String((c as Card).back ?? '').trim() }))
    .filter((c) => c.front && c.back);
}

export async function generateCards(c: AiChoice, title: string, batches: PageImage[][], opts: { count?: number; focus?: string }, onProgress: (msg: string) => void) {
  const cards: Card[] = [];
  const notes: string[] = [];
  let truncated = false;
  const totalPages = batches.reduce((n, b) => n + b.length, 0);
  for (const [i, imgs] of batches.entries()) {
    const range = `${imgs[0].page}–${imgs[imgs.length - 1].page}`;
    onProgress(batches.length > 1 ? `Reading pages ${range} (part ${i + 1} of ${batches.length})…` : `Reading ${imgs.length} page${imgs.length === 1 ? '' : 's'}…`);
    const share = opts.count ? Math.max(1, Math.round((opts.count * imgs.length) / totalPages)) : 0;
    const text = [
      `Notebook: "${title}", pages ${range}.`,
      share ? `Make about ${share} flashcards.` : 'Make as many flashcards as needed to cover everything important.',
      opts.focus?.trim() ? `The learner asks: ${opts.focus.trim()}` : '',
      cards.length ? `Earlier pages already produced cards; avoid repeating these fronts: ${cards.slice(-80).map((x) => x.front).join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    const r = await ask(c, CARDS_SYSTEM, text, imgs, onProgress);
    truncated ||= r.truncated;
    if (r.note && !notes.includes(r.note)) notes.push(r.note);
    cards.push(...parseCards(r.text));
  }
  if (truncated) notes.push('The reply hit the length limit, so the last cards may be missing. Try fewer pages at once.');
  return { cards, notes };
}

export async function generateSummary(c: AiChoice, title: string, batches: PageImage[][], opts: { length: 'short' | 'medium' | 'detailed'; focus?: string }, onProgress: (msg: string) => void) {
  const lengthHint = { short: 'Keep it short: about one screen.', medium: 'Medium length: cover each topic in a few bullets.', detailed: 'Detailed: keep every important point.' }[opts.length];
  const parts: string[] = [];
  const notes: string[] = [];
  for (const [i, imgs] of batches.entries()) {
    const range = `${imgs[0].page}–${imgs[imgs.length - 1].page}`;
    onProgress(batches.length > 1 ? `Reading pages ${range} (part ${i + 1} of ${batches.length})…` : `Reading ${imgs.length} page${imgs.length === 1 ? '' : 's'}…`);
    const text = [`Notebook: "${title}", pages ${range}.`, batches.length > 1 ? 'Summarize these pages in detail; this part will be merged with others.' : lengthHint, opts.focus?.trim() ? `The learner asks: ${opts.focus.trim()}` : ''].filter(Boolean).join('\n');
    const r = await ask(c, SUMMARY_SYSTEM, text, imgs, onProgress);
    if (r.note && !notes.includes(r.note)) notes.push(r.note);
    if (r.truncated) notes.push(`The summary of pages ${range} hit the length limit and may be cut short.`);
    parts.push(r.text.trim());
  }
  if (parts.length === 1) return { text: parts[0], notes };
  onProgress('Combining the parts…');
  const merged = await ask(c, SUMMARY_SYSTEM.replace('The pages arrive as images.', 'You receive partial summaries of consecutive parts of the notebook instead of images.'), [`Notebook: "${title}". Merge these partial summaries into one summary without repeating yourself. ${lengthHint}`, ...parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`)].join('\n\n'), [], onProgress);
  if (merged.note && !notes.includes(merged.note)) notes.push(merged.note);
  return { text: merged.text.trim(), notes };
}

/** Characters of text per request when making cards from a web page (well inside every context window). */
export const TEXT_CHARS_PER_REQUEST = 120_000;

const TEXT_CARDS_SYSTEM = CARDS_SYSTEM.replace(
  'The pages arrive as images. They may be handwritten, typed, drawn, or PDF pages: read everything carefully, including handwriting, labels in diagrams, tables and formulas.',
  'The material arrives as text: a web page, or a video transcript with [m:ss] time marks (speech recognition may mishear words; correct them from context). Ignore navigation, ads, cookie notices, sponsor messages and other furniture.',
).replace("a learner's notebook pages", 'study material');

/** Flashcards from plain text (a web page). Long text goes in several parts; nothing is cut off. */
export async function generateCardsFromText(c: AiChoice, title: string, text: string, opts: { count?: number; focus?: string }, onProgress: (msg: string) => void) {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += TEXT_CHARS_PER_REQUEST) parts.push(text.slice(i, i + TEXT_CHARS_PER_REQUEST));
  const cards: Card[] = [];
  const notes: string[] = [];
  for (const [i, part] of parts.entries()) {
    onProgress(parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}…` : 'Reading the page…');
    const share = opts.count ? Math.max(1, Math.round((opts.count * part.length) / text.length)) : 0;
    const prompt = [
      `Source: "${title}"${parts.length > 1 ? `, part ${i + 1} of ${parts.length}` : ''}.`,
      share ? `Make about ${share} flashcards.` : 'Make as many flashcards as needed to cover everything important.',
      opts.focus?.trim() ? `The learner asks: ${opts.focus.trim()}` : '',
      cards.length ? `Earlier parts already produced cards; avoid repeating these fronts: ${cards.slice(-80).map((x) => x.front).join(' | ')}` : '',
      '<material>',
      part,
      '</material>',
    ].filter(Boolean).join('\n');
    const r = await ask(c, TEXT_CARDS_SYSTEM, prompt, [], onProgress);
    if (r.note && !notes.includes(r.note)) notes.push(r.note);
    if (r.truncated) notes.push('A reply hit the length limit, so some cards may be missing.');
    cards.push(...parseCards(r.text));
  }
  return { cards, notes };
}

const VIDEO_CARDS_SYSTEM = CARDS_SYSTEM.replace(
  'The pages arrive as images. They may be handwritten, typed, drawn, or PDF pages: read everything carefully, including handwriting, labels in diagrams, tables and formulas.',
  'The material is a video: watch and listen to all of it, including slides, board work, diagrams and on-screen text.',
).replace("a learner's notebook pages", 'a video');

/**
 * Google Gemini watches a YouTube video itself, for videos without readable captions. This uses
 * Gemini's own API (the OpenAI-compatible one cannot take a video link); the key is added by the backend.
 */
export async function generateCardsFromVideo(c: AiChoice, title: string, videoUrl: string, opts: { count?: number; focus?: string }, onProgress: (msg: string) => void) {
  if (c.provider !== 'google') throw new Error('This video has no captions that apps may read. Google Gemini (the free AI in Settings → AI) can watch the video itself; switch the provider to Google Gemini and try again.');
  onProgress('Gemini is watching the video…');
  const prompt = [
    `Video: "${title}".`,
    opts.count ? `Make about ${opts.count} flashcards.` : 'Make as many flashcards as needed to cover everything important.',
    opts.focus?.trim() ? `The learner asks: ${opts.focus.trim()}` : '',
  ].filter(Boolean).join('\n');
  const body = {
    systemInstruction: { parts: [{ text: VIDEO_CARDS_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ fileData: { fileUri: videoUrl } }, { text: prompt }] }],
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.model.replace(/^models\//, ''))}:generateContent`;
  let r = { status: 0, body: '' };
  for (let attempt = 0; ; attempt++) {
    r = await invoke<{ status: number; body: string }>('ai_fetch', {
      req: { url, method: 'POST', headers: [['content-type', 'application/json'], ['x-goog-api-key', SECRET_MARK]], body: JSON.stringify(body), secret: 'google' },
    });
    if (![429, 500, 503].includes(r.status) || attempt === RETRY_DELAYS.length) break;
    onProgress(`Google is busy. Trying again in ${RETRY_DELAYS[attempt] / 1000} s…`);
    await sleep(RETRY_DELAYS[attempt]);
  }
  type Gen = { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; error?: { message?: string } };
  const j = JSON.parse(r.body || '{}') as Gen;
  if (r.status >= 400) throw new Error(`Google could not watch this video: ${j.error?.message ?? `error ${r.status}`}`);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const notes = cand?.finishReason === 'MAX_TOKENS' ? ['The reply hit the length limit, so some cards may be missing.'] : [];
  return { cards: parseCards(text), notes };
}

// ---- finding sources ----------------------------------------------------------------------------

const SEARCH_SYSTEM = `You help a learner find good material to study further. The learner's notebook pages arrive as images (handwriting, typed text, drawings or PDF pages); read them carefully.
Work out what the notes are about and write web search queries that would find clear explanations, lectures and reference pages for exactly these topics.
Reply with JSON only: {"topic":"a short title for what the notes cover","language":"the notes' language as a two-letter code, e.g. de or en","queries":["3 to 4 specific search queries"]}
Write the queries in the notes' language; if that is not English, make one of them English.`;

/** Read a notebook and suggest what to search for. */
export async function suggestSearch(c: AiChoice, title: string, images: PageImage[], onWait?: OnWait): Promise<{ topic: string; language: string; queries: string[] }> {
  const r = await ask(c, SEARCH_SYSTEM, `Notebook: "${title}".`, images, onWait);
  const j = parseJson(r.text) as { topic?: string; language?: string; queries?: string[] };
  const queries = (j.queries ?? []).map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  if (!queries.length) throw new Error('The model did not suggest any searches. Try again or type a topic instead.');
  return { topic: String(j.topic ?? title), language: String(j.language ?? 'en').slice(0, 2).toLowerCase(), queries };
}

const RANK_SYSTEM = `You pick study sources for a learner. You get a numbered list of search results (websites, Wikipedia articles, YouTube videos).
Choose the most useful ones for learning the topic: clear explanations, lectures, textbooks and reputable reference pages. Prefer variety (a few articles, a few videos). Leave out shops, spam, forums with no answer, paywalled or unrelated pages, and near-duplicates.
Reply with JSON only: {"picks":[{"i":0,"why":"one short line in the learner's language on what it offers"}]} with at most 12 picks, best first.`;

/** Let the model choose the best results and say why; indices refer to `items`. */
export async function rankSources(c: AiChoice, topic: string, items: { kind: string; title: string; source: string; snippet: string }[], onWait?: OnWait): Promise<{ i: number; why: string }[]> {
  const list = items.map((f, i) => `${i}. [${f.kind}] ${f.title} (${f.source}) ${f.snippet.slice(0, 200)}`).join('\n');
  const r = await ask(c, RANK_SYSTEM, `Topic: ${topic}\n\nResults:\n${list}`, [], onWait);
  const j = parseJson(r.text) as { picks?: { i?: number; why?: string }[] };
  const seen = new Set<number>();
  return (j.picks ?? [])
    .map((p) => ({ i: Number(p.i), why: String(p.why ?? '').trim() }))
    .filter((p) => Number.isInteger(p.i) && p.i >= 0 && p.i < items.length && !seen.has(p.i) && seen.add(p.i));
}

/** The JSON object in a model's reply (models sometimes wrap it in a code fence or a sentence). */
function parseJson(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try {
    return JSON.parse(repairLatexEscapes(text.slice(a, b + 1)));
  } catch {
    throw new Error('The model did not reply in the expected format. Try again or pick another model.');
  }
}

// ---- low-level calls (live ink checks, streaming answers, voice) --------------------------------

export interface Usage {
  input: number;
  output: number;
}

export interface CompleteImage {
  mime: 'image/jpeg' | 'image/png';
  data: string; // base64
  label?: string;
  /** OpenAI-style detail hint ('low' saves tokens for small crops) */
  detail?: 'low' | 'high' | 'auto';
  /** pixel size, for token estimates when a provider reports no usage */
  w?: number;
  h?: number;
}

export interface CompleteRequest {
  system: string;
  images?: CompleteImage[];
  /** audio for the first user turn (OpenAI-compatible providers only) */
  audio?: { data: string; format: 'wav' | 'mp3' };
  turns: Turn[];
  maxTokens: number;
  /** ask for strict JSON following this schema (structured output where the provider has it) */
  json?: { name: string; schema: Record<string, unknown> };
  /** the system prompt is a static prefix: mark it for prompt caching (Anthropic; others cache prefixes implicitly) */
  cacheSystem?: boolean;
  signal?: AbortSignal;
  /** streams text as it arrives */
  onDelta?: (delta: string) => void;
}

export interface CompleteResult {
  text: string;
  truncated: boolean;
  /** null when the provider did not report usage */
  usage: Usage | null;
  model: string;
}

/** Providers whose OpenAI-compatible API takes response_format json_schema. */
const JSON_SCHEMA_OK = new Set<ProviderId>(['openai', 'google', 'openrouter', 'ollama', 'xai', 'mistral', 'groq', 'custom']);

async function completeAnthropic(c: AiChoice, r: CompleteRequest): Promise<CompleteResult> {
  const client = anthropicClient(c);
  const content: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  for (const img of r.images ?? []) {
    if (img.label) content.push({ type: 'text', text: img.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
  }
  const messages: Anthropic.MessageParam[] = r.turns.map((t, i) => (i === 0 ? { role: 'user', content: [...content, { type: 'text', text: t.text }] } : { role: t.role, content: t.text }));
  const system: Anthropic.MessageCreateParamsNonStreaming['system'] = r.cacheSystem ? [{ type: 'text', text: r.system, cache_control: { type: 'ephemeral' } }] : r.system;
  const full: Anthropic.MessageCreateParamsNonStreaming = { model: c.model, max_tokens: r.maxTokens, system, messages };
  if (c.effort && claudeAdaptive(c.model)) {
    full.thinking = { type: 'adaptive' };
    full.output_config = { effort: c.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  }
  if (r.json) full.output_config = { ...full.output_config, format: { type: 'json_schema', schema: r.json.schema } };
  const variants = [full];
  // structured output not available for this model: run once more, the prompt asks for JSON too
  if (r.json) variants.push({ ...full, output_config: full.output_config?.effort ? { effort: full.output_config.effort } : undefined });
  let lastErr: unknown;
  for (const params of variants) {
    try {
      const stream = client.messages.stream(params, { signal: r.signal });
      if (r.onDelta) stream.on('text', (d) => r.onDelta!(d));
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('The model declined this request.');
      const text = (msg.content as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
      const u = msg.usage;
      const usage = u ? { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 } : null;
      return { text, truncated: msg.stop_reason === 'max_tokens', usage, model: msg.model ?? c.model };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof Anthropic.BadRequestError) || !/format|schema|output_config/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

async function completeOpenAI(c: AiChoice, r: CompleteRequest): Promise<CompleteResult> {
  const client = openaiClient(c);
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
  for (const img of r.images ?? []) {
    if (img.label) parts.push({ type: 'text', text: img.label });
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}`, detail: img.detail ?? 'auto' } });
  }
  if (r.audio) parts.push({ type: 'input_audio', input_audio: { data: r.audio.data, format: r.audio.format } });
  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: c.model,
    messages: [{ role: 'system', content: r.system }, ...r.turns.map((t, i): OpenAI.Chat.ChatCompletionMessageParam => (i === 0 ? { role: 'user', content: [...parts, { type: 'text', text: t.text }] } : { role: t.role, content: t.text }))],
  };
  if (c.provider === 'openai') body.max_completion_tokens = r.maxTokens;
  else body.max_tokens = r.maxTokens;
  const fmt: OpenAI.Chat.ChatCompletionCreateParams['response_format'] | undefined = r.json
    ? JSON_SCHEMA_OK.has(c.provider)
      ? { type: 'json_schema', json_schema: { name: r.json.name, schema: r.json.schema, strict: true } }
      : { type: 'json_object' }
    : undefined;
  const effort = c.effort ? (c.provider === 'openrouter' ? { reasoning: { effort: c.effort } } : { reasoning_effort: c.effort }) : {};
  // most specific first; a provider that rejects a field gets the next variant
  const variants: object[] = [{ ...body, ...effort, ...(fmt ? { response_format: fmt } : {}) }];
  if (c.effort) variants.push({ ...body, ...(fmt ? { response_format: fmt } : {}) });
  if (fmt) variants.push(fmt.type === 'json_schema' ? { ...body, response_format: { type: 'json_object' } } : body, body);
  let lastErr: unknown;
  for (const v of variants) {
    try {
      if (r.onDelta) {
        const stream = await client.chat.completions.create({ ...(v as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming), stream: true, stream_options: { include_usage: true } }, { signal: r.signal });
        let text = '';
        let finish: string | null = null;
        let usage: Usage | null = null;
        let model = c.model;
        for await (const ch of stream) {
          const d = ch.choices?.[0]?.delta?.content;
          if (d) {
            text += d;
            r.onDelta(d);
          }
          finish = ch.choices?.[0]?.finish_reason ?? finish;
          if (ch.usage) usage = { input: ch.usage.prompt_tokens ?? 0, output: ch.usage.completion_tokens ?? 0 };
          if (ch.model) model = ch.model;
        }
        return { text, truncated: finish === 'length', usage, model };
      }
      const res = await client.chat.completions.create(v as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, { signal: r.signal });
      const ch = res.choices[0];
      const usage = res.usage ? { input: res.usage.prompt_tokens ?? 0, output: res.usage.completion_tokens ?? 0 } : null;
      return { text: ch?.message?.content ?? '', truncated: ch?.finish_reason === 'length', usage, model: res.model ?? c.model };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof OpenAI.BadRequestError) || !/reason|effort|response_format|json|schema|stream_options|unsupported|not supported/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

/**
 * One request with no retries (the caller decides about retries and failover), an abort signal,
 * a token limit, optional structured JSON output, streaming and usage reporting.
 */
export async function complete(c: AiChoice, r: CompleteRequest): Promise<CompleteResult> {
  if (!c.model) throw new Error('Choose a model first.');
  const res = await (c.provider === 'anthropic' ? completeAnthropic(c, r) : completeOpenAI(c, r));
  // the SDKs end an aborted stream quietly with the text so far; to the caller it is an abort
  if (r.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
  return res;
}

export type AiFailure = 'abort' | 'busy' | 'offline' | 'auth' | 'model' | 'bad-request' | 'other';

/** What kind of failure an AI call had: decides between retry, failover and giving up. */
export function aiFailure(e: unknown): AiFailure {
  if (e instanceof Anthropic.APIUserAbortError || e instanceof OpenAI.APIUserAbortError) return 'abort';
  if (e instanceof DOMException && e.name === 'AbortError') return 'abort';
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return 'offline';
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof OpenAI.PermissionDeniedError) return 'auth';
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError) return 'model';
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) {
    const s = e.status ?? 0;
    if ([408, 409, 429, 500, 502, 503, 504, 529].includes(s)) return 'busy';
    if (s === 400 || s === 422) return 'bad-request';
  }
  // the backend reports unreachable hosts as plain strings
  const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  if (/Could not reach|network|Failed to fetch|timed? ?out/i.test(msg)) return 'offline';
  return 'other';
}
