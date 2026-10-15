# Live Ink Intelligence: spec

goodink is a Tauri 2 + React 19 + TypeScript pen-notes app (Goodnotes-style). The ink engine is
plain TS on Canvas 2D (`src/renderer/engine/viewport.ts`), the document model is
`src/renderer/engine/model.ts`, the AI layer is `src/renderer/lib/ai.ts` (all provider traffic goes
through the Rust backend `ai_fetch`, which inserts saved keys), and the Rust backend is
`src-tauri/src/*.rs`. Shared contract for this feature: `src/renderer/live/contract.ts`.

## What we are building

1. **Live recognition** of handwriting and handwritten formulas, as you write, on-device first.
2. **Live checking**: every handwritten math step is checked against the previous one. A wrong
   step gets an animated **red wavy underline** exactly under the wrong part (the strokes that
   are wrong, not the whole page). Unsure results get a quiet amber dotted underline. Optional
   subtle green tick at the end of verified lines.
3. **Insight card**: right-click (mouse/pen barrel) or long-press (touch, 450 ms, no movement) on
   any recognised ink opens a card: the recognised text/LaTeX (KaTeX-rendered, editable to
   correct a misread, which re-checks), the verdict, why it is wrong, a hint ladder
   (Hint → Next step → Show fix, never giving the answer before asked), Copy LaTeX, Convert to
   text, and an **ask box with keyboard and microphone** whose answers stream in.
4. **AI selector** (new tool, Sparkles icon, shortcut `A`): draw a loop around any part of a page
   (ink, PDF, images, text) like the lasso; the region glows and a popover offers quick chips
   (Explain, Check my work, Solve step by step, Summarise, Translate, Make flashcards) plus a
   free question by keyboard or mic. Answers stream into a card anchored to the region, with
   follow-ups.
5. **Modes / token saving** (`LiveMode` in the contract): Off, Local (free, offline, nothing
   leaves the PC), Smart (default: local first, AI only for settled changed blocks the CAS
   cannot decide, cropped small images, cached by content hash, errors confirmed by a second
   independent call), Max (strongest model on every settled block + verification). A status
   pill shows mode, last latency and tokens used this session.

## Non-negotiables

- **Precision over recall. A false red underline is the worst possible bug.** Red is shown only
  when (a) the CAS proves the step wrong on a confident reading, or (b) AI found it and an
  independent second check agreed. Everything else is amber "unsure" or nothing.
- **Speed**: grouping < 2 ms; local recognition + CAS verdict < 120 ms after the pen settles
  (settle = 600 ms after the last pen-up in that block); AI verdict p50 < 2.5 s. Nothing runs
  during a stroke; the ink hot path in viewport.ts must not get slower (no React state while
  drawing, no allocation in pointermove).
- Results are keyed by content hash; unchanged blocks are never re-checked or re-sent.
- Erasing or editing a line clears its marks immediately.
- Works offline in Local mode. Keys never enter the web view (keep using `ai_fetch`).
- Matches the app's existing design language (`src/renderer/styles/tokens.css`, `app.css`,
  `ui/primitives.tsx`, lucide icons, Geist font), light and dark themes, pen, touch and mouse.
- `npm run typecheck` and `npm run test:unit` stay green.

## Module ownership (edit only your files; additive one-line registrations elsewhere are OK)

| module | owner agent | files |
| --- | --- | --- |
| recog | recog | `src-tauri/src/ink.rs`, `src-tauri/src/speech.rs`, Cargo.toml features, `lib.rs` (register commands only), `api.ts` (add methods only), `src/renderer/live/recog/**`, `tests/live/handwriting.mjs`, `tests/unit/recog*.test.ts` |
| math | math | `src/renderer/live/math/**`, `tests/unit/mathcheck*.test.ts` |
| ai + engine | tutor | `src/renderer/live/ai/**`, `src/renderer/live/engine.ts`, additive exports in `src/renderer/lib/ai.ts`, `tests/unit/liveai*.test.ts`, `tests/live/mock-ai.mjs` |
| UI | ui | `viewport.ts`, `Editor.tsx`, `src/renderer/live/ui/**`, `app.css` (new section at the end), `shared/types.ts` (Settings fields), settings UI, `tests/live/ui-*.mjs` |

## Running the real app (for screenshots and end-to-end checks)

- The Vite dev server runs on http://localhost:5199 (already started; if it is down, start it
  with `npm run dev:web` in the background). It hot-reloads your edits.
- The debug app `src-tauri/target/debug/goodink.exe` loads the dev server. Rebuild it with
  `cargo build` in `src-tauri` only after Rust changes (cargo serialises concurrent builds).
- Drive it: `node tests/drive-tauri.mjs <scenario.mjs> src-tauri/target/debug/goodink.exe`.
  Each run gets its own scratch library and WebView2 profile, so runs can happen in parallel. See
  `tests/ai.mjs` for a scenario that creates a notebook and runs a mock AI provider server.
  Screenshots go to `tests/shots/`; prefix yours with your module name.
- Synthetic handwriting: `tests/live/handwriting.mjs` (owned by recog) writes text like
  `2x+3=7` as realistic jittered pen strokes through real pointer events.

## Benchmark: the hackathon reference

The reference is the class of Gemini/DeepMind-hackathon math tutors, e.g. "Somo"
(https://dev.to/colinje01/i-built-a-tutor-that-circles-your-math-mistake-in-red-pen-3ffi):
photo of handwritten working → Gemini returns structured JSON (transcription, concept,
error_step, final_answer) → the UI circles the first wrong line in red like a teacher's pen →
"here's what I read" confirmation step → streamed lesson (idea, error, analogy, worked example
with different numbers) → one comprehension check → independent second model call that solves
the problem blind and hedges when it disagrees → provider failover (Gemini → Claude) with a
circuit breaker; ~10 s per diagnosis.

We must beat it on every axis: live while writing instead of a photo; marks the wrong *symbols*
not just the line; under 3 s instead of ~10 s (instant locally); the correction-of-reading step
is inline in the insight card; independent verification before any red mark; works offline and
nearly free in Local/Smart; ask by voice or keyboard about anything on the page; AI selector.

## Quality bar (what the critic checks)

Every pixel at the level of Apple Notes Math Notes / Goodnotes 6 / Linear: crisp 1px hairlines,
correct radii, consistent 4 px spacing grid, no layout shift, 60 fps animations with
`prefers-reduced-motion` respected, nothing clipped at small windows (760 × 520), dark mode
correct, keyboard accessible (focus rings, Esc closes, Enter sends), aria labels, no console
errors.

- Contract note (recog, 2026-10-14): `LineRecognition.alternateLatex?: string[]` added (additive), the LaTeX of each alternate in the same order as `alternates`.
