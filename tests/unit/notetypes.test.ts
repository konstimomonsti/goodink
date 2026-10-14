// Anki-style note types: templates, cloze, conditional sections, typed answers, card generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOCK_TYPES, renderSide, cardOrdinals, compareTyped, htmlToText, textToHtml, TYPE_MARK, type Note } from '../../src/renderer/study/notetypes.ts';

const type = (id: string) => STOCK_TYPES.find((t) => t.id === id)!;
const note = (typeId: string, fields: string[]): Note => ({ id: 'n', typeId, fields, tags: ['chem'], created: 0, modified: 0 });

test('Basic: one card, back shows the front above the answer', () => {
  const n = note('nt-basic', ['What is H<sub>2</sub>O?', 'Water']);
  assert.deepEqual(cardOrdinals(type('nt-basic'), n), [0]);
  assert.equal(renderSide(type('nt-basic'), n, 0, 'q'), 'What is H<sub>2</sub>O?');
  assert.equal(renderSide(type('nt-basic'), n, 0, 'a'), 'What is H<sub>2</sub>O?\n\n<hr id="answer">\n\nWater');
});

test('reversed: two cards; optional reversed only when "Add Reverse" is filled', () => {
  assert.deepEqual(cardOrdinals(type('nt-basic-reversed'), note('nt-basic-reversed', ['a', 'b'])), [0, 1]);
  assert.equal(renderSide(type('nt-basic-reversed'), note('nt-basic-reversed', ['a', 'b']), 1, 'q'), 'b');
  assert.deepEqual(cardOrdinals(type('nt-basic-optional'), note('nt-basic-optional', ['a', 'b', ''])), [0]);
  assert.deepEqual(cardOrdinals(type('nt-basic-optional'), note('nt-basic-optional', ['a', 'b', 'y'])), [0, 1]);
  assert.deepEqual(cardOrdinals(type('nt-basic'), note('nt-basic', ['', 'only a back'])), []);
});

test('cloze: one card per number, hints, other deletions shown', () => {
  const n = note('nt-cloze', ['{{c1::Paris}} is the capital of {{c2::France::country}}', 'Geography']);
  assert.deepEqual(cardOrdinals(type('nt-cloze'), n), [1, 2]);
  assert.equal(renderSide(type('nt-cloze'), n, 2, 'q'), 'Paris is the capital of <span class="cloze">[country]</span>');
  assert.equal(renderSide(type('nt-cloze'), n, 1, 'a'), '<span class="cloze">Paris</span> is the capital of France<br>\nGeography');
});

test('sections, filters and special fields', () => {
  const t = { ...type('nt-basic'), templates: [{ name: 'C', front: '{{#Back}}has back{{/Back}}{{^Back}}no back{{/Back}} {{text:Front}} {{Tags}} {{Card}} {{Nope}}', back: '{{hint:Back}}' }] };
  assert.equal(renderSide(t, note('nt-basic', ['<b>x</b>', '']), 0, 'q'), 'no back x chem C {unknown field Nope}');
  assert.equal(renderSide(t, note('nt-basic', ['x', 'y']), 0, 'q').startsWith('has back'), true);
  assert.match(renderSide(t, note('nt-basic', ['x', 'y']), 0, 'a'), /<details class="hint"><summary>Show Back<\/summary>y<\/details>/);
});

test('type in the answer: a box on the front, a comparison on the back', () => {
  const t = type('nt-basic-typein');
  const n = note('nt-basic-typein', ['Capital of France?', 'Paris']);
  assert.ok(renderSide(t, n, 0, 'q').includes(TYPE_MARK));
  assert.match(renderSide(t, n, 0, 'a', { typed: 'Paris' }), /typeans-good">Paris</);
  const diff = compareTyped('Pariz', 'Paris');
  assert.match(diff, /typeans-good">Pari</);
  assert.match(diff, /typeans-bad">z</);
  assert.match(diff, /typeans-missing">s</);
});

test('text and HTML convert both ways', () => {
  assert.equal(textToHtml('a < b\nc'), 'a &lt; b<br>c');
  assert.equal(htmlToText('a &lt; b<br>c<div>d</div><img src="x">'), 'a < b\nc\nd [image]');
});
