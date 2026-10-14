export default async ({ win, shot }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() => window.__goodink.openDialog({ type: 'new-notebook', folderId: null }));
  await win.waitForTimeout(300);
  await win.getByRole('radio', { name: 'Infinite canvas' }).click();
  await win.getByPlaceholder('Untitled notebook').fill('Mind map');
  await win.waitForTimeout(200);
  await shot('81-new-infinite');
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.waitForTimeout(1500);
  const box = await win.locator('.gi-scroller').boundingBox();
  for (let k = 0; k < 5; k++) {
    const x0 = box.x + 200 + k * 160, y0 = box.y + 200 + (k % 2) * 120;
    await win.mouse.move(x0, y0); await win.mouse.down();
    for (let i = 0; i < 30; i++) await win.mouse.move(x0 + Math.cos(i / 4.7) * 50, y0 + Math.sin(i / 4.7) * 50);
    await win.mouse.up();
  }
  await win.waitForTimeout(500);
  await shot('82-infinite-writing');
  const before = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return [s.pages[0].w, s.pages[0].h, g.useApp.getState().pageOf]; });
  // write near the right/bottom edge: scroll there and draw
  await win.evaluate(() => { const sc = document.querySelector('.gi-scroller'); sc.scrollLeft = sc.scrollWidth; sc.scrollTop = sc.scrollHeight; });
  await win.waitForTimeout(400);
  const pg = await win.locator('.gi-page').first().boundingBox();
  const ex = Math.min(pg.x + pg.width - 120, box.x + box.width - 80), ey = Math.min(pg.y + pg.height - 120, box.y + box.height - 80);
  await win.mouse.move(ex - 200, ey - 100); await win.mouse.down(); await win.mouse.move(ex, ey, { steps: 20 }); await win.mouse.up();
  await win.waitForTimeout(800);
  const after = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return [s.pages[0].w, s.pages[0].h]; });
  console.log('infinite page size before', JSON.stringify(before.slice(0, 2)), 'after writing at edge', JSON.stringify(after), 'zoom', await win.locator('.zoom-val').innerText());
  await shot('83-infinite-grown');
};
