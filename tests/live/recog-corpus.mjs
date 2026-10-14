// Recognition eval corpus: what to write (handwriting.mjs syntax) and the linear text expected
// back from recognizeBlock. Equations, algebra steps, fractions, exponents, roots, prose.
const R = String.raw;

export const corpus = [
  // linear equations and steps
  ['2x+3=7'], ['2x=4'], ['x=2'], ['3x-5=10'], ['3x=15'], ['x=5'], ['5x+2=3x+8'], ['2x=6'],
  ['4(x+1)=12'], ['x+1=3'], ['7-2x=1'], ['-2x=-6'], ['y=mx+b'], ['2a+3b=12'], ['4x-8=0'],
  ['10x=50'], ['x+y=10'], ['x-y=2'], ['2y=8'], ['3(2x-1)=9'], ['6x-3=9'], ['0.5x=2'],
  // arithmetic with operators
  ['6÷3=2', '6/3=2'], ['12÷4=3', '12/4=3'], ['3×4=12', '3*4=12'], ['2.5×4=10', '2.5*4=10'],
  ['9-4=5'], ['15+27=42'], ['100-37=63'], ['8×7=56', '8*7=56'],
  // exponents and factoring
  ['(x+3)(x-3)=x^2-9'], ['x^2-4=(x-2)(x+2)'], ['x^2+5x+6=0'], ['(x+2)(x+3)=0'], ['x=-2'],
  ['(a+b)^2=a^2+2ab+b^2'], ['2^{10}=1024', '2^10=1024'], ['3^2+4^2=5^2'], ['x^3-x=x(x-1)(x+1)'],
  ['f(x)=x^2-3x'], ['f(2)=4-6=-2'], ['y=2x^2+1'], ['y=e^{2x}', 'y=e^(2x)'], ['x^{n+1}', 'x^(n+1)'],
  // fractions
  [R`\frac{3}{4}+\frac{1}{4}=1`, '(3)/(4)+(1)/(4)=1'], [R`\frac{1}{2}+\frac{1}{3}=\frac{5}{6}`, '(1)/(2)+(1)/(3)=(5)/(6)'],
  [R`\frac{x}{2}=5`, '(x)/(2)=5'], [R`\frac{2x+1}{3}=5`, '(2x+1)/(3)=5'], [R`\frac{x+1}{x-1}=2`, '(x+1)/(x-1)=2'],
  [R`y=\frac{x^2+1}{2}`, 'y=(x^2+1)/(2)'],
  // roots and subscripts
  [R`\sqrt{16}=4`, 'sqrt(16)=4'], [R`\sqrt{x+1}=3`, 'sqrt(x+1)=3'], [R`\sqrt{9}+\sqrt{16}=7`, 'sqrt(9)+sqrt(16)=7'],
  ['a_1+a_2=5'], ['x_1=3'],
  // prose
  ['The derivative is 2x'], ['solve for x'], ['check the answer'], ['this is wrong'], ['Hello world'],
  ['find the area of the circle'], ['the answer is five'], ['Divide both sides by two'],
].map(([write, expect]) => ({ write, expect: expect ?? write, kind: /^[A-Za-z ]+$/.test(write) && / /.test(write) ? 'text' : /[a-z]{3} /.test(write) ? 'text' : 'math' }));
