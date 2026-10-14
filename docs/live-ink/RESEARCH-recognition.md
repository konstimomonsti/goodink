# Live Ink: recognition and step checking, research and recommendation

Date: 2026-10-13. Scope: handwriting and handwritten-math recognition, step checking, AI tutor and
AI selector for goodink (see `SPEC.md`, `src/renderer/live/contract.ts`).

**Verification note.** Items marked **[v]** were read from the primary source this session. Items marked
**[u]** come from prior knowledge and could not be re-checked (the web-tool quota ran out mid-session).
Re-verify [u] items before quoting them externally.

## 1. TL;DR

1. **Specialised local models now read handwritten math better than frontier cloud VLMs.** On CROHME,
   Gemini 2.5 Flash reaches 55% ExpRate and GPT-4o 49% zero-shot. TexTeller (298M, Apache-2.0)
   reaches 86–88% and a 3B fine-tuned Qwen (Uni-MuMER) reaches 73–80% **[v]**. So use the cloud to
   **judge** steps, not to **read** them. Send the local LaTeX with the crop and ask the model to
   confirm or correct it.
2. **The reading is the weakest link, not the maths.** Do not mark red on the top-1 reading alone.
   Check every top-k beam hypothesis with the CAS, and mark red only when *all* plausible readings
   fail. If any plausible reading makes the step correct, the verdict is amber or nothing.
3. **Cloud cost is negligible when crops are small.** An 800×200 crop is 232 visual tokens on Claude
   and 280 on Gemini 3 at low resolution **[v]**. One check on Claude Haiku 5.5 costs about
   **$0.00008**, so 100 checked steps in Smart mode cost a fraction of a cent.
4. **Licensing trap: MathWriting is CC BY-NC-SA 4.0 [v].** Any model trained on it is risky in a
   commercial app. CROHME and synthetic/rendered data are the safer base.

## 2. Recognition state of the art

### 2.1 Online (stroke) handwritten math

| System | Date | Input | Size | Result | License / availability |
|---|---|---|---|---|---|
| MathWriting baselines: CTC Transformer | Apr 2024 | ink | 35M | **CER 5.49** test / 4.52 valid | dataset CC BY-NC-SA 4.0 [v] |
| MathWriting: PaLI | Apr 2024 | ink + image | 700M | CER 5.95 | not released [v] |
| MathWriting: PaLIGemma | Apr 2024 | image + speed | 3B | CER 5.97 | [v] |
| MathWriting: Google Cloud OCR | Apr 2024 | image only | – | CER 7.17 | [v] |
| Fadeeva et al., ink tokens in VLMs: PaLM-E | Feb 2024 | ink text + image | ~500M | CER 4.19 on MathWriting | not released [v] |
| Uni-MuMER† (on rendered ink) | May 2025 | image | 3.75B | MathWriting ExpRate 51.45, CER 4.00 | code and models on GitHub [v] |
| TexTeller (on rendered ink) | Aug 2025 | image | 298M | MathWriting ExpRate **81.0** | Apache-2.0 [v] |

Sources: MathWriting https://arxiv.org/abs/2404.10690 (table 6, v2 HTML);
"Representing Online Handwriting for Recognition in Large VLMs" https://arxiv.org/abs/2402.15307;
Uni-MuMER https://arxiv.org/abs/2505.23566; TexTeller https://arxiv.org/abs/2508.09220,
https://github.com/OleehyO/TexTeller.

Lessons from Fadeeva et al. **[v]**:
- **Tokenising ink for an LLM.** Resample each stroke at 20 ms (median 313 → 178 points). Encode
  points as relative offsets scaled to the ViT input size, using 2 integer tokens per point. The
  MathWriting median is then **~367 tokens** (raw x/y/t text is 2,692).
- **Ink alone beats image alone for PaLI** (CER 4.64 vs 8.07). Ink plus image is best (4.22–4.55).
- **This needs a fine-tuned model.** Off-the-shelf cloud LLMs are not trained on this format. For
  cloud calls, an image is the right modality, and an ink text sequence (~370 tokens) costs about as
  much as a 232–280-token image anyway.

**Online vs offline.** The best published *open* numbers now come from image models applied to
rendered strokes (TexTeller, Uni-MuMER). Our strokes render perfectly: no blur, no paper. We can
also crop each token exactly because we know the stroke boxes, and we keep stroke-to-token mapping
from our own grouping. So rendering to an image and running an image model is the pragmatic v1.
A custom online-ink CTC model (35M class, ~5% CER) is a v2 option when we need per-stroke alignment
for underlines that is better than attention maps.

**InkSight** (Google/EPFL, arXiv 2402.05804) does the reverse job: it turns photos into ink
("derendering"). It uses a ViT + mT5 architecture, and 87% of its HierText tracings are rated
valid. The Small-p weights are released. It is useful for **imported photos and PDFs → editable
ink** (a creative extra), not for live recognition. https://arxiv.org/abs/2402.05804 [v]

**CROHME 2023** (ICDAR 2023) added 3,905 new online and offline paired equations with online,
offline and bimodal tasks. I could not find official per-task winners. An aggregator lists 70.26
ExpRate as the 2023 SOTA, and TexTeller reports 61.8 [v].
https://zenodo.org/records/8428035, DOI 10.1007/978-3-031-41679-8_33.

### 2.2 Offline (image) HMER, CROHME ExpRate (%)

| Model | Venue | CROHME 14 / 16 / 19 | HME100K | Params | License / ONNX |
|---|---|---|---|---|---|
| CoMER | ECCV'22 | 58.38 / 56.98 / 59.12 | 68.12 | ~6M [u] | MIT? [u]; small DenseNet + decoder, exports to ONNX |
| NAMER (non-autoregressive) | 2024 | 60.51 / 60.24 / 61.72 | – | small [u] | [v] numbers |
| TAMER | AAAI'25 | 61.36 / 59.54 / 60.13 | 69.50 | ~6–8M [u] | – |
| PosFormer | ECCV'24 | 60.45 / 60.94 / 62.22 | 69.5 | ~6–8M [u] | – |
| UniMERNet | 2024 | 67.4 / 68.4 / 65.4 | 68.0 | ~100–300M [u] | Apache [u] |
| Uni-MuMER (Qwen2.5-VL-3B FT) | NeurIPS'25 sub. | 75.36 / 70.79 / 73.73 (82.05 / 77.94 / 79.23 with extra data) | 71.93 | 3.75B | open [v]; too big for us |
| **TexTeller 3** | 2024–25 | **88.0 / 85.9 / 85.8** | **90.7** | **298M** | **Apache-2.0**, server has `--use-onnx` [v] |
| Gemini 2.5 Flash (zero-shot) | – | 58.01 / 52.74 / 55.21 | 28.14 | – | cloud [v] |
| GPT-4o (zero-shot) | – | 50.61 / 46.03 / 49.79 | 22.96 | – | cloud [v] |
| Qwen2.5-VL-7B (zero-shot) | – | 55.98 / 50.92 / 49.62 | 54.57 | 7B | [v] |

Sources: Uni-MuMER table 1/2 https://arxiv.org/html/2505.23566v2; TAMER https://arxiv.org/abs/2408.08578;
PosFormer https://arxiv.org/abs/2407.07764; CoMER https://arxiv.org/abs/2207.04410;
TexTeller tables https://arxiv.org/html/2508.09220v1.

Caveats:
- TexTeller trains on 80M synthetic pairs plus ~5% handwritten data. Its CROHME numbers are not
  directly comparable with the 8.8k-train-set papers, so possible data overlap should be checked.
- The TexTeller arXiv paper is shown as **withdrawn** (version history to Jan 2026). The Apache-2.0
  repo and weights remain.
- **Pix2Text MFR** is TrOCR-based with an ONNX build (`mfr-1.5-onnx`). Its license for commercial
  use is unclear (a paid commercial licence existed for older versions).
  https://huggingface.co/breezedeus/pix2text-mfr

**Pick:** TexTeller (int8 ONNX) as the local math reader v1, and a CoMER/TAMER-class ~6–8M model as
the "lite" fallback for low-end PCs. Fine-tune the lite model on CROHME + synthetic renders of our
own ink, not on MathWriting, to avoid the NC licence.

## 3. On-device feasibility in our stack

**Where to run: Rust (`ort` crate, ONNX Runtime) in the backend, not onnxruntime-web.**
- The web view must keep the ink hot path free (see the SPEC). ORT-web WASM/WebGPU adds a
  ~10–25 MB runtime to the web bundle, and the WebView2 GPU process competes with Canvas
  rendering. **[u]**
- `ort` runs on CPU (MLAS, int8) everywhere. On Windows 11 24H2+ it can use **Windows ML**, which
  ships a system ONNX Runtime and auto-selects CPU/GPU/NPU execution providers. Windows ML became
  GA in 2025, and DirectML is in maintenance mode. **[u]** Start with the CPU EP, and add the
  DirectML/WinML EP behind a flag.
- The repo already links `windows` with `UI_Input_Inking_Analysis` and `Media_Ocr`, so InkAnalyzer
  and OCR are available in `ink.rs`/`ocr.rs` today.

**Latency estimates on a typical laptop** (i5/Ryzen 5 class, 4 P-cores; needs a benchmark spike) **[u]**:

| Model | Disk (int8) | Per line, CPU | iGPU (DML) |
|---|---|---|---|
| CoMER-class 6–8M | 8–15 MB | 15–40 ms encoder + ~2 ms/token × 20 tokens, so **40–80 ms** with beam 3 | ~same |
| TexTeller 298M (ViT + decoder) | ~300 MB fp32, ~80–150 MB int8 | encoder 80–200 ms + ~6–12 ms/token × 20, so **250–450 ms** | 60–150 ms |
| Uni-MuMER 3B | 2+ GB at 4-bit | seconds | not viable |

The SPEC requires a "<120 ms after settle" budget for recognition + CAS. That points to:
- the **lite model on the hot path**;
- TexTeller as a **second pass** on lines whose lite confidence is below threshold, or on the
  line the user opened in the insight card;
- **lazy downloads**, so the 12 MB installer is not affected: Local-lite ≈ 15 MB, Local-accurate ≈
  120 MB. Verify each download with sha256, which the `sha2` crate already handles.

**Windows built-ins:**
- **InkAnalyzer** (`Windows.UI.Input.Inking.Analysis`, since 10.0.15063) gives writing/drawing
  classification, lines, paragraphs, words, shapes and text recognition in installed languages. It
  does **no math structure** [v]. https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.inking.analysis
- Use it for the prose path and the `kind: 'text' | 'math'` split. A good heuristic: InkAnalyzer
  "drawing" or low text confidence together with math glyph density means math.
- **Math Input Panel was removed in Windows 11.** It is replaced by an on-demand "Math Recognizer"
  optional feature that contains the Math Input Control and recognizer [v] (Microsoft deprecation
  list via https://www.elevenforum.com/t/windows-11-feature-deprecations-and-removals.129).
- The remaining API is the legacy COM `IMathInputControl` (micaut). It is a modal UI control, not a
  headless recogniser, and it is not installed by default **[u]**. Do not build on it.
- **MyScript iink** has very good math and ink but is a commercial per-seat SDK. It is the only
  turnkey alternative. **[u]**

## 4. Cloud tier: cost and latency

Prices are per 1M tokens, standard tier, as of 2026-10-13 **[v]**:
- Gemini: https://ai.google.dev/gemini-api/docs/pricing
- Claude: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI: https://developers.openai.com/api/docs/pricing

| Model | In / cached / out | Image tokens for 800×200 | ≈ $ per step check* |
|---|---|---|---|
| **Claude Haiku 5.5** (≤100k prompt) | $0.10 / $0.01 / $0.50 | ⌈800/28⌉×⌈200/28⌉ = **232** [v] | **$0.00008** |
| Gemini 2.5 Flash-Lite | $0.10 / $0.01 / $0.40 | 258 (tile) [u] | $0.00008 |
| Gemini 3.1 Flash-Lite | $0.25 / $0.025 / $1.50 | 280 at `media_resolution: low` [v] | $0.00025 |
| GPT-5-nano | $0.05 / $0.005 / $0.40 | ~430 (patches × 2.46, disputed) | $0.00006 + reasoning tokens |
| gpt-6-luna | $0.10 / $0.01 / $0.50 | ? | ~$0.0001 |
| Gemini 3 Flash Preview | $0.50 / $0.05 / $3.00 | 280 | $0.0006 |
| Claude Sonnet 5.5 (Max mode) | $2 / $0.10 / $10 | 232 | $0.0035 |
| Gemini 3.6/3.8 Flash | $0.75 / $0.075 / $3.75, rising to $1.50/$7.50 on 2027-01-01 | 280 | $0.0013 |

*The per-step estimate assumes:
- the image;
- ~150 uncached tokens: local LaTeX of this line plus the previous 2 lines;
- ~400 cached tokens: the system prompt and JSON schema;
- ~80 output tokens of compact JSON;
- no extended thinking.

**Latency.** Small-model TTFT is typically 0.3–0.8 s, and a full 80-token JSON answer arrives in about
0.6–1.5 s **[u]**. That fits the p50 2.5 s target even with a second verification call run **in
parallel**, not sequentially.

All three vendors support structured JSON output and prompt caching. On Claude, the cache-read price
is 10% of input; Haiku 5.5 is $0.01/MTok **[v]**.

**Token tricks**, in order of value:
1. **Send the local reading as text plus the crop.** Ask for `{"reading_ok", "corrected_latex",
   "verdict", "span", ...}`. The model only confirms the reading and judges the step.
2. **Crop to the changed line only**, with ~12 px padding. Scale so the x-height is about 20–28 px
   (Claude handles small text badly under 200 px [v]), and cap the long edge at ~1000 px.
3. Send **previous steps as text** (already verified LaTeX), never as images.
4. **Render clean**: black on white, 1-bit or grayscale PNG with no paper texture. This compresses
   better and reads better. Grayscale does not change the token count; pixel size does.
5. Use a **content-hash cache**, as the SPEC requires. Also keep a static system prompt first so it
   hits the prompt cache.
6. **Turn off thinking** on Flash/nano models for the reading and judging call. Allow it only on the
   verification call in Max mode.
7. Ink-as-text is only worth it with a fine-tuned model. Skip it for cloud.

## 5. Step verification: avoiding false red

Evidence:
- **Let's Verify Step by Step** (OpenAI, 2023, arXiv 2305.20050) **[u]**: process supervision beat
  outcome supervision for best-of-N on MATH (78.2% vs 72.4%) and released PRM800K, about 800k
  step labels.
- **ProcessBench** (Qwen, Dec 2024, arXiv 2412.06559) **[u]**: the task is to find the *earliest*
  wrong step, which is exactly our task. Off-the-shelf PRMs generalise poorly to harder problems.
  Strong *prompted critic* LLMs, such as reasoning models, match or beat them.
- **"Lessons of Developing PRMs"** (Qwen2.5-Math-PRM, Jan 2025, arXiv 2501.07301) **[u]**:
  Monte-Carlo step labels are noisy. LLM-as-judge plus consensus filtering produces better PRMs.
- **The conclusion for us:** do not ship a PRM. Use (a) the CAS for decidable algebra and (b) a
  prompted judge with independent confirmation for everything else.

**Decision rules.** Implement these in `math/` and `ai/`.
1. **CAS first.** Each step is an equation or expression relation. Test equivalence of consecutive
   steps:
   - Expressions: is A−B = 0? Simplify symbolically, and also evaluate at **5 random exact-rational
     points**. Equal at all points means OK. Unequal at ≥2 points means *proved wrong for that reading*.
   - Equations: compare solution sets. For linear and quadratic equations in one variable, solve
     exactly. Otherwise test whether the solutions of step *n* satisfy step *n−1* (direction matters:
     dividing by x loses roots, which counts as "unsure", not "wrong").
   - Out of scope: inequalities, domains, ± and dropped cases go to "unsure" or cloud.
2. **Reading robustness.** Run the CAS over the top-k (k=3–5) beam readings of *both* lines.
   - Red (local-cas) only if every reading with probability ≥ 0.1 fails, the line confidence is
     ≥ 0.9, and the failure localises to tokens. The span is found by aligning against the
     corrected alternative, then mapped to `InkToken.strokeIds`.
   - If any alternate reading passes, the verdict is "unsure", or nothing if that alternate is likely.
   - This is the single biggest false-red killer, and it is cheap (a CAS check costs microseconds).
3. **AI path (Smart).**
   - Call 1 is the judge: it gets the crop, the local LaTeX and prior steps, and returns the verdict
     plus the corrected reading.
   - If the verdict is "error", run **Call 2 in parallel or immediately after**. It uses a different
     model family and solves blind from the previous step, without seeing the claim.
   - Mark red only if Call 2 agrees *and* the CAS does not contradict on the corrected reading.
   - On disagreement, mark amber.
   - Use a cross-vendor pair, e.g. Haiku 5.5 + Gemini 3.1 Flash-Lite, so the errors are uncorrelated.
4. **Calibration.** Log (confidence, user-corrected?) pairs locally and fit isotonic regression so that
   `confidence` means what the contract says. The red threshold is tuned for ≥ 99% precision on an
   internal set of ~300 synthetic wrong and right steps. Use `tests/live/handwriting.mjs` with
   injected sign errors, dropped terms and wrong distribution.
5. **Abstain generously.** "Unsure" is cheap and "red" is expensive (SPEC non-negotiable).

## 6. Recommended architecture

```
pen settles (600 ms) ─► group lines (<2 ms, TS)
  ├─ InkAnalyzer (Rust, WinRT)  → text lines + writing/drawing split          ~15–40 ms
  ├─ math lines → render 1-bit crop → HMER-lite (ort, int8, top-5 beams)       ~40–80 ms
  │      └─ low conf? → TexTeller int8 (async, second pass)                    ~250–450 ms
  ├─ CAS over beam × beam (TS or Rust, exact rationals)                        ~1–5 ms
  │      verdict ok / error(robust) / unsure
  └─ Smart: unsure or undecidable or low-conf → cloud judge (crop + LaTeX + prior steps)
            error → independent re-solve (other vendor) → red only on agreement    p50 ~1.2–2 s
```

| Mode | Reader | Judge | Expected step accuracy (est.) | Latency | $ / 100 checked steps |
|---|---|---|---|---|---|
| Local | lite → TexTeller | CAS + beam robustness | reading 80–88% exact per line, higher for short school algebra; false red near 0 by design, many amber | 50–120 ms (lite); +0.3 s 2nd pass | **$0** |
| Smart | local + cloud correction | CAS → Haiku 5.5 / 3.1 Flash-Lite, 2nd call on errors | reading >95% after correction (est.) | local instant; AI p50 1–2 s | ~20–30 calls ≈ **$0.002–0.008** |
| Max | local + cloud | Sonnet 5.5 or Gemini 3.x Flash on every block, plus a blind cross-vendor re-solve | best | p50 1.5–2.5 s | ~1.3 calls/step ≈ **$0.2–0.5** |

**AI selector and tutor.** For the selector, send the lasso bounding-box crop:
- downscale to ≤1,000 px long edge (~1,300 tokens);
- include the recognised text/LaTeX of the ink inside the loop, and PDF text-layer text if present.

Stream the answer from Sonnet-class or Gemini Flash. A typical question costs ~$0.003–0.01. Mic
input uses the existing `Media_SpeechRecognition` (offline).

**Build order:**
1. Spike (1–2 days): benchmark `ort` + TexTeller int8 and a CoMER-class model on 50 of our synthetic
   lines. Measure ExpRate and the p50/p95 per-line latency. Decide the lite model.
2. The CAS with beam-robust verdicts and span mapping. This delivers Local mode, the core value.
3. The InkAnalyzer text path and text/math classification.
4. The Smart cloud judge with JSON schema, caching, the cross-vendor second call and the
   tokens/latency pill.
5. The selector, insight-card editing (a correction re-runs the CAS) and calibration logging.
6. v2: fine-tune the lite model on our own corrected ink (opt-in) plus CROHME. Consider an online-ink
   CTC model for crisp stroke alignment.

## 7. Creative extras

| Feature | Why it delights | Effort |
|---|---|---|
| **Live result preview** ("=" shows a ghost answer in handwriting-like font, à la Apple Math Notes) | instant reward; uses the CAS we already have | M (3–4 d) |
| **Variables carry across lines and pages** (`a = 3` then `2a+1 =` → 7) | turns notes into a live calculator | S–M |
| **Ink → LaTeX beautify** (tidy, aligned typeset, still editable, toggle back to ink) | clean notes for sharing; Copy LaTeX | M |
| **Inline graphing** (circle `y = x^2-4`, or write it, and a mini plot appears; drag a slider on a parameter) | wow moment; plot via canvas, no cloud | M |
| **Unit checking** (`3 m · 2 s = 6 m` gets an amber "units: m·s") | catches physics mistakes that CAS equality misses | M (units library) |
| **"Next-step ghost"** (hint ladder shows the next line faintly in the user's own ink style, via glyph reuse from their strokes) | personal, feels magical | L |
| **Photo / PDF → ink** with InkSight-style derendering | old paper notes become checkable | L (model 300M+, cloud fallback) |
| **Mistake journal** (errors auto-collected into flashcards by concept: sign errors, distribution) | learning loop | S |
| **Solve-for gesture** (circle a variable and tap "solve for") | fast, discoverable | S |
| **Step-by-step replay** (stroke timestamps animate how a solution was written, for tutors) | we have the timing data for free | S |

## 8. Open risks

- Model licences must be confirmed file-by-file (TexTeller Apache-2.0 [v]; others [u]). Avoid
  MathWriting-trained weights for distribution.
- The CPU latency numbers are estimates. The step-1 spike is mandatory before committing.
- Cloud prices change quickly: Gemini 3.6/3.8 Flash doubles on 2027-01-01 [v]. Keep model IDs and
  prices in config, not code.
