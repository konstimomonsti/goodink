// Checks the scheduler against Anki's v3 behaviour with default deck options (fuzz off unless noted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, buildQueue, dayNumber, fuzzBounds, leechThresholdMet, ANKI_DEFAULTS, type Grade } from '../../src/renderer/engine/srs.ts';
import type { Flashcard } from '../../src/shared/types.ts';

const NOW = new Date(2026, 9, 9, 12, 0).getTime();
const DAY = 86400_000;
const fresh = (): Flashcard => ({ id: 'c1', pageId: 'p1', state: 'new', ease: 2.5, interval: 0, due: 0 });
const go = (c: Flashcard, g: Grade, at = NOW) => answer(c, g, at, ANKI_DEFAULTS, null);
const review = (interval: number, ease = 2.5, lateDays = 0): Flashcard => ({
  id: 'r', pageId: 'p', state: 'review', ease, interval, lastReview: NOW - (interval + lateDays) * DAY, due: NOW - lateDays * DAY,
});

test('new card: again 1m, hard 6m, good 10m, easy graduates to 4 days', () => {
  assert.equal(go(fresh(), 1).secs, 60);
  assert.equal(go(fresh(), 2).secs, 330); // average of 1m and 10m, like Anki
  assert.equal(go(fresh(), 3).secs, 600);
  const easy = go(fresh(), 4);
  assert.equal(easy.days, 4);
  assert.equal(easy.card.state, 'review');
});

test('good on the last learning step graduates to 1 day at 250% ease', () => {
  const step2 = go(fresh(), 3).card;
  assert.equal(step2.remaining, 1);
  const grad = go(step2, 3, NOW + 600_000);
  assert.equal(grad.card.state, 'review');
  assert.equal(grad.days, 1);
  assert.equal(grad.card.ease, 2.5);
  // hard on the last step repeats it
  assert.equal(go(step2, 2).secs, 600);
});

test('review on time: hard ×1.2, good ×ease, easy ×ease×1.3, with ease changes', () => {
  const c = review(10);
  const hard = go(c, 2), good = go(c, 3), easy = go(c, 4);
  assert.equal(hard.days, 12);
  assert.equal(hard.card.ease, 2.35);
  assert.equal(good.days, 25);
  assert.equal(good.card.ease, 2.5);
  assert.equal(easy.days, 33);
  assert.equal(easy.card.ease, 2.65);
});

test('late reviews count half the delay for good and all of it for easy', () => {
  const c = review(10, 2.5, 4);
  assert.equal(go(c, 3).days, Math.round((10 + 2) * 2.5));
  assert.equal(go(c, 4).days, Math.round((10 + 4) * 2.5 * 1.3));
});

test('hard is at least one day longer, good at least one day longer than hard', () => {
  const c = review(1, 1.3);
  assert.equal(go(c, 2).days, 2);
  assert.equal(go(c, 3).days, 3);
  assert.equal(go(c, 4).days, 4);
});

test('lapse: ease -20%, relearn 10m, then back to a 1 day interval', () => {
  const lapse = go(review(30), 1);
  assert.equal(lapse.card.state, 'relearning');
  assert.equal(lapse.secs, 600);
  assert.equal(lapse.card.ease, 2.3);
  assert.equal(lapse.card.lapses, 1);
  const back = go(lapse.card, 3, NOW + 600_000);
  assert.equal(back.card.state, 'review');
  assert.equal(back.days, 1);
  assert.equal(go(lapse.card, 4).days, 2);
});

test('ease never drops below 130%', () => {
  assert.equal(go(review(5, 1.3), 1).card.ease, 1.3);
  assert.equal(go(review(5, 1.35), 2).card.ease, 1.3);
});

test('leech at 8 lapses, then every 4 more', () => {
  const hits = [...Array(20).keys()].filter((n) => leechThresholdMet(n, 8));
  assert.deepEqual(hits, [8, 12, 16]);
});

test('fuzz ranges match Anki', () => {
  assert.deepEqual(fuzzBounds(1, 1, 36500), [1, 1]);
  assert.deepEqual(fuzzBounds(25, 1, 36500), [22, 28]);
  assert.deepEqual(fuzzBounds(100, 1, 36500), [93, 107]);
  const fuzzed = answer(review(10), 3, NOW, ANKI_DEFAULTS, 0.999).days!;
  assert.ok(fuzzed >= 22 && fuzzed <= 28);
});

test('day rolls over at 4am local time', () => {
  const d = new Date(2026, 9, 10, 3, 59).getTime();
  assert.equal(dayNumber(d), dayNumber(NOW));
  assert.equal(dayNumber(d + 2 * 60_000), dayNumber(NOW) + 1);
});

test('queue: learning first, 20 new cards a day, reviews due today', () => {
  const cards: Flashcard[] = [];
  for (let i = 0; i < 30; i++) cards.push({ id: `n${i}`, pageId: `p${i}`, state: 'new', ease: 2.5, interval: 0, due: 0 });
  cards.push({ ...review(3), id: 'r1', pageId: 'pr1' });
  cards.push({ ...review(3), id: 'r2', pageId: 'pr2', due: NOW + 5 * DAY });
  cards.push({ id: 'l1', pageId: 'pl', state: 'learning', remaining: 1, ease: 2.5, interval: 0, due: NOW - 1000 });
  const q = buildQueue(cards, cards.map((c) => c.id), { day: dayNumber(NOW), newCount: 5, reviewCount: 0 }, NOW);
  assert.equal(q.learning[0].id, 'l1');
  assert.equal(q.counts.new, 15);
  assert.equal(q.counts.review, 1);
  assert.equal(q.main.length, 16);
});
