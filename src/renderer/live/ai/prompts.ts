// Prompt templates for live checking (judge), blind verification, tutoring answers, the AI selector
// and voice. System prompts are static so they stay a cacheable prefix; everything that varies goes
// in the user turn. Tunables live in ./policy.ts (which re-exports this file).

// ---- judge --------------------------------------------------------------------------------------

/**
 * The cloud JUDGES, it does not read: the local recogniser's reading arrives as text with a crop of
 * just this line, and the model confirms or corrects the reading, then judges the step against the
 * earlier steps (text). Specialised local readers beat frontier VLMs at handwritten maths, so the
 * model is asked to correct the reading only when the image clearly shows something else.
 */
export const JUDGE_SYSTEM = `You check one step of a student's handwritten maths, like a careful teacher who only marks what is certainly wrong.
Input: the earlier steps as text (already checked), a local recogniser's reading of the new step (text and LaTeX), and an image of the new step's handwriting.
1. reading_ok: true if the image shows the recogniser's reading (ignore spacing and notation style). If the image clearly shows something else, false, and give the right reading in "corrected" (plain linear text like 2x+3=7, x^2-4=(x-2)(x+2), sqrt(x)=3). Otherwise "corrected" is "".
2. Judge the step as written (corrected if you corrected it), only against the earlier steps:
   verdict "ok": correct, or follows correctly from the earlier steps (an equivalent rewrite, the same operation on both sides, a correct evaluation). Unfinished work is fine.
   verdict "error": only if you are certain it is mathematically wrong or does not follow.
   verdict "unsure": the handwriting is ambiguous, or you cannot decide.
3. For "error" or "unsure":
   wrong_span: the shortest exact substring of the step's reading that is wrong (e.g. "10", "-3", "x^2"), or "".
   title: 2 to 4 words naming the mistake (e.g. "Sign error"). detail: one sentence saying what is wrong without giving the correct result, maths in $...$.
   hint: for "error", a question that nudges towards the mistake without revealing the answer. fix: for "error", the corrected step in LaTeX.
   misconception: for "error", one tag: sign-move, distribute-first-term, square-of-sum, exponent-rule, fraction-add, cancel-terms, divide-one-side, arithmetic, root-sign, log-rule, order-of-operations, copy-error, other.
   For "ok" all of these are "".
4. concept: the topic in 2 to 4 words.
Examples:
earlier: 2x+3=7 | step: 2x=10 -> {"reading_ok":true,"corrected":"","latex":"2x=10","verdict":"error","wrong_span":"10","title":"Subtraction error","detail":"Moving $+3$ across should subtract it from $7$.","hint":"What is $7-3$?","fix":"2x=4","misconception":"sign-move","concept":"Linear equations"}
earlier: (none) | step: (a+b)^2=a^2+b^2 -> {"reading_ok":true,"corrected":"","latex":"(a+b)^2=a^2+b^2","verdict":"error","wrong_span":"a^2+b^2","title":"Missing middle term","detail":"Squaring a sum does not square each term separately.","hint":"Write $(a+b)^2$ as $(a+b)(a+b)$ and multiply out.","fix":"(a+b)^2=a^2+2ab+b^2","misconception":"square-of-sum","concept":"Binomial expansion"}
earlier: x^2=9 | step: x=3 (image shows x=±3) -> {"reading_ok":false,"corrected":"x=±3","latex":"x=\\\\pm 3","verdict":"ok","wrong_span":"","title":"","detail":"","hint":"","fix":"","misconception":"","concept":"Quadratic equations"}
Reply with the JSON object only.`;

export function judgeUser(prior: string[], reading: string, latex: string): string {
  const earlier = prior.length ? prior.map((p, i) => `${i + 1}. ${p}`).join('\n') : '(none: judge the step on its own)';
  return `Earlier steps:\n${earlier}\n\nRecogniser reading of the new step:\ntext: ${reading || '?'}\nlatex: ${latex || reading || '?'}`;
}

/** Misconception tags (judge, CAS) with a name and the rule, for "Your patterns" and rule flashcards. */
export const MISCONCEPTIONS: Record<string, { label: string; rule: string }> = {
  'sign-move': { label: 'Moving a term across', rule: 'A term that moves to the other side of an equation changes its sign: $x+a=b \Rightarrow x=b-a$.' },
  'distribute-first-term': { label: 'Distributing only the first term', rule: 'A factor multiplies every term in the bracket: $a(b+c)=ab+ac$.' },
  'square-of-sum': { label: 'Squaring a sum', rule: '$(a+b)^2=a^2+2ab+b^2$, not $a^2+b^2$.' },
  'exponent-rule': { label: 'Exponent rules', rule: '$a^m\cdot a^n=a^{m+n}$, $(a^m)^n=a^{mn}$, $a^{-n}=1/a^n$.' },
  'fraction-add': { label: 'Adding fractions', rule: 'Add fractions over a common denominator: $\frac{a}{b}+\frac{c}{d}=\frac{ad+bc}{bd}$, never top+top over bottom+bottom.' },
  'cancel-terms': { label: 'Cancelling terms instead of factors', rule: 'Only common factors cancel: $\frac{ab}{ac}=\frac{b}{c}$, but $\frac{a+b}{a+c}$ does not simplify that way.' },
  'divide-one-side': { label: 'Changing only one side', rule: 'Whatever you do to one side of an equation, do to the whole other side too.' },
  arithmetic: { label: 'Arithmetic slip', rule: 'Recompute each number in a step before moving on; a quick estimate catches most slips.' },
  'root-sign': { label: 'Forgetting the ± of a square root', rule: '$x^2=c$ (with $c>0$) has two solutions: $x=\pm\sqrt{c}$.' },
  'log-rule': { label: 'Logarithm rules', rule: '$\log(ab)=\log a+\log b$, $\log(a^n)=n\log a$; $\log(a+b)$ does not split.' },
  'order-of-operations': { label: 'Order of operations', rule: 'Brackets, then powers, then multiplication and division, then addition and subtraction.' },
  'copy-error': { label: 'Copying a line wrong', rule: 'When you rewrite a line, check every sign and number against the line above.' },
  other: { label: 'Other mistakes', rule: 'Check each step against the one before it: does it say the same thing?' },
};

// ---- blind verification -------------------------------------------------------------------------

/**
 * The verifier never sees the judge's verdict: it gets the image, the earlier steps and the step's
 * reading, and must work the step out itself. It runs in parallel with the judge, ideally on another
 * vendor's model, so the two errors are uncorrelated.
 */
export const VERIFY_SYSTEM = `You verify one step of a student's handwritten maths, independently.
You get the earlier steps as text, a transcription of the step to verify, and an image of that step.
1. readingOk: true if the image shows the step as transcribed (ignore spacing and notation style).
2. work: solve or simplify the earlier steps yourself in at most two short lines and derive what this step should say.
3. valid: "yes" if the step follows correctly from the earlier steps (an equivalent rewrite, a correct operation on both sides, a correct evaluation), "no" if it is mathematically wrong, "unsure" if you cannot tell.
4. reason: one short sentence.
Reply with JSON only: {"readingOk":true,"work":"...","valid":"yes|no|unsure","reason":"..."}`;

export function verifyUser(prev: string[], line: string): string {
  return `Earlier steps:\n${prev.length ? prev.join('\n') : '(none: judge the step on its own)'}\n\nStep to verify:\n${line}`;
}

// ---- tutoring (RESEARCH-ux §1.2, §2 rules 7–8) ----------------------------------------------------

export const TUTOR_SYSTEM = `You are a patient maths and science tutor looking at a learner's handwritten notes.
The image shows the part of the page the learner is asking about; the transcription given with it may contain misreads.
How you teach:
- One step per reply, at most 60 words. No preamble.
- Ask before telling: prefer a short guiding question the learner can answer.
- Never state the final answer, or the corrected step, unless the request says "show the fix" or the learner explicitly asks to solve.
- If a verified solution or correct step is given below, it is the truth: follow it and never contradict it.
- Worked examples always use different numbers from the learner's problem.
Write maths in LaTeX: $...$ inline, $$...$$ on its own line; never use LaTeX for ordinary words. Reply in the language of the learner's question (or of their notes).
After your answer, on a last line of its own, write ">>> " followed by two or three short follow-up questions the learner might ask next, separated by " | ".`;

export type HintLevel = 'hint' | 'next' | 'fix' | 'explain' | 'explainBack';

/** The hint ladder: Hint (conceptual question) -> Next step (structure only) -> Show fix (bottom-out). */
export const LADDER: Record<HintLevel, string> = {
  hint: 'Give one hint as a short guiding question that points at what went wrong. Do not reveal the correct step, the corrected value or the answer.',
  next: 'Say only what to do next (the operation or idea), not its result, in one or two sentences. Do not write the corrected step or finish the problem.',
  fix: 'Show the fix: give the corrected step and explain the mistake in one or two sentences. Do not solve the rest of the problem.',
  explainBack: 'The fix was just shown. Ask exactly one short explain-back question that checks the learner understood why the fix is right (e.g. "Why do we subtract 3 from both sides?"). Do not answer it, and add nothing else.',
  explain: 'Explain the idea behind this step simply: which rule applies and why, with a tiny worked example that uses different numbers. Do not solve the learner\'s problem.',
};

export type QuickActionId = 'explain' | 'check' | 'solve' | 'summarise' | 'translate' | 'flashcards';

export const QUICK_ACTIONS: { id: QuickActionId; label: string; prompt: string }[] = [
  { id: 'explain', label: 'Explain', prompt: 'Explain what this shows, simply and briefly.' },
  { id: 'check', label: 'Check my work', prompt: 'Check this work step by step. Say which step is the first wrong one (if any) and why, without solving the rest for me.' },
  { id: 'solve', label: 'Solve step by step', prompt: 'The learner explicitly asks to solve this: solve it step by step, one short line per step, and state the final answer.' },
  { id: 'summarise', label: 'Summarise', prompt: 'Summarise this in at most five short bullet points.' },
  { id: 'translate', label: 'Translate', prompt: 'Translate the text in this region into English (or into German if it is already English). Keep formulas as they are.' },
  { id: 'flashcards', label: 'Make flashcards', prompt: 'Make flashcards from this.' },
];

export interface IssueBrief {
  title: string;
  detail: string;
  lineText: string;
  /** the corrected step, verified by the CAS or confirmed by two models */
  fix?: string;
}

/**
 * What the learner's request becomes for a ladder level or quick action. `grounding` (the CAS's
 * correct step or solution) is passed so the model cannot invent the maths (Kestin et al. 2025).
 */
export function questionFor(opts: { question?: string; level?: HintLevel; action?: QuickActionId; issue?: IssueBrief; grounding?: string }): string {
  const parts: string[] = [];
  if (opts.issue) parts.push(`The checker found a mistake in the step "${opts.issue.lineText}": ${opts.issue.title}. ${opts.issue.detail}`.trim());
  const truth = opts.grounding || opts.issue?.fix;
  if (truth) parts.push(`Verified correct step (for you; reveal it only when showing the fix): ${truth}`);
  if (opts.level) parts.push(opts.level === 'fix' ? `Show the fix. ${LADDER.fix}` : LADDER[opts.level]);
  if (opts.action) parts.push(QUICK_ACTIONS.find((a) => a.id === opts.action)?.prompt ?? '');
  if (opts.question?.trim()) parts.push(`The learner asks: ${opts.question.trim()}`);
  return parts.filter(Boolean).join('\n') || 'Explain this.';
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
