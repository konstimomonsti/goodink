// YouTube → flashcards with the real free Gemini setup (uses the saved Google key, a few requests):
// node tests/drive-tauri.mjs tests/yt-real.mjs
export default async ({ win }) => {
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  // log every AI request with its result and duration
  await win.evaluate(() => {
    const orig = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args, opts) => {
      if (cmd !== 'ai_fetch') return orig(cmd, args, opts);
      const t = performance.now();
      try {
        const r = await orig(cmd, args, opts);
        console.log(`AI ${args.req.method} ${args.req.url.slice(0, 90)} → ${r.status} in ${Math.round(performance.now() - t)} ms ${r.status >= 400 ? r.body.slice(0, 160) : `(${r.body.length} bytes)`}`);
        return r;
      } catch (e) {
        console.log(`AI ${args.req.url.slice(0, 90)} → threw after ${Math.round(performance.now() - t)} ms: ${e}`);
        throw e;
      }
    };
  });
  const keys = await invoke('secret_has', { names: ['google'] });
  console.log('google key saved:', keys.includes('google'));
  await win.evaluate((k) => window.__goodink.updateSettings({ ai: { provider: 'google', models: {}, efforts: {}, baseURLs: {}, keys: k } }), keys);
  await win.locator('.lib-tab', { hasText: 'Study' }).click();
  await win.locator('.st-tab', { hasText: 'Folders' }).click();
  for (const link of ['https://www.youtube.com/watch?v=aircAruvnKk']) {
    await win.getByRole('button', { name: 'Add link or video' }).click();
    await win.locator('.modal input').fill(link);
    await win.locator('.modal').getByRole('button', { name: /Add to/ }).click();
    await win.waitForTimeout(4000);
    console.log('toasts after adding:', JSON.stringify(await win.locator('.toast').allInnerTexts()));
    const row = win.locator('.st-res-list li').first();
    console.log('row:', (await row.innerText()).replace(/\n/g, ' | '));
    await row.getByRole('button', { name: 'Make flashcards' }).click();
    await win.waitForTimeout(500);
    console.log('model shown:', await win.locator('.modal input[list]').inputValue().catch(() => '?'), '| effort:', await win.locator('.modal').getByLabel('Effort').inputValue().catch(() => '?'));
    await win.locator('.modal').getByRole('button', { name: 'Make flashcards' }).click();
    const t0 = Date.now();
    await Promise.race([win.locator('.ai-card').first().waitFor({ timeout: 300000 }), win.locator('.toast-error').first().waitFor({ timeout: 300000 })]).catch(() => {});
    console.log('after', Math.round((Date.now() - t0) / 1000), 's: cards', await win.locator('.ai-card').count(), '| errors', JSON.stringify(await win.locator('.toast-error').allInnerTexts()), '| working text:', await win.locator('.modal .empty p').innerText().catch(() => '-'));
    if (await win.locator('.ai-card').count()) console.log('first card:', JSON.stringify(await win.locator('.ai-card textarea').first().inputValue()));
    await win.keyboard.press('Escape');
  }
};
