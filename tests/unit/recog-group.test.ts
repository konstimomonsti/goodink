// Live ink grouping: synthetic handwriting (tests/live/handwriting.mjs) is split into the right
// lines and blocks, fractions/exponents/dots stay on their line, ids are stable, and it is fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupStrokes } from '../../src/renderer/live/recog/geom.ts';
// @ts-expect-error plain JS test helper
import { strokesFor } from '../live/handwriting.mjs';
import type { Stroke } from '../../src/renderer/live/contract.ts';

let n = 0;
type W = { pts: number[][]; mark: string };
function write(text: string, x: number, y: number, o: Record<string, number> = {}): Stroke[] {
  return (strokesFor(text, { x, y, size: 24, jitter: 0.5, seed: 3, ...o }) as W[]).map((s) => {
    const pts = new Float32Array(s.pts.flat());
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [a, b] of s.pts) [x0, y0, x1, y1] = [Math.min(x0, a), Math.min(y0, b), Math.max(x1, a), Math.max(y1, b)];
    return { id: `s${String(n++).padStart(4, '0')}`, kind: 'pen', color: '#000', width: 1.6, pts, bbox: [x0, y0, x1, y1] } as Stroke;
  });
}

test('a worked problem is one block of lines in writing order; a far paragraph is another block', () => {
  const l1 = write('2x+3=7', 60, 100);
  const l2 = write('2x=4', 60, 150);
  const l3 = write('x=2', 60, 200);
  const prose = write('The answer is two', 60, 330);
  const blocks = groupStrokes('p', [...l3, ...prose, ...l1, ...l2]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].lines.map((l) => l.strokeIds.length), [l1.length, l2.length, l3.length]);
  assert.deepEqual(blocks[0].lines[0].strokeIds, l1.map((s) => s.id).sort());
  assert.equal(blocks[1].lines.length, 1);
  assert.equal(blocks[1].lines[0].strokeIds.length, prose.length);
});

test('fractions, exponents, roots, i-dots and = signs stay on their line', () => {
  const lines = [
    write(String.raw`\frac{3}{4}+\frac{1}{4}=1`, 60, 100),
    write('x^2-4=(x-2)(x+2)', 60, 170),
    write(String.raw`\sqrt{x+1}=3`, 60, 230),
    write('this is it', 60, 290),
    write(String.raw`y=\frac{x^2+1}{2x}`, 60, 360),
  ];
  const blocks = groupStrokes('p', lines.flat());
  const got = blocks.flatMap((b) => b.lines.map((l) => l.strokeIds.length));
  assert.deepEqual(got, lines.map((l) => l.length));
});

test('two columns side by side are separate lines and blocks', () => {
  const a = write('a+b=c', 60, 100);
  const b = write('5-2=3', 360, 100);
  const blocks = groupStrokes('p', [...a, ...b]);
  assert.equal(blocks.length, 2);
});

test('ids are stable and depend only on the strokes', () => {
  const s = [...write('x+1=2', 60, 100), ...write('x=1', 60, 150)];
  const a = groupStrokes('p', s), b = groupStrokes('p', [...s].reverse());
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.deepEqual(a[0].lines.map((l) => l.id), b[0].lines.map((l) => l.id));
  const c = groupStrokes('p', s.slice(0, -1));
  assert.notEqual(c[0].lines.at(-1)!.id, a[0].lines.at(-1)!.id);
  assert.equal(c[0].lines[0].id, a[0].lines[0].id);
});

test('highlighter, tape and shapes are ignored', () => {
  const s = write('x=1', 60, 100);
  const hl = { ...s[0], id: 'hl', kind: 'highlighter' } as Stroke;
  const shape = { ...s[1], id: 'sh', shape: true } as Stroke;
  const blocks = groupStrokes('p', [...s, hl, shape]);
  assert.equal(blocks[0].lines[0].strokeIds.length, s.length);
});

test('500 strokes group in under 2 ms', () => {
  const s: Stroke[] = [];
  for (let r = 0; s.length < 500; r++) s.push(...write(r % 3 ? '3x-5=10+2y' : 'the sum of the parts', 40 + (r % 2) * 280, 60 + Math.floor(r / 2) * 48, { size: 18, seed: r }));
  for (let i = 0; i < 5; i++) groupStrokes('p', s); // warm the JIT
  // best of a few batches: the test runner shares the CPU with other test files
  let ms = Infinity;
  for (let b = 0; b < 12; b++) {
    const t = performance.now();
    for (let i = 0; i < 4; i++) groupStrokes('p', s);
    ms = Math.min(ms, (performance.now() - t) / 4);
  }
  assert.ok(ms < 2, `grouping took ${ms.toFixed(2)} ms`);
});
