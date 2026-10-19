// Find in a PDF: typing jumps to the first match by itself and highlights it; a phrase matches only
// where its words follow each other; Enter steps through every match, also several on one page.
//   node tests/drive-tauri.mjs tests/live/search-pdf.mjs src-tauri/target/debug/goodink.exe
import path from 'node:path';
export default async ({ win, shot }) => {
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(1000);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate((p) => window.__goodink.importPdfFile(p), path.resolve('tests/fixtures/sample.pdf'));
  await win.waitForTimeout(3000); // the PDF's text gets indexed
  const page = () => win.evaluate(() => window.__editor.vp.pageIndexNow);
  await win.keyboard.press('Control+f');
  const box = win.getByPlaceholder('Find in this notebook');
  await box.waitFor({ timeout: 3000 });
  await box.fill('Calvin cycle');
  await win.waitForTimeout(1200);
  ok('typing jumps to the page by itself', (await page()) === 1, `page ${(await page()) + 1}`);
  const marks = await win.locator('.gi-mark').count(), cur = await win.locator('.gi-mark.is-current').count();
  ok('the phrase is highlighted, and only it', marks === 2 && cur === 2, `${marks} marked, ${cur} current`);
  ok('the counter shows it', /1 of 1/.test(await win.locator('.hit-count').innerText().catch(() => '')));
  await shot('search-01-phrase');
  // a common word: several matches, some on the same page
  await box.fill('the');
  await win.waitForTimeout(900);
  const count = await win.locator('.hit-count').innerText().catch(() => '');
  const total = Number(/of (\d+)/.exec(count)?.[1] ?? 0);
  await box.press('Enter');
  await win.waitForTimeout(500);
  ok('Enter steps to the next match', (await win.locator('.hit-count').innerText()).startsWith('2 of'), `${count}, then ${await win.locator('.hit-count').innerText()}`);
  ok('several matches on one page are all marked, one current', (await win.locator('.gi-mark').count()) > 1 && (await win.locator('.gi-mark.is-current').count()) >= 1 && total > 3);
  await shot('search-02-steps');
};
