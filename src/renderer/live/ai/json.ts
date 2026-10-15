// The AI's judge and verify replies come back as JSON. Models wrap it in fences, write LaTeX with
// single backslashes, stop mid-object at the token limit or rename fields; this module turns any of
// that into a validated AiJudge / AiVerify (or null), and maps a "wrong part" quote back onto the
// recognised line text.
import { repairLatexEscapes } from '../../lib/ai';

export type AiLineVerdict = 'ok' | 'error' | 'unsure';

/** The judge's answer for one line. */
export interface AiJudge {
  /** the image shows the local reading */
  readingOk: boolean;
  /** the right reading when readingOk is false ('' otherwise) */
  corrected: string;
  latex: string;
  verdict: AiLineVerdict;
  /** exact substring of the step's reading that is wrong ('' = none or the whole line) */
  wrongSpan: string;
  title: string;
  detail: string;
  hint: string;
  fix: string;
  misconception: string;
  concept: string;
  /** a step of a proof or argument (red then needs a named logical gap from both models) */
  proof: boolean;
  /** for a proof step: the specific logical gap */
  gap: string;
}

const JUDGE_FIELDS = ['reading_ok', 'corrected', 'latex', 'step_kind', 'verdict', 'wrong_span', 'title', 'detail', 'hint', 'fix', 'gap', 'misconception', 'concept'] as const;

/** JSON schema for structured output (strict: every field required, no extras). */
export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [...JUDGE_FIELDS],
  properties: {
    reading_ok: { type: 'boolean' },
    corrected: { type: 'string' },
    latex: { type: 'string' },
    verdict: { type: 'string', enum: ['ok', 'error', 'unsure'] },
    wrong_span: { type: 'string' },
    title: { type: 'string' },
    detail: { type: 'string' },
    hint: { type: 'string' },
    fix: { type: 'string' },
    step_kind: { type: 'string', enum: ['calculation', 'proof'] },
    gap: { type: 'string' },
    misconception: { type: 'string' },
    concept: { type: 'string' },
  },
};

export interface AiVerify {
  /** the image shows the two lines as transcribed */
  readingOk: boolean;
  /** the step from the previous line(s) to this line is valid; null = cannot tell */
  valid: boolean | null;
  /** for a proof step judged invalid: the specific logical gap */
  gap: string;
  reason: string;
}

export const VERIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['readingOk', 'work', 'valid', 'gap', 'reason'],
  properties: {
    readingOk: { type: 'boolean' },
    work: { type: 'string' },
    valid: { type: 'string', enum: ['yes', 'no', 'unsure'] },
    gap: { type: 'string' },
    reason: { type: 'string' },
  },
};

// ---- repair -------------------------------------------------------------------------------------

/** Close whatever a cut-off JSON text left open (strings, arrays, objects). */
function closeOpen(s: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (esc) out = out.slice(0, -1);
  if (inStr) out += '"';
  out = out.replace(/[\s,]+$/, '');
  if (/:\s*$/.test(out)) out += 'null';
  // a dangling key inside an object: {"a":1,"b"
  else if (stack[stack.length - 1] === '}' && /[{,]\s*"(?:[^"\\]|\\.)*"$/.test(out)) out += ':null';
  return out + stack.reverse().join('');
}

/** Parse the first JSON object or array in a model reply, repairing common damage. */
export function parseLooseJson(text: string): unknown {
  let t = text.replace(/^﻿/, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)(?:```|$)/i.exec(t);
  if (fence && fence[1].trim()) t = fence[1].trim();
  const a = t.search(/[{[]/);
  if (a < 0) return null;
  t = repairLatexEscapes(t.slice(a));
  const attempts = [t];
  const lastClose = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (lastClose > 0 && lastClose < t.length - 1) attempts.push(t.slice(0, lastClose + 1));
  const noTrailing = (x: string) => x.replace(/,(\s*[}\]])/g, '$1');
  for (const x of attempts) {
    for (const y of [x, noTrailing(x), closeOpen(noTrailing(x))]) {
      try {
        return JSON.parse(y);
      } catch {
        /* next */
      }
    }
  }
  // truncated mid-value: cut back to the last complete element and close
  let cut = t;
  for (let i = 0; i < 40; i++) {
    const k = cut.lastIndexOf(',');
    if (k <= 0) break;
    cut = cut.slice(0, k);
    try {
      return JSON.parse(closeOpen(noTrailing(cut)));
    } catch {
      /* cut more */
    }
  }
  return null;
}

// ---- validation ---------------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export function normVerdict(v: unknown): AiLineVerdict {
  const s = str(v).toLowerCase();
  if (/^(ok|correct|right|valid|true|yes|fine|pass)/.test(s)) return 'ok';
  if (/^(error|wrong|incorrect|invalid|false|no|mistake|fail)/.test(s)) return 'error';
  return 'unsure';
}

const pick = (o: Record<string, unknown>, ...names: string[]) => {
  for (const n of names) if (o[n] != null) return o[n];
  return undefined;
};

const truthy = (v: unknown) => v === true || /^(yes|true|ok|1)$/i.test(str(v));

/** Validate (and repair) a judge reply. Null when nothing usable is in it. */
export function parseAiJudge(text: string, localReading: string): AiJudge | null {
  let raw = parseLooseJson(text);
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const v = pick(o, 'verdict', 'status', 'result', 'correct');
  if (v === undefined) return null;
  const verdict = normVerdict(v);
  const ro = pick(o, 'reading_ok', 'readingOk', 'readingCorrect');
  let corrected = str(pick(o, 'corrected', 'corrected_reading', 'corrected_latex', 'reading'));
  const sameAsLocal = (x: string) => x.replace(/\s+/g, '') === localReading.replace(/\s+/g, '');
  const readingOk = ro === undefined ? !corrected || sameAsLocal(corrected) : truthy(ro) || !corrected || sameAsLocal(corrected);
  if (readingOk) corrected = '';
  const reading = corrected || localReading;
  let wrongSpan = str(pick(o, 'wrong_span', 'wrongSpan', 'span', 'wrongPart'));
  // the quote must be a part of the reading, otherwise it cannot be placed
  if (wrongSpan && !reading.includes(wrongSpan)) {
    const loose = wrongSpan.replace(/\s+/g, '');
    wrongSpan = loose && reading.replace(/\s+/g, '').includes(loose) ? wrongSpan : '';
  }
  const j: AiJudge = {
    readingOk,
    corrected,
    latex: str(pick(o, 'latex', 'tex')),
    verdict,
    wrongSpan: verdict === 'ok' ? '' : wrongSpan,
    title: verdict === 'ok' ? '' : str(pick(o, 'title', 'error', 'label')).slice(0, 80),
    detail: verdict === 'ok' ? '' : str(pick(o, 'detail', 'explanation', 'why', 'reason')).slice(0, 600),
    hint: verdict === 'error' ? str(pick(o, 'hint', 'nudge')).slice(0, 400) : '',
    fix: verdict === 'error' ? str(pick(o, 'fix', 'correction')).slice(0, 400) : '',
    misconception: verdict === 'error' ? str(pick(o, 'misconception', 'tag')).toLowerCase().replace(/[^a-z-]/g, '').slice(0, 40) : '',
    concept: str(pick(o, 'concept', 'topic')).slice(0, 80),
    proof: /proof|argument/i.test(str(pick(o, 'step_kind', 'stepKind', 'kind'))),
    gap: verdict === 'ok' ? '' : str(pick(o, 'gap', 'logical_gap')).slice(0, 300),
  };
  // a proof step is wrong only with a named gap; otherwise it is a question, not a verdict
  if (j.proof && j.verdict === 'error' && !j.gap) j.verdict = 'unsure';
  // an "error" with no explanation at all is not actionable: treat as unsure
  if (j.verdict === 'error' && !j.title && !j.detail && !j.wrongSpan && !j.fix) j.verdict = 'unsure';
  return j;
}

export function parseAiVerify(text: string): AiVerify | null {
  const raw = parseLooseJson(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const v = pick(o, 'valid', 'correct', 'verdict');
  if (v === undefined) return null;
  const s = str(v).toLowerCase();
  const valid = v === true || /^(yes|true|valid|ok|correct)/.test(s) ? true : v === false || /^(no|false|invalid|wrong|error|incorrect)/.test(s) ? false : null;
  const ro = pick(o, 'readingOk', 'reading_ok');
  return { readingOk: ro === undefined ? true : ro === true || /^(yes|true)/i.test(str(ro)), valid, gap: valid === false ? str(pick(o, 'gap', 'logical_gap')).slice(0, 300) : '', reason: str(pick(o, 'reason', 'why')).slice(0, 400) };
}

// ---- span mapping -------------------------------------------------------------------------------

const EQUIV: Record<string, string> = { '−': '-', '–': '-', '—': '-', '×': '*', '·': '*', '⋅': '*', '∙': '*', '÷': '/', '：': ':', '＝': '=', '²': '^2', '³': '^3' };

/** Whitespace-free, symbol-normalised form of s, with each output char's index in s. */
function compact(s: string, dropStar = false): { t: string; at: number[] } {
  let t = '';
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) continue;
    const m = EQUIV[ch] ?? ch;
    for (const c of m) {
      if (dropStar && c === '*') continue;
      t += c.toLowerCase();
      at.push(i);
    }
  }
  return { t, at };
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Where the AI's quoted wrong part sits in the locally recognised line text, as [start, end).
 * Null when it cannot be placed reliably (then the whole line is meant).
 */
export function mapSpan(lineText: string, reading: string, wrongSpan: string): [number, number] | null {
  if (!wrongSpan.trim() || !lineText) return null;
  for (const dropStar of [false, true]) {
    const L = compact(lineText, dropStar), W = compact(wrongSpan, dropStar), R = compact(reading, dropStar);
    if (!W.t) continue;
    const hits = occurrences(L.t, W.t);
    if (!hits.length) continue;
    let best = hits[0];
    if (hits.length > 1) {
      // several matches: take the one at the same relative place as in the AI's reading
      const inR = occurrences(R.t, W.t);
      const rel = inR.length && R.t.length ? inR[0] / R.t.length : 0;
      best = hits.reduce((b, h) => (Math.abs(h / L.t.length - rel) < Math.abs(b / L.t.length - rel) ? h : b), hits[0]);
    }
    const start = L.at[best];
    const end = L.at[best + W.t.length - 1] + 1;
    return [start, end];
  }
  return null;
}

/** How alike two readings are (0..1), ignoring spaces and symbol variants. */
export function similarity(a: string, b: string): number {
  const x = compact(a, true).t, y = compact(b, true).t;
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  // Levenshtein on short strings (lines are short)
  const prev = new Array(y.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/**
 * Pair the AI's lines with the recognised lines: by position when the counts match, otherwise by
 * reading similarity in order. Returns, for each recognised line, the index of its AI line or -1.
 */
export function alignLines(local: string[], ai: string[]): number[] {
  if (local.length === ai.length) return local.map((_, i) => i);
  const out = local.map(() => -1);
  let from = 0;
  for (let i = 0; i < local.length; i++) {
    let best = -1, bestS = 0.5;
    for (let j = from; j < ai.length; j++) {
      const s = similarity(local[i], ai[j]);
      if (s > bestS) {
        bestS = s;
        best = j;
      }
    }
    if (best >= 0) {
      out[i] = best;
      from = best + 1;
    }
  }
  return out;
}
