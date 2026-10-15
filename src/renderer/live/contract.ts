// Live Ink Intelligence: the shared contract between the recognition, math-check, AI and UI modules.
// Every module codes against these types only. Coordinates are page units (PDF points), like strokes.
// Change this file only with a note in docs/live-ink/SPEC.md, since four modules depend on it.
import type { BBox } from '../engine/geometry';
import type { Stroke } from '../engine/model';

export type { BBox, Stroke };

// ---- grouping (recog module) --------------------------------------------------------------------

/** One handwritten baseline: strokes that read left to right as a single line. */
export interface InkLine {
  id: string; // stable while its strokes are unchanged: hash of sorted stroke ids
  pageId: string;
  strokeIds: string[];
  bbox: BBox;
}

/** Lines that belong together (a worked problem, a paragraph). Checked as one unit. */
export interface InkBlock {
  id: string; // hash of its line ids
  pageId: string;
  lines: InkLine[];
  bbox: BBox;
}

// ---- recognition (recog module) -----------------------------------------------------------------

/** A recognised symbol or word, mapped back onto the strokes that drew it. */
export interface InkToken {
  text: string; // plain form, e.g. "x", "^2", "=", "√", "frac"
  strokeIds: string[];
  bbox: BBox;
  /** char range in LineRecognition.text this token produced: [start, end) */
  span: [number, number];
}

export type RecogSource = 'local-ink' | 'local-ocr' | 'ai';

export interface LineRecognition {
  lineId: string;
  kind: 'math' | 'text';
  /** linear plain text, e.g. "2x+3=7", "x^2-4=(x-2)(x+2)", "The derivative is 2x" */
  text: string;
  latex: string;
  confidence: number; // 0..1, calibrated: 0.95 means right 95% of the time
  alternates: string[]; // other readings, most likely first
  /** probability of each alternate (same order); the CAS checks every reading with p >= 0.1 */
  alternateProbs?: number[];
  /** LaTeX of each alternate (same order); LaTeX is the source of truth for math lines */
  alternateLatex?: string[];
  tokens: InkToken[];
  source: RecogSource;
}

export interface BlockRecognition {
  blockId: string;
  lines: LineRecognition[];
  ms: number;
}

// ---- verification (math module + AI module) ------------------------------------------------------

export type Verdict = 'ok' | 'error' | 'unsure' | 'pending' | 'none';

export interface Issue {
  lineId: string;
  /** char range of the wrong part in the line's text; null = the whole line */
  span: [number, number] | null;
  severity: 'error' | 'unsure';
  title: string; // short, e.g. "Sign error"
  detail: string; // one or two sentences, may contain $…$ LaTeX
  hint?: string; // a nudge that does not give the answer away
  fix?: string; // corrected line as LaTeX, shown only on request
  source: 'local-cas' | 'ai' | 'ai-verified';
  confidence: number;
  /** misconception tag for the mistake journal, e.g. 'sign-move', 'distribute-first-term', 'square-of-sum' */
  misconception?: string;
}

export interface LineCheck {
  lineId: string;
  verdict: Verdict;
  /** the line follows correctly from an earlier wrong line (carry-forward: no mark, "method ok" in the card) */
  carried?: boolean;
}

export interface BlockCheck {
  blockId: string;
  pageId: string;
  recognition: BlockRecognition;
  lines: LineCheck[];
  issues: Issue[];
  /** what produced the verdict and what it cost */
  via: 'local' | 'ai' | 'cache';
  ms: number;
  tokens?: { input: number; output: number };
}

// ---- modes --------------------------------------------------------------------------------------

/**
 * off: nothing runs.
 * local: on-device only (ink recogniser + CAS). Free, offline, nothing leaves the PC.
 * smart: local first; AI only for settled, changed blocks the CAS cannot decide, as small cropped
 *        images, cached; an error is confirmed by a second independent call before it is shown.
 * max: AI checks every settled block with the strongest model, plus independent verification.
 */
export type LiveMode = 'off' | 'local' | 'smart' | 'max';

// ---- decorations (engine -> viewport) -------------------------------------------------------------

export interface LiveDecoration {
  id: string;
  pageId: string;
  /** result = live answer preview after a trailing "=" (Math Notes style), drawn as ghost ink */
  kind: 'error' | 'unsure' | 'ok' | 'result';
  /** for kind 'result': the value to draw, LaTeX */
  text?: string;
  /** box of the strokes the mark refers to */
  bbox: BBox;
  /** where the squiggle runs: from (x1,y) to (x2,y), just under the strokes */
  underline: { x1: number; x2: number; y: number };
  blockId: string;
  lineId: string;
}

// ---- insight (engine -> insight card) -------------------------------------------------------------

export interface Insight {
  pageId: string;
  block: InkBlock;
  check: BlockCheck | null; // null while the first check runs
  focusLineId: string | null;
}

// ---- module entry points (each module exports exactly these from its index.ts) ---------------------

export interface RecogModule {
  /** sync and fast (< 2 ms for 500 strokes): split a page's ink into blocks and lines */
  groupInk(pageId: string, strokes: readonly Stroke[]): InkBlock[];
  /** recognise a block on-device; resolves in well under 100 ms for a typical line */
  recognizeBlock(block: InkBlock, strokes: ReadonlyMap<string, Stroke>): Promise<BlockRecognition>;
}

export interface MathModule {
  /** check consecutive lines of a block; lines that are prose come back 'none' */
  checkSteps(lines: LineRecognition[]): { lines: LineCheck[]; issues: Issue[] };
  toLatex(text: string): string;
  /** live results: value of every line ending in "=", with variables assigned earlier on the page ("a=3") */
  evaluate(lines: LineRecognition[], vars?: ReadonlyMap<string, string>): { lineId: string; value: string; latex: string }[];
  /** same problem, new numbers: an isomorphic problem whose answer the CAS has verified, or null */
  variant(problem: string, seed: number): { problem: string; answer: string } | null;
}
