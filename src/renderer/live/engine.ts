// LiveEngine: live recognition and checking for one open notebook.
//
//   session 'page' event ──(next task)──> groupInk ──> blocks diffed by content id
//        lines that changed lose their marks at once; changed blocks wait to settle
//        (600 ms after the last pen-up in that block)
//   settled block ──(idle slice)──> recognizeBlock ──> checkSteps + evaluate ──> local verdict,
//        ticks, amber and live results shown
//        ──(mode allows, CAS undecided)──> per line: crop of that line + its reading as text ──>
//        AI judge ‖ blind re-solve (parallel, cross-vendor) ──> merged verdict
//
// Red is shown only under the policy in ai/merge.ts, never sooner than 900 ms after the pen left
// the line, and held while the pen is still busy right there (notePenActivity). Only the first
// error of a block is marked. Results are cached by content hash, so an unchanged block is never
// re-checked or re-sent and undo brings marks back instantly. Every knob is in ai/policy.ts.
import { aiFailure, type AiSettings, type Card, type CompleteImage } from '../lib/ai';
import { whenIdle } from '../lib/idle';
import type { PageContent } from '../engine/model';
import type { BBox, BlockRecognition, Insight, InkBlock, InkLine, Issue, LineRecognition, LiveDecoration, LiveMode, MathModule, RecogModule, Stroke } from './contract';
import { blockKey, hash53 } from './ai/hash';
import { browserKV, Lru, type KV } from './ai/cache';
import type { CropImage, JudgeResult } from './ai/check';
import { cropBlockImage, type CropOpts } from './ai/crop';
import { mergeCheck, type AiLineOutcome, type AiOutcome, type LiveBlockCheck, type LocalResult } from './ai/merge';
import { LiveAi, NoAiProvider } from './ai/service';
import { DEICTIC, MISCONCEPTIONS, POLICY, type Tier } from './ai/policy';
import type { AskResult, LiveStatus, LiveUiEngine, RegionContext, UiDecoration } from './ui/engineApi';
import { math as casModule } from './math';

/** What the engine needs from a session (NotebookSession fits). */
export interface LiveSource {
  on(fn: (e: { type: string; pageId?: string }) => void): () => void;
  content(pageId: string): PageContent | undefined;
  /** the page list, to pick up pages whose content loads later */
  readonly pages?: readonly { id: string }[];
  /** the notebook id: the mistake journal and paused pages are kept per notebook */
  readonly id?: string;
}

export type LiveEvent = { type: 'decorations'; pageId: string } | { type: 'check'; pageId: string; blockId: string } | { type: 'stats' } | { type: 'journal' };

export interface LiveStats {
  mode: LiveMode;
  /** settle → final verdict of the last check, ms */
  lastMs: number | null;
  /** settle → local verdict of the last check, ms */
  lastLocalMs: number | null;
  tokensIn: number;
  tokensOut: number;
  /** estimated cost this session, USD (known model prices only) */
  usd: number;
  /** blocks waiting to settle or being checked */
  pending: number;
  state: 'idle' | 'checking' | 'offline' | 'error';
  aiReady: boolean;
  /** an AI call has been running for more than 4 s */
  slow: boolean;
  exam: boolean;
}

/**
 * A decoration plus what the UI needs to present it: the issue title for the hover tip, how sure
 * the verdict is (amber opacity), and for red marks a priority (0 = show first; the UI shows at
 * most 3 per screen and folds the rest into "+n").
 */
export type LiveMark = LiveDecoration & { title?: string; confidence?: number; priority?: number };

interface StoredMark extends LiveMark {
  /** red: not before this time (POLICY.redMinMs after the last pen-up in the line) */
  notBefore: number;
  /** the line's box, for the "pen still busy here" hold */
  line: BBox;
  shown?: boolean;
}

/** One confirmed mistake, kept per notebook for "Your patterns" and flashcards. */
export interface JournalEntry {
  id: string;
  at: number; // epoch ms
  pageId: string;
  lineId: string;
  text: string;
  latex: string;
  title: string;
  detail: string;
  fix?: string;
  misconception: string;
  source: Issue['source'];
}

export interface Pattern {
  misconception: string;
  label: string;
  rule: string;
  count: number;
  last: number;
  examples: string[];
}

export interface LiveEngineOptions {
  mode?: LiveMode;
  recog?: RecogModule;
  math?: MathModule;
  /** the AI layer; default: one built on the saved settings */
  ai?: LiveAi;
  settings?: () => AiSettings | undefined;
  crop?: (strokes: readonly Stroke[], bbox: BBox, o: CropOpts) => Promise<CropImage>;
  /** runs fn in an idle slice once the pen is up */
  idle?: (fn: () => void) => () => void;
  settleMs?: number;
  /** red marks wait at least this long after pen-up (tests shorten it) */
  redMinMs?: number;
  now?: () => number;
  /** wall clock for the journal */
  clock?: () => number;
  /** AI line checks running at once */
  aiConcurrency?: number;
  /** where the journal and paused pages persist; null = memory only */
  kv?: KV | null;
}

interface PageState {
  strokesRef: readonly Stroke[] | null;
  strokes: Map<string, Stroke>;
  blocks: InkBlock[];
}

const PAD = 6; // pt around a block that still counts as "on" it

const area = (b: BBox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inter = (a: BBox, b: BBox): BBox => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const unionB = (a: BBox, b: BBox): BBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const contains = (b: BBox, x: number, y: number, pad = 0) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Lines of a block the AI should judge in this mode (pure, exported for tests). */
export function linesToJudge(mode: LiveMode, rec: BlockRecognition, local: LocalResult): LineRecognition[] {
  if (mode !== 'smart' && mode !== 'max') return [];
  const out: LineRecognition[] = [];
  for (const l of rec.lines) {
    const lc = local.lines.find((x) => x.lineId === l.lineId);
    const v = lc?.verdict ?? 'none';
    // a confident local error is final; nothing after it is marked (first error only)
    if (v === 'error' && l.confidence >= POLICY.confidentReading && local.issues.some((i) => i.lineId === l.lineId && i.severity === 'error' && i.confidence >= POLICY.confidentCas)) break;
    if (lc?.carried) continue;
    if (mode === 'max') {
      if (l.text || l.tokens.length) out.push(l);
      continue;
    }
    if (l.kind !== 'math') continue;
    if (!POLICY.smartOnlyUndecided || v === 'unsure' || v === 'none' || v === 'pending' || (v === 'error' && l.confidence < POLICY.confidentReading)) out.push(l);
  }
  return out;
}

/** Does this block need the AI in this mode? */
export const needsAi = (mode: LiveMode, rec: BlockRecognition, local: LocalResult) => linesToJudge(mode, rec, local).length > 0;

/** Where a mark goes: the strokes of the tokens in the issue's span, or the whole line. */
export function markGeometry(line: InkLine, rec: LineRecognition | undefined, span: [number, number] | null): { bbox: BBox; underline: { x1: number; x2: number; y: number } } {
  let bbox: BBox | null = null;
  if (span && rec)
    for (const t of rec.tokens) if (t.span[0] < span[1] && t.span[1] > span[0]) bbox = bbox ? unionB(bbox, t.bbox) : t.bbox;
  bbox ??= line.bbox;
  const gap = Math.max(1.5, (line.bbox[3] - line.bbox[1]) * 0.06);
  return { bbox, underline: { x1: bbox[0], x2: bbox[2], y: bbox[3] + gap } };
}

/** Assignments like "a=3" or "r = 2.5" in recognised lines: variables for live results. */
function assignments(lines: readonly LineRecognition[], into: Map<string, string>) {
  for (const l of lines) {
    const m = /^\s*([A-Za-z])\s*=\s*([-+]?[\d.,/]+)\s*$/.exec(l.text);
    if (m) into.set(m[1], m[2]);
  }
}

export class LiveEngine {
  private mode: LiveMode;
  /** null until the recogniser module has loaded (it pulls in the backend bridge) */
  private recog: RecogModule | null;
  private waitingForRecog = new Set<string>();
  private math: MathModule;
  readonly ai: LiveAi;
  private crop: NonNullable<LiveEngineOptions['crop']>;
  private idle: NonNullable<LiveEngineOptions['idle']>;
  private settleMs: number;
  private redMinMs: number;
  private now: () => number;
  private clock: () => number;
  private aiConcurrency: number;
  private kv: KV | null;

  private pages = new Map<string, PageState>();
  private regroupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private penUpAt = new Map<string, number>();
  private settle = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: { pageId: string; blockId: string; force?: boolean }[] = [];
  private idleCancel: (() => void) | null = null;
  private inflight = new Map<string, { ctrl: AbortController; since: number }>();
  private aiActive = 0;
  private aiWaiters: (() => void)[] = [];
  /** latest check per current block id */
  private checks = new Map<string, LiveBlockCheck>();
  /** results by content key: undo and unchanged blocks come back without any work */
  private results = new Lru<{ rec: BlockRecognition; check: LiveBlockCheck }>(POLICY.cache.localEntries);
  private marks = new Map<string, StoredMark[]>(); // by line id
  private corrections = new Map<string, string>(); // line id -> text the user confirmed
  private waiters = new Map<string, ((c: LiveBlockCheck | null) => void)[]>();
  private listeners = new Set<(e: LiveEvent) => void>();
  private unsub: () => void;
  private unsubAi: () => void;
  private lastMs: number | null = null;
  private lastLocalMs: number | null = null;
  private disposed = false;
  // pen activity (no allocation on the hot path: plain fields)
  private actPage = '';
  private actX = 0;
  private actY = 0;
  private actT = -Infinity;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private exam = false;
  private revealed = false;
  private paused = new Set<string>();
  private journalList: JournalEntry[] = [];

  private source: LiveSource;

  constructor(source: LiveSource, o: LiveEngineOptions = {}) {
    this.source = source;
    this.mode = o.mode ?? 'smart';
    this.recog = o.recog ?? null;
    this.math = o.math ?? casModule;
    if (!this.recog)
      void import('./recog').then((m) => {
        this.recog = { groupInk: m.groupInk, recognizeBlock: m.recognizeBlock };
        for (const id of this.waitingForRecog) this.touch(id);
        this.waitingForRecog.clear();
      });
    this.ai = o.ai ?? new LiveAi(o.settings ? { settings: o.settings } : storeSettings());
    this.crop = o.crop ?? cropBlockImage;
    this.idle = o.idle ?? ((fn) => whenIdle(fn, 0));
    this.settleMs = o.settleMs ?? POLICY.settleMs;
    this.redMinMs = o.redMinMs ?? POLICY.redMinMs;
    this.now = o.now ?? (() => performance.now());
    this.clock = o.clock ?? Date.now;
    this.aiConcurrency = o.aiConcurrency ?? POLICY.aiConcurrency;
    this.kv = o.kv === undefined ? browserKV() : o.kv;
    this.load();
    this.unsub = source.on((e) => {
      if (e.type === 'page' && e.pageId) this.touch(e.pageId, (e as { stroke?: Stroke }).stroke);
      else if (e.type === 'pages') for (const id of this.pages.keys()) this.touch(id);
    });
    this.unsubAi = this.ai.onChange(() => this.emit({ type: 'stats' }));
  }

  // ---- public API ---------------------------------------------------------------------------------

  subscribe(cb: (e: LiveEvent) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /**
   * Marks to draw on a page. The first call for a page starts watching its existing ink. Red marks
   * appear no sooner than 900 ms after pen-up and wait while the pen is still busy at that line.
   */
  decorations(pageId: string): LiveMark[] {
    if (this.mode === 'off' || this.paused.has(pageId)) return [];
    const st = this.pages.get(pageId);
    if (!st) {
      this.touch(pageId);
      return [];
    }
    if (this.exam && !this.revealed) return [];
    const now = this.now();
    const out: LiveMark[] = [];
    const reds: StoredMark[] = [];
    let wake = Infinity;
    for (const b of st.blocks)
      for (const l of b.lines)
        for (const m of this.marks.get(l.id) ?? []) {
          if (m.kind === 'error') {
            const until = this.heldUntil(m, now);
            if (until > now) {
              wake = Math.min(wake, until);
              continue;
            }
            m.shown = true;
            reds.push(m);
            continue;
          }
          out.push(strip(m));
        }
    // newest red first: the UI shows at most 3 per screen
    reds.sort((a, b) => b.notBefore - a.notBefore);
    reds.forEach((m, i) => out.push({ ...strip(m), priority: i }));
    if (wake < Infinity) this.wakeAt(pageId, wake);
    return out;
  }

  /**
   * The UI reports pen (or finger) activity on a page, in page units, at most once per frame
   * (pointerdown and pointermove while drawing). Cheap: stores four numbers.
   */
  notePenActivity(pageId: string, x: number, y: number) {
    this.actPage = pageId;
    this.actX = x;
    this.actY = y;
    this.actT = this.now();
  }

  /** The recognised block (and its check) under a page point, or null. */
  insightAt(pageId: string, x: number, y: number): Insight | null {
    const st = this.pages.get(pageId);
    if (!st) return null;
    let best: InkBlock | null = null;
    for (const b of st.blocks) if (contains(b.bbox, x, y, PAD) && (!best || area(b.bbox) < area(best.bbox))) best = b;
    if (!best) return null;
    return this.insightFor(pageId, best, y);
  }

  /** The block that overlaps a page box most (e.g. the AI selector's loop). */
  blockFor(pageId: string, bbox: BBox): InkBlock | null {
    const st = this.pages.get(pageId);
    let best: InkBlock | null = null, bestA = 0;
    for (const b of st?.blocks ?? []) {
      const a = area(inter(b.bbox, bbox));
      if (a > bestA) {
        bestA = a;
        best = b;
      }
    }
    return best;
  }

  insightFor(pageId: string, block: InkBlock, y?: number): Insight {
    let focus: InkLine | null = null;
    if (y != null) {
      let d = Infinity;
      for (const l of block.lines) {
        const dd = y >= l.bbox[1] - 2 && y <= l.bbox[3] + 2 ? 0 : Math.abs(y - (l.bbox[1] + l.bbox[3]) / 2);
        if (dd < d) {
          d = dd;
          focus = l;
        }
      }
    } else {
      // no point given: the first error, or the last line
      const c = this.checks.get(block.id);
      const err = c?.lines.find((l) => l.verdict === 'error' || l.verdict === 'unsure');
      focus = block.lines.find((l) => l.id === err?.lineId) ?? block.lines[block.lines.length - 1] ?? null;
    }
    return { pageId, block, check: this.checks.get(block.id) ?? null, focusLineId: focus?.id ?? block.lines[0]?.id ?? null };
  }

  /**
   * What "why?", "this" or "here" refer to: the block under the pen right now, or the block written
   * last within the last 10 s. Null when neither exists.
   */
  resolveDeictic(): Insight | null {
    const now = this.now();
    if (now - this.actT <= POLICY.deicticWindowMs) {
      const i = this.insightAt(this.actPage, this.actX, this.actY);
      if (i) return i;
    }
    let best: { pageId: string; block: InkBlock; t: number } | null = null;
    for (const [pageId, st] of this.pages)
      for (const b of st.blocks)
        for (const l of b.lines)
          for (const id of l.strokeIds) {
            const t = this.penUpAt.get(id) ?? -Infinity;
            if (now - t <= POLICY.deicticWindowMs && (!best || t > best.t)) best = { pageId, block: b, t };
          }
    return best ? this.insightFor(best.pageId, best.block) : null;
  }

  /** Latest check of a current block. */
  check(blockId: string): LiveBlockCheck | null {
    return this.checks.get(blockId) ?? null;
  }

  /** The block with this id, if it is still on its page. */
  block(blockId: string): { pageId: string; block: InkBlock } | null {
    for (const [pageId, st] of this.pages) {
      const b = st.blocks.find((x) => x.id === blockId);
      if (b) return { pageId, block: b };
    }
    return null;
  }

  /**
   * Check a block again now. With a correction, the user's text replaces the reading: of `lineId`,
   * or of the only line, or line by line when the text has one line per block line.
   */
  recheck(blockId: string, correctedText?: string, lineId?: string): Promise<LiveBlockCheck | null> {
    const found = this.block(blockId);
    if (!found || this.mode === 'off') return Promise.resolve(null);
    const { pageId, block } = found;
    if (correctedText != null) {
      const rows = correctedText.split('\n');
      if (lineId) this.corrections.set(lineId, correctedText.trim());
      else if (block.lines.length === 1) this.corrections.set(block.lines[0].id, correctedText.trim());
      else if (rows.length === block.lines.length) block.lines.forEach((l, i) => this.corrections.set(l.id, rows[i].trim()));
    }
    this.cancel(blockId);
    const p = this.waitFor(blockId);
    void this.process(pageId, blockId, this.now(), true);
    return p;
  }

  /**
   * The learner looks at a block (insight card): give it the AI check its mode allows, also when
   * the ink is older than this session. Resolves with the check (at once when nothing is needed).
   */
  ensureChecked(blockId: string): Promise<LiveBlockCheck | null> {
    const found = this.block(blockId);
    if (!found || this.mode === 'off') return Promise.resolve(null);
    const c = this.checks.get(blockId);
    if (this.inflight.has(blockId) || this.settle.has(blockId) || this.queue.some((q) => q.blockId === blockId)) return this.waitFor(blockId);
    if (c && (c.via !== 'local' || this.mode === 'local' || !needsAi(this.mode, c.recognition, c))) return Promise.resolve(c);
    const p = this.waitFor(blockId);
    this.enqueue(found.pageId, blockId, true);
    return p;
  }

  /** A sharper crop of a block for questions about it (null when the block is gone). */
  async blockImage(blockId: string): Promise<CropImage | null> {
    const found = this.block(blockId);
    const st = found && this.pages.get(found.pageId);
    if (!found || !st) return null;
    const b = found.block;
    const strokes = b.lines.flatMap((l) => l.strokeIds.map((id) => st.strokes.get(id)).filter((x): x is Stroke => !!x));
    return this.crop(strokes, b.bbox, { lineHeight: median(b.lines.map((l) => l.bbox[3] - l.bbox[1])), xHeightPx: POLICY.crop.askXHeightPx, maxLong: POLICY.crop.askMaxLong });
  }

  /** Start watching pages whose content is loaded (existing ink gets its local check). */
  watchLoaded() {
    for (const p of this.source.pages ?? []) if (!this.pages.has(p.id) && this.source.content(p.id)) this.touch(p.id);
  }

  setMode(mode: LiveMode) {
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    if (mode === 'off') {
      for (const id of [...this.settle.keys(), ...this.inflight.keys()]) this.cancel(id);
      this.queue = [];
      this.marks.clear();
      this.checks.clear();
      for (const id of this.pages.keys()) this.emit({ type: 'decorations', pageId: id });
    } else {
      if (mode === 'local') for (const id of [...this.inflight.keys()]) this.cancel(id);
      // the new mode may decide differently: run every current block again (local results are cached)
      for (const [pageId, st] of this.pages) {
        if (was === 'off') st.strokesRef = null;
        for (const b of st.blocks) if (was === 'off' || (mode !== 'local' && this.needsAiNow(b.id, mode))) this.enqueue(pageId, b.id);
        if (was === 'off') this.touch(pageId);
      }
    }
    this.emit({ type: 'stats' });
  }

  getMode() {
    return this.mode;
  }

  /** Exam mode: checks keep running, but no mark shows until reveal(); then all appear together. */
  setExamMode(on: boolean) {
    this.exam = on;
    this.revealed = false;
    for (const id of this.pages.keys()) this.emit({ type: 'decorations', pageId: id });
    this.emit({ type: 'stats' });
  }

  reveal() {
    if (!this.exam) return;
    this.revealed = true;
    for (const id of this.pages.keys()) this.emit({ type: 'decorations', pageId: id });
  }

  examState() {
    return { exam: this.exam, revealed: this.revealed };
  }

  /** "Pause checking on this page": nothing is checked or shown there until resumed. */
  pausePage(pageId: string, paused: boolean) {
    if (paused === this.paused.has(pageId)) return;
    if (paused) {
      this.paused.add(pageId);
      for (const b of this.pages.get(pageId)?.blocks ?? []) this.cancel(b.id);
    } else {
      this.paused.delete(pageId);
      const st = this.pages.get(pageId);
      if (st) st.strokesRef = null;
      this.touch(pageId);
    }
    this.save();
    this.emit({ type: 'decorations', pageId });
  }

  isPaused(pageId: string) {
    return this.paused.has(pageId);
  }

  // ---- mistake journal ----------------------------------------------------------------------------

  /** Confirmed mistakes in this notebook, newest first. */
  journal(): readonly JournalEntry[] {
    return this.journalList;
  }

  /** Mistakes grouped by misconception, most frequent first. */
  patterns(): Pattern[] {
    const by = new Map<string, Pattern>();
    for (const e of this.journalList) {
      const tag = e.misconception || 'other';
      const info = MISCONCEPTIONS[tag] ?? MISCONCEPTIONS.other;
      const p = by.get(tag) ?? { misconception: tag, label: info.label, rule: info.rule, count: 0, last: 0, examples: [] };
      p.count++;
      p.last = Math.max(p.last, e.at);
      if (p.examples.length < 3 && !p.examples.includes(e.text)) p.examples.push(e.text);
      by.set(tag, p);
    }
    return [...by.values()].sort((a, b) => b.count - a.count || b.last - a.last);
  }

  /**
   * Flashcards from the journal for the existing card system (front/back drafts, reviewed in
   * CardDrafts and saved like any generated cards): one "spot the mistake" card per entry and one
   * rule card per misconception.
   */
  journalCards(opts: { misconception?: string; max?: number } = {}): Card[] {
    const list = this.journalList.filter((e) => !opts.misconception || (e.misconception || 'other') === opts.misconception);
    const cards: Card[] = [];
    for (const p of this.patterns()) if (!opts.misconception || p.misconception === opts.misconception) cards.push({ front: `${p.label}: what is the rule?`, back: p.rule });
    for (const e of list) cards.push({ front: `What is wrong with this step? $${e.latex || e.text}$`, back: [`${e.title}. ${e.detail}`.trim(), e.fix ? `Correct: $${e.fix}$` : ''].filter(Boolean).join('\n') });
    return cards.slice(0, opts.max ?? 40);
  }

  stats(): LiveStats {
    const now = this.now();
    let slow = false;
    for (const f of this.inflight.values()) if (now - f.since > POLICY.slowMs) slow = true;
    const h = this.ai.health;
    return {
      mode: this.mode,
      lastMs: this.lastMs,
      lastLocalMs: this.lastLocalMs,
      tokensIn: this.ai.meter.input,
      tokensOut: this.ai.meter.output,
      usd: this.ai.meter.usd,
      pending: this.settle.size + this.inflight.size + this.queue.length,
      // rate limited or unreachable: the AI is paused, local checks go on
      state: this.inflight.size || this.ai.inflight ? 'checking' : h === 'offline' || h === 'busy' ? 'offline' : h === 'auth' ? 'error' : 'idle',
      aiReady: this.ai.ready(),
      slow,
      exam: this.exam,
    };
  }

  dispose() {
    this.disposed = true;
    this.unsub();
    this.unsubAi();
    for (const t of this.regroupTimers.values()) clearTimeout(t);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    for (const id of [...this.settle.keys(), ...this.inflight.keys()]) this.cancel(id);
    this.idleCancel?.();
    this.listeners.clear();
  }

  // ---- red timing -----------------------------------------------------------------------------------

  /** Until when a red mark is held back (<= now: show it). */
  private heldUntil(m: StoredMark, now: number): number {
    if (m.shown) return 0; // once shown, never flicker away
    let until = m.notBefore;
    if (this.actPage === m.pageId && now - this.actT < POLICY.holdPauseMs) {
      const lh = Math.max(4, m.line[3] - m.line[1]);
      const cy = (m.line[1] + m.line[3]) / 2;
      // still writing at this line (or just above it); moving on to a new line below releases it
      const near = Math.abs(this.actY - cy) <= POLICY.holdLineHeights * lh && this.actY < m.line[3] + 0.5 * lh;
      if (near) until = Math.max(until, this.actT + POLICY.holdPauseMs);
    }
    return until;
  }

  private wakeAt(pageId: string, t: number) {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(
      () => {
        this.holdTimer = null;
        this.emit({ type: 'decorations', pageId });
      },
      Math.max(16, t - this.now() + 5),
    );
  }

  // ---- grouping -----------------------------------------------------------------------------------

  /** Something changed on a page: regroup in the next task (never inside the pen-up handler). */
  private touch(pageId: string, stroke?: Stroke) {
    if (this.disposed || this.mode === 'off') return;
    if (stroke) this.penUpAt.set(stroke.id, this.now());
    if (this.paused.has(pageId) || this.regroupTimers.has(pageId)) return;
    this.regroupTimers.set(
      pageId,
      setTimeout(() => {
        this.regroupTimers.delete(pageId);
        this.regroup(pageId);
      }, 0),
    );
  }

  private regroup(pageId: string) {
    if (this.disposed || this.mode === 'off' || this.paused.has(pageId)) return;
    if (!this.recog) return void this.waitingForRecog.add(pageId);
    const c = this.source.content(pageId);
    const strokes = c?.strokes ?? [];
    let st = this.pages.get(pageId);
    if (st && st.strokesRef === strokes) return;
    const pen = strokes.filter((s) => s.kind === 'pen' && !s.shape);
    const blocks = pen.length ? this.recog.groupInk(pageId, pen) : [];
    const oldBlocks = st?.blocks ?? [];
    const oldLineIds = new Set(oldBlocks.flatMap((b) => b.lines.map((l) => l.id)));
    const newBlockIds = new Set(blocks.map((b) => b.id));
    st = { strokesRef: strokes, strokes: new Map(pen.map((s) => [s.id, s])), blocks };
    this.pages.set(pageId, st);

    let changed = false;
    // gone blocks: stop their work
    for (const b of oldBlocks)
      if (!newBlockIds.has(b.id)) {
        this.cancel(b.id);
        this.checks.delete(b.id);
      }
    // marks of lines that no longer exist go at once (erase means gone)
    const live = new Set(blocks.flatMap((b) => b.lines.map((l) => l.id)));
    for (const b of oldBlocks)
      for (const l of b.lines)
        if (!live.has(l.id) && this.marks.delete(l.id)) changed = true;

    for (const b of blocks) {
      if (this.checks.has(b.id) || this.settle.has(b.id) || this.inflight.has(b.id) || this.queue.some((q) => q.blockId === b.id)) continue;
      // in a changed block, later lines may depend on an edited line: their marks go too
      const firstNew = b.lines.findIndex((l) => !oldLineIds.has(l.id));
      if (firstNew >= 0) for (const l of b.lines.slice(firstNew)) if (this.marks.delete(l.id)) changed = true;
      // seen before with exactly this content (undo, a move): the result comes back at once
      const hit = this.results.get(this.keyOf(b, st.strokes));
      if (hit) {
        this.publish(pageId, b, { ...hit.check, blockId: b.id, pageId, via: 'cache' }, hit.rec, false);
        changed = true;
        continue;
      }
      const last = this.lastPenUp(b.lines);
      const wait = last > -Infinity ? Math.max(0, last + this.settleMs - this.now()) : 0;
      this.settle.set(
        b.id,
        setTimeout(() => {
          this.settle.delete(b.id);
          this.enqueue(pageId, b.id);
        }, wait),
      );
    }
    if (changed) this.emit({ type: 'decorations', pageId });
    this.emit({ type: 'stats' });
  }

  private lastPenUp(lines: readonly InkLine[]) {
    let last = -Infinity;
    for (const l of lines) for (const id of l.strokeIds) last = Math.max(last, this.penUpAt.get(id) ?? -Infinity);
    return last;
  }

  private keyOf(b: InkBlock, strokes: ReadonlyMap<string, Stroke>) {
    const corr = b.lines.map((l) => this.corrections.get(l.id) ?? '').join('\u0001');
    return blockKey(b, strokes) + (corr.replace(/\u0001/g, '') ? hash53(corr) : '');
  }

  /** The content key of one line, with the text it is judged against (earlier steps) and the tier. */
  private lineKey(line: InkLine, strokes: ReadonlyMap<string, Stroke>, rec: LineRecognition, prior: readonly LineRecognition[], tier: Tier) {
    const own = blockKey({ id: line.id, pageId: line.pageId, lines: [line], bbox: line.bbox }, strokes);
    return hash53([own, rec.text, ...prior.slice(-POLICY.priorLines).map((l) => l.text), tier].join('\u0001'));
  }

  // ---- checking -----------------------------------------------------------------------------------

  private enqueue(pageId: string, blockId: string, force = false) {
    const q = this.queue.find((x) => x.blockId === blockId);
    if (q) q.force ||= force;
    else this.queue.push({ pageId, blockId, force });
    this.pump();
  }

  /** One block per idle slice, never while the pen is down. */
  private pump() {
    if (this.idleCancel || !this.queue.length || this.disposed) return;
    this.idleCancel = this.idle(() => {
      this.idleCancel = null;
      const next = this.queue.shift();
      if (next) void this.process(next.pageId, next.blockId, this.now(), next.force);
      this.pump();
    });
  }

  /** after a mode change: blocks whose local-only verdict the new mode would send to the AI */
  private needsAiNow(blockId: string, mode: LiveMode) {
    const c = this.checks.get(blockId);
    return !c || (c.via === 'local' && needsAi(mode, c.recognition, c));
  }

  private cancel(blockId: string) {
    const t = this.settle.get(blockId);
    if (t) clearTimeout(t);
    this.settle.delete(blockId);
    this.inflight.get(blockId)?.ctrl.abort();
    this.inflight.delete(blockId);
    this.queue = this.queue.filter((q) => q.blockId !== blockId);
    this.resolve(blockId, null);
  }

  private current(pageId: string, blockId: string): InkBlock | null {
    return this.pages.get(pageId)?.blocks.find((b) => b.id === blockId) ?? null;
  }

  /** Variables assigned on the page above this block ("a=3"), for live results. */
  private pageVars(pageId: string, block: InkBlock): Map<string, string> {
    const vars = new Map<string, string>();
    const blocks = [...(this.pages.get(pageId)?.blocks ?? [])].filter((b) => b.id !== block.id && b.bbox[1] < block.bbox[1]).sort((a, b) => a.bbox[1] - b.bbox[1]);
    for (const b of blocks) {
      const c = this.checks.get(b.id);
      if (c) assignments(c.recognition.lines, vars);
    }
    return vars;
  }

  private evaluate(pageId: string, block: InkBlock, rec: BlockRecognition) {
    if (typeof this.math.evaluate !== 'function') return [];
    try {
      return this.math.evaluate(rec.lines, this.pageVars(pageId, block));
    } catch (e) {
      console.warn('live: evaluate failed', e);
      return [];
    }
  }

  private async process(pageId: string, blockId: string, t0: number, force = false) {
    const block = this.current(pageId, blockId);
    const st = this.pages.get(pageId);
    if (!block || !st || this.mode === 'off' || this.paused.has(pageId)) return this.resolve(blockId, null);
    const key = this.keyOf(block, st.strokes);
    let rec: BlockRecognition;
    let local: LocalResult;
    try {
      const raw = await this.recog!.recognizeBlock(block, st.strokes);
      if (!this.current(pageId, blockId)) return this.resolve(blockId, null);
      rec = this.applyCorrections(raw);
      local = this.math.checkSteps(rec.lines);
    } catch (e) {
      console.warn('live: local check failed', e);
      return this.resolve(blockId, null);
    }
    const results = this.evaluate(pageId, block, rec);
    const localMs = this.now() - t0;
    this.lastLocalMs = Math.round(localMs);
    await this.ai.whenReady();
    const mode = this.mode;
    const tier: Tier = mode === 'max' ? 'strong' : 'fast';

    // per line: what to judge, and what the cache already knows
    const judge = linesToJudge(mode, rec, local);
    const keys = new Map<string, string>();
    const cachedLines: JudgeResult[] = [];
    for (const l of judge) {
      const line = block.lines.find((x) => x.id === l.lineId);
      if (!line) continue;
      const k = this.lineKey(line, st.strokes, l, rec.lines.slice(0, rec.lines.indexOf(l)), tier);
      keys.set(l.lineId, k);
      const c = this.ai.cached(k);
      if (c) cachedLines.push(c);
    }
    // ink written in this session is checked by itself; older ink only when the learner asks
    const fresh = force || !POLICY.aiOnlyForFreshInk || block.lines.some((l) => l.strokeIds.some((id) => this.penUpAt.has(id)));
    const toCall = judge.filter((l) => keys.has(l.lineId) && !cachedLines.some((c) => c.outcome.lineId === l.lineId));
    const wantAi = fresh && toCall.length > 0 && this.ai.available();
    const cachedOutcome = cachedLines.length ? aggregate(cachedLines, true) : null;
    const first = mergeCheck({ blockId, pageId, recognition: rec, local, ai: cachedOutcome, ms: Math.round(localMs), via: cachedOutcome ? 'cache' : 'local' });
    this.publish(pageId, block, first, rec, !wantAi, key, results);
    if (!wantAi) {
      this.lastMs = Math.round(localMs);
      return this.resolve(blockId, first);
    }

    const ctrl = new AbortController();
    this.inflight.set(blockId, { ctrl, since: this.now() });
    this.emit({ type: 'stats' });
    const done: JudgeResult[] = [...cachedLines];
    const partials = new Map<string, AiLineOutcome>();
    const show = () => {
      if (ctrl.signal.aborted || !this.current(pageId, blockId)) return;
      const outs = [...done.map((d) => d.outcome), ...[...partials.values()].filter((p) => !done.some((d) => d.outcome.lineId === p.lineId))];
      const agg: AiOutcome = { ...aggregate(done, false), lines: outs };
      this.publish(pageId, block, mergeCheck({ blockId, pageId, recognition: this.withAiReadings(rec, agg), local, ai: agg, ms: Math.round(this.now() - t0), via: 'ai' }), rec, false, undefined, results);
    };
    try {
      await Promise.all(
        toCall.map(async (l) => {
          await this.aiSlot(ctrl.signal);
          try {
            if (ctrl.signal.aborted) return;
            const line = block.lines.find((x) => x.id === l.lineId)!;
            const strokes = line.strokeIds.map((id) => st.strokes.get(id)).filter((s): s is Stroke => !!s);
            const image = await this.crop(strokes, line.bbox, { lineHeight: line.bbox[3] - line.bbox[1] });
            const idx = rec.lines.indexOf(l);
            const r = await this.ai.judge(keys.get(l.lineId)!, {
              line: l,
              prior: rec.lines.slice(0, idx).map((p) => (this.corrections.has(p.lineId) ? p : partials.get(p.lineId)?.corrected ? { ...p, text: partials.get(p.lineId)!.corrected! } : p)),
              image,
              localVerdict: local.lines.find((x) => x.lineId === l.lineId)?.verdict ?? 'none',
              tier,
              verifyTier: POLICY.verifyTier[mode === 'max' ? 'max' : 'smart'],
              signal: ctrl.signal,
              checkSteps: (lines) => this.math.checkSteps(lines),
              // show what the judge found at once (amber); it turns red when the re-solve agrees
              onJudged: (partial) => {
                if (!POLICY.showUnconfirmedAsAmber) return;
                partials.set(partial.lineId, partial);
                show();
              },
            });
            if (r) {
              done.push(r);
              show();
            }
          } finally {
            this.releaseSlot();
          }
        }),
      );
      if (ctrl.signal.aborted || !this.current(pageId, blockId)) return this.resolve(blockId, null);
      const ms = Math.round(this.now() - t0);
      const out = done.length ? aggregate(done, done.every((d) => cachedLines.includes(d))) : null;
      const merged = out ? mergeCheck({ blockId, pageId, recognition: this.withAiReadings(rec, out), local, ai: out, ms, via: out.cached ? 'cache' : 'ai' }) : { ...first, ms };
      this.publish(pageId, block, merged, rec, true, key, results);
      this.lastMs = ms;
      this.resolve(blockId, merged);
    } catch (e) {
      if (!ctrl.signal.aborted) {
        // offline, rate limited, no provider: the local verdict stands (not cached, so the
        // block gets its AI check after the next change once the provider is back)
        this.publish(pageId, block, first, rec, false, undefined, results);
        this.lastMs = Math.round(localMs);
        this.resolve(blockId, first);
      } else this.resolve(blockId, null);
      // offline and busy are expected (the status pill shows them); anything else is worth a note
      if (!ctrl.signal.aborted && !(e instanceof Error && e.name === 'NoAiProvider') && !['offline', 'busy', 'abort'].includes(aiFailure(e))) console.warn('live: AI check failed', e);
    } finally {
      if (this.inflight.get(blockId)?.ctrl === ctrl) this.inflight.delete(blockId);
      this.emit({ type: 'stats' });
    }
  }

  /** The AI's reading of a line it read differently from the local recogniser (shown in the card). */
  private withAiReadings(rec: BlockRecognition, ai: AiOutcome): BlockRecognition {
    return {
      ...rec,
      lines: rec.lines.map((l) => {
        const a = ai.lines.find((x) => x.lineId === l.lineId);
        const alt = a?.corrected;
        if (!alt || this.corrections.has(l.lineId) || alt === l.text) return l;
        // keep the local text (the token spans refer to it); offer the AI reading first
        return { ...l, alternates: [alt, ...l.alternates.filter((x) => x !== alt)] };
      }),
    };
  }

  private applyCorrections(rec: BlockRecognition): BlockRecognition {
    if (!rec.lines.some((l) => this.corrections.has(l.lineId))) return rec;
    return {
      ...rec,
      lines: rec.lines.map((l) => {
        const t = this.corrections.get(l.lineId);
        if (t == null || t === l.text) return t == null ? l : { ...l, confidence: 1 };
        // the user's text: certain, and the token spans no longer refer to it
        return { ...l, text: t, latex: this.math.toLatex(t), confidence: 1, alternates: [l.text, ...l.alternates], alternateProbs: undefined, tokens: [] };
      }),
    };
  }

  private aiSlot(signal: AbortSignal): Promise<void> {
    if (this.aiActive < this.aiConcurrency) {
      this.aiActive++;
      return Promise.resolve();
    }
    return new Promise((r) => {
      const go = () => {
        this.aiActive++;
        r();
      };
      this.aiWaiters.push(go);
      signal.addEventListener('abort', () => {
        const i = this.aiWaiters.indexOf(go);
        if (i >= 0) {
          this.aiWaiters.splice(i, 1);
          this.aiActive++; // balanced by the release in finally
          r();
        }
      });
    });
  }

  private releaseSlot() {
    this.aiActive = Math.max(0, this.aiActive - 1);
    const next = this.aiWaiters.shift();
    next?.();
  }

  private waitFor(blockId: string): Promise<LiveBlockCheck | null> {
    return new Promise((r) => {
      const list = this.waiters.get(blockId) ?? [];
      list.push(r);
      this.waiters.set(blockId, list);
    });
  }

  private resolve(blockId: string, c: LiveBlockCheck | null) {
    const list = this.waiters.get(blockId);
    if (!list) return;
    this.waiters.delete(blockId);
    for (const r of list) r(c);
  }

  // ---- results → marks ----------------------------------------------------------------------------

  private publish(pageId: string, block: InkBlock, check: LiveBlockCheck, rec: BlockRecognition, final: boolean, key?: string, results: { lineId: string; value: string; latex: string }[] = []) {
    if (!this.current(pageId, block.id) || this.mode === 'off') return;
    this.checks.set(block.id, check);
    if (final && key) this.results.set(key, { rec, check });
    let redDone = false;
    for (const line of block.lines) {
      const lc = check.lines.find((l) => l.lineId === line.id);
      const r = check.recognition.lines.find((l) => l.lineId === line.id);
      const prev = this.marks.get(line.id);
      const out: StoredMark[] = [];
      const lineNotBefore = this.lastPenUp([line]) + this.redMinMs;
      const base = { pageId, blockId: block.id, lineId: line.id, line: line.bbox, notBefore: 0 };
      if (lc?.carried) {
        // follows correctly from an earlier mistake: no mark of its own (the card says so)
      } else if (lc?.verdict === 'error' && !(POLICY.firstErrorOnly && redDone)) {
        redDone = true;
        const issues = check.issues.filter((i) => i.lineId === line.id && i.severity === 'error');
        (issues.length ? issues : [null]).forEach((i, k) => {
          const g = markGeometry(line, r, i?.span ?? null);
          const id = `${block.id}:${line.id}:e${k}`;
          // a mark already on screen keeps its "shown" state (no re-hold, no flicker)
          const was = prev?.find((m) => m.id === id && m.kind === 'error');
          out.push({ ...base, id, kind: 'error', bbox: g.bbox, underline: g.underline, title: i?.title, confidence: i?.confidence, notBefore: lineNotBefore, shown: was?.shown });
        });
        if (final) this.record(pageId, line, r, issues);
      } else if (lc?.verdict === 'error' || lc?.verdict === 'unsure') {
        if (lc.verdict === 'unsure' || !redDone) {
          const issues = check.issues.filter((i) => i.lineId === line.id && i.severity === 'unsure');
          (issues.length ? issues : [null]).forEach((i, k) => {
            const g = markGeometry(line, r, i?.span ?? null);
            out.push({ ...base, id: `${block.id}:${line.id}:u${k}`, kind: 'unsure', bbox: g.bbox, underline: g.underline, title: i?.title, confidence: i?.confidence ?? r?.confidence });
          });
        }
        // a later error after the first one: no mark (first error only)
      } else if (lc?.verdict === 'ok' && r?.kind === 'math') {
        const g = markGeometry(line, r, null);
        out.push({ ...base, id: `${block.id}:${line.id}:ok`, kind: 'ok', bbox: g.bbox, underline: g.underline });
      }
      // live result after a trailing "=": ghost ink to the right of the line
      const res = results.find((x) => x.lineId === line.id);
      if (res && !lc?.carried) {
        const lh = Math.max(4, line.bbox[3] - line.bbox[1]);
        const x = line.bbox[2] + lh * 0.25;
        const bbox: BBox = [x, line.bbox[1], x + Math.max(lh, lh * 0.55 * res.value.length), line.bbox[3]];
        out.push({ ...base, id: `${block.id}:${line.id}:r`, kind: 'result', text: res.latex || res.value, bbox, underline: { x1: bbox[0], x2: bbox[2], y: line.bbox[3] } });
      }
      if (out.length) this.marks.set(line.id, out);
      else this.marks.delete(line.id);
    }
    this.emit({ type: 'decorations', pageId });
    this.emit({ type: 'check', pageId, blockId: block.id });
  }

  // ---- persistence (journal, paused pages) ---------------------------------------------------------

  private storageKey() {
    return this.source.id ? POLICY.journal.storagePrefix + this.source.id : null;
  }

  private load() {
    const k = this.storageKey();
    if (!k || !this.kv) return;
    try {
      const raw = this.kv.get(k);
      if (!raw) return;
      const j = JSON.parse(raw) as { journal?: JournalEntry[]; paused?: string[] };
      this.journalList = Array.isArray(j.journal) ? j.journal : [];
      this.paused = new Set(Array.isArray(j.paused) ? j.paused : []);
    } catch {
      /* a damaged journal starts empty */
    }
  }

  private save() {
    const k = this.storageKey();
    if (!k || !this.kv) return;
    try {
      this.kv.set(k, JSON.stringify({ journal: this.journalList.slice(0, POLICY.journal.maxEntries), paused: [...this.paused] }));
    } catch {
      /* storage full: memory only */
    }
  }

  /** A confirmed mistake goes into the journal once (per line and title). */
  private record(pageId: string, line: InkLine, r: LineRecognition | undefined, issues: Issue[]) {
    const i = issues[0];
    if (!i || !r) return;
    const id = hash53(`${line.id}|${i.title}`);
    if (this.journalList.some((e) => e.id === id)) return;
    this.journalList.unshift({ id, at: this.clock(), pageId, lineId: line.id, text: r.text, latex: r.latex, title: i.title, detail: i.detail, fix: i.fix, misconception: i.misconception || 'other', source: i.source });
    if (this.journalList.length > POLICY.journal.maxEntries) this.journalList.length = POLICY.journal.maxEntries;
    this.save();
    this.emit({ type: 'journal' });
  }

  private emit(e: LiveEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

/** A stored mark as the UI sees it. */
function strip(m: StoredMark): LiveMark {
  const { notBefore: _n, line: _l, shown: _s, ...rest } = m;
  void _n;
  void _l;
  void _s;
  return rest;
}

/** Line judgements of one block as one AiOutcome. */
function aggregate(list: JudgeResult[], cached: boolean): AiOutcome {
  const tokens = { input: 0, output: 0 };
  for (const r of list) {
    tokens.input += r.tokens.input;
    tokens.output += r.tokens.output;
  }
  return { lines: list.map((r) => r.outcome), concept: list.find((r) => r.concept)?.concept ?? '', finalAnswer: '', tokens, model: list[0]?.model ?? '', cached };
}

/** The saved AI settings from the app store, loaded lazily (keeps this module light for tests). */
function storeSettings(): { settings: () => AiSettings | undefined; settingsReady: Promise<unknown> } {
  let get: (() => AiSettings | undefined) | null = null;
  const settingsReady = import('../lib/store').then((m) => (get = () => m.useApp.getState().settings.ai)).catch(() => undefined);
  return { settings: () => get?.(), settingsReady };
}

// ---- the UI's engine interface (src/renderer/live/ui/engineApi.ts) --------------------------------

const LEVELS = { 1: 'hint', 2: 'next', 3: 'fix' } as const;

/** What the tutor is told about a block: the readings, numbered, and what the check found. */
function contextOf(check: LiveBlockCheck | null, focusLineId: string | null): string {
  if (!check) return '';
  const lines = check.recognition.lines.map((l, i) => {
    const lc = check.lines.find((x) => x.lineId === l.lineId);
    const mark = lc?.carried ? '   (follows correctly from the earlier mistake)' : l.lineId === focusLineId ? '   <- the learner is asking about this line' : '';
    return `${i + 1}. ${l.text || '(unreadable)'}${mark}`;
  });
  return [...lines, check.concept ? `Topic: ${check.concept}` : ''].filter(Boolean).join('\n');
}

/** The issue the learner is looking at, and the verified fix to ground the tutor on. */
function issueOf(check: LiveBlockCheck | null, lineId: string | null) {
  const i = check?.issues.find((x) => x.lineId === lineId) ?? check?.issues.find((x) => x.severity === 'error') ?? check?.issues[0];
  if (!i) return { issue: undefined, grounding: undefined };
  const text = check?.recognition.lines.find((l) => l.lineId === i.lineId)?.text ?? '';
  // only a fix the CAS proved or two models agreed on may ground the tutor
  const verified = i.severity === 'error' && (i.source === 'local-cas' || i.source === 'ai-verified') ? i.fix : undefined;
  return { issue: { title: i.title, detail: i.detail, lineText: text, fix: verified }, grounding: verified };
}

/** The engine as the UI uses it: LiveUiEngine plus the extras of this engine. */
export type RealUiEngine = LiveUiEngine & {
  engine: LiveEngine;
  reveal(): void;
  isPaused(pageId: string): boolean;
  journalEntries(): readonly JournalEntry[];
  patterns(): Pattern[];
  journalCards(opts?: { misconception?: string; max?: number }): Card[];
  /** the block "why?" / "this" refers to right now (focus ring while listening) */
  deicticTarget(): Insight | null;
};

/**
 * The engine as the Live Ink UI uses it (picked up by ui/adapter.ts). One per open notebook.
 */
export function createUiEngine(s: LiveSource & { pages: readonly { id: string }[] }, o: LiveEngineOptions = {}): RealUiEngine {
  const e = new LiveEngine(s, o);
  const statusFns = new Set<(st: LiveStatus) => void>();
  const decoFns = new Set<(pageId: string, d: UiDecoration[]) => void>();
  const status = (): LiveStatus => {
    const st = e.stats();
    return { mode: st.mode, state: st.state, lastMs: st.lastMs, tokens: st.tokensIn + st.tokensOut, aiReady: st.aiReady, slow: st.slow };
  };
  e.subscribe((ev) => {
    if (ev.type === 'decorations') for (const f of decoFns) f(ev.pageId, e.decorations(ev.pageId));
    else if (ev.type === 'stats') for (const f of statusFns) f(status());
  });
  // pages load lazily as the user scrolls: watch each once its ink is there
  e.watchLoaded();
  const offPages = s.on((ev) => (ev.type === 'pages' || ev.type === 'doc') && e.watchLoaded());
  const poll = setInterval(() => e.watchLoaded(), 1500);
  // the "slow" flag changes with time, not with events
  const slowPoll = setInterval(() => {
    if (e.stats().slow) for (const f of statusFns) f(status());
  }, 1000);

  const imageOf = async (blockId: string): Promise<CompleteImage[]> => {
    const img = await e.blockImage(blockId);
    return img ? [{ mime: img.mime, data: img.data, w: img.w, h: img.h }] : [];
  };

  return {
    kind: 'real',
    engine: e,
    status,
    onStatus: (fn) => (statusFns.add(fn), () => void statusFns.delete(fn)),
    setMode: (m) => e.setMode(m),
    onDecorations: (fn) => {
      decoFns.add(fn);
      for (const p of s.pages) {
        const d = e.decorations(p.id);
        if (d.length) fn(p.id, d);
      }
      return () => void decoFns.delete(fn);
    },
    insightAt: (pageId, x, y) => {
      const i = e.insightAt(pageId, x, y);
      if (i) void e.ensureChecked(i.block.id);
      return i;
    },
    onInsight: (blockId, fn) =>
      e.subscribe((ev) => {
        if (ev.type !== 'check' || ev.blockId !== blockId) return;
        const f = e.block(blockId);
        if (f) fn(e.insightFor(f.pageId, f.block));
      }),
    recheck: (blockId, lineId, text) => e.recheck(blockId, text, lineId),
    async hint(insight, level, opts) {
      const check = e.check(insight.block.id) ?? (insight.check as LiveBlockCheck | null);
      const { issue, grounding } = issueOf(check, insight.focusLineId);
      const r = await e.ai.ask({ images: await imageOf(insight.block.id), context: contextOf(check, insight.focusLineId), level: LEVELS[level], issue, grounding, signal: opts.signal }, opts.onDelta);
      return r.text;
    },
    async ask(ctx, question, history, opts): Promise<AskResult> {
      let images: CompleteImage[] = [];
      let context = '';
      let issue: ReturnType<typeof issueOf>['issue'];
      let grounding: string | undefined;
      // "why?", "this", "here" with nothing selected: the block under the pen or written last
      const insight = ctx.insight ?? (!ctx.region && DEICTIC.test(question) ? e.resolveDeictic() : null) ?? undefined;
      if (ctx.region?.image) images = [{ mime: ctx.region.image.mime, data: ctx.region.image.data, w: ctx.region.image.w, h: ctx.region.image.h }];
      if (insight) {
        const check = e.check(insight.block.id) ?? (insight.check as LiveBlockCheck | null);
        if (!images.length) images = await imageOf(insight.block.id);
        context = contextOf(check, insight.focusLineId);
        if (ctx.action !== 'check') ({ issue, grounding } = issueOf(check, insight.focusLineId));
      } else if (ctx.region) {
        // ink inside the loop that the engine has read: its reading helps the model
        const b = e.blockFor(ctx.region.pageId, ctx.region.bbox as BBox);
        if (b) context = contextOf(e.check(b.id), null);
      }
      if (!images.length && !context) throw new Error('There is nothing here to ask about yet. Write something, or draw a loop around it.');
      const before = e.ai.meter.input + e.ai.meter.output;
      const r = await e.ai.ask({ images, context, question, history: history.length ? history : undefined, action: ctx.action, issue, grounding, signal: opts.signal }, opts.onDelta);
      return { text: r.text, followUps: r.followUps, tokens: e.ai.meter.input + e.ai.meter.output - before };
    },
    async transcribe(audio) {
      return e.ai.transcribe(audio);
    },
    async explainBack(insight, opts) {
      const check = e.check(insight.block.id) ?? (insight.check as LiveBlockCheck | null);
      const { issue, grounding } = issueOf(check, insight.focusLineId);
      const r = await e.ai.ask({ images: [], context: contextOf(check, insight.focusLineId), level: 'explainBack', issue, grounding, signal: opts.signal }, opts.onDelta);
      return r.text;
    },
    notePenActivity: (pageId, x, y) => e.notePenActivity(pageId, x, y),
    setExam: (on) => e.setExamMode(on),
    reveal: () => e.reveal(),
    pausePage: (pageId, paused) => e.pausePage(pageId, paused),
    isPaused: (pageId) => e.isPaused(pageId),
    journal: () => e.journal().map((j) => ({ id: j.id, at: j.at, title: j.title, tag: j.misconception, line: j.text, fix: j.fix, detail: j.detail, pageId: j.pageId })),
    journalEntries: () => e.journal(),
    patterns: () => e.patterns(),
    journalCards: (opts) => e.journalCards(opts),
    deicticTarget: () => e.resolveDeictic(),
    dispose() {
      clearInterval(poll);
      clearInterval(slowPoll);
      offPages();
      e.dispose();
    },
  };
}

export { NoAiProvider };
export type { RegionContext };
