// Does WebView2's low-memory mode wipe visible page canvases?
import path from 'node:path';
export default async ({ win, shot }) => {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate((p) => window.__goodink.importPdfFile(p), path.resolve('tests/fixtures/sample.pdf'));
  await win.waitForSelector('.gi-page');
  await win.waitForTimeout(2500);
  const ink = () => win.evaluate(() => { const c = document.querySelector('.gi-page .gi-bg'); const x = document.createElement('canvas'); x.width = 60; x.height = 60; const g = x.getContext('2d'); g.drawImage(c, c.width * 0.15, c.height * 0.12, c.width * 0.3, c.height * 0.1, 0, 0, 60, 60); const d = g.getImageData(0, 0, 60, 60).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++; return dark; });
  console.log('dark pixels in page title area, normal mode:', await ink());
  await shot('110-normal');
  await win.evaluate(() => window.__TAURI_INTERNALS__.invoke('memory_mode', { low: true }));
  await win.waitForTimeout(3000);
  await shot('111-low');
  console.log('dark pixels after LOW memory mode:', await ink());
  await win.evaluate(() => window.__TAURI_INTERNALS__.invoke('memory_mode', { low: false }));
  await win.waitForTimeout(1500);
  await shot('112-back-normal');
  console.log('dark pixels after back to normal:', await ink());
};
