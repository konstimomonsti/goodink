// Live check marks and the insight card with the fake engine:
// node tests/drive-tauri.mjs tests/live/ui-marks.mjs src-tauri/target/debug/goodink.exe
import { openNotebook, pageBox, writeProblem, crop, clipAround } from './ui-lib.mjs';

export default async ({ win, shot }) => {
  const dark = process.env.DARK === '1';
  const small = process.env.SMALL === '1';
  const sfx = (dark ? '-dark' : '') + (small ? '-small' : '');
  await openNotebook(win, { dark, ...(small ? { w: 760, h: 520 } : {}) });
  const pb = await pageBox(win);
  const x = pb.x + (small ? 50 : 90), y = pb.y + (small ? 110 : 170);
  const lines = await writeProblem(win, x, y);
  await win.waitForTimeout(2300);
  const all = { x0: lines[0].x0, y0: lines[0].y0, x1: lines[0].x1 + 40, y1: lines[2].y1 };
  await shot(`ui-01-marks${sfx}`);
  await crop(win, `ui-02-marks-crop${sfx}`, clipAround(all, 30));
  console.log('marks:', await win.locator('.gi-live-mark').evaluateAll((m) => m.map((e) => e.getAttribute('class'))));

  // hover the wavy line: tip with the issue title
  const err = await win.locator('.gi-live-mark.is-error path').boundingBox();
  await win.keyboard.press('l'); // lasso: mouse hover does not draw
  await win.mouse.move(err.x + err.width / 2, err.y + err.height / 2);
  await win.waitForTimeout(400);
  console.log('tip:', await win.evaluate(() => { const t = document.querySelector('.gi-live-tip'); if (!t) return 'none'; const cs = getComputedStyle(t); return [t.className, cs.opacity, cs.backgroundColor, t.style.left, t.style.top, t.offsetWidth]; }));
  await crop(win, `ui-03-tip${sfx}`, clipAround({ x0: err.x - 60, y0: err.y - 60, x1: err.x + err.width + 200, y1: err.y + 70 }, 10));

  // zoom levels
  for (const [k, z] of [[1, 0.6], [2, 1.6], [3, 3]]) {
    await win.evaluate((zz) => window.__editor.vp.setZoom(zz), z);
    await win.waitForTimeout(400);
    await win.evaluate(() => document.querySelector('.gi-live-mark')?.scrollIntoView({ block: 'center', inline: 'center' }));
    await win.waitForTimeout(400);
    const e2 = await win.locator('.gi-live-mark.is-error path').boundingBox();
    if (e2) await crop(win, `ui-04-zoom${k}${sfx}`, clipAround({ x0: e2.x - 120, y0: e2.y - 130, x1: e2.x + e2.width + 120, y1: e2.y + 30 }, 10));
  }
  await win.evaluate(() => {
    window.__editor.vp.setZoom(1.6);
    window.__editor.vp.scrollToPage(0, false);
  });
  await win.waitForTimeout(500);

  // the same marks on a 2x screen (crispness)
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await win.waitForTimeout(900);
  const e4 = await win.locator('.gi-live-mark.is-error path').boundingBox();
  await win.screenshot({ path: `tests/shots/ui-04-dpr2${sfx}.png`, clip: { x: e4.x - 90, y: e4.y - 150, width: e4.width + 180, height: 180 }, scale: 'device' });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await win.waitForTimeout(600);

  // right-click the wrong line: the insight card
  const e3 = await win.locator('.gi-live-mark.is-error path').boundingBox();
  await win.mouse.click(e3.x + e3.width / 2, e3.y - 14, { button: 'right' });
  await win.waitForTimeout(500);
  await win.locator('.live-card').waitFor();
  await win.waitForTimeout(350);
  await shot(`ui-05-card${sfx}`);
  const cb = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-06-card-crop${sfx}`, { x: cb.x - 260, y: cb.y - 20, width: cb.width + 290, height: cb.height + 40 });

  // hint ladder
  await win.getByRole('button', { name: 'Hint', exact: true }).click();
  await win.waitForTimeout(700);
  await crop(win, `ui-07-hint-streaming${sfx}`, { x: cb.x - 20, y: cb.y - 20, width: cb.width + 40, height: Math.min(700, (await win.locator('.live-card').boundingBox()).height + 40) });
  await win.waitForTimeout(1500);
  await win.getByRole('button', { name: 'Next step', exact: true }).click();
  await win.waitForTimeout(2200);
  await win.getByRole('button', { name: 'Show fix', exact: true }).click();
  await win.waitForTimeout(2200);
  const cb2 = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-08-hints-all${sfx}`, { x: cb2.x - 20, y: cb2.y - 20, width: cb2.width + 40, height: cb2.height + 40 });

  // ask
  await win.locator('.live-card textarea').fill('Why is it 2 and not 3?');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1100);
  let cb3 = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-09-ask-streaming${sfx}`, { x: cb3.x - 20, y: cb3.y - 20, width: cb3.width + 40, height: cb3.height + 40 });
  await win.waitForTimeout(2500);
  cb3 = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-10-ask-done${sfx}`, { x: cb3.x - 20, y: cb3.y - 20, width: cb3.width + 40, height: cb3.height + 40 });

  // edit reading → re-check
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  await win.mouse.click(e3.x + e3.width / 2, e3.y - 14, { button: 'right' });
  await win.locator('.live-card').waitFor();
  await win.waitForTimeout(400);
  await win.getByRole('button', { name: 'Edit reading' }).click();
  await win.waitForTimeout(200);
  let cb4 = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-11-edit-reading${sfx}`, { x: cb4.x - 20, y: cb4.y - 20, width: cb4.width + 40, height: cb4.height + 40 });
  await win.locator('.live-edit').fill('x=2');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(120);
  cb4 = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-12-rechecking${sfx}`, { x: cb4.x - 20, y: cb4.y - 20, width: cb4.width + 40, height: cb4.height + 40 });
  await win.waitForTimeout(800);
  cb4 = await win.locator('.live-card').boundingBox();
  await crop(win, `ui-13-rechecked-ok${sfx}`, { x: cb4.x - 20, y: cb4.y - 20, width: cb4.width + 40, height: cb4.height + 40 });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  console.log('card closed by Esc:', (await win.locator('.live-card').count()) === 0);

  // status pill + popover
  const pill = win.locator('.live-pill');
  const pbx = await pill.boundingBox();
  await crop(win, `ui-14-pill${sfx}`, { x: pbx.x - 300, y: 0, width: 760, height: 60 });
  await pill.click();
  await win.locator('.live-pop').waitFor();
  await win.waitForTimeout(250);
  const pop = await win.locator('.live-pop').boundingBox();
  await crop(win, `ui-15-pill-popover${sfx}`, { x: pop.x - 20, y: 0, width: pop.width + 40, height: pop.y + pop.height + 20 });
  await win.keyboard.press('Escape');
};
