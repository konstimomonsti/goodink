// One organisation for notes, links, videos and flashcards: node tests/drive-tauri.mjs tests/unified.mjs
// Uses the real YouTube (internet) and a local fake AI.
import http from 'node:http';

const seen = [];
const ARTICLE = '<html><head><title>Photosynthesis basics</title></head><body><article><h1>Photosynthesis</h1><p>Plants turn light, water and carbon dioxide into glucose and oxygen.</p><p>It happens in the chloroplasts of plant cells.</p></article></body></html>';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    seen.push({ path: req.url, json });
    if (req.url === '/article') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
    const send = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url.startsWith('/v1/models')) return send({ object: 'list', data: [{ id: 'mock', object: 'model', created: 0, owned_by: 't' }] });
    if (req.url.startsWith('/v1/chat/completions')) {
      const sys = json.messages[0].content;
      const reply = /pick study sources/.test(sys) ? { picks: [{ i: 0, why: 'Clear overview' }] } : { cards: [{ front: 'Where does photosynthesis happen?', back: 'In the chloroplasts' }] };
      return send({ id: 'c', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }] });
    }
    res.writeHead(404).end('{}');
  });
});

export default async ({ win, shot, browser }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const article = `http://127.0.0.1:${port}/article`;
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const vis = (sel) => win.locator(`${sel}:visible`);
  try {
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await win.waitForTimeout(1500);
    const skip = win.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await invoke('secret_set', { name: 'custom', value: 'k' });
    await win.evaluate((p) => window.__goodink.updateSettings({ ai: { provider: 'custom', models: { custom: 'mock' }, efforts: {}, baseURLs: { custom: `http://127.0.0.1:${p}/v1` }, keys: ['custom'] } }), port);
    // an old Study resource from 2.8, to be moved into the library
    await invoke('doc_write', { name: 'study.json', json: JSON.stringify({ v: 1, decks: [], cards: [], resources: [{ id: 'old-link', kind: 'link', title: 'Old saved page', url: article, added: 1 }], revlog: [], imported: [] }) });

    // Files: a folder with a video and a web page in it
    await win.getByRole('button', { name: 'Folder', exact: true }).click();
    await win.locator('.modal input').fill('Biology');
    await win.getByRole('button', { name: 'Save', exact: true }).click();
    await win.getByRole('button', { name: 'Open folder Biology' }).click();
    const addLink = async (url) => {
      await win.getByRole('button', { name: 'New', exact: true }).click();
      await win.getByRole('menuitem', { name: /Link or YouTube video/ }).click();
      await win.locator('.modal input').fill(url);
      await win.locator('.modal').getByRole('button', { name: /Add to/ }).click();
      await win.locator('.modal').waitFor({ state: 'detached', timeout: 20000 });
    };
    await addLink('https://youtu.be/aircAruvnKk');
    await addLink(article);
    console.log('Biology in Files:', JSON.stringify(await win.locator('.lib-scroll .card-title').allInnerTexts()));
    await shot('unified-01-files');

    // open both inside the app
    await win.getByRole('button', { name: 'Open Photosynthesis basics' }).click();
    await vis('.web-preview').waitFor({ timeout: 15000 });
    // the page itself runs in its own native webview (a separate CDP target), not as copied text
    let pageTarget = null;
    for (let i = 0; i < 40 && !pageTarget; i++) {
      pageTarget = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(article));
      if (!pageTarget) await win.waitForTimeout(250);
    }
    console.log('web preview: native page loaded', !!pageTarget, '| its text:', pageTarget ? (await pageTarget.locator('h1').innerText().catch(() => '?')) : '-', '| no reader copy:', (await win.locator('.lv-reader').count()) === 0);
    await shot('unified-01b-web-preview');
    await win.getByRole('tab', { name: 'Files' }).click();
    await win.getByRole('button', { name: /Open But what is a neural network/ }).click();
    await vis('.lv-player iframe').waitFor({ timeout: 15000 });
    await vis('.lv-transcript p').first().waitFor({ timeout: 20000 });
    console.log('video tab: player', await vis('.lv-player iframe').getAttribute('src'), '| transcript lines', await vis('.lv-transcript p').count());
    await shot('unified-02-video-tab');
    await win.getByRole('tab', { name: 'Files' }).click();

    // Study the same folder: make cards from the web page into the folder's deck
    await win.getByRole('button', { name: /Study this folder/ }).click();
    await win.locator('.st-folders').waitFor();
    console.log('Study opens at:', await win.locator('.st-crumbs').innerText(), '| items:', JSON.stringify(await win.locator('.st-folders .st-res-title').allInnerTexts()));
    await win.locator('.st-res-list li', { hasText: 'Photosynthesis basics' }).getByRole('button', { name: 'Make flashcards' }).click();
    console.log('deck chosen by default:', await win.locator('.modal').getByLabel('Add to deck').locator('option:checked').innerText());
    await win.locator('.modal').getByRole('button', { name: 'Make flashcards' }).click();
    await win.getByRole('button', { name: /Add 1 card/ }).click();
    await win.waitForTimeout(400);
    console.log('folder deck:', (await win.locator('.st-folder-deck').innerText()).replace(/\n/g, ' | '));
    await shot('unified-03-study-folder');

    // Find sources into this folder, previewing one inside the app first
    await win.locator('.st-folders').getByRole('button', { name: 'Find sources' }).click();
    await win.locator('.modal input.input').first().fill('photosynthesis');
    await win.locator('.modal').getByRole('button', { name: 'Search' }).click();
    await win.locator('.fs-list li').first().waitFor({ timeout: 60000 });
    console.log('saving to:', await win.locator('.modal').getByLabel('Save to folder').locator('option:checked').innerText());
    await win.locator('.fs-list li').first().getByRole('button', { name: 'Preview' }).click();
    await win.locator('.fs-preview .web-preview, .fs-preview .lv-player iframe').first().waitFor({ timeout: 20000 });
    console.log('preview shows:', (await win.locator('.fs-preview').innerText()).slice(0, 80).replace(/\s+/g, ' '));
    console.log('preview inside the app:', await win.locator('.fs-preview').count() === 1);
    await shot('unified-04-preview');
    await win.getByRole('button', { name: 'Select none' }).click();
    await win.locator('.fs-list li').first().locator('input[type=checkbox]').check();
    await win.getByRole('button', { name: /Save 1 to folder/ }).click();
    await win.waitForTimeout(500);

    // back in Files, same folder, with the new source
    await win.locator('.st-folders').getByRole('button', { name: 'Show in Files' }).click();
    await win.waitForTimeout(400);
    console.log('Files at:', await win.locator('.crumbs').first().innerText().catch(() => '?'), '| items:', await win.locator('.lib-scroll .card').count());
    // the old resource moved into the library (top level)
    console.log('old resource now in library:', await win.evaluate(() => window.__goodink.useApp.getState().library.links.some((x) => x.id === 'old-link' && x.folderId === null)));
    const sj = JSON.parse(await invoke('doc_read', { name: 'study.json' }));
    console.log('study.json resources left:', sj.resources.length, '| folder decks:', JSON.stringify(sj.decks.filter((d) => d.folderId).map((d) => d.name)));
  } finally {
    await invoke('secret_delete', { name: 'custom' }).catch(() => {});
    server.close();
  }
};
