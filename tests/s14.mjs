// Tauri: first-run storage prompt + in-place notebooks-folder switch.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export default async ({ win, shot }) => {
  await win.waitForSelector('.storage', { timeout: 15000 });
  console.log('prompt visible:', await win.locator('.storage').isVisible());
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Keep me', folderId: null, cover: { style: 'solid', color: '#2b59d9' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: false }));
  await win.waitForTimeout(500);
  const pick = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-pick-'));
  await win.evaluate((d) => window.__goodink.changeLibraryFolder(d), pick).catch(() => {});
  await win.waitForTimeout(3000);
  await win.waitForFunction(() => !!window.__goodink, null, { timeout: 10000 });
  const st = await win.evaluate(() => ({ prompt: !!document.querySelector('.storage'), cards: document.querySelectorAll('.nb-card').length }));
  const lp = await win.evaluate(() => window.gink.libraryPath());
  console.log('after switch', JSON.stringify(st), 'library at', lp, 'copied:', fs.existsSync(path.join(lp, 'library.json')));
};
