// Grouping on real pen ink (tests/fixtures/ink): handwriting the synthetic tests did not cover.
// steps-circled.json: "2+2=4", then "3x+2=8 / 3x=6 / x=2" written small with wide gaps between the
// symbols, three different "=" (one with dashes so short they count as dots), "x=2" circled, and a
// stray tap. It used to come out as one block with the circle gluing lines 2 and 3 together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { groupStrokes } from '../../src/renderer/live/recog/geom.ts';
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
