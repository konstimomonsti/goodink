// Math coverage corpus: a small LaTeX parser plus the canonical normal form used for exact-match
// scoring of recognition (docs/live-ink/MATH-COVERAGE.md §5). Two readings that look the same in
// ink normalise to the same string: whitespace and spacing commands, \left/\right and sizing,
// \dfrac/\tfrac/\cfrac -> \frac, \to/\rightarrow, \le/\leq, \mid/\vert -> |, font-only wrappers
// (\mathbf, \mathrm, \boldsymbol), redundant braces, sub-before-sup, ^{\prime} -> '.
//
//   import { normalize, parseLatex, features, difficulty } from './corpus/normalize.mjs';
//   normalize(String.raw`\dfrac{x^{2}}{2}`)  // '\frac{x^2}{2}'
//
// parseLatex() is also the front end of tests/live/handwriting-latex.mjs. Plain JS, no imports.

// ---- tables -------------------------------------------------------------------------------------

/** commands that take brace arguments: name -> number of mandatory args */
export const ARITY = {
  frac: 2, dfrac: 2, tfrac: 2, cfrac: 2, binom: 2, dbinom: 2, tbinom: 2,
  sqrt: 1, overset: 2, underset: 2, stackrel: 2, xrightarrow: 1, xleftarrow: 1, xmapsto: 1,
  overbrace: 1, underbrace: 1, overline: 1, underline: 1, boxed: 1, cancel: 1, substack: 1,
  hat: 1, widehat: 1, bar: 1, vec: 1, dot: 1, ddot: 1, tilde: 1, widetilde: 1, check: 1, breve: 1,
  acute: 1, grave: 1, mathring: 1, overrightarrow: 1, overleftarrow: 1, overleftrightarrow: 1,
  mathbb: 1, mathcal: 1, mathfrak: 1, mathscr: 1, mathrm: 1, mathbf: 1, mathit: 1, mathsf: 1,
  mathtt: 1, boldsymbol: 1, bm: 1, operatorname: 1, pmod: 1, not: 0,
};
/** commands whose optional [arg] is parsed */
const OPTIONAL = new Set(['sqrt', 'xrightarrow', 'xleftarrow']);
/** commands whose argument is raw text */
export const TEXT_CMDS = new Set(['text', 'textrm', 'textit', 'textbf', 'textsf', 'mbox', 'textup', 'textnormal']);
/** dropped entirely (sizing and style) */
const DROP = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'bigm', 'Bigm', 'middle', 'nonumber', 'notag']);
/** horizontal spacing commands -> width in em (layout) */
export const SPACES = { ',': 0.17, ':': 0.22, '>': 0.22, ';': 0.28, '!': -0.1, ' ': 0.3, quad: 1, qquad: 2, thinspace: 0.17, medspace: 0.22, thickspace: 0.28, enspace: 0.5 };

/** Unicode that people paste or that readers emit -> LaTeX */
export const UNICODE = {
  '−': '-', '–': '-', '×': '\\times ', '÷': '\\div ', '·': '\\cdot ', '⋅': '\\cdot ', '±': '\\pm ', '∓': '\\mp ',
  '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '≈': '\\approx ', '≅': '\\cong ', '≃': '\\simeq ', '∼': '\\sim ', '≡': '\\equiv ', '∝': '\\propto ',
  '≪': '\\ll ', '≫': '\\gg ', '⊥': '\\perp ', '∥': '\\parallel ', '∞': '\\infty ', '∂': '\\partial ', '∇': '\\nabla ',
  '∫': '\\int ', '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ', '∑': '\\sum ', '∏': '\\prod ', '∐': '\\coprod ', '⋃': '\\bigcup ', '⋂': '\\bigcap ',
  '→': '\\to ', '←': '\\leftarrow ', '↔': '\\leftrightarrow ', '⇒': '\\Rightarrow ', '⇐': '\\Leftarrow ', '⇔': '\\Leftrightarrow ', '↦': '\\mapsto ', '↪': '\\hookrightarrow ', '↠': '\\twoheadrightarrow ', '⇀': '\\rightharpoonup ',
  '∈': '\\in ', '∉': '\\notin ', '∋': '\\ni ', '⊂': '\\subset ', '⊆': '\\subseteq ', '⊃': '\\supset ', '⊇': '\\supseteq ', '⊊': '\\subsetneq ', '∪': '\\cup ', '∩': '\\cap ', '∖': '\\setminus ', '∅': '\\emptyset ',
  '∀': '\\forall ', '∃': '\\exists ', '∄': '\\nexists ', '¬': '\\neg ', '∧': '\\land ', '∨': '\\lor ', '⊢': '\\vdash ', '⊨': '\\models ', '⊕': '\\oplus ', '⊗': '\\otimes ', '∘': '\\circ ', '†': '\\dagger ', '∗': '*',
  '′': "'", '″': "''", '⌊': '\\lfloor ', '⌋': '\\rfloor ', '⌈': '\\lceil ', '⌉': '\\rceil ', '‖': '\\| ', '⟨': '\\langle ', '⟩': '\\rangle ', 'ℵ': '\\aleph ', 'ℓ': '\\ell ', 'ℏ': '\\hbar ', '…': '\\dots ', '⋯': '\\dots ', '⊲': '\\lhd ', '◁': '\\lhd ',
  'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}', '𝔽': '\\mathbb{F}',
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ', 'ε': '\\varepsilon ', 'ϵ': '\\epsilon ', 'ζ': '\\zeta ', 'η': '\\eta ', 'θ': '\\theta ', 'ϑ': '\\vartheta ', 'ι': '\\iota ', 'κ': '\\kappa ', 'λ': '\\lambda ', 'μ': '\\mu ', 'ν': '\\nu ', 'ξ': '\\xi ', 'π': '\\pi ', 'ρ': '\\rho ', 'σ': '\\sigma ', 'τ': '\\tau ', 'υ': '\\upsilon ', 'φ': '\\varphi ', 'ϕ': '\\phi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Ξ': '\\Xi ', 'Π': '\\Pi ', 'Σ': '\\Sigma ', 'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ',
};

/** command aliases that are the same ink -> one canonical name (without the backslash) */
export const ALIAS = {
  dfrac: 'frac', tfrac: 'frac', cfrac: 'frac', dbinom: 'binom', tbinom: 'binom',
  rightarrow: 'to', longrightarrow: 'to', gets: 'leftarrow', longleftarrow: 'leftarrow',
  implies: 'Rightarrow', Longrightarrow: 'Rightarrow', impliedby: 'Leftarrow', Longleftarrow: 'Leftarrow',
  iff: 'Leftrightarrow', Longleftrightarrow: 'Leftrightarrow', longleftrightarrow: 'leftrightarrow', longmapsto: 'mapsto',
  leq: 'le', leqslant: 'le', geq: 'ge', geqslant: 'ge', neq: 'ne',
  wedge: 'land', vee: 'lor', lnot: 'neg', owns: 'ni', varnothing: 'emptyset', backslash: 'setminus', smallsetminus: 'setminus',
  ldots: 'dots', cdots: 'dots', dotsc: 'dots', dotsb: 'dots', dotsm: 'dots', dotso: 'dots', mathellipsis: 'dots',
  triangleleft: 'lhd', unlhd: 'unlhd', trianglelefteq: 'unlhd', triangleright: 'rhd', dag: 'dagger', ddag: 'ddagger',
  intop: 'int', cdotp: 'cdot', centerdot: 'cdot', mathscr: 'mathcal', bmod: 'bmod', mod: 'bmod', textrm: 'text', textit: 'text',
  textbf: 'text', textsf: 'text', mbox: 'text', textup: 'text', textnormal: 'text', thinspace: ',', lbrace: '{', rbrace: '}',
  vert: '|', lvert: '|', rvert: '|', mid: '|', Vert: '\\|', lVert: '\\|', rVert: '\\|', lbrack: '[', rbrack: ']', ast: '*', colon: ':', gt: '>', lt: '<',
};
/** font-only wrappers: the ink is the same as the plain argument */
const UNWRAP = new Set(['mathbf', 'mathrm', 'mathit', 'mathsf', 'mathtt', 'boldsymbol', 'bm']);
/** \operatorname{X} for these X is the built-in \X */
const OPNAMES = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd', 'hom', 'arg', 'max', 'min', 'sup', 'inf', 'lim', 'limsup', 'liminf', 'Pr']);

// ---- tokenizer ----------------------------------------------------------------------------------

function readGroupRaw(src, i) {
  // src[i] === '{' -> [raw inner text, index after the closing brace]
  let depth = 1, j = i + 1;
  while (j < src.length && depth) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  return [src.slice(i + 1, j - 1), j];
}

export function tokenize(input) {
  let src = '';
  for (const ch of input) src += UNICODE[ch] ?? ch;
  const out = [];
  let i = 0;
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; out.push({ k: 'ws' }); continue; }
    if (c === '%') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)(\*?)/.exec(src.slice(i));
      if (m) {
        i += m[0].length;
        const name = m[1];
        if (name === 'begin' || name === 'end') {
          skipWs();
          const [env, j] = readGroupRaw(src, i);
          i = j;
          const tok = { k: name, v: env.trim() };
          if (name === 'begin' && /^(array|alignat\*?|alignedat|tabular)$/.test(tok.v)) {
            skipWs();
            if (src[i] === '{') { const [spec, j2] = readGroupRaw(src, i); tok.spec = spec.replace(/\s+/g, ''); i = j2; }
          }
          out.push(tok);
          continue;
        }
        if (TEXT_CMDS.has(name)) {
          skipWs();
          if (src[i] === '{') { const [raw, j] = readGroupRaw(src, i); i = j; out.push({ k: 'text', v: raw }); }
          else out.push({ k: 'text', v: src[i++] ?? '' });
          continue;
        }
        out.push({ k: 'cmd', v: name, star: !!m[2] });
        continue;
      }
      const n = src[i + 1] ?? '';
      i += 2;
      if (n === '\\') out.push({ k: 'nl' });
      else out.push({ k: 'ctl', v: n });
      continue;
    }
    i++;
    if (c === '{') out.push({ k: 'open' });
    else if (c === '}') out.push({ k: 'close' });
    else if (c === '^') out.push({ k: 'sup' });
    else if (c === '_') out.push({ k: 'sub' });
    else if (c === '&') out.push({ k: 'amp' });
    else if (c === '~') out.push({ k: 'ctl', v: ' ' });
    else out.push({ k: 'ch', v: c });
  }
  return out;
}

// ---- parser -------------------------------------------------------------------------------------
//
// Nodes:
//   { t: 'sym', v }                         'x', '+', '\alpha', '\{', '\|'  (stretch: 'left'|'right' after \left/\right)
//   { t: 'group', body }                    {...}
//   { t: 'cmd', name, args: [body], opt }   \frac{a}{b}, \sqrt[3]{x}, \hat{x}, \mathbb{R}, \not
//   { t: 'text', v }                        \text{if } (raw)
//   { t: 'env', name, spec, rows: [[body]] } matrices, cases, aligned
//   { t: 'scripts', base, sub, sup }        base: node | null; sub/sup: body | null
//   { t: 'space', w }                       \, \quad
// body = node[]

export function parseLatex(input) {
  const toks = tokenize(input);
  let i = 0;
  const peek = () => toks[i];
  const skipWs = () => { while (toks[i]?.k === 'ws') i++; };

  function parseArg() {
    // one mandatory argument: a {group} body or a single token
    skipWs();
    const t = toks[i];
    if (!t) return [];
    if (t.k === 'open') {
      i++;
      const body = parseList('close');
      i++; // close
      return body;
    }
    const one = parseAtom();
    return one ? [one] : [];
  }
  function parseOpt() {
    skipWs();
    if (toks[i]?.k === 'ch' && toks[i].v === '[') {
      i++;
      const body = parseList('opt');
      i++; // ]
      return body;
    }
    return null;
  }
  function parseAtom() {
    const t = toks[i];
    if (!t) return null;
    if (t.k === 'ws') { i++; return null; }
    if (t.k === 'open') {
      i++;
      const body = parseList('close');
      i++;
      return { t: 'group', body };
    }
    if (t.k === 'ch') { i++; return { t: 'sym', v: t.v }; }
    if (t.k === 'text') { i++; return { t: 'text', v: t.v }; }
    if (t.k === 'ctl') {
      i++;
      if (t.v in SPACES) return { t: 'space', w: SPACES[t.v] };
      return { t: 'sym', v: '\\' + t.v };
    }
    if (t.k === 'begin') {
      i++;
      return parseEnv(t.v, t.spec ?? null);
    }
    if (t.k === 'cmd') {
      i++;
      const name = t.v;
      if (DROP.has(name)) return null;
      if (name in SPACES) return { t: 'space', w: SPACES[name] };
      if (name === 'left' || name === 'right') {
        skipWs();
        const d = toks[i++];
        const v = d ? (d.k === 'ch' ? d.v : d.k === 'ctl' ? '\\' + d.v : d.k === 'cmd' ? '\\' + d.v : '.') : '.';
        return { t: 'sym', v, stretch: name };
      }
      if (name === 'operatorname') {
        const args = [parseArg()];
        return { t: 'cmd', name, args, opt: null, star: t.star };
      }
      if (name === 'not') {
        skipWs();
        const next = parseAtom();
        return { t: 'cmd', name: 'not', args: [next ? [next] : []], opt: null };
      }
      if (name in ARITY) {
        const opt = OPTIONAL.has(name) ? parseOpt() : null;
        const args = [];
        for (let a = 0; a < ARITY[name]; a++) args.push(parseArg());
        return { t: 'cmd', name, args, opt };
      }
      return { t: 'sym', v: '\\' + name };
    }
    // stray tokens (sup/sub without base handled in parseList; amp/nl outside env)
    i++;
    if (t.k === 'amp') return { t: 'sym', v: '&' };
    if (t.k === 'nl') return { t: 'sym', v: '\\\\' };
    return null;
  }
  function parseEnv(name, spec) {
    const rows = [[[]]];
    for (;;) {
      const t = toks[i];
      if (!t) break;
      if (t.k === 'end') { i++; break; }
      if (t.k === 'amp') { i++; rows[rows.length - 1].push([]); continue; }
      if (t.k === 'nl') {
        i++;
        skipWs();
        if (toks[i]?.k === 'ch' && toks[i].v === '[') { while (toks[i] && !(toks[i].k === 'ch' && toks[i].v === ']')) i++; i++; }
        rows.push([[]]);
        continue;
      }
      const row = rows[rows.length - 1];
      const cell = row[row.length - 1];
      parseInto(cell, (tk) => tk.k === 'end' || tk.k === 'amp' || tk.k === 'nl');
    }
    // drop a trailing empty row (a final \\ before \end)
    const last = rows[rows.length - 1];
    if (rows.length > 1 && last.length === 1 && last[0].length === 0) rows.pop();
    return { t: 'env', name, spec, rows };
  }
  function parseInto(list, stop) {
    // parses one item (with its scripts) into list, unless at a stop token
    const t = toks[i];
    if (!t || stop(t)) return false;
    if (t.k === 'sup' || t.k === 'sub') {
      i++;
      const arg = parseArg();
      let prev = list[list.length - 1];
      if (!prev || prev.t === 'space') { prev = { t: 'scripts', base: null, sub: null, sup: null }; list.push(prev); }
      else if (prev.t !== 'scripts' || (t.k === 'sup' ? prev.sup : prev.sub)) {
        // primes belong with the base: f'^2 -> scripts on f'
        prev = { t: 'scripts', base: list.pop(), sub: null, sup: null };
        list.push(prev);
      }
      if (t.k === 'sup') prev.sup = arg;
      else prev.sub = arg;
      return true;
    }
    const a = parseAtom();
    if (a) list.push(a);
    return true;
  }
  function parseList(until) {
    const list = [];
    const stop = (t) => (until === 'close' ? t.k === 'close' : until === 'opt' ? t.k === 'ch' && t.v === ']' : false) || t.k === 'end';
    while (i < toks.length && parseInto(list, stop));
    return list;
  }
  const body = [];
  while (i < toks.length) {
    if (!parseInto(body, () => false)) break;
  }
  return body;
}

// ---- normal form --------------------------------------------------------------------------------

const isPrimeSup = (sup) => sup && sup.length > 0 && sup.every((n) => n.t === 'sym' && (n.v === '\\prime' || n.v === "'"));
const isAtom = (body) => body.length === 1 && body[0].t === 'sym' && !body[0].stretch && body[0].v !== '\\\\';

function canonName(name) {
  let n = name;
  for (let k = 0; k < 3 && ALIAS[n] !== undefined; k++) n = ALIAS[n];
  return n;
}

/** canonical serialisation of a body; ctx 'arg' = inside a braced argument */
function ser(body) {
  const parts = [];
  for (let k = 0; k < body.length; k++) {
    const n = body[k];
    // \not= -> \ne, \not\in -> \notin, \not| -> \nmid, \not\exists -> \nexists
    parts.push(serNode(n, body, k));
  }
  return joinTokens(parts.filter((p) => p !== ''));
}

function joinTokens(parts) {
  let s = '';
  for (const p of parts) {
    if (/\\[a-zA-Z]+$/.test(s) && /^[a-zA-Z0-9]/.test(p)) s += ' ';
    s += p;
  }
  return s;
}

function scriptStr(body) {
  if (isAtom(body)) {
    const v = symOut(body[0]);
    if (v) return v;
  }
  return '{' + ser(body) + '}';
}

function symOut(n) {
  if (n.stretch && n.v === '.') return '';
  let v = n.v;
  if (v.startsWith('\\') && /^[a-zA-Z]+$/.test(v.slice(1))) {
    const c = canonName(v.slice(1));
    if (c === '{' || c === '}') return '\\' + c;
    if (c === '|' || c === '[' || c === ']' || c === '*' || c === ':' || c === '>' || c === '<') return c;
    if (c === '\\|') return '\\|';
    if (c === ',') return '';
    return '\\' + c;
  }
  return v;
}

function serNode(n, body, k) {
  switch (n.t) {
    case 'space':
      return '';
    case 'sym':
      return symOut(n);
    case 'text': {
      const v = n.v.replace(/\s+/g, ' ').trim();
      return v ? '\\text{' + v + '}' : '';
    }
    case 'group':
      if (n.body.length === 0) return '{}';
      return ser(n.body);
    case 'scripts': {
      let base = '';
      if (n.base) base = n.base.t === 'group' ? (n.base.body.length ? '{' + ser(n.base.body) + '}' : '{}') : serNode(n.base, body, k);
      else base = '{}';
      let out = base;
      let sup = n.sup;
      if (isPrimeSup(sup)) {
        out += "'".repeat(sup.length);
        sup = null;
      }
      if (n.sub && n.sub.length) out += '_' + scriptStr(n.sub);
      else if (n.sub) out += '_{}';
      if (sup && sup.length) out += '^' + scriptStr(sup);
      else if (sup) out += '^{}';
      return out;
    }
    case 'cmd': {
      const name = canonName(n.name);
      if (name === 'not') {
        const inner = n.args[0][0];
        const iv = inner && inner.t === 'sym' ? symOut(inner) : null;
        if (iv === '=') return '\\ne';
        if (iv === '\\in') return '\\notin';
        if (iv === '|') return '\\nmid';
        if (iv === '\\exists') return '\\nexists';
        return '\\not' + (inner ? joinTokens(['', serNode(inner, n.args[0], 0)]) : '');
      }
      if (UNWRAP.has(name)) {
        return ser(n.args[0]);
      }
      if (name === 'operatorname') {
        const raw = n.args[0].map((x) => (x.t === 'sym' ? x.v : x.t === 'text' ? x.v : '')).join('');
        if (OPNAMES.has(raw)) return '\\' + raw;
        if (raw === 'Re') return '\\Re';
        if (raw === 'Im') return '\\Im';
        return '\\operatorname{' + raw + '}';
      }
      if (name === 'pmod') return '(\\bmod ' + ser(n.args[0]) + ')';
      const single = n.args[0] && isAtom(n.args[0]);
      if (name === 'overline' && single) return '\\bar{' + ser(n.args[0]) + '}';
      if (name === 'widehat' && single) return '\\hat{' + ser(n.args[0]) + '}';
      if (name === 'widetilde' && single) return '\\tilde{' + ser(n.args[0]) + '}';
      if (name === 'overrightarrow' && single) return '\\vec{' + ser(n.args[0]) + '}';
      let s = '\\' + name;
      if (n.opt) s += '[' + ser(n.opt) + ']';
      for (const a of n.args) s += '{' + ser(a) + '}';
      return s;
    }
    case 'env': {
      const name = n.name.replace(/\*$/, '');
      const env = name === 'align' || name === 'eqnarray' ? 'aligned' : name === 'gather' ? 'gathered' : name;
      const rows = n.rows.map((r) => r.map((c) => ser(c)).join('&')).join('\\\\');
      return '\\begin{' + env + '}' + (n.spec != null ? '{' + n.spec + '}' : '') + rows + '\\end{' + env + '}';
    }
  }
  return '';
}

/** The canonical normal form for exact-match scoring. Idempotent. */
export function normalize(latex) {
  return ser(parseLatex(latex)).trim();
}

// ---- features and difficulty --------------------------------------------------------------------

export const FEATURES = [
  'frac', 'nested-frac', 'cont-frac', 'sup', 'sub', 'subsup', 'prescript', 'prime', 'sqrt', 'nroot',
  'bigop', 'bigop-limits', 'int', 'int-limits', 'multi-int', 'contour-int', 'lim', 'matrix', 'det-bars',
  'augmented', 'column-vector', 'cases', 'binom', 'brace', 'accent', 'multiline', 'stretch-delim', 'norm',
  'abs', 'angle', 'floor-ceil', 'blackboard', 'calligraphic', 'fraktur', 'greek', 'text', 'arrow',
  'relation', 'set-op', 'logic', 'operatorname', 'stacked', 'dots', 'factorial', 'not',
];

const BIGOPS = new Set(['\\sum', '\\prod', '\\coprod', '\\bigcup', '\\bigcap', '\\bigoplus', '\\bigotimes', '\\bigvee', '\\bigwedge', '\\bigsqcup']);
const INTS = new Set(['\\int', '\\iint', '\\iiint', '\\oint', '\\oiint', '\\intop']);
const LIMS = new Set(['\\lim', '\\limsup', '\\liminf', '\\max', '\\min', '\\sup', '\\inf', '\\argmax', '\\argmin']);
const GREEK = /^\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/;
const ARROWS = /^\\(to|rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|Leftrightarrow|implies|iff|mapsto|longmapsto|hookrightarrow|twoheadrightarrow|rightharpoonup|longrightarrow|Longrightarrow|Longleftrightarrow|uparrow|downarrow|nearrow|searrow|leadsto|gets)$/;
const RELATIONS = /^\\(le|leq|ge|geq|ne|neq|approx|cong|simeq|sim|equiv|propto|ll|gg|perp|parallel|prec|succ|preceq|succeq|asymp|doteq|lhd|unlhd|rhd|leqslant|geqslant)$/;
const SETOPS = /^\\(in|notin|ni|subset|subseteq|supset|supseteq|subsetneq|cup|cap|setminus|emptyset|varnothing|complement|times|bigcup|bigcap|sqcup)$/;
const LOGIC = /^\\(forall|exists|nexists|neg|lnot|land|lor|wedge|vee|vdash|models|Rightarrow|Leftrightarrow|implies|iff|top|bot|therefore|because)$/;
const ACCENTS = new Set(['hat', 'widehat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widetilde', 'check', 'breve', 'acute', 'grave', 'mathring', 'overrightarrow', 'overleftarrow', 'overline', 'underline']);

/** Structure features present in an expression (sorted, subset of FEATURES). */
export function features(latex) {
  const f = new Set();
  const walk = (body, depth) => {
    let bars = 0;
    for (let k = 0; k < body.length; k++) {
      const n = body[k];
      if (n.t === 'sym') {
        if (n.stretch && n.v !== '.') f.add('stretch-delim');
        if (GREEK.test(n.v)) f.add('greek');
        if (ARROWS.test(n.v)) f.add('arrow');
        if (RELATIONS.test(n.v)) f.add('relation');
        if (SETOPS.test(n.v)) f.add('set-op');
        if (LOGIC.test(n.v)) f.add('logic');
        if (BIGOPS.has(n.v)) f.add('bigop');
        if (INTS.has(n.v)) { f.add('int'); if (n.v === '\\iint' || n.v === '\\iiint') f.add('multi-int'); if (n.v === '\\oint') f.add('contour-int'); }
        if (LIMS.has(n.v)) f.add('lim');
        if (/^\\(dots|ldots|cdots|vdots|ddots)$/.test(n.v)) f.add('dots');
        if (n.v === '!') f.add('factorial');
        if (n.v === "'" || n.v === '\\prime') f.add('prime');
        if (/^\\(\||Vert|lVert|rVert)$/.test(n.v)) f.add('norm');
        if (n.v === '|' || /^\\(vert|lvert|rvert)$/.test(n.v)) bars++;
        if (/^\\(langle|rangle)$/.test(n.v)) f.add('angle');
        if (/^\\(lfloor|rfloor|lceil|rceil)$/.test(n.v)) f.add('floor-ceil');
        if (/^\\(sin|cos|tan|log|ln|exp|det|dim|ker|deg|gcd|arg|Re|Im|Pr|hom|sinh|cosh|tanh|arcsin|arccos|arctan|bmod|mod)$/.test(n.v)) f.add('operatorname');
      } else if (n.t === 'text') f.add('text');
      else if (n.t === 'group') walk(n.body, depth);
      else if (n.t === 'scripts') {
        if (n.base) walk([n.base], depth);
        const b = n.base && n.base.t === 'sym' ? n.base.v : null;
        if (!n.base || (n.base.t === 'group' && n.base.body.length === 0)) f.add('prescript');
        if (b && BIGOPS.has(b)) f.add('bigop-limits');
        else if (b && INTS.has(b)) f.add('int-limits');
        else {
          if (isPrimeSup(n.sup)) f.add('prime');
          else if (n.sup) f.add('sup');
          if (n.sub) f.add('sub');
          if (n.sub && n.sup && !isPrimeSup(n.sup)) f.add('subsup');
        }
        if (n.sub) walk(n.sub, depth);
        if (n.sup) walk(n.sup, depth);
      } else if (n.t === 'cmd') {
        const name = n.name;
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
          f.add('frac');
          if (depth > 0) f.add('nested-frac');
          if (name === 'cfrac') f.add('cont-frac');
          n.args.forEach((a) => walk(a, depth + 1));
          continue;
        }
        if (name === 'sqrt') { f.add('sqrt'); if (n.opt) f.add('nroot'); }
        if (name === 'binom' || name === 'dbinom' || name === 'tbinom') f.add('binom');
        if (name === 'overbrace' || name === 'underbrace') f.add('brace');
        if (ACCENTS.has(name)) f.add('accent');
        if (name === 'mathbb') f.add('blackboard');
        if (name === 'mathcal' || name === 'mathscr') f.add('calligraphic');
        if (name === 'mathfrak') f.add('fraktur');
        if (name === 'operatorname') f.add('operatorname');
        if (/^(overset|underset|stackrel|xrightarrow|xleftarrow|xmapsto|substack)$/.test(name)) f.add('stacked');
        if (/^(xrightarrow|xleftarrow|xmapsto)$/.test(name)) f.add('arrow');
        if (name === 'not') f.add('not');
        if (n.opt) walk(n.opt, depth);
        n.args.forEach((a) => walk(a, depth));
      } else if (n.t === 'env') {
        const name = n.name.replace(/\*$/, '');
        if (/matrix$/.test(name) || name === 'array') {
          f.add('matrix');
          if (name === 'vmatrix') f.add('det-bars');
          if (name === 'Vmatrix') f.add('norm');
          if (n.spec && n.spec.includes('|')) f.add('augmented');
          if (n.rows.length > 1 && n.rows.every((r) => r.length === 1)) f.add('column-vector');
        } else if (name === 'cases' || name === 'dcases') f.add('cases');
        else f.add('multiline');
        n.rows.forEach((r) => r.forEach((c) => walk(c, depth)));
      }
    }
    if (bars >= 2) f.add('abs');
  };
  walk(parseLatex(latex), 0);
  return [...f].sort();
}

const TWO_D = new Set(['frac', 'sqrt', 'bigop-limits', 'int-limits', 'matrix', 'cases', 'binom', 'brace', 'multiline', 'stacked', 'subsup', 'prescript', 'lim', 'accent']);

/** 1 = linear (scripts at most), 2 = one or two 2-D structures, 3 = nested or many 2-D structures, matrices or derivations. */
export function difficulty(latex) {
  const f = features(latex);
  const twoD = f.filter((x) => TWO_D.has(x)).length;
  if (f.includes('nested-frac') || f.includes('cont-frac') || f.includes('multiline') || f.includes('augmented') || (f.includes('matrix') && latex.length > 60) || twoD >= 3 || latex.length > 90) return 3;
  if (twoD >= 1) return 2;
  return 1;
}
