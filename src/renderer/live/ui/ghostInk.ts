// Ghost ink: live results drawn like handwriting (Math Notes style). A tiny single-stroke glyph set,
// slanted and slightly jittered per result, drawn in the writer's pen colour at low opacity.
// Glyphs live in a unit box: x 0..~0.62, y 0 (top) .. 1 (baseline); each is a list of strokes.
type Pt = [number, number];
const G: Record<string, { w: number; s: Pt[][] }> = {
  '0': { w: 0.62, s: [[[0.3, 0], [0.08, 0.15], [0, 0.5], [0.08, 0.86], [0.3, 1], [0.52, 0.86], [0.6, 0.5], [0.52, 0.14], [0.3, 0]]] },
  '1': { w: 0.42, s: [[[0.08, 0.22], [0.3, 0], [0.3, 1]]] },
  '2': { w: 0.62, s: [[[0.04, 0.24], [0.14, 0.07], [0.32, 0], [0.5, 0.06], [0.58, 0.24], [0.5, 0.45], [0.02, 1], [0.62, 0.99]]] },
  '3': { w: 0.6, s: [[[0.04, 0.12], [0.28, 0], [0.52, 0.1], [0.52, 0.32], [0.26, 0.47], [0.54, 0.6], [0.58, 0.84], [0.32, 1], [0.04, 0.9]]] },
  '4': { w: 0.64, s: [[[0.44, 0], [0.02, 0.68], [0.62, 0.68]], [[0.46, 0.32], [0.46, 1]]] },
  '5': { w: 0.6, s: [[[0.56, 0], [0.12, 0], [0.06, 0.44], [0.34, 0.38], [0.56, 0.56], [0.54, 0.86], [0.3, 1], [0.04, 0.9]]] },
  '6': { w: 0.6, s: [[[0.5, 0.04], [0.26, 0.2], [0.08, 0.55], [0.12, 0.88], [0.32, 1], [0.52, 0.88], [0.56, 0.66], [0.36, 0.52], [0.12, 0.62]]] },
  '7': { w: 0.6, s: [[[0.02, 0.02], [0.6, 0], [0.22, 1]]] },
  '8': { w: 0.6, s: [[[0.3, 0.48], [0.08, 0.3], [0.12, 0.08], [0.32, 0], [0.5, 0.1], [0.5, 0.3], [0.3, 0.48], [0.06, 0.68], [0.1, 0.92], [0.32, 1], [0.54, 0.9], [0.56, 0.68], [0.3, 0.48]]] },
  '9': { w: 0.6, s: [[[0.52, 0.3], [0.36, 0.46], [0.12, 0.4], [0.08, 0.18], [0.28, 0], [0.5, 0.08], [0.54, 0.3], [0.5, 0.7], [0.36, 1]]] },
  '.': { w: 0.22, s: [[[0.08, 0.95], [0.11, 0.98]]] },
  ',': { w: 0.22, s: [[[0.1, 0.9], [0.06, 1.12]]] },
  '-': { w: 0.5, s: [[[0.04, 0.6], [0.46, 0.6]]] },
  '+': { w: 0.6, s: [[[0.3, 0.32], [0.3, 0.92]], [[0.02, 0.62], [0.58, 0.62]]] },
  '/': { w: 0.5, s: [[[0.48, 0], [0.04, 1]]] },
  '(': { w: 0.36, s: [[[0.32, -0.04], [0.1, 0.3], [0.08, 0.7], [0.32, 1.06]]] },
  ')': { w: 0.36, s: [[[0.04, -0.04], [0.26, 0.3], [0.28, 0.7], [0.04, 1.06]]] },
  '·': { w: 0.24, s: [[[0.1, 0.58], [0.13, 0.61]]] },
  '√': { w: 0.5, s: [[[0, 0.62], [0.12, 0.56], [0.24, 1], [0.38, -0.02], [0.5, -0.02]]] },
  'π': { w: 0.66, s: [[[0.02, 0.42], [0.64, 0.38]], [[0.2, 0.4], [0.14, 1]], [[0.46, 0.4], [0.48, 0.98]]] },
  x: { w: 0.58, s: [[[0.02, 0.38], [0.56, 1]], [[0.56, 0.38], [0.02, 1]]] },
  a: { w: 0.6, s: [[[0.5, 0.48], [0.3, 0.38], [0.1, 0.52], [0.08, 0.84], [0.28, 1], [0.48, 0.84], [0.5, 0.42], [0.54, 1]]] },
  y: { w: 0.6, s: [[[0.02, 0.38], [0.3, 0.8]], [[0.58, 0.38], [0.2, 1.3]]] },
  n: { w: 0.6, s: [[[0.04, 0.4], [0.06, 1]], [[0.06, 0.62], [0.28, 0.4], [0.5, 0.48], [0.54, 1]]] },
};

/** LaTeX → the plain characters ghost ink can draw ("\frac{1}{2}" → "1/2"). */
export function ghostText(tex: string) {
  return tex
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√$1')
    .replace(/\\pi\b/g, 'π')
    .replace(/\\cdot|\\times/g, '·')
    .replace(/\\left|\\right|\\,|\\;|\\!|\s+/g, '')
    .replace(/[{}]/g, '');
}

/** Can every character be drawn as ghost ink? (otherwise the result falls back to typeset text) */
export const ghostable = (s: string) => [...s].every((c) => G[c]);

/**
 * Stroke paths for `text`, baseline-left at (0, 0), glyph height `h`, in a local frame where +x runs
 * along the line and +y down. `map` turns local points into screen points. Deterministic per seed.
 */
export function ghostPaths(text: string, h: number, seed: number, map: (x: number, y: number) => [number, number]) {
  let s = seed || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const slant = 0.14;
  const out: string[] = [];
  let cx = 0;
  for (const ch of text) {
    const g = G[ch];
    if (!g) continue;
    const jx = rnd() * 0.03 * h, jy = rnd() * 0.04 * h;
    for (const stroke of g.s) {
      let d = '';
      stroke.forEach(([u, v], k) => {
        const [x, y] = map(cx + (u + (1 - v) * slant) * h + jx + rnd() * 0.012 * h, (v - 1) * h + jy + rnd() * 0.012 * h);
        d += `${k ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
      });
      out.push(d);
    }
    cx += (g.w + 0.14) * h;
  }
  return { d: out.join(''), width: cx };
}
