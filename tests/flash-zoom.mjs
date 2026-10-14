// The reported case: PDF placed on an infinite canvas, then zooming in and out (like pinch / Ctrl+wheel).
// Counts frames in which a visible placed PDF is an empty box (blank) or not yet sharp (blurry).
import path from 'node:path';
export default async ({ win }) => {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Canvas', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'dotted', paper: 'white' }, size: 'a4', landscape: false, infinite: true }));
  await win.waitForTimeout(1500);
  await win.evaluate((p) => window.__editor.insertPdf(p), path.resolve('tests/fixtures/big.pdf'));
  await win.waitForTimeout(2500);
  const r = await win.evaluate(async () => {
    const vp = window.__editor.vp;
    const t = { frames: 0, blank: 0, blurry: 0 };
    let run = true;
    const tick = () => {
      if (!run) return;
      const s = vp.debugFrameStats();
      t.frames++;
      if (s.blank) t.blank++;
      else if (s.blurry) t.blurry++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 30; i++) { vp.setZoom(vp.zoom * 1.06); await frame(); if (round === 0 && i === 29) window.__shotNow = true; } // pinch out
      await new Promise((res) => setTimeout(res, 400));
      for (let i = 0; i < 40; i++) { vp.setZoom(vp.zoom / 1.06); await frame(); } // pinch in
      await new Promise((res) => setTimeout(res, 400));
    }
    run = false;
    return t;
  });
  console.log(`ZOOM frames ${r.frames}: blank (empty PDF box) ${((r.blank / r.frames) * 100).toFixed(1)}% · not yet sharp ${((r.blurry / r.frames) * 100).toFixed(1)}%`);
};
