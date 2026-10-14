// Live Ink math checker: generated correct working (>= 2000 steps) must never be marked 'error';
// generated wrong steps must be caught; a 10-line block checks in < 5 ms. Deterministic (seeded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSteps, evaluate, variant } from '../../src/renderer/live/math/index.ts';
import type { LineRecognition } from '../../src/renderer/live/contract.ts';

const rec = (text: string, i: number): LineRecognition => ({
  lineId: 'l' + i, kind: 'math', text, latex: '', confidence: 0.97, alternates: [], tokens: [], source: 'local-ink',
});
const run = (lines: string[]) => checkSteps(lines.map(rec));

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = rng(20261014);
const int = (lo: number, hi: number, nz = false): number => { for (;;) { const v = lo + Math.floor(R() * (hi - lo + 1)); if (!nz || v !== 0) return v; } };
const pick = <T,>(xs: T[]): T => xs[Math.floor(R() * xs.length)];
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/** a·x as written: "3x", "-x", "x" */
const lin = (a: number, v = 'x') => (a === 1 ? v : a === -1 ? `-${v}` : `${a}${v}`);
/** "+3", "-3", "" */
const sgn = (b: number) => (b === 0 ? '' : b > 0 ? `+${b}` : `${b}`);
/** an exact rational as written: "3", "-5/2" */
const frac = (n: number, d: number) => { const g = gcd(n, d) || 1; let p = n / g, q = d / g; if (q < 0) { p = -p; q = -q; } return q === 1 ? `${p}` : `${p}/${q}`; };

/** families of correct working; each returns the lines of one block */
const FAMILIES: (() => string[])[] = [
  // a x + b = c  ->  a x = c - b  ->  x = (c-b)/a
  () => { const a = int(-9, 9, true), b = int(-12, 12, true), c = int(-20, 20); return [`${lin(a)}${sgn(b)}=${c}`, `${lin(a)}=${c - b}`, `x=${frac(c - b, a)}`]; },
  // a x + b = c x + d
  () => { let a = int(-9, 9, true), c = int(-9, 9, true); if (a === c) c = a + 1; const b = int(-15, 15), d = int(-15, 15); return [`${lin(a)}${sgn(b)}=${c === 0 ? '' : lin(c)}${c === 0 ? d : sgn(d)}`, `${lin(a - c)}=${d - b}`, `x=${frac(d - b, a - c)}`]; },
  // k(x + m) = n  ->  kx + km = n
  () => { const k = int(2, 9), m = int(-9, 9, true), n = int(-30, 30); return [`${k}(x${sgn(m)})=${n}`, `${k}x${sgn(k * m)}=${n}`, `${k}x=${n - k * m}`, `x=${frac(n - k * m, k)}`]; },
  // x/k + m = n  ->  x/k = n - m  ->  x = k(n-m)
  () => { const k = int(2, 9), m = int(-9, 9, true), n = int(-9, 9); return [`x/${k}${sgn(m)}=${n}`, `x/${k}=${n - m}`, `x=${k * (n - m)}`]; },
  // (x - r)(x - s) = 0 and its expanded form
  () => { const r = int(-9, 9), s = int(-9, 9); const m = -(r + s); const mid = m === 0 ? '' : m === 1 ? '+x' : m === -1 ? '-x' : `${sgn(m)}x`; return [`x^2${mid}${sgn(r * s)}=0`, `(x${sgn(-r)})(x${sgn(-s)})=0`, r === s ? `x=${r}` : `x=${r} or x=${s}`]; },
  // inequality a x + b < c with the flip when a < 0
  () => { const a = int(-6, 6, true), b = int(-10, 10, true), c = int(-10, 10); const op = pick(['<', '>', '≤', '≥']); const flip: Record<string, string> = { '<': '>', '>': '<', '≤': '≥', '≥': '≤' }; return [`${lin(a)}${sgn(b)}${op}${c}`, `${lin(a)}${op}${c - b}`, `x${a < 0 ? flip[op] : op}${frac(c - b, a)}`]; },
  // arithmetic facts
  () => { const a = int(2, 99), b = int(2, 99); return [pick([`${a}+${b}=${a + b}`, `${a}-${b}=${a - b}`, `${a}×${b}=${a * b}`, `${a}·${b}=${a * b}`, `${a * b}÷${a}=${b}`, `${a * b}/${b}=${a}`])]; },
  // fraction sums
  () => { const p = int(1, 9), q = int(2, 9), r = int(1, 9), s = int(2, 9); return [`(${p})/(${q})+(${r})/(${s})=${frac(p * s + r * q, q * s)}`]; },
  // decimals
  () => { const a = int(1, 99) / 10, b = int(1, 99) / 10; return [`${a}+${b}=${Math.round((a + b) * 10) / 10}`]; },
  // powers
  () => { const b = int(-5, 5, true), e = int(0, 5); return [`${b < 0 ? `(${b})` : b}^${e}=${b ** e}`]; },
  // expansions (x+a)(x+b)
  () => { const a = int(-9, 9, true), b = int(-9, 9, true); const m = a + b; return [`(x${sgn(a)})(x${sgn(b)})=x^2${m === 0 ? '' : m === 1 ? '+x' : m === -1 ? '-x' : `${sgn(m)}x`}${sgn(a * b)}`]; },
  // binomial squares as a lead chain
  () => { const a = int(-9, 9, true); return [`(x${sgn(a)})^2`, `=x^2${sgn(2 * a)}x${sgn(a * a)}`]; },
  // exponent rules
  () => { const m = int(1, 9), n = int(1, 9); return [pick([`x^${m}·x^${n}=x^${m + n}`, `(x^${m})^${n}=x^${m * n}`, `x^${m + n}/x^${n}=x^${m}`])]; },
  // derivatives of polynomials
  () => { const a = int(1, 9), n = int(2, 6), b = int(-9, 9, true); return [`d/dx(${a === 1 ? '' : a}x^${n}${sgn(b)}x)=${a * n}x${n - 1 === 1 ? '' : `^${n - 1}`}${sgn(b)}`]; },
  // distribution facts
  () => { const k = int(-9, 9, true), a = int(-9, 9, true); return [`${k}(x${sgn(a)})=${lin(k)}${sgn(k * a)}`]; },
  // multi-line with prose and checks
  () => { const r = int(-9, 9), a = int(2, 6), b = int(-9, 9, true); return [`${a}x${sgn(b)}=${a * r + b}`, `${a}x=${a * r}`, `x=${r}`, `${a}·${r < 0 ? `(${r})` : r}${sgn(b)}=${a * r + b}`]; },
];

test('fuzz: >= 2000 generated correct steps are never flagged', () => {
  let steps = 0;
  const fps: string[] = [];
  while (steps < 2400) {
    const block = pick(FAMILIES)();
    steps += Math.max(1, block.length - 1);
    const r = run(block);
    r.lines.forEach((l, i) => { if (l.verdict === 'error') fps.push(`${JSON.stringify(block)} line ${i}: ${r.issues.find((x) => x.lineId === l.lineId)?.title}`); });
  }
  assert.deepEqual(fps.slice(0, 20), []);
  assert.ok(steps >= 2000);
});

test('fuzz: generated wrong steps are caught (>= 90%) and never on the wrong line', () => {
  let n = 0, caught = 0;
  const misses: string[] = [];
  for (let k = 0; k < 400; k++) {
    const a = int(2, 9), b = int(1, 12), c = int(-20, 20);
    const kind = pick(['sign', 'value', 'distribute', 'fact', 'divide']);
    let block: string[];
    if (kind === 'sign') block = [`${a}x+${b}=${c}`, `${a}x=${c + b}`]; // moved +b without flipping
    else if (kind === 'value') block = [`${a}x=${a * c}`, `x=${c + int(1, 5)}`];
    else if (kind === 'distribute') block = [`${a}(x+${b})=${c}`, `${a}x+${b}=${c}`];
    else if (kind === 'divide') block = [`${a}x+${a * b}=${a * c}`, `x+${a * b}=${c}`];
    else { const x = int(2, 12), y = int(2, 12); block = [`${x}×${y}=${x * y + int(1, 9)}`]; }
    n++;
    const r = run(block);
    assert.ok(r.lines.slice(0, -1).every((l) => l.verdict !== 'error'), `error on a correct line: ${block}`);
    if (r.lines[r.lines.length - 1].verdict === 'error') caught++;
    else misses.push(`${JSON.stringify(block)} -> ${r.lines[r.lines.length - 1].verdict}`);
  }
  if (caught / n < 0.97) console.log(misses.slice(0, 15).join('\n'));
  assert.ok(caught / n >= 0.9, `recall ${caught}/${n}`);
});

test('latency: a 10-line block checks in < 5 ms (median, robust to parallel test load)', () => {
  const blocks = [
    ['3(2x-1)=4x+7', '6x-3=4x+7', '6x-4x=7+3', '2x=10', 'x=5', '3(2·5-1)=27', '4·5+7=27', 'x^2-5x+6=0', '(x-2)(x-3)=0', 'x=2 or x=3'],
    ['(x+1)^2', '=x^2+2x+1', '7×8=56', '1/2+1/3=5/6', 'd/dx(x^3)=3x^2', '2x+3=7', '2x=4', 'x=2', 'sin(x)^2+cos(x)^2=1', '√(16)=4'],
    ['2x+3=7', '2x=10', 'x=5', '4x-8=12', '4x=20', 'x=5', '(a+b)^2=a^2+b^2', '-2x<4', 'x<-2', '7×8=54'],
  ];
  for (let i = 0; i < 5; i++) for (const b of blocks) run(b); // warm up the JIT
  for (const b of blocks) {
    const times: number[] = [];
    for (let i = 0; i < 25; i++) { const t0 = performance.now(); run(b); times.push(performance.now() - t0); }
    times.sort((x, y) => x - y);
    const median = times[times.length >> 1];
    console.log(`latency median ${median.toFixed(2)} ms: ${b[0]} …`);
    assert.ok(median < 5, `${median.toFixed(2)} ms for ${JSON.stringify(b)}`);
  }
});

test('variant: generated problems are verified and nicely solvable', () => {
  for (const problem of ['2x+3=7', 'x^2-5x+6=0', '(3)/(4)+(1)/(4)=', '5x-4=3x+6', '4(x-1)=2(x+3)', '2x-5<7', '7×8=', '(x+2)(x-3)']) {
    for (let seed = 1; seed <= 20; seed++) {
      const v = variant(problem, seed);
      assert.ok(v, `${problem} seed ${seed}`);
      assert.notEqual(v.problem, problem);
      // the answer the variant claims must check out against the CAS as a step
      if (/^[a-z]=/.test(v.answer)) {
        const r = run([v.problem, v.answer]);
        assert.equal(r.lines[1].verdict, 'ok', `${v.problem} -> ${v.answer}`);
        for (const n of v.answer.match(/-?\d+/g) ?? []) assert.ok(Math.abs(Number(n)) <= 20 && Number.isInteger(Number(n)));
      }
    }
  }
  assert.equal(variant('hello', 1), null);
});

test('evaluate: live results after a trailing "=" with variables from earlier lines', () => {
  const lines = ['a=3', '2a+1=', 'b=a/2', 'a+b=', '1/3=', '√2=', '7×8=', 'x+1=', '2x+3=7'].map(rec);
  const out = evaluate(lines);
  const by = Object.fromEntries(out.map((o) => [o.lineId, o.value]));
  assert.deepEqual(by, { l1: '7', l3: '4.5', l4: '1/3', l5: '1.414213562', l6: '56' });
  assert.equal(out.find((o) => o.lineId === 'l4')!.latex, '\\frac{1}{3}');
  assert.deepEqual(evaluate([rec('r^2·π=', 0)], new Map([['r', '2']])).map((o) => o.value), ['12.56637061']);
  assert.deepEqual(evaluate([rec('2^40=', 0), rec('0.1+0.2=', 1)]).map((o) => o.value), ['1099511627776', '0.3']);
});
