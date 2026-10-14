// The Study environment end to end, with a local fake AI provider: node tests/drive-tauri.mjs tests/study-env.mjs
import http from 'node:http';

const seen = [];
const ARTICLE = '<html><head><title>Photosynthesis basics</title></head><body><nav>menu</nav><article><h1>Photosynthesis</h1><p>Plants turn light, water and carbon dioxide into glucose and oxygen.</p><p>It happens in the chloroplasts.</p></article><footer>cookies</footer></body></html>';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    seen.push({ path: req.url, json });
    if (req.url === '/article') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
    if (req.url.startsWith('/oai/v1/models')) return send(res, { object: 'list', data: ['mock-vision', 'mock-vision-2'].map((id) => ({ id, object: 'model', created: 0, owned_by: 't' })) });
    if (req.url.startsWith('/oai/v1/chat/completions')) {
      const isLink = JSON.stringify(json).includes('Photosynthesis');
      const cards = isLink ? [{ front: 'Where does photosynthesis happen?', back: 'In the chloroplasts' }] : [{ front: 'What does SN2 stand for?', back: 'Bimolecular nucleophilic substitution' }, { front: 'Rate law of SN1?', back: 'rate = k[substrate]' }];
      let content = JSON.stringify({ cards });
      if (!isLink) content = content.replace('rate = k[substrate]', String.raw`$r = k[\ce{RX}]$, $\frac{1}{2}\times\theta$`);
      return send(res, { id: 'c', object: 'chat.completion', created: 0, model: json.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
    }
    res.writeHead(404).end('{}');
  });
});
const send = (res, o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));

export default async ({ win, shot }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const vis = (sel) => win.locator(`${sel}:visible`);
  try {
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await win.waitForTimeout(1500);
    const skip = win.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await invoke('secret_set', { name: 'custom', value: 'k' });
    await win.evaluate((p) => window.__goodink.updateSettings({ ai: { provider: 'custom', models: { custom: 'mock-vision' }, efforts: {}, baseURLs: { custom: `http://127.0.0.1:${p}/oai/v1` }, keys: ['custom'] } }), port);

    // an old-style deck notebook (2.4/2.5) that Study should carry over, and a normal notebook
    await win.evaluate(() => window.__goodink.createNotebook({ title: 'Old deck', folderId: null, cover: { style: 'solid', color: '#2f5b8a' }, template: { kind: 'flashcard', paper: 'white' }, size: 'a5', landscape: true, kind: 'flashcards', open: false }));
    console.log('new menu has deck option:', await win.getByRole('button', { name: 'New', exact: true }).click().then(() => win.getByRole('menuitem', { name: /Flashcard deck/ }).count()));
    await win.getByRole('menuitem', { name: /^Notebook/ }).click();
    await win.locator('.modal input').first().fill('Chem notes');
    console.log('type switch in new-notebook dialog:', await win.locator('.modal').getByRole('radio', { name: 'Flashcards' }).count());
    await win.getByRole('button', { name: 'Create', exact: true }).click();
    await win.waitForTimeout(1500);
    await vis('.page-indicator').waitFor();
    await win.getByRole('button', { name: 'Add page' }).first().click();

    // model choice persists: change it in the Ask panel, close, reopen
    await vis('.tb-ask').click();
    await win.locator('.ask-model').click();
    await win.locator('.ask-panel input[list]').fill('mock-vision-2');
    await win.locator('.ask-panel').getByRole('button', { name: 'Close' }).click();
    await vis('.tb-ask').click();
    console.log('ask panel model after reopening:', await win.locator('.ask-model').innerText());
    await win.locator('.ask-panel').getByRole('button', { name: 'Close' }).click();
    await win.waitForTimeout(1200);
    const settingsOnDisk = JSON.parse(await invoke('doc_read', { name: 'settings.json' }));
    console.log('model saved in settings.json:', settingsOnDisk.ai.models.custom);
    await win.evaluate(() => {
      const g = window.__goodink;
      g.updateSettings({ ai: { ...g.useApp.getState().settings.ai, models: { custom: 'mock-vision' } } });
    });

    // Study from the library
    await win.getByRole('tab', { name: 'Files' }).click();
    await win.locator('.lib-tab', { hasText: 'Study' }).click();
    await win.locator('.st-tab', { hasText: 'Decks' }).click();
    await win.locator('.st-decks').waitFor();
    await win.waitForTimeout(500);
    console.log('decks:', JSON.stringify(await win.locator('.st-decks tbody tr').allInnerTexts()));
    await shot('study-01-decks');

    // Resources → make cards from the notebook into a new deck
    await win.locator('.st-tab', { hasText: 'Folders' }).click();
    console.log('items listed:', JSON.stringify(await win.locator('.st-res-title').allInnerTexts()));
    await win.locator('.st-res-list li', { hasText: 'Chem notes' }).getByRole('button', { name: 'Make flashcards' }).click();
    await win.waitForTimeout(500);
    await shot('study-02-make');
    await win.locator('.modal').getByRole('button', { name: 'Make flashcards' }).click();
    await win.locator('.ai-card').first().waitFor({ timeout: 30000 });
    console.log('typeset formulas in card preview:', await win.locator('.ai-card-preview .katex').count(), '| back text:', await win.locator('.ai-card textarea').nth(3).inputValue());
    await win.getByRole('button', { name: /Add 2 cards/ }).click();
    await win.waitForTimeout(400);

    // a link resource → cards into the same deck
    await win.getByRole('button', { name: 'Add link or video' }).click();
    await win.locator('.modal input').fill(`http://127.0.0.1:${port}/article`);
    await win.locator('.modal').getByRole('button', { name: /Add to/ }).click();
    await win.locator('.st-res-title', { hasText: 'Photosynthesis basics' }).waitFor({ timeout: 15000 });
    await win.locator('.st-res-list li', { hasText: 'Photosynthesis basics' }).getByRole('button', { name: 'Make flashcards' }).click();
    await win.locator('.modal').getByLabel('Add to deck').selectOption({ label: 'Chem notes' });
    await win.locator('.modal').getByRole('button', { name: 'Make flashcards' }).click();
    await win.locator('.ai-card').first().waitFor({ timeout: 30000 });
    await win.getByRole('button', { name: /Add 1 card/ }).click();
    const linkReq = seen.filter((s) => s.path.includes('chat/completions')).pop();
    const linkText = JSON.stringify(linkReq.json);
    console.log('link request has article text:', linkText.includes('chloroplasts'), '| page furniture removed:', !linkText.includes('cookies'), '| images:', (linkText.match(/image_url/g) ?? []).length);
    await shot('study-03-resources');

    // decks → overview → review with undo
    await win.locator('.st-tab', { hasText: 'Decks' }).click();
    console.log('decks after making cards:', JSON.stringify(await win.locator('.st-decks tbody tr').allInnerTexts()));
    await win.locator('.st-deck-name', { hasText: 'Chem notes' }).click();
    await win.getByRole('button', { name: 'Study now' }).click();
    await win.locator('.st-face').waitFor();
    await shot('study-04-question');
    await win.keyboard.press('Space');
    await win.waitForTimeout(200);
    console.log('buttons:', JSON.stringify(await win.locator('.study-ivl').allInnerTexts()));
    await shot('study-05-answer');
    const before = await win.locator('.st-rv-counts').innerText();
    await win.keyboard.press('3');
    await win.waitForTimeout(300);
    const after = await win.locator('.st-rv-counts').innerText();
    await win.keyboard.press('Control+z');
    await win.waitForTimeout(300);
    console.log('counts before/after Good/after undo:', [before, after, await win.locator('.st-rv-counts').innerText()].map((s) => s.replace(/\n/g, ' ')).join(' | '));
    await win.keyboard.press('Space');
    await win.keyboard.press('3');
    await win.waitForTimeout(300);
    await win.keyboard.press('Space');
    await win.waitForTimeout(300);
    console.log('review card:', (await win.locator('.st-face .card').innerText()).slice(0, 40), '| typeset formulas on the card:', await win.locator('.st-face .katex').count());
    await shot('study-09-math-card');

    // old handwritten deck works in review
    await win.locator('.st-back').first().click();
    await win.locator('.st-tab', { hasText: 'Decks' }).click();
    await win.locator('.st-deck-name', { hasText: 'Old deck' }).click();
    await win.getByRole('button', { name: 'Study now' }).click();
    await win.locator('.st-page-card img').waitFor({ timeout: 15000 });
    console.log('old deck shows its page: true');
    await win.locator('.st-back').first().click();

    // Add: a cloze note makes one card per deletion
    await win.locator('.st-tab', { hasText: 'Add' }).click();
    await win.locator('.add-chooser').first().click();
    await win.locator('.modal input').fill('Cloze');
    await win.keyboard.press('Enter');
    await win.locator('.ne-rich').first().click();
    await win.keyboard.type('Paris');
    await win.keyboard.press('Shift+Home');
    await win.keyboard.press('Control+Shift+C');
    await win.keyboard.press('End');
    await win.keyboard.type(' is the capital of France');
    for (let i = 0; i < 6; i++) await win.keyboard.press('Shift+ArrowLeft');
    await win.keyboard.press('Control+Shift+C');
    console.log('cloze field:', await win.locator('.ne-rich').first().innerText());
    await win.keyboard.press('Control+Enter');
    await win.waitForTimeout(300);
    await shot('study-06-add');

    // Browse
    await win.locator('.st-tab', { hasText: 'Browse' }).click();
    await win.locator('.st-search input').fill('Paris');
    console.log('browse "Paris" rows:', await win.locator('.st-table tbody tr').count());
    await win.locator('.st-search input').fill('is:new');
    await win.locator('.st-table tbody tr').first().click();
    console.log('browse is:new rows:', await win.locator('.st-table tbody tr').count(), '| editor open:', await win.locator('.st-editor').isVisible());
    await shot('study-07-browse');

    // Stats
    await win.locator('.st-tab', { hasText: 'Stats' }).click();
    console.log('stats tiles:', JSON.stringify((await win.locator('.st-tile').allInnerTexts()).slice(0, 9).map((t) => t.replace(/\n/g, ' '))));
    await shot('study-08-stats');

    // saved to disk
    await win.waitForTimeout(1000);
    const data = JSON.parse(await invoke('doc_read', { name: 'study.json' }));
    console.log('study.json:', JSON.stringify({ decks: data.decks.map((d) => d.name), cards: data.cards.length, links: await win.evaluate(() => window.__goodink.useApp.getState().library.links.map((x) => x.kind)), revlog: data.revlog.length, imported: data.imported.length }));
  } finally {
    await invoke('secret_delete', { name: 'custom' }).catch(() => {});
    server.close();
  }
};
