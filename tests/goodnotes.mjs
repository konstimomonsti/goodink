// Goodnotes import: node tests/drive-tauri.mjs tests/goodnotes.mjs src-tauri/target/debug/goodink.exe
// Without a file it checks the menu entry and that a file goodink cannot read gives an error toast
// (no crash). GOODNOTES=<path to a .goodnotes file> also imports it, checks the notebook and shoots
// its first page (Goodnotes files are personal: none ship with the repo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async ({ win, shot }) => {
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  // the New menu offers it
  await win.getByRole('button', { name: 'New', exact: true }).first().click();
  await win.waitForTimeout(300);
  ok('New → Import from Goodnotes… is in the menu', await win.getByText('Import from Goodnotes…').isVisible());
  await shot('goodnotes-0-menu');
  await win.keyboard.press('Escape');

  // a file that is not a Goodnotes notebook: an error toast, and the library is unchanged
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-')), 'Broken.goodnotes');
  fs.writeFileSync(bad, 'not a zip');
  const before = await win.evaluate(() => window.__goodink.useApp.getState().library.notebooks.length);
  const r0 = await win.evaluate((f) => window.__goodink.importGoodnotes(f, null), bad);
  await win.waitForTimeout(300);
  const toast = await win.locator('.toast-error').innerText().catch(() => '');
  const after = await win.evaluate(() => window.__goodink.useApp.getState().library.notebooks.length);
  ok('a broken file gives an error toast and adds nothing', r0 === null && /not a Goodnotes file/i.test(toast) && before === after, toast);
  await shot('goodnotes-1-error');

  const file = process.env.GOODNOTES;
  if (!file) return console.log('(set GOODNOTES=<file.goodnotes> to import a real notebook)');
  const t0 = Date.now();
  const r = await win.evaluate((f) => window.__goodink.importGoodnotes(f, null), file);
  ok('the notebook is imported', !!r?.id, r ? `${r.pages} pages in ${Date.now() - t0} ms, warnings ${JSON.stringify(r.warnings)}` : 'see the toast');
  if (!r?.id) return;
  const m = await win.evaluate((id) => window.__goodink.useApp.getState().library.notebooks.find((n) => n.id === id), r.id);
  ok('it is in the library with every page', m?.pageCount === r.pages, `${m?.title}: ${m?.pageCount} pages`);
  await win.evaluate((id) => window.__goodink.openNotebook(id), r.id);
  await win.waitForTimeout(4000);
  await shot('goodnotes-2-page');
};
