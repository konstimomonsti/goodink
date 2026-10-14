// Typeset math (LaTeX) in AI answers and flashcards with KaTeX, bundled so it works offline.
// Supports $…$ and \(…\) inline, $$…$$ and \[…\] on their own, and \ce{…} chemistry (mhchem).
import { useMemo, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/contrib/mhchem';
import 'katex/dist/katex.min.css';

export type MathPart = { kind: 'text'; v: string } | { kind: 'math'; v: string; display: boolean };

const BLOCK = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
// inline $…$: no space just inside the dollars and no digit right after, so "$5 and $10" stays text
const INLINE = /\u0000(\d+)\u0000|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;

/** Pull display math out first so it may span lines; it comes back as \u0000n\u0000 markers. */
export function extractDisplay(text: string) {
  const blocks: string[] = [];
  const out = text.replace(BLOCK, (_, a: string | undefined, b: string | undefined) => `\u0000${blocks.push((a ?? b ?? '').trim()) - 1}\u0000`);
  return { text: out, blocks };
}

export function mathParts(text: string, blocks: string[] = []): MathPart[] {
  const parts: MathPart[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) parts.push({ kind: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ kind: 'math', v: blocks[+m[1]] ?? '', display: true });
    else parts.push({ kind: 'math', v: (m[2] ?? m[3]).trim(), display: false });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', v: text.slice(last) });
  return parts;
}

export const hasMath = (text: string) => mathParts(extractDisplay(text).text).some((p) => p.kind === 'math');

const cache = new Map<string, string>();

export function MathHtml({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(() => {
    const key = `${display ? 'D' : 'I'}${tex}`;
    let h = cache.get(key);
    if (h === undefined) {
      // trust: false keeps \href, \url and friends from producing links or HTML from model output
      h = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
      if (cache.size > 2000) cache.clear();
      cache.set(key, h);
    }
    return h;
  }, [tex, display]);
  return <span className={display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Inline content: math typeset, other text passed to `text` (for bold, links…) or shown as is. */
export function renderParts(parts: MathPart[], text: (v: string, key: number) => ReactNode = (v) => v): ReactNode[] {
  return parts.map((p, i) => (p.kind === 'math' ? <MathHtml key={i} tex={p.v} display={p.display} /> : <span key={i}>{text(p.v, i)}</span>));
}

const bold = (t: string) => t.split(/(\*\*[^*]+\*\*)/g).map((s, i) => (s.startsWith('**') && s.endsWith('**') && s.length > 4 ? <strong key={i}>{s.slice(2, -2)}</strong> : s));

/** Plain text with math and **bold**: flashcard sides. Line breaks are kept by the container's CSS. */
export function RichText({ text }: { text: string }) {
  const { text: t, blocks } = extractDisplay(text);
  return <>{renderParts(mathParts(t, blocks), bold)}</>;
}

/** LaTeX made readable as plain text, for typed text on notebook pages (which cannot show math). */
export function mathToPlain(text: string) {
  const { text: t, blocks } = extractDisplay(text);
  return mathParts(t, blocks)
    .map((p) => (p.kind === 'text' ? p.v : texToUnicode(p.v)))
    .join('');
}

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π', times: '×', cdot: '·', div: '÷', pm: '±', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', sum: '∑', int: '∫', partial: '∂', nabla: '∇', sqrt: '√', degree: '°', circ: '°',
};
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ' };
const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋' };
const mapAll = (s: string, m: Record<string, string>, fallback: string) => ([...s].every((c) => m[c]) ? [...s].map((c) => m[c]).join('') : `${fallback}(${s})`);

function texToUnicode(tex: string) {
  return tex
    .replace(/\\ce\{([^}]*)\}/g, (_, f: string) => f.replace(/(?<=[A-Za-z)\]])(\d+)/g, (d: string) => mapAll(d, SUB, '_')).replace(/->/g, '→').replace(/<=>/g, '⇌'))
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/\\([A-Za-z]+)/g, (m, name: string) => SYMBOLS[name] ?? m)
    .replace(/\^\{([^}]*)\}|\^(\S)/g, (_, a: string | undefined, b: string | undefined) => mapAll(a ?? b ?? '', SUP, '^'))
    .replace(/_\{([^}]*)\}|_(\S)/g, (_, a: string | undefined, b: string | undefined) => mapAll(a ?? b ?? '', SUB, '_'))
    .replace(/[{}]/g, '')
    .replace(/\\,|\\;|\\!|~/g, ' ');
}
