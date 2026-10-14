import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape } from '../../src/renderer/engine/shapes.ts';

const pack = (pts: [number, number][]) => new Float32Array(pts.flatMap(([x, y]) => [x, y, 0.5]));
const jitter = (i: number) => Math.sin(i * 12.9898) * 1.2;

test('wobbly circle becomes a circle', () => {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 60) * Math.PI * 2;
    const r = 60 * (1 + 0.04 * Math.sin(i));
    pts.push([200 + Math.cos(a) * r, 200 + Math.sin(a) * r]);
  }
  assert.equal(recognizeShape(pack(pts))?.kind, 'circle');
});

test('flat ellipse becomes an ellipse', () => {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 60) * Math.PI * 2;
    pts.push([200 + Math.cos(a) * 120 + jitter(i), 200 + Math.sin(a) * 50 + jitter(i + 7)]);
  }
  assert.equal(recognizeShape(pack(pts))?.kind, 'ellipse');
});

test('hand-drawn square becomes a rectangle', () => {
  const pts: [number, number][] = [];
  const corners: [number, number][] = [[100, 100], [300, 104], [298, 300], [102, 296], [101, 106]];
  for (let k = 0; k < corners.length - 1; k++)
    for (let i = 0; i < 20; i++) {
      const t = i / 20;
      pts.push([corners[k][0] + (corners[k + 1][0] - corners[k][0]) * t + jitter(i + k * 20), corners[k][1] + (corners[k + 1][1] - corners[k][1]) * t + jitter(i * 3 + k)]);
    }
  assert.equal(recognizeShape(pack(pts))?.kind, 'rectangle');
});

test('triangle becomes a triangle', () => {
  const pts: [number, number][] = [];
  const c: [number, number][] = [[200, 80], [320, 280], [80, 280], [198, 86]];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 25; i++) pts.push([c[k][0] + ((c[k + 1][0] - c[k][0]) * i) / 25, c[k][1] + ((c[k + 1][1] - c[k][1]) * i) / 25]);
  assert.equal(recognizeShape(pack(pts))?.kind, 'triangle');
});

test('nearly straight stroke becomes a snapped line', () => {
  const pts: [number, number][] = Array.from({ length: 30 }, (_, i) => [100 + i * 10, 200 + jitter(i)] as [number, number]);
  const r = recognizeShape(pack(pts));
  assert.equal(r?.kind, 'line');
  assert.ok(Math.abs(r!.pts[1] - r!.pts[4]) < 0.01, 'snapped horizontal');
});

test('scribble is not a shape', () => {
  const pts: [number, number][] = Array.from({ length: 60 }, (_, i) => [100 + i * 4, 200 + Math.sin(i / 2) * 30] as [number, number]);
  assert.equal(recognizeShape(pack(pts)), null);
});
