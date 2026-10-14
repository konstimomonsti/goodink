// Spaced repetition: a port of Anki's v3 scheduler (SM-2 based) with Anki's default deck options.
// Mirrors rslib/src/scheduler/states/{learning,relearning,review,steps,fuzz}.rs: learning steps,
// graduating intervals, ease changes, lapses + relearning, leeches, interval fuzz and the 4am day
// rollover. Pure functions, so it can be unit tested without the app.
import type { Flashcard } from '../../shared/types';

export type Grade = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export interface SrsConfig {
  learnSteps: number[]; // minutes
  relearnSteps: number[]; // minutes
  graduatingGood: number; // days
  graduatingEasy: number; // days
  initialEase: number;
  easyBonus: number;
  hardMultiplier: number;
  lapseMultiplier: number; // "new interval" after a lapse
  intervalModifier: number;
  maxInterval: number; // days
  minLapseInterval: number; // days
  leechThreshold: number;
  newPerDay: number;
  reviewsPerDay: number;
  learnAheadMins: number;
  rolloverHour: number;
}

export const ANKI_DEFAULTS: SrsConfig = {
  learnSteps: [1, 10],
  relearnSteps: [10],
  graduatingGood: 1,
  graduatingEasy: 4,
  initialEase: 2.5,
  easyBonus: 1.3,
  hardMultiplier: 1.2,
  lapseMultiplier: 0,
  intervalModifier: 1,
  maxInterval: 36500,
  minLapseInterval: 1,
  leechThreshold: 8,
  newPerDay: 20,
  reviewsPerDay: 200,
  learnAheadMins: 20,
  rolloverHour: 4,
};

const MIN_EASE = 1.3;
const SEC = 1000;
const DAY_SECS = 86400;

// ---- days (Anki's "today" starts at the rollover hour, local time) ----------------------------

export function dayNumber(ms: number, cfg = ANKI_DEFAULTS) {
  const d = new Date(ms - cfg.rolloverHour * 3600 * SEC);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (DAY_SECS * SEC));
}

export function dayStart(day: number, cfg = ANKI_DEFAULTS) {
  const d = new Date(day * DAY_SECS * SEC);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), cfg.rolloverHour).getTime();
}

// ---- card state --------------------------------------------------------------------------------

/** Fill in fields for cards saved by the old scheduler (or brand new ones). */
export function normalize(c: Flashcard, cfg = ANKI_DEFAULTS): Required<Flashcard> {
  const state = c.state ?? (c.interval > 0 ? 'review' : 'new');
  return {
    id: c.id,
    pageId: c.pageId ?? '',
    state,
    ease: c.ease || cfg.initialEase,
    interval: state === 'review' || state === 'relearning' ? Math.max(1, Math.round(c.interval)) : Math.round(c.interval),
    due: c.due ?? 0,
    remaining: c.remaining ?? 0,
    lapses: c.lapses ?? 0,
    reps: c.reps ?? 0,
    leech: c.leech ?? false,
    lastReview: c.lastReview ?? (state === 'review' ? Math.max(0, (c.due ?? 0) - Math.round(c.interval) * DAY_SECS * SEC) : 0),
  };
}

// ---- learning steps (steps.rs) -----------------------------------------------------------------

function stepIndex(steps: number[], remaining: number) {
  return Math.min(Math.max(0, steps.length - (remaining % 1000)), steps.length - 1);
}
const stepSecs = (steps: number[], i: number) => (i < steps.length ? Math.round(steps[i] * 60) : undefined);

function hardDelaySecs(steps: number[], remaining: number) {
  const idx = stepIndex(steps, remaining);
  const current = stepSecs(steps, idx);
  if (current === undefined) return undefined;
  if (idx > 0) return current;
  const next = stepSecs(steps, 1);
  if (next !== undefined) return Math.floor((current + next) / 2);
  return Math.min(Math.floor(current * 1.5), current + DAY_SECS);
}
const goodDelaySecs = (steps: number[], remaining: number) => stepSecs(steps, stepIndex(steps, remaining) + 1);
const remainingForGood = (steps: number[], remaining: number) => Math.max(0, steps.length - (stepIndex(steps, remaining) + 1));

// ---- fuzz (fuzz.rs) ----------------------------------------------------------------------------

const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Infinity, factor: 0.05 },
];

function fuzzDelta(interval: number) {
  if (interval < 2.5) return 0;
  return FUZZ_RANGES.reduce((d, r) => d + r.factor * Math.max(0, Math.min(interval, r.end) - r.start), 1);
}

export function fuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  minimum = Math.min(minimum, maximum);
  interval = Math.min(Math.max(interval, minimum), maximum);
  const delta = fuzzDelta(interval);
  let lower = Math.round(interval - delta);
  let upper = Math.round(interval + delta);
  lower = Math.min(Math.max(lower, minimum), maximum);
  upper = Math.min(Math.max(upper, minimum), maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

function reviewFuzz(fuzz: number | null, interval: number, minimum: number, maximum: number) {
  if (fuzz === null) return Math.min(Math.max(Math.round(interval), minimum), maximum);
  const [lower, upper] = fuzzBounds(interval, minimum, maximum);
  return Math.floor(lower + fuzz * (1 + upper - lower));
}

function learningFuzz(fuzz: number | null, secs: number) {
  if (fuzz === null) return secs;
  const upper = secs + Math.floor(Math.min(secs * 0.25, 300));
  return secs >= upper ? secs : secs + Math.floor(fuzz * (upper - secs));
}

/** Anki seeds fuzz from the card id and its review count, so the shown interval is the one you get. */
export function fuzzSeed(c: Flashcard) {
  let h = 2166136261;
  const key = `${c.id}:${c.reps ?? 0}`;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// ---- review intervals (review.rs) --------------------------------------------------------------

function minMax(cfg: SrsConfig, minimum: number): [number, number] {
  const maximum = Math.max(1, cfg.maxInterval);
  return [Math.min(Math.max(minimum, 1), maximum), maximum];
}

function constrainPassing(cfg: SrsConfig, fuzz: number | null, interval: number, minimum: number) {
  const [lo, hi] = minMax(cfg, minimum);
  return reviewFuzz(fuzz, interval * cfg.intervalModifier, lo, hi);
}

function passingIntervals(c: Required<Flashcard>, today: number, cfg: SrsConfig, fuzz: number | null) {
  const current = c.interval;
  const elapsed = Math.max(0, today - dayNumber(c.lastReview, cfg));
  const daysLate = Math.max(0, elapsed - current);
  const hardMin = cfg.hardMultiplier <= 1 ? 0 : current + 1;
  const hard = constrainPassing(cfg, fuzz, current * cfg.hardMultiplier, hardMin);
  const goodMin = cfg.hardMultiplier <= 1 ? current + 1 : hard + 1;
  const good = constrainPassing(cfg, fuzz, (current + daysLate / 2) * c.ease, goodMin);
  const easy = constrainPassing(cfg, fuzz, (current + daysLate) * c.ease * cfg.easyBonus, good + 1);
  return { hard, good, easy };
}

function failingInterval(c: Required<Flashcard>, cfg: SrsConfig) {
  const [lo, hi] = minMax(cfg, cfg.minLapseInterval);
  return Math.min(Math.max(Math.round(c.interval * cfg.lapseMultiplier), lo), hi);
}

export function leechThresholdMet(lapses: number, threshold: number) {
  if (threshold <= 0) return false;
  const half = Math.max(1, Math.ceil(threshold / 2));
  return lapses >= threshold && (lapses - threshold) % half === 0;
}

// ---- answering ---------------------------------------------------------------------------------

export interface Answer {
  card: Required<Flashcard>;
  /** seconds until due for learning steps, otherwise undefined */
  secs?: number;
  /** days until due for review cards */
  days?: number;
  leechNow: boolean;
}

function learnDue(now: number, secs: number, cfg: SrsConfig) {
  // steps of a day or more are "interday" and become due at the day rollover, like Anki
  if (secs >= DAY_SECS) return dayStart(dayNumber(now, cfg) + Math.round(secs / DAY_SECS), cfg);
  return now + secs * SEC;
}

function toReview(c: Required<Flashcard>, interval: number, now: number, cfg: SrsConfig, extra: Partial<Flashcard> = {}): Answer {
  const today = dayNumber(now, cfg);
  return { card: { ...c, ...extra, state: 'review', interval, remaining: 0, due: dayStart(today + interval, cfg), lastReview: now }, days: interval, leechNow: false };
}

function toLearning(c: Required<Flashcard>, state: 'learning' | 'relearning', remaining: number, secs: number, now: number, cfg: SrsConfig, fuzz: number | null, extra: Partial<Flashcard> = {}): Answer {
  // like Anki, the button shows the plain step; the fuzz only moves the actual due time
  return { card: { ...c, ...extra, state, remaining, due: learnDue(now, learningFuzz(fuzz, secs), cfg), lastReview: now }, secs, leechNow: false };
}

export function answer(card: Flashcard, grade: Grade, now: number, cfg = ANKI_DEFAULTS, fuzz: number | null = fuzzSeed(card)): Answer {
  const c = { ...normalize(card, cfg), reps: (card.reps ?? 0) + 1 };
  const today = dayNumber(now, cfg);

  if (c.state === 'new' || c.state === 'learning') {
    const steps = cfg.learnSteps;
    const remaining = c.state === 'new' ? steps.length : c.remaining;
    const ease = cfg.initialEase;
    const [lo, hi] = minMax(cfg, 1);
    const graduate = (days: number) => toReview(c, reviewFuzz(fuzz, days, lo, hi), now, cfg, { ease });
    if (!steps.length) return graduate(grade === 4 ? cfg.graduatingEasy : cfg.graduatingGood);
    if (grade === 1) return toLearning(c, 'learning', steps.length, stepSecs(steps, 0)!, now, cfg, fuzz, { ease });
    if (grade === 2) {
      const secs = hardDelaySecs(steps, remaining);
      return secs === undefined ? graduate(cfg.graduatingGood) : toLearning(c, 'learning', remaining, secs, now, cfg, fuzz, { ease });
    }
    if (grade === 3) {
      const secs = goodDelaySecs(steps, remaining);
      return secs === undefined ? graduate(cfg.graduatingGood) : toLearning(c, 'learning', remainingForGood(steps, remaining), secs, now, cfg, fuzz, { ease });
    }
    return graduate(cfg.graduatingEasy);
  }

  if (c.state === 'relearning') {
    const steps = cfg.relearnSteps;
    if (!steps.length) return toReview(c, c.interval, now, cfg);
    if (grade === 1) return toLearning(c, 'relearning', steps.length, stepSecs(steps, 0)!, now, cfg, fuzz);
    if (grade === 2) {
      const secs = hardDelaySecs(steps, c.remaining);
      return secs === undefined ? toReview(c, c.interval, now, cfg) : toLearning(c, 'relearning', c.remaining, secs, now, cfg, fuzz);
    }
    if (grade === 3) {
      const secs = goodDelaySecs(steps, c.remaining);
      return secs === undefined ? toReview(c, c.interval, now, cfg) : toLearning(c, 'relearning', remainingForGood(steps, c.remaining), secs, now, cfg, fuzz);
    }
    return toReview(c, c.interval + 1, now, cfg);
  }

  // review
  if (grade === 1) {
    const lapses = c.lapses + 1;
    const leechNow = leechThresholdMet(lapses, cfg.leechThreshold);
    const extra = { lapses, ease: Math.max(MIN_EASE, c.ease - 0.2), interval: failingInterval(c, cfg), leech: c.leech || leechNow };
    const steps = cfg.relearnSteps;
    const a = steps.length
      ? toLearning(c, 'relearning', steps.length, stepSecs(steps, 0)!, now, cfg, fuzz, extra)
      : toReview(c, extra.interval, now, cfg, extra);
    return { ...a, leechNow };
  }
  const iv = passingIntervals(c, today, cfg, fuzz);
  if (grade === 2) return toReview(c, iv.hard, now, cfg, { ease: Math.max(MIN_EASE, c.ease - 0.15) });
  if (grade === 3) return toReview(c, iv.good, now, cfg);
  return toReview(c, iv.easy, now, cfg, { ease: c.ease + 0.15 });
}

/** What each button would do, for the labels above them (Anki's "show next review time"). */
export function previews(card: Flashcard, now: number, cfg = ANKI_DEFAULTS) {
  return ([1, 2, 3, 4] as Grade[]).map((g) => {
    const a = answer(card, g, now, cfg);
    return a.secs !== undefined ? formatSecs(a.secs) : formatDays(a.days ?? 0);
  });
}

export function formatSecs(secs: number) {
  if (secs < 60) return '<1m';
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < DAY_SECS) return `${+(secs / 3600).toFixed(1)}h`;
  return formatDays(secs / DAY_SECS);
}

export function formatDays(days: number) {
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${+(days / 30).toFixed(1)}mo`;
  return `${+(days / 365).toFixed(1)}y`;
}

// ---- queues ------------------------------------------------------------------------------------

export interface StudyLog {
  day: number;
  newCount: number;
  reviewCount: number;
}

export interface Queue {
  learning: Required<Flashcard>[]; // due now (or within the learn-ahead limit when nothing else is left)
  main: Required<Flashcard>[]; // reviews with new cards mixed in, Anki's default order
  counts: { new: number; learning: number; review: number };
  nextLearnAt?: number;
}

/** `order` lists card ids in the order new cards should be introduced (Anki: order added). */
export function buildQueue(cards: Flashcard[], order: string[], log: StudyLog | undefined, now: number, cfg = ANKI_DEFAULTS): Queue {
  const today = dayNumber(now, cfg);
  const done = log && log.day === today ? log : { day: today, newCount: 0, reviewCount: 0 };
  const all = cards.map((c) => normalize(c, cfg));
  const pos = new Map(order.map((id, i) => [id, i]));
  const byPage = (a: Flashcard, b: Flashcard) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0);

  const learningAll = all.filter((c) => c.state === 'learning' || c.state === 'relearning').sort((a, b) => a.due - b.due);
  const learnIntraday = learningAll.filter((c) => c.due - now < DAY_SECS * SEC && dayNumber(c.due, cfg) <= today);
  const reviews = all
    .filter((c) => c.state === 'review' && dayNumber(c.due, cfg) <= today)
    .sort((a, b) => a.due - b.due || byPage(a, b))
    .slice(0, Math.max(0, cfg.reviewsPerDay - done.reviewCount));
  const fresh = all
    .filter((c) => c.state === 'new')
    .sort(byPage)
    .slice(0, Math.max(0, Math.min(cfg.newPerDay - done.newCount, cfg.reviewsPerDay - done.reviewCount - reviews.length)));

  // spread new cards evenly through the reviews ("mix with reviews")
  const main: Required<Flashcard>[] = [];
  const total = reviews.length + fresh.length;
  let r = 0, n = 0;
  for (let i = 0; i < total; i++) {
    const wantNew = n < fresh.length && (r >= reviews.length || (n + 1) / (fresh.length + 1) <= (i + 1) / (total + 1));
    main.push(wantNew ? fresh[n++] : reviews[r++]);
  }

  let learning = learnIntraday.filter((c) => c.due <= now);
  if (!learning.length && !main.length) learning = learnIntraday.filter((c) => c.due <= now + cfg.learnAheadMins * 60 * SEC);
  const later = learnIntraday.find((c) => !learning.includes(c));
  return {
    learning,
    main,
    counts: { new: fresh.length, learning: learnIntraday.length, review: reviews.length },
    nextLearnAt: later?.due,
  };
}

export function nextCard(q: Queue) {
  return q.learning[0] ?? q.main[0] ?? null;
}

export function logAnswer(log: StudyLog | undefined, before: Flashcard, now: number, cfg = ANKI_DEFAULTS): StudyLog {
  const day = dayNumber(now, cfg);
  const cur = log && log.day === day ? log : { day, newCount: 0, reviewCount: 0 };
  const state = normalize(before, cfg).state;
  return { ...cur, newCount: cur.newCount + (state === 'new' ? 1 : 0), reviewCount: cur.reviewCount + (state === 'review' ? 1 : 0) };
}
