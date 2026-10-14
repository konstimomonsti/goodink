# Math step checker: red-team findings

Target: `src/renderer/live/math/index.ts` (`checkSteps`, `evaluate`, `variant`). The builder's claim was
0 false positives (correct steps marked `error`) on about 400 hand cases plus 30k fuzz steps.

Suite: `tests/unit/mathcheck-redteam.test.ts`. Run it with
`node --test --experimental-strip-types tests/unit/mathcheck-redteam.test.ts`.

What the suite covers:

- About 650 correct blocks in the `SOUND` lists. These are hard assertions and all of them pass.
- 88 false-positive cases, written as `todo` tests.
- 55 wrong blocks that the checker catches.
- 18 recall misses.
- 2 wrong-green cases (wrong work marked `ok`).
- 51 `evaluate` cases, 9 of them wrong.
- 8 `variant` checks.
- 10 seeded generated families of 150 blocks each.

Every `todo` test fails today. When a finding is fixed, its test turns green.

**Verdict: the 0-false-positive claim does not hold.** I found 88 hand cases of correct work marked red, in 9
distinct classes. Several of them sit in the most common workflows of school maths. In a seeded generator run
(3000 blocks over 6 families), **1538 of the blocks (51%) had at least one false red.** Four families were
affected: rounded answers, `f''`, annotations without a bar, and a new problem after a solved line.

## False positives (correct work marked `error`), ranked by severity

### FP-1: derivatives `y'`, `y''`, `f''(x)` and `f'(x)=0` are red. Severity: critical

Examples that come back red:

| Input | Verdict |
|---|---|
| `y=x^2 ;; y'=2x` | line 2 is `error`, "Derivative slip" |
| `y=sin(x) ;; y'=cos(x)` | `error` |
| `f(x)=x^3 ;; f'(x)=3x^2 ;; f''(x)=6x` | line 3 is `error` |
| `f(x)=x^3-3x ;; f'(x)=3x^2-3 ;; f'(x)=0 ;; 3x^2-3=0 ;; x=±1` | line 3 is `error` |
| `y'=0` | `error` |
| `f''(x)=6x` | `error` |

Why this happens:

- The postfix `'` is turned into `deriv(v='?')` of the operand. The variable is guessed from the operand's free variables.
- For `y'` the derivative of `y` with respect to `y` is 1, so `y'=2x` reads as `1=2x`.
- For `f''(x)` the derivative is taken of something that is not the defined function.
- `f'(x)=0` is read as an identity claim, but it is an equation to solve.

This is the standard curve-sketching workflow (set the derivative to zero, then take the second derivative).
A generated family of 150 cubic `f, f', f''` chains is red in 100% of blocks.

### FP-2: a rounded answer on its own line with `=`. Severity: critical (most frequent)

| Input | Verdict |
|---|---|
| `3x=7 ;; x=2.33` | `error`, "Not a solution" |
| `A=π·3^2 ;; A=28.27` | `error` |
| `x^2=2 ;; x=1.41` | `error` |
| `K=1000·1.05^3 ;; K=1157.63` | `error` |
| `1.05^x=2 ;; x=log(2)/log(1.05) ;; x=14.21` | `error` |
| `e^x=2 ;; x=0.693` | `error` |

The checker is inconsistent with itself here:

- `A=π·3^2=28.27`, `√2=1.41` and `100/7=14.29` are `ok` on one line.
- `O=2π·3 ;; O=18.85` is only `unsure`.
- `x=±1.41` is `unsure`.

Students write `=` for rounded results all the time, and teachers do not mark that as a wrong step. The
equation and solution-set path needs the same tolerance for rounding that the single-line path already has.

### FP-3: inverse trig written `sin^-1`, and degree-mode inverse trig. Severity: high

| Input | Verdict | What happens |
|---|---|---|
| `sin^-1(1)=π/2` | `error` | |
| `sin^-1(0.5)=π/6` | `error` | |
| `tan^-1(1)=π/4` | `error` | `f^-1` is parsed as the reciprocal `1/f` |
| `cos^-1(0.5)=60` | `error` | |
| `sin^-1(1)=90` | `error` | |
| `asin(0.5)=30` | `error` | |
| `sin(x)=0.5 ;; x=30` | `error` | `sin(30)=0.5` is accepted in degrees, so a degree answer here is inconsistent |

The reciprocal reading is also why `sin^-1(x)=1/sin(x)` gets a green tick (see the wrong greens below).

### FP-4: log with the base written inline. Severity: high

`log10(1000)=3`, `log10(100)=2`, `log10(10)=1`, `log2(8)=3` and `log 2(8)=3` are all `error`. They are read as
`log(10·1000)`. Meanwhile `lg100=2`, `log_2 8=3` and `log₂8=3` work. Handwriting recognisers often flatten a
subscript base into `log2`.

### FP-5: operation annotation without a bar. Severity: high

| Input | Verdict |
|---|---|
| `4x=12 :4 ;; x=3` | `error`, "Divided only one side" |
| `2x=8 /2 ;; x=4` | `error` |
| `x-3=4 +3 ;; x=7` | `error` |
| `x+3=7 (-3) ;; x=4` | `error` |
| `2x+3=7 \| -3 \| :2 ;; x=2` | `error` (two stacked annotations) |

The trailing annotation is absorbed into the right-hand side. The thin `|` is exactly the stroke a recogniser
drops, and a dropped bar comes back at full confidence. The family with a dropped bar is red in about 90% of
blocks. With the bar present (`| :a`), all 150 blocks are fine.

### FP-6: a new unlabelled problem right after a solved line. Severity: high

| Input | Verdict |
|---|---|
| `x+1=3 ;; x=2 ;; 2x+5=7` | line 3 is `error`, "Multiplied only one side" |
| `x+1=3 ;; x=2 ;; x+1=5` | `error`, "Divided only one side" |
| `x=2 ;; x+5=9` | `error` |

A solved form `x=c` ends a problem. The misconception detectors then fit the next, unrelated equation by
coincidence. The family is red in about 13% of blocks. A labelled version (`a)`, `1)`, `Nr. 2:`) is fine.

### FP-7: `e` as a variable. Severity: medium

`e=3`, `2e=6 ;; e=3` and `a=3 ;; e=2a ;; e=6` are all `error`, because `e` is always Euler's number. Geometry
uses `e` for an edge, and the recogniser can read a sloppy `c` as `e`. A line `e=<number>` is an assignment
and should never be an arithmetic falsehood.

### FP-8: calculator-style percent. Severity: medium

`50+20%=60`, `100-10%=90` and `200+5%=210` are `error`. This is a common notation that matches calculator
behaviour. It should be `unsure`.

### FP-9: dropped superscript on a pure-number line. Severity: medium

`23=8` (from `2^3=8`), `2^3=8 ;; 23=8` and `x=3 ;; x^2=9 ;; 32=9` are all red at confidence 0.97. The `x2=9`
form is already guarded, but the digit-only case is not. A cheap guard: if splitting the digits as `a^b`
satisfies the equation, return `unsure`.

## Wrong green ticks (`ok` on wrong work)

- `sin^-1(x)=1/sin(x)` is `ok`. This is the classic misconception and it gets confirmed (same cause as FP-3).
- `x>3 ;; x≥3` is `ok`. It is a weaker statement, not an equivalent one.

## Wrong live results (`evaluate`)

| Id | Input | Shown | Expected |
|---|---|---|---|
| LIVE-1 | `sin(30)=` | -0.9880316241 | 0.5. `checkSteps` accepts `sin(30)=0.5`, so the two are inconsistent |
| LIVE-1 | `cos(60)=` | -0.9524129804 | 0.5 |
| LIVE-1 | `tan(90)=` | -1.995200412 | undefined |
| LIVE-2 | `sin^-1(1)=` | 1.188395106 (that is 1/sin 1) | π/2 ≈ 1.570796327 |
| LIVE-3 | `tan(π/2)=` | 1.633124e16 | undefined (no result) |
| LIVE-4 | `e=5 ;; e+1=` | 3.718281828 | 6 (the assignment is ignored) |
| LIVE-4 | `pi=3 ;; pi+1=` | 4.141592654 | 4 |
| LIVE-5 | `log10(1000)=` | nothing | 3 (`lg(1000)=` works) |
| LIVE-5 | `x=1,5 ;; 2x=` | nothing | 3 (a decimal comma in an assignment is dropped) |

The other 42 `evaluate` probes were correct: big integers, exact fractions, `÷`/`:`, `%`, `|…|`, chained
assignments, and division by zero or log(0) returning nothing.

## `variant` findings

Answers were always right. I checked them by independent substitution over 12 problem shapes and 6 seeds.
Inequality flips are kept. The problems are not always the same shape, though:

- **VAR-1:** an identity `2(x+1)=2x+2` becomes a one-solution equation. The no-solution problem
  `x/(x-2)=2/(x-2)` becomes one with two solutions.
- **VAR-2:** decimal literals are replaced by integers (`x+0.25=1` becomes `x+3=1`, and `0.5x=2` becomes
  `2x=6`).
- **VAR-3:** `2x+3=7=` is echoed as `4x+5=13=`.
- **VAR-4:** a double root (`x^2-4x+4=0`) becomes two distinct roots.

## Recall misses (lower priority)

These are single-line algebra slips that come back `none` or `unsure` instead of `error`:

- `2x+3x=5x^2`, `x·x=2x`, `x^3·x^2=x^6`, `(3x)^2=3x^2`
- `2(x+3)=2x+3`, `-(x-2)=-x-2`, `(x+2)^2=x^2+4`, `(x-1)(x+1)=x^2+1`
- `x^-1=-x`, `√(x^2+9)=x+3`, `2x+4=2(x+4)`, `5-(2-x)=3-x`

Lost solutions are not flagged either: `x^3=x ;; x^2=1`, `x^2=9 ;; x=3` and `|x|=3 ;; x=3` are `unsure`.
`x+y=5 ;; x-y=1 ;; 2x=8` is also missed, because systems are not tracked at all.

Recall on standard step errors is otherwise good. 55 of the probed wrong blocks are red with sensible titles:
sign moves, inverse operations, inequality flips, fraction addition, order of operations, exponent and log
rules, and derivative rules.

## Ambiguous (not counted)

Some exercise lists with no labels are red: `x+3=7 ;; x-3=7`, `2x+3=7 ;; 2x+3=9` and `5x=15 ;; 5x=20`.
Read as steps they are wrong. Read as a list of separate problems they are not. Without layout cues the
checker cannot tell the two apart. Prefer `unsure` when the earlier line was not derived from anything,
because it is a first line or a bare problem statement.

## What held up well

- **Notation:** decimal commas, `÷` and `:`, `±`, unary minus chains, roots, rational exponents, logs with an
  explicit base, `≈` with rounding, scientific notation with `·10^`, and big integers. All are exact.
- **Units:** units are handled very conservatively, and every unit line probed came back `none`.
- **Restarts:** `⇒`/`∴`/`⇔` prefixes, `a)`/`(i)` labels, substitution checks with ✓, and annotations with `|`.
- **Equations:** quadratics, completing the square, biquadratics, abs equations, inequalities with flips, and
  set or interval answers.
- **Numerics:** domain-limited identities near singularities return `none`. There were no floating-point
  false reds with large coefficients.
- **Gates:** confidence below 0.9 and alternates with p ≥ 0.4 never gave red.

## Summary ranking

1. **FP-1 derivative notation** (critical): every second derivative and every `y'` is red.
2. **FP-2 rounded answers with `=`** (critical): the most frequent class in real homework.
3. **FP-5 annotation without a bar** (high): this is how a dropped `|` stroke shows up.
4. **FP-3 `sin^-1` and degree inverse trig** (high). It also gives a wrong green and a wrong live value.
5. **FP-4 `log10(…)`, `log2(…)`** (high).
6. **FP-6 a new problem after a solved line** (high).
7. FP-7 `e` as a variable, FP-8 percent shorthand and FP-9 dropped `^` (medium).
8. LIVE-1 to LIVE-5, the wrong greens, and VAR-1 to VAR-4 (medium).
9. Recall gaps (low).

**Recommendation:** do not ship local-cas red ink until FP-1 through FP-6 are fixed. Gate on this suite: every
`todo` here must pass, alongside a precision measurement on real notebook pages rather than generated corpora.
Until then, downgrade "Not a solution" and "Derivative slip" findings to `unsure` whenever the line involves
a decimal approximation or a prime.

---

# Round 2: attacks on the round-1 fixes

After the round-1 fixes (all 88 hand false reds resolved), the new heuristics became the attack surface. The
suite gained a `describe('round 2')` block in `tests/unit/mathcheck-redteam.test.ts` with 291 new hand cases
and 9 seeded families of 150 blocks each:

- 154 sound blocks and 83 wrong-and-caught blocks, all hard assertions that pass today;
- 26 false reds, 37 wrong green ticks and 24 recall misses, all `todo`;
- 15 good and 8 wrong live results, plus 1 spacing-invariance check.

The full file runs with 258 tests: 139 pass, 0 fail, 119 todo.

**Verdict:** the derivative resolution and the degree reading of `sin(30)` are solid. The rounding tolerance
is the weak point. It is too narrow, so whole-number, significant-figure and scientific-notation roundings
are still red. It is also too loose, so exact decimal answers that are off by one unit in the last digit get
a green tick.

## P0: new false reds

| Id | Example | Verdict | Why it is correct |
|---|---|---|---|
| R2-FP-1 | `K=1000·1.05^3 ;; K=1158` | `error` "Not a solution" | 1157.625 rounded to whole euros |
| R2-FP-1 | `A=π·5^2 ;; A=79`, `A=π·10^2 ;; A=314` | `error` | 78.54 → 79, 314.16 → 314 |
| R2-FP-1 | `x=12345/7 ;; x=1764`, `x^2=20000 ;; x=141` | `error` | rounded to a whole number |
| R2-FP-2 | `x=12345/7 ;; x=1760`, `x=1518/5 ;; x=304` | `error` | 3 significant figures |
| R2-FP-3 | `x=1/3000 ;; x=3.3·10^-4`, `x=6.02·10^23/3 ;; x=2.01·10^23` | `error` | scientific notation, 2–3 s.f. |
| R2-FP-4 | `f(x)=sin(x) ;; f(30)=0.5`, `f(x)=cos(x) ;; f(60)=0.5` | `error` "Arithmetic slip" | `sin(30)=0.5` is `ok`, but through a defined function it is radians-only |
| R2-FP-5 | `v=3t^2 ;; a=v'`, `y=2x+3 ;; m=y'=2`, `y=x^2 ;; k=y'` | `error` "Derivative slip" | naming a derivative is a definition, not an identity claim |

The "within one unit of the last digit" rule only helps when the answer has decimal places. The seeded
families show where it stops:

| Family | Red |
|---|---|
| p/q rounded to a whole number | 88% |
| p/q rounded to 3 significant figures | 97% |
| p/q in scientific notation | 61% |
| p/q rounded to 1, 2 or 3 decimal places | 0% |
| √n to 2 decimal places, both roots | 0% |

## Wrong green ticks: mistakes confirmed as `ok`

**R2-G-1: the exact answer is a short decimal, and an answer one unit off passes.**
- `x=0.1+0.2 ;; x=0.31`, `x=7.1+0.1 ;; x=7.19`, `x=99·1.1 ;; x=108.8` and `2x+3=7 ;; x=1.99` are all `ok`.
- `100x=1 ;; x=0.02` and `x^2=0.0001 ;; x=0.02` are `ok`, although the answer is twice the root.
- In the family test, 100% of exact one-decimal sums answered ±0.01 off are green, and 51% of `2x=odd`
  answers that are 0.1 off are green.
- **Fix:** when the exact root is a terminating decimal with no more digits than the student wrote, require
  an exact match. Treat the tolerance as rounding, not proximity: the written value must equal the root
  rounded to the written precision (`|x − r| ≤ ½` unit), not any value within 1 unit.

**R2-G-2: wrong rounding passes.** `3x=7 ;; x=2.34`, `x=56/6 ;; x=9.34` and `x=1/3000 ;; x=0.0004` are `ok`.
Truncations such as `x=2/3 ;; x=0.66` and `6x=1 ;; x=0.16` are `ok` too. In the family test, 31% of
answers rounded up by one unit get a green tick.

**R2-G-3: calculator in the wrong mode gets a green tick.** `sin(30)=-0.99`, `tan(45)=1.62`,
`sin(180)=-0.80` and `sin(1)≈0.017` are all `ok`. A line passes if it is right in either radians or degrees.
A degree/radian mix-up is the most common trig error in school. These lines should be `unsure` with a
"calculator mode?" hint.

**R2-G-4: the bar-less annotation reading rescues genuinely wrong lines, and only when there is a space.**

| Line | Verdict | What the student wrote |
|---|---|---|
| `2x=8 ;; x=4 -1` | `ok` | x = 3 |
| `2x+3=7 ;; 2x=4 +3` | `ok` | a sign error |
| `3x=9 ;; x=3 ·2` | `ok` | x = 6 |
| `2x+1=9 ;; 2x=8 /2 ;; x=2` | `ok` on every line | a wrong chain |

The same lines without the space are red. The recogniser's spacing is not evidence. A reading that relies
on the annotation should be at most `unsure` when the literal reading is wrong, and never `ok`.

## Recall lost (to `unsure` or `none`)

- **Exact answers off by more than one unit, now `unsure`.** `2x=5 ;; x=2.4`, `2x+3=7 ;; x=2.1`,
  `x+1.5=4 ;; x=2.4`, `x=10/4 ;; x=2.6` and `x^2=0.01 ;; x=0.2`. Before the tolerance rule, these were red.
- **Wrong rounding with `≈` is never checked.** `3x=7 ;; x≈3` is `none`.
- **A plain final answer ends the chain, so consequences are not checked.** `x+1=3 ;; x=2 ;; x^2=5`,
  `x=2 ;; y=x+1 ;; y=4` and `x=4 ;; 2x=9` are `none`, although `2x+3=7 ;; x=2 ;; 4x+6=14` is `ok`. The
  checker can see that a line follows from x=2, but stays silent when it does not. Wrong second roots
  (`(x-2)(x+3)=0 ;; x=2 ;; x=3`) are still caught.
- **Derivative definitions and higher orders.** `f(x)=x^2 ;; g(x)=f'(x) ;; g(x)=x` and
  `s(t)=t^3 ;; s'(t)=3t^2 ;; s''(t)=6` are `none`.
- **Percent and dropped-`^` alternates did not hide real errors.** `50+20%=70`, `23=6`, `42=8` and
  `x=3 ;; 32=6` stay red.

## Wrong live results (`evaluate`)

| Id | Input | Shown | Problem |
|---|---|---|---|
| R2-L-1 | `x=30 ;; sin(x)=`, `sin(2·15)=` | -0.988 | `sin(30)=` shows 0.5. The degree reading depends on how the 30 was written |
| R2-L-2 | `sin(7)+sin(6)=` | -0.1575 | 7 is read in degrees and 6 in radians, then the two are added |
| R2-L-3 | `sin(7.5)=` | 0.938 (radians) | `sin(7)=` gives 0.122 (degrees), so there is a jump |
| R2-L-4 | `asin(0.5)=` | 0.5236 | radians, while `sin(30)=` is degrees on the same page |
| R2-L-5 | `sin(180)=` | 1.224647e-16 | should be 0 |
| R2-L-6 | `50+20%=` | 50.2 | `checkSteps` lets `50+20%=60` through as `unsure` |

All round-1 live findings are fixed: `sin^-1(1)=`, `tan(π/2)=`, `e=5 ;; e+1=`, `log10(1000)=` and
`x=1,5 ;; 2x=`.

## What held up in round 2

- **Derivative resolution** from `f(x)=` and `y=` lines handles all of these correctly, and catches each
  wrong version: product and chain rule, quotient rule, redefinitions of `y` and `f`, a derivative of the
  wrong function, `y''` and `y'''`, `f'(2)`, and unicode primes (`′`, `’`, `´`).
- **Implicit differentiation** comes back `none`, never red.
- **The degree reading** of whole-number arguments, and degree answers to `sin(x)=…`, are consistent within
  `checkSteps`.
- **Wrong second roots and failing substitution checks** after a final answer are still red.

## Round-2 ranking

1. **R2-G-1 and R2-G-4** (P0 for trust): green ticks on wrong arithmetic and on wrong lines rescued by the
   annotation reading. A green tick on a mistake teaches the mistake.
2. **R2-FP-1 to R2-FP-3** (P0): roundings to a whole number, to significant figures and in scientific
   notation are red. These are common in physics and finance homework.
3. **R2-FP-4 and R2-FP-5** (P0): degree values through a defined function, and named derivatives (`a=v'`).
4. **R2-G-3** (wrong mode gets a green tick) and **R2-L-1 to R2-L-4** (inconsistent degree and radian live
   values).
5. **Recall regressions** from the tolerance rule and from the chain-ending rule.
