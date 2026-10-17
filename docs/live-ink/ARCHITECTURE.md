# Live Ink: architecture decisions (from RESEARCH-recognition.md and RESEARCH-ux.md)

These override SPEC.md where they differ. Decided 2026-10-14.

## A. Pipeline

```
pen settles (600 ms) → groupInk (<2 ms)
  ├─ prose: InkAnalyzer (Rust, WinRT), 15–40 ms
  ├─ math: InkAnalyzer + 2-D layout pass (v1, now)  ║  local HMER model via `ort` in Rust (v1.1, spike)
  │        top-k readings with probabilities (alternateProbs)
  ├─ CAS over every reading with p ≥ 0.1 of both lines (beam × beam), 1–5 ms
  └─ Smart/Max: the cloud JUDGES, it does not read: crop + local LaTeX + prior steps as text
       error → independent blind re-solve, run in parallel; cross-vendor when 2 providers are ready
```

1. **The cloud confirms or corrects the reading and judges the step.** Specialised models read
   handwritten math far better than frontier VLMs (TexTeller 86–88% vs Gemini Flash ~55% on
   CROHME). The local reading always goes in as text, and the model returns `reading_ok` /
   `corrected`.
2. **Red only when every plausible reading fails.** A local-cas red needs line confidence ≥ 0.9,
   every reading with p ≥ 0.1 failing, and an error localised to tokens. If any plausible reading
   passes, the verdict is amber or nothing. A red from the AI needs the blind re-solve to agree and
   the CAS not to contradict the corrected reading. Release gate: ≥ 98% red precision on the test
   corpus.
3. **Crops**: only the changed line, about 12 px padding, scaled so the x-height is 20–28 px, long
   edge ≤ 1000 px, black-on-white grayscale. Prior steps go as text. The system prompt and schema
   come first and stay static (prompt cache). Thinking is off for judge calls. Model IDs and prices
   live in config (`live/ai/policy.ts`).
4. **Grounding the tutor**: hint, explain and fix prompts get the CAS's correct next step or
   solution when it has one, so the model cannot hallucinate the maths (Kestin et al.).
5. **Local math model**: a spike with `ort` (ONNX Runtime) in Rust. It benchmarks a CoMER/TAMER-class
   lite model (~8–15 MB) and TexTeller int8 (~120 MB) on our synthetic corpus, and the winner is
   downloaded lazily (sha256 checked). It plugs in as a second `RecogBackend` and is fused by
   confidence. No MathWriting-trained weights (CC BY-NC-SA).

## B. UX rules (binding)

- **Timing**:
  - No work happens during a stroke.
  - Red appears no sooner than 900 ms after pen-up. It is held while the pen is active within 2
    line-heights, until a 1.5 s pause or the pen moves to a new line.
  - Amber and ticks appear at settle.
  - Erasing or editing removes marks within one frame. A fixed step gets a 600 ms green tick fade,
    the only celebration.
- **Marks**:
  - Red is wavy: 1.5 px at 100%, scaled with zoom, #E5484D light / #FF6369 dark, at **100% opacity**
    (the ≥ 3:1 contrast rule wins over the earlier 70%: #E5484D on white is 3.9:1), 250 ms ease-out
    draw-in, played once. Amplitude 1.75 px and wavelength 6 px at 100% (at least 3 periods). It sits
    max(3 px, 0.12 × line height) below the lowest ink of the marked tokens and runs 3 px past each
    side, at least max(14 px, 0.8 × line height) long. (Changed 2026-10-15 after critique r1.)
  - Amber is dotted, #B26B00 at 90% opacity (3.6:1). Confidence is encoded by the dot spacing (gap
    2.4 → 3.6 × width), not by opacity. Hovering says "70% sure: I read 5 as S?".
  - The green tick is ≤ 10 px, #1E8A50 at 70% opacity, and fades out after 4 s unless "show ticks"
    is on.
  - Shape carries the meaning, not colour. With reduced motion, marks are static.
- **First error only.** Later lines that follow correctly from it carry no mark
  (`LineCheck.carried`); the card says "your next steps follow correctly from this". At most 3 red
  marks per screen, with the rest collapsing into a "+n" margin dot.
- **Card**: it opens on rung 0, which is what's wrong in one sentence, without the fix. The ladder
  runs Hint → Next step → Show fix. "Show fix" unlocks after one hint or 10 s. Replies give one
  step, ≤ 60 words, and ask before telling. Worked examples use different numbers. The reading is
  shown first and is editable, and an edit rechecks in < 120 ms.
- **Voice**: push-to-talk by default (hold the mic button, or `Space` while the card is focused),
  with live partial transcripts. "Why?", "this" and "here" refer to the block under the pen or the
  last block written within 10 s, which gets a 1 px focus ring while listening.
- **AI selector**:
  - The loop auto-closes when its end comes within 24 px of the start.
  - The region glows in over 120 ms and stays lit while the card is open.
  - Chips appear ≤ 100 ms after release.
  - The card sits beside the region on the side with the most space, never over the ink, and can
    be pinned.
- **Quiet defaults**:
  - Smart mode is on and ticks are off.
  - A one-tap "Pause checking on this page" switch.
  - Exam mode: marks stay hidden until "Reveal", then animate in together.
- **Accessibility**: marks are focusable (Tab through them, Enter opens the card). A polite live
  region announces after a 2 s pause. Light and dark marks meet 3:1 contrast.

## C. Creative features in scope (chosen for value ÷ effort)

| Feature | Owner |
|---|---|
| **Live result** after a trailing "=" as ghost ink (Math Notes style), with variables carried across lines (`a=3` … `2a+1=` → 7) | math `evaluate`, engine, ui (`kind: 'result'`) |
| **Carry-forward / method marks**: steps after an error are checked relative to the wrong value | math, engine |
| **Mistake journal**: confirmed errors tagged by misconception, a "Your patterns" view, one tap to make flashcards with the existing card system | math (tags), engine, ui |
| **Same problem, new numbers**: a CAS-verified isomorphic practice box placed below, checked live | math `variant`, ui |
| **Voice "why?" while writing**, with deictic resolution | tutor, ui |
| **Explain-back check** after "Show fix": one comprehension question | tutor, ui |
| Exam mode and pause-per-page | engine, ui |

Later: inline graphing, unit checking, ghost next step in the user's own ink, photo → ink.

## D. Scope: everything a mathematics degree needs (decided 2026-10-14)

The owner requires recognition and checking for all mathematics up to a full mathematics degree.
Coverage is defined in `docs/live-ink/MATH-COVERAGE.md` and measured with the corpus in
`tests/live/corpus/`.

1. **LaTeX is the canonical format for math lines.** `LineRecognition.latex` is the source of
   truth. The math module parses LaTeX directly; `text` stays as a linear convenience for simple
   lines. Matrices, case braces, integral and sum limits, accents and similar structures exist only
   in LaTeX.
2. **The local HMER model is the primary math reader.** InkAnalyzer stays the prose reader and
   fallback. InkAnalyzer cannot represent 2-D structures (matrices, stacked limits, nested
   fractions), so degree-level coverage depends on the HMER backend.
3. **Local checking only where a step is decidable**, under the same zero-false-red rules:
   arithmetic, algebra, calculus (derivatives exactly; antiderivatives by differentiating; limits
   and definite integrals numerically, with abstention near singularities), linear algebra (matrix
   arithmetic, det, inverse, rank, eigenpairs by `Av = λv`), complex numbers, modular arithmetic and
   gcd, finite sums and series partial sums, ODE solutions by substitution, finite propositional
   logic (truth tables), and finite set identities by sampling.
4. **Proofs and anything undecidable go to the AI judge.** Examples are ε-δ arguments, induction
   steps, quantifier logic and abstract algebra. A local verdict there is 'none'. Red needs the AI
   judge plus an independent re-solve. Otherwise the verdict is amber or nothing.

## E. Owner priorities (2026-10-16): follow the notes; the tutor only on request

These override earlier sections where they differ.

1. **The first goal is following the learner's math notes:** reading the ink and checking the
   steps, quietly, while they write.
2. **On-device when sure; the better cloud model when not.**
   - Simple calculations are read and checked on this PC, instantly.
   - In Smart mode, a line goes to the cloud when this PC is not fully sure: the CAS left it
     undecided, or the reading itself is shaky (confidence < 0.9), even if the CAS found the step
     correct. A misread can hide a real mistake.
   - The escalation uses the **strong** model tier (`POLICY.smartTier`). It is slower and costs
     more per call, but it runs only on uncertain lines.
   - The cloud may correct the reading (`reading_ok` / `corrected`) as well as judge the step. A
     confident local reading stays the source of truth.
   - Local mode never calls the cloud.
3. **The tutor never runs on its own.** It opens only when the learner asks:
   - by voice: the toolbar "Ask by voice" push-to-talk button (`live/ui/VoiceAsk.tsx`);
   - with the AI selector (circle a region);
   - by right-click or long-press on their own ink.

   Nothing pops up, speaks or listens unprompted, and there is no open microphone. Marks (red,
   amber, ticks, live results) are part of following the notes, not the tutor, and stay automatic.

## F. Owner priorities (2026-10-17): the cloud model checks the formulas; complex maths first

These override §A.1–A.3 and §E.2 where they differ.

1. **The main use is complex mathematics:** integrals, derivatives, limits, series, matrices and
   the like, not only school arithmetic.
2. **Every formula is checked by the cloud model** (strong tier) in Smart mode, not only uncertain
   lines (`POLICY.cloudChecksEveryFormula`). One-line formulas are included. Plain givens
   (`a = 3`) and carried lines are skipped.
3. **For two-dimensional notation the cloud also reads.** The on-device recogniser garbles
   integrals, limits, fractions, roots and matrices, so the judge reads the image and trusts it
   over the local reading. The local reading is sent as a hint only.
4. **The on-device CAS stays the instant first pass and the veto against false reds.** A step it
   proves wrong on a confident reading stays red, but only while the cloud agrees on the reading.
   When the cloud reads a line differently, the local verdict counts for nothing (`merge.ts`).
   Cloud reds still need the independent blind re-solve.
5. **Calculus judging rules** (in the judge prompt):
   - an antiderivative is right if it differentiates back to the integrand, in any equivalent form;
   - a missing `+ C` is "unsure", never red;
   - definite integrals are judged by their exact or correctly rounded value;
   - in a substitution, `dx` and the limits must be transformed;
   - in integration by parts, check u, dv, v and the sign.
6. **Local mode** remains the offline option that sends nothing.
7. **Every level, with a big context window** (owner, 2026-10-17). Recognition and tips cover
   all of a mathematics degree. Complicated problems need context, so the cloud gets it:
   - **Checks** get the whole problem (every earlier line of the block,
     `POLICY.priorLines = 1000`) and the rest of the page as text: other parts, the problem
     statement, definitions and typed text, nearest first, up to `POLICY.contextChars` (40,000
     characters, about 10k tokens).
   - The page context comes first in the message, so the provider's prompt cache reuses it for
     every line of the page.
   - The line's cache key deliberately ignores the page context, so editing elsewhere does not
     re-send checked lines.
   - **The tutor (on request)** gets this page and its neighbouring pages
     (`POLICY.askContextChars` = 120,000 characters, `askNeighbourPages` = 1).
   - Hints stay at one step of at most 60 words. Free questions and explanations may run to about
     200 words.
