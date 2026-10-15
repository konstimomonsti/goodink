// Prompt templates for live checking (judge), blind verification, tutoring answers, the AI selector
// and voice. System prompts are static so they stay a cacheable prefix; everything that varies goes
// in the user turn. Tunables live in ./policy.ts (which re-exports this file). Scope: everything a
// mathematics degree needs (ARCHITECTURE.md §D); maths is always exchanged as LaTeX.

// ---- judge --------------------------------------------------------------------------------------

/**
 * The cloud JUDGES, it does not read: the local recogniser's reading arrives as LaTeX with a crop of
 * just this line (or 2-D structure), and the model confirms or corrects the reading, then judges the
 * step against the earlier steps (LaTeX). Specialised local readers beat frontier VLMs at handwritten
 * maths, so the model corrects the reading only when the image clearly shows something else.
 * Proof steps are judged as proofs: an "error" there must name one specific logical gap.
 */
export const JUDGE_SYSTEM = `You check one step of a student's handwritten maths, like a careful university teacher who only marks what is certainly wrong. Any level: school algebra to a full mathematics degree (analysis, linear and abstract algebra, ε-δ arguments, induction, quantifier logic, probability).
Input: the earlier steps as LaTeX (already checked), a local recogniser's reading of the new step (LaTeX and linear text), and an image of the new step's handwriting (a matrix, integral with limits, cases or aligned derivation is shown whole).
1. reading_ok: true if the image shows the recogniser's reading (ignore spacing and notation style). If the image clearly shows something else, false, and give the right reading in "corrected" as LaTeX. Otherwise "corrected" is "".
2. step_kind: "proof" for a step of a proof or argument (claims, quantifiers, "assume", "hence", "by induction", "let ε>0", set or group properties); otherwise "calculation".
3. Judge the step as written (corrected if you corrected it), only against the earlier steps and standard definitions and theorems:
   verdict "ok": correct, or follows correctly from the earlier steps. Unfinished work is fine.
   verdict "error": only if you are certain it is wrong or does not follow. For a proof step, also only if you can name one specific logical gap in "gap" (e.g. "the induction step assumes P(k+1)", "the order of ∀ε ∃δ is swapped", "δ depends on x", "uses commutativity in a group not known to be abelian", "divides by a possibly zero determinant").
   verdict "unsure": the handwriting is ambiguous, the step is not fully justified but not clearly wrong, or you cannot decide.
4. For "error" or "unsure":
   wrong_span: the shortest exact substring of the step's reading that is wrong (e.g. "10", "-3", "x^2"), or "".
   title: 2 to 4 words naming the mistake (e.g. "Sign error", "Quantifier order"). detail: one sentence saying what is wrong without giving the correct result, maths in $...$.
   hint: a question that nudges towards the problem without revealing the answer (for a proof: a precise question about the missing justification). fix: for "error", the corrected step in LaTeX.
   gap: for a proof step, the specific logical gap in one sentence; otherwise "".
   misconception: for "error", one tag: sign-move, distribute-first-term, square-of-sum, cancel-terms, divide-one-side, sqrt-of-sum, exponent-product, fraction-add-denominators, order-of-operations, arithmetic, inverse-operation, inequality-flip, power-rule, derivative, log-rule, function-linearity, like-terms, dropped-term, extra-term, proof-gap, other.
   For "ok" all of these are "".
5. concept: the topic in 2 to 4 words.
Examples:
earlier: 2x+3=7 | step: 2x=10 -> {"reading_ok":true,"corrected":"","latex":"2x=10","step_kind":"calculation","verdict":"error","wrong_span":"10","title":"Subtraction error","detail":"Moving $+3$ across should subtract it from $7$.","hint":"What is $7-3$?","fix":"2x=4","gap":"","misconception":"sign-move","concept":"Linear equations"}
earlier: (none) | step: (a+b)^2=a^2+b^2 -> {"reading_ok":true,"corrected":"","latex":"(a+b)^2=a^2+b^2","step_kind":"calculation","verdict":"error","wrong_span":"a^2+b^2","title":"Missing middle term","detail":"Squaring a sum does not square each term separately.","hint":"Write $(a+b)^2$ as $(a+b)(a+b)$ and multiply out.","fix":"(a+b)^2=a^2+2ab+b^2","gap":"","misconception":"square-of-sum","concept":"Binomial expansion"}
earlier: x^2=9 | step: x=3 (image shows x=±3) -> {"reading_ok":false,"corrected":"x=\\\\pm 3","latex":"x=\\\\pm 3","step_kind":"calculation","verdict":"ok","wrong_span":"","title":"","detail":"","hint":"","fix":"","gap":"","misconception":"","concept":"Quadratic equations"}
earlier: \\\\text{Assume } P(k) \\\\text{ holds.} | step: \\\\text{Then } P(k+1) \\\\text{ holds, so } \\\\sum_{i=1}^{k+1} i = \\\\tfrac{(k+1)(k+2)}{2} -> {"reading_ok":true,"corrected":"","latex":"...","step_kind":"proof","verdict":"error","wrong_span":"","title":"Step not shown","detail":"The step concludes $P(k+1)$ without deriving it from $P(k)$.","hint":"How can you write $\\\\sum_{i=1}^{k+1} i$ using $\\\\sum_{i=1}^{k} i$?","fix":"\\\\sum_{i=1}^{k+1} i = \\\\tfrac{k(k+1)}{2} + (k+1) = \\\\tfrac{(k+1)(k+2)}{2}","gap":"The induction step asserts P(k+1) instead of deriving it from P(k).","misconception":"proof-gap","concept":"Induction"}
Reply with the JSON object only.`;

export interface PriorStep {
  text: string;
  latex: string;
}

export function judgeUser(prior: PriorStep[], reading: string, latex: string): string {
  const earlier = prior.length ? prior.map((p, i) => `${i + 1}. ${p.latex || p.text || '?'}`).join('\n') : '(none: judge the step on its own)';
  return `Earlier steps (LaTeX):\n${earlier}\n\nRecogniser reading of the new step:\nlatex: ${latex || reading || '?'}\ntext: ${reading || '?'}`;
}

/**
 * Misconception tags, shared with the CAS (math/index.ts MISCONCEPTION): name and rule, for
 * "Your patterns" and rule flashcards. The judge must answer with one of these keys.
 */
export const MISCONCEPTIONS: Record<string, { label: string; rule: string }> = {
  'sign-move': { label: 'Moving a term across', rule: 'A term that moves to the other side of an equation changes its sign: $x+a=b \\Rightarrow x=b-a$.' },
  'distribute-first-term': { label: 'Distributing only the first term', rule: 'A factor multiplies every term in the bracket: $a(b+c)=ab+ac$.' },
  'square-of-sum': { label: 'Squaring a sum term by term', rule: '$(a+b)^2=a^2+2ab+b^2$, not $a^2+b^2$.' },
  'cancel-terms': { label: 'Cancelling terms instead of factors', rule: 'Only common factors cancel: $\\frac{ab}{ac}=\\frac{b}{c}$, but $\\frac{a+b}{a+c}$ does not simplify that way.' },
  'divide-one-side': { label: 'Changing only one side or one term', rule: 'Whatever you do to an equation, do it to the whole of both sides: every term on each side.' },
  'sqrt-of-sum': { label: 'Root of a sum', rule: '$\\sqrt{a+b}$ is not $\\sqrt{a}+\\sqrt{b}$; roots split only over products: $\\sqrt{ab}=\\sqrt{a}\\sqrt{b}$.' },
  'exponent-product': { label: 'Exponent rules', rule: '$a^m\\cdot a^n=a^{m+n}$, $(a^m)^n=a^{mn}$, $(ab)^n=a^nb^n$, but $(a+b)^n\\neq a^n+b^n$.' },
  'fraction-add-denominators': { label: 'Adding fractions', rule: 'Add fractions over a common denominator: $\\frac{a}{b}+\\frac{c}{d}=\\frac{ad+bc}{bd}$, never top+top over bottom+bottom.' },
  'order-of-operations': { label: 'Order of operations', rule: 'Brackets, then powers, then multiplication and division, then addition and subtraction.' },
  arithmetic: { label: 'Arithmetic slip', rule: 'Recompute each number in a step before moving on; a quick estimate catches most slips.' },
  'inverse-operation': { label: 'Wrong inverse operation', rule: 'Undo an operation with its inverse: $+$ with $-$, $\\times$ with $\\div$, a square with a square root (both signs).' },
  'inequality-flip': { label: 'Inequality direction', rule: 'Multiplying or dividing an inequality by a negative number flips its direction.' },
  'power-rule': { label: 'Power rule', rule: '$\\frac{d}{dx}x^n=nx^{n-1}$: bring the exponent down and lower it by one.' },
  derivative: { label: 'Derivative slip', rule: 'Differentiate term by term, and use the product, quotient and chain rules where they apply.' },
  'log-rule': { label: 'Logarithm rules', rule: '$\\log(ab)=\\log a+\\log b$, $\\log(a^n)=n\\log a$; $\\log(a+b)$ does not split.' },
  'function-linearity': { label: 'Treating a function as linear', rule: 'Most functions do not split over sums: $\\sin(a+b)\\neq\\sin a+\\sin b$, $f(a+b)\\neq f(a)+f(b)$ in general.' },
  'like-terms': { label: 'Combining unlike terms', rule: 'Only like terms combine: $3x+2x=5x$, but $3x+2$ and $x^2+x$ stay as they are.' },
  'dropped-term': { label: 'Dropped a term', rule: 'When you rewrite a line, carry every term across; count the terms before and after.' },
  'extra-term': { label: 'Extra term', rule: 'A rewrite must not add terms out of nowhere; check each term comes from the line above.' },
  'proof-gap': { label: 'Gap in a proof', rule: 'Each line of a proof must follow from earlier lines, the hypotheses or a named definition or theorem; say which one you use.' },
  other: { label: 'Other mistakes', rule: 'Check each step against the one before it: does it say the same thing?' },
};

/** A tag from the judge as one of MISCONCEPTIONS' keys ('other' when unknown). */
export function normMisconception(tag: string): string {
  const t = tag.toLowerCase().replace(/[^a-z-]/g, '');
  return t in MISCONCEPTIONS ? t : t ? 'other' : '';
}

// ---- blind verification -------------------------------------------------------------------------

/**
 * The verifier never sees the judge's verdict: it gets the image, the earlier steps and the step's
 * reading, and must work the step out (or, for a proof step, critique it) itself. It runs in
 * parallel with the judge, ideally on another vendor's model, so the two errors are uncorrelated.
 */
export const VERIFY_SYSTEM = `You verify one step of a student's handwritten maths independently, at any level up to a mathematics degree.
You get the earlier steps as LaTeX, the step to verify as LaTeX, and an image of that step.
1. readingOk: true if the image shows the step as transcribed (ignore spacing and notation style).
2. work: for a calculation, solve or simplify the earlier steps yourself in at most two short lines and derive what this step should say; for a proof step, state what this step needs (hypothesis, definition or theorem) and whether the earlier steps provide it.
3. valid: "yes" if the step follows correctly, "no" if it is wrong or (for a proof) has a definite logical gap, "unsure" if you cannot tell or it is merely terse.
4. gap: for a proof step judged "no", the specific logical gap in one sentence; otherwise "".
5. reason: one short sentence.
Reply with JSON only: {"readingOk":true,"work":"...","valid":"yes|no|unsure","gap":"","reason":"..."}`;

export function verifyUser(prev: string[], line: string): string {
  return `Earlier steps:\n${prev.length ? prev.join('\n') : '(none: judge the step on its own)'}\n\nStep to verify:\n${line}`;
}

// ---- tutoring (RESEARCH-ux §1.2, §2 rules 7–8) ----------------------------------------------------

export const TUTOR_SYSTEM = `You are a patient maths tutor (school to university level) looking at a learner's handwritten notes.
The image shows the part of the page the learner is asking about; the transcription given with it may contain misreads.
How you teach:
- One step per reply, at most 60 words. No preamble.
- Ask before telling: prefer a short guiding question the learner can answer.
- Never state a corrected step, a corrected value or a final answer to the learner's own work unless the request contains the words "Show the fix". This holds even if the learner asks for the answer: then give a hint instead.
- If a verified solution or correct step is given below, it is the truth: follow it and never contradict it.
- Worked examples always use different numbers from the learner's problem.
- For proofs, name the definition or theorem that applies and point at the missing justification; do not write the learner's proof for them.
Write maths in LaTeX: $...$ inline, $$...$$ on its own line; never use LaTeX for ordinary words. Reply in the language of the learner's question (or of their notes).
After your answer, on a last line of its own, write ">>> " followed by two or three short follow-up questions the learner might ask next, separated by " | ".`;

export type HintLevel = 'hint' | 'next' | 'fix' | 'explain' | 'explainBack';

/** The hint ladder: Hint (conceptual question) -> Next step (structure only) -> Show fix (bottom-out). */
export const LADDER: Record<HintLevel, string> = {
  hint: 'Give one hint as a short guiding question that points at what went wrong. Do not reveal the correct step, the corrected value or the answer.',
  next: 'Say only what to do next (the operation or idea), not its result, in one or two sentences. Do not write the corrected step or finish the problem.',
  fix: 'Show the fix: give the corrected step and explain the mistake in one or two sentences. Do not solve the rest of the problem.',
  explainBack: 'The fix was just shown. Ask exactly one short explain-back question that checks the learner understood why the fix is right (e.g. "Why do we subtract 3 from both sides?"). Do not answer it, and add nothing else.',
  explain: 'Explain the idea behind this step simply: which rule applies and why, with a tiny worked example that uses different numbers. Do not state the corrected step, any corrected value or the answer to the learner\'s problem.',
};

/** The ladder for proof steps: what is missing -> which definition or theorem applies -> the next line. */
export const PROOF_LADDER: Record<HintLevel, string> = {
  hint: 'Say what is missing in this proof step (which claim is not yet justified), as a short question. Do not write the missing argument.',
  next: 'Name the definition, hypothesis or theorem that closes the gap and what it gives here, in one or two sentences. Do not write the proof line.',
  fix: 'Show the fix: write the next correct line of the proof (LaTeX) and say in one sentence why it follows. Do not finish the proof.',
  explainBack: LADDER.explainBack,
  explain: 'Explain the idea of this proof step: which definition or theorem is used and why it applies, with a tiny example (different objects). Do not write the learner\'s proof.',
};

export type QuickActionId = 'explain' | 'check' | 'solve' | 'summarise' | 'translate' | 'flashcards';

export const QUICK_ACTIONS: { id: QuickActionId; label: string; prompt: string }[] = [
  { id: 'explain', label: 'Explain', prompt: 'Explain what this shows, simply and briefly. Do not correct the learner\'s work or state corrected values.' },
  { id: 'check', label: 'Check my work', prompt: 'Check this work step by step. Say which step is the first wrong one (if any) and why, without solving the rest for me.' },
  // only offered for material that is not the learner's own marked work (the UI routes marked work to the card)
  { id: 'solve', label: 'Solve step by step', prompt: 'Show the fix: solve this given problem step by step, one short line per step, and state the final answer.' },
  { id: 'summarise', label: 'Summarise', prompt: 'Summarise this in at most five short bullet points.' },
  { id: 'translate', label: 'Translate', prompt: 'Translate the text in this region into English (or into German if it is already English). Keep formulas as they are.' },
  { id: 'flashcards', label: 'Make flashcards', prompt: 'Make flashcards from this.' },
];

export interface IssueBrief {
  title: string;
  detail: string;
  lineText: string;
  /** the corrected step, verified by the CAS or confirmed by two models (only once Show fix is unlocked) */
  fix?: string;
  /** a proof step: the proof ladder applies */
  proof?: boolean;
  /** the specific logical gap of a proof step */
  gap?: string;
}

/**
 * What the learner's request becomes for a ladder level or quick action. `grounding` (the CAS's
 * correct step or solution) is passed so the model cannot invent the maths (Kestin et al. 2025);
 * callers pass it, and issue.fix, only once Show fix is unlocked.
 */
export function questionFor(opts: { question?: string; level?: HintLevel; action?: QuickActionId; issue?: IssueBrief; grounding?: string }): string {
  const parts: string[] = [];
  if (opts.issue) parts.push(`The checker found a problem in the step "${opts.issue.lineText}": ${opts.issue.title}. ${opts.issue.detail}${opts.issue.gap ? ` Gap: ${opts.issue.gap}` : ''}`.trim());
  const truth = opts.grounding || opts.issue?.fix;
  if (truth) parts.push(`Verified correct step (for you; reveal it only when showing the fix): ${truth}`);
  const ladder = opts.issue?.proof ? PROOF_LADDER : LADDER;
  if (opts.level) parts.push(opts.level === 'fix' ? ladder.fix : ladder[opts.level]);
  if (opts.action) parts.push(QUICK_ACTIONS.find((a) => a.id === opts.action)?.prompt ?? '');
  if (opts.question?.trim()) parts.push(`The learner asks: ${opts.question.trim()}`);
  return parts.filter(Boolean).join('\n') || 'Explain this.';
}

/** A request that asks for the answer instead of help (the ladder answers it with a hint first). */
export const ANSWER_SEEKING = /\b(answers?|solutions?|solve|result|tell me|just (give|tell|show)|what('?s| is) (x|y|z|the (answer|result|value))|correct (step|line|value|version)|fix it|do it for me|l[öo]sung|l[öo]s(e|en)|antwort|ergebnis|sag (mir|es))\b/i;

/** The ladder's reply to an answer-seeking request while Show fix is still locked. */
export function ladderLockedReply(unlockInMs: number): string {
  const s = Math.ceil(unlockInMs / 1000);
  return s > 0 ? `Try the hint first. Show fix unlocks in ${s} s.` : 'Try the hint first. Show fix unlocks after one hint.';
}

/** Split the trailing ">>> a | b | c" follow-up line off an answer (also while it is still streaming). */
export function splitFollowUps(text: string): { body: string; followUps: string[] } {
  const k = text.lastIndexOf('>>>');
  if (k < 0) {
    // hide a marker that is still arriving: ">", ">>" at the very end of a line
    const m = /\n?>{1,2}$/.exec(text);
    return { body: m ? text.slice(0, m.index) : text, followUps: [] };
  }
  const body = text.slice(0, k).replace(/\s+$/, '');
  const followUps = text
    .slice(k + 3)
    .split('|')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 2)
    .slice(0, 3);
  return { body, followUps };
}

// ---- voice --------------------------------------------------------------------------------------

export const TRANSCRIBE_SYSTEM = 'You transcribe speech. Reply with the exact words spoken, in the language spoken, with normal punctuation. Write spoken math as plain text (e.g. "x squared plus 3"). No comments, no quotes. If there is no speech, reply with nothing.';

/** "why?", "this", "here" and friends: a question that points at the ink instead of naming it. */
export const DEICTIC = /\b(why|this|that|here|there|it|wrong|warum|wieso|das|dies|hier|da|falsch)\b|^\W*\?\W*$/i;
