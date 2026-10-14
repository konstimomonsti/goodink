// AI flashcards + summary against a local fake provider: node tests/drive-tauri.mjs tests/ai.mjs
// One server speaks both the Anthropic Messages API (streaming) and the OpenAI-compatible API, so the
// whole path runs for real: key in Credential Manager -> backend inserts it -> SDK -> page images.
import http from 'node:http';

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    seen.push({ path: req.url, headers: req.headers, json });
    if (req.url.startsWith('/oai/v1/models')) return send(res, { object: 'list', data: [{ id: 'mock-vision', object: 'model', created: 0, owned_by: 'test' }, { id: 'text-embedding-x', object: 'model', created: 0, owned_by: 'test' }] });
    if (req.url.startsWith('/oai/v1/chat/completions') && /questions about their notebook/.test(json.messages[0].content)) {
      const turns = json.messages.length - 1;
      return send(res, { id: 'c2', object: 'chat.completion', created: 0, model: json.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: turns === 1 ? 'SN2 happens in **one step** with backside attack (p. 1). Rate: $r = k[\\ce{RX}][\\ce{Nu^-}]$\n$$\\frac{d[P]}{dt} = k[A][B]$$' : `Follow-up answer, I saw ${turns} turns (p. 2).` } }] });
    }
    if (req.url.startsWith('/oai/v1/chat/completions')) {
      const cards = { cards: [{ front: 'What does SN2 stand for?', back: 'Bimolecular nucleophilic substitution' }, { front: 'Rate law of SN1?', back: 'rate = k[substrate]' }] };
      return send(res, { id: 'c1', object: 'chat.completion', created: 0, model: json.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Here you go:\n' + JSON.stringify(cards) } }] });
    }
    if (req.url.startsWith('/v1/models')) return send(res, { data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' });
    if (req.url.startsWith('/v1/messages')) {
      const text = '# Summary\n- **SN2**: one step, backside attack\n- **SN1**: carbocation first';
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(
        ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
          ev('content_block_stop', { index: 0 }) +
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }) +
          ev('message_stop', {}),
      );
    }
    res.writeHead(404).end('{}');
  });
});
const send = (res, obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));

export default async ({ win, shot }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  try {
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await win.waitForTimeout(1500);
    const skip = win.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible().catch(() => false)) await skip.click();

    // a notebook with two pages
    await win.getByRole('button', { name: 'New', exact: true }).click();
    await win.getByRole('menuitem', { name: /^Notebook/ }).click();
    await win.locator('.modal input').first().waitFor();
    await win.locator('.modal input').first().fill('Chem notes');
    await win.getByRole('button', { name: 'Create', exact: true }).click();
    await win.waitForTimeout(1500);
    await win.getByRole('button', { name: 'Add page' }).first().click();
    await win.waitForTimeout(300);

    // Settings → AI: save a key for the custom provider through the UI
    await win.keyboard.press('Control+,');
    await win.waitForTimeout(800);
    const ai = win.locator('.settings section', { has: win.getByRole('heading', { name: 'AI', exact: true }) });
    await ai.scrollIntoViewIfNeeded();
    await ai.getByRole('button', { name: /Customize/ }).click();
    await ai.locator('select').first().selectOption('custom');
    await ai.getByPlaceholder('https://…/v1').fill(`http://127.0.0.1:${port}/oai/v1`);
    await ai.getByPlaceholder('Paste your API key').fill('test-key-custom');
    await ai.getByRole('button', { name: 'Save' }).click();
    await win.waitForTimeout(1500);
    await shot('ai-01-settings');
    console.log('keys after save:', JSON.stringify(await invoke('secret_has', { names: ['custom', 'anthropic'] })));
    await win.keyboard.press('Escape');

    // anthropic pointed at the fake server, key saved directly
    await invoke('secret_set', { name: 'anthropic', value: 'test-key-anthropic' });
    await win.evaluate((p) => {
      const g = window.__goodink;
      const ai = g.useApp.getState().settings.ai;
      g.updateSettings({ ai: { ...ai, provider: 'custom', models: { ...ai.models, custom: 'mock-vision', anthropic: 'claude-opus-5-5' }, efforts: { ...ai.efforts, custom: 'high', anthropic: 'high' }, baseURLs: { ...ai.baseURLs, anthropic: `http://127.0.0.1:${p}` }, keys: ['custom', 'anthropic'] } });
    }, port);

    // summary with the Anthropic path, back in the notes
    const pagesBefore = await win.locator('.page-indicator:visible span').first().innerText();
    await win.locator('.toolbar').getByRole('button', { name: 'More', exact: true }).click();
    await win.getByRole('menuitem', { name: 'Summarize with AI…' }).click();
    await win.waitForTimeout(800);
    await win.locator('.modal select').first().selectOption('anthropic');
    await win.waitForTimeout(500);
    await win.locator('.modal').getByRole('button', { name: 'Summarize' }).click();
    await win.locator('.ai-summary').waitFor({ timeout: 30000 });
    await shot('ai-05-summary');
    await win.getByRole('button', { name: 'Add to notebook as pages' }).click();
    await win.waitForTimeout(1200);
    console.log('pages before/after summary:', pagesBefore, '→', await win.locator('.page-indicator:visible span').first().innerText());
    await shot('ai-06-summary-page');

    // Ask AI panel: question, follow-up, and a page link
    await win.evaluate(() => {
      const g = window.__goodink;
      g.updateSettings({ ai: { ...g.useApp.getState().settings.ai, provider: 'custom' } });
    });
    await win.locator('.tb-ask:visible').click();
    await win.locator('.ask-panel textarea').waitFor();
    await win.locator('.ask-panel textarea').fill('What is SN2?');
    await win.keyboard.press('Enter');
    await win.locator('.ask-msg.is-ai:not(.ask-busy)').first().waitFor({ timeout: 30000 });
    await win.locator('.ask-panel textarea').fill('And SN1?');
    await win.keyboard.press('Enter');
    await win.locator('.ask-msg.is-ai:not(.ask-busy)').nth(1).waitFor({ timeout: 30000 });
    console.log('typeset formulas in chat:', await win.locator('.ask-msg .katex').count(), '| display:', await win.locator('.ask-msg .katex-display').count());
    console.log('ask answers:', JSON.stringify(await win.locator('.ask-msg.is-ai').allInnerTexts()));
    await shot('ai-07-ask');
    await win.locator('.page-ref', { hasText: 'p. 1' }).first().click();
    await win.waitForTimeout(800);
    console.log('after page link:', await win.locator('.page-indicator:visible span').first().innerText());
    const askReqs = seen.filter((s) => s.path.includes('chat/completions') && /questions about their notebook/.test(s.json.messages[0].content));
    console.log('ask requests:', askReqs.length, '| images in follow-up:', askReqs[1].json.messages[1].content.filter((p) => p.type === 'image_url').length, '| messages in follow-up:', askReqs[1].json.messages.length);

    const chat = seen.find((s) => s.path.includes('chat/completions') && s.json.messages[1].content.some?.((p) => p.type === 'image_url'));
    const msgs = seen.find((s) => s.path.startsWith('/v1/messages'));
    const imgs = chat.json.messages[1].content.filter((p) => p.type === 'image_url');
    console.log('openai auth header ok:', chat.headers.authorization === 'Bearer test-key-custom', '| images:', imgs.length, imgs[0]?.image_url.url.slice(0, 23), '| effort:', chat.json.reasoning_effort);
    console.log('anthropic key ok:', msgs.headers['x-api-key'] === 'test-key-anthropic', '| beta:', msgs.headers['anthropic-beta'], '| thinking:', JSON.stringify(msgs.json.thinking), '| output_config:', JSON.stringify(msgs.json.output_config), '| fallbacks:', msgs.json.fallbacks, '| images:', msgs.json.messages[0].content.filter((b) => b.type === 'image').length, '| stream:', msgs.json.stream);
    console.log('placeholder never left the app:', !JSON.stringify(seen.map((s) => s.headers)).includes('__GOODINK_SECRET__'));
  } finally {
    await invoke('secret_delete', { name: 'custom' }).catch(() => {});
    await invoke('secret_delete', { name: 'anthropic' }).catch(() => {});
    console.log('test keys removed:', JSON.stringify(await invoke('secret_has', { names: ['custom', 'anthropic'] }).catch(() => 'n/a')));
    server.close();
  }
};
