// Circle to ask: a pen loop around ink offers "Ask AI about this"; tapping it opens the AI card on
// that region; a written 0 (a loop around nothing) offers nothing; the offer fades by itself.
//   node tests/drive-tauri.mjs tests/live/circle-ask.mjs src-tauri/target/debug/goodink.exe
export default async ({ win, shot }) => {
  const { newNotebook, writeText, drawPath, loopAround } = await import('./handwriting.mjs');
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(1000);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: true, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Circle');
  await writeText(win, '3x=6', { x: 100, y: 160, size: 30, seed: 2 });
  const { bbox } = await writeText(win, 'x=2', { x: 100, y: 220, size: 30, seed: 3 });
  await win.waitForTimeout(400);

  // a written 0 next to it: a loop, but around nothing
  await writeText(win, '0', { x: 300, y: 220, size: 30, seed: 4 });
  await win.waitForTimeout(250);
  ok('a written 0 offers nothing', (await win.locator('.live-circle-ask').count()) === 0);

  // circle x=2 with the pen
  const t0 = Date.now();
  await drawPath(win, loopAround(bbox, 10, 5));
  await win.locator('.live-circle-ask').waitFor({ timeout: 2000 }).catch(() => {});
  const shown = await win.locator('.live-circle-ask').count();
  ok('circling ink offers "Ask AI about this"', shown === 1, `${Date.now() - t0} ms`);
  await shot('circle-01-offer');

  // tapping it opens the AI card on that region
  if (shown) await win.locator('.live-circle-ask').click();
  await win.waitForTimeout(600);
  const card = await win.locator('.live-card').count();
  ok('tapping it opens the AI card', card >= 1, await win.locator('.live-card').first().innerText().then((t) => t.slice(0, 80).replace(/\n/g, ' | ')).catch(() => ''));
  ok('the offer is gone once used', (await win.locator('.live-circle-ask').count()) === 0);
  await shot('circle-02-card');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // a second circle that is ignored fades by itself
  await drawPath(win, loopAround([100, 140, 190, 165], 10, 6));
  await win.locator('.live-circle-ask').waitFor({ timeout: 2000 }).catch(() => {});
  const again = await win.locator('.live-circle-ask').count();
  await win.waitForTimeout(6600);
  ok('an ignored offer fades by itself', again === 1 && (await win.locator('.live-circle-ask').count()) === 0);
};
