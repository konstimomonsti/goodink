// Grouping on real pen ink (tests/fixtures/ink): handwriting the synthetic tests did not cover.
// steps-circled.json: "2+2=4", then "3x+2=8 / 3x=6 / x=2" written small with wide gaps between the
// symbols, three different "=" (one with dashes so short they count as dots), "x=2" circled, and a
// stray tap. It used to come out as one block with the circle gluing lines 2 and 3 together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { groupStrokes } from '../../src/renderer/live/recog/geom.ts';

// the app's modules import each other without extensions (Vite style); resolve those to .ts here
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (/^\.\.?\//.test(spec) && ctx.parentURL?.endsWith('.ts'))
        for (const ext of ['.ts', '/index.ts'])
          try {
            return next(spec + ext, ctx);
          } catch {
            /* next */
          }
      throw e;
    }
  },
});
import type { Stroke } from '../../src/renderer/live/contract.ts';

function load(name: string): Stroke[] {
  const j = JSON.parse(fs.readFileSync(new URL(`../fixtures/ink/${name}`, import.meta.url), 'utf8')) as { strokes: { id: string; k: string; c: string; w: number; pts: string }[] };
  return j.strokes.map((s) => {
    const b = Buffer.from(s.pts, 'base64');
    const pts = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) [x0, y0, x1, y1] = [Math.min(x0, pts[i]), Math.min(y0, pts[i + 1]), Math.max(x1, pts[i]), Math.max(y1, pts[i + 1])];
    return { id: s.id, kind: s.k, color: s.c, width: s.w, pts, bbox: [x0, y0, x1, y1] } as Stroke;
  });
}

test('real ink: a circled answer, wide gaps and tiny "=" signs group into the right problems and lines', () => {
  const strokes = load('steps-circled.json');
  const blocks = groupStrokes('p', strokes);
  assert.deepEqual(blocks.map((b) => b.lines.map((l) => l.strokeIds.length)), [[8], [9, 6, 5]], '2+2=4 alone; then 3x+2=8, 3x=6, x=2');
  const used = new Set(blocks.flatMap((b) => b.lines.flatMap((l) => l.strokeIds)));
  // the circle (the longest stroke) and the lone tap are not writing
  const circle = strokes.reduce((a, s) => (s.pts.length > a.pts.length ? s : a));
  assert.ok(!used.has(circle.id), 'the circle around x=2 is not part of any line');
  assert.equal(used.size, strokes.length - 2, 'everything else is used, once');
});

test('impossible readings are repaired with handwriting look-alikes, a digit before a new letter', async () => {
  const { repairs } = await import('../../src/renderer/live/recog/read.ts');
  assert.equal(repairs('3x+<=8')[0]?.text, '3x+2=8', 'the 2 the recogniser read as "<"');
  assert.equal(repairs('}x=6')[0]?.text, '3x=6', 'the 3 read as "}"');
  // one swap gives a valid reading with f as a variable; the all-digit reading needs two
  const r = repairs('3x+<=f').map((x) => x.text);
  assert.equal(r[0], '3x+2=f');
  assert.ok(r.includes('3x+2=8'), 'the all-digit reading is offered too');
  assert.deepEqual(repairs('((('), [], 'nothing valid nearby: no repair');
});

test('real ink: a 5 with a separate flag and a stacked fraction under the line above', () => {
  const strokes = load('steps-fraction.json');
  const blocks = groupStrokes('p', strokes);
  assert.deepEqual(blocks.map((b) => b.lines.map((l) => l.strokeIds.length)), [[8], [10, 6, 7]], 'earlier line; then 3x+5=6, 3x=1, x=1/3');
  // the "1" ending 3x=1 is in that line, not stacked onto the numerator of 1/3
  const one = strokes.find((s) => Math.round(s.bbox[0]) === 230 && Math.round(s.bbox[1]) === 162)!;
  assert.ok(blocks[1].lines[1].strokeIds.includes(one.id));
});

test('real ink: inline stacked fractions next to "=" and "+" stay whole and on their line', () => {
  const blocks = groupStrokes('p', load('inline-fractions.json'));
  assert.deepEqual(blocks.map((b) => b.lines.map((l) => l.strokeIds.length)), [[8], [10, 6, 7], [7, 10]], 'x = 1/3 and 2/3 + x = 1, each one line');
});
