// Which provider and model a live check uses, failover between providers, a circuit breaker per
// provider, and token accounting for the status pill.
import type { AiChoice, AiFailure, AiSettings, ProviderId, Usage } from '../../lib/ai';
import { PROVIDERS, readyProviders, choiceFrom } from '../../lib/ai';

import { POLICY, priceOf, type Tier } from './policy';

export type { Tier };

const NOT_LIVE = POLICY.notLive;
const UNSTABLE = POLICY.unstable;

/** Version numbers in a model id, for "newest first" (gemini-3.5-flash-lite > gemini-2.5-flash-lite). */
function version(id: string): number[] {
  return (id.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}
function newer(a: string, b: string): number {
  // stable models before previews
  const pa = UNSTABLE.test(a) ? 1 : 0, pb = UNSTABLE.test(b) ? 1 : 0;
  if (pa !== pb) return pa - pb;
  // "-latest" aliases always follow the newest model
  const la = /latest/.test(a) ? 1 : 0, lb = /latest/.test(b) ? 1 : 0;
  if (la !== lb) return lb - la;
  const va = version(a), vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d) return d;
  }
  return a.length - b.length; // plain id before dated snapshots
}

const PREFS = POLICY.models;

/**
 * The model for a tier from the provider's live model list. Falls back to the user's own model,
 * which is always a sensible choice (it is what they picked for everything else).
 */
export function pickModel(provider: ProviderId, models: readonly string[], tier: Tier, userModel: string): string {
  const prefs = PREFS[provider]?.[tier];
  if (tier === 'strong' && userModel && (POLICY.strongIsUserModel.includes(provider) || !prefs)) return userModel;
  if (prefs) {
    const usable = models.filter((m) => !NOT_LIVE.test(m));
    for (const re of prefs) {
      const hits = usable.filter((m) => re.test(m)).sort(newer);
      if (hits.length) return hits[0];
    }
  }
  return userModel || models[0] || '';
}

/** The lightest effort the provider takes (no thinking at all for Claude). */
export function effortFor(provider: ProviderId, tier: Tier): string {
  const levels = PROVIDERS[provider].efforts;
  const e = POLICY.effort;
  if (provider === 'anthropic') return tier === 'fast' ? e.anthropicFast : e.anthropicStrong;
  if (tier === 'fast') return e.fastPrefs.find((l) => levels.includes(l)) ?? '';
  return levels.includes(e.strong) ? e.strong : '';
}

/** Ready providers, the user's chosen one first: the failover order. */
export function providerOrder(ai: AiSettings): ProviderId[] {
  const ready = readyProviders(ai);
  return ready.includes(ai.provider) ? [ai.provider, ...ready.filter((p) => p !== ai.provider)] : ready;
}

export function choiceFor(ai: AiSettings, provider: ProviderId, models: readonly string[], tier: Tier): AiChoice {
  const base = choiceFrom(ai, provider);
  const model = pickModel(provider, models.length ? models : PROVIDERS[provider].models, tier, base.model);
  return { ...base, model, effort: effortFor(provider, tier) };
}

// ---- circuit breaker ----------------------------------------------------------------------------

interface BreakerState {
  failures: number;
  openUntil: number;
  last?: AiFailure;
}

/**
 * Per provider: after a failure the provider is skipped for a cool-down that doubles with each
 * further failure (rate limits and outages), much longer for a rejected key. A success resets it.
 */
export class Breaker {
  private s = new Map<ProviderId, BreakerState>();
  private now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  allow(p: ProviderId): boolean {
    return (this.s.get(p)?.openUntil ?? 0) <= this.now();
  }

  fail(p: ProviderId, kind: AiFailure) {
    if (kind === 'abort' || kind === 'bad-request' || kind === 'other') return;
    const st = this.s.get(p) ?? { failures: 0, openUntil: 0 };
    st.failures++;
    st.last = kind;
    const b = POLICY.breaker;
    const pause = kind === 'auth' || kind === 'model' ? b.authMs : Math.min(b.maxMs, (kind === 'offline' ? b.offlineMs : b.busyMs) * 2 ** (st.failures - 1));
    st.openUntil = this.now() + pause;
    this.s.set(p, st);
  }

  ok(p: ProviderId) {
    this.s.delete(p);
  }

  /** why a provider is paused, if it is */
  reason(p: ProviderId): AiFailure | null {
    const st = this.s.get(p);
    return st && st.openUntil > this.now() ? (st.last ?? null) : null;
  }

  reset() {
    this.s.clear();
  }
}

// ---- tokens -------------------------------------------------------------------------------------

/** Rough token cost of an image, for providers that do not report usage. */
export function imageTokens(provider: ProviderId, w: number, h: number): number {
  if (provider === 'anthropic') return Math.ceil((w * h) / 750);
  if (provider === 'google') return w <= 384 && h <= 384 ? 258 : 258 * Math.ceil(w / 768) * Math.ceil(h / 768);
  return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
}

export const textTokens = (s: string) => Math.ceil(s.length / 3.6);

export class TokenMeter {
  input = 0;
  output = 0;
  calls = 0;
  /** estimated cost in USD (models with a known price only) */
  usd = 0;
  add(u: Usage | null, estimate: Usage, model = '') {
    const x = u && (u.input || u.output) ? u : estimate;
    this.input += x.input;
    this.output += x.output;
    this.calls++;
    const p = priceOf(model);
    if (p) this.usd += (x.input * p.in + x.output * p.out) / 1e6;
    return x;
  }
}
