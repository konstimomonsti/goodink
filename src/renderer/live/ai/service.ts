// LiveAi: the one object the engine and the UI talk to for AI. It picks provider and model per
// tier, fails over between ready providers behind a circuit breaker, caches line judgements by
// content hash (memory + persisted LRU), and counts tokens and cost for the status pill.
import { aiFailure, choiceFrom, complete as defaultComplete, listModels as defaultListModels, PROVIDERS, type AiChoice, type AiFailure, type AiSettings, type CompleteImage, type CompleteRequest, type ProviderId, type Turn, type Usage } from '../../lib/ai';
import { PersistentLru, browserKV, type KV } from './cache';
import { judgeLine, type CallOpts, type CallResult, type JudgeInput, type JudgeResult } from './check';
import { Breaker, choiceFor, effortFor, imageTokens, providerOrder, textTokens, TokenMeter, type Tier } from './router';
import { streamAsk, type StreamAskResult } from './stream';
import { POLICY, type HintLevel, type IssueBrief, type QuickActionId } from './policy';
import { audioProvider, LocalDictationNeeded, toWav16k, transcribeWith } from './voice';

export interface LiveAiOptions {
  /** the saved AI settings (read on every call, so settings changes apply at once) */
  settings: () => AiSettings | undefined;
  complete?: typeof defaultComplete;
  listModels?: (c: AiChoice) => Promise<string[]>;
  now?: () => number;
  /** where the AI result cache persists; null = memory only */
  kv?: KV | null;
  /** resolves once `settings` can answer (settings load asynchronously in the app) */
  settingsReady?: Promise<unknown>;
}

export class NoAiProvider extends Error {
  why: AiFailure | 'none';
  constructor(why: AiFailure | 'none') {
    super(why === 'none' ? 'No AI provider is set up.' : why === 'offline' ? 'The AI provider cannot be reached.' : why === 'auth' ? 'The API key was rejected.' : 'The AI provider is busy. Live checks continue on this PC.');
    this.name = 'NoAiProvider';
    this.why = why;
  }
}

export type AiHealth = 'ok' | 'offline' | 'busy' | 'auth' | 'none';

export class LiveAi {
  readonly meter = new TokenMeter();
  readonly breaker: Breaker;
  private run: typeof defaultComplete;
  private list: (c: AiChoice) => Promise<string[]>;
  private models = new Map<string, Promise<string[]>>();
  private cache: PersistentLru<Omit<JudgeResult, 'verify'>>;
  /** last call outcome, for the status pill */
  health: AiHealth = 'ok';
  /** calls in flight */
  inflight = 0;
  private listeners = new Set<() => void>();

  private o: LiveAiOptions;
  constructor(o: LiveAiOptions) {
    this.o = o;
    this.run = o.complete ?? defaultComplete;
    this.list = o.listModels ?? defaultListModels;
    this.breaker = new Breaker(o.now);
    this.cache = new PersistentLru<Omit<JudgeResult, 'verify'>>(o.kv === undefined ? browserKV() : o.kv, POLICY.cache.storageKey, POLICY.cache.aiEntries, POLICY.cache.aiBytes);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private changed() {
    for (const l of this.listeners) l();
  }

  private settings(): AiSettings | undefined {
    const ai = this.o.settings();
    return ai && ai.keys.length ? ai : undefined;
  }

  /** Resolves once the settings have loaded. */
  whenReady(): Promise<unknown> {
    return this.o.settingsReady ?? Promise.resolve();
  }

  /** A provider is set up (it may still be paused by the breaker). */
  ready(): boolean {
    const ai = this.settings();
    return !!ai && providerOrder(ai).length > 0;
  }

  /** Ready and not every provider paused. */
  available(): boolean {
    const ai = this.settings();
    return !!ai && providerOrder(ai).some((p) => this.breaker.allow(p));
  }

  private modelsFor(c: AiChoice): Promise<string[]> {
    const key = `${c.provider}|${c.baseURL ?? ''}`;
    let p = this.models.get(key);
    if (!p) {
      let t: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<string[]>((r) => (t = setTimeout(() => r([]), POLICY.modelListTimeoutMs)));
      p = Promise.race([this.list(c).catch(() => [] as string[]), timeout]).finally(() => clearTimeout(t));
      this.models.set(key, p);
      // an empty list (offline at the time) is asked for again next time
      void p.then((m) => !m.length && this.models.delete(key));
    }
    return p;
  }

  private async choice(ai: AiSettings, p: ProviderId, tier: Tier | 'user', think?: boolean): Promise<AiChoice> {
    if (tier === 'user') {
      const c = choiceFrom(ai, p);
      // answers should come quickly: cap the user's effort at a low level
      const low = POLICY.answerEffortPrefs.find((l) => PROVIDERS[p].efforts.includes(l)) ?? '';
      return { ...c, effort: c.effort && c.effort !== 'none' && c.effort !== 'minimal' ? low : c.effort };
    }
    const c = choiceFor(ai, p, await this.modelsFor(choiceFrom(ai, p)), tier);
    // judge calls never think; only Max-mode verification may
    return think === undefined ? c : { ...c, effort: effortFor(p, think ? 'strong' : 'fast') };
  }

  /** The provider a call would go to first right now (null when none is available). */
  firstProvider(): ProviderId | null {
    const ai = this.settings();
    return (ai && providerOrder(ai).find((p) => this.breaker.allow(p))) ?? null;
  }

  private estimate(req: CompleteRequest, text: string, provider: ProviderId): Usage {
    let input = textTokens(req.system) + req.turns.reduce((n, t) => n + textTokens(t.text), 0);
    for (const img of req.images ?? []) input += imageTokens(provider, img.w ?? 800, img.h ?? 300);
    return { input, output: textTokens(text) };
  }

  /**
   * Run fn on the best provider for a tier, failing over to the next ready provider on rate limits,
   * outages and rejected keys (each one then pauses behind the breaker). Aborts propagate.
   * `started()` tells it that output already reached the user, after which it must not retry.
   */
  async withFailover<T>(tier: Tier | 'user', signal: AbortSignal | undefined, fn: (c: AiChoice) => Promise<T>, started: () => boolean = () => false, opts: CallOpts = {}): Promise<T> {
    if (this.o.settingsReady) await this.o.settingsReady;
    const ai = this.settings();
    if (!ai) {
      this.health = 'none';
      throw new NoAiProvider('none');
    }
    const all = providerOrder(ai);
    let order = all.filter((p) => this.breaker.allow(p));
    // cross-vendor: another provider first when one is ready, the avoided one only as a fallback
    if (opts.avoid && order.length > 1) order = [...order.filter((p) => p !== opts.avoid), ...order.filter((p) => p === opts.avoid)];
    if (!order.length) throw new NoAiProvider(this.breaker.reason(all[0]) ?? 'busy');
    let last: unknown = new NoAiProvider('busy');
    let lastKind: AiFailure = 'busy';
    this.inflight++;
    this.changed();
    try {
      for (const p of order) {
        let c = await this.choice(ai, p, tier, opts.think);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await fn(c);
            this.breaker.ok(p);
            this.health = 'ok';
            return r;
          } catch (e) {
            const kind = aiFailure(e);
            if (kind === 'abort' || signal?.aborted || started()) throw e;
            last = e;
            lastKind = kind;
            // the picked model is not available on this key: try the user's own model once
            const own = choiceFrom(ai, p).model;
            if (kind === 'model' && attempt === 0 && own && own !== c.model) {
              c = { ...c, model: own };
              continue;
            }
            this.breaker.fail(p, kind);
            if (kind === 'bad-request' || kind === 'other') throw e; // another provider would not help
            break;
          }
        }
      }
      this.health = lastKind === 'offline' ? 'offline' : lastKind === 'auth' ? 'auth' : 'busy';
      throw last;
    } finally {
      this.inflight--;
      this.changed();
    }
  }

  /** One request with failover; usage is counted (estimated when the provider reports none). */
  call(tier: Tier | 'user', req: CompleteRequest, opts: CallOpts = {}): Promise<CallResult & { provider: ProviderId }> {
    return this.withFailover(
      tier,
      req.signal,
      async (c) => {
        const r = await this.run(c, req);
        const usage = this.meter.add(r.usage, this.estimate(req, r.text, c.provider), r.model || c.model);
        return { text: r.text, truncated: r.truncated, usage, model: r.model, provider: c.provider };
      },
      undefined,
      opts,
    );
  }

  // ---- line checks ------------------------------------------------------------------------------

  cached(key: string): JudgeResult | undefined {
    const c = this.cache.get(key);
    return c && { ...c, tokens: { input: 0, output: 0 }, verify: null };
  }

  /** Judge one line (+ blind re-solve); cached by content key. */
  async judge(key: string, input: JudgeInput): Promise<JudgeResult | null> {
    const have = this.cached(key);
    if (have) return have;
    const out = await judgeLine((tier, req, opts) => this.call(tier, req, opts), input, { judgeProvider: this.firstProvider() ?? undefined });
    // only settled verdicts are kept: an unconfirmed error is asked again next time
    if (out && !(out.outcome.verdict === 'error' && !out.outcome.confirmed && !out.outcome.refuted)) {
      const { verify: _v, ...keep } = out;
      void _v;
      this.cache.set(key, keep);
    }
    return out;
  }

  // ---- answers ----------------------------------------------------------------------------------

  /** Streamed tutor answer (insight card ladder, ask box, AI selector chips), with failover. */
  async ask(o: { images: CompleteImage[]; context?: string; question?: string; history?: Turn[]; level?: HintLevel; action?: QuickActionId; issue?: IssueBrief; grounding?: string; signal?: AbortSignal }, onDelta: (textSoFar: string) => void): Promise<StreamAskResult & { ms: number }> {
    const t0 = performance.now();
    let shown = false;
    const r = await this.withFailover(
      'user',
      o.signal,
      (choice) =>
        streamAsk({ ...o, choice }, (t) => {
          shown ||= t.length > 0;
          onDelta(t);
        }, this.run),
      () => shown,
    );
    const req: CompleteRequest = { system: '', images: o.images, turns: [{ role: 'user', text: (o.context ?? '') + (o.question ?? '') }], maxTokens: 0 };
    r.usage = this.meter.add(r.usage, { input: this.estimate(req, '', 'google').input + 500, output: textTokens(r.text) }, r.model);
    this.changed();
    return { ...r, ms: Math.round(performance.now() - t0) };
  }

  // ---- voice ------------------------------------------------------------------------------------

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    if (this.o.settingsReady) await this.o.settingsReady;
    const ai = this.settings();
    const p = ai && audioProvider(providerOrder(ai));
    if (!ai || !p) throw new LocalDictationNeeded();
    const c = await this.choice(ai, p, 'fast');
    const r = await transcribeWith(c, await toWav16k(audio), signal, this.run);
    this.meter.add(r.usage, { input: 50 + Math.round(audio.size / 400), output: textTokens(r.text) }, c.model);
    this.changed();
    return r.text;
  }
}
