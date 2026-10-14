// Live Ink math checker: hand-written corpora. Correct working must never be marked 'error';
// wrong steps must be caught (>= 90% recall) with the right title and the wrong part underlined.
// In the wrong corpus ⟦…⟧ marks the expected underline; the markers are stripped before checking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSteps, toLatex } from '../../src/renderer/live/math/index.ts';
import type { LineRecognition } from '../../src/renderer/live/contract.ts';

const rec = (text: string, i: number, over: Partial<LineRecognition> = {}): LineRecognition => ({
  lineId: 'l' + i, kind: 'math', text, latex: '', confidence: 0.97, alternates: [], tokens: [], source: 'local-ink', ...over,
});
const run = (lines: string[]) => checkSteps(lines.map((t, i) => rec(t, i)));

// ---- correct working: every block must come back without a single 'error' -----------------------

const CORRECT: string[][] = [
  // linear equations
  ['2x+3=7', '2x=4', 'x=2'],
  ['3x-5=10', '3x=15', 'x=5'],
  ['5x+2=3x+10', '2x+2=10', '2x=8', 'x=4'],
  ['4(x-1)=2(x+3)', '4x-4=2x+6', '2x=10', 'x=5'],
  ['x/2+1=4', 'x/2=3', 'x=6'],
  ['(x+1)/3=2', 'x+1=6', 'x=5'],
  ['7-x=3', '-x=-4', 'x=4'],
  ['-3x+4=-8', '-3x=-12', 'x=4'],
  ['0.5x+1.5=4', '0.5x=2.5', 'x=5'],
  ['2(x+3)=10', '2x+6=10', '2x=4', 'x=2'],
  ['3(2x-1)=4x+7', '6x-3=4x+7', '2x=10', 'x=5'],
  ['x+3=7 | -3', 'x=4'],
  ['2x+3=7', '2x=7-3', '2x=4', 'x=4/2', 'x=2'],
  ['5x=20', 'x=20/5=4'],
  ['12=4x', 'x=3'],
  ['x-7=-2', 'x=5'],
  ['(2x)/(3)=4', '2x=12', 'x=6'],
  ['1/x=2', '1=2x', 'x=1/2'],
  ['10-2x=4', '-2x=-6', 'x=3'],
  ['2x+3=7 ⇒ 2x=4 ⇒ x=2'],
  ['6x−4=2x+8', '4x=12', 'x=3'],
  ['3·x+2=11', '3x=9', 'x=3'],
  ['x/4=2.5', 'x=10'],
  ['0,5x=2', 'x=4'],
  ['2x+3x=15', '5x=15', 'x=3'],
  ['4x-2x+1=9', '2x+1=9', '2x=8', 'x=4'],
  ['a) 2x=6', 'x=3'],
  ['x+1=2x-3', '4=x', 'x=4'],
  ['3(x+2)-2(x-1)=12', '3x+6-2x+2=12', 'x+8=12', 'x=4'],
  ['2x+3=7 |-3', '2x=4 |:2', 'x=2'],
  ['5(x-2)=3(x+2)', '5x-10=3x+6', '2x=16', 'x=8'],
  ['x/3-2=1', 'x/3=3', 'x=9'],
  ['(x-4)/2=x-5', 'x-4=2x-10', '-x=-6', 'x=6'],
  ['0.2x=1.4', 'x=7'],
  ['1.5x-0.5=2.5', '1.5x=3', 'x=2'],
  ['8-3x=2x-7', '15=5x', 'x=3'],
  ['2(3-x)=x', '6-2x=x', '6=3x', 'x=2'],
  ['x+x+x=12', '3x=12', 'x=4'],
  ['(1)/(2)x=5', 'x=10'],
  ['−4x=−20', 'x=5'],
  ['9x=0', 'x=0'],
  ['3x+7=7', '3x=0', 'x=0'],
  ['2x+3=2x+5', '3=5'],
  ['x+2=x+2', '0=0'],
  ['4x-8=0', '4(x-2)=0', 'x-2=0', 'x=2'],
  ['(x+3)/(4)=(x-1)/(2)', 'x+3=2(x-1)', 'x+3=2x-2', 'x=5'],
  ['2x+3=7', '2x=4', 'x=2', '5x-2=13', '5x=15', 'x=3'],
  ['x=2', '2·2+3=7'],
  ['3x=12', 'x=4', 'Check: 3·4=12'],
  // quadratics and other non-linear equations
  ['x^2-5x+6=0', '(x-2)(x-3)=0', 'x=2 or x=3'],
  ['x^2=9', 'x=±3'],
  ['x^2-4=0', 'x^2=4', 'x=2 or x=-2'],
  ['x^2+2x+1=0', '(x+1)^2=0', 'x+1=0', 'x=-1'],
  ['x^2-x-6=0', '(x-3)(x+2)=0', 'x-3=0 or x+2=0', 'x=3 or x=-2'],
  ['2x^2=18', 'x^2=9', 'x=3 or x=-3'],
  ['x^2-6x+5=0', 'x=(6±√(36-20))/2', 'x=(6±4)/2', 'x=5 or x=1'],
  ['x^2+4x=0', 'x(x+4)=0', 'x=0 or x=-4'],
  ['(x-1)^2=4', 'x-1=±2', 'x=3 or x=-1'],
  ['x²-16=0', '(x-4)(x+4)=0', 'x=4, x=-4'],
  ['x^2-5x+6=0', 'x₁=2, x₂=3'],
  ['3x^2-12=0', 'x^2=4', 'x=±2'],
  ['x^2=2', 'x=±√2'],
  ['x^2=2', 'x=√2 or x=-√2'],
  ['e^x=1', 'x=0'],
  ['2^x=8', 'x=3'],
  ['ln(x)=0', 'x=1'],
  ['√x=3', 'x=9'],
  ['x^3=8', 'x=2'],
  ['|x|=3', 'x=3 or x=-3'],
  ['10^x=1000', 'x=3'],
  ['log(x)=2', 'x=100'],
  ['x^2=3x', 'x^2-3x=0', 'x(x-3)=0', 'x=0 or x=3'],
  ['x^2+6x+9=0', '(x+3)^2=0', 'x=-3'],
  ['2x^2-8x=0', '2x(x-4)=0', 'x=0 or x=4'],
  ['x^2-7x+12=0', 'x=(7±√(49-48))/2', 'x=(7±1)/2', 'x=4 or x=3'],
  ['x^4=16', 'x^2=4', 'x=±2'],
  ['(x+2)(x-5)=0', 'x=-2 or x=5'],
  ['x^2+1=0'],
  ['3/(x-1)=1', '3=x-1', 'x=4'],
  ['x/(x+1)=1/2', '2x=x+1', 'x=1'],
  // inequalities
  ['2x+3<7', '2x<4', 'x<2'],
  ['-2x<4', 'x>-2'],
  ['3x-1≥5', '3x≥6', 'x≥2'],
  ['-x>3', 'x<-3'],
  ['5-x≤2', '-x≤-3', 'x≥3'],
  ['1<2x+1<5', '0<2x<4', '0<x<2'],
  ['x/2>1', 'x>2'],
  ['4x+1>2x+7', '2x>6', 'x>3'],
  ['-3x+2≤11', '-3x≤9', 'x≥-3'],
  ['x/(-2)<1', 'x>-2'],
  ['2(x-1)≥x', '2x-2≥x', 'x≥2'],
  // multi-variable rearranging and systems
  ['v=s/t', 's=v·t'],
  ['A=πr^2', 'r^2=A/π'],
  ['y=2x+3', 'y-3=2x', 'x=(y-3)/2'],
  ['ax+b=c', 'ax=c-b', 'x=(c-b)/a'],
  ['F=ma', 'a=F/m'],
  ['x+y=5', 'x-y=1', '2x=6', 'x=3'],
  ['y=2x+1', 'y=-x+4'],
  ['x+y=10', 'x=2y'],
  ['2a+b=7', 'b=7-2a'],
  ['P=2l+2w', 'P-2l=2w', 'w=(P-2l)/2'],
  ['E=mc^2', 'm=E/c^2'],
  ['y=mx+b', 'b=y-mx'],
  ['2x+3y=12', '3y=12-2x', 'y=4-(2)/(3)x'],
  // arithmetic facts
  ['7×8=56'], ['3·4=12'], ['5×6=30'], ['12÷4=3'], ['√(16)=4'], ['100-37=63'], ['15·15=225'],
  ['(3)/(4)+(1)/(4)=1'], ['1/2+1/3=5/6'], ['2/3·3/4=1/2'], ['(5)/(6)-(1)/(3)=(1)/(2)'], ['3/4÷1/2=3/2'],
  ['1/2+1/4=3/4'], ['2/5+1/10=1/2'], ['0.1+0.2=0.3'], ['2.5·4=10'], ['1.5×1.5=2.25'], ['3.6÷1.2=3'],
  ['0.25=1/4'], ['12.5%·80=10'], ['20% of 50=10'], ['√2≈1.41'], ['π≈3.14'], ['1/3≈0.333'], ['√2=1.414'],
  ['5!=120'], ['|−3|=3'], ['2^3=8'], ['∛27=3'], ['(-2)^3=-8'], ['-2^2=-4'], ['3+4·2=11'], ['(3+4)·2=14'],
  ['10-4-3=3'], ['24/4/2=3'], ['2·(3+4)=14'], ['log(100)=2'], ['ln(1)=0'], ['log_2(8)=3'], ['e^0=1'],
  ['2^10=1024'], ['10^-2=0.01'], ['8^(1/3)=2'], ['4^(3/2)=8'], ['2^3·2^2=2^5=32'], ['9-12=-3'],
  ['-4·-3=12'], ['(-3)^2=9'], ['2+2=4'], ['17-9=8'], ['144÷12=12'], ['6^2=36'], ['√(144)=12'],
  ['0.3·0.3=0.09'], ['1,5+2,5=4'], ['3,2·2=6,4'], ['4:2=2'], ['1/8=0.125'], ['2/3≈0.67'],
  ['(2+3)^2=25'], ['2·3^2=18'], ['50%·30=15'], ['3!·2!=12'], ['7²=49'], ['2³=8'], ['√(9+16)=5'],
  ['1000·0.01=10'], ['(1)/(2)·(4)/(5)=(2)/(5)'], ['3-(-2)=5'], ['-5+8=3'], ['4.5-1.25=3.25'],
  ['sin(π/6)=1/2'], ['cos(0)=1'], ['sin(30)=0.5'], ['cos(60)=1/2'], ['cos(π)=-1'], ['tan(45)=1'],
  ['7×8=56=8×7'], ['2+3=5', '5·2=10'], ['12+8=20', '=4·5'],
  // identities: exponents, expansion and factoring
  ['x^2·x^3=x^5'], ['(x^2)^3=x^6'], ['x^5/x^2=x^3'], ['(2x)^2=4x^2'], ['x^-1=1/x'], ['√(x^2)=|x|'],
  ['(ab)^2=a^2b^2'], ['x^0=1'], ['(x^3)^2/x^4=x^2'], ['a^2·a=a^3'], ['(x^2y)^2=x^4y^2'],
  ['(x+1)^2=x^2+2x+1'], ['(x-3)^2=x^2-6x+9'], ['(a+b)^2=a^2+2ab+b^2'], ['(a-b)(a+b)=a^2-b^2'],
  ['x^2-4=(x-2)(x+2)'], ['2(x+3)=2x+6'], ['x^2+5x+6=(x+2)(x+3)'], ['(x+2)^3=x^3+6x^2+12x+8'],
  ['3x+6=3(x+2)'], ['x^3-x=x(x-1)(x+1)'], ['(2x+1)(x-3)=2x^2-5x-3'], ['-(x-2)=2-x'], ['a(b+c)=ab+ac'],
  ['(x+1)^2=(x+1)(x+1)=x^2+2x+1'], ['(x+2)^2', '=x^2+4x+4'], ['(x+3)(x-3)', '=x^2-9'],
  ['2x+3x', '5x'], ['(x^2-1)/(x-1)=x+1'], ['(x)/(2)+(x)/(3)=(5x)/(6)'], ['1/x+1/y=(x+y)/(xy)'],
  ['(a+b)/c=a/c+b/c'], ['x-(y+3)=x-y-3'], ['(x+2)/2=x/2+1'], ['(2x+4)/2=x+2'],
  ['4x^2-9=(2x-3)(2x+3)'], ['x^2+2xy+y^2=(x+y)^2'], ['(x-1)(x^2+x+1)=x^3-1'],
  ['3(x-2)', '=3x-6'], ['(x+1)(x+2)', '=x^2+3x+2'], ['2x(x-3)', '=2x^2-6x'],
  ['(x+4)^2-16', '=x^2+8x+16-16', '=x^2+8x'],
  // trigonometry, logs, exponentials
  ['sin(x)^2+cos(x)^2=1'], ['sin(2x)=2sin(x)cos(x)'], ['cos(2x)=cos(x)^2-sin(x)^2'], ['tan(x)=sin(x)/cos(x)'],
  ['1+tan(x)^2=1/cos(x)^2'], ['sin(-x)=-sin(x)'], ['sin^2 x+cos^2 x=1'], ['2sin(x)cos(x)=sin(2x)'],
  ['cos(-x)=cos(x)'], ['sin(x+π)=-sin(x)'], ['ln(ab)=ln(a)+ln(b)'], ['ln(x^3)=3ln(x)'], ['e^(2x)=(e^x)^2'],
  ['e^a·e^b=e^(a+b)'], ['ln(e^x)=x'], ['log(1000)=3'], ['ln(a/b)=ln(a)-ln(b)'],
  // derivatives
  ['d/dx(x^3)=3x^2'], ['d/dx(5x^2)=10x'], ['d/dx(x^2+3x)=2x+3'], ['d/dx(7)=0'], ['d/dx(sin(x))=cos(x)'],
  ['d/dx(e^x)=e^x'], ['d/dx(ln(x))=1/x'], ['d/dx(x^4-2x)=4x^3-2'], ['f(x)=x^2', "f'(x)=2x"], ['f(x)=3x+1', 'f(2)=7'],
  ["(x^3)'=3x^2"], ['d/dx(1/x)=-1/x^2'], ['d/dx(√x)=1/(2√x)'], ['d/dx(cos(x))=-sin(x)'], ['d/dx(x^5)=5x^4'],
  ['d/dx(3x^4+2x^2-x)=12x^3+4x-1'], ['d/dx((x+1)^2)=2(x+1)'], ['d/dx(x·e^x)=e^x+x·e^x'], ['f(x)=x^3-x', "f'(x)=3x^2-1", "f'(2)=11"],
  ['d/dx(2x^3)', '=6x^2'], ['d/dx(sin(2x))=2cos(2x)'],
  // domain-restricted identities students write: never red
  ['√(x^2)=x'], ['(x^2)/x=x'], ['ln(x^2)=2ln(x)'], ['√(ab)=√a·√b'],
  // squaring / dividing by expressions: at most amber
  ['√(x+1)=x-1', 'x+1=(x-1)^2'], ['x^2=3x', 'x=3'], ['x^2=25', 'x=5'],
  // prose and unparsable lines in between
  ['Solve for x', '2x+3=7', 'subtract 3', '2x=4', 'x=2'],
  ['x^2=2', 'x=±√2', 'x≈±1.41'],
  ['2x+3=7', '2x=4', 'x=2 ✓'],
  ['(1)', '3x=9', 'x=3'],
];

// ---- wrong steps: [lines, allowed titles]; ⟦…⟧ marks the wrong part on the last line ------------

const WRONG: [string[], string[]][] = [
  // arithmetic facts
  [['7×8=⟦54⟧'], ['Arithmetic slip']],
  [['6·7=⟦43⟧'], ['Arithmetic slip']],
  [['12÷4=⟦4⟧'], ['Arithmetic slip']],
  [['15+27=⟦41⟧'], ['Arithmetic slip']],
  [['100-37=⟦73⟧'], ['Arithmetic slip']],
  [['13·3=⟦36⟧'], ['Arithmetic slip']],
  [['2^5=⟦64⟧'], ['Arithmetic slip', 'Exponent rule']],
  [['√(49)=⟦8⟧'], ['Arithmetic slip']],
  [['5!=⟦100⟧'], ['Arithmetic slip']],
  [['0.1+0.2=⟦0.12⟧'], ['Arithmetic slip']],
  [['2.5·4=⟦12⟧'], ['Arithmetic slip']],
  [['3.6÷1.2=⟦0.3⟧'], ['Arithmetic slip']],
  [['5×6=⟦35⟧'], ['Arithmetic slip']],
  [['8+5=⟦12⟧'], ['Arithmetic slip']],
  [['9-12=⟦3⟧'], ['Sign error']],
  [['-4·-3=⟦-12⟧'], ['Sign error']],
  [['(-2)^3=⟦8⟧'], ['Sign error']],
  [['√(16)=⟦8⟧'], ['Arithmetic slip']],
  [['∛(27)=⟦9⟧'], ['Arithmetic slip']],
  [['144÷12=⟦11⟧'], ['Arithmetic slip']],
  [['17-9=⟦7⟧'], ['Arithmetic slip']],
  [['1,5+2,5=⟦3⟧'], ['Arithmetic slip']],
  [['3-(-2)=⟦1⟧'], ['Sign error', 'Arithmetic slip']],
  [['2+2=4', '4·3=⟦7⟧'], ['Arithmetic slip']],
  [['12+8=20', '=4·⟦6⟧'], ['Arithmetic slip']],
  [['7×8=56=8×⟦6⟧'], ['Arithmetic slip']],
  [['20% of 50=⟦5⟧'], ['Arithmetic slip']],
  [['log(100)=⟦10⟧'], ['Arithmetic slip']],
  [['0.3·0.3=⟦0.9⟧'], ['Arithmetic slip']],
  [['6^2=⟦12⟧'], ['Arithmetic slip', 'Exponent rule']],
  [['3^4=⟦12⟧'], ['Arithmetic slip', 'Exponent rule']],
  [['4.5-1.25=⟦3.35⟧'], ['Arithmetic slip']],
  // fractions
  [['(3)/(4)+(1)/(4)=(4)/⟦(8)⟧'], ['Adding fractions']],
  [['1/2+1/3=2/⟦5⟧'], ['Adding fractions']],
  [['1/4+1/4=2/⟦8⟧'], ['Adding fractions']],
  [['2/5+1/5=3/⟦10⟧'], ['Adding fractions']],
  [['(1)/(3)+(1)/(6)=(2)/⟦(9)⟧'], ['Adding fractions']],
  [['2/3·3/4=6/⟦7⟧'], ['Arithmetic slip']],
  [['3/4-1/4=⟦2/8⟧'], ['Adding fractions', 'Arithmetic slip']],
  // order of operations
  [['2+3·4=⟦20⟧'], ['Order of operations']],
  [['10-4-3=⟦9⟧'], ['Order of operations']],
  [['-3^2=⟦9⟧'], ['Order of operations', 'Sign error']],
  [['2·3^2=⟦36⟧'], ['Order of operations']],
  [['24/4/2=⟦12⟧'], ['Order of operations']],
  [['5+2·3=⟦21⟧'], ['Order of operations']],
  [['8-2·3=⟦18⟧'], ['Order of operations']],
  [['12/2·3=⟦2⟧'], ['Order of operations']],
  [['20-5+3=⟦12⟧'], ['Order of operations']],
  [['3·2^3=⟦216⟧'], ['Order of operations']],
  // roots and exponents (numeric)
  [['√(9+16)=⟦7⟧'], ['Root of a sum']],
  [['√(36+64)=⟦14⟧'], ['Root of a sum']],
  [['2^3·2^2=2^⟦6⟧'], ['Exponent rule']],
  [['(2^3)^2=2^⟦5⟧'], ['Exponent rule']],
  [['3^5/3^2=3^⟦(5/2)⟧'], ['Exponent rule', 'Arithmetic slip']],
  [['(3+4)^2=⟦25⟧'], ['Squared term by term']],
  [['(5-2)^2=⟦21⟧'], ['Squared term by term']],
  // identity misconceptions with two variables (standalone lines are red)
  [['(a+b)^2=⟦a^2+b^2⟧'], ['Squared term by term']],
  [['(a-b)^2=⟦a^2-b^2⟧'], ['Squared term by term']],
  [['√(a+b)=⟦√a+√b⟧'], ['Root of a sum']],
  [['(a+b)/a=⟦b⟧'], ['Cancelled a term']],
  [['ln(a+b)=⟦ln(a)+ln(b)⟧'], ['Log rule']],
  [['ln(ab)=⟦ln(a)·ln(b)⟧'], ['Log rule']],
  [['sin(a+b)=⟦sin(a)+sin(b)⟧'], ['Not linear']],
  [['(ab)^3=⟦ab^3⟧'], ['Exponent rule']],
  [['a/b+c/d=⟦(a+c)/(b+d)⟧'], ['Adding fractions']],
  [['x^a·x^b=x^⟦(ab)⟧'], ['Exponent rule']],
  [['a(b+c)=ab+⟦c⟧'], ['Distributed to one term']],
  [['(x+y)^2=⟦x^2+y^2⟧'], ['Squared term by term']],
  [['(a+b)^3=⟦a^3+b^3⟧'], ['Squared term by term']],
  [['ln(a/b)=⟦ln(a)/ln(b)⟧'], ['Log rule']],
  [['(x+y)/y=⟦x⟧'], ['Cancelled a term']],
  // expression chains (lines starting with '=')
  [['(x+3)^2', '=⟦x^2+9⟧'], ['Squared term by term']],
  [['(x-2)^2', '=⟦x^2-4⟧'], ['Squared term by term']],
  [['(x+1)^2', '=x^2+⟦x⟧+1'], ['Arithmetic slip']],
  [['2(x+3)', '=2x+⟦3⟧'], ['Distributed to one term']],
  [['3(x-2)', '=3x-⟦2⟧'], ['Distributed to one term']],
  [['5(2x+1)', '=10x+⟦1⟧'], ['Distributed to one term']],
  [['-(x-4)', '=-x⟦-4⟧'], ['Sign error']],
  [['x-(y+3)', '=x-y⟦+3⟧'], ['Sign error']],
  [['x^2·x^3', '=x^⟦6⟧'], ['Exponent rule']],
  [['(x^2)^3', '=x^⟦5⟧'], ['Exponent rule']],
  [['x^6/x^2', '=x^⟦3⟧'], ['Exponent rule']],
  [['(2x)^3', '=⟦2x^3⟧'], ['Exponent rule']],
  [['(x+2)/2', '=⟦x+1⟧'], ['Cancelled a term']],
  [['(a+2)/(a+b)', '=⟦2/b⟧'], ['Cancelled a term']],
  [['(2x+4)/2', '=x+⟦4⟧'], ['Cancelled a term']],
  [['(x)/(2)+(x)/(3)', '=(2x)/⟦(5)⟧'], ['Adding fractions']],
  [['(x+1)(x+2)', '=x^2+3x+⟦3⟧'], ['Arithmetic slip']],
  [['(x+1)(x-1)', '=x^2⟦+1⟧'], ['Sign error']],
  [['(x+4)^2', '=x^2+⟦4⟧x+16'], ['Arithmetic slip']],
  [['2x(x-3)', '=2x^2-⟦3x⟧'], ['Distributed to one term', 'Arithmetic slip']],
  [['(x-5)^2', '=x^2-10x⟦-25⟧'], ['Sign error']],
  [['(x+1)^2=(x+1)(x+1)=⟦x^2+1⟧'], ['Squared term by term', 'Dropped a term']],
  [['4x^2-9', '=(2x-3)(2x+⟦9⟧)'], ['Arithmetic slip']],
  [['3x+5x', '=⟦8x^2⟧'], ['Arithmetic slip', 'Exponent rule']],
  [['sin(x)^2+cos(x)^2+x', '=⟦2⟧+x'], ['Arithmetic slip']],
  [['sin(2x)', '=⟦2sin(x)⟧'], ['Not linear']],
  [['√(x^2+9)', '=⟦x+3⟧'], ['Root of a sum']],
  [['ln(x^3)', '=⟦ln(x)^3⟧'], ['Log rule']],
  // derivatives
  [['d/dx(x^3)=3x^⟦3⟧'], ['Power rule']],
  [['d/dx(x^4)=4x^⟦4⟧'], ['Power rule']],
  [['d/dx(5x^2)=⟦5⟧x'], ['Derivative slip']],
  [['d/dx(x^2+3x)=2x+⟦3x⟧'], ['Derivative slip']],
  [['d/dx(sin(x))=⟦-cos(x)⟧'], ['Sign error', 'Derivative slip']],
  [['d/dx(cos(x))=⟦sin(x)⟧'], ['Sign error', 'Derivative slip']],
  [['d/dx(x^5)=⟦4⟧x^4'], ['Derivative slip', 'Power rule']],
  [['d/dx(7x)=⟦7x⟧'], ['Derivative slip']],
  [['d/dx(3x^2+2)=6x+⟦2⟧'], ['Extra term', 'Derivative slip']],
  [['d/dx(x^3-x)=3x^2⟦+1⟧'], ['Sign error']],
  [['d/dx(2x^3)', '=6x^⟦3⟧'], ['Power rule']],
  [['f(x)=x^2', "f'(x)=⟦x⟧"], ['Derivative slip', 'Arithmetic slip']],
  [['f(x)=3x+1', 'f(2)=⟦6⟧'], ['Arithmetic slip']],
  [['d/dx(e^(2x))=⟦e^(2x)⟧'], ['Derivative slip']],
  [['d/dx(ln(x))=⟦x⟧'], ['Derivative slip']],
  // equation steps
  [['2x=4', 'x=⟦8⟧'], ['Inverse operation']],
  [['x+3=7', 'x=⟦10⟧'], ['Sign error']],
  [['3x=12', 'x=⟦5⟧'], ['Not a solution', 'Arithmetic slip']],
  [['2x+3=7', '2x=⟦10⟧'], ['Sign error']],
  [['5x-2=13', '5x=⟦11⟧'], ['Sign error']],
  [['2(x+3)=10', '2x+⟦3⟧=10'], ['Distributed to one term']],
  [['4x=2', 'x=⟦2⟧'], ['Inverse operation']],
  [['x/3=4', 'x=⟦4/3⟧'], ['Inverse operation']],
  [['x-5=3', 'x=⟦-2⟧'], ['Sign error']],
  [['7-x=3', 'x=⟦-4⟧'], ['Sign error']],
  [['-3x=12', 'x=⟦4⟧'], ['Sign error']],
  [['x^2=16', 'x=⟦8⟧'], ['Inverse operation']],
  [['x^2=9', 'x=⟦4.5⟧'], ['Inverse operation']],
  [['3x+2=2x+7', 'x=⟦9⟧'], ['Sign error']],
  [['5x+1=3x+9', '2x=⟦10⟧'], ['Sign error']],
  [['4(x-2)=12', '4x-⟦2⟧=12'], ['Distributed to one term']],
  [['2x+4=10', 'x+⟦4⟧=5'], ['Divided only one term']],
  [['3x=9', 'x=⟦27⟧'], ['Inverse operation']],
  [['2x+3=11', '2x=⟦14⟧'], ['Sign error']],
  [['10-2x=4', '-2x=⟦14⟧'], ['Sign error']],
  [['x/2=6', 'x=⟦3⟧'], ['Inverse operation']],
  [['6x=3', 'x=⟦2⟧'], ['Inverse operation']],
  [['x+7=2', 'x=⟦9⟧'], ['Sign error']],
  [['(x+1)/2=3', 'x+1=⟦3/2⟧'], ['Inverse operation']],
  [['x^2-5x+6=0', '(x-2)(x+⟦3⟧)=0'], ['Sign error']],
  [['x^2-5x+6=0', 'x=2 or x=⟦-3⟧'], ['Sign error']],
  [['x^2-9=0', 'x=⟦9⟧'], ['Not a solution', 'Arithmetic slip', 'Inverse operation']],
  [['2x+3=7', '2x=4', 'x=⟦4⟧'], ['Inverse operation', 'Not a solution', 'Divided only one side']],
  [['3(x+2)=15', '3x+⟦2⟧=15'], ['Distributed to one term']],
  [['4x+8=20', 'x+⟦8⟧=5'], ['Divided only one term']],
  [['6x+3=2x+11', '4x=⟦14⟧'], ['Sign error']],
  [['x/4+2=5', 'x/4=⟦7⟧'], ['Sign error']],
  [['5-2x=11', '-2x=⟦16⟧'], ['Sign error']],
  [['2x-7=3', '2x=⟦-4⟧'], ['Sign error']],
  [['9x=3', 'x=⟦3⟧'], ['Inverse operation']],
  [['x+2=5x-6', '⟦-4x⟧=-8', 'x=2'], []], // placeholder (replaced below)
  [['0.5x=3', 'x=⟦1.5⟧'], ['Inverse operation']],
  [['x^2=49', 'x=⟦24.5⟧'], ['Inverse operation']],
  [['3(x-1)=2x+4', '3x-⟦1⟧=2x+4'], ['Distributed to one term']],
  [['x(x+2)=0', 'x=0 or x=⟦2⟧'], ['Sign error']],
  [['(x-4)(x+1)=0', 'x=⟦-4⟧ or x=-1'], ['Sign error']],
  [['x^2+4x=0', 'x(x+⟦2⟧)=0'], ['Arithmetic slip', 'Divided only one term']],
  [['2x^2=50', 'x^2=⟦100⟧'], ['Inverse operation', 'Multiplied only one side']],
  [['x/5=2', 'x=⟦2/5⟧'], ['Inverse operation']],
  [['-x=5', 'x=⟦5⟧'], ['Sign error']],
  [['2x=-8', 'x=⟦4⟧'], ['Sign error']],
  [['3x-4=x+6', '2x=⟦2⟧'], ['Sign error']],
  // inequalities
  [['-2x<4', 'x⟦<⟧-2'], ['Inequality sign']],
  [['-x>3', 'x⟦>⟧-3'], ['Inequality sign']],
  [['-3x≥9', 'x⟦≥⟧-3'], ['Inequality sign']],
  [['x/(-2)<1', 'x⟦<⟧-2'], ['Inequality sign']],
  [['2x+3<7', '2x<⟦10⟧'], ['Sign error']],
  [['5-x≤2', 'x⟦≤⟧3'], ['Inequality sign']],
  [['3x-1≥5', '3x≥⟦4⟧'], ['Sign error']],
  [['4x<12', 'x<⟦8⟧'], ['Sign error', 'Not equivalent', 'Inverse operation']],
  // formulas
  [['y=2x+3', 'x=(y⟦+3⟧)/2'], ['Sign error']],
  [['F=ma', 'a=⟦F·m⟧'], ['Inverse operation']],
  [['x+y=5', 'x=5⟦+y⟧'], ['Sign error']],
  [['v=s/t', 's=⟦v/t⟧'], ['Inverse operation']],
  [['y-4=3x', 'y=3x⟦-4⟧'], ['Sign error']],
];
// replace the placeholder with a real case
WRONG.splice(WRONG.findIndex((w) => w[1].length === 0), 1, [['x+2=5x-6', '-4x=⟦-4⟧'], ['Sign error']]);

function strip(line: string): { text: string; span: [number, number] | null } {
  const s = line.indexOf('⟦'), e = line.indexOf('⟧');
  if (s < 0) return { text: line, span: null };
  return { text: line.slice(0, s) + line.slice(s + 1, e) + line.slice(e + 1), span: [s, e - 1] };
}

test('correct corpus: zero errors over >= 400 correct steps', () => {
  let steps = 0;
  const fps: string[] = [];
  for (const block of CORRECT) {
    steps += Math.max(1, block.length - (block.length > 1 ? 1 : 0));
    const lines = block.map((t, i) => rec(t, i, /^[A-Z][a-z]+( [a-z]+)*:?$|^subtract/.test(t) ? { kind: 'text' } : {}));
    const r = checkSteps(lines);
    r.lines.forEach((l, i) => {
      if (l.verdict === 'error') {
        const is = r.issues.find((x) => x.lineId === l.lineId);
        fps.push(`${JSON.stringify(block)} line ${i}: ${is?.title} ${is?.detail}`);
      }
    });
  }
  assert.deepEqual(fps, [], 'false positives');
  assert.ok(steps >= 400 || CORRECT.length + GENERATED_CORRECT().length >= 400);
});

/** generated families that widen the correct corpus beyond the hand-written blocks */
function GENERATED_CORRECT(): string[][] {
  const out: string[][] = [];
  for (let a = 2; a <= 9; a++) for (let b = 2; b <= 9; b += 3) out.push([`${a}×${b}=${a * b}`], [`${a * b}÷${a}=${b}`], [`${a}+${b}=${a + b}`]);
  for (let a = 1; a <= 6; a++) for (let b = -5; b <= 5; b += 2) {
    const s = (n: number) => (n < 0 ? `-${-n}` : `+${n}`);
    out.push([`(x${s(a)})(x${s(b)})=x^2${s(a + b)}x${s(a * b)}`.replace('+0x', '').replace('-0x', '')]);
    out.push([`${a}x${s(b)}=${a * 3 + b}`, `${a}x=${a * 3}`, 'x=3']);
  }
  for (let n = 2; n <= 7; n++) out.push([`d/dx(x^${n})=${n}x^${n - 1}`], [`x^${n}·x^2=x^${n + 2}`]);
  return out;
}

test('generated correct families: zero errors', () => {
  const fps: string[] = [];
  for (const block of GENERATED_CORRECT()) {
    const r = run(block);
    r.lines.forEach((l, i) => { if (l.verdict === 'error') fps.push(`${JSON.stringify(block)} line ${i}`); });
  }
  assert.deepEqual(fps, []);
  let steps = 0;
  for (const b of [...CORRECT, ...GENERATED_CORRECT()]) steps += Math.max(1, b.length - 1);
  assert.ok(steps >= 400, `only ${steps} correct steps`);
});

test('wrong corpus: >= 90% recall with the right title and underline', () => {
  assert.ok(WRONG.length >= 150, `only ${WRONG.length} wrong steps`);
  let caught = 0, titled = 0, placed = 0;
  const misses: string[] = [];
  for (const [block, titles] of WRONG) {
    const lines = block.map(strip);
    const r = checkSteps(lines.map((l, i) => rec(l.text, i)));
    const last = r.lines[r.lines.length - 1];
    const marked = lines.findIndex((l) => l.span);
    const target = r.lines[marked];
    const issue = r.issues.find((x) => x.lineId === target.lineId);
    if (target.verdict !== 'error' || !issue) { misses.push(`MISS ${JSON.stringify(block)} -> ${target.verdict} ${issue?.title ?? ''}`); continue; }
    caught++;
    if (titles.includes(issue.title)) titled++;
    else misses.push(`TITLE ${JSON.stringify(block)} -> ${issue.title}`);
    const want = lines[marked].span!;
    const got = issue.span;
    const ok = got && ((got[0] <= want[0] && want[1] <= got[1]) || (want[0] <= got[0] && got[1] <= want[1]));
    if (ok) placed++;
    else misses.push(`SPAN ${JSON.stringify(block)} -> ${got ? JSON.stringify(lines[marked].text.slice(got[0], got[1])) : 'null'}`);
    void last;
  }
  const n = WRONG.length;
  if (misses.length) console.log(misses.join('\n'));
  console.log(`wrong corpus: recall ${caught}/${n}, title ${titled}/${caught}, span ${placed}/${caught}`);
  assert.ok(caught / n >= 0.9, `recall ${caught}/${n}`);
  assert.ok(titled / caught >= 0.9, `titles ${titled}/${caught}`);
  assert.ok(placed / caught >= 0.9, `spans ${placed}/${caught}`);
});

test('issues carry detail, hint and a LaTeX fix', () => {
  const r = run(['2x=4', 'x=8']);
  assert.equal(r.lines[1].verdict, 'error');
  const is = r.issues[0];
  assert.equal(is.source, 'local-cas');
  assert.equal(is.severity, 'error');
  assert.ok(is.detail.length > 0 && is.hint && is.fix);
  assert.equal(is.fix, 'x = 2');
  assert.ok(!is.hint!.includes('x = 2') && !is.hint!.includes('x=2'), 'the hint must not give the answer away');
});

test('confidence gating: a misread never becomes red', () => {
  // low-confidence reading: at most unsure
  let r = checkSteps([rec('2x=4', 0), rec('x=8', 1, { confidence: 0.5 })]);
  assert.equal(r.lines[1].verdict, 'unsure');
  // confident primary but an alternate reading makes the step correct: unsure
  r = checkSteps([rec('2x=4', 0), rec('x=8', 1, { alternates: ['x=2'] })]);
  assert.equal(r.lines[1].verdict, 'unsure');
  // an alternate reading of the previous line explains it
  r = checkSteps([rec('2x=16', 0, { alternates: ['2x=4'] }), rec('x=2', 1)]);
  assert.notEqual(r.lines[1].verdict, 'error');
  // alternates that are also wrong keep the error
  r = checkSteps([rec('2x=4', 0), rec('x=8', 1, { alternates: ['x=6'] })]);
  assert.equal(r.lines[1].verdict, 'error');
  // decimal comma vs list: one sound reading wins
  r = run(['2x=3', 'x=1,5']);
  assert.notEqual(r.lines[1].verdict, 'error');
});

test('verdicts: prose is none, first lines are none, verified steps are ok', () => {
  const r = checkSteps([rec('Solve', 0, { kind: 'text' }), rec('2x+3=7', 1), rec('2x=4', 2), rec('x=2', 3), rec('7×8=56', 4)]);
  assert.deepEqual(r.lines.map((l) => l.verdict), ['none', 'none', 'ok', 'ok', 'ok']);
  assert.deepEqual(run(['hello world']).lines.map((l) => l.verdict), ['none']);
  assert.deepEqual(run(['x^2=9', 'x=3']).lines.map((l) => l.verdict), ['none', 'unsure']);
});

test('toLatex', () => {
  assert.equal(toLatex('(3)/(4)+(1)/(4)=1'), '\\frac{3}{4} + \\frac{1}{4} = 1');
  assert.equal(toLatex('√(16)=4'), '\\sqrt{16} = 4');
  assert.equal(toLatex('5×6=30'), '5 \\times 6 = 30');
  assert.equal(toLatex('3·4=12'), '3 \\cdot 4 = 12');
  assert.equal(toLatex('12÷4=3'), '12 \\div 4 = 3');
  assert.equal(toLatex('x^2-4=(x-2)(x+2)'), 'x^{2} - 4 = \\left(x - 2\\right)\\left(x + 2\\right)');
  assert.equal(toLatex('d/dx(x^3)=3x^2'), '\\frac{d}{dx}\\left(x^{3}\\right) = 3x^{2}');
  assert.equal(toLatex('sin(x)^2+cos(x)^2=1'), '\\sin^{2}\\left(x\\right) + \\cos^{2}\\left(x\\right) = 1');
  assert.equal(toLatex('x=±√2'), 'x = \\pm \\sqrt{2}');
  assert.equal(toLatex('2x+3≤7'), '2x + 3 \\le 7');
  assert.equal(toLatex('2πr'), '2\\pi r');
  assert.equal(toLatex('|x|=3'), '\\left|x\\right| = 3');
  assert.equal(toLatex('x²'), 'x^{2}');
  assert.equal(toLatex('The answer'), 'The answer');
});

test('beam x beam: alternates with p >= 0.1 can rescue a step, unlikely ones cannot', () => {
  const two = (cur: Partial<LineRecognition>, prev: Partial<LineRecognition> = {}) => checkSteps([rec('2x=4', 0, prev), rec('x=8', 1, cur)]).lines[1].verdict;
  assert.equal(two({ alternates: ['x=2'], alternateProbs: [0.05] }), 'error'); // implausible reading ignored
  assert.equal(two({ alternates: ['x=2'], alternateProbs: [0.2] }), 'unsure'); // plausible reading passes: amber
  assert.equal(two({ alternates: ['x=2'], alternateProbs: [0.45] }), 'none'); // likely reading passes: nothing
  assert.equal(two({}, { alternates: ['2x=16'], alternateProbs: [0.3] }), 'unsure'); // previous line misread
  assert.equal(two({ confidence: 0.85 }), 'unsure'); // red needs line confidence >= 0.9
});

test('carry-forward: lines that follow correctly from a wrong line are carried, with no issue', () => {
  const r = run(['2x+3=7', '2x=10', 'x=5', 'x+1=6']);
  assert.deepEqual(r.lines.map((l) => [l.verdict, !!l.carried]), [['none', false], ['error', false], ['ok', true], ['ok', true]]);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].lineId, 'l1');
  // a corrected rewrite is not carried
  const c = run(['2x=4', 'x=8', 'x=2']);
  assert.deepEqual(c.lines.map((l) => [l.verdict, !!l.carried]), [['none', false], ['error', false], ['ok', false]]);
});

test('misconception tags for the mistake journal', () => {
  const tag = (lines: string[]) => run(lines).issues.find((i) => i.severity === 'error')?.misconception;
  assert.equal(tag(['x+3=7', 'x=10']), 'sign-move');
  assert.equal(tag(['2(x+3)=10', '2x+3=10']), 'distribute-first-term');
  assert.equal(tag(['(a+b)^2=a^2+b^2']), 'square-of-sum');
  assert.equal(tag(['(x+2)/2', '=x+1']), 'cancel-terms');
  assert.equal(tag(['2x+4=10', 'x+4=5']), 'divide-one-side');
  assert.equal(tag(['√(9+16)=7']), 'sqrt-of-sum');
  assert.equal(tag(['x^2·x^3', '=x^6']), 'exponent-product');
  assert.equal(tag(['1/2+1/3=2/5']), 'fraction-add-denominators');
  assert.equal(tag(['2+3·4=20']), 'order-of-operations');
  assert.equal(tag(['7×8=54']), 'arithmetic');
});
