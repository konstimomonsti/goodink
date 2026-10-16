// "Edit reading" fixes misreads only (critic round 1, P0-4): typing the right answer over wrong ink
// must not turn it green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plausibleEdit } from '../../src/renderer/live/ui/editReading.ts';

test('lookalike symbols and the recogniser’s own alternates are accepted', () => {
  assert.ok(plausibleEdit('0=3', [], 'a=3'), 'a read as 0');
  assert.ok(plausibleEdit('29+1=', ['2a+1='], '2a+1='), 'an alternate');
  assert.ok(plausibleEdit('2x=S', [], '2x=5'), 'S read for 5');
  assert.ok(plausibleEdit('l2+3', [], '12+3'), 'l read for 1');
  assert.ok(plausibleEdit('7x8=', [], '7×8='), 'x for ×');
  assert.ok(plausibleEdit('2x+3=7', [], '2x+3 = 7'), 'spacing');
  assert.ok(plausibleEdit('x=3', [], 'x=3.'), 'a dropped dot');
});

test('changing what is written is refused', () => {
  assert.ok(!plausibleEdit('x=3', [], 'x=2'), 'the critic’s case: 3 is not a lookalike of 2');
  assert.ok(!plausibleEdit('2x=4', [], '2x=8'));
  assert.ok(!plausibleEdit('x=3', [], 'x=12'));
  assert.ok(!plausibleEdit('2x+3=7', [], 'x=2'), 'a different line');
  assert.ok(!plausibleEdit('x=3', [], ''));
  assert.ok(!plausibleEdit('abcdefgh', [], 'q0zt-u[o'), 'a lookalike rewrite of a whole line');
});
