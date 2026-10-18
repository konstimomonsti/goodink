// What the Live Ink UI needs from an engine. The real LiveEngine (src/renderer/live/engine.ts) is
// adapted to this in ./adapter.ts; ./fakeEngine.ts implements it for screenshots and UI tests.
// Coordinates are page units, like strokes.
import type { BlockCheck, Insight, LiveDecoration, LiveMode } from '../contract';

export type { BlockCheck, Insight, LiveDecoration, LiveMode };

/** A decoration as the viewport draws it: the contract's, plus the issue title for the hover tip. */
export type UiDecoration = Omit<LiveDecoration, 'kind'> & {
  /** the contract's kinds, plus room for new ones (see MARK_PAINTERS in decorations.ts) */
  kind: LiveDecoration['kind'] | 'more' | 'fixed' | 'ring' | (string & {});
  title?: string;
  /** how sure the check is (amber opacity scales with it) */
  confidence?: number;
  /** hover text when it says more than the title, e.g. "70% sure: I read 5 as S?" */
  tip?: string;
  /** shown for a while, then fades (green ticks when "show ticks" is off) */
  transient?: boolean;
  /** red marks: 0 = show first (at most 3 show per page) */
  priority?: number;
};

/** One confirmed mistake for the "Your patterns" journal. */
export interface JournalEntry {
  id: string;
  at: number;
  title: string;
  /** misconception tag, e.g. 'sign-move' */
  tag?: string;
  /** the wrong line as written (plain) and its fix (LaTeX), when known */
  line?: string;
  fix?: string;
  detail?: string;
  pageId?: string;
}

export interface LiveStatus {
  mode: LiveMode;
  /** idle: nothing running · checking: a check is in flight · offline: AI unreachable (local still works) */
  state: 'idle' | 'checking' | 'offline' | 'busy' | 'error';
  /** last check's end-to-end latency */
  lastMs: number | null;
  /** tokens used this session (input + output) */
  tokens: number;
  /** an AI provider is configured (keys saved) */
  aiReady: boolean;
  /** a slow AI call is in flight (more than ~4 s) */
  slow?: boolean;
}

export interface StreamOpts {
  onDelta: (textSoFar: string) => void;
  signal?: AbortSignal;
}

export interface AskResult {
  text: string;
  /** short follow-up questions to offer as chips */
  followUps: string[];
  tokens?: number;
}

export type Turn = { role: 'user' | 'assistant'; text: string };

/** A region drawn with the AI selector, captured as an image. */
export interface RegionContext {
  pageId: string;
  /** polygon in page units, flat [x0, y0, x1, y1, …] */
  pts: number[];
  bbox: [number, number, number, number];
  /** PNG of the region (page, PDF, images, ink), clipped to the loop */
  image: { mime: 'image/png'; data: string; w: number; h: number } | null;
}

export type QuickAction = 'explain' | 'check' | 'solve' | 'summarise' | 'translate' | 'flashcards';

export interface LiveUiEngine {
  readonly kind: 'real' | 'fake';
  status(): LiveStatus;
  onStatus(fn: (s: LiveStatus) => void): () => void;
  setMode(mode: LiveMode): void;
  /** decorations per page; called again whenever a page's marks change (empty array clears) */
  onDecorations(fn: (pageId: string, decos: UiDecoration[]) => void): () => void;
  /** Is there recognised (or recognisable) ink at this point? Returns its insight, or null. */
  insightAt(pageId: string, x: number, y: number): Insight | null;
  /** Fresh state of an insight's block (the check may have finished since). */
  onInsight(blockId: string, fn: (i: Insight) => void): () => void;
  /** The user corrected the reading of a line: re-check with this text. */
  recheck(blockId: string, lineId: string, text: string): Promise<BlockCheck | null>;
  /** Hint ladder: 1 hint, 2 next step, 3 show fix. Streams. */
  hint(insight: Insight, level: 1 | 2 | 3, opts: StreamOpts): Promise<string>;
  /** Free question about an insight's block or a drawn region. Streams. */
  ask(ctx: { insight?: Insight; region?: RegionContext; action?: QuickAction }, question: string, history: Turn[], opts: StreamOpts): Promise<AskResult>;
  /** Speech to text for a recorded clip (used when live dictation is not available). */
  transcribe?(audio: Blob): Promise<string>;
  dispose?(): void;
  // ---- optional hooks (the UI works without them) ----
  /** the pen went down / up at a page point: lets the engine hold red near active writing */
  notePenActivity?(pageId: string, x: number, y: number, down?: boolean): void;
  /** stop checking one page (marks go away) or resume it */
  pausePage?(pageId: string, paused: boolean): void;
  /** exam mode: keep checking but report marks only after reveal (the UI also hides them) */
  setExam?(on: boolean): void;
  /** confirmed mistakes so far (the UI also collects what it sees) */
  journal?(): JournalEntry[];
  /** one comprehension question after the fix was shown. Streams. */
  explainBack?(insight: Insight, opts: StreamOpts): Promise<string>;
  /** exam mode: show every held mark now, together */
  reveal?(): void;
  isPaused?(pageId: string): boolean;
  /** "Your patterns": mistakes grouped by misconception, with the rule to remember */
  patterns?(): { misconception: string; label: string; rule: string; count: number; last: number; examples: string[] }[];
  /** flashcard drafts from the journal */
  journalCards?(opts?: { misconception?: string; max?: number }): { front: string; back: string }[];
  /** the block "why?" / "this" refers to right now */
  deicticTarget?(): Insight | null;
}
