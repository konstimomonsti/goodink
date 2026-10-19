// Copy text from a PDF: the "Select text" tool (X) selects the words dragged across, in reading
// order with line breaks, shows Copy, and Ctrl+C copies.
//   node tests/drive-tauri.mjs tests/live/pdf-copy.mjs src-tauri/target/debug/goodink.exe
import path from 'node:path';
export default async ({ win, shot }) => {
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(1000);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate((p) => window.__goodink.importPdfFile(p), path.resolve('tests/fixtures/sample.pdf'));
  await win.waitForTimeout(3000);
  await win.keyboard.press('x');
  const box = await win.locator('.gi-page').first().boundingBox();
  const k = box.width / 595.28;
  // first body line: "The mitochondrion produces ATP through oxidative phosphorylation." at pdf y 700
  const y1 = box.y + (841.89 - 700 - 4) * k;
  const drag = async (pts) => {
    await win.mouse.move(pts[0][0], pts[0][1]);
    await win.mouse.down();
    for (const [x, y] of pts.slice(1)) await win.mouse.move(x, y, { steps: 6 });
    await win.mouse.up();
  };
  await drag([[box.x + 62 * k, y1], [box.x + 330 * k, y1]]);
  await win.waitForTimeout(300);
  const text = await win.evaluate(() => window.__editor.vp.selectedText);
  ok('dragging selects the words passed over', /^The mitochondrion produces ATP/.test(text) && !text.includes('Ribosomes'), JSON.stringify(text));
  ok('Copy appears next to it', (await win.locator('.sel-menu[aria-label="Selected text"]').count()) === 1);
  ok('the words are marked in blue', (await win.locator('.gi-textsel').count()) >= 4);
  await shot('pdf-copy-01');
  // two lines: a line break between them
  const y2 = box.y + (841.89 - 672 - 4) * k;
  await drag([[box.x + 62 * k, y1], [box.x + 200 * k, y2]]);
  await win.waitForTimeout(300);
  const two = await win.evaluate(() => window.__editor.vp.selectedText);
  ok('across two lines, a line break between them', /phosphorylation\.\nRibosomes/.test(two), JSON.stringify(two));
  // Ctrl+C copies (the toast confirms it)
  await win.keyboard.press('Control+c');
  await win.waitForTimeout(400);
  ok('Ctrl+C copies', /Copied/.test(await win.locator('.toast, [role="status"]').allInnerTexts().then((t) => t.join(' ')).catch(() => '')));
  await shot('pdf-copy-02');
};
