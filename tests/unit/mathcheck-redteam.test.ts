// Red-team suite for the on-device math step checker (src/renderer/live/math/index.ts).
// Findings are written up in docs/live-ink/math-redteam.md.
//
// How to read this file:
//  - SOUND: correct working that the checker already handles. Every line must come back without 'error'.
//    These are hard assertions (regression guards).
//  - FALSE_POSITIVES: correct working the checker marks 'error' today. Each one is a `todo` test tagged with
//    its finding id (FP-n). It fails today; when the checker is fixed it turns green on its own.
//  - WRONG: work a teacher would mark. Recall misses are `todo` (lower priority than false reds).
//  - WRONG_GREEN: wrong work the checker marks 'ok' (a green tick on a mistake).
//  - LIVE / VARIANT: evaluate() and variant() checks; known wrong results are `todo`.
//  - FAMILIES: seeded generated families (deterministic); families that currently produce false reds are `todo`.
// Line syntax inside a block: lines are separated by ' ;; '. A line may end in `@0.85` (confidence) and/or
// `{{alt::p||alt2::p}}` (recogniser alternates with probabilities).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSteps, evaluate, variant } from '../../src/renderer/live/math/index.ts';
import type { LineRecognition } from '../../src/renderer/live/contract.ts';

function rec(raw: string, i: number): LineRecognition {
  let text = raw.trim(), confidence = 0.97;
  const alternates: string[] = [], alternateProbs: number[] = [];
  const m = text.match(/^(.*?)\s*(?:@([\d.]+))?\s*(?:\{\{(.*)\}\})?$/);
  if (m) {
    text = m[1];
    if (m[2]) confidence = Number(m[2]);
    if (m[3]) for (const a of m[3].split('||')) { const [t, p] = a.split('::'); alternates.push(t); alternateProbs.push(Number(p ?? 0.2)); }
  }
  return { lineId: 'l' + i, kind: 'math', text, latex: '', confidence, alternates, alternateProbs, tokens: [], source: 'local-ink' };
}
const run = (block: string) => checkSteps(block.split(' ;; ').map(rec));
const verdicts = (block: string) => run(block).lines.map((l) => l.verdict);
const reds = (block: string) => run(block).lines.flatMap((l, i) => (l.verdict === 'error' ? [i] : []));

// ---- SOUND: correct work the checker must never mark red --------------------------------------------

const SOUND: Record<string, string[]> = {
  notation: [
    '2,5+1,5=4', '2,5x=5 ;; x=2', '1,5+2,25=3,75', '50%·80=40', '20% of 50=10', '0.2·50=10', 'x·y=xy', '2(3)=6',
    '2(3)+1=7', 'a(b+c)=ab+ac', 'sin(2x)=2sin(x)cos(x)', '12÷4=3', '12:4=3', '6:2(1+2)=9', '--3=3', '5+-3=2', '5--3=8',
    'x^-1=1/x', 'x^(1/2)=√x', 'e^0=1', 'ln(e)=1', 'ln(1)=0', 'log_2(8)=3', 'log_2 8=3', 'log(100)=2', 'log 10=1',
    'lg(100)=2', 'lg100=2', 'log_10(1000)=3', 'log_{10}(1000)=3', 'log₂8=3', 'log(8)/log(2)=3', 'π≈3.14', '2π≈6.28',
    '√2≈1.41', '√2≈1.414', '1/3≈0.33', '1/3≈0.333', '2/3≈0.67', '2/3≈0.667', 'π·2^2≈12.57', '1.5×10^3=1500',
    '3·10^-2=0.03', '5 m+3 m=8 m', '5m+3m=8m', '3×2=6', '3 x 2=6', '5x4=20', '3x2=6', '2x3=6', '1/2x=1/(2x)',
    '1/2x=x/2', '8/2(2+2)=16', '8/2(2+2)=1', '1 1/2+2 1/4=3 3/4', '3½=7/2', '½+¼=¾', '2 1/2+1 1/2=4', 'f(1,2)=3',
    '0.333...=1/3', '0.(3)=1/3', '1.5e3=1500', 'sin(30°)=1/2', 'sin(90°)=1', 'cos(60°)=0.5', 'sin2x=2sinxcosx',
    '1,000+2,000=3,000', '1.000+2.000=3.000', '1.000·3=3.000', '3,14·2=6,28', '2·3,5=7', '(1,2)+(3,4)=(4,6)',
    '10 %=0.1', '15% von 200=30',
  ],
  arithmetic_and_numerics: [
    '2^10=1024', '2^100=1267650600228229401496703205376', '10^20+1=100000000000000000001', '0.1+0.2=0.3',
    '99999999999·99999999999=9999999999800000000001', '123456789·987654321=121932631112635269', 'sqrt(2)^2=2',
    '√8=2√2', '√12=2√3', '(-8)^(1/3)=-2', '∛8=2', '8^(1/3)=2', '3/4=0.75', '0.75=75%', '3/8=37.5%', '1/4=0.25=25%',
    '-3^2=-9', '(-3)^2=9', '2^3^2=512', '2^-2=1/4', '2^-2=0.25', '4^0.5=2', 'e^(ln2)=2', 'sin(π)=0', 'sin(π/6)=1/2',
    'cos(π/3)=1/2', 'tan(π/4)=1', '100/7≈14.29', '100/7=14.29', '100/7≈14.3', '1/7≈0.142857', '22/7≈3.14', 'e≈2.718',
    'e≈2.72', 'e^2≈7.39', 'ln2≈0.693', 'ln(2)≈0.69', 'sin(1)≈0.84', '√50≈7.07', '1000000/3≈333333.33',
    '1/3000≈0.000333', '1/3000≈3.33·10^-4', '6.02·10^23·2=1.204·10^24', '1.2·10^-3+3·10^-4=1.5·10^-3',
    '0.0000001+0.0000002=0.0000003', 'π·5^2=78.5', '3.14·5^2=78.5', 'π·5^2≈78.54', 'π·5^2=78.54', '√2=1.41',
    '√2=1.414', 'π=3.14', 'π=3.14159', '2/3=0.67', '2/3=0.6667', '1/3=0.33', '2/3≈0.66', '100/7≈14',
    '√(16)=4', '√16=4', '-√16=-4', '∛-8=-2', '∛(-27)=-3', '(-27)^(1/3)=-3', '16^(3/4)=8', '27^(-2/3)=1/9',
    '(1/4)^(-1/2)=2', '0.1^3=0.001', '1.1^2=1.21', '(0.5)^-2=4', '(2/3)^2=4/9', '(-1/2)^3=-1/8', '1/2^2=1/4',
    '2/3^2=2/9', '(2/3)^-1=3/2', '3^-1+3^-1=2/3', 'log_4(2)=1/2', 'log_2(1/8)=-3', 'log_3(81)=4', 'log_5(1)=0',
    'log(1000)=3', 'log(2)+log(5)=1', 'ln(1/e)=-1', 'log_2(32)-log_2(4)=3', 'log_0.5(4)=-2', '1/2+1/3=5/6',
    '1/2+1/3=3/6+2/6=5/6', '2/3·3/4=1/2', '2/3:4/5=10/12=5/6', '2/3÷4/5=5/6', '3/4-1/2=1/4', '0.5+1/4=0.75',
    '(1/2)/(3/4)=2/3', '1/2/3/4=1/24', '6/2·3=9', '6÷2·3=9', '5!=120', '3!·2=12', '√2<1.5', 'π>3', '1/3<0.34',
    '2^10>1000', '(1+2)^2≠1^2+2^2', '2^3≠3^2', '1/2+1/3≠2/5', '3+4·2≠14', '2^3=8≠6', '-2^2=-4', '-2²=-4',
    '2^1000/2^999=2', '10^-300·10^300=1', '(1+1/1000000)^1000000≈2.718', 'sin(30)=0.5', 'sin30=1/2', 'cos(60)=0.5',
    'tan(45)=1', 'sin(90)=1', 'cos(0)=1', 'sin^2(30)=0.25', 'arcsin(0.5)=π/6', '1/0=∞', 'e^1000=e^1000',
    '1/3=0.3', '1/3=0.333', '0.999...=1', 'x=1/0', 'x/0.2=5 ;; x=1',
  ],
  identities: [
    'x/x=1', '(x^2-1)/(x-1)=x+1', 'x^2-1=(x-1)(x+1)', 'x^3-8=(x-2)(x^2+2x+4)', '√(x^2)=|x|', '-(-x)=x',
    '-x^2=-(x^2)', '(-x)^2=x^2', 'sin(x)/cos(x)=tan(x)', 'sin^2x+cos^2x=1', 'sin²(x)+cos²(x)=1', 'log(ab)=log(a)+log(b)',
    'ln(x^2)=2ln(x)', '(a+b)^2=a^2+2ab+b^2', '(a-b)^2=a^2-2ab+b^2', '(a+b)(a-b)=a^2-b^2', '(a+b)^3=a^3+3a^2b+3ab^2+b^3',
    'a^m·a^n=a^(m+n)', '(a^m)^n=a^(mn)', 'a^2·a^3=a^5', 'x^2·x^3=x^5', '(2x)^3=8x^3', '√(ab)=√a·√b', 'a/b/c=a/(bc)',
    '√x·√x=x', '(√x)^2=x', '√(x^2)=x', 'ln(e^x)=x', 'e^(ln x)=x', 'x^0=1', '1/(1/x)=x', '(x^(1/2))^2=x',
    '(-8)^(2/3)=4', 'x^(2/3)=(x^2)^(1/3)', '|x|^2=x^2', '√(x^2y^2)=xy', '√(x^2y^2)=|xy|', 'a^(log_a(x))=x',
    '2^(log_2(x))=x', 'cos(2x)=1-2sin^2(x)', 'cos(2x)=cos^2(x)-sin^2(x)', 'sin(x+π)=-sin(x)', 'tan(x)=sin(x)/cos(x)',
    '1/(x-1)-1/(x+1)=2/(x^2-1)', '(x^10-1)/(x-1)=x^9+x^8+x^7+x^6+x^5+x^4+x^3+x^2+x+1', '1/(x-1e-9)=1/(x-1e-9)',
    'x^2/x=x', '(x^3-x)/(x^2-1)=x', 'sec(x)=1/cos(x)', '1+tan^2(x)=sec^2(x)', 'csc(x)=1/sin(x)', 'cot(x)=cos(x)/sin(x)',
    'sinh(x)=(e^x-e^-x)/2', 'x^(1/3)=∛x', '√(x-5)·√(x-5)=x-5', 'ln(x-10)+ln(x-10)=2ln(x-10)', '(√(x-100))^2=x-100',
    'ln((x-50)^2)=2ln(x-50)', '(x+1000)^2=x^2+2000x+1000000',
    '(x+100000)^3=x^3+300000x^2+30000000000x+1000000000000000',
    '(100000000x+1)^2=10000000000000000x^2+200000000x+1', '(x-0.001)^2=x^2-0.002x+0.000001',
    '1/(x^2+1)+x^2/(x^2+1)=1', 'sin(1000x)^2+cos(1000x)^2=1', 'x^50/x^49=x', 'e^(x^2)·e^(-x^2)=1',
    '√(x^2+2x+1)=|x+1|', '1/(1/(1/x))=1/x', 'tan(x)·cos(x)=sin(x)', '1/sin(x)^2-1=cot(x)^2', 'x^x=e^(x·ln x)',
    '(-x)^(1/3)=-x^(1/3)', '|x-3|=|3-x|', 'asin(x)+acos(x)=π/2', 'r(x+1)=r·x+r', '2x+4=2(x+2)', 'x/2=x/2',
    'x+1>x', '(a+b)^2=a^2+2ab+b^2', 'd/dx(x^2)=2x', 'd/dx(sin x)=cos x', 'd/dx sin(x)=cos(x)', 'd/dx(x^3)=3x^2',
    "(x^3)'=3x^2", "(e^x)'=e^x", "(ln x)'=1/x", "(x^2·sin x)'=2x·sin x+x^2·cos x", '∫2x dx=x^2+C', '∫x dx=x^2/2+C',
  ],
  linear_steps: [
    '2x+3=7 ;; 2x=4 ;; x=2', 'x+3=7 ;; ⇒ x=4', 'x+3=7 ;; → x=4', 'x+3=7 ;; ∴ x=4', 'x+3=7 ;; x+3=7 ;; x=4',
    'x+3=7 ;; x=4 ;; 2x=10 ;; x=5', 'a) x+3=7 ;; x=4 ;; b) 2x=10 ;; x=5', '(i) x+3=7 ;; x=4',
    'x+3=7 ;; x=4 ;; 4+3=7 ✓', '2x+3=7 ;; x=2 ;; 2(2)+3=7', 'y=2x+3 ;; x=(y-3)/2', 'x+3=7 ;; x=7-3 ;; x=4',
    '2x=6 ;; x=3 ;; 3x=12 ;; x=4', 'x+3=7 ;; x=4 ;; y-2=5 ;; y=7', '2+3=5 ;; 4·5=20', '3+4=7 ;; 7·2=14',
    '5+3=8 ;; 8+2=10', '12/4=3 ;; 3+2=5', 'x/(x+1)=2 ;; x=2(x+1) ;; x=2x+2 ;; x=-2', '1/x+1/2=1 ;; 2+x=2x ;; x=2',
    '(x+1)/x=3 ;; x+1=3x ;; 1=2x ;; x=1/2', '2x=3 ;; x=1,5', '2x=3 ;; x=1.5', '0,2x=1 ;; x=5', 'x=2,5 ;; 2x=5',
    '2x=5 ;; x=2,5', '2x=5 ;; x=5/2 ;; x=2,5', 'x=1.5 ;; 2x=3', '2x+3=7 ;; 2x=4 ;; x=2 ✓',
    '2x+3=7 ;; 2x=4 ;; x=2 ;; Probe: 2·2+3=7', '2x+3=7   | -3 ;; 2x=4   | :2 ;; x=2', '2x+3=7 |·2 ;; 4x+6=14',
    'x/3=4 |·3 ;; x=12', '-x=5 | ·(-1) ;; x=-5', '2x=8 |÷2 ;; x=4', '2x=8 |:2 ;; x=4', '2x=8 | /2 ;; x=4',
    'x/3=4 | ·3 ;; x=12', 'x/3=4 | *3 ;; x=12', '3x-2=7 | +2 ;; 3x=9 | :3 ;; x=3', 'x-3=4 | +3 ;; x=7',
    '2(x+1)=10 | :2 ;; x+1=5 | -1 ;; x=4', 'x+3=7 ⇔ x=4', 'x+3=7 <=> x=4', 'x+3=7 ⇒ x=4 ⇒ x^2=16',
    'x+3=7 ;; x=7+-3', 'x+3=7 ;; x=7+(-3)', 'x+3=7 ;; x=7−3', '5x=20 ;; x=4 ;; 5·4=20', '5x=20 ;; x=4 ;; 5×4=20',
    '5x=20 ;; x=4 ;; 5x4=20', '5x=20 ;; x=4 ;; 5(4)=20', '5x=20 ;; x=4 ;; 5*4=20', 'x+3=7 ;; x+3-3=7-3 ;; x=4',
    '2x+3=7 ;; 2x+3-3=7-3 ;; 2x=4 ;; (2x)/2=4/2 ;; x=2', '2x=4 ;; 2x/2=4/2 ;; x=2', '2x=4 ;; x=4/2=2',
    'x+2=2x-1 ;; 3=x', '2x+3=7 ;; 2·2+3=7 ;; 7=7', 'x+3=7 ;; 4+3=7 ;; x=4', 'x+3=7 ;; x=7-3=4',
    'x=5 ;; 2x+1=11 ;; 11=11', '2x+3=2x+5 ;; 3=5 ;; no solution', '2x+4=2(x+2) ;; 0=0 ;; all x', 'a=3 ;; 2a+1=7',
    'x=4 ;; 2x=8', 'x+1=5 ;; x=4 ;; x=4', 'x+2=5 ;; x=3 ;; x+2=5 ;; 3+2=5', 'x+y=10 ;; x=10-y',
    'x+y=5 ;; 2x+2y=10', 'y=2x ;; x+y=9 ;; x+2x=9 ;; 3x=9 ;; x=3', '3x+2y=12 ;; y=(12-3x)/2 ;; y=6-1.5x',
    'x+e=5 ;; x=5-e', 'y-1=2(x-1) ;; y=2x-1', 'u=x+1 ;; x=u-1', '2x=4 cm ;; x=2 cm', 'x=5 cm ;; 2x=10 cm',
    '3x+1=10 ;; x=3 ;; y=2x ;; y=6', 'y=2x+1 ;; y=7 ;; 2x+1=7 ;; x=3',
    'x+1=3 ;; x=2 ;; 3x=9', 'x+1=3 ;; x=2 ;; x^2=9', 'x+1=3 ;; x=2 ;; 4x-3=9', 'a) x+1=3 ;; x=2 ;; b) 2x+5=7 ;; x=1',
    '1) x+1=3 ;; x=2 ;; 2) 2x+5=7 ;; x=1', '3x=7 ;; x=7/3 ;; x≈2.33', '3x=7 ;; x≈2.33', '3x=7 ;; x≈2,33',
    '3x=7 ;; x≈2.333', '3x=7 ;; x=2.3̅', '3x=7 ;; x=2 1/3', 'A=π·3^2 ;; A=9π ;; A≈28.3', 'A=3.14·5^2 ;; A=78.5',
    'A=π·3^2 ;; A≈28', 'A=π·3^2=28.27', 'A=π·3^2=28.3', 'K=1000·1.05^3=1157.63', 'U=2πr=2π·3=18.85',
    'V=4/3·π·3^3=113.1', 'V=4/3πr^3 ;; V=4/3π·27=36π', '4πr^2=36π ;; r^2=9 ;; r=3', 'e^x=5 ;; x=ln(5) ;; x≈1.61',
    '1.05^x=2 ;; x≈14.2', 'x^2=2 ;; x≈1.41 ;; x≈±1.41', 'x^2=10 ;; x≈±3.16', 'x^2=2 ;; x≈1.414 or x≈-1.414',
    'c=√(5^2+7^2) ;; c=8.6', 'O=2πr ;; O=2π·3 ;; O=18.85', 'tan(α)=3/4 ;; α=36.87°', 'sin(α)=0.5 ;; α=30°',
    'sin(x)=0.3 ;; x=17.46°', '2sin(x)=1 ;; sin(x)=1/2 ;; x=30°', 'sin(x)=0.5 ;; x=π/6', 'cos(x)=0 ;; x=π/2',
  ],
  nonlinear_steps: [
    'x^2-5x+6=0 ;; (x-2)(x-3)=0 ;; x=2 or x=3', 'x^2=9 ;; x=±3', '|x|=3 ;; x=3 or x=-3', '|x-1|<2 ;; -1<x<3',
    'x^2+x-6=0 ;; x=2 or x=-3', 'x^2+x-6=0 ;; x∈{2,-3}', 'x^2-1<0 ;; -1<x<1', 'x^2-1<0 ;; x∈(-1,1)',
    'x^2+x-6=0 ;; x={2,-3}', 'x^2-5x+6=0 ;; x=2 ;; x=3', 'x^2-5x+6=0 ;; x₁=2 ;; x₂=3', 'x^2-5x+6=0 ;; x1=2 ;; x2=3',
    'x^2-5x+6=0 ;; x_1=2, x_2=3', 'x^2-5x+6=0 ;; x=3, x=2', 'x^2-5x+6=0 ;; x=2,3', 'x^2-5x+6=0 ;; x=2 ∨ x=3',
    'x^2-5x+6=0 ;; x=2 v x=3', 'x^2-5x+6=0 ;; x=2 or 3', 'x^2-5x+6=0 ;; L={2;3}',
    'x^2-5x+6=0 ;; (x-2)(x-3)=0 ;; x-2=0 ;; x=2', 'x^2-5x+6=0 ;; (x-2)(x-3)=0 ;; x=2 ;; x=3',
    'x^2-5x+6=0 ;; x=(5±√(25-24))/2 ;; x=(5±1)/2 ;; x=3 or x=2', 'x^2-5x+6=0 ;; x=(5±1)/2 ;; x₁=3 ;; x₂=2',
    'x^2-5x+6=0 ;; D=25-24=1 ;; x=(5±1)/2', 'x^2+5x+6=0 ;; a=1, b=5, c=6 ;; D=b^2-4ac ;; D=1',
    'x^2+5x+6=0 ;; a=1 ;; b=5 ;; c=6 ;; D=25-24 ;; D=1', 'x^2-4x=0 ;; x(x-4)=0 ;; x=0 ;; x-4=0 ;; x=4',
    'x^2=2x ;; x^2-2x=0 ;; x(x-2)=0', '√(x+2)=x ;; x+2=x^2 ;; x^2-x-2=0 ;; x=2 or x=-1 ;; x=2', '√x=3 ;; x=9',
    '2^x=8 ;; x=3', '2^x=8 ;; 2^x=2^3 ;; x=3', 'e^x=5 ;; x=ln5', '3^(x+1)=27 ;; x+1=3 ;; x=2', 'log(x)=2 ;; x=100',
    'ln(x)=0 ;; x=1', 'log_2(x)=3 ;; x=8', 'ln(x)+ln(2)=ln(6) ;; ln(2x)=ln(6) ;; 2x=6 ;; x=3',
    'ln(x^2)=2 ;; 2ln(x)=2 ;; ln(x)=1 ;; x=e', 'x^2=16 ;; x=4 (length)', 'x^2=16 ;; √(x^2)=√16 ;; x=4',
    'x^2=16 ;; |x|=4 ;; x=±4', 'x^3=8 ;; x=2', 'x^4=16 ;; x=±2', 'x^4=16 ;; x^2=4 ;; x=±2', 'x^2+1=0 ;; x^2=-1',
    'x^2+1=0 ;; no real solution', 'x^2+1=0 ;; x=±i', '(x-1)(x+2)=0 ;; x=1 ;; x=-2', '2x-4>0 ;; 2x>4 ;; x>2',
    '-2x+4>0 ;; -2x>-4 ;; x<2', '3-x≤5 ;; -x≤2 ;; x≥-2', 'x/(-2)>3 ;; x<-6', '-x/2<1 ;; x>-2',
    'x^2>4 ;; x>2 or x<-2', 'x^2≥9 ;; |x|≥3', 'x^2<4 ;; -2<x<2', 'x^2<4 ;; |x|<2', '2<x+1<5 ;; 1<x<4',
    '-3<2x+1<7 ;; -4<2x<6 ;; -2<x<3', '1/x>2 ;; 0<x<1/2', '-2x<6 ;; x>-3', '-x>3 ;; x<-3',
    '|2x-1|=5 ;; 2x-1=5 or 2x-1=-5 ;; x=3 or x=-2', '|x+2|=0 ;; x=-2', '|x|=-1 ;; no solution', '|x-3|=x-3 ;; x≥3',
    '2x+y=7 ;; x-y=2 ;; 3x=9 ;; x=3 ;; y=1', 'x+2y=8 ;; 2x+y=7 ;; x=2 ;; y=3', 'x+y=10, x-y=2 ;; 2x=12 ;; x=6 ;; y=4',
    'I: x+y=5 ;; II: x-y=1 ;; I+II: 2x=6 ;; x=3', 'x+y=5 ;; x-y=1 ;; 2y=4',
    'x^2+6x+5=0 ;; x^2+6x=-5 ;; x^2+6x+9=4 ;; (x+3)^2=4 ;; x+3=±2 ;; x=-1 or x=-5',
    'x^2+6x+5=0 ;; (x+3)^2-4=0 ;; (x+3)^2=4', '2x^2-8x+6=0 ;; x^2-4x+3=0 ;; (x-1)(x-3)=0',
    '2x^2+3x-2=0 ;; x=(-3±√(9+16))/4 ;; x=(-3±5)/4 ;; x=1/2 or x=-2', 'x^2-2x-1=0 ;; x=1±√2',
    'x^2-2x-1=0 ;; x=(2±√8)/2 ;; x=1±√2', 'x^2-2x-1=0 ;; x≈2.41 or x≈-0.41', 'x^2-2x-1=0 ;; x=2.41 or x=-0.41',
    'x^2+x+1=0 ;; D=1-4=-3 ;; D<0', 'x^2-4x+4=0 ;; (x-2)^2=0 ;; x=2', 'x^2-3x=0 ;; x(x-3)=0 ;; x₁=0 ;; x₂=3',
    'x^4-5x^2+4=0 ;; u=x^2 ;; u^2-5u+4=0 ;; u=1 or u=4 ;; x=±1 or x=±2',
    'x^4-5x^2+4=0 ;; (x^2-1)(x^2-4)=0 ;; x=±1 or x=±2', 'x^3-6x^2+11x-6=0 ;; (x-1)(x^2-5x+6)=0 ;; (x-1)(x-2)(x-3)=0',
    'x^3-x=0 ;; x(x^2-1)=0 ;; x(x-1)(x+1)=0 ;; x=0 or x=1 or x=-1', 'x^3-x=0 ;; x=0, x=1, x=-1',
    'x^3-x=0 ;; x=0 ;; x^2=1 ;; x=±1', 'x>2 ;; x∈(2,∞)', 'x>2 ;; x∈]2;∞[', 'x≥2 ;; [2,∞)', 'x<3 and x>1 ;; 1<x<3',
    'x=e^2 ;; ln(x)=2', 'x^2=4 ;; x=2 (x>0)', 'x^2=9 ;; x=±3 ;; x=3 or x=-3', 'x^2-9=0 ;; x^2=9 ;; x=3 ;; x=-3',
  ],
  functions_and_calculus: [
    'f(x)=x^2 ;; f(3)=9', 'f(x)=2x+1 ;; f(2)=5', 'f(x)=x^2+1 ;; f(2)=5 ;; f(3)=10', "f(x)=x^2+1 ;; f'(x)=2x",
    "f(x)=3x^2+2x ;; f'(x)=6x+2 ;; f'(1)=8", 'g(x)=2x ;; g(3)=6', 'f(x)=2x ;; g(x)=x+1 ;; f(g(1))=4',
    'f(x)=x+1 ;; f(x)=0 ;; x=-1', 'f(x)=x^2-4 ;; f(x)=0 ;; x^2-4=0 ;; x=±2', 'f(x)=2x+1 ;; f(x)=7 ;; 2x+1=7 ;; x=3',
    'f(x)=2x+1 ;; y=2x+1 ;; x=(y-1)/2 ;; f^-1(x)=(x-1)/2', 'h(t)=-5t^2+20t ;; h(2)=20', 'y=x^2 ;; dy/dx=2x',
    'f(x)=x^2 ;; f(x+1)=(x+1)^2', 'f(x)=x^2 ;; f(x+1)=x^2+2x+1', 'f(x)=x^2 ;; f(-x)=x^2', 'f(x)=3x ;; f(a)=3a',
    'f(x)=2x+3 ;; f(x)=2(x+1.5)', 'f(x)=x^2+1 ;; f(x)=10 ;; x^2=9 ;; x=±3', 'f(x)=x^2 ;; g(x)=f(x)+1 ;; g(2)=5',
    "f(x)=x^3-3x ;; f'(x)=3x^2-3 ;; 3x^2-3=0 ;; x=±1", "f(x)=x^2-4x ;; f'(x)=2x-4=0 ;; x=2", 'f(x)=x^2 ;; f(x)=x·x',
    's(t)=5t^2 ;; v(t)=10t ;; v(2)=20', "s(t)=5t^2 ;; s'(t)=10t", 'p(x)=x^2-1 ;; p(1)=0',
    "f(x)=(x+1)^2 ;; f(x)=x^2+2x+1 ;; f'(x)=2x+2", 'x(t)=3t ;; x(2)=6', 'y(x)=2x ;; y(3)=6', 'a(b+c)=3 ;; ab+ac=3',
    "f(x)=x^3 ;; f'(x)=3x^2 ;; f'(2)=12", "f(x)=x^3 ;; f'(2)=12", "f(x)=x^2 ;; f'(x)=2x ;; f'(3)=6",
    "f(x)=x^2 ;; f'(x)=2x ;; 2x=0 ;; x=0", "f(x)=x^2-2x ;; f'(x)=2x-2 ;; f'(1)=0", 'y=3x^2 ;; dy/dx=6x',
    "y=3x^2 ;; y'(x)=6x", "f(x)=x·e^x ;; f'(x)=e^x+x·e^x", "f(x)=x·e^x ;; f'(x)=e^x(1+x)", "f(x)=ln(x) ;; f'(x)=1/x",
    "f(x)=√x ;; f'(x)=1/(2√x)", "f(x)=1/x ;; f'(x)=-1/x^2", "f(x)=(2x+1)^3 ;; f'(x)=6(2x+1)^2", "f'(x)=3x^2-3",
    "f'(x)=0", 'u=x+1 ;; u^2=(x+1)^2', 'let u=x+1', 'let u=2x ;; du=2dx', 'x=2t ;; y=3t ;; y=3x/2', 'F=ma ;; F=2·3=6',
    'v=s/t ;; v=100/20=5', 's=1/2·a·t^2 ;; s=1/2·10·2^2=20', 'E=mc^2', 'P(A)=0.3 ;; P(not A)=0.7', 'C(5,2)=10',
  ],
  units_and_formulas: [
    '2 km=2000 m', '2km=2000m', '1 m=100 cm', '1m=100cm', '1 h=60 min', '3 cm·4 cm=12 cm²', '3cm·4cm=12cm^2',
    '5 kg+300 g=5.3 kg', '5kg+300g=5300g', '1 L=1000 mL', '1l=1000ml', '60 km/h·2 h=120 km', 'v=120 km/2 h=60 km/h',
    'A=3 m·4 m=12 m²', 'A=l·b ;; A=3·4=12', 'A=l·w=5·3=15', 'V=a^3=2^3=8', 'U=2·(a+b)=2·(3+4)=14', 's=v·t=50·3=150',
    'I=U/R=12/4=3', 'F=m·a=2·9.81=19.62', 'P=U·I=230·2=460', 'd=√((3-0)^2+(4-0)^2)=5', 'm=(5-1)/(3-1)=2',
    '1.5 h=90 min', '2 cm=20 mm', '1 kg=1000 g', '3 m+50 cm=3.5 m', '3 m+50 cm=350 cm', '1 t=1000 kg', '5 s·2=10 s',
    '3 g+2 g=5 g', '1 a=100 m²', '2 d=48 h', '1 Std=60 min', '2 dm=20 cm', '5€·3=15€', '$5·3=$15', '5$+3$=8$',
    'c^2=3^2+4^2 ;; c^2=25 ;; c=5', 'c=√(3^2+4^2)=5', 'c^2=a^2+b^2 ;; c^2=9+16 ;; c=5',
    'c^2=a^2+b^2 ;; c=√(a^2+b^2) ;; c=√(9+16) ;; c=5', 'a=3 cm, b=4 cm ;; c=5 cm', 'd=2r ;; d=6', 'E=5+3=8',
    'Δx=2 ;; Δy=4 ;; m=Δy/Δx=2', 'v_0=5 ;; v=v_0+at', 'x_1+x_2=5 ;; x_1·x_2=6', 'x1+x2=5', 'ab=6 ;; a=2 ;; b=3',
  ],
  layout_and_restarts: [
    '(x+1)^2 ;; =x^2+2x+1', '(x+1)^2 ;; x^2+2x+1', '3x+2 ;; x-1', '2x+3x ;; =5x', '2x+3x ;; 5x ;; 4y-y ;; 3y',
    '3+4 ;; 7', '3+4 ;; 8·2', '12 ;; 15', 'x+1 ;; y+2', '2(x+3) ;; 2x+6 ;; 3(x-1) ;; 3x-3', 'x=2 ;; 3', 'x+3=7 ;; 4',
    'x+3=7 ;; 7-3 ;; 4', '2x=10 ;; 10/2 ;; 5', '5 ;; 10 ;; 15', '1, 2, 3, 4', '2, 4, 8, 16', 'a_n=2n ;; a_3=6',
    'a_1=3 ;; a_2=5', '(3+4)·2 ;; =7·2 ;; =14', '=7·2 ;; =14', '= 3+4 ;; = 7', '2·(3+4)=2·7=14 ;; =15-1',
    '2+3=5 ;; =5', '2+3 ;; =5 ;; ·2 ;; =10', 'x(x+1) ;; =x^2+x', 'x=3 ;; y=5', 'x=4 ;; x=5', 'x=4 ;; y=5 ;; x+y=9',
    'x=2 ;; 3x=9', 'x=2 ;; 2x=6', 'y=3 ;; 2y=8', 'x+3=7 ;; 2x+1=11', 'x+3=7 ;; 2x+1=11 ;; 2x=10 ;; x=5', '2x=8 ;; 3x=9',
    '3x=12 ;; 4x=12', '2x+3=7 ;; x=2 ;; 2x-3=7 ;; x=5', 'x+3=7 ;; x=4 ;; x-3=7 ;; x=10', 'x+1=3 ;; x=2 ;; x/2=3',
    'x+1=3 ;; x=2 ;; x+4=10', 'x+1=3 ;; x=2 ;; x-5=1', 'x+1=3 ;; x=2 ;; Nr. 2: 2x+5=7', '2x+3=7 ;; 2x=4 ;; x=2 ;; 3x+3=9',
    'Answer: x=2', '2x=4 ;; Answer: x=2', '2x=4 ;; A: x=2', '2x=4 ;; Antwort: x=2', '2x=4 ;; L={2}', '2x=4 ;; S={2}',
    '2x=4 ;; x=2 cm', '(a+b)^2=a^2+b^2 ?', '(a+b)^2=a^2+b^2? ;; (1+2)^2=9 ;; 1^2+2^2=5 ;; 9≠5', '(a+b)^2≠a^2+b^2',
    '√(a+b)≠√a+√b', 'x+3=7 ;; x≠4', 'x≠0', 'x=4 (4+3=7)', '2^x=8 ;; 2^1=2 ;; 2^2=4 ;; 2^3=8 ;; x=3',
    'x^2-5x+6=0 ;; try x=1 ;; 1-5+6=2 ;; try x=2 ;; 4-10+6=0', '√(x+2)=x ;; x=2 or x=-1 ;; x=-1 ;; x=2',
    'x=-3 ;; x^2=9', 'x=-3 ;; -x^2=-9', '-x^2 ;; x=3 ;; -9', 'max=3', 'sin=0.5', 'n!=n(n-1)!', 'x=5, y=2', 'x=2; y=3',
    'x=2 and y=3', '2x+3=7 ;; -3 -3 ;; 2x=4', '2x+3=7 ;; 2x=4 ;; :2 ;; x=2', '2x=8 /:2 ;; x=4', '2x=8 //:2 ;; x=4',
    '2x=8 ||:2 ;; x=4', 'x/3=4 | x3 ;; x=12', 'x^2=9 | √ ;; x=±3', 'x^2=9 | √ ;; x=3', '3x=9 /:3 ;; x=3',
  ],
  recogniser_noise: [
    '2x+3=7 ;; 2×=4', '2x+3=7 ;; 2x=4 ;; ×=2', '2x+3=7 ;; 2x=4 ;; x=Z', '2x+3=7 ;; 2x=4 ;; x=z', 'x+l=5 ;; x=4',
    'x+1=5 ;; x=l', '2x=1O ;; x=5', '2x=10 ;; x=S', '2x+3=7 ;; 2x=4 ;; x=2 @0.95 {{x=z::0.3}}', 'x2=9 ;; x=3',
    'x2+2x+1=0 ;; (x+1)2=0', 'x2+2x+1=0 ;; (x+1)^2=0', 'x^2+2x+1=0 ;; (x+1)2=0', 'x^2-9=0 ;; x2=9',
    'x^2+2x+1=0 ;; (x+1)^2=0 @0.85', '2x+3=7 ;; 2x=10 @0.95 {{2x=4::0.3}}', '2x+3=7 @0.5 ;; 2x=10 @0.95',
    '2x+t3=7 ;; 2x=4', '2x+3=7 ;; 2x=7t3', '2x+3=7 ;; 2x=10 @0.6', '3x=12 ;; x=9 @0.89',
    '3x=12 ;; x=9 @0.95 {{x=4::0.45}}', 'x+3=7 @0.7 ;; x=5',
  ],
};

for (const [cat, blocks] of Object.entries(SOUND)) {
  test(`sound/${cat}: ${blocks.length} correct blocks, no red`, () => {
    const bad = blocks.filter((b) => reds(b).length).map((b) => `${b} -> ${verdicts(b).join(',')}`);
    assert.deepEqual(bad, []);
  });
}

// ---- FALSE POSITIVES: correct work marked red today (see math-redteam.md) ---------------------------

const FALSE_POSITIVES: [id: string, block: string][] = [
  // FP-1 derivatives: y', y'', f''(x) and "f'(x)=0" are all red
  ['FP-1', "y=x^2 ;; y'=2x"], ['FP-1', "y=sin(x) ;; y'=cos(x)"], ['FP-1', "y=3x^2 ;; y'=6x"], ['FP-1', "y=x^3 ;; y'=3x^2 ;; y''=6x"],
  ['FP-1', "y=e^(2x) ;; y'=2e^(2x)"], ['FP-1', "y=x^2-4x ;; y'=2x-4 ;; 2x-4=0 ;; x=2"], ['FP-1', "y=x^2 ;; y'=2x ;; y'(3)=6"],
  ['FP-1', "y'=2x"], ['FP-1', "y'=0"], ['FP-1', "f''(x)=6x"],
  ['FP-1', "f(x)=x^3 ;; f'(x)=3x^2 ;; f''(x)=6x"], ['FP-1', "f(x)=x^3-3x ;; f'(x)=3x^2-3 ;; f''(x)=6x"],
  ['FP-1', "f(x)=x^3-3x ;; f'(x)=3x^2-3 ;; f''(x)=6x ;; f''(1)=6"], ['FP-1', "f(x)=e^x ;; f'(x)=e^x ;; f''(x)=e^x"],
  ['FP-1', "f(x)=sin(x) ;; f'(x)=cos(x) ;; f''(x)=-sin(x)"], ['FP-1', "g(x)=x^4 ;; g'(x)=4x^3 ;; g''(x)=12x^2"],
  ['FP-1', "f(x)=x^3-3x ;; f'(x)=3x^2-3 ;; f'(x)=0"], ['FP-1', "f(x)=x^3-3x ;; f'(x)=3x^2-3 ;; f'(x)=0 ;; 3x^2-3=0 ;; x=±1"],
  ['FP-1', "f(x)=x^2 ;; f'(x)=2x ;; f'(x)=0 ;; x=0"], ['FP-1', "f(x)=x^2-2x ;; f'(x)=2x-2 ;; f'(x)=0 ;; 2x-2=0 ;; x=1 ;; f(1)=-1"],
  // FP-2 rounded answer on its own line with "=" (the same rounding on one line is accepted)
  ['FP-2', '3x=7 ;; x=2.33'], ['FP-2', '3x=7 ;; x=7/3=2.33'], ['FP-2', 'A=π·3^2 ;; A=28.27'], ['FP-2', 'A=π·r^2 ;; A=π·3^2 ;; A=28.27'],
  ['FP-2', '3x=10 ;; x=3.33'], ['FP-2', '7x=22 ;; x=3.14'], ['FP-2', 'x^2=2 ;; x=1.41'], ['FP-2', 'x^2=50 ;; x=7.07'],
  ['FP-2', '6x=1 ;; x=0.17'], ['FP-2', '6x=1 ;; x=0.167'], ['FP-2', '6x=1 ;; x=0,17'], ['FP-2', '1.5x=1 ;; x=0.67'],
  ['FP-2', 'x·1.08=100 ;; x=92.59'], ['FP-2', '1.05^x=2 ;; x=14.2'], ['FP-2', '1.05^x=2 ;; x=log(2)/log(1.05) ;; x=14.21'],
  ['FP-2', '2^x=10 ;; x=3.32'], ['FP-2', 'e^x=2 ;; x=0.69'], ['FP-2', 'e^x=2 ;; x=0.693'], ['FP-2', 'c^2=74 ;; c=8.6'],
  ['FP-2', 'K=1000·1.05^3 ;; K=1157.63'], ['FP-2', 'x=1000·1.05^3 ;; x=1157.6'], ['FP-2', 'cos(x)=0.3 ;; x=72.5'],
  ['FP-2', 'tan(x)=2 ;; x=63.4'], ['FP-2', 'x=7/3 ;; x=2.33'], ['FP-2', 'x=2/9 ;; x=0.22'], ['FP-2', '3x=7 ;; x=2.3'],
  // FP-3 inverse trig written f^-1 is read as 1/f; degree-mode inverse trig
  ['FP-3', 'sin^-1(1)=π/2'], ['FP-3', 'sin^-1(0.5)=π/6'], ['FP-3', 'tan^-1(1)=π/4'], ['FP-3', 'cos^-1(0.5)=60'],
  ['FP-3', 'sin^-1(1)=90'], ['FP-3', 'asin(0.5)=30'], ['FP-3', 'sin(x)=0.5 ;; x=30'],
  // FP-4 log with the base written inline: log10(...), log2(...)
  ['FP-4', 'log10(1000)=3'], ['FP-4', 'log10(100)=2'], ['FP-4', 'log10(10)=1'], ['FP-4', 'log2(8)=3'], ['FP-4', 'log 2(8)=3'],
  // FP-5 operation annotation without a bar (or with a bracket / slash), as a recogniser that drops the thin "|" produces
  ['FP-5', '4x=12 :4 ;; x=3'], ['FP-5', '4x=12 / 4 ;; x=3'], ['FP-5', '2x=8 /2 ;; x=4'], ['FP-5', 'x-3=4 +3 ;; x=7'],
  ['FP-5', 'x+3=7 (-3) ;; x=4'], ['FP-5', 'x+3=7 /-3 ;; x=4'], ['FP-5', '2x+3=7 | -3 | :2 ;; x=2'], ['FP-5', '9x=18 :9 ;; x=2'],
  // FP-6 a new (unlabelled) problem right after a solved line is judged as a step
  ['FP-6', 'x+1=3 ;; x=2 ;; x+1=5'], ['FP-6', 'x+1=3 ;; x=2 ;; 2x+1=9'], ['FP-6', 'x+1=3 ;; x=2 ;; 2x=8'],
  ['FP-6', 'x+1=3 ;; x=2 ;; 2x+5=7'], ['FP-6', 'x+1=3 ;; x=2 ;; 3x-1=2'], ['FP-6', 'x+1=3 ;; x=2 ;; 5x+2=7'],
  ['FP-6', '2x+3=7 ;; 2x=4 ;; x=2 ;; 2x+5=7 ;; 2x=2 ;; x=1'], ['FP-6', 'x=2 ;; 2x+5=7'], ['FP-6', 'x=2 ;; x+5=9'],
  ['FP-6', '5x-9=-44 ;; 5x=-35 ;; x=-7 ;; 9x+6=-3'],
  // FP-7 "e" used as a variable is the constant e
  ['FP-7', 'e=3'], ['FP-7', '2e=6 ;; e=3'], ['FP-7', 'e+2=5 ;; e=3'], ['FP-7', 'a=3 ;; e=2a ;; e=6'], ['FP-7', 'e·2=6'],
  // FP-8 calculator-style percent ("50+20%")
  ['FP-8', '50+20%=60'], ['FP-8', '100-10%=90'], ['FP-8', '200+5%=210'],
  // FP-9 dropped superscript on a pure-number line ("2^3=8" read as "23=8")
  ['FP-9', '23=8'], ['FP-9', '2^3=8 ;; 23=8'], ['FP-9', '32=9'], ['FP-9', 'x=3 ;; x^2=9 ;; 32=9'],
];

for (const [id, block] of FALSE_POSITIVES) {
  test(`${id} false red (fixed, hard assertion): ${block}`, () => {
    assert.deepEqual(reds(block), [], `verdicts ${verdicts(block).join(',')}`);
  });
}

// ---- AMBIGUOUS: exercise lists of near-identical problems without labels ---------------------------
// A teacher reading these as steps would mark them; as an exercise list they are fine. Documented, not asserted.
const AMBIGUOUS = [
  '2x+3=7 ;; 2x+3=9', 'x+5=12 ;; x+5=15', 'x+3=7 ;; x-3=7', '3x+1=7 ;; 3x-1=7', '5x=15 ;; 5x=20', 'x^2=9 ;; x^2=16',
  'x^2-5x+6=0 ;; x^2-5x+4=0', '2(x+1)=8 ;; 2(x-1)=8', 'x+3=7 ;; 2x+3=7', '2x+3=11 ;; 2x=8 ;; 2x+3=13 ;; 2x=10',
  'x+3=7 ;; x+3=7-3', '0.25=25% ;; 0.3=3%', '√16=±4',
];
test('ambiguous exercise lists (informational)', () => {
  for (const b of AMBIGUOUS) assert.ok(Array.isArray(verdicts(b)));
});

// ---- WRONG: work a teacher would mark ------------------------------------------------------------

const WRONG_CAUGHT = [
  '2x+3=7 ;; 2x=10', '2x+3=7 ;; 2x=4 ;; x=8', '3x=12 ;; x=9', 'x/2=4 ;; x=2', '-2x=6 ;; x=3', '-2x<6 ;; x<-3',
  '-x>3 ;; x>-3', '(a+b)^2=a^2+b^2', '√(a+b)=√a+√b', '3+4·2=14', '2^3=6', '2^3·2^4=2^12', '(2^3)^2=2^9', '1/2+1/3=2/5',
  '2/3·3/4=6/7', 'log(a+b)=log(a)+log(b)', 'ln(xy)=ln(x)·ln(y)', 'sin(a+b)=sin(a)+sin(b)', "(x^3)'=3x^3", "(x^3)'=x^2",
  'd/dx(x^2)=x', "(sin x)'=-cos x", 'x^2-5x+6=0 ;; (x-2)(x+3)=0', 'x^2-5x+6=0 ;; x=2 or x=-3', 'x^2-4=0 ;; x=4',
  'x^2=4 ;; x=2 or x=-4', '5x-3=2x+9 ;; 3x=6', '4x=2 ;; x=2', 'x/3=6 ;; x=2', '3(x-1)=9 ;; 3x-1=9', '-3^2=9',
  '(-2)^3=8', '0.5·0.5=2.5', '0.2·0.3=0.6', '12/0.5=6', '7·8=54', '9·6=56', '15-7=9', '25+38=53', 'x+3=7 ;; x=10',
  'x-5=2 ;; x=-3', '2x=x+5 ;; x=-5', '1/x=3 ;; x=3', 'x^2+6x+9=0 ;; (x+3)^2=0 ;; x=3', 'a/b+c/d=(a+c)/(b+d)',
  '2^-2=-4', 'log_2(8)=4', 'ln(e^2)=e', '10% of 50=10', '0.99=1', '2x=3x ;; 2=3', '3x=10 ;; x=3',
  'x^2-5x+6=0 ;; x=2 ;; x=4', '2x+3=7 ;; 2x=10 @0.95 {{2x=4::0.05}} ;; x=4',
];
test(`wrong/caught: ${WRONG_CAUGHT.length} wrong blocks are red`, () => {
  const missed = WRONG_CAUGHT.filter((b) => !reds(b).length);
  assert.deepEqual(missed, []);
});

const RECALL_MISSES = [
  '2x+3x=5x^2', 'x·x=2x', 'x^3·x^2=x^6', '(3x)^2=3x^2', '2(x+3)=2x+3', '-(x-2)=-x-2', '(x+2)^2=x^2+4',
  '(x-1)(x+1)=x^2+1', 'x^-1=-x', '√(x^2+9)=x+3', '2x+4=2(x+4)', '5-(2-x)=3-x', '√(-4)=-2', 'x^3=x ;; x^2=1',
  '|x-1|<2 ;; x<3', 'x^2=9 ;; x=3', '|x|=3 ;; x=3', 'x+y=5 ;; x-y=1 ;; 2x=8',
];
for (const b of RECALL_MISSES) {
  test(`recall miss: ${b}`, { todo: 'recall gap (see math-redteam.md)' }, () => {
    assert.ok(reds(b).length > 0, `verdicts ${verdicts(b).join(',')}`);
  });
}

// green ticks on wrong work
const WRONG_GREEN = ['sin^-1(x)=1/sin(x)', 'x>3 ;; x≥3'];
for (const b of WRONG_GREEN) {
  test(`wrong green (fixed, hard assertion): ${b}`, () => {
    assert.ok(!verdicts(b).includes('ok'), `verdicts ${verdicts(b).join(',')}`);
  });
}

// ---- gates that must hold ------------------------------------------------------------------------

test('gates: low confidence and a likely alternate never give red', () => {
  assert.deepEqual(reds('3x=12 ;; x=9 @0.89'), []);
  assert.deepEqual(reds('3x=12 ;; x=9 @0.95 {{x=4::0.45}}'), []);
  assert.deepEqual(reds('2x+3=7 @0.5 ;; 2x=10'), []);
  assert.deepEqual(reds('x^2+2x+1=0 ;; (x+1)^2=0 @0.85'), []);
});

// ---- LIVE results: evaluate() ---------------------------------------------------------------------

const ev = (block: string) => evaluate(block.split(' ;; ').map(rec)).map((r) => r.value);
const LIVE_OK: [string, string[]][] = [
  ['2+3=', ['5']], ['7/2=', ['3.5']], ['1/3=', ['1/3']], ['2^10=', ['1024']], ['0.1+0.2=', ['0.3']], ['2,5+1,5=', ['4']],
  ['sin(π/6)=', ['0.5']], ['log_2(8)=', ['3']], ['lg(1000)=', ['3']], ['ln(e)=', ['1']], ['√2=', ['1.414213562']],
  ['1/0=', []], ['0/0=', []], ['√-4=', []], ['ln 0=', []], ['10%=', ['0.1']], ['50% of 80=', ['40']], ['-2^2=', ['-4']],
  ['(-2)^2=', ['4']], ['2^3^2=', ['512']], ['6÷2(1+2)=', ['9']], ['(-8)^(1/3)=', ['-2']], ['1/3+1/3+1/3=', ['1']],
  ['12:4·3=', ['9']], ['|2-7|+1=', ['6']], ['2(3)(4)=', ['24']], ['cos π=', ['-1']], ['0.1·3=', ['0.3']],
  ['2^64=', ['18446744073709551616']], ['99999999999999999·3=', ['299999999999999997']], ['10^-7=', ['1e-7']],
  ['a=3 ;; 2a+1=', ['7']], ['a=3 ;; b=2a ;; a+b=', ['9']], ['x=2 ;; x^2=', ['4']], ['a=3 ;; a=4 ;; a·2=', ['8']],
  ['x=√2 ;; x^2=', ['2']], ['x=1/3 ;; 3x=', ['1']], ['x=2 ;; y=x+1 ;; y=', ['3']], ['a=2 ;; a^a^a=', ['16']],
  ['x=5 ;; x/0=', []], ['3x=', []],
];
test(`live/evaluate: ${LIVE_OK.length} inputs give the right value or nothing`, () => {
  for (const [b, want] of LIVE_OK) assert.deepEqual(ev(b), want, b);
});
const LIVE_WRONG: [id: string, block: string, want: string[]][] = [
  ['LIVE-1', 'sin(30)=', ['0.5']], // checkSteps accepts sin(30)=0.5 (degrees), evaluate shows -0.988
  ['LIVE-1', 'cos(60)=', ['0.5']],
  ['LIVE-1', 'tan(90)=', []],
  ['LIVE-2', 'sin^-1(1)=', ['1.570796327']], // shows 1/sin(1) = 1.188
  ['LIVE-3', 'tan(π/2)=', []], // shows 1.633124e16
  ['LIVE-4', 'e=5 ;; e+1=', ['6']], // assignment to e ignored, shows 3.718
  ['LIVE-4', 'pi=3 ;; pi+1=', ['4']],
  ['LIVE-5', 'log10(1000)=', ['3']], // nothing shown although lg(1000)= works
  ['LIVE-5', 'x=1,5 ;; 2x=', ['3']], // decimal comma in an assignment is dropped
];
for (const [id, b, want] of LIVE_WRONG) {
  test(`${id} live result (fixed, hard assertion): ${b}`, () => assert.deepEqual(ev(b), want));
}

// ---- variant() ------------------------------------------------------------------------------------

const solves = (problem: string, answer: string) => !reds(`${problem.replace(/=$/, '')} ;; ${answer}`).length;
test('variant: answers are right (independent substitution) for linear, quadratic, abs, log, exp problems', () => {
  const sub = (eq: string, x: number) => {
    const [l, r] = eq.split('=');
    const f = (s: string) => Function('x', `return ${s.replace(/log_2\(x\)/g, 'L2').replace(/\^/g, '**').replace(/(\d)x/g, '$1*x').replace(/(\d)\(/g, '$1*(').replace(/\|([^|]+)\|/g, 'Math.abs($1)').replace(/√x/g, 'Math.sqrt(x)').replace(/L2/g, 'Math.log2(x)')}`)(x);
    return Math.abs(f(l) - f(r)) < 1e-9;
  };
  for (const p of ['2x+3=7', 'x^2-5x+6=0', '3(x-2)=12', 'x/4=3', 'x^2=9', '√x=3', 'log_2(x)=3', '|x-2|=3', 'x^2-4x+4=0', '3x-7=2x+1', '5x=0', '(x-3)^2=16']) {
    for (let seed = 1; seed <= 6; seed++) {
      const v = variant(p, seed);
      if (!v) continue;
      for (const part of v.answer.split(' or ')) {
        const x = Number(part.split('=')[1]);
        assert.ok(sub(v.problem, x), `${p} seed ${seed}: ${v.problem} -> ${v.answer}`);
      }
      assert.ok(solves(v.problem, v.answer));
    }
  }
});
test('variant: inequality answers keep the flipped sign', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const v = variant('-2x+4>0', seed);
    if (v) assert.match(v.answer, /^x</, JSON.stringify(v));
  }
});
const VARIANT_SHAPE: [id: string, p: string, check: (v: { problem: string; answer: string }) => boolean][] = [
  ['VAR-1', '2(x+1)=2x+2', (v) => !/^x=/.test(v.answer)], // identity becomes a one-solution equation
  ['VAR-1', 'x/(x-2)=2/(x-2)', (v) => !/or/.test(v.answer)], // no-solution problem gets two solutions
  ['VAR-2', 'x+0.25=1', (v) => /\./.test(v.problem)], // decimal literal replaced by an integer
  ['VAR-2', '0.5x=2', (v) => /\./.test(v.problem)],
  ['VAR-3', '2x+3=7=', (v) => !/=.*=$/.test(v.problem)], // equation problem echoed with a trailing "="
  ['VAR-4', 'x^2-4x+4=0', (v) => !/or/.test(v.answer)], // double root becomes two roots
];
for (const [id, p, check] of VARIANT_SHAPE) {
  test(`${id} variant keeps the problem's shape (fixed, hard assertion): ${p}`, () => {
    for (let seed = 1; seed <= 3; seed++) { const v = variant(p, seed); if (v) assert.ok(check(v), JSON.stringify(v)); }
  });
}

// ---- generated families (seeded) -------------------------------------------------------------------

function lcg(seed: number) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
const R = lcg(7);
const ri = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
const nz = (a: number, b: number) => { let v = 0; while (!v) v = ri(a, b); return v; };
const sg = (v: number) => (v < 0 ? `${v}` : `+${v}`);
type Fam = { name: string; todo?: string; gen: () => string };
const FAMILIES: Fam[] = [
  { name: 'barred annotations (| -b, | :a)', gen: () => { const a = nz(2, 9), x0 = ri(-9, 9), b = ri(1, 9); return `${a}x+${b}=${a * x0 + b} | -${b} ;; ${a}x=${a * x0} | :${a} ;; x=${x0}`; } },
  { name: 'arithmetic facts with big ints', gen: () => { const a = ri(1e6, 9e9), b = ri(1e6, 9e9); return `${a}·${b}=${BigInt(a) * BigInt(b)}`; } },
  { name: 'fraction sums', gen: () => { const a = ri(1, 9), b = ri(2, 12), c = ri(1, 9), d = ri(2, 12); return `${a}/${b}+${c}/${d}=${a * d + c * b}/${b * d}`; } },
  { name: 'distribute then solve', gen: () => { const a = nz(2, 9), b = ri(-9, 9), x0 = ri(-9, 9); return `${a}(x${sg(b)})=${a * (x0 + b)} ;; ${a}x${sg(a * b)}=${a * (x0 + b)} ;; ${a}x=${a * x0} ;; x=${x0}`; } },
  { name: 'flip on negative division', gen: () => { const a = nz(2, 9), c = ri(-20, 20); return `-${a}x<${a * c} ;; x>${-c}`; } },
  { name: 'factorised quadratics', gen: () => { const p = ri(-9, 9), q = ri(-9, 9); return `x^2${sg(-(p + q))}x${sg(p * q)}=0 ;; (x${sg(-p)})(x${sg(-q)})=0 ;; x=${p} or x=${q}`; } },
  { name: 'rounded answer on the next line', todo: 'FP-2', gen: () => { const a = nz(3, 9), b = ri(1, 40); return b % a ? `${a}x=${b} ;; x=${(b / a).toFixed(2)}` : `${a}x=${b + 1} ;; x=${((b + 1) / a).toFixed(2)}`; } },
  { name: "second derivative f''", todo: 'FP-1', gen: () => { const a = nz(1, 5), b = ri(-9, 9), c = ri(-9, 9); return `f(x)=${a}x^3${sg(b)}x^2${sg(c)}x ;; f'(x)=${3 * a}x^2${sg(2 * b)}x${sg(c)} ;; f''(x)=${6 * a}x${sg(2 * b)}`; } },
  { name: 'annotation with dropped bar (":a")', todo: 'FP-5', gen: () => { const a = nz(2, 9), x0 = ri(-9, 9); return `${a}x=${a * x0} :${a} ;; x=${x0}`; } },
  { name: 'new unlabelled problem after a solved line', todo: 'FP-6', gen: () => { const a = nz(2, 9), x0 = ri(-9, 9), b = ri(-9, 9), a2 = nz(2, 9), x1 = ri(-9, 9), b2 = ri(-9, 9); return `${a}x${sg(b)}=${a * x0 + b} ;; ${a}x=${a * x0} ;; x=${x0} ;; ${a2}x${sg(b2)}=${a2 * x1 + b2}`; } },
];
for (const fam of FAMILIES) {
  const blocks = Array.from({ length: 150 }, fam.gen);
  // every family passes since the FP-1/2/5/6 fixes; `todo` documents which finding a family guarded
  test(`family: ${fam.name} (150 blocks)${fam.todo ? ` [was ${fam.todo}]` : ''}`, () => {
    const bad = blocks.filter((b) => reds(b).length);
    assert.deepEqual(bad.slice(0, 5), [], `${bad.length}/150 red`);
  });
}

// ---- count -----------------------------------------------------------------------------------------

test('red-team size: >= 300 adversarial cases', () => {
  const n = Object.values(SOUND).reduce((a, b) => a + b.length, 0) + FALSE_POSITIVES.length + AMBIGUOUS.length +
    WRONG_CAUGHT.length + RECALL_MISSES.length + WRONG_GREEN.length + LIVE_OK.length + LIVE_WRONG.length + VARIANT_SHAPE.length;
  assert.ok(n >= 300, String(n));
});

// ==== ROUND 2: attacks on the heuristics added by the round-1 fixes ================================
// Rounding tolerance ("a root within one unit of the last digit"), degree reading of whole-number trig
// arguments, derivative resolution from f(x)=/y= lines, "a plain final answer ends a chain",
// bar-less annotations as an alternative reading, and percent / dropped-^ alternates.
// Hard assertions hold today (regression guards); `todo` tests are open findings (R2-…, see math-redteam.md).

const isGreen = (b: string) => { const v = verdicts(b); return v[v.length - 1] === 'ok'; };

describe('round 2', () => {
  const SOUND2: string[] = [
    // rounding that is accepted
    '3x=7 ;; x=2.3', '3x=7 ;; x=2,33', '3x=7 ;; x=2,3', '3x=7 ;; x=2.333', '3x=7 ;; x=2.3333', '6x=1 ;; x=0.17',
    '6x=1 ;; x=0.2', 'x=1/3000 ;; x=0.00033', 'x=1/3000 ;; x=0.0003', 'x=2/3 ;; x=0.7', 'x=2/3 ;; x=0.67',
    'x=6.02·10^23/2 ;; x=3.01·10^23', 'K=1000·1.05^3 ;; K=1157.6', 'K=1000·1.05^3 ;; K=1157.63', 'A=π·10^2 ;; A=314.2',
    'x=12345/7 ;; x=1763.6', 'x^2=200 ;; x=±14.1', 'x^2=200 ;; x≈14', 'K=1000·1.05^3 ;; K≈1158', '2x+3=7 ;; x=2.0',
    '2x+3=7 ;; x=2.00', '100x=1 ;; x=0.01', 'x=5/8 ;; x=0.63', 'x=99·1.1 ;; x=108.9', '3x=-7 ;; x=-2.33',
    'x^2=2 ;; x=1.41 ;; 2x=2.82', '3x=7 ;; x=2.33 ;; 3x=6.99', '3x=7 ;; x=2.33 ;; x+1=3.33', '2x=4.2 ;; x=2.1',
    'sin(x)=0.1 ;; x=5.74', 'sin(x)=0.9 ;; x=64.2', 'sin(x)=0.9 ;; x=1.12', 'cos(x)=0.5 ;; x=1.05',
    // degree reading
    'sin(30)=0.5', 'cos(60)=0.5', 'tan(45)=1', 'sin(180)=0', 'sin(360)=0', 'cos(180)=-1', 'sin(30)+cos(60)=1',
    '2sin(30)=1', 'sin(30)^2+cos(30)^2=1', 'sin(x)=0.5 ;; x=30', 'sin(x)=0.5 ;; x=150', 'sin(x)=0.5 ;; x=30 or x=150',
    'sin(x)=0.5 ;; x=0.52', 'cos(x)=0.5 ;; x=60', 'tan(x)=1 ;; x=45', 'tan(x)=1 ;; x=225', 'sin(x)=1 ;; x=90',
    'sin(x)=0 ;; x=180', '2sin(x)=1 ;; sin(x)=0.5 ;; x=30', 'f(x)=sin(x) ;; f(10)=-0.544', 'f(x)=sin(x) ;; f(π/6)=0.5',
    'sin(20)·2=0.68', 'sin(20)=0.34 ;; 2sin(20)=0.68', 'sin(10)+sin(20)=0.52', 'sin(7)·sin(7)+cos(7)·cos(7)=1',
    'sin(10)/cos(10)=tan(10)', 'sin(2·5)=sin(10)', 'sin(2·15)=0.5', 'sin(60/2)=0.5', 'asin(0.5)=30', 'asin(0.5)=0.52',
    'acos(0)=90', 'atan(1)=45', 'atan(1)=0.785', 'asin(1)=90', 'asin(1)=1.57', 'sin^-1(0.5)=30', 'h=10·sin(30) ;; h=5',
    'h=10·sin(30)=5', 'x=30 ;; sin(x)=0.5', 'y=sin(x) ;; x=30 ;; y=0.5', 'sin(10)≈-0.544', 'sin(10)≈0.174',
    // derivative resolution
    "y=x^2 ;; y'=2x ;; y''=2", "y=x^3 ;; y'=3x^2 ;; y''=6x ;; y'''=6", "y=x^2·sin(x) ;; y'=2x·sin(x)+x^2·cos(x)",
    "y=sin(x^2) ;; y'=2x·cos(x^2)", "y=(3x+1)^5 ;; y'=15(3x+1)^4", "y=e^(3x) ;; y'=3e^(3x)", "y=ln(2x) ;; y'=1/x",
    "y=x/(x+1) ;; y'=1/(x+1)^2", "f(x)=x^2 ;; g(x)=x^3 ;; f'(x)=2x", "f(x)=x^2 ;; g(x)=x^3 ;; g'(x)=3x^2",
    "f(x)=x^2 ;; f(x)=x^3 ;; f'(x)=3x^2", "y=x^2 ;; y=x^3 ;; y'=3x^2", "y=x^2 ;; y'=2x ;; y=x^3 ;; y'=3x^2",
    "f(x)=x^2 ;; f'(x)=2x ;; g(x)=sin(x) ;; g'(x)=cos(x)", "y=3x+2 ;; x=4 ;; y'=3", "x^2+y^2=25 ;; 2x+2yy'=0 ;; y'=-x/y",
    "x^2+y^2=25 ;; y'=-x/y", "xy=1 ;; y'=-y/x", "y^2=x ;; 2yy'=1 ;; y'=1/(2y)", "y=x^2 ;; dy/dx=2x ;; d^2y/dx^2=2",
    "s(t)=t^3 ;; s'(t)=3t^2 ;; s''(t)=6t", "s=t^3 ;; s'=3t^2", "f(x)=x^3 ;; f'(x)=3x^2 ;; f'(x)=0 ;; x=0",
    "f(x)=x^3 ;; f'(x)=3x^2 ;; f''(x)=6x ;; f''(0)=0", "f(x)=x^3 ;; f''(x)=6x", "f(x)=ax^2 ;; f'(x)=2ax",
    "f(x)=ax^2+bx+c ;; f'(x)=2ax+b", "f(t)=t^2 ;; f'(t)=2t", "f(x)=x^2 ;; f'(a)=2a", "f(x)=x^2 ;; f'(x)=2x ;; f'(x)=4 ;; x=2",
    "y=x^2 ;; y′=2x", "y=x^2 ;; y’=2x", "y=x^2 ;; y´=2x", "f(x)=x^2 ;; f´(x)=2x", "f(x)=x^2 ;; f′(x)=2x", "f(x)=x^2 ;; f ' (x)=2x",
    "f(x)=x^2 ;; f''(x)=2", "f(x)=x^2 ;; f′′(x)=2", "f(x)=x^2 ;; m=f'(1)=2", "y=x^2 ;; m=y'(1)=2", "u=x^2 ;; v=sin(x) ;; u'=2x ;; v'=cos(x)",
    "v(t)=3t^2 ;; a(t)=v'(t)=6t", "s(t)=5t^2 ;; v=s' ;; v=10t", "f(x)=x^3 ;; f'(x)=3x^2 ;; m=f'(2)=12", "y=Ce^x ;; y'=Ce^x",
    "y'=y", "f'(x)=f(x)", "y'=2x ;; y=x^2+C", "x=t^2 ;; x'=2t", "y=x^2+1 ;; y(2)=5 ;; y'=2x",
    // a final answer ends a chain; new problems after it
    'x+1=3 ;; x=2 ;; 2x+5=7 ;; x=1', '2x+3=7 ;; x=2 ;; 4x+6=14', 'x+1=3 ;; x=2 ;; 2x+3=8 ;; 2x=5 ;; x=2.5',
    // annotations and percent
    '2x=8 /2 ;; x=4', '4x=12 :4 ;; x=3', 'x-3=4 +3 ;; x=7', '5x=20 ;; x=4 (·5)', '5x=20 ;; x=4 | ·5', 'x/2=5 ;; x=5·2',
    '2x+1=9 ;; 2x=8 :2', '3+4=7 :7', '3·4=12 /3', '50+20%=60', '100-10%=90', '100+10%=110', '200·5%=10', '20%·50=10',
    '50+20%=50.2', '23=8', '32=9', '25=32', '24=16', '33=27', '34=81', '52=25', '42=16', '26=64', 'x=3 ;; 32=9',
  ];
  test(`sound: ${SOUND2.length} correct blocks, no red`, () => {
    const bad = SOUND2.filter((b) => reds(b).length).map((b) => `${b} -> ${verdicts(b).join(',')}`);
    assert.deepEqual(bad, []);
  });

  /** round-2 classes fixed by the exact-rounding rule: hard assertions from now on */
  const R2_FIXED = new Set(['R2-FP-1', 'R2-FP-2', 'R2-FP-3', 'R2-G-1', 'R2-G-2']);

  const CAUGHT2: string[] = [
    '3x=7 ;; x=2.32', '3x=7 ;; x=2.35', '3x=7 ;; x=-2.33', '3x=-7 ;; x=2.33', '3x=7 ;; x=2', '3x=7 ;; x=3', '3x=7 ;; x=2.5',
    '3x=7 ;; x=2.332', 'x^2=2 ;; x=1', 'x^2=2 ;; x=2', '2x=5 ;; x=3', '2x=5 ;; x=2', '100x=1 ;; x=0.0', 'x/7=1000 ;; x=7010',
    'x+0.5=0 ;; x=0.5', 'x^2-5x+6=0 ;; x=2.1 or x=3', 'x^2-5x+6=0 ;; x=2 or x=3.1', '6x=1 ;; x=0.18', 'x=1/3000 ;; x=0.0005',
    'x=2/3 ;; x=0.68', 'x=12.5·4 ;; x=51', 'x=12.5·4 ;; x=49', 'x=10/4 ;; x=3', 'sin(x)=0.5 ;; x=60', 'sin(x)=0.5 ;; x=6',
    'sin(x)=1 ;; x=270', 'sin(x)=0 ;; x=7', 'cos(x)=0.5 ;; x=30', 'tan(x)=1 ;; x=46', "y=x^2 ;; y'=3x", "y=x^2 ;; y'=x",
    "y=x^2 ;; y'=2x ;; y''=2x", "y=x^3 ;; y'=3x^2 ;; y''=3x", "y=x^2·sin(x) ;; y'=2x·cos(x)", "y=sin(x^2) ;; y'=cos(x^2)",
    "y=sin(x^2) ;; y'=cos(2x)", "y=(3x+1)^5 ;; y'=5(3x+1)^4", "y=e^(3x) ;; y'=e^(3x)", "y=ln(2x) ;; y'=2/x",
    "y=x/(x+1) ;; y'=1/(x+1)", "f(x)=x^2 ;; g(x)=x^3 ;; g'(x)=2x", "f(x)=x^2 ;; g(x)=x^3 ;; f'(x)=3x^2",
    "f(x)=x^2 ;; f(x)=x^3 ;; f'(x)=2x", "y=x^2 ;; y=x^3 ;; y'=2x", "y=x^2 ;; y'=2x ;; y=x^3 ;; y'=2x",
    "f(x)=x^2 ;; f'(x)=2x ;; g(x)=sin(x) ;; f'(x)=cos(x)", "y=x^2 ;; dy/dx=x", "s=t^3 ;; s'=3t",
    "f(x)=x^3 ;; f'(x)=3x^2 ;; f'(x)=0 ;; x=1", "f(x)=x^3 ;; f'(x)=3x^2 ;; f'(2)=6", "f(x)=x^3 ;; f'(x)=3x^2 ;; f''(x)=6x ;; f''(1)=3",
    "f(x)=x^3 ;; f'(x)=2x^2", "f(x)=x^3 ;; f''(x)=3x^2", "f(x)=ax^2 ;; f'(x)=ax", "u=x^2 ;; v=sin(x) ;; u'=2x ;; v'=-cos(x)",
    '(x-2)(x+3)=0 ;; x=2 ;; x=3', '(x-2)(x+3)=0 ;; x-2=0 ;; x=2 ;; x+3=0 ;; x=3', 'x^2-5x+6=0 ;; (x-2)(x-3)=0 ;; x=2 ;; x=4',
    '2x+3=7 ;; x=2 ;; 2·2+3=8', 'x+1=3 ;; x=2 ;; 2x+3=9 ;; 2x=5 ;; x=2.5', 'x+1=3 ;; x=2 ;; 2x+3=9 ;; 2x=6 ;; x=4',
    '4x=12 :4 ;; x=4', '4x=12 :4 ;; x=8', '4x=12 /4 ;; x=48', '2x=8 /2 ;; x=16', 'x-3=4 +3 ;; x=1', '3x=9 ;; x=3·2',
    '2x+3=7 ;; 2x=4+3', 'x/2=5 ;; x=10·2', '50+20%=70', '50+20%=52', '100-10%=110', '100+10%=101', '200·5%=1000',
    '20%·50=100', '23=6', '52=10', '42=8', 'x=3 ;; 32=6', '2^3=6', '23=9', '34=12', '26=12',
  ];
  test(`caught: ${CAUGHT2.length} wrong blocks are red`, () => {
    assert.deepEqual(CAUGHT2.filter((b) => !reds(b).length), []);
  });

  // P0: correct work marked red by the new rules
  const FP2: [string, string][] = [
    ['R2-FP-1', 'K=1000·1.05^3 ;; K=1158'], ['R2-FP-1', 'x=1000·1.05^3 ;; x=1158'], ['R2-FP-1', 'A=π·10^2 ;; A=314'],
    ['R2-FP-1', 'A=π·5^2 ;; A=79'], ['R2-FP-1', 'x=12345/7 ;; x=1764'], ['R2-FP-1', 'x=393/10 ;; x=39'], ['R2-FP-1', 'x=687/7 ;; x=98'],
    ['R2-FP-1', 'x^2=20000 ;; x=141'], ['R2-FP-1', 'x^2=200 ;; x=14'],
    ['R2-FP-2', 'x=12345/7 ;; x=1760'], ['R2-FP-2', 'x=1518/5 ;; x=304'], ['R2-FP-2', 'x=17154/8 ;; x=2140'], ['R2-FP-2', 'A=π·10^2 ;; A=310'],
    ['R2-FP-3', 'x=1/3000 ;; x=3.3·10^-4'], ['R2-FP-3', 'x=6.02·10^23/3 ;; x=2.01·10^23'], ['R2-FP-3', 'x=6.02·10^23/3 ;; x=2.0·10^23'],
    ['R2-FP-3', 'x=2/3000 ;; x=6.7·10^-4'], ['R2-FP-3', 'x=1/13000 ;; x=7.7·10^-5'],
    ['R2-FP-4', 'f(x)=sin(x) ;; f(30)=0.5'], ['R2-FP-4', 'f(x)=cos(x) ;; f(60)=0.5'], ['R2-FP-4', 'f(x)=2sin(x) ;; f(30)=1'],
    ['R2-FP-4', 'g(α)=sin(α) ;; g(30)=0.5'],
    ['R2-FP-5', "v=3t^2 ;; a=v'"], ['R2-FP-5', "v=3t^2 ;; a=v'=6t"], ['R2-FP-5', "y=2x+3 ;; m=y'=2"], ['R2-FP-5', "y=x^2 ;; k=y'"],
  ];
  for (const [id, b] of FP2) {
    test(`${id} false red: ${b}`, R2_FIXED.has(id) ? {} : { todo: `${id} (math-redteam.md round 2)` }, () => assert.deepEqual(reds(b), [], verdicts(b).join(',')));
  }

  // wrong work that the new rules tick green (worse than silence: it confirms the mistake)
  const GREEN2: [string, string][] = [
    ['R2-G-1', 'x=0.1+0.2 ;; x=0.31'], ['R2-G-1', 'x=0.1+0.2 ;; x=0.29'], ['R2-G-1', 'x=7.1+0.1 ;; x=7.19'], ['R2-G-1', 'x=8.8+8.2 ;; x=16.99'],
    ['R2-G-1', 'x=99·1.1 ;; x=108.8'], ['R2-G-1', '100x=1 ;; x=0.02'], ['R2-G-1', 'x^2=0.0001 ;; x=0.02'], ['R2-G-1', '2x+3=7 ;; x=1.99'],
    ['R2-G-1', '5x=1 ;; x=0.21'], ['R2-G-1', 'x-0.25=1 ;; x=1.26'], ['R2-G-1', 'x-0.25=1 ;; x=1.24'], ['R2-G-1', '4x=5 ;; x=1.24'],
    ['R2-G-1', '4x=5 ;; x=1.26'],
    ['R2-G-2', '3x=7 ;; x=2.34'], ['R2-G-2', '3x=7 ;; x=2.334'], ['R2-G-2', '3x=-7 ;; x=-2.34'], ['R2-G-2', 'x=412/13 ;; x=31.70'],
    ['R2-G-2', 'x=56/6 ;; x=9.34'], ['R2-G-2', 'x=1/3000 ;; x=0.0004'], ['R2-G-2', '6x=1 ;; x=0.16'], ['R2-G-2', 'x=2/3 ;; x=0.66'],
    ['R2-G-3', 'sin(30)=-0.99'], ['R2-G-3', 'tan(45)=1.62'], ['R2-G-3', 'sin(180)=-0.80'], ['R2-G-3', 'sin(10)=-0.54'],
    ['R2-G-3', 'sin(7)≈0.657'], ['R2-G-3', 'sin(1)≈0.017'],
    ['R2-G-4', '2x=8 ;; x=4 -1'], ['R2-G-4', '3x=9 ;; x=3 ·2'], ['R2-G-4', '2x+3=7 ;; 2x=4 +3'], ['R2-G-4', '2x+3=7 ;; 2x=4 /2'],
    ['R2-G-4', 'x/2=5 ;; x=10 ·2'], ['R2-G-4', 'x+3=7 ;; x=4 -3'], ['R2-G-4', '2x=8 ;; x=4 +1'], ['R2-G-4', '3x=9 ;; x=3 :3'],
    ['R2-G-4', '2x+1=9 ;; 2x=8 /2 ;; x=2'], ['R2-G-4', 'x+3=7 :2 ;; x=4'],
  ];
  for (const [id, b] of GREEN2) {
    test(`${id} green on wrong work: ${b}`, R2_FIXED.has(id) ? {} : { todo: `${id} (math-redteam.md round 2)` }, () => assert.ok(!isGreen(b), verdicts(b).join(',')));
  }

  // recall lost to 'unsure' / 'none'
  const MISS2 = [
    '2x=5 ;; x=2.4', '2x=5 ;; x=2.6', '2x+3=7 ;; x=2.1', '2x+3=7 ;; x=1.9', '2x=4.2 ;; x=2.2', 'x+1.5=4 ;; x=2.4',
    'x=1.5·2 ;; x=3.1', 'x=10/4 ;; x=2.6', 'x^2=0.01 ;; x=0.2', 'x^2=0.25 ;; x=0.6', 'x^2=6.25 ;; x=2.6', '5x=1 ;; x=0.3',
    'x+0.5=0 ;; x=-0.4', 'x^2=2 ;; x=±1.5', '3x=7 ;; x≈2.4', '3x=7 ;; x≈3', 'x+1=3 ;; x=2 ;; x^2=5', 'x+1=3 ;; x=2 ;; 2x=5',
    'x=2 ;; y=x+1 ;; y=4', 'x=2 ;; y=3x ;; y=5', 'x=4 ;; 2x=9', "f(x)=x^2 ;; g(x)=f'(x) ;; g(x)=x", "s(t)=t^3 ;; s'(t)=3t^2 ;; s''(t)=6",
    'x+3=7 ;; x=7 -3 ;; x=10',
  ];
  for (const b of MISS2) {
    test(`R2 recall miss: ${b}`, { todo: 'R2-M (math-redteam.md round 2)' }, () => assert.ok(reds(b).length > 0, verdicts(b).join(',')));
  }

  // spacing alone flips the verdict: the recogniser's spaces are not evidence
  test('R2-G-4 spacing invariance: "x=4 -1" and "x=4-1" get the same verdict', { todo: 'R2-G-4' }, () => {
    for (const [a, b] of [['2x=8 ;; x=4 -1', '2x=8 ;; x=4-1'], ['3x=9 ;; x=3 ·2', '3x=9 ;; x=3·2'], ['2x+3=7 ;; 2x=4 +3', '2x+3=7 ;; 2x=4+3']]) {
      assert.deepEqual(verdicts(a), verdicts(b), `${a} vs ${b}`);
    }
  });

  // live results
  const LIVE2_OK: [string, string[]][] = [
    ['sin(30)=', ['0.5']], ['sin(10)=', ['0.1736481777']], ['cos(60)=', ['0.5']], ['tan(45)=', ['1']], ['tan(90)=', []],
    ['sin(-30)=', ['-0.5']], ['sin 30=', ['0.5']], ['sin(30)·2=', ['1']], ['1/sin(30)=', ['2']], ['sin^-1(1)=', ['1.570796327']],
    ['tan(π/2)=', []], ['e=5 ;; e+1=', ['6']], ['log10(1000)=', ['3']], ['x=1,5 ;; 2x=', ['3']], ['sin(π/6)=', ['0.5']],
  ];
  test(`live: ${LIVE2_OK.length} inputs`, () => { for (const [b, w] of LIVE2_OK) assert.deepEqual(ev(b), w, b); });
  const LIVE2_BAD: [string, string, (v: string[]) => boolean][] = [
    ['R2-L-1', 'x=30 ;; sin(x)=', (v) => v[0] === '0.5'], // -0.988 though sin(30)= shows 0.5
    ['R2-L-1', 'sin(2·15)=', (v) => v[0] === '0.5'], // -0.988
    ['R2-L-1', 'sin(15+15)=', (v) => v[0] === '0.5'],
    ['R2-L-2', 'sin(7)+sin(6)=', (v) => v[0] !== '-0.1575461548'], // 7 read in degrees, 6 in radians, then added
    ['R2-L-3', 'sin(7.5)=', (v) => Math.abs(Number(v[0]) - Math.sin((7.5 * Math.PI) / 180)) < 1e-6], // 0.938 (radians) next to sin(7)=0.122 (degrees)
    ['R2-L-4', 'asin(0.5)=', (v) => v[0] === '30'], // radians, while sin(30)= is degrees
    ['R2-L-5', 'sin(180)=', (v) => v[0] === '0'], // 1.224647e-16
    ['R2-L-6', '50+20%=', (v) => v[0] !== '50.2'], // checkSteps lets 50+20%=60 through as unsure, the live value is 50.2
  ];
  for (const [id, b, ok] of LIVE2_BAD) {
    test(`${id} live: ${b}`, { todo: `${id} (math-redteam.md round 2)` }, () => assert.ok(ok(ev(b)), ev(b).join(',')));
  }

  // generated families (seeded)
  const R2 = lcg(11);
  const r2i = (a: number, b: number) => a + Math.floor(R2() * (b - a + 1));
  const FAM2: { name: string; todo?: string; expect: 'noRed' | 'notGreen'; gen: () => string }[] = [
    { name: 'p/q rounded to 1 dp', expect: 'noRed', gen: () => { const q = r2i(3, 13), p = r2i(2, 999); return `x=${p}/${q} ;; x=${(p / q).toFixed(1)}`; } },
    { name: 'p/q rounded to 2 dp', expect: 'noRed', gen: () => { const q = r2i(3, 13), p = r2i(2, 999); return `x=${p}/${q} ;; x=${(p / q).toFixed(2)}`; } },
    { name: 'p/q rounded to 3 dp', expect: 'noRed', gen: () => { const q = r2i(3, 13), p = r2i(2, 999); return `x=${p}/${q} ;; x=${(p / q).toFixed(3)}`; } },
    { name: 'sqrt n to 2 dp, both roots', expect: 'noRed', gen: () => { const n = r2i(2, 500); return `x^2=${n} ;; x=${Math.sqrt(n).toFixed(2)} or x=${(-Math.sqrt(n)).toFixed(2)}`; } },
    { name: 'p/q rounded to a whole number (>= 10)', todo: 'R2-FP-1', expect: 'noRed', gen: () => { const q = r2i(3, 13), p = r2i(10 * q + 1, 999); return `x=${p}/${q} ;; x=${Math.round(p / q)}`; } },
    { name: 'p/q to 3 significant figures', todo: 'R2-FP-2', expect: 'noRed', gen: () => { const q = r2i(3, 13), p = r2i(1000, 99999); return `x=${p}/${q} ;; x=${Number((p / q).toPrecision(3))}`; } },
    { name: 'scientific notation, 2 s.f.', todo: 'R2-FP-3', expect: 'noRed', gen: () => { const q = r2i(3, 13), p = r2i(1, 9); const [m, e] = (p / q / 1000).toExponential(1).split('e'); return `x=${p}/${q * 1000} ;; x=${m}·10^${Number(e)}`; } },
    { name: 'exact decimal sum, answer off by 0.01', todo: 'R2-G-1', expect: 'notGreen', gen: () => { const a = r2i(1, 99), b = r2i(1, 99); return `x=${a / 10}+${b / 10} ;; x=${((a + b) / 10 + (R2() < 0.5 ? 0.01 : -0.01)).toFixed(2)}`; } },
    { name: '2x=odd, answer off by 0.1', todo: 'R2-G-1', expect: 'notGreen', gen: () => { const b = r2i(1, 40) * 2 + 1; return `2x=${b} ;; x=${(b / 2 + (R2() < 0.5 ? 0.1 : -0.1)).toFixed(1)}`; } },
  ];
  for (const fam of FAM2) {
    const blocks = Array.from({ length: 150 }, fam.gen);
    test(`family: ${fam.name} (150 blocks)`, fam.todo && !R2_FIXED.has(fam.todo) ? { todo: fam.todo } : {}, () => {
      const bad = blocks.filter((b) => (fam.expect === 'noRed' ? reds(b).length > 0 : isGreen(b)));
      assert.deepEqual(bad.slice(0, 5), [], `${bad.length}/150`);
    });
  }

  test('round-2 size: >= 150 new cases', () => {
    const n = SOUND2.length + CAUGHT2.length + FP2.length + GREEN2.length + MISS2.length + LIVE2_OK.length + LIVE2_BAD.length;
    assert.ok(n >= 150, String(n));
  });
});
