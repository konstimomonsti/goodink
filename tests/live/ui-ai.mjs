// AI selector with the fake engine: draw a loop, glow, quick actions, streamed answer, pin, move.
// node tests/drive-tauri.mjs tests/live/ui-ai.mjs src-tauri/target/debug/goodink.exe
// env: DARK=1 dark theme · SMALL=1 760x520 window · NOAI=1 no AI configured
import { openNotebook, pageBox, writeProblem, crop } from './ui-lib.mjs';

async function loop(win, cx, cy, rx, ry, { release = true, steps = 70 } = {}) {
  await win.mouse.move(cx + rx, cy);
  await win.mouse.down();
  for (let k = 1; k <= steps; k++) {
    const a = (k / steps) * Math.PI * 2.08;
    const wob = 1 + 0.04 * Math.sin(a * 3);
    await win.mouse.move(cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob);
  }
  if (release) await win.mouse.up();
}

export default async ({ win, shot }) => {
  const dark = process.env.DARK === '1';
  const small = process.env.SMALL === '1';
  const noai = process.env.NOAI === '1';
  const sfx = `${dark ? '-dark' : ''}${small ? '-small' : ''}${noai ? '-noai' : ''}`;
  if (noai) await win.evaluate(() => (window.__liveFake = { aiReady: false }));
  await openNotebook(win, { dark, w: small ? 760 : 1440, h: small ? 520 : 900 });
  const pb = await pageBox(win);
  const x = pb.x + (small ? 40 : 90), y = pb.y + (small ? 90 : 170);
  const lines = await writeProblem(win, x, y, small ? 22 : 30, small ? 40 : 54);
  await win.waitForTimeout(1200);
  await shot(`ui-20-before${sfx}`);

  await win.keyboard.press('a');
  await win.waitForTimeout(200);
  const b = { x0: lines[0].x0, y0: lines[0].y0, x1: lines[0].x1, y1: lines[2].y1 };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const rx = (b.x1 - b.x0) / 2 + 34, ry = (b.y1 - b.y0) / 2 + 30;
  await loop(win, cx, cy, rx, ry, { release: false, steps: 50 });
  await win.waitForTimeout(60);
  await shot(`ui-21-drawing${sfx}`);
  await crop(win, `ui-21b-drawing-crop${sfx}`, { x: cx - rx - 40, y: cy - ry - 40, width: rx * 2 + 80, height: ry * 2 + 80 });
  for (let k = 51; k <= 72; k++) {
    const a = (k / 70) * Math.PI * 2.08;
    await win.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  await win.mouse.up();
  await win.waitForTimeout(120);
  await shot(`ui-22-release${sfx}`);
  await win.waitForTimeout(900);
  await shot(`ui-23-popover${sfx}`);
  if (noai) return;
  const card = win.locator('.live-ai');
  await card.waitFor();
  let cb = await card.boundingBox();
  await crop(win, `ui-23b-popover-crop${sfx}`, { x: Math.max(0, cx - rx - 30), y: Math.max(0, Math.min(cb.y, cy - ry) - 30), width: Math.min(win.viewportSize().width, cb.x + cb.width + 30) - Math.max(0, cx - rx - 30), height: Math.max(cb.y + cb.height, cy + ry) - Math.min(cb.y, cy - ry) + 60 });

  await win.getByRole('button', { name: 'Explain' }).click();
  await win.waitForTimeout(1000);
  await shot(`ui-24-streaming${sfx}`);
  await win.waitForTimeout(2600);
  await shot(`ui-25-answer${sfx}`);
  cb = await card.boundingBox();
  await crop(win, `ui-25b-answer-crop${sfx}`, { x: cb.x - 20, y: cb.y - 20, width: cb.width + 40, height: cb.height + 40 });

  // follow-up by chip
  const chip = win.locator('.live-ai .live-chip').first();
  if (await chip.count()) {
    await chip.click();
    await win.waitForTimeout(3200);
    cb = await card.boundingBox();
    await crop(win, `ui-26-followup${sfx}`, { x: cb.x - 20, y: cb.y - 20, width: cb.width + 40, height: cb.height + 40 });
  }

  // pin, then move it by its header
  await win.getByRole('button', { name: /^Pin/ }).click();
  await win.waitForTimeout(250);
  cb = await card.boundingBox();
  await win.mouse.move(cb.x + 120, cb.y + 22);
  await win.mouse.down();
  await win.mouse.move(cb.x + 60, cb.y + 140, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(250);
  await shot(`ui-27-pinned-moved${sfx}`);
  console.log('region capture size:', await win.evaluate(async () => {
    const vp = window.__editor.vp;
    const p = vp.session.pages[0].id;
    const r = await vp.captureRegion(p, [80, 80, 300, 80, 300, 260, 80, 260]);
    return r && [r.w, r.h, r.png.length];
  }));
  await win.getByRole('button', { name: 'Close (Esc)' }).click();
  await win.waitForTimeout(200);
  console.log('cards left:', await win.locator('.live-card').count());
};
