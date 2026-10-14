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
