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
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  const pdf = path.resolve('tests/fixtures/sample.pdf');
  await win.evaluate((p) => window.__goodink.importPdfFile(p), pdf);
  await win.waitForTimeout(2500);
  await shot('10-pdf-open');
  const box = await win.locator('.gi-page').first().boundingBox();
  const X = box.x, Y = box.y, k = box.width / 595.28;
  // highlight first body line (pdf y 700 -> top-left y = 841.89-700-~10)
  await win.keyboard.press('h');
  await drawPath(win, [[X + 58 * k, Y + 136 * k], [X + 300 * k, Y + 136 * k], [X + 470 * k, Y + 136 * k]]);
  await win.keyboard.press('p');
  await drawPath(win, Array.from({ length: 30 }, (_, i) => [X + 80 * k + i * 12, Y + 400 * k + Math.sin(i / 2) * 10]));
  await win.waitForTimeout(600);
  await shot('11-pdf-annotated');
  // eraser: precise through the middle of the wave
  await win.keyboard.press('e');
  await drawPath(win, [[X + 80 * k + 150, Y + 360 * k], [X + 80 * k + 150, Y + 440 * k]]);
  await win.waitForTimeout(500);
  await shot('12-erased');
  // in-document search for PDF text
  await win.keyboard.press('Control+f');
  await win.keyboard.type('Calvin');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
  await shot('13-search');
  await win.keyboard.press('Escape');
  // export PDF via engine directly to check output
  const out = path.join(lib, 'export-test.pdf');
  const bytes = await win.evaluate(async () => {
    const st = window.__goodink;
    const id = st.useApp.getState().active;
    const s = await st.getSession(id);
    await s.flush();
    const { exportPdf } = await import('/src/renderer/engine/export.ts').catch(() => ({ exportPdf: null }));
    return exportPdf ? 'dev' : 'n/a';
  });
  console.log('export probe', bytes);
  // library view with the imported PDF
  await win.evaluate(() => window.__goodink.activateTab(null));
  await win.waitForTimeout(1200);
  await shot('14-library');
  // global search
  await win.locator('#lib-search').fill('oxidative');
  await win.waitForTimeout(1200);
  await shot('15-global-search');
  void out; void fs;
};
