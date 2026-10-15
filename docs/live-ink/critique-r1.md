# Live Ink Intelligence: critic round 1

Critic: independent design/UX review (bar: "Apple would ship this unchanged" = 10/10).
Date: 2026-10-14. Build: debug exe + Vite dev server, current working tree.

## Evidence

- **Builder shots**: I reviewed all 126 `tests/shots/ui-*.png` files. The `-dark` and `-small`
  variants of 01–15 and 20–27 date from 2026-10-13, so they predate the current UI. Shots 01–54 use
  the scripted fake engine, so their *placement* is evidence and their *verdicts* are not.
- **My own real-engine runs** (`tests/live/critic-r1-*.mjs`, run one at a time). Screenshots use the
  `tests/shots/critic-r1-*` prefix.

  | Scenario | What it covers |
  |---|---|
  | `critic-r1-a` | Correct work, a wrong last step, a wrong middle step, live results, red hold timing |
  | `critic-r1-b` | The insight card with the pen tool, no-AI states, edit reading, Esc, undo and rewrite. Rerun at 760×520 in dark with `W=760 H=520 DARK=1 X=380 Y=150 SFX=-small-dark` |
  | `critic-r1-d` | Smart mode against `mock-ai.mjs`: ask before any hint, the AI selector, Solve, pin |
  | `critic-r1-e` | Erase, then frames until the red mark is gone |
  | `critic-r1-f` | The engine's own reading of the "results" and "a=3" blocks |
  | `critic-r1-crash` | Process liveness while the engine settles |

- **`tests/live/critic-drive.mjs`** is a copy of `drive-tauri.mjs` that keeps the exe's
  stdout/stderr and its exit code. It is how the crash below was caught.
- **Zoomed crops** (5–6×): `critic-r1-a3z-false-red.png`, `critic-r1-a4z-plus-badge.png` and
  `critic-r1-b2z-wave-x6.png`.

### What the real engine gets right

These are measured, not taken from the builder's claims:

- **No false reds on correct work.** `2x+3=7 / 2x=4 / x=2` got two ticks and no red.
- **Red lands on the right line and symbol** (`x=3`, under the `3`):
  - It appears 1,492 ms after the last pen-up, which meets the ≥ 900 ms rule.
  - The middle-step case also works: `3x-5=10 / 3x=5 / x=5/3` gives red under `5` on line 2,
    titled "Sign error", and the carried line 3 has no mark.
- **Red hold works.** While the pen kept writing on the same line, red waited until 1.49 s after the
  last nearby pen-up (3,697 ms in total).
- **Erasing clears the mark in one frame** (9 ms).
- **The card opens in 92 ms**, takes focus, and Esc returns focus to the canvas.
- **Show fix is gated**: it is disabled with the title "Try a hint first" and unlocks after one
  hint.
- **The local hint works offline**: "Substitute your value back into the line before…".
- **AI selector chips appear 60 ms after release** (budget ≤ 100 ms).
- **The tutor prompt carries the "never state the final answer" guard**, and the CAS-verified step
  is passed as hidden grounding.

That core loop is genuinely good. Almost everything below is about trust, reach and finish.

---

## P0: broken or wrong (ship blockers)

### P0-1. The app crashes natively about 40% of the time on the first problem

- **Evidence**: `critic-r1-crash.mjs` and every other scenario.
- **What happens**:
  - Across 16 fresh launches, the process died 7 times, 250–450 ms after the first three lines were
    written (that is, at the first settle and recognition).
  - Exit codes were `0xC0000374` (heap corruption) and `0xC0000005` (access violation).
  - There was no console error. The window simply vanishes and the student loses their unsaved
    page.
  - The builder's runs hit the same thing: it is why `ui-01` and earlier scenarios occasionally
    "fail".
- **Probable site**: `ink_analyze`, `src-tauri/src/ink.rs`, roughly lines 93–220. Several
  `spawn_blocking` workers each lazily create a WinRT `InkAnalyzer` in an MTA apartment, and the
  first burst of blocks hits them concurrently.
  - `hmer.rs` is not referenced from `live/`, so it is not on this path.
- **Fix**:
  1. Run *one* analyzer thread (an STA with `CoInitializeEx(COINIT_APARTMENTTHREADED)`) and
     serialise jobs through a single channel. Measure first: parallelism buys nothing at
     15–40 ms per block.
  2. Construct the analyzer once at startup, not on first use.
  3. Wrap each call in `catch_unwind` and return an error string, never abort.
  4. Add `critic-r1-crash.mjs` × 20 launches as a release gate with 0 exits.

### P0-2. False red on correct work: a variable definition `a=3` is marked "Arithmetic slip"

- **Evidence**: `critic-r1-a3-overview.png` and the crop `critic-r1-a3z-false-red.png`.
  - `critic-r1-f` dump: `"0=3 [math 0.98] alts=a=3|9=3|6=3"` → `error/local-cas: Arithmetic slip`.
- **Cause**: the recogniser reads the handwritten `a` as `0` with confidence 0.98. "0=3" is false,
  so the CAS proves it wrong on the top reading. The gate let it through even though `a=3` is in
  the alternates.
- **Why it is P0**: this violates the #1 non-negotiable (every reading with p ≥ 0.1 must fail). The
  alternates either carry p < 0.1 (miscalibrated) or are ignored. A 0.98 on a letter/digit
  confusion is not credible calibration.
- **Fix**:
  1. **Letter↔digit confusables cap line confidence at 0.85.** The confusable pairs are a/0/9/6,
     l/1, o/0, S/5, z/2, b/6, g/9 and q/9. Any line whose top-3 differ only in such a pair gets its
     confidence capped at 0.85, so it can never be red, only amber or nothing.
  2. **A single-line statement with no premise is never red** (a block's first line, or a lone
     `x=3`). That is a definition or a given, not a step.
  3. **Add this exact case** (`a=3` handwritten, seeds 42 and 43 of `handwriting.mjs`) to the
     red-precision corpus.

### P0-3. The "+n" badge is drawn on top of correct ink, in the wrong problem

- **Evidence**: `critic-r1-a4-card-pen.png` and the crop `critic-r1-a4z-plus-badge.png`.
- **What happens**:
  - With four reds on the page, a solid red "+1" disc landed *on the `=` of the correct `x=2`* of
    problem 1.
  - The hidden mark belongs to problem 2, 370 px to the right. A student reads this as "your
    correct answer is wrong".
  - The cause is in `markGate.ts`: x is the minimum `bbox[0]` over **all** reds on the page minus
    0.6 line-height, and y is the hidden mark's line.
  - Also, the hidden red was the **topmost, oldest** error, while three newer ones stayed visible.
    The first error on the page should never be the one collapsed.
- **Fix**:
  1. Place the dot in the hidden mark's **own block**: `block.bbox[0] − 14 px`, vertically
     centred on that line.
  2. Never place it within 6 px of any stroke bbox. If it would collide, move it up a line-height
     and nudge it left.
  3. Make it an outline badge: 16 px, 1.5 px `#E5484D` ring, 11 px/600 text in `#C2373C` on the
     page colour. Do not use a solid red disc: a solid disc is a notification, not a margin note.
  4. Decide which reds show by *screen* (the spec says "per screen", the code does it per page) and
     by reading order (top to bottom). The most recent writing must not hide the first error.

### P0-4. "Edit reading" lets a student turn a wrong answer green, with the celebration

- **Evidence**: `critic-r1-b9-edited.png` and `critic-r1-b9b-edited-page.png`.
- **What happens**:
  - The ink says `x=3`. I opened "Edit reading", typed `x=2` and pressed Enter.
  - The card flips to "✓ Correct / Every step checks out", the red disappears, and the one-off
    green "fixed" tick plays (`is-fixed` fired 9 ms later).
  - The page still says `x=3`.
- **Why it matters**:
  - It is a two-keystroke way to game every mark.
  - It teaches that the answer is whatever you type.
  - It pollutes the journal: the mistake is recorded as fixed.
- **Fix**: an edited reading may only change symbols the recogniser was *unsure* of. For each
  edited token:
  1. **When the edit is plausible.** The new symbol is among that token's alternates with
     p ≥ 0.05, or it is in the confusable table above. Accept the edit and recheck.
  2. **When the edit is not plausible.** Keep the verdict and show inline, in 12 px muted text,
     "That's not what's on the page; rewrite it in ink to fix it." Do not recheck.
  3. **No celebration from an edit.** The fixed tick only fires on new ink.
  4. **Label the outcome.** Results that came from an edit are labelled "Checked against your
     correction" and use amber, not green.

### P0-5. Live results after "=" do not appear on the real engine for ordinary handwriting

- **Evidence**:
  - `critic-r1-a3-overview.png`: neither `12+5=` nor `2a+1=` gets a result.
  - Same in the builder's `ui-60-real-marks.png`.
  - `critic-r1-f` dump: `"12+5 [math 0.90] alts=12+5=|124=|1245="`. The trailing `=` is dropped
    from the top reading, so `evaluate` never fires.
  - `7×8=` does get `56`.
  - The CAS itself is fine: `evaluate(['12+5='])` gives 17 in isolation.
- **Why it matters**: Math Notes' entire magic is this feature, and in practice it fails on the
  first example anyone will write.
- **Fix**:
  1. A geometric "=" detector: two near-parallel horizontal strokes, length ratio 0.7–1.4, vertical
     gap 0.15–0.6 line-height, at the right end of the line.
  2. If the detector fires, force the trailing `=` onto the top reading.
  3. Otherwise, evaluate when any alternate with p ≥ 0.2 ends in `=` and the ink geometry agrees.
  4. Add `12+5=`, `3+4=` and `100-1=` in 5 seeds each to `recog-eval`, with a ≥ 95% result rate as
     a gate.

### P0-6. Exam mode shows a live count of mistakes in the toolbar

- **Evidence**: `ui-48-exam-popover.png` and `ui-49-exam-hidden.png` show "Exam ❻". The code is
  `StatusPill.tsx:61`.
- **What happens**: during an exam, the moment a wrong line settles the badge goes from 0 to 1, so
  the student gets instant right/wrong feedback, which is exactly what exam mode exists to remove.
  The popover also says "Reveal 6 marks".
- **Fix**:
  1. In exam mode the pill shows only "Exam", in muted text with no number.
  2. Reveal reads "Reveal marks".
  3. The count appears only *after* Reveal, inside the popover: "6 marks revealed".

### P0-7. The demo-path screenshot itself is wrong (lead's catch, verified)

- **Evidence**: `ui-05-card.png`, `ui-01-marks.png`, `ui-02/03/04`, `ui-06-card-crop.png`. All of
  these are fake engine, but they are the hero shots.
- **What is wrong**:
  1. The red squiggle is under the `4` of line 2 (`2x=4`, which is correct) while the card says
     line 3 `x=3` is the mistake.
     - Cause: the harness's stray 200 px diagonal stroke (from 2x+3=7 up to the top right) joins
       line 1's block and shifts the fake engine's line indices.
     - Fix the harness: lift the mouse before `openNotebook` returns, and assert
       `pageStrokes().length === 0` before writing.
     - Fix the product too: the card's highlighted line must be derived from the *same* decoration
       id the user clicked. Today they can disagree.
  2. **"I READ" shows a fourth, greyed `x = 2` at rung 0, which leaks the answer.** Rung 0 must list
     only lines that exist in ink. The CAS solution may appear only after "Show fix", and then
     labelled "Fix".
  3. **"✓ Your next steps follow correctly from this" appears when the error is the last line.**
     Show it only when `carried.length > 0`, and name the lines: "Line 4 follows correctly from
     this."
  4. **The fix rung says "Your next line x=2 is then right"** (`ui-08`) when there is no next line.
     Same rule as above.
  5. **The stray diagonal stroke is in every hero shot.** Retake them all.

---

## P1: clearly not AAA

### P1-1. The red wave is too faint, too small, and collides with the ink

- **Evidence**: `critic-r1-b2z-wave-x6.png` and `critic-r1-b1-marks-small-dark.png`.
- **What is wrong**:
  - **It touches the glyph.** The wave's top is at y = 495 and the ink bottom of `3` is at 496, so
    it hits the tail of the 3.
  - **It is too small to read as a squiggle.** It is 17 px long at 160% and only 12.7 px at 116%,
    with fewer than two crests. It reads as a pink smudge.
  - **It fails contrast.** At 70% opacity, #E5484D on white composites to #ED7F82, which is
    **2.6:1**. That fails the doc's own ≥ 3:1 rule (WCAG 1.4.11). The spec numbers contradict each
    other, so the contrast rule must win.
- **Fix**:
  1. **Offset**: baseline + max(3 px, 0.12 × lineH) below the lowest ink point *of the marked
     tokens*, not the line.
  2. **Length**: token width + 3 px on each side, minimum max(14 px, 0.8 × lineH).
  3. **Shape**: amplitude 1.75 px × zoom (clamp 1.5–3.5), wavelength 6 px × zoom (≥ 3 full
     periods).
  4. **Colour**: opacity 1.0 with #E5484D (3.9:1) in light; on dark paper #FF6369 is fine at
     100%.
  5. **Animation**: keep the 250 ms draw-in.

### P1-2. Amber dots and ticks are effectively invisible (contrast 1.5–1.7:1)

- **Evidence**: `ui-41-kinds.png`, `ui-43-unsure-tip.png`, `ui-20-before.png`.
- **What is wrong**:
  - **Amber**: #D38C00 × 0.55 × confidence (down to 0.3 effective) is **1.7:1 at best**.
  - **Ticks**: #2C9D5F at 0.4 is about 1.5:1.
  - "Shape carries meaning" only works if you can see the shape.
- **Fix**:
  - **Amber**: #B26B00 at a fixed 0.9 opacity (3.6:1). Encode confidence by dot *spacing* (gap
    2.4 → 3.6 × width), not by opacity.
  - **Tick**: #1E8A50 at 0.7 while visible, still ≤ 10 px and still fading after 4 s.

### P1-3. The insight card goes off-screen at the minimum window size, and its primary action is hidden

- **Evidence**: `critic-r1-b4-card-small-dark.png` (760×520) and `ui-05-card-small.png`.
- **What is wrong**:
  - The card's top is at 160 and its height is 392, so it **ends at 552, 32 px below the window**.
  - The Ask field is cut off.
  - At rung 0 the **Hint button is not visible at all**: the scroll body shows reading and issue,
    and the footer eats the rest.
- **Cause**: `anchor.ts` clamps with the height measured before content fills in, and never
  re-places.
- **Fix**:
  1. Re-run placement from a `ResizeObserver` on `.live-card`.
  2. `max-height: calc(100vh − top − 12px)`.
  3. Pin the ladder row (Hint · Show fix) to the bottom *above* the tools row, so it is never
     scrolled away.
  4. At heights below 600 px, collapse the tools row (Copy LaTeX / To text / New numbers) into one
     28 px "⋯" button.

### P1-4. The card is too big and busy for one wrong digit

- **Evidence**: `critic-r1-b5-card-crop.png`. The card is 360 × 442 px for a 3-line problem.
- **What is wrong**:
  - **Utility actions compete with the tutoring.** The footer has three utilities (Copy LaTeX, To
    text, New numbers), a separate "Set up free AI" link, an Ask field and a mic, all at the same
    visual weight as the ladder.
  - **The reading takes too much room.** The read-back of all three lines is 126 px tall for two
    lines that are not in question.
  - Apple would show one sentence and one button.
- **Fix**:
  1. **Rung 0 layout**:
     - The marked line in KaTeX at 17 px.
     - Then the issue title (15/20 semibold), one sentence (13/18), and Hint as the primary.
  2. **Context lines**: collapse earlier lines into a single 12 px muted "after 2x = 4" context
     line, with "Edit reading" as a 12 px link on the marked line.
  3. **Utilities**: move them into a "⋯" menu in the header.
  4. **Target size**: ≤ 260 px tall at rung 0.

### P1-5. The Ask field and "Solve step by step" bypass the hint ladder

- **Evidence**: `critic-r1-d` (prompts captured by the mock); `ui-25-answer.png`; `ui-27`.
- **What is wrong**:
  1. **The guard has an escape hatch any student can trigger.** In the card, before any hint, I
     asked "just tell me the answer". The prompt does include the guard, but the guard says
     "unless … the learner explicitly asks to solve", and the hidden CAS step `x = 2` is in the
     context. Ten words defeat the ladder.
  2. **The AI selector offers "Solve step by step" over work that has a red mark.** Its prompt is
     literally "solve it … and state the final answer".
  3. **The builder's own "Explain" answer states "it should be x = 2"** (`ui-25`) while the Show
     fix rung is still locked in the card.
- **Fix**:
  1. **Ask follows the ladder state.** Before Show fix is unlocked, the tutor prompt omits the
     verified step entirely and drops the "explicitly asks" exception. Requests for the answer
     get: "Try the hint first. Show fix unlocks in N s."
  2. **The selector routes to the card.** When the region contains a red or amber mark, replace
     "Solve step by step" with "Help with my mistake", which opens the insight card at rung 0.
     Keep Solve only for regions without the student's own wrong work.
  3. **Fix the explain prompt.** It must not state corrected values (the same guard as the
     hints).

### P1-6. The no-AI path shows broken messaging and drops the question

- **Evidence**: `critic-r1-b7-ask-noai.png`.
- **What is wrong**:
  - In Local mode with no key, typing a question and pressing Enter silently drops it. Instead, a
    big "Free AI with Google Gemini" panel appears inside the tutoring card, saying **"Already set
    up: Gemini Flash (newest) with medium effort"**, which is false.
  - It includes an API-key password field (the console warns "Password field is not contained in
    a form") and a privacy disclaimer.
- **Fix**:
  1. **Keep the question.** Leave it in the field, greyed.
  2. **Explain in one line**: "Asking needs AI. Hints and checks work offline." with a single
     "Set up free AI (1 min)" button that opens Settings → AI in a sheet.
  3. **Remove "Already set up"** unless a key actually exists.
  4. **Never put a credential field inside a floating card on the canvas.**

### P1-7. The status pill shows developer telemetry, and it collapses badly at small widths

- **Evidence**: `ui-01`, `ui-15`, `critic-r1-a3-overview.png`, `ui-01-marks-small.png`,
  `ui-23-popover-small.png`.
- **What is wrong**:
  - The toolbar shows "Smart | 262 ms" in mono, and the popover shows "38 ms last check · 461
    tokens this session". Students don't care, and it reads as a debug build.
  - At 760 px the pill degrades to a bare 12 px dot, half clipped at the right edge (x = 730–760),
    and the right-hand toolbar items are gone.
  - The popover is 716–765 px tall with no `max-height`, so at 520 px it overflows by about
    250 px.
- **Fix**:
  1. **Pill content**: mode name plus a 6 px state dot. No latency or tokens.
  2. **Telemetry location**: move them to Settings → AI → "Usage". Keep latency in the `title`
     tooltip only.
  3. **Small widths**: below 900 px, fold the pill into the "⋯" overflow menu with the same
     popover.
  4. **Popover height**: `.live-pop { max-height: calc(100vh − 72px); overflow: auto }`, with Exam
     and Pause pinned at the top.

### P1-8. The mark tooltip is mouse-only copy on a pen-first app, and it can cover ink

- **Evidence**: `ui-03-tip.png` (left edge clipped, sitting over line 3) and
  `critic-r1-b3-tip.png`.
- **What is wrong**: "Right-click for details" is wrong for pen and touch users.
- **Fix**:
  1. **Copy by input type**: "Tap and hold for details" for pen/touch hover, "Right-click or Enter"
     for mouse.
  2. **Placement**: place the tip *below the wave*, offset 8 px. If that intersects ink, place it
     to the right of the line end + 12 px.
  3. **Bounds**: keep it inside the page's visible rect with 8 px of padding.

### P1-9. Smart mode spent two cloud calls on a step the CAS had already proved locally

- **Evidence**: `critic-r1-d`: `["verify","check"]` for `x=3`, which Local mode proves with the
  CAS. The card then says "Checked by AI", not "Checked on this PC".
- **What is wrong**: this burns the "about $0.0002, mostly free" promise and adds about 1 s of
  latency.
- **Fix**: if `local-cas` has an error that passes the red gate, Smart sends nothing. If the
  synthetic ink's line confidence is the reason it escalated, that is the calibration bug from
  P0-2 again.

### P1-10. The AI selector region does not stay lit while the card is open after pinning

- **Evidence**: `critic-r1-d6-pinned.png` and `ui-27-pinned-moved.png`.
- **What is wrong**:
  - After pinning (and on Esc), the glow and dim disappear while the card stays, so the card no
    longer shows what it is about.
  - The pin button's pinned state shows a "pin-off" glyph inside a focus ring, which reads as "not
    pinned".
- **Fix**:
  1. **Glow while the card exists**: keep a 1.5 px gradient outline at 60% around the region for as
     long as its card exists. Drop the page dim when pinned.
  2. **Pin button**: a filled pin with `aria-pressed=true` and the tooltip "Unpin".
  3. **Title**: the card title stays "About this selection". Don't switch to a bare "AI".

### P1-11. Push-to-talk does not meet the spec

- **Evidence**: `ui-31`–`ui-33`.
- **What is wrong**:
  - There are no live partial transcripts while recording; you only see "Listening… release to"
    (truncated).
  - The level meter is a **red dotted line with a red cursor**, which is the visual grammar of an
    error or amber mark, inside the same card.
- **Fix**:
  1. **Partial transcripts**: show them in the field at 60% opacity, updated at least every
     300 ms.
  2. **Placeholder**: "Listening… release to send", with a min-width so it never truncates.
  3. **Meter**: a 5-bar meter in `--c-accent` (bars 3 px wide, 2 px gap, height mapped from RMS).
     Never red or dotted.

### P1-12. Patterns: wrong tags and duplicates

- **Evidence**: `ui-53-patterns.png`.
- **What is wrong**:
  - "Dividing only one side ×7" is the wrong misconception for `2x=4 → x=3` (that is a division
    slip).
  - The ×7 is the *same* mistake counted seven times, and it becomes seven identical flashcards
    (`ui-54`: "7 flashcards added").
- **Fix**:
  1. Deduplicate by (lineId, misconception).
  2. "Make flashcards" creates one card per distinct example, at most 5.
  3. The real-engine tag ("Arithmetic slip", `ui-63`) is right; align the fake engine or remove
     it.

---

## P2: polish

### Colour and type

1. **Primary colours are inconsistent.** The ladder's primary is slate #2F5B8A (white text), while
   the app's primary elsewhere ("Add page", toasts) is near-black. Pick one. For Live Ink, use the
   app accent and keep red for marks only.
2. **KaTeX weight in dark mode** renders bold inline (`ui-06-card-crop-dark`,
   `critic-r1-b4-card-small-dark`) while light is regular. Set `.katex { font-weight: 400 }` in
   card text.
3. **The ghost result does not match the user's ink.** It is a light grey Segoe-Print-like ghost at
   42% (about 2.9:1). Use the user's pen colour at 55% (≥ 3:1), and draw it with the stroke width
   of the line's median stroke, so it looks like ink rather than a font (Apple's bar).
4. **The `live-tool` buttons use 12.5 px type.** That is off-scale: the type ramp is 11/13/15. Use
   13 px.
5. **The card head is 48 px tall with 8/8/4/12 padding**, which is off the 4 px grid on the left.
   Use 12/12/8/16.

### Interaction details

6. **"Show fix" disabled state has no affordance.** Add a 12 px lock glyph and a 10 s ring timer
   around it. The tooltip-only "Try a hint first" is invisible to pen users.
7. **The ladder progress dots** (3 × 6 px, right-aligned) are ambiguous. Replace them with "1 of 3"
   in 11 px muted text, or drop them.
8. **"To text"** is jargon. Use "Convert to text".
9. **The follow-up chips' "↵" glyph** reads as a keyboard shortcut. Use no glyph.
10. **The long-press pulse** is a 64 px grey disc that sits on the ink while the card animates in
    (`ui-30`). Use a 40 px ring at 30% that is gone in 300 ms, before the card arrives.
11. **The card's scroll area clips content under the header with no fade** (`ui-08`). Add a 12 px
    top and bottom mask gradient when scrolled.
12. **The focus ring on a mark clips the wave** (`ui-46`: the ring ends above the squiggle). Extend
    it to the wave's bottom + 4 px.
13. **The paused page has no in-canvas cue** (`ui-52`). Show a 24 px "Checking paused" chip at the
    page's top-right margin, tap to resume.
14. **The mic button's toolbar presence varies between builds and tools** (`ui-01` vs `ui-60`/
    `ui-62`). Give it one stable position.
15. **"Checked on this PC" vs "Checked by AI"** is a good idea, but put it in the tooltip on the
    verdict chip. It clutters the header.

---

## Scores (10 = Apple ships it unchanged)

| Area | Score | Why |
|---|---|---|
| Correctness of marks | **3/10** | The core loop is right (line, symbol, timing, hold, erase, carried), but there is a false red on `a=3`, the "+n" lands on correct ink, the edit-reading green is gameable, and results are missing |
| Visual craft | **5/10** | Clean, consistent card system and a nice selector glow, but marks fail contrast, the wave is a smudge, the card is oversized, the toolbar shows telemetry, and 760×520 breaks |
| Interaction | **5/10** | Fast (92 ms card, 60 ms chips), good Esc/focus, Tab order works, Show-fix gating. But the ladder is bypassable, the no-AI path is broken, PTT has no partials, exam mode leaks, and the pinned card loses its region |
| AI and pedagogy | **5/10** | Grounded prompts with hidden CAS steps and a local offline hint are excellent. The guard's escape hatch and "Solve" over red work undo it |
| Robustness | **1/10** | About 40% native crash on first use |
| Accessibility | **5/10** | Focusable marks, aria labels and a polite region are good. Mark contrast 1.5–2.6:1 is a fail |
| **Overall** | **3.5/10** | Not shippable. It could reach 8 within one or two rounds, because the architecture is right |

---

## Blind A/B: same task in two products

**Task**: a Year-9 student solves 2x + 3 = 7 in three handwritten lines, writing `x = 3` on the
last line (wrong).

### Product A

1. The student writes on a lined page. About 1.5 s after lifting the pen on `x=3`, a thin red wavy
   line draws itself under the `3`. Nothing else changes, and correct lines get a faint tick that
   fades away.
2. Right-click (or press and hold) on the `3`, and a card slides out beside the work in under a
   tenth of a second.
3. The card shows "Mistake · Not a solution: x = 3 does not satisfy 2x = 4", the three lines as
   typeset maths with the 3 in red, and a Hint button. "Show fix" is locked.
4. Hint: "Substitute your value back into the line before and check both sides." This works with no
   internet.
5. With AI set up, the student can type or hold-to-talk a question. They can also loop any part of
   the page with an AI tool and pick Explain, Check my work, Solve, Translate, Flashcards…
6. Rewriting `x=2` makes the red vanish, with a brief green tick.
7. Total: instant, private, free. **But**:
   - In my runs it crashed about 4 times in 10 on the first problem.
   - It once put a red badge on a correct answer and red-marked a correct `a = 3`.
   - On a small laptop the card ran off the bottom of the window.

### Product B

1. The student finishes, then photographs the page.
2. About 10 s later, the photo comes back on an exercise-book-style screen with the wrong line
   circled in bold red pen, like a teacher.
3. "Here's what I read" lists the transcription, and the student confirms or corrects it before any
   teaching.
4. A lesson streams in (in the student's language if wanted):
   - the idea;
   - where it went wrong;
   - an everyday analogy;
   - a worked example with different numbers;
   - the exam vocabulary.
5. One check question follows. Wrong → a simpler re-explanation; right → a real past-paper question
   with its source labelled.
6. If a blind second solve disagrees, it says "I'm not fully sure I read this right."
7. It needs a network connection and a camera. It does not help while writing, and does nothing
   about steps after the first error.

### Scoring, criterion by criterion (which one a student prefers)

| Criterion | Winner | Note |
|---|---|---|
| Speed to feedback | **A** | 1.5 s in place vs 10 s plus a photo round-trip |
| Stays in flow (no context switch) | **A** | B forces stop → camera → separate screen |
| Precision of the mark | **A**, when correct | Symbol-level vs whole-line circle. But A's mark is a pale 17 px smudge; B's circle is unmistakable |
| Trust (no false alarms) | **B** | A produced a false red and a misplaced badge in my session. One of those costs more trust than A's speed earns |
| Reading confirmation | **B** | B asks first. A shows the reading but lets you "correct" it into a green tick |
| Teaching depth | **B** | Analogy, worked example, check question, past paper. A's ladder is good but terse, and the hint after rung 0 is one sentence |
| Guardrails | **B**, narrowly | B never hands over the answer before the check. A's Ask/Solve can |
| Delight / warmth | **B** | Teacher's red pen on an exercise book is emotionally legible. A is tasteful but clinical, and its toolbar shows "262 ms" |
| Offline, private, free | **A** | Decisively |
| Reliability | **B** | A crashes |

**Verdict**: today a student would pick **B** for a homework session (6 of 10 criteria),
because it never embarrasses them and it teaches. A wins the categories that *could* make it
dominant: live, in-ink, instant, offline. Fix the five P0s and the red legibility, and A beats B on
every axis the spec names.

**Reveal**:
- **Product A = goodink Live Ink** (this build, real engine).
- **Product B = Somo** (hackathon reference, from its write-up). The article's images could not be
  downloaded without a separate download approval, so B's visuals are judged from the article's
  description.

**Against Apple Math Notes and Goodnotes AI math** (RESEARCH-ux §1.3):
- **Versus Apple**: Apple's result-after-"=" is the feature that makes people say "magic". goodink's
  equivalent does not fire for `12+5=` on real handwriting (P0-5), and its ghost digits are a font,
  not ink.
- **Versus Goodnotes**: Goodnotes' "underline → tap → fix in place → recheck" is matched in
  structure. goodink goes beyond it (every page, offline, hint ladder) once its marks are visible
  and trustworthy.

## Am I wowed?

**No.**

- **What is good**: the 1.5 s symbol-level red on real handwriting, with no false red on correct
  algebra and a correct carried-line policy, is the first time I've seen live in-ink step checking
  work. That is the wow seed.
- **What is missing for a yes**:
  1. Zero crashes.
  2. Zero false reds in a 10-minute free-writing session, including variables and letters.
  3. A red wave you can see from arm's length (3:1 or better, not touching ink).
  4. Results after "=" that fire every time, in the user's ink.
  5. A rung-0 card under 260 px that never leaks the answer and never leaves the window.
