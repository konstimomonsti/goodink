// Flash test: scroll quickly through a 60-slide PDF and count screen frames in which a visible page
// is blank (no PDF yet) or blurry (stretched low-res image).
import path from 'node:path';
export default async ({ win }) => {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate((p) => window.__goodink.importPdfFile(p), path.resolve('tests/fixtures/big.pdf'));
  await win.waitForSelector('.gi-page');
  await win.waitForTimeout(1500);
  const r = await win.evaluate(async () => {
    const vp = window.__editor.vp;
    const sc = document.querySelector('.gi-scroller');
    const tally = { frames: 0, blankFrames: 0, blurryFrames: 0 };
    let run = true;
    const tick = () => {
      if (!run) return;
      const s = vp.debugFrameStats();
      tally.frames++;
      if (s.blank) tally.blankFrames++;
      else if (s.blurry) {
        tally.blurryFrames++;
        (window.__reasons ??= {}), s.reasons.forEach((r) => (window.__reasons[r.replace(/sc=[^ ]+ /, '')] = (window.__reasons[r.replace(/sc=[^ ]+ /, '')] ?? 0) + 1));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // a quick flick: ~one screen per 80 ms, like a fast wheel/touchpad scroll, then a pause, twice
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 25; i++) {
        sc.scrollTop += sc.clientHeight * 0.8;
        await new Promise((res) => setTimeout(res, 80));
      }
      await new Promise((res) => setTimeout(res, 600));
      sc.scrollTop = 0;
      await new Promise((res) => setTimeout(res, 600));
    }
    // reading speed: ~2 screens per second, the way you page through notes
    const fast = { ...tally };
    tally.frames = tally.blankFrames = tally.blurryFrames = 0;
    for (let i = 0; i < 40; i++) {
      sc.scrollTop += sc.clientHeight * 0.3;
      await new Promise((res) => setTimeout(res, 150));
    }
    run = false;
    return { fast, reading: { ...tally }, reasons: window.__reasons };
  });
  console.log('REASONS', JSON.stringify(r.reasons));
  const pct = (t, k) => ((t[k] / t.frames) * 100).toFixed(1);
  console.log(`FLASH fast flick: blank ${pct(r.fast, 'blankFrames')}% · blurry ${pct(r.fast, 'blurryFrames')}%   |   reading speed: blank ${pct(r.reading, 'blankFrames')}% · blurry ${pct(r.reading, 'blurryFrames')}%`);
};
