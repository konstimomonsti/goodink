// Math coverage corpus: generated step blocks for the math checker (steps.json, "steps").
// Every block is correct by construction: the numbers are computed here, and each wrong block
// applies one named misconception to one line. Lines after a wrong line that follow correctly from
// it are labelled 'carried'. Deterministic for a given seed.
//
// Line labels: given | correct | wrong | carried. A wrong line has span ([start, end) into its
// LaTeX), wrongText (= latex.slice(...span)), misconception and fix (the correct LaTeX line).

// ---- helpers ------------------------------------------------------------------------------------

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}

const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };

/** a rational p/q as LaTeX: 3, -\frac{1}{2} */
export function q(p, d = 1) {
  if (d < 0) { p = -p; d = -d; }
  const g = gcd(p, d) || 1;
  p /= g; d /= g;
  if (d === 1) return String(p);
  return (p < 0 ? '-' : '') + `\\frac{${Math.abs(p)}}{${d}}`;
}

/** coefficient * v^pow as a term with sign handling; first = no leading '+' */
function term(c, pow, v, first) {
  if (c === 0) return '';
  const sign = c < 0 ? '-' : first ? '' : '+';
  const a = Math.abs(c);
  const vp = pow === 0 ? '' : pow === 1 ? v : `${v}^{${pow}}`.replace(/\^\{(\d)\}/, '^$1');
  const coef = pow !== 0 && a === 1 ? '' : String(a);
  return sign + coef + vp;
}

/** polynomial from [[coef, pow], ...] (in the given order) */
export function poly(terms, v = 'x') {
  let s = '';
  for (const [c, p] of terms) {
    const t = term(c, p, v, s === '');
    s += t;
  }
  return s || '0';
}

const pm = (n) => (n < 0 ? `-${-n}` : `+${n}`); // signed constant after a term
const par = (n) => (n < 0 ? `(${n})` : `${n}`);

function wrongLine(latex, wrongText, misconception, fix, from = 'last') {
  const at = from === 'first' ? latex.indexOf(wrongText) : latex.lastIndexOf(wrongText);
  if (at < 0) throw new Error(`wrong span "${wrongText}" not in "${latex}"`);
  return { latex, label: 'wrong', span: [at, at + wrongText.length], wrongText, misconception, fix };
}
const L = (latex, label = 'correct') => ({ latex, label });

// ---- families -----------------------------------------------------------------------------------

export function generateSteps(seed = 1) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const nz = (lo, hi) => { let v = 0; while (v === 0) v = int(lo, hi); return v; };
  const out = [];
  const add = (area, topic, lines) => out.push({ area, topic, lines });
  const N = (n, f) => { for (let k = 0; k < n; k++) f(k); };

  // algebra: linear equations ax+b=c
  N(80, (k) => {
    const a = int(2, 9), x = int(-9, 12), b = nz(-15, 15), c = a * x + b;
    const lines = [L(`${a}x${pm(b)}=${c}`, 'given')];
    if (k % 2 === 0) lines.push(L(`${a}x=${c - b}`), L(`x=${x}`));
    else if (k % 4 === 1) {
      const w = c + b;
      lines.push(wrongLine(`${a}x=${w}`, String(w), 'sign-move', `${a}x=${c - b}`), L(`x=${q(w, a)}`, 'carried'));
    } else {
      const w = c - b - a;
      if (w === x) return;
      lines.push(L(`${a}x=${c - b}`), wrongLine(`x=${w}`, String(w), 'inverse-operation', `x=${x}`));
    }
    add('algebra', 'linear equations', lines);
  });

  // algebra: distributing a(x+b)=c
  N(60, (k) => {
    const a = int(2, 7), b = nz(-9, 9), x = int(-6, 8), c = a * (x + b);
    const lines = [L(`${a}(x${pm(b)})=${c}`, 'given')];
    if (k % 2 === 0) lines.push(L(`${a}x${pm(a * b)}=${c}`), L(`${a}x=${c - a * b}`), L(`x=${x}`));
    else {
      lines.push(wrongLine(`${a}x${pm(b)}=${c}`, `${pm(b)}`, 'distribute-first-term', `${a}x${pm(a * b)}=${c}`, 'first'));
      lines.push(L(`${a}x=${c - b}`, 'carried'), L(`x=${q(c - b, a)}`, 'carried'));
    }
    add('algebra', 'linear equations', lines);
  });

  // algebra: expanding products and squares
  N(50, (k) => {
    const p = nz(-9, 9), s = nz(-9, 9);
    if (k % 2 === 0) {
      add('algebra', 'expanding', [L(`(x${pm(p)})(x${pm(s)})=${poly([[1, 2], [p + s, 1], [p * s, 0]])}`, 'correct')]);
    } else if (k % 4 === 1) {
      const right = poly([[1, 2], [2 * p, 1], [p * p, 0]]);
      add('algebra', 'expanding', [wrongLine(`(x${pm(p)})^2=x^2+${p * p}`, `x^2+${p * p}`, 'square-of-sum', `(x${pm(p)})^2=${right}`)]);
    } else {
      const w = p + s + (p * s > 0 ? 1 : -1);
      const right = poly([[1, 2], [p + s, 1], [p * s, 0]]);
      const bad = poly([[1, 2], [w, 1], [p * s, 0]]);
      const mid = term(w, 1, 'x', false);
      add('algebra', 'expanding', [wrongLine(`(x${pm(p)})(x${pm(s)})=${bad}`, mid, 'like-terms', `(x${pm(p)})(x${pm(s)})=${right}`)]);
    }
  });

  // arithmetic: adding fractions
  N(50, (k) => {
    const b = int(2, 9), d = int(2, 9), a = int(1, b - 1 || 1), c = int(1, d - 1 || 1);
    if (b === d) return;
    const left = `\\frac{${a}}{${b}}+\\frac{${c}}{${d}}`;
    const right = q(a * d + c * b, b * d);
    if (k % 2 === 0) add('arithmetic', 'fractions', [L(`${left}=${right}`)]);
    else {
      const w = `\\frac{${a + c}}{${b + d}}`;
      add('arithmetic', 'fractions', [wrongLine(`${left}=${w}`, w, 'fraction-add-denominators', `${left}=${right}`)]);
    }
  });

  // algebra: exponent laws
  N(30, (k) => {
    const a = int(2, 7), b = int(2, 7), v = ['x', 'a', 'y', 't'][k % 4];
    if (k % 3 === 0) add('algebra', 'exponents', [L(`${v}^{${a}}\\cdot ${v}^{${b}}=${v}^{${a + b}}`.replace(/\^\{(\d)\}/g, '^$1'))]);
    else if (k % 3 === 1) add('algebra', 'exponents', [L(`(${v}^{${a}})^{${b}}=${v}^{${a * b}}`.replace(/\^\{(\d)\}/g, '^$1'))]);
    else {
      if (a * b === a + b) return;
      const line = `${v}^{${a}}\\cdot ${v}^{${b}}=${v}^{${a * b}}`.replace(/\^\{(\d)\}/g, '^$1');
      const ww = `${v}^{${a * b}}`.replace(/\^\{(\d)\}/g, '^$1');
      add('algebra', 'exponents', [wrongLine(line, ww, 'exponent-product', `${v}^{${a}}\\cdot ${v}^{${b}}=${v}^{${a + b}}`.replace(/\^\{(\d)\}/g, '^$1'))]);
    }
  });

  // algebra: quadratics with integer roots
  N(40, (k) => {
    const r1 = nz(-8, 8), r2 = nz(-8, 8);
    if (r1 === -r2 || r1 === r2) return;
    const g = `${poly([[1, 2], [-(r1 + r2), 1], [r1 * r2, 0]])}=0`;
    const f = `(x${pm(-r1)})(x${pm(-r2)})=0`;
    if (k % 2 === 0) add('algebra', 'quadratics', [L(g, 'given'), L(f), L(`x=${r1}\\ \\text{or}\\ x=${r2}`)]);
    else {
      const bad = `(x${pm(r1)})(x${pm(r2)})=0`;
      add('algebra', 'quadratics', [L(g, 'given'), wrongLine(bad, bad.slice(0, -2), 'factor-sign', f), L(`x=${-r1}\\ \\text{or}\\ x=${-r2}`, 'carried')]);
    }
  });

  // calculus: power rule
  N(60, (k) => {
    const n = int(2, 7), m = int(1, n - 1), a = nz(-9, 9), b = nz(-9, 9), c = nz(-9, 9);
    const f = poly([[a, n], [b, m], [c, 0]]);
    const d = poly([[a * n, n - 1], [b * m, m - 1]]);
    if (k % 2 === 0) add('calculus', 'derivatives', [L(`f(x)=${f}`, 'given'), L(`f'(x)=${d}`)]);
    else {
      const bad = poly([[a * n, n], [b * m, m - 1]]);
      add('calculus', 'derivatives', [L(`f(x)=${f}`, 'given'), wrongLine(`f'(x)=${bad}`, term(a * n, n, 'x', true), 'power-rule', `f'(x)=${d}`, 'first')]);
    }
  });

  // calculus: chain rule (ax+b)^n
  N(30, (k) => {
    const a = int(2, 6), b = nz(-7, 7), n = int(2, 6);
    const inner = `${a}x${pm(b)}`;
    const right = `${n * a}(${inner})^${n - 1}`.replace('^1', '');
    const line = `\\frac{d}{dx}(${inner})^${n}`;
    if (k % 2 === 0) add('calculus', 'derivatives', [L(`${line}=${right}`)]);
    else {
      const bad = `${n}(${inner})^${n - 1}`.replace('^1', '');
      add('calculus', 'derivatives', [wrongLine(`${line}=${bad}`, bad, 'chain-rule', `${line}=${right}`)]);
    }
  });

  // calculus: product rule x^n e^{kx}
  N(20, (j) => {
    const n = int(2, 5), kk = int(2, 5);
    const line = `\\frac{d}{dx}\\left(x^${n}e^{${kk}x}\\right)`;
    const right = `${n}x^${n - 1}e^{${kk}x}+${kk}x^${n}e^{${kk}x}`.replace('x^1e', 'xe');
    if (j % 2 === 0) add('calculus', 'derivatives', [L(`${line}=${right}`)]);
    else {
      const bad = `${n * kk}x^${n - 1}e^{${kk}x}`.replace('x^1e', 'xe');
      add('calculus', 'derivatives', [wrongLine(`${line}=${bad}`, bad, 'product-rule', `${line}=${right}`)]);
    }
  });

  // calculus: definite integrals of c x^n on [0, b]
  N(50, (k) => {
    const c = int(1, 6), n = int(1, 4), b = int(1, 4);
    const lhs = `\\int_0^${b}${c === 1 ? '' : c}x${n === 1 ? '' : '^' + n}\\,dx`;
    const anti = `\\left[${q(c, n + 1)}x^${n + 1}\\right]_0^${b}`.replace('[1x', '[x');
    const val = q(c * b ** (n + 1), n + 1);
    if (k % 2 === 0) add('calculus', 'integrals', [L(`${lhs}=${anti}`), L(`=${val}`)]);
    else {
      const w = String(c * b ** (n + 1));
      if (w === val) return;
      const badAnti = `\\left[${c}x^${n + 1}\\right]_0^${b}`.replace('[1x', '[x');
      add('calculus', 'integrals', [wrongLine(`${lhs}=${badAnti}`, badAnti, 'power-rule', `${lhs}=${anti}`), L(`=${w}`, 'carried')]);
    }
  });

  // calculus: indefinite integrals
  N(20, (k) => {
    const n = int(2, 8);
    const lhs = `\\int x^${n}\\,dx`;
    if (k % 2 === 0) add('calculus', 'integrals', [L(`${lhs}=\\frac{x^${n + 1}}{${n + 1}}+C`)]);
    else add('calculus', 'integrals', [wrongLine(`${lhs}=x^${n + 1}+C`, `x^${n + 1}`, 'power-rule', `${lhs}=\\frac{x^${n + 1}}{${n + 1}}+C`)]);
  });

  // calculus: removable singularities
  N(30, (k) => {
    const a = nz(-6, 6);
    const lhs = `\\lim_{x\\to ${a}}\\frac{x^2-${a * a}}{x${pm(-a)}}`;
    if (k % 2 === 0) add('calculus', 'limits', [L(`${lhs}=\\lim_{x\\to ${a}}(x${pm(a)})`), L(`=${2 * a}`)]);
    else add('calculus', 'limits', [L(`${lhs}=\\lim_{x\\to ${a}}(x${pm(a)})`), wrongLine(`=${a}`, String(a), 'arithmetic', `=${2 * a}`)]);
  });

  // linear algebra: 2x2 products
  const M = (m) => `\\begin{pmatrix}${m[0][0]}&${m[0][1]}\\\\${m[1][0]}&${m[1][1]}\\end{pmatrix}`;
  N(50, (k) => {
    const A = [[int(-4, 5), int(-4, 5)], [int(-4, 5), int(-4, 5)]], B = [[int(-4, 5), int(-4, 5)], [int(-4, 5), int(-4, 5)]];
    const P = [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]], [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]];
    const E = [[A[0][0] * B[0][0], A[0][1] * B[0][1]], [A[1][0] * B[1][0], A[1][1] * B[1][1]]];
    if (k % 2 === 0) add('linalg', 'matrix products', [L(`${M(A)}${M(B)}=${M(P)}`)]);
    else {
      if (JSON.stringify(E) === JSON.stringify(P)) return;
      add('linalg', 'matrix products', [wrongLine(`${M(A)}${M(B)}=${M(E)}`, M(E), 'matrix-entrywise', `${M(A)}${M(B)}=${M(P)}`)]);
    }
  });

  // linear algebra: 2x2 determinants
  N(40, (k) => {
    const a = int(-6, 9), b = int(-6, 9), c = int(-6, 9), d = int(-6, 9);
    const V = `\\begin{vmatrix}${a}&${b}\\\\${c}&${d}\\end{vmatrix}`;
    if (k % 2 === 0) add('linalg', 'determinants', [L(`${V}=${par(a)}\\cdot ${par(d)}-${par(b)}\\cdot ${par(c)}`), L(`=${a * d - b * c}`)]);
    else {
      if (b * c === 0) return;
      add('linalg', 'determinants', [wrongLine(`${V}=${par(a)}\\cdot ${par(d)}+${par(b)}\\cdot ${par(c)}`, '+', 'det-sign', `${V}=${par(a)}\\cdot ${par(d)}-${par(b)}\\cdot ${par(c)}`), L(`=${a * d + b * c}`, 'carried')]);
    }
  });

  // linear algebra: 3x3 determinants (upper triangular plus one entry, computed by cofactors)
  N(20, (k) => {
    const m = [[int(-3, 4), int(-3, 4), int(-3, 4)], [int(-3, 4), int(-3, 4), int(-3, 4)], [int(-3, 4), int(-3, 4), int(-3, 4)]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const V = `\\begin{vmatrix}${m.map((row) => row.join('&')).join('\\\\')}\\end{vmatrix}`;
    if (k % 2 === 0) add('linalg', 'determinants', [L(`${V}=${det}`)]);
    else {
      const w = det + m[0][1] * 2 * (m[1][0] * m[2][2] - m[1][2] * m[2][0]); // the cofactor of a_12 added instead of subtracted
      if (w === det) return;
      add('linalg', 'determinants', [wrongLine(`${V}=${w}`, String(w), 'cofactor-sign', `${V}=${det}`)]);
    }
  });

  // linear algebra: 2x2 inverses with det 1
  N(20, (k) => {
    const a = int(1, 6), b = int(1, 5), c = int(1, 5);
    if ((1 + b * c) % a !== 0) return;
    const d = (1 + b * c) / a; // ad - bc = 1
    const A = [[a, b], [c, d]], I = [[d, -b], [-c, a]], W = [[a, -b], [-c, d]];
    if (k % 2 === 0) add('linalg', 'inverses', [L(`${M(A)}^{-1}=${M(I)}`)]);
    else {
      if (a === d) return;
      add('linalg', 'inverses', [wrongLine(`${M(A)}^{-1}=${M(W)}`, M(W), 'inverse-formula', `${M(A)}^{-1}=${M(I)}`)]);
    }
  });

  // linear algebra: eigenvalues of triangular matrices
  N(20, (k) => {
    const a = int(-5, 6), b = nz(-5, 5), d = int(-5, 6);
    if (a === d) return;
    const A = M([[a, b], [0, d]]);
    if (k % 2 === 0) add('linalg', 'eigenvalues', [L(`${A}\\begin{pmatrix}1\\\\0\\end{pmatrix}=${a}\\begin{pmatrix}1\\\\0\\end{pmatrix}`.replace(/=1\\begin/, '=\\begin'))]);
    else add('linalg', 'eigenvalues', [wrongLine(`${A}\\begin{pmatrix}1\\\\0\\end{pmatrix}=${d}\\begin{pmatrix}1\\\\0\\end{pmatrix}`, `=${d}`, 'eigenvector', `${A}\\begin{pmatrix}1\\\\0\\end{pmatrix}=${a}\\begin{pmatrix}1\\\\0\\end{pmatrix}`)]);
  });

  // complex numbers: products and moduli
  const cx = (re, im) => (re === 0 ? '' : String(re)) + (im === 0 ? (re === 0 ? '0' : '') : (im < 0 ? '-' : re === 0 ? '' : '+') + (Math.abs(im) === 1 ? '' : Math.abs(im)) + 'i');
  N(50, (k) => {
    const a = nz(-6, 6), b = nz(-6, 6), c = nz(-6, 6), d = nz(-6, 6);
    const lhs = `(${cx(a, b)})(${cx(c, d)})`;
    const right = cx(a * c - b * d, a * d + b * c);
    if (k % 2 === 0) add('complex', 'complex arithmetic', [L(`${lhs}=${right}`)]);
    else {
      const bad = cx(a * c + b * d, a * d + b * c);
      if (bad === right) return;
      add('complex', 'complex arithmetic', [wrongLine(`${lhs}=${bad}`, bad, 'i-squared', `${lhs}=${right}`)]);
    }
  });
  const TRIPLES = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [6, 8, 10], [7, 24, 25], [9, 12, 15], [12, 5, 13], [20, 21, 29]];
  N(16, (k) => {
    const [a, b, c] = TRIPLES[k % 8];
    const s = k % 3 === 0 ? -1 : 1;
    const lhs = `|${cx(a * s, b)}|`;
    if (k < 8) add('complex', 'complex arithmetic', [L(`${lhs}=\\sqrt{${a * a}+${b * b}}=${c}`)]);
    else add('complex', 'complex arithmetic', [wrongLine(`${lhs}=${a + b}`, String(a + b), 'sqrt-of-sum', `${lhs}=${c}`)]);
  });

  // number theory: modular powers, Euclid, gcd
  const modpow = (a, e, n) => { let x = 1; for (let i = 0; i < e; i++) x = (x * a) % n; return x; };
  N(40, (k) => {
    const n = [5, 7, 9, 11, 13, 17][k % 6], a = int(2, 9), e = int(3, 40);
    const res = modpow(a, e, n);
    const line = (v) => `${a}^{${e}}\\equiv ${v}\\pmod{${n}}`;
    if (k % 2 === 0) add('number-theory', 'congruences', [L(line(res))]);
    else {
      const w = (res + int(1, n - 1)) % n;
      add('number-theory', 'congruences', [wrongLine(line(w), String(w), 'arithmetic', line(res), 'last')]);
    }
  });
  N(30, (k) => {
    const g = int(2, 12), a = g * int(5, 20), b = g * int(2, 9);
    const G = gcd(a, b);
    if (k % 2 === 0) add('number-theory', 'gcd', [L(`\\gcd(${a},${b})=${G}`)]);
    else {
      const w = G * 2 <= b ? G * 2 : Math.max(1, G / 2);
      if (!Number.isInteger(w) || w === G) return;
      add('number-theory', 'gcd', [wrongLine(`\\gcd(${a},${b})=${w}`, String(w), 'arithmetic', `\\gcd(${a},${b})=${G}`)]);
    }
  });
  N(20, (k) => {
    const b = int(7, 40), qq = int(2, 9), rr = int(1, b - 1), a = qq * b + rr;
    if (k % 2 === 0) add('number-theory', 'euclid', [L(`${a}=${qq}\\cdot ${b}+${rr}`)]);
    else add('number-theory', 'euclid', [wrongLine(`${a}=${qq}\\cdot ${b}+${rr + 1}`, String(rr + 1), 'arithmetic', `${a}=${qq}\\cdot ${b}+${rr}`)]);
  });

  // discrete: finite sums and binomials
  N(30, (k) => {
    const n = int(4, 30);
    const kind = k % 3;
    const lhs = kind === 0 ? `\\sum_{k=1}^{${n}}k` : kind === 1 ? `\\sum_{k=1}^{${n}}k^2` : `\\sum_{k=0}^{${n % 8 + 2}}2^k`;
    const val = kind === 0 ? (n * (n + 1)) / 2 : kind === 1 ? (n * (n + 1) * (2 * n + 1)) / 6 : 2 ** (n % 8 + 3) - 1;
    const off = kind === 0 ? ((n - 1) * n) / 2 : kind === 1 ? ((n - 1) * n * (2 * n - 1)) / 6 : 2 ** (n % 8 + 2) - 1;
    if (k % 2 === 0) add('discrete', 'finite sums', [L(`${lhs}=${val}`)]);
    else add('discrete', 'finite sums', [wrongLine(`${lhs}=${off}`, String(off), 'sum-index', `${lhs}=${val}`)]);
  });
  const C = (n, k) => { let x = 1; for (let i = 1; i <= k; i++) x = (x * (n - k + i)) / i; return Math.round(x); };
  N(20, (j) => {
    const n = int(4, 12), k = int(1, n - 1);
    if (j % 2 === 0) add('discrete', 'binomials', [L(`\\binom{${n}}{${k}}=\\frac{${n}!}{${k}!\\,${n - k}!}=${C(n, k)}`)]);
    else {
      const w = C(n, k) * k;
      if (w === C(n, k)) return;
      add('discrete', 'binomials', [wrongLine(`\\binom{${n}}{${k}}=${w}`, String(w), 'factorial', `\\binom{${n}}{${k}}=${C(n, k)}`)]);
    }
  });

  // ODEs: constant-coefficient second order, exponential growth
  N(30, (k) => {
    const a = nz(-4, 5), b = nz(-4, 5);
    if (a === b) return;
    const eq = `y''${term(-(a + b), 1, "y'", false)}${term(a * b, 1, 'y', false)}=0`;
    const ch = `${poly([[1, 2], [-(a + b), 1], [a * b, 0]], '\\lambda')}=0`;
    const ex = (r) => (r === 1 ? 'e^{x}' : r === -1 ? 'e^{-x}' : `e^{${r}x}`);
    const sol = `y=C_1${ex(a)}+C_2${ex(b)}`;
    if (k % 2 === 0) add('ode', 'linear ODEs', [L(eq, 'given'), L(ch), L(sol)]);
    else {
      const bad = `y=C_1${ex(-a)}+C_2${ex(-b)}`;
      add('ode', 'linear ODEs', [L(eq, 'given'), L(ch), wrongLine(bad, bad.slice(2), 'char-root-sign', sol)]);
    }
  });
  N(16, (j) => {
    const k = nz(-5, 6), y0 = int(1, 9);
    const g = `y'=${k === 1 ? '' : k === -1 ? '-' : k}y,\\ y(0)=${y0}`;
    const ex = k === 1 ? 'e^{t}' : k === -1 ? 'e^{-t}' : `e^{${k}t}`;
    if (j % 2 === 0) add('ode', 'linear ODEs', [L(g, 'given'), L(`y(t)=${y0 === 1 ? '' : y0}${ex}`)]);
    else {
      if (y0 === 1) return;
      add('ode', 'linear ODEs', [L(g, 'given'), wrongLine(`y(t)=${ex}+${y0 - 1}`, `+${y0 - 1}`, 'initial-condition', `y(t)=${y0}${ex}`)]);
    }
  });

  // logic: De Morgan and contrapositive
  const PAIRS = [['p', 'q'], ['a', 'b'], ['p', 'r'], ['q', 'r'], ['A', 'B'], ['P', 'Q']];
  N(24, (k) => {
    const [p, s] = PAIRS[k % 6];
    if (k % 4 === 0) add('logic-sets', 'propositional logic', [L(`\\neg(${p}\\land ${s})\\equiv\\neg ${p}\\lor\\neg ${s}`)]);
    else if (k % 4 === 1) add('logic-sets', 'propositional logic', [wrongLine(`\\neg(${p}\\land ${s})\\equiv\\neg ${p}\\land\\neg ${s}`, '\\land\\neg', 'de-morgan', `\\neg(${p}\\land ${s})\\equiv\\neg ${p}\\lor\\neg ${s}`)]);
    else if (k % 4 === 2) add('logic-sets', 'propositional logic', [L(`(${p}\\Rightarrow ${s})\\equiv(\\neg ${s}\\Rightarrow\\neg ${p})`)]);
    else add('logic-sets', 'propositional logic', [wrongLine(`(${p}\\Rightarrow ${s})\\equiv(${s}\\Rightarrow ${p})`, `(${s}\\Rightarrow ${p})`, 'converse', `(${p}\\Rightarrow ${s})\\equiv(\\neg ${s}\\Rightarrow\\neg ${p})`)]);
  });

  // sets: finite set operations
  const S = (xs) => (xs.length ? `\\{${xs.join(',')}\\}` : '\\emptyset');
  N(30, (k) => {
    const A = [...new Set(Array.from({ length: int(2, 5) }, () => int(1, 9)))].sort((x, y) => x - y);
    const B = [...new Set(Array.from({ length: int(2, 5) }, () => int(1, 9)))].sort((x, y) => x - y);
    const U = [...new Set([...A, ...B])].sort((x, y) => x - y), I = A.filter((x) => B.includes(x)), D = A.filter((x) => !B.includes(x));
    const op = k % 3;
    const sym = ['\\cup', '\\cap', '\\setminus'][op], res = [U, I, D][op], bad = [I, U, I][op];
    const lhs = `${S(A)}${sym}${S(B)}`;
    if (k % 2 === 0) add('logic-sets', 'set operations', [L(`${lhs}=${S(res)}`)]);
    else {
      if (S(bad) === S(res)) return;
      add('logic-sets', 'set operations', [wrongLine(`${lhs}=${S(bad)}`, S(bad), 'set-operation', `${lhs}=${S(res)}`)]);
    }
  });

  // probability: inclusion-exclusion, fair coins
  N(24, (k) => {
    const pa = int(2, 7) / 10, pb = int(2, 6) / 10, pab = int(1, Math.min(pa, pb) * 10 - 0) / 10;
    const f = (x) => String(Math.round(x * 100) / 100);
    const lhs = `P(A\\cup B)=${f(pa)}+${f(pb)}-${f(pab)}`;
    if (k % 2 === 0) add('probability', 'events', [L(`${lhs}=${f(pa + pb - pab)}`)]);
    else add('probability', 'events', [L(lhs), wrongLine(`=${f(pa + pb + pab)}`, f(pa + pb + pab), 'arithmetic', `=${f(pa + pb - pab)}`)]);
  });
  N(16, (j) => {
    const n = int(3, 8), k = int(0, n);
    const lhs = `P(X=${k})=\\binom{${n}}{${k}}\\left(\\frac{1}{2}\\right)^{${n}}`;
    const val = q(C(n, k), 2 ** n);
    if (j % 2 === 0) add('probability', 'distributions', [L(`${lhs}=${val}`)]);
    else {
      const w = q(1, 2 ** n);
      if (w === val) return;
      add('probability', 'distributions', [wrongLine(`${lhs}=${w}`, w, 'counting', `${lhs}=${val}`)]);
    }
  });

  // multivariable: partial derivatives of monomials
  N(30, (j) => {
    const a = nz(-6, 7), m = int(2, 5), n = int(2, 5);
    const mono = `${a === 1 ? '' : a === -1 ? '-' : a}x^${m}y^${n}`;
    const lhs = `\\frac{\\partial}{\\partial x}\\left(${mono}\\right)`;
    const xm = m - 1 === 1 ? 'x' : `x^${m - 1}`;
    const right = `${a * m}${xm}y^${n}`;
    if (j % 2 === 0) add('multivar', 'partial derivatives', [L(`${lhs}=${right}`)]);
    else {
      const yn = n - 1 === 1 ? 'y' : `y^${n - 1}`;
      const bad = `${a * m * n}${xm}${yn}`;
      add('multivar', 'partial derivatives', [wrongLine(`${lhs}=${bad}`, bad, 'partial-constant', `${lhs}=${right}`)]);
    }
  });

  // numerical: one Newton step for x^2 - c
  N(16, (j) => {
    const c = int(2, 30), x0 = int(1, 6);
    const lhs = `x_1=${x0}-\\frac{${x0}^2-${c}}{2\\cdot ${x0}}`;
    const val = q(x0 * x0 + c, 2 * x0);
    if (j % 2 === 0) add('numerical', 'root finding', [L(`f(x)=x^2-${c},\\ x_0=${x0}`, 'given'), L(lhs), L(`x_1=${val}`)]);
    else {
      const bad = q(3 * x0 * x0 - c, 2 * x0);
      if (bad === val) return;
      add('numerical', 'root finding', [L(`f(x)=x^2-${c},\\ x_0=${x0}`, 'given'), L(lhs), wrongLine(`x_1=${bad}`, bad, 'sign-move', `x_1=${val}`)]);
    }
  });

  return out;
}
