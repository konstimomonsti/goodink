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
