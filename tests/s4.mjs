import path from 'node:path';
import fs from 'node:fs';
const drawPath = async (win, pts) => {
  await win.mouse.move(pts[0][0], pts[0][1]);
  await win.mouse.down();
  for (const [x, y] of pts.slice(1)) await win.mouse.move(x, y, { steps: 2 });
  await win.mouse.up();
};
export default async ({ win, shot, lib }) => {
  await win.waitForTimeout(1000);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate((p) => window.__goodink.importPdfFile(p), path.resolve('tests/fixtures/sample.pdf'));
  await win.waitForTimeout(2000);
  const box = await win.locator('.gi-page').first().boundingBox();
  const X = box.x, Y = box.y, k = box.width / 595.28;
  await win.keyboard.press('h');
  await drawPath(win, [[X + 58 * k, Y + 136 * k], [X + 470 * k, Y + 137 * k]]);
  await win.keyboard.press('p');
  await drawPath(win, Array.from({ length: 30 }, (_, i) => [X + 80 * k + i * 12, Y + 400 * k + Math.sin(i / 2) * 10]));
  await win.keyboard.press('s');
  await drawPath(win, Array.from({ length: 42 }, (_, i) => [X + 300 * k + Math.cos(i / 40 * 6.283) * 60, Y + 560 * k + Math.sin(i / 40 * 6.283) * 60]));
  await win.keyboard.press('t');
  await win.mouse.click(X + 80 * k, Y + 540 * k);
  await win.keyboard.type('Exam: know the ATP yield');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(800);
  // export through the engine and write to disk
  const out = path.join(lib, 'exported.pdf');
  const b64 = await win.evaluate(async () => {
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    await s.flush();
    const bytes = await g.exportPdf(s, { pages: s.pages.map((_, i) => i), includeAnnotations: true, includeTemplates: true });
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('exported bytes', fs.statSync(out).size);
  await win.evaluate((p) => window.__goodink.importPdfFile(p), out);
  await win.waitForTimeout(2500);
  await shot('20-reimported-export');
  // OCR bridge probe with rendered text
  const words = await win.evaluate(async () => {
    const c = new OffscreenCanvas(900, 200);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 200);
    ctx.fillStyle = '#000'; ctx.font = '48px "Segoe Print"'; ctx.fillText('photosynthesis notes', 30, 110);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return window.gink.ocr(new Uint8Array(await blob.arrayBuffer()));
  });
  console.log('OCR words', JSON.stringify(words));
  // library: folders, favourite, trash
  await win.evaluate(() => window.__goodink.activateTab(null));
  await win.evaluate(() => { const g = window.__goodink; const id = g.createFolder('Semester 2', null); g.createFolder('Archive', null); g.toggleFavorite(g.useApp.getState().library.notebooks[0].id); g.moveItems([g.useApp.getState().library.notebooks[1].id], id); });
  await win.waitForTimeout(1500);
  await shot('21-library-light');
  await win.evaluate(() => window.__goodink.openDialog({ type: 'new-notebook', folderId: null }));
  await win.waitForTimeout(400);
  await shot('22-new-dialog-paper');
  await win.getByRole('radio', { name: 'Cover' }).click();
  await win.waitForTimeout(300);
  await shot('23-new-dialog-cover');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__goodink.openDialog({ type: 'settings' }));
  await win.waitForTimeout(400);
  await shot('24-settings');
};
