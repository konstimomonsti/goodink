// The AI line check: a judge call and a blind re-solve, run in parallel.
//   judge:  the crop of ONE line + its local reading as text + earlier steps as text. It confirms or
//           corrects the reading and judges the step (strict JSON, no thinking, static prompt first).
//   verify: started at the same time (on another vendor when two are ready); it works the step out
//           from the earlier steps without ever seeing the judge's verdict. Aborted when the judge
//           finds nothing wrong.
// An AI 'error' becomes red only when the blind re-solve agrees AND the local CAS does not find
// the (corrected) reading correct. Disagreement => amber. See merge.ts for the final policy.
import type { CompleteRequest, ProviderId, Usage } from '../../lib/ai';
import type { LineRecognition, Verdict } from '../contract';
import { JUDGE_SCHEMA, mapSpan, parseAiJudge, parseAiVerify, VERIFY_SCHEMA, type AiJudge, type AiVerify } from './json';
import type { AiLineOutcome, LocalResult } from './merge';
import { JUDGE_SYSTEM, judgeUser, normMisconception, POLICY, VERIFY_SYSTEM, verifyUser, type Tier } from './policy';

export interface CropImage {
  mime: 'image/png' | 'image/jpeg';
  data: string; // base64
  w: number;
  h: number;
}

export interface CallResult {
  text: string;
  truncated: boolean;
  usage: Usage; // reported or estimated
  model: string;
  provider?: ProviderId;
}

export interface CallOpts {
  /** may the model think (reasoning effort)? Judge calls never do. */
  think?: boolean;
  /** run on a different provider than this one when another is ready */
  avoid?: ProviderId;
}

/** Runs one request on the best available provider for a tier (failover is the caller's job). */
export type Caller = (tier: Tier, req: CompleteRequest, opts?: CallOpts) => Promise<CallResult>;

export interface JudgeInput {
  /** the local reading of the line (user corrections applied) */
  line: LineRecognition;
  /** the earlier lines of the block, as recognised (text goes to the model) */
  prior: LineRecognition[];
  /** crop of this line only */
  image: CropImage;
  /** the rest of the page as text (problem statement, definitions, other parts) */
  context?: string;
  /** the local CAS verdict on this line */
  localVerdict: Verdict;
  tier: Tier;
  verifyTier: Tier;
  signal?: AbortSignal;
  /** the local CAS, to test the (corrected) reading */
  checkSteps?: (lines: LineRecognition[]) => LocalResult;
  /** the judge's result before verification (an error then still unconfirmed, so amber) */
  onJudged?: (partial: AiLineOutcome) => void;
}

export interface JudgeResult {
  outcome: AiLineOutcome;
  concept: string;
  tokens: Usage;
  model: string;
  /** what the blind re-solve said, for logs and tests */
  verify: AiVerify | null;
}

const imgPart = (img: CropImage) => ({ mime: img.mime, data: img.data, detail: POLICY.crop.detail, w: img.w, h: img.h });

const looksMath = (s: string) => /[=<>≤≥]/.test(s) || /\d\s*[-+*/^]\s*[\d(a-z]/i.test(s);

function asRecognition(lineId: string, text: string, latex: string): LineRecognition {
  return { lineId, kind: looksMath(text) ? 'math' : 'text', text, latex, confidence: 1, alternates: [], tokens: [], source: 'ai' };
}

/** Link a child AbortController to a parent signal. */
function linked(parent?: AbortSignal): AbortController {
  const c = new AbortController();
  if (parent?.aborted) c.abort();
  else parent?.addEventListener('abort', () => c.abort(), { once: true });
  return c;
}

async function runJudge(call: Caller, input: JudgeInput, extra = ''): Promise<{ j: AiJudge | null; tokens: Usage; model: string; provider?: ProviderId; truncated: boolean }> {
  const prior = input.prior.slice(-POLICY.priorLines).map((l) => ({ text: l.text, latex: l.latex }));
  const r = await call(
    input.tier,
    {
      system: JUDGE_SYSTEM,
      cacheSystem: true,
      images: [imgPart(input.image)],
      turns: [{ role: 'user', text: judgeUser(prior, input.line.text, input.line.latex, input.context) + extra }],
      maxTokens: input.tier === 'fast' ? POLICY.budget.judge : POLICY.budget.judgeStrong,
      json: { name: 'step_judge', schema: JUDGE_SCHEMA },
      signal: input.signal,
    },
    { think: false },
  );
  return { j: parseAiJudge(r.text, input.line.text), tokens: r.usage, model: r.model, provider: r.provider, truncated: r.truncated };
}

async function runVerify(call: Caller, input: JudgeInput, reading: string, signal: AbortSignal, avoid?: ProviderId): Promise<{ v: AiVerify | null; tokens: Usage }> {
  // maths goes as LaTeX (the canonical form: matrices, limits and cases exist only there)
  const prior = input.prior.slice(-POLICY.priorLines).map((l) => l.latex || l.text || '?');
  const strong = input.verifyTier === 'strong';
  const r = await call(
    input.verifyTier,
    {
      system: VERIFY_SYSTEM,
      cacheSystem: true,
      images: [imgPart(input.image)],
      turns: [{ role: 'user', text: verifyUser(prior, reading, input.context) }],
      maxTokens: strong ? POLICY.budget.verifyStrong : POLICY.budget.verifyFast,
      json: { name: 'step_verify', schema: VERIFY_SCHEMA },
      signal,
    },
    // thinking only for Max-mode verification; another vendor when one is ready
    { think: strong, avoid: POLICY.crossVendorVerify ? avoid : undefined },
  );
  return { v: parseAiVerify(r.text), tokens: r.usage };
}

/** The provider the judge will most likely run on (the user's first ready one); set by the caller. */
export interface JudgeHints {
  judgeProvider?: ProviderId;
}

/** Judge one line, with a parallel blind re-solve for anything that may be an error. */
export async function judgeLine(call: Caller, input: JudgeInput, hints: JudgeHints = {}): Promise<JudgeResult | null> {
  const tokens = { input: 0, output: 0 };
  const add = (u: Usage) => {
    tokens.input += u.input;
    tokens.output += u.output;
  };
  const localTex = input.line.latex || input.line.text;
  const vCtrl = linked(input.signal);
  // the blind re-solve starts now, on the local reading, before the judge has said anything
  let verifyP: Promise<{ v: AiVerify | null; tokens: Usage } | null> | null =
    POLICY.verifyInParallel ? runVerify(call, input, localTex, vCtrl.signal, hints.judgeProvider).catch((e) => (vCtrl.signal.aborted && !input.signal?.aborted ? null : Promise.reject(e))) : null;
  // a verify failure must not surface as an unhandled rejection while the judge runs
  verifyP?.catch(() => undefined);

  let judged;
  try {
    judged = await runJudge(call, input);
    add(judged.tokens);
    if (!judged.j) {
      // one more try: cut off => the same budget is too small; unreadable => insist on the format
      judged = await runJudge(call, input, judged.truncated ? '' : '\nYour last reply was not valid JSON. Reply with the JSON object only.');
      add(judged.tokens);
    }
  } catch (e) {
    vCtrl.abort();
    throw e;
  }
  const j = judged.j;
  if (!j) {
    vCtrl.abort();
    return null;
  }
  const reading = j.corrected || input.line.text;
  const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  const corrected = !!j.corrected && !same(j.corrected, input.line.text) && !same(j.corrected, input.line.latex);
  const outcome: AiLineOutcome = {
    lineId: input.line.lineId,
    verdict: j.verdict,
    confirmed: false,
    refuted: false,
    reading,
    corrected: j.corrected || undefined,
    span: j.verdict === 'ok' ? null : mapSpan(input.line.text, reading, j.wrongSpan),
    title: j.title,
    detail: j.detail,
    hint: j.hint,
    fix: j.fix,
    misconception: normMisconception(j.misconception) || undefined,
    proof: j.proof || undefined,
    gap: j.gap || undefined,
  };
  if (j.verdict !== 'error') {
    vCtrl.abort();
    return { outcome, concept: j.concept, tokens, model: judged.model, verify: null };
  }

  // the CAS on the reading the judge settled on: a proof of correctness contradicts the judge
  let cas: Verdict | undefined;
  if (input.checkSteps) {
    try {
      const lines = [...input.prior.slice(-POLICY.priorLines), j.corrected ? asRecognition(input.line.lineId, j.corrected, j.latex) : { ...input.line, confidence: 1 }];
      cas = input.checkSteps(lines).lines.find((l) => l.lineId === input.line.lineId)?.verdict;
    } catch {
      cas = undefined;
    }
  }
  if (cas === 'ok') {
    vCtrl.abort();
    outcome.refuted = true;
    return { outcome, concept: j.concept, tokens, model: judged.model, verify: null };
  }
  input.onJudged?.({ ...outcome });

  // the parallel re-solve judged the local reading; if the judge corrected it, re-solve that reading
  if (!verifyP || corrected) {
    vCtrl.abort();
    const c2 = linked(input.signal);
    verifyP = runVerify(call, input, j.corrected || localTex, c2.signal, judged.provider ?? hints.judgeProvider);
  }
  let verify: AiVerify | null = null;
  try {
    const r = await verifyP;
    if (r) {
      add(r.tokens);
      verify = r.v;
    }
  } catch (e) {
    if (input.signal?.aborted) throw e;
    // no second opinion: the line stays unconfirmed (amber)
  }
  if (verify) {
    // a proof step: both must name a logical gap (the judge always does, see parseAiJudge)
    if (verify.valid === false && verify.readingOk && (!j.proof || !!verify.gap)) outcome.confirmed = true;
    else if (verify.valid === true) outcome.refuted = true;
  }
  // an unconfirmed proof objection becomes a precise question, not a verdict
  if (j.proof && !outcome.confirmed && j.hint) outcome.detail = j.hint;
  return { outcome, concept: j.concept, tokens, model: judged.model, verify };
}
