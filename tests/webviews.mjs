// Extra webviews start (WebView2 needs the same switches everywhere): node tests/drive-tauri.mjs tests/webviews.mjs
export default async ({ win, browser }) => {
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const call = (cmd, args) => win.evaluate(async ([c, a]) => {
    try {
      await window.__TAURI_INTERNALS__.invoke(c, a);
      return 'ok';
    } catch (e) {
      return `error: ${e}`;
    }
  }, [cmd, args]);
  console.log('preview:', await call('web_preview_create', { label: 'preview-probe', url: 'https://example.com/', x: 100, y: 100, width: 400, height: 300 }));
  console.log('window:', await call('web_window_open', { label: 'web-probe', url: 'https://example.org/', title: 'probe' }));
  // presentation window from a notebook (F5)
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'P', folderId: null, cover: { style: 'solid', color: '#2f5b8a' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: true }));
  await win.locator('.page-indicator:visible').waitFor({ timeout: 15000 });
  await win.keyboard.press('F5');
  await win.waitForTimeout(4000);
  console.log('targets:', browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(' | '));
};
