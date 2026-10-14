// What Gemini's OpenAI-compatible endpoint answers through the backend (uses the saved Google key).
export default async ({ win }) => {
  await win.waitForTimeout(1200);
  const call = (body) =>
    win.evaluate(async (b) => {
      const t = performance.now();
      const r = await window.__TAURI_INTERNALS__.invoke('ai_fetch', {
        req: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', method: 'POST', headers: [['content-type', 'application/json'], ['authorization', 'Bearer __GOODINK_SECRET__']], body: JSON.stringify(b), secret: 'google' },
      });
      return { ms: Math.round(performance.now() - t), status: r.status, retryAfter: r.headers.find(([k]) => k === 'retry-after')?.[1], body: r.body.slice(0, 600) };
    }, body);
  console.log('tiny, flash-latest:', JSON.stringify(await call({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'Say OK.' }] })));
  console.log('tiny, effort medium:', JSON.stringify(await call({ model: 'gemini-flash-latest', reasoning_effort: 'medium', messages: [{ role: 'user', content: 'Say OK.' }] })));
  const long = 'This is a transcript sentence about neurons and activations in a neural network. '.repeat(250);
  console.log('20k chars, effort medium:', JSON.stringify(await call({ model: 'gemini-flash-latest', reasoning_effort: 'medium', messages: [{ role: 'system', content: 'Make flashcards. Reply with JSON {"cards":[{"front":"","back":""}]}' }, { role: 'user', content: long }] })));
};
