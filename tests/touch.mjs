// Touch, touchpad and keyboard parity in the notebook editor: node tests/drive-tauri.mjs tests/touch.mjs
// Real input through the DevTools protocol: touch points, a touchpad pinch gesture, key presses.
import zlib from 'node:zlib';

function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([30, 90, 200], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export default async ({ win, shot }) => {
  const cdp = await win.context().newCDPSession(win);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const wait = (ms) => win.waitForTimeout(ms);
  const vis = (sel) => win.locator(`${sel}:visible`);
  const zoomText = async () => (await vis('.zoom-val').innerText()).trim();
  const holdDrag = async (x0, y0, x1, y1, hold = 650) => {
    await touch('touchStart', x0, y0);
    await wait(hold);
    for (let k = 1; k <= 12; k++) {
      await touch('touchMove', x0 + ((x1 - x0) * k) / 12, y0 + ((y1 - y0) * k) / 12);
      await wait(25);
    }
    await touch('touchEnd');
    await wait(400);
  };

  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await wait(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.getByRole('button', { name: 'New', exact: true }).click();
  await win.getByRole('menuitem', { name: /^Notebook/ }).click();
  await win.locator('.modal input').first().fill('Touch test');
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await vis('.page-indicator').waitFor();
  for (let k = 0; k < 2; k++) await win.getByRole('button', { name: 'Add page' }).first().click();
  await wait(600);

  // touchpad pinch (the gesture Windows sends for a precision touchpad), out then in
  const box = await vis('.ed-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const z0 = await zoomText();
  await cdp.send('Input.synthesizePinchGesture', { x: cx, y: cy, scaleFactor: 0.5, gestureSourceType: 'mouse' });
  await wait(500);
  const z1 = await zoomText();
  await cdp.send('Input.synthesizePinchGesture', { x: cx, y: cy, scaleFactor: 1.8, gestureSourceType: 'mouse' });
  await wait(500);
  const z2 = await zoomText();
  console.log('touchpad pinch: start', z0, '→ out', z1, '→ in', z2, '| whole-window zoom stayed at', await win.evaluate(() => window.visualViewport?.scale));
  // two-finger touch pinch out
  const p0 = await zoomText();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 150, y: cy, id: 1 }, { x: cx + 150, y: cy, id: 2 }] });
  for (let k = 1; k <= 8; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 150 + k * 12, y: cy, id: 1 }, { x: cx + 150 - k * 12, y: cy, id: 2 }] });
    await wait(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(300);
  console.log('two-finger pinch out:', p0, '→', await zoomText());
  await vis('.zoom-val').click(); // back to fit width
  await wait(400);

  // page thumbnails: bookmark page 1, then hold its thumbnail and drag it below page 3
  await win.locator('.ed-canvas:visible').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await vis('.thumb[data-index="0"] .thumb-hit').click();
  await wait(900);
  await win.keyboard.press('Control+b');
  await wait(300);
  const t0 = await vis('.thumb[data-index="0"]').boundingBox();
  const t2 = await vis('.thumb[data-index="2"]').boundingBox();
  await holdDrag(t0.x + t0.width / 2, t0.y + t0.height / 2, t2.x + t2.width / 2, t2.y + t2.height * 0.8);
  const bmAt = await win.locator('.thumb:visible:has(.thumb-bm)').getAttribute('data-index');
  console.log('touch drag moved bookmarked page 1 to position', +bmAt + 1, '(expected 3)');
  await shot('touch-01-reordered');

  // keyboard: Alt+Up moves the current page up
  await vis('.thumb[data-index="2"] .thumb-hit').click();
  await wait(900);
  await vis('.nav-list').focus();
  await win.keyboard.press('Alt+ArrowUp');
  await wait(300);
  console.log('Alt+Up moved it to position', +(await win.locator('.thumb:visible:has(.thumb-bm)').getAttribute('data-index')) + 1, '(expected 2)');

  // keyboard: select two pages with Shift+Down, move both with Alt+Down
  const order = () => win.evaluate(() => window.__editor.vp.session.pages.map((p) => p.id));
  await vis('.thumb[data-index="0"] .thumb-hit').click();
  await wait(900);
  await vis('.nav-list').focus();
  const before = await order();
  await win.keyboard.press('Shift+ArrowDown');
  await wait(300);
  console.log('selected with Shift+Down:', await win.locator('.thumb.is-picked:visible').count(), 'pages');
  await win.keyboard.press('Alt+ArrowDown');
  await wait(300);
  const after = await order();
  console.log('Alt+Down moved both:', JSON.stringify(after.map((id) => before.indexOf(id) + 1)), '(expected [3,1,2])');
  // a placed image: fingers scroll (pen-only mode), holding a finger still picks it up and moves it
  await win.evaluate(() => window.__goodink.updateSettings({ stylusMode: 'penOnly' }));
  const pageId = await win.evaluate(async (bytes) => {
    const vp = window.__editor.vp;
    const id = vp.session.pages[vp.pageIndexNow].id;
    await vp.insertImageBytes(id, new Uint8Array(bytes), 'png');
    return id;
  }, [...png(160, 120)]);
  await wait(500);
  await win.evaluate((pageId) => {
    const vp = window.__editor.vp;
    const o = vp.session.content(pageId).objects.at(-1);
    vp.scrollToPage(vp.session.pageIndex(pageId), false, o.y + o.h / 2);
  }, pageId);
  await wait(400);
  const geo = await win.evaluate((pageId) => {
    const vp = window.__editor.vp;
    const i = vp.session.pageIndex(pageId);
    const o = vp.session.content(pageId).objects.at(-1);
    const sr = vp.scroller.getBoundingClientRect();
    const r = vp.rects[i];
    return { id: o.id, x: o.x, y: o.y, cx: sr.left + r.x - vp.scroller.scrollLeft + (o.x + o.w / 2) * vp.zoom, cy: sr.top + r.y - vp.scroller.scrollTop + (o.y + o.h / 2) * vp.zoom, zoom: vp.zoom };
  }, pageId);
  await holdDrag(geo.cx, geo.cy, geo.cx + 120, geo.cy + 60);
  const moved = await win.evaluate(([pageId, id]) => {
    const o = window.__editor.vp.session.content(pageId).objects.find((x) => x.id === id);
    return { x: o.x, y: o.y };
  }, [pageId, geo.id]);
  console.log('finger long-press moved the image by', Math.round((moved.x - geo.x) * geo.zoom), 'x', Math.round((moved.y - geo.y) * geo.zoom), 'px (expected about 120 x 60)');
  await shot('touch-02-image-moved');
  // the picked-up image's menu closes with a finger tap next to it, and with its Done button
  console.log('menu open after pick-up:', await win.locator('.sel-menu').isVisible());
  await touch('touchStart', geo.cx - 300, geo.cy - 200);
  await touch('touchEnd');
  await wait(300);
  console.log('menu after a finger tap elsewhere:', await win.locator('.sel-menu').count() ? 'still open' : 'closed');
  await holdDrag(geo.cx + 120, geo.cy + 60, geo.cx + 120, geo.cy + 60);
  console.log('menu after picking up again:', await win.locator('.sel-menu').isVisible());
  await win.locator('.sel-menu').getByRole('button', { name: 'Done' }).click();
  await wait(200);
  console.log('menu after Done:', await win.locator('.sel-menu').count() ? 'still open' : 'closed');

  // a quick finger swipe in pen-only mode scrolls instead of drawing
  const strokes = () => win.evaluate((pageId) => window.__editor.vp.session.content(pageId).strokes.length, pageId);
  const s0 = await strokes();
  await touch('touchStart', cx - 200, cy + 150);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', cx - 200 + k * 30, cy + 150 - k * 20); await wait(16); }
  await touch('touchEnd');
  await wait(300);
  const s1 = await strokes();
  // "Fingers draw": the same swipe writes with the pen
  await win.evaluate(() => window.__goodink.updateSettings({ stylusMode: 'touch' }));
  await touch('touchStart', cx - 200, cy + 150);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', cx - 200 + k * 30, cy + 150 - k * 20); await wait(16); }
  await touch('touchEnd');
  await wait(400);
  console.log('strokes: pen-only swipe', s1 - s0, '(expected 0) | fingers-draw swipe', (await strokes()) - s1, '(expected 1)');
  await win.evaluate(() => window.__goodink.updateSettings({ stylusMode: 'auto' }));
};
