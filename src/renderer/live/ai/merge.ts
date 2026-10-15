// Merge policy: how the local CAS verdict and the AI verdict become one BlockCheck.
// Precision over recall. A line is red ('error') only when
//   (a) the local CAS proved it wrong on a confident reading, or
//   (b) the AI found it AND an independent check agreed (second blind call, or the CAS on the
//       AI's reading).
// Everything else is 'unsure' (amber) or nothing. enforceRedPolicy() re-checks this invariant on
// every result before it leaves the engine, so no code path can show an unconfirmed red mark.
import type { BlockCheck, BlockRecognition, Issue, LineCheck, Verdict } from '../contract';
import { POLICY } from './policy';

/** A reading at least this confident counts as what the learner wrote. */
export const CONFIDENT_READING = POLICY.confidentReading;
/** A local CAS issue needs at least this confidence to be final. */
export const CONFIDENT_CAS = POLICY.confidentCas;

export interface AiLineOutcome {
  lineId: string;
  verdict: 'ok' | 'error' | 'unsure';
  /** an independent check agreed that this line is wrong */
  confirmed: boolean;
  /** an independent check found the line correct */
  refuted: boolean;
  reading: string;
  /** char range in the recognised line text, null = whole line */
  span: [number, number] | null;
  title: string;
  detail: string;
  hint: string;
  fix: string;
  /** the judge's corrected reading, when the image showed something else */
  corrected?: string;
  /** misconception tag for the mistake journal */
  misconception?: string;
  /** a proof step (the proof ladder applies) and its named logical gap */
  proof?: boolean;
  gap?: string;
}

export interface AiOutcome {
  lines: AiLineOutcome[];
  concept: string;
  finalAnswer: string;
  tokens: { input: number; output: number };
  model: string;
  cached: boolean;
}

export interface LocalResult {
  lines: LineCheck[];
  issues: Issue[];
}

/** BlockCheck plus what the AI added for the insight card. */
export interface LiveBlockCheck extends BlockCheck {
  concept?: string;
  finalAnswer?: string;
  model?: string;
}

const demote = (i: Issue): Issue => ({ ...i, severity: 'unsure', confidence: Math.min(i.confidence, 0.6) });

export function mergeCheck(a: { blockId: string; pageId: string; recognition: BlockRecognition; local: LocalResult; ai: AiOutcome | null; ms: number; via: BlockCheck['via'] }): LiveBlockCheck {
  const lines: LineCheck[] = [];
  const issues: Issue[] = [];
  for (const rec of a.recognition.lines) {
    const id = rec.lineId;
    const localLine = a.local.lines.find((l) => l.lineId === id);
    const L: Verdict = localLine?.verdict ?? 'none';
    const localIssues = a.local.issues.filter((i) => i.lineId === id);
    const casError = localIssues.find((i) => i.severity === 'error');
    const confident = rec.confidence >= CONFIDENT_READING;
    const A = a.ai?.lines.find((l) => l.lineId === id);
    let verdict: Verdict;
    const out: Issue[] = [];

    if (L === 'error' && confident && casError && casError.confidence >= CONFIDENT_CAS) {
      // (a) proved wrong on a confident reading: final, whatever the AI says
      verdict = 'error';
      out.push(...localIssues.map((i) => (i === casError ? { ...i, source: 'local-cas' as const } : i)));
      // the AI's explanation and hint are better words for the same mistake
      if (A && A.verdict === 'error') Object.assign(out[0], { hint: out[0].hint ?? (A.hint || undefined), fix: out[0].fix ?? (A.fix || undefined) });
    } else if (L === 'ok' && confident) {
      verdict = 'ok';
    } else if (A) {
      const unsure = (issue: Issue | null) => {
        verdict = 'unsure';
        if (issue) out.push(issue);
        else if (localIssues.length) out.push(...localIssues.map(demote));
        else out.push({ lineId: id, span: A.span, severity: 'unsure', title: 'Not sure', detail: 'The local check and the AI do not agree on this line.', source: 'ai', confidence: 0.4 });
      };
      verdict = 'ok';
      if (A.verdict === 'error') {
        if (A.confirmed && !A.refuted) {
          verdict = 'error';
          out.push(aiIssue(A, 'error'));
        } else if (A.refuted && !A.confirmed && L !== 'error') verdict = 'ok'; // the independent check found it correct
        else unsure(A.title || A.detail ? aiIssue(A, 'unsure') : null);
      } else if (A.verdict === 'ok') {
        // the AI settles what the CAS could not decide, but does not overrule a local error
        if (L === 'error') unsure(null);
      } else unsure(A.title || A.detail ? aiIssue(A, 'unsure') : null);
    } else {
      // no AI: a local error on an uncertain reading is only a suspicion
      verdict = L === 'error' ? 'unsure' : L;
      if (L === 'error' || L === 'unsure') out.push(...localIssues.map((i) => (i.severity === 'error' ? demote(i) : i)));
    }
    // carry-forward: the line follows correctly from an earlier wrong one (no mark of its own)
    lines.push(localLine?.carried ? { lineId: id, verdict, carried: true } : { lineId: id, verdict });
    issues.push(...out);
  }
  const check: LiveBlockCheck = {
    blockId: a.blockId,
    pageId: a.pageId,
    recognition: a.recognition,
    lines,
    issues,
    via: a.via,
    ms: a.ms,
  };
  if (a.ai) {
    check.tokens = a.ai.tokens;
    if (a.ai.concept) check.concept = a.ai.concept;
    if (a.ai.finalAnswer) check.finalAnswer = a.ai.finalAnswer;
    check.model = a.ai.model;
  }
  return enforceRedPolicy(check);
}

function aiIssue(A: AiLineOutcome, severity: 'error' | 'unsure'): Issue {
  return {
    lineId: A.lineId,
    span: A.span,
    severity,
    title: A.title || (severity === 'error' ? 'Check this step' : 'Not sure'),
    detail: A.detail,
    hint: A.hint || undefined,
    fix: A.fix || undefined,
    source: severity === 'error' ? 'ai-verified' : 'ai',
    confidence: severity === 'error' ? 0.9 : 0.5,
    ...(A.misconception ? { misconception: A.misconception } : {}),
  };
}

/**
 * The red-mark invariant, applied last: an 'error' needs a local-CAS issue on a confident reading
 * or an ai-verified issue. Anything else is demoted to 'unsure'.
 */
export function enforceRedPolicy<T extends BlockCheck>(check: T): T {
  const conf = new Map(check.recognition.lines.map((l) => [l.lineId, l.confidence]));
  // a block's first line (or a lone line) has no premise: it is a definition or a given ("a=3",
  // "x=3"), not a step, so it is never red (a misread "a=3" as "0=3" must not turn red)
  const premiseless = check.recognition.lines[0]?.lineId;
  const issues = check.issues.map((i) => {
    if (i.severity !== 'error') return i;
    if (i.lineId === premiseless) return demote(i);
    const ok = i.source === 'ai-verified' || (i.source === 'local-cas' && (conf.get(i.lineId) ?? 0) >= CONFIDENT_READING && i.confidence >= CONFIDENT_CAS);
    return ok ? i : demote(i);
  });
  const lines = check.lines.map((l) => (l.verdict === 'error' && !issues.some((i) => i.lineId === l.lineId && i.severity === 'error') ? { ...l, verdict: 'unsure' as const } : l));
  return { ...check, lines, issues };
}
