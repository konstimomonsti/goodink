// Latency regression: fast handwriting must not hit main-thread stalls between strokes.
export default async ({ win, shot }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Speed', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'ruled-college', paper: 'white' }, size: 'a4', landscape: false }));
  await win.waitForTimeout(1500);
  await win.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
  });
  const box = await win.locator('.gi-page').first().boundingBox();
  for (let k = 0; k < 30; k++) {
    const x0 = box.x + 80 + (k % 10) * 70, y0 = box.y + 140 + Math.floor(k / 10) * 60;
    await win.mouse.move(x0, y0);
    await win.mouse.down();
    for (let i = 1; i <= 16; i++) await win.mouse.move(x0 + i * 3, y0 + Math.sin(i / 2) * 14);
    await win.mouse.up();
    await win.waitForTimeout(140); // pause between letters like real writing
  }
  const during = await win.evaluate(() => window.__long.slice());
  await win.waitForTimeout(4500); // now idle: saving, thumbnails and OCR should run here
  const after = await win.evaluate(() => window.__long.slice());
  console.log('long tasks while writing:', JSON.stringify(during));
  console.log('long tasks incl. idle period after:', JSON.stringify(after.slice(during.length)));
  await shot('50-speed');
};
