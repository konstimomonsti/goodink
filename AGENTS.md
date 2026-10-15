# goodink: instructions for coding agents

goodink is a Windows pen-first notes app, a Goodnotes 6-style rebuild: handwriting, PDF annotation,
notebooks, study and flashcards, and AI. The owner wants every part at **AAA quality**: fast,
correct and polished down to the pixel. Measure against Apple Notes Math Notes, Goodnotes 6 and
Linear, not against "good enough".

## Stack

- **Shell**: Tauri 2 (Rust backend in `src-tauri/src/*.rs`) with the system WebView2. The NSIS
  installer is about 12 MB, so keep it small.
- **UI**: React 19 + TypeScript + Vite (`src/renderer`), with zustand state (`lib/store.ts`), lucide
  icons, the Geist font, and design tokens in `styles/tokens.css`. Primitives are in
  `ui/primitives.tsx`.
- **Ink engine**: plain TypeScript on Canvas 2D (`engine/viewport.ts`). React is never on the
  per-stroke path. The document model is in `engine/model.ts`: immutable strokes, points as
  `Float32Array` `[x, y, pressure]` in page units (PDF points).
- **AI**: `lib/ai.ts`. Anthropic uses its SDK; every other provider uses the OpenAI-compatible SDK.
  **All traffic goes through the Rust `ai_fetch`, which inserts the saved key, so keys never enter
  the web view.** The free default is Google Gemini Flash.
- **Built-in services**: Windows OCR (`ocr.rs`), Windows InkAnalyzer (`ink.rs`), KaTeX math
  (`ui/Math.tsx`), pdf.js, and pdf-lib.
- Product recon and the design system are in `replica/`.

## Commands

| What | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm run test:unit` (`node --test --experimental-strip-types`, so **import with explicit `.ts` paths**) |
| Dev server | `npm run dev:web` (Vite on http://localhost:5199, hot reload) |
| Debug app | `cargo build` in `src-tauri`, giving `src-tauri/target/debug/goodink.exe`, which loads the dev server |
| Drive the app | `node tests/drive-tauri.mjs <scenario.mjs> src-tauri/target/debug/goodink.exe` |
| Release build | `npm run build` / `npm run dist` |

- **Driving the app**: each run gets a scratch library and WebView2 profile, so runs can go in
  parallel. The window is placed off-screen in test mode. Screenshots go to `tests/shots/`
  (git-ignored).
- **Scenario examples**: `tests/ai.mjs` creates a notebook with a mock AI provider.
  `tests/live/handwriting.mjs` writes realistic synthetic handwriting with real pen pointer events.
  `tests/live/mock-ai.mjs` is a configurable mock of the Anthropic and OpenAI-compatible APIs.
- After Rust changes, rebuild the debug exe. Cargo serialises concurrent builds.

## Rules

### Git

- Commit **feature by feature**: one focused commit per feature or fix, with a message that says
  what and why, so problems can be bisected. Do not batch unrelated work.
- **Never delete, re-initialise or rewrite `.git`.** No `git init`, `rm -rf .git`, `reset --hard`,
  force-push or history rewrites. The history was lost once on 2026-10-14 when `.git` was
  re-created.
- Commit only when asked to, or at the end of a feature when you are the lead. Sub-agents leave
  committing to the lead.

### Secrets

- Never read, list or probe stored API keys or credentials (Windows Credential Manager, settings
  files).
- Test AI features against the mock providers. Real-provider runs need the owner's explicit OK.

### Performance

- The ink hot path is sacred:
  - no React state while drawing;
  - no allocation in `pointermove`;
  - no work during a stroke;
  - committed strokes are blitted from cached page bitmaps.
- Measure before and after any change to `viewport.ts`.

### Quality bar for UI work

- Light and dark themes.
- 760 × 520 minimum window.
- Pen, touch and mouse input.
- `prefers-reduced-motion` respected.
- Keyboard and screen-reader access: focus rings, Esc closes, Enter sends, aria labels.
- No console errors and no layout shift.
- Visually verify every state with real screenshots before calling UI work done.

### Code style

- Match the surrounding code: terse explanatory header comments at the top of each file, comment
  density like the neighbours, and the same naming.
- Prefer the existing primitives and tokens over new ones.

## Live Ink Intelligence (the feature in progress)

Docs: `docs/live-ink/SPEC.md` (what and why), `ARCHITECTURE.md` (binding decisions; it overrides
the spec), `RESEARCH-recognition.md`, `RESEARCH-ux.md`. Shared types:
`src/renderer/live/contract.ts`. Change the contract only additively, and note the change in the docs.

**Owner priorities (2026-10-16, binding; see ARCHITECTURE §E)**:
- First goal: follow the learner's math notes (read the ink and check the steps quietly).
- On-device when sure. When not fully sure (the CAS is undecided or the reading is shaky), Smart
  sends the line to the **better (strong) cloud model**, which is slower.
- The tutor opens only when asked: "Ask by voice" (push-to-talk), the AI selector, or
  right-click/long-press on ink. It never pops up or listens on its own.

**What it does**:
- recognises handwriting and handwritten formulas live, on-device first;
- checks each math step against the one before;
- puts a red wavy underline under exactly the wrong symbols;
- long-press (touch) or right-click opens an insight card: the editable reading, why it's wrong, a
  hint ladder, and ask by keyboard or push-to-talk voice;
- an **AI selector** tool (`A`, Sparkles icon) lets you draw a loop around anything on the page and
  ask about it;
- modes: Off, Local (free, offline), Smart (default: local first, then the cloud for undecided
  steps), Max;
- extras: live results after `=` with variables, carry-forward "method marks", a mistake journal
  that turns patterns into flashcards, "same problem, new numbers", exam mode, and pause per page.

**Modules**

| Path | Contents |
| --- | --- |
| `live/recog/` | Line grouping, Windows InkAnalyzer backend, 2-D math layout, top-k readings with `alternateProbs`, pluggable `RecogBackend`s fused by confidence |
| `live/math/` | Pure TS CAS step checker: exact rationals plus sampling, beam × beam over readings, `checkSteps`, `evaluate`, `variant`, `toLatex` |
| `live/ai/` | Judge, verify, ask, transcribe. Every knob (models, prices, crops, timings, thresholds) lives in `policy.ts`. Streaming is simulated by a pacer until Rust gets `ai_fetch_stream` |
| `live/engine.ts` | `LiveEngine`: the settle/debounce pipeline, the mark gating policy, decorations, journal and modes |
| `live/ui/` | Marks, `InsightCard`, `AiCard`, `StatusPill`, `Patterns`. Viewport and editor wiring are in `viewport.ts` and `Editor.tsx` |

**Non-negotiables**

1. **A false red mark is the worst possible bug.** Red appears only when one of these holds:
   - the CAS proves the step wrong on **every** reading with p ≥ 0.1, with line confidence ≥ 0.9
     and a localised span;
   - the AI judge found an error, an independent blind re-solve agreed (another vendor when
     possible), and the CAS does not contradict the corrected reading.

   Anything less is amber dotted or nothing. Release gate: ≥ 98% red precision on the test corpus.
2. **The cloud judges and does not read.** Specialised local models read handwritten math better
   than frontier VLMs (TexTeller 86–88% vs Gemini Flash ~55% on CROHME). Always send the local
   reading as text, a crop of only the changed line (x-height 20–28 px, long edge ≤ 1000 px,
   grayscale) and the prior steps as text.
3. **Speed budgets**:
   - grouping < 2 ms;
   - local recognition + CAS < 120 ms after settle (600 ms after the last pen-up);
   - AI verdict p50 < 2.5 s;
   - a Smart check costs about $0.0002 on Haiku/Flash-Lite;
   - results are cached by content hash and unchanged blocks are never re-sent.
4. **Offline**: Local mode works offline and sends nothing.
5. **Licensing**: no MathWriting-trained model weights (CC BY-NC-SA). Local HMER candidates are
   TexTeller (Apache-2.0, ~300M, ONNX) and a CoMER/TAMER-class lite model, run through `ort` in
   Rust and downloaded lazily with sha256 checks.

**UX rules** (from research; numbers are binding)

- **Timing**:
  - Nothing runs during a stroke.
  - Red appears ≥ 900 ms after pen-up, and is held while the pen is active within 2 line-heights
    (until a 1.5 s pause or a new line).
  - Amber and ticks appear at settle.
  - Erasing removes marks within one frame.
  - A fixed step gets a 600 ms green tick fade, the only celebration.
- **Marks**:
  - Red: wavy, 1.5 px at 100% zoom, #E5484D light / #FF6369 dark, 100% opacity (≥ 3:1 contrast
    wins), amplitude 1.75 px, wavelength 6 px, clear of the ink by max(3 px, 0.12 × line height),
    250 ms ease-out draw-in played once.
  - Amber: dotted, #B26B00 at 90%, confidence encoded by dot spacing, with a hover that says "70%
    sure: I read 5 as S?".
  - Tick: ≤ 10 px, #1E8A50 at 70%, fading after 4 s unless enabled.
  - Shape encodes meaning (WCAG 1.4.1), and every mark has ≥ 3:1 contrast.
- **Showing errors**: mark the **first error only**. Lines that follow correctly from it are
  "carried", with no mark. Show at most 3 red marks per screen, with a "+n" margin dot for the rest.
- **Hint ladder**: the card opens on rung 0, which says what's wrong without the fix. Then Hint →
  Next step → Show fix. "Show fix" unlocks after one hint or 10 s. Replies are one step, ≤ 60 words,
  ask before telling, are grounded on the CAS solution, and use different numbers in examples. An
  explain-back question follows the fix. (Unguarded AI answers hurt learning: Bastani et al.,
  PNAS 2025, −17%.)
- **Voice**:
  - Push-to-talk by default, with live partial transcripts.
  - "Why?", "this" and "here" refer to the block under the pen or the last block written within
    10 s.
  - Latency target: ≤ 800 ms to the first token.
- **AI selector**:
  - The loop auto-closes within 24 px of its start.
  - The glow fades in over 120 ms, and the chips appear ≤ 100 ms after release.
  - The card sits beside the region, never over the ink, and can be pinned.
- **Accessibility**: marks are focusable (Tab and Enter), with a polite live region after a 2 s
  pause.

**Benchmark to beat**: Gemini/DeepMind-hackathon math tutors, for example "Somo":
- It takes a photo, Gemini returns JSON, the first wrong line is circled in red, and the user
  confirms the reading.
- It streams a lesson, then a blind second solve hedges on disagreement.
- It takes about 10 s.

goodink must win on every axis: live while writing, symbol-level marks, < 3 s (instant locally),
inline reading correction, verification before red, offline and near-free, voice, and the AI
selector. No published hackathon winner does live in-ink step checking. "Check every handwritten
calculation on every page" is the most-voted Goodnotes feature request.

**Open items** (2026-10-14):
- the recog accuracy eval and calibration;
- the HMER spike (TexTeller via `ort`), with a go/no-go;
- real streaming (`ai_fetch_stream` over a Tauri `Channel`);
- aligning the AI judge's misconception tags with math's tags;
- the red-precision corpus;
- the math red-team (`tests/unit/mathcheck-redteam.test.ts`);
- harsh visual critic rounds on every UI state;
- real-provider accuracy runs, which need the owner's OK.
