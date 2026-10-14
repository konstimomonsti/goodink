// Find sources: real web, Wikipedia and YouTube searches; a local fake AI picks and suggests.
// node tests/drive-tauri.mjs tests/sources.mjs   (needs internet)
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
    if (req.url.startsWith('/v1/chat/completions')) {
      const sys = json.messages[0].content;
      const reply = /find good material/.test(sys)
        ? { topic: 'Nucleophilic substitution', language: 'en', queries: ['SN1 SN2 reaction mechanism'] }
        : { picks: [{ i: 0, why: 'Clear written overview' }, { i: 1, why: 'Second explanation' }, { i: 99, why: 'out of range, must be ignored' }] };
      return send({ id: 'c', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }] });
    }
    res.writeHead(404).end('{}');
  });
});

export default async ({ win, shot }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  try {
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await win.waitForTimeout(1500);
    const skip = win.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await invoke('secret_set', { name: 'custom', value: 'k' });
    await win.evaluate((p) => window.__goodink.updateSettings({ ai: { provider: 'custom', models: { custom: 'mock' }, efforts: {}, baseURLs: { custom: `http://127.0.0.1:${p}/v1` }, keys: ['custom'] } }), port);

    // a topic
    await win.locator('.lib-tab', { hasText: 'Study' }).click();
    await win.locator('.st-tab', { hasText: 'Folders' }).click();
    await win.getByRole('button', { name: 'Find sources' }).click();
    await win.locator('.modal input.input').first().fill('SN1 SN2 reaction mechanism');
    await win.locator('.modal').getByRole('button', { name: 'Search' }).click();
    await win.locator('.fs-list li').first().waitFor({ timeout: 60000 });
    const kinds = await win.locator('.fs-list .fs-kind').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    console.log('results:', kinds.length, '| web', kinds.filter((k) => k === 'web').length, '| wikipedia', kinds.filter((k) => k === 'wikipedia').length, '| youtube', kinds.filter((k) => k === 'youtube').length);
    console.log('AI picks shown:', await win.locator('.fs-list li.is-pick').count(), '| first:', (await win.locator('.fs-list li').first().innerText()).replace(/\n/g, ' | ').slice(0, 160));
    console.log('summary line:', await win.locator('.fs-results > p').innerText());
    await shot('sources-01-topic');
    // add one web result and one video
    await win.getByRole('button', { name: 'Select none' }).click();
    const firstText = (await win.locator('.fs-list li', { has: win.locator('[aria-label="web"]') }).count()) ? '[aria-label="web"]' : '[aria-label="wikipedia"]';
    await win.locator('.fs-list li', { has: win.locator(firstText) }).first().locator('input').check();
    await win.locator('.fs-list li', { has: win.locator('[aria-label="youtube"]') }).first().locator('input').check();
    await win.getByRole('button', { name: /Save 2 to folder/ }).click();
    await win.waitForTimeout(400);
    console.log('resources now:', JSON.stringify(await win.locator('.st-res-list li .st-res-title').allInnerTexts()));

    // a notebook: the AI reads it and suggests the searches
    await win.locator('.lib-tab', { hasText: 'Files' }).click();
    await win.getByRole('button', { name: 'New', exact: true }).click();
    await win.getByRole('menuitem', { name: /^Notebook/ }).click();
    await win.locator('.modal input').first().fill('Organic chemistry');
    await win.getByRole('button', { name: 'Create', exact: true }).click();
    await win.locator('.toolbar:visible').getByRole('button', { name: 'More', exact: true }).click();
    await win.getByRole('menuitem', { name: 'Find sources for this notebook…' }).click();
    await win.locator('.modal').getByRole('button', { name: 'Search' }).click();
    await win.locator('.fs-list li').first().waitFor({ timeout: 60000 });
    const suggest = seen.find((s) => s.path.includes('chat/completions') && /find good material/.test(s.json.messages[0].content));
    console.log('notebook search: page images sent', JSON.stringify(suggest.json.messages[1].content).split('image_url').length - 1, '| results', await win.locator('.fs-list li').count(), '|', await win.locator('.fs-results > p').innerText());
    await shot('sources-02-notebook');
  } finally {
    await invoke('secret_delete', { name: 'custom' }).catch(() => {});
    server.close();
  }
};
