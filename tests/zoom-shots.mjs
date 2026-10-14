// Screenshots during and after zooming on an infinite canvas with placed PDFs.
import path from 'node:path';
export default async ({ win, shot }) => {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Canvas', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'dotted', paper: 'white' }, size: 'a4', landscape: false, infinite: true }));
  await win.waitForTimeout(1500);
  await win.evaluate((p) => window.__editor.insertPdf(p), path.resolve('tests/fixtures/big.pdf'));
  await win.waitForTimeout(3000);
  await shot('120-placed');
  for (let k = 0; k < 4; k++) {
    await win.evaluate(async () => { const vp = window.__editor.vp; for (let i = 0; i < 8; i++) { vp.setZoom(vp.zoom * 1.08); await new Promise((r) => requestAnimationFrame(r)); } });
    await shot(`121-zoom-in-${k}`);
    await win.waitForTimeout(60);
    await shot(`122-zoom-in-${k}-settling`);
    await win.waitForTimeout(400);
    console.log('stats', JSON.stringify(await win.evaluate(() => window.__editor.vp.debugFrameStats())));
  }
  await shot('123-after');
};
