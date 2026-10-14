# Live Ink: UX and pedagogy research

Scope: research and shipped products (2024–2026 first) on real-time AI feedback for handwritten math, and the design rules that follow for goodink's live checking, insight card and AI selector. Compiled 2026-10-13.
**Verification note:** items marked (PK) come from prior knowledge and were not re-fetched in this session, because the web quota ran out partway through. Re-check them before quoting them externally.

---

## 1. Findings

### 1.1 Feedback timing and intrusiveness

- **Immediate feedback does slightly better for step-level math.** A meta-analysis of 40 studies on computer-based item feedback (Van der Kleij, Feskens & Eggen 2015, *RER*, doi 10.3102/0034654314564881) found:
  - Delayed timing lowered effect sizes.
  - Mathematics showed larger effects than other subjects.
  - *Elaborated* feedback (an explanation) was the strongest, at d≈0.49. Correct/incorrect alone was near zero (0.05), and showing the correct answer gave 0.32.
  - Source: https://acuresearchbank.acu.edu.au/item/86y84/effects-of-feedback-in-a-computer-based-learning-environment-on-students-learning-outcomes-a-meta-analysis
  - **The content of feedback matters more than its timing.** A bare red mark teaches almost nothing. The mark has to lead to an explanation.
- **Timing effects are small and depend on context.** A randomised study of 1,629 algebra students found no learning difference between immediate and delayed feedback (Smith et al., ICLS 2022, summarised at https://repository.eduhk.hk/en/publications/to-wait-or-not-to-wait-adding-to-the-debate-on-immediate-versus-d/). A 2024 study reports that delayed hints help students who game the system (cited in the LAK 2026 hint-button paper below). Takeaway: show the mark *soon after the step settles*, not mid-stroke, and let delay be configurable.
- **Interrupting mid-production is the cost to avoid.** Oviatt's pen and speech work shows that under load and during error handling, users "hyper-time" their input and fall back to entrenched patterns (https://research.monash.edu/en/publications/toward-a-theory-of-organized-multimodal-integration-patterns-duri/). Visual change during a stroke competes for the same attention. Our spec already blocks work during strokes, and the research supports keeping it that way.
- **False alarms destroy trust faster than misses do.** In automation research, false alarms reduce *compliance* (users stop acting on alerts) and misses reduce *reliance*. A high false-alarm rate makes users trust the aid less than a high miss rate does, and produces the "cry-wolf" effect (Dixon & Wickens; Wickens 2007, https://interruptions.net/literature/Wickens-HF07.pdf). Aggregate work puts the point below which an aid starts to *hurt* performance at about 70% reliability (https://mars.gmu.edu/items/f2c277ce-39bf-418d-a2dc-1f4b6cec02ee). For a red underline on a student's own work, the bar has to be far higher, because every false red tells the student they are wrong when they are not. This confirms the spec's "precision over recall".
- **LLMs are unreliable at finding the first wrong step.** ProcessBench (ACL 2025, https://arxiv.org/pdf/2412.06559) shows that even strong critic models are often wrong about the earliest erroneous step, especially on harder math. Khan Academy also admits Khanmigo misjudges whether a student is right "even when it calculates the math correctly", and now routes arithmetic to a calculator (https://blog.khanacademy.org/khanmigo-math-computation-and-tutoring-updates/). This supports the design: CAS first, AI second, and a second independent agreement before any red.

### 1.2 Hints and tutoring

- **Hint ladders work, but students abuse them.** In a Geometry Cognitive Tutor, students abused hints on 36% of actions (14% when rapid bursts count as one), clicking straight through to the bottom-out hint (https://learnlab.org/research/wiki/index.php/Help_abuse). *Help avoidance*, never asking at all, is the opposite failure. Requesting a hint immediately on difficulty predicts poorer learning (An et al., "Revisiting the Hint Button", LAK 2026, https://www.cs.cmu.edu/afs/cs.cmu.edu/Web/People/bmclaren/pubs/AnEtAl-RevisitingTheHintButton-LAK2026.pdf).
- **Unguarded AI harms learning; guardrails mostly repair it.**
  - Bastani et al. (PNAS 2025, about 1,000 high-school students, https://ideas.repec.org/a/nas/journl/v122y2025pe2422633122.html): GPT-4 access improved practice grades (+48% for the plain chat tutor, +127% for the guarded tutor).
  - After access was removed, the plain-chat group scored **17% worse** on the exam than the no-AI group.
  - The guarded "GPT Tutor" (hints, no direct answers, teacher-provided solutions) roughly neutralised that harm but did not beat the control group (https://knowledge.wharton.upenn.edu/article/without-guardrails-generative-ai-can-harm-education).
- **Untuned LLMs give away answers.** In MathDial (EMNLP Findings 2023, https://arxiv.org/pdf/2305.14536), ChatGPT acting as tutor revealed the solution 66% of the time and gave incorrect feedback 59% of the time. Scaffolding questions from a teacher-move taxonomy beat telling.
- **LearnLM (Google) treats pedagogy as instruction-following.** System instructions specify the teaching behaviour. Experts preferred LearnLM over GPT-4o by +31%, Claude 3.5 Sonnet by +11% and Gemini 1.5 Pro by +13% (https://arxiv.org/abs/2412.16429, v3 Aug 2025). Practical lesson: the pedagogy lives in the system prompt per mode ("hint only", "next step only", "show fix"). Circle to Search homework help runs on LearnLM and is positioned as "hints for solving problems step by step rather than just the final answer" (https://techcrunch.com/2024/05/14/circle-to-search-is-now-a-better-homework-helper).
- **A well-designed AI tutor can beat active learning.** Harvard physics RCT (Kestin et al., *Sci. Rep.* 2025, N=194, https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260/): learning gains about 2x those of in-class active learning, in less time. The design traits reported: one step per message, the student attempts first, short replies, and the tutor is given the correct solution up front to prevent hallucination.
- **Engagement is the binding constraint.** In a two-year Khanmigo RCT (NBER w35620, 2026, https://www.nber.org/papers/w35620), the median student messaged the tutor in only **17% of sessions where they made a mistake**, and gains were small (0.06–0.08 SD). A tutor that waits to be asked is mostly ignored. Proactive, low-friction surfacing (a mark you can tap) is the fix this points to.

### 1.3 Shipped products

| Product | What it does | Interaction model | Praise / complaints |
|---|---|---|---|
| **Apple Math Notes** (iPadOS 18+) | Write an expression ending in "=" and the result appears in your own handwriting style. Variables, graph insertion, scrub along a graph. | Fully implicit: write, then the answer appears. The result is a suggestion until accepted. Variables change colour once recognised (https://support.apple.com/en-au/guide/notes/apda85974595; https://9to5mac.com/2024/07/17/ipados-18-smart-script-math-notes-interview/). | Praised as "magic" and for zero UI. Complaints: inconsistent recognition, margins and non-paragraph layouts ignored, "doesn't always acknowledge equations", heat and battery drain (https://appleinsider.com/articles/24/09/16/ipados-18-review-making-ipad-better-for-everyone-but-the-pros; https://www.macstories.net/stories/ipados-18s-smart-script-a-promising-start-but-dont-toss-your-keyboard-out-yet/). It computes answers and does *not* check your steps. |
| **Goodnotes AI Math Assistance** | Inside Marketplace practice sessions, a wrong equation gets a **red underline**; tapping it shows what went wrong; fix in the pop-up or rewrite, and it rechecks. Lasso → Convert → Math. | Implicit underline, tap for an explanation (https://www.techradar.com/computing/software/how-to-start-taking-notes-with-goodnotes-6-on-your-ipad). | Limited to course scratch areas. The most-voted user request is to check *every handwritten calculation on every page* (https://feedback.goodnotes.com/forums/191274-customer-suggestions-for-goodnotes/suggestions/48623651-significantly-enhanced-ai-math-assistant). That request is exactly our feature. |
| **OneNote Math Assistant** | Lasso the ink → Math pane → confirm recognition, with "Fix it" on individual strokes → solve with steps by method → graph → generate a practice quiz whose distractors model common mistakes (https://support.microsoft.com/en-us/education/create-math-equations-using-ink-or-text-with-math-assistant-in-onenote). | Explicit: lasso, then a side pane. | Strong pedagogy (methods, quizzes). Heavy UI, no live checking, and some step features are Enterprise/Education only. |
| **Samsung Notes Math Solver** (One UI 8) | Turn it on in the menu; write a problem ending in "=" and the answer appears in your pen colour and style, movable and editable (https://www.samsung.com/in/support/mobile-devices/how-to-use-maths-solver-feature-in-notes-on-galaxy-devices/). | Implicit, like Apple. Separately, Circle to Search: hold the nav handle, circle the problem, get a pop-up with steps. | Accuracy depends on handwriting. Must be written linearly. Limited scope. |
| **Circle to Search homework help** | Circle anything on screen and get guided steps (LearnLM). | Long-press the system handle, then a freehand loop; the region stays highlighted while the result appears in a bottom sheet. | Praised for its "no context switch" lasso, so the gesture *is* the query. Positioned as help, not answers. Requires opting in to Labs at launch. |
| **Gemini in Classroom / Guided Learning** | Guided Learning explanations, practice quizzes, flashcards and study guides from class materials, with context-aware starter prompts; all ages since Aug 2026 (https://workspaceupdates.googleblog.com/2026/08/gemini-in-google-classroom-is-expanding-to-users-of-all-ages-with-contextualized-Gemini-starter-prompts-for-students.html). | Chat side panel. | Not ink-native. |
| **Photomath** (PK) | Camera → animated step-by-step solution, with multiple methods. | Photo, crop, then steps. | Loved as an answer engine. Teachers see it as a cheating tool. No checking of your own work. |
| **MyScript Calculator / Nebo** (PK) | Write and the result appears live. Scratch-out to erase. Nebo math blocks convert and solve. | Implicit, gesture-rich (scratch-out, strike-through). | Best-in-class recognition and gestures. Computes, does not tutor. |

**Patterns to steal:**
1. From Apple and Samsung: **results rendered in the user's own ink style** and anchored where the pen is.
2. From Goodnotes: **underline, then tap for why, then fix in place and recheck**.
3. From OneNote: **"confirm what I read" with stroke-level fixes**, and **quizzes with mistake-aware distractors**.
4. From Circle to Search: **the loop gesture is the query**, the region stays lit, and the answer sits next to it without leaving the page.

### 1.4 Hackathon reference

- **Somo** (AI Engineer NYC hackathon, MLH, 11 Oct 2026; https://dev.to/colinje01/i-built-a-tutor-that-circles-your-math-mistake-in-red-pen-3ffi). Features:
  - Input is a photo of the working.
  - Gemini Flash returns schema-validated JSON (transcription, concept, first wrong line, why).
  - **The first wrong line is circled in red.** The UI looks like an exercise book (grid, red margin, handwriting font for teacher notes).
  - A "Here's what I read" confirm or correct step.
  - A streamed lesson: idea, error, everyday analogy, worked example with *different numbers*, exam vocabulary. Available in English, Swahili and Spanish.
  - One check question. A wrong answer gets a simpler re-explanation; a right answer unlocks a real past-paper question found by web search and labelled by provenance.
  - A blind second solve; if it disagrees, the app says "I'm not fully sure I read this right."
  - Gemma grades answer equivalence.
  - Failover Gemini → Claude with a 60 s circuit breaker. Diagnosis takes about 10 s.
  - Admitted limits: no real users, three test problems, and the second-solve check cannot catch shared misreadings.
- **EduNova** (Gemini Live Agent Challenge entry, https://dev.to/sumit231292/edunova-building-a-real-time-ai-tutor-that-sees-speaks-with-gemini-live-api-4im3):
  - Voice-first tutor on Gemini 2.5 Flash native audio; points the camera at homework.
  - Supports barge-in. Socratic "guide first, answer second". Supports 20+ languages.
  - No mistake marking. A whiteboard is only planned.
- **Winners checked:** the Gemini Live Agent Challenge winners (https://cloud.google.com/blog/topics/developers-practitioners/winners-and-highlights-of-the-gemini-live-agent-challenge) include no tutor; the grand prize went to ORION, a surgical copilot. In the Gemini 3 Hackathon (Devpost), top places went to non-education projects. The honorable mentions "Logic Lift" and "Proofy.AI" could not be verified (the page returned 403).
- **Conclusion:** no published winner does *live, in-ink, symbol-level* checking. The bar is Somo's pipeline quality plus EduNova's voice.

### 1.5 Voice and pen together

- Oviatt's findings:
  - Pen and speech carry *complementary* information.
  - The pen usually leads.
  - Each user is stably either a *simultaneous* or a *sequential* integrator (95–96% consistent), and the pattern can be identified at first use (https://chi1997.acm.org/proceedings/paper/slo.html; Monash link above).
  - Children integrate more simultaneously, with shorter lags.
  - Implication: let users speak *while* writing, and use the pen position or most recent block as the referent for "this" or "why?".
  - Use an adaptive fusion window rather than a fixed one: start at about 1.5–2 s after pen-up, then adapt.
- **Latency:**
  - Human turn gaps cluster around 200–250 ms (Stivers et al., PNAS).
  - Voice-AI practice treats under 800 ms to first audio as natural and over 1.5 s as broken. These are vendor heuristics, not controlled research (https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms).
  - Endpointing with a model takes 200–400 ms, against 800 ms or more for a naive silence threshold. p95 matters more than the median.
- **Push-to-talk versus an open mic.** For a note-taking app (lectures, shared rooms, privacy), use **push-to-talk or hold-to-talk by default**. An open mic is acceptable only inside an explicit "conversation" session, with a visible level meter and barge-in (EduNova shows barge-in is expected).

### 1.6 Accessibility and cognitive load

- **WCAG 1.4.1, use of colour** (https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html): red versus green alone is not enough, since about 8% of men have red-green colour vision deficiency. Marks need a *shape* code: wavy = wrong, dotted = unsure, tick = verified.
- **WCAG 1.4.11, non-text contrast** of at least 3:1 against the page, in both themes (https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
- **WCAG 2.3.3, animation from interactions**: honour `prefers-reduced-motion`.
- Marks and cards must be reachable by keyboard and announced to screen readers through a live region, politely, never assertively while writing.
- **Cognitive load:** a red mark over the ink adds extraneous load. Keep a single mark per error, mark only the *first* error in a chain (later steps that follow from it are "consequential"), and move explanations behind a tap (progressive disclosure).

---

## 2. Design rules

1. **Never draw during a stroke.** Evaluate only after the block settles: 600 ms after the last pen-up (as in the spec). Render the mark at settle + verdict, with a **minimum 900 ms** from pen-up to red so it never feels like the app is "watching the pen". If the pen comes down again in the same block before the verdict, cancel and wait.
2. **Delay red further while the user is still writing nearby.** If the pen is active within about 2 line-heights of the wrong step, hold the red mark until a 1.5 s pause or until the pen moves to a new line. Amber and green ticks can appear at the normal settle time.
3. **Red is reserved for proven errors.** Set the gate at at least 98% precision on our test corpus, and track it as a release metric. Everything else is amber dotted or nothing. If a user marks a red as "I'm right" twice in a session, show red only after a second confirmation for the rest of that session (protecting trust).
4. **Mark the first error only**, under the exact wrong symbols. Later steps that follow correctly from the wrong value get *no* mark, plus a subtle "carried" badge in the card ("your next steps follow correctly from this").
5. **Visual intensity:**
   - **Red:** wavy, 1.5 px at 100% zoom, scaled with zoom; colour about #E5484D light / #FF6369 dark; at least 3:1 contrast; 70% opacity.
   - **Amber:** dotted at 55% opacity.
   - **Green:** a tick of at most 10 px, at 40% opacity, which fades to 0 after 4 s unless "show ticks" is on.
   - **Animation:** draw-in over 250 ms, ease-out, once. No pulsing and no sound. Static when reduced motion is on.
6. **Shape encodes meaning, not just colour:** wavy = wrong, dotted = unsure, tick = verified. The card always says the verdict in words.
7. **The card opens on hint 0.** First show *what's wrong in one sentence, without the fix*. The ladder runs: Hint (conceptual question) → Next step (structure only) → Show fix (bottom-out). Each rung needs an explicit tap. Show fix is enabled only after at least one hint was viewed or 10 s have passed (this slows click-through gaming). Default mode is Socratic. Remember the last rung used per user to adapt.
8. **Pedagogy is in the prompt.**
   - One step per reply, at most about 60 words.
   - Ask before telling.
   - Never state the final answer unless "Show fix" was pressed.
   - Ground on the CAS solution (as in the Kestin tutor) so the model cannot hallucinate the maths.
   - Worked examples use *different numbers* (as Somo does).
9. **Make the reading visible and correctable.** The card always shows the KaTeX reading first. Editing it rechecks within 120 ms locally. If the reading is low-confidence, show amber with "I may have misread this", never red.
10. **Voice is push-to-talk by default:** hold the mic button, or press and hold the pen barrel plus `Space`. Show partial transcripts as you speak. Target **first token at most 800 ms, first spoken audio at most 1.2 s at p50, at most 2.5 s at p95** after the end of speech. Barge-in stops output within 200 ms.
11. **Resolve deictic references.** "Why?", "this" and "here" refer to the block under the pen or the last-written block within 10 s. Show a 1 px focus ring on that block while listening.
12. **AI selector:** the loop closes automatically when the end comes within 24 px of the start. The region glow is 120 ms in and stays lit while the card is open. Chips appear at most 100 ms after the loop closes. The card is anchored beside the region (never over the ink), on the side with the most free space, and is pinnable.
13. **Progressive disclosure and quiet defaults.**
    - Defaults: live checking on in Smart mode; green ticks off; at most 3 red marks visible per screen. Further marks collapse into a margin dot showing "+2".
    - A one-tap "Pause checking for this page" switch (exam or creative mode).
14. **Accessibility:**
    - Every mark is a focusable element (Tab/Shift+Tab through marks; Enter opens the card).
    - Polite ARIA announcement only after writing pauses for 2 s.
    - Text scales with the system scale.
    - The card is fully operable by keyboard and voice.
15. **Erase means gone.** Editing or erasing removes marks within one frame. A fixed step gets a brief 600 ms green fade-in of the tick so the correction feels rewarded. This is the only celebratory animation.

---

## 3. Feature gap: goodink (planned) vs others

| Capability | goodink (spec) | Apple Math Notes | Goodnotes | OneNote | Samsung Notes / CtS | Photomath | MyScript/Nebo | Somo | EduNova |
|---|---|---|---|---|---|---|---|---|---|
| Live while writing | **Yes** | Yes (answers) | Practice area only | No | Yes (answers) | No | Yes (answers) | No (photo) | No (camera) |
| Checks *your* steps | **Every step, every page** | No | Yes, limited | No | No | No | No | First wrong line | Verbal only |
| Mark granularity | **Wrong symbols** | – | Line | – | – | – | – | Line circle | None |
| Precision gate | **CAS or 2-model agreement** | – | Unknown | – | – | – | – | Blind 2nd solve, hedge | None |
| Fix reading in place | **Yes, KaTeX edit** | No | Pop-up edit | Fix it on strokes | No | Crop | Yes | Confirm screen | No |
| Hint ladder | **3 rungs, gated** | No | Hints in courses | Methods | Steps | Steps | No | Lesson + 1 check | Socratic voice |
| Voice | **PTT + streaming** | No | No | No | No | No | No | No | Yes, native audio |
| Lasso and ask anything | **AI selector** | No | Lasso convert | Lasso → pane | Circle to Search | Crop | Select | No | No |
| Offline | **Local mode** | Yes | ? | Partial | Partial | No | Yes | No | No |
| Latency | **under 120 ms local, about 2.5 s AI** | Instant | Fast | Fast | Instant | ~2 s | Instant | ~10 s | Conversational |
| Practice generation | Planned (below) | No | Courses | **Quiz with error distractors** | No | No | No | Past-paper search | Yes |
| Multilingual | Via LLM | Yes | Yes | Yes | Yes | Yes | Yes | EN/SW/ES | 20+ |

**Gaps we still have to close:** practice generation (OneNote and Somo have it), provenance-labelled real exam questions (Somo), and bilingual key terms (Somo).

---

## 4. Creative features (value / effort, each 1–5)

1. **Ghost next step** (5/3): after a verified line, a 20%-opacity ghost of the *structure* of the next step (for example `x = □`) appears on a long pause (over 8 s idle) or on request. Tapping it reveals one rung. Gives momentum without giving the answer away.
2. **Confidence-aware marks** (4/2): amber opacity scales with confidence, and hovering shows "70% sure: I read 5 as S?". Makes uncertainty honest.
3. **Misconception tracker → flashcards** (5/3): each confirmed error is tagged with a misconception (sign flip on moving terms, distributing over a square, and so on). A notebook-level "Your patterns" panel feeds auto-generated spaced-repetition cards and **OneNote-style quizzes whose distractors are *your* past mistakes**.
4. **Voice "why?" while writing** (5/2): hold the barrel and say "why?" or "is this right?". The answer refers to the block under the pen, with a short spoken reply (at most 2 sentences) and the card shown silently.
5. **Same problem, new numbers** (5/2): one tap generates an isomorphic problem, verified by the CAS, placed below as a practice box that is checked live. Beats Somo's web search on speed and determinism.
6. **Teacher margin notes** (4/2): explanations can be "pinned to margin" in a handwriting-style font, in the red-pen style of Somo's exercise book. They export with the PDF.
7. **Carry-forward awareness** (4/3): after an early error, later steps are checked *relative to the wrong value*, with "method marks: your algebra after line 2 is correct". This is how real teachers grade, and no product does it.
8. **Exam mode** (3/1): checking hidden until "Reveal", then all marks animate in at once, for self-testing (delayed feedback for higher-order practice and for students who game hints).
9. **Scrub variables** (3/3): Apple-style dragging of a number to see dependent lines and graphs update, with live re-checking.
10. **Explain-back check** (4/2): after "Show fix", a single comprehension question, as in Somo, asked by voice or with the pen. Bastani's results suggest this kind of active retrieval is what protects learning.
11. **Session recap** (3/2): when a notebook closes, "3 steps checked, 1 fixed, 1 pattern: sign errors", with a link to the practice set.

---

## Sources found but not read

- Penquiry, a pen-based in-situ LLM Q&A system (CHI '26?): https://arxiv.org/pdf/2609.19870
- AmIWrite, handwriting-based LLM math tutoring: https://ouci.dntb.gov.ua/en/works/lRrpePgj/
- Colliot et al. 2024, real-time feedback on tablets (BJET): https://bera-journals.onlinelibrary.wiley.com/doi/full/10.1111/bjet.13439

These are the closest academic analogues to our feature. Read them before the UI is finalised.
