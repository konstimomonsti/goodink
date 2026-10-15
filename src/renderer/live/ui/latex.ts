// Reading → LaTeX for the insight card, with the wrong part of a line in red.
import type { Issue, LineRecognition } from '../contract';

const ERR = '#d9473f';

/** Plain linear math ("x^2-4=(x-2)(x+2)", "3*x/2") as LaTeX good enough to typeset. */
export function plainToTex(s: string) {
  return s
    .replace(/\\/g, '\\backslash ')
    .replace(/([{}#%&_])/g, '\\$1')
    .replace(/<=|≤/g, '\\le ')
    .replace(/>=|≥/g, '\\ge ')
    .replace(/!=|≠/g, '\\ne ')
    .replace(/\*|·|×/g, '\\cdot ')
    .replace(/÷/g, '\\div ')
    .replace(/sqrt\(([^()]*)\)/g, '\\sqrt{$1}')
    .replace(/√\(([^()]*)\)/g, '\\sqrt{$1}')
    .replace(/√(\w+)/g, '\\sqrt{$1}')
    .replace(/\^\(([^()]*)\)/g, '^{$1}')
    .replace(/\bpi\b|π/g, '\\pi ');
}

/** The line as LaTeX; with an issue span, that part of the text coloured. */
export function lineTex(r: LineRecognition, issue?: Issue | null) {
  if (r.kind === 'text') return null;
  const span = issue?.span;
  if (!span || span[0] >= span[1] || span[1] > r.text.length) return r.latex || plainToTex(r.text);
  const a = r.text.slice(0, span[0]), b = r.text.slice(span[0], span[1]), c = r.text.slice(span[1]);
  return `${plainToTex(a)}{\\color{${ERR}}\\underline{${plainToTex(b)}}}${plainToTex(c)}`;
}

// ---- correcting a reading -------------------------------------------------------------------------

/** Symbols handwriting recognisers confuse: a correction may swap one for another. */
const CONFUSABLE = ['a096', 'l1I|', 'o0O', 'S5s', 'z2Z', 'b6', 'g9q', 'x×X*', '-−–', 't+', 'B8', 'y4', 'u4'];
const confusable = (a: string, b: string) => CONFUSABLE.some((g) => g.includes(a) && g.includes(b));

/**
 * May the learner correct this reading to `next`? Only symbols the recogniser could have misread:
 * the new text is one of its own alternates (p ≥ 0.05), or every changed symbol is a look-alike of
 * what was read. Anything else would change the work itself, which has to happen in ink.
 */
export function editPlausible(r: LineRecognition, next: string) {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const n = norm(next), t = norm(r.text);
  if (n === t) return true;
  if (r.alternates.some((a, i) => norm(a) === n && (r.alternateProbs?.[i] ?? 1) >= 0.05)) return true;
  if (n.length !== t.length) return false;
  return [...t].every((c, i) => c === n[i] || confusable(c, n[i]));
}
