// Math in AI output: LaTeX survives the card JSON, and the formula splitter finds what KaTeX should typeset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairLatexEscapes } from '../../src/renderer/lib/ai.ts';

const parse = (raw: string) => JSON.parse(repairLatexEscapes(raw)).cards[0];

test('single-backslash LaTeX in JSON is kept, including commands that look like JSON escapes', () => {
  const c = parse(String.raw`{"cards":[{"front":"What is $\frac{a}{b} \times \theta$?","back":"$\ce{H2SO4} \to \nabla$"}]}`);
  assert.equal(c.front, String.raw`What is $\frac{a}{b} \times \theta$?`);
  assert.equal(c.back, String.raw`$\ce{H2SO4} \to \nabla$`);
});

test('correctly escaped LaTeX and real newlines are left alone', () => {
  const c = parse(String.raw`{"cards":[{"front":"Line one\nLine two","back":"$\\alpha + \\beta$"}]}`);
  assert.equal(c.front, 'Line one\nLine two');
  assert.equal(c.back, String.raw`$\alpha + \beta$`);
});
