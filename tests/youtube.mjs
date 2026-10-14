// YouTube resource against the real YouTube (needs internet) and a local fake AI: node tests/drive-tauri.mjs tests/youtube.mjs
import http from 'node:http';

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    seen.push({ path: req.url, json });
    const send = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: 'mock', object: 'model', created: 0, owned_by: 't' }] });
    if (req.url.startsWith('/v1/chat/completions')) return send({ id: 'c', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ cards: [{ front: 'What does a neuron hold?', back: 'A number between 0 and 1 (its activation)' }] }) } }] });
    res.writeHead(404).end('{}');
  });
});

export default async ({ win, shot }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  try {
    await win.waitForTimeout(1500);
    const skip = win.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await invoke('secret_set', { name: 'custom', value: 'k' });
    await win.evaluate((p) => window.__goodink.updateSettings({ ai: { provider: 'custom', models: { custom: 'mock' }, efforts: {}, baseURLs: { custom: `http://127.0.0.1:${p}/v1` }, keys: ['custom'] } }), port);
    await win.locator('.lib-tab', { hasText: 'Study' }).click();
    await win.locator('.st-tab', { hasText: 'Folders' }).click();
    await win.getByRole('button', { name: 'Add link or video' }).click();
    await win.locator('.modal input').fill('https://youtu.be/aircAruvnKk');
    await win.locator('.modal').getByRole('button', { name: /Add to/ }).click();
    await win.locator('.st-res-list li', { hasText: 'neural network' }).waitFor({ timeout: 20000 });
    console.log('resource:', (await win.locator('.st-res-list li', { hasText: 'neural network' }).innerText()).replace(/\n/g, ' | '));
    await win.locator('.st-res-list li', { hasText: 'neural network' }).getByRole('button', { name: 'Make flashcards' }).click();
    await win.locator('.modal').getByRole('button', { name: 'Make flashcards' }).click();
    await win.locator('.ai-card').first().waitFor({ timeout: 60000 });
    const req = seen.filter((s) => s.path.includes('chat/completions')).pop();
    const text = req.json.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const marks = text.match(/\[\d+:\d\d\]/g) ?? [];
    console.log('transcript sent to the AI:', text.length, 'chars |', marks.length, 'time marks | mentions "neuron":', /neuron/i.test(text));
    console.log('sample:', text.slice(text.indexOf('<material>') + 11, text.indexOf('<material>') + 200).replace(/\n/g, ' '));
    await shot('youtube-01-cards');
  } finally {
    await invoke('secret_delete', { name: 'custom' }).catch(() => {});
    server.close();
  }
};
