// Live Ink AI policy: every tunable knob in one place, so model choice and prices, crop/encoding,
// the verification policy, timing, budgets and prompts can be retuned without touching the logic.
// Prompt templates live in ./prompts.ts and are re-exported here. Decisions behind the defaults:
// docs/live-ink/ARCHITECTURE.md and RESEARCH-recognition.md §4–5, RESEARCH-ux.md §2.
import type { ProviderId } from '../../lib/ai';

export * from './prompts';

/** fast: cheap quick vision model (Smart). strong: the best model (Max). */
export type Tier = 'fast' | 'strong';

/** USD per 1M tokens: input / cached input / output (standard tier, 2026-10-13). */
export interface Price {
  in: number;
  cached: number;
  out: number;
}

export const POLICY = {
  // ---- timing (RESEARCH-ux §2 rules 1–2) ----------------------------------------------------------
  /** a block is checked this long after the last pen-up in it; amber and ticks show then */
  settleMs: 600,
  /** red never appears sooner than this after the last pen-up in its line */
  redMinMs: 900,
  /** red is held while the pen is active within this many line-heights of the line ... */
  holdLineHeights: 2,
  /** ... until the pen has paused this long (or moved to a new line below) */
  holdPauseMs: 1500,
  /** "why?", "this", "here" refer to the block under the pen or the last one written this recently */
  deicticWindowMs: 10_000,
  /** AI line checks running at once */
  aiConcurrency: 3,
  /** an AI call running longer than this shows as "slow" */
  slowMs: 4000,

  // ---- red-mark policy (merge.ts, ARCHITECTURE §A.2) ----------------------------------------------
  /** a reading at least this confident counts as what the learner wrote */
  confidentReading: 0.9,
  /** a local CAS issue needs at least this confidence to be final on a confident reading */
  confidentCas: 0.9,
  /** the blind re-solve starts together with the judge call, not after it */
  verifyInParallel: true,
  /** the blind re-solve runs on another vendor when two providers are ready (uncorrelated errors) */
  crossVendorVerify: true,
  /** verification tier per mode (Max verifies with the strong model, and may think) */
  verifyTier: { smart: 'fast', max: 'strong' } as Record<'smart' | 'max', Tier>,
  /** earlier steps sent as text with a judge or verify call */
  priorLines: 1000,
  /** the rest of the page (other worked parts, the problem statement, definitions, typed text), as
   *  context for a check: complicated problems need it, and it is the same for every line of a
   *  page, so the provider's prompt cache reuses it (owner, 2026-10-17: a big context window) */
  contextChars: 40_000,
  /** what the tutor sees when asked: this page and its neighbours */
  askContextChars: 120_000,
  askNeighbourPages: 1,
  /** show the AI's unconfirmed finding as amber while the second opinion runs */
  showUnconfirmedAsAmber: true,
  /** Smart judges a line only when the CAS left it undecided (or a shaky local error) */
  smartOnlyUndecided: true,
  /** ... or when this PC is not sure it read the line right, even if the CAS found it correct:
   *  a misread can hide a real mistake (owner's rule: on-device when sure, else the cloud) */
  smartEscalateShakyReading: true,
  /** the model Smart escalates to: the better, slower one (the owner asked for the better model) */
  smartTier: 'strong' as Tier,
  /** Smart sends every formula line to the cloud model, not only the ones this PC is unsure of
   *  (owner, 2026-10-17). The CAS stays the instant first pass and the veto against false reds. */
  cloudChecksEveryFormula: true,
  /** after the stronger model is rate-limited or missing, use the user's own model this long */
  downgradeMs: 10 * 60_000,
  /** lines that wanted the cloud while it was busy or unreachable are tried again after these waits */
  retryAiMs: [15_000, 45_000, 120_000],
  /** ink older than this session is judged by AI only when the learner opens its card */
  aiOnlyForFreshInk: true,
  /** only the first error of a block is marked red; later ones are in the card */
  firstErrorOnly: true,

  // ---- crop / encoding (crop.ts, RESEARCH-recognition §4 token tricks) ----------------------------
  crop: {
    /** target x-height in output px (20–28 reads well; Claude reads small text badly) */
    xHeightPx: 24,
    /** x-height as a share of a handwritten line's box height */
    xHeightRatio: 0.45,
    /** padding around the line, output px */
    padPx: 12,
    /** long edge cap, output px */
    maxLong: 1000,
    /** questions about a whole block: a bit larger */
    askXHeightPx: 26,
    askMaxLong: 1200,
    minScale: 0.3,
    maxScale: 8,
    /** floors on the output size, so 2-D formulas (integrals with limits) stay readable */
    minLongPx: 480,
    minShortPx: 120,
    /** thinnest stroke in output px, so small crops stay legible */
    minStrokePx: 1.2,
    /** black ink on white (grayscale content); PNG keeps two-tone ink tiny and sharp */
    format: 'image/png' as 'image/png' | 'image/jpeg',
    /** OpenAI-style detail hint sent with check images */
    detail: 'high' as 'low' | 'high' | 'auto',
  },

  // ---- output budgets ------------------------------------------------------------------------------
  budget: {
    /** one judged line of compact JSON (~80 tokens typical) */
    judge: 360,
    /** Max mode judge (still no thinking) */
    judgeStrong: 1200,
    verifyFast: 320,
    /** Max mode verification may think */
    verifyStrong: 4000,
    answer: 1600,
    transcribe: 600,
  },

  // ---- models --------------------------------------------------------------------------------------
  /** models never used for live work */
  notLive: /tts|image|audio|realtime|transcribe|embed|search|computer|codex|nano|thinking|instruct|live/i,
  /** previews and experiments rank after stable models */
  unstable: /preview|exp/i,
  /** per provider and tier: patterns tried in order, newest match wins; else the user's model */
  models: {
    google: { fast: [/flash-lite/, /flash/], strong: [/pro/, /flash(?!-lite)/] },
    anthropic: { fast: [/haiku/, /sonnet/], strong: [/sonnet/, /opus/] },
    openai: { fast: [/^gpt-[\d.]+-mini$/, /^gpt-[\d.o]+-mini/, /mini/], strong: [/^gpt-[\d.]+$/, /^gpt-[\d.o]+$/] },
    xai: { fast: [/mini|fast/], strong: [/^grok-[\d.]+$/] },
    mistral: { fast: [/small/], strong: [/large|medium/] },
    openrouter: { fast: [/flash-lite|haiku|mini/], strong: [/pro|opus|sonnet/] },
  } as Partial<Record<ProviderId, Record<Tier, RegExp[]>>>,
  /** for OpenAI the strong tier is the user's own model */
  strongIsUserModel: ['openai'] as ProviderId[],
  /** reasoning effort when a call may think (Max verification); judge calls never think */
  effort: { fastPrefs: ['none', 'minimal', 'low'], strong: 'medium', anthropicFast: '', anthropicStrong: 'medium' },
  /** answers (hint ladder, ask box) cap the user's effort at this */
  answerEffortPrefs: ['low', 'minimal', 'none'],
  /** prices by model id prefix (longest match wins), for the cost shown next to the token count */
  prices: {
    'claude-haiku-5-5': { in: 0.1, cached: 0.01, out: 0.5 },
    'claude-sonnet-5-5': { in: 2, cached: 0.1, out: 10 },
    'gemini-2.5-flash-lite': { in: 0.1, cached: 0.01, out: 0.4 },
    'gemini-3.1-flash-lite': { in: 0.25, cached: 0.025, out: 1.5 },
    'gemini-flash-lite-latest': { in: 0.25, cached: 0.025, out: 1.5 },
    'gemini-3-flash': { in: 0.5, cached: 0.05, out: 3 },
    'gemini-3.6-flash': { in: 0.75, cached: 0.075, out: 3.75 },
    'gemini-3.8-flash': { in: 0.75, cached: 0.075, out: 3.75 },
    'gpt-5-nano': { in: 0.05, cached: 0.005, out: 0.4 },
    'gpt-6-luna': { in: 0.1, cached: 0.01, out: 0.5 },
  } as Record<string, Price>,

  // ---- voice ---------------------------------------------------------------------------------------
  /** providers whose chat API takes audio input, in order of preference after the user's own */
  audioProviders: ['google', 'openai', 'openrouter'] as ProviderId[],
  /** audio models to try when the chat model itself cannot listen */
  audioModels: { openai: ['gpt-audio-mini', 'gpt-4o-mini-audio-preview'], openrouter: ['google/gemini-flash-lite-latest', 'openai/gpt-audio-mini'] } as Partial<Record<ProviderId, string[]>>,

  // ---- resilience ----------------------------------------------------------------------------------
  breaker: { busyMs: 20_000, offlineMs: 15_000, authMs: 10 * 60_000, maxMs: 5 * 60_000 },
  modelListTimeoutMs: 4000,

  // ---- caching and storage ------------------------------------------------------------------------
  cache: { aiEntries: 600, aiBytes: 500_000, localEntries: 400, storageKey: 'goodink.live.ai.v2' },
  journal: { maxEntries: 500, storagePrefix: 'goodink.live.journal.' },
};

/** Price of a model (null when unknown). */
export function priceOf(model: string): Price | null {
  let best: string | null = null;
  for (const k of Object.keys(POLICY.prices)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? POLICY.prices[best] : null;
}
