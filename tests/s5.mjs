// Regression for the writing bug: loops must not self-fill, and deep zoom must not black out.
const drawPath = async (win, pts) => {
  await win.mouse.move(pts[0][0], pts[0][1]);
  await win.mouse.down();
  for (const [x, y] of pts.slice(1)) await win.mouse.move(x, y, { steps: 1 });
  await win.mouse.up();
};
// a "b": down-stroke, then a bowl that loops back over the stem
const letterB = (x, y, s) => [
  ...Array.from({ length: 20 }, (_, i) => [x, y + (i * 80 * s) / 20]),
  ...Array.from({ length: 40 }, (_, i) => { const a = Math.PI + (i / 40) * Math.PI * 2.1; return [x + 22 * s + Math.cos(a) * 22 * s, y + 58 * s + Math.sin(a) * 22 * s]; }),
];
const spiral = (cx, cy) => Array.from({ length: 120 }, (_, i) => { const a = i / 8; const r = 4 + i * 0.5; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
const letterE = (x, y) => [[x, y], [x + 30, y], ...Array.from({ length: 50 }, (_, i) => { const a = -0.1 - (i / 50) * Math.PI * 1.7; return [x + 15 + Math.cos(a) * 16, y + Math.sin(a) * 16]; })];

export default async ({ win, shot }) => {
  await win.waitForTimeout(1000);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Loops', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'dotted', paper: 'white' }, size: 'a4', landscape: false }));
  await win.waitForTimeout(1500);
  const box = await win.locator('.gi-page').first().boundingBox();
  const X = box.x, Y = box.y;
  for (const [i, pen] of ['fountain', 'ball', 'brush'].entries()) {
    await win.evaluate((p) => window.__goodink.setTools({ penKind: p, penWidth: 3 }), pen);
    const ox = X + 80 + i * 220;
    await drawPath(win, letterB(ox, Y + 120, 1));
    await drawPath(win, letterE(ox + 70, Y + 180));
    await drawPath(win, spiral(ox + 70, Y + 330));
  }
  await win.waitForTimeout(500);
  await shot('40-loops');
  // deep zoom on the first letters
  const vp = win.locator('.gi-scroller');
  await win.mouse.move(X + 120, Y + 200);
  for (let k = 0; k < 14; k++) await win.mouse.wheel(0, -120).then(() => win.keyboard.down('Control')).catch(() => {});
  await win.keyboard.up('Control');
  await win.evaluate(() => { const g = window.__goodink; });
  await win.keyboard.press('Control+=');
  for (let k = 0; k < 8; k++) await win.keyboard.press('Control+=');
  await win.waitForTimeout(800);
  await shot('41-deep-zoom');
  // write while deeply zoomed, then scroll around
  const b2 = await vp.boundingBox();
  await drawPath(win, letterB(b2.x + b2.width / 2 - 40, b2.y + 120, 3));
  await win.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  for (let k = 0; k < 6; k++) { await win.mouse.wheel(0, 400); await win.waitForTimeout(60); }
  await win.waitForTimeout(700);
  await shot('42-zoom-scrolled');
  const canv = await win.evaluate(() => [...document.querySelectorAll('.gi-page canvas')].map((c) => c.width * c.height).reduce((a, b) => a + b, 0));
  console.log('total canvas pixels at deep zoom', canv, 'zoom', await win.locator('.zoom-val').innerText());
};
