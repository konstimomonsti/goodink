// YouTube links and the free AI preset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeId } from '../../src/renderer/study/youtube.ts';
import { withDefaults, DEFAULT_AI } from '../../src/renderer/lib/ai.ts';

test('every common YouTube link gives its video id', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=aircAruvnKk',
    'https://youtube.com/watch?v=aircAruvnKk&t=42s',
    'youtube.com/watch?v=aircAruvnKk',
    'https://m.youtube.com/watch?v=aircAruvnKk',
    'https://youtu.be/aircAruvnKk?si=abc',
    'https://www.youtube.com/shorts/aircAruvnKk',
    'https://www.youtube.com/live/aircAruvnKk',
    'https://www.youtube.com/embed/aircAruvnKk',
  ]) assert.equal(youtubeId(u), 'aircAruvnKk', u);
  for (const u of ['https://example.com/watch?v=aircAruvnKk', 'https://www.youtube.com/', 'not a link']) assert.equal(youtubeId(u), null, u);
});

test('with no provider set up, the free Gemini preset is used', () => {
  assert.equal(withDefaults(undefined).provider, 'google');
  assert.equal(withDefaults(undefined).models.google, 'gemini-flash-latest');
  assert.equal(withDefaults(undefined).efforts.google, 'medium');
  // an old setting without keys switches to the free preset; one with a key keeps its choice
  assert.equal(withDefaults({ ...DEFAULT_AI, provider: 'anthropic', keys: [] }).provider, 'google');
  const mine = withDefaults({ provider: 'anthropic', models: { anthropic: 'claude-sonnet-5-5' }, efforts: {}, baseURLs: {}, keys: ['anthropic'] });
  assert.equal(mine.provider, 'anthropic');
  assert.equal(mine.models.anthropic, 'claude-sonnet-5-5');
  assert.equal(mine.models.google, 'gemini-flash-latest');
});
