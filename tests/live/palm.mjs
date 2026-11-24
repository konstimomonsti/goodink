// Palm rejection for both hands: a resting hand never scrolls, zooms or jumps the page while you
// write, a hand that lands just before the pen is undone, and a real finger still scrolls.
//   node tests/drive-tauri.mjs tests/live/palm.mjs src-tauri/target/debug/goodink.exe
export default async ({ win, shot }) => {
  const { newNotebook } = await import('./handwriting.mjs');
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'off', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Palm');
  for (let i = 0; i < 3; i++) {
    await win.getByRole('button', { name: 'Add page' }).first().click();
    await win.waitForTimeout(250);
  }
  // somewhere in the middle, so the page can scroll both ways
  await win.evaluate(() => (window.__editor.vp.scroller.scrollTop = 900));
  await win.waitForTimeout(300);

  // synthetic pointer events on the scroller: pen strokes and touches with a contact size
  const send = (evs) =>
    win.evaluate(async (list) => {
      const sc = window.__editor.vp.scroller;
      for (const [type, o] of list) {
        if (o.wait) await new Promise((r) => setTimeout(r, o.wait));
        if (!type) continue;
        sc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: o.id < 20, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, pressure: o.type === 'pen' ? 0.5 : 0.5, width: o.w ?? 1, height: o.w ?? 1, pointerId: o.id, pointerType: o.type, clientX: o.x, clientY: o.y }));
      }
    }, evs);
  const pen = (x, y, len = 120) => {
    const ev = [['pointerdown', { id: 2, type: 'pen', x, y }]];
    for (let k = 1; k <= 12; k++) ev.push(['pointermove', { id: 2, type: 'pen', x: x + (len * k) / 12, y: y + Math.sin(k) * 6, wait: 8 }]);
    ev.push(['pointerup', { id: 2, type: 'pen', x: x + len, y }]);
    return ev;
  };
  const drag = (id, x, y, dx, dy, o = {}) => {
    const ev = [['pointerdown', { id, type: 'touch', x, y, ...o }]];
    for (let k = 1; k <= 10; k++) ev.push(['pointermove', { id, type: 'touch', x: x + (dx * k) / 10, y: y + (dy * k) / 10, wait: 12, ...o }]);
    ev.push(['pointerup', { id, type: 'touch', x: x + dx, y: y + dy, ...o }]);
    return ev;
  };
  const view = () => win.evaluate(() => ({ top: Math.round(window.__editor.vp.scroller.scrollTop), zoom: +window.__editor.vp.zoom.toFixed(3) }));
  const strokes = () =>
    win.evaluate(async () => {
      const vp = window.__editor.vp;
      let n = 0;
      for (const p of vp.session.pages) n += (await vp.session.ensure(p.id)).strokes.length;
      return n;
    });
  const hand = (writingHand) => win.evaluate((h) => window.__goodink.updateSettings({ writingHand: h }), writingHand);

  // 1. left-handed: after writing, the hand rests below-left of the pen and slides: nothing moves
  await hand('left');
  await send(pen(640, 420));
  let v0 = await view();
  await send([['', { wait: 1300 }], ...drag(31, 520, 560, 30, -220)]);
  let v1 = await view();
  ok('left hand: a resting palm below-left of the pen does not scroll', v1.top === v0.top, `${v0.top} → ${v1.top}`);

  // 2. the same touch is a finger for a right-handed writer (it is on the free side): it scrolls
  await hand('right');
  await send(pen(640, 420));
  v0 = await view();
  await send([['', { wait: 1300 }], ...drag(32, 520, 560, 0, -220)]);
  v1 = await view();
  ok('right hand: a finger on the other side still scrolls', v1.top !== v0.top, `${v0.top} → ${v1.top}`);

  // 3. right-handed: the palm rests below-right and slides: nothing moves
  await send(pen(640, 420));
  v0 = await view();
  await send([['', { wait: 1300 }], ...drag(33, 760, 560, -20, -200)]);
  v1 = await view();
  ok('right hand: a resting palm below-right of the pen does not scroll', v1.top === v0.top, `${v0.top} → ${v1.top}`);

  // 4. the hand lands first (5 s after writing, so nothing guards it), drags the page, then the pen
  // touches down: the page goes back to where it was and the pen writes
  await win.waitForTimeout(4300);
  v0 = await view();
  const s0 = await strokes();
  await send([['pointerdown', { id: 34, type: 'touch', x: 900, y: 650 }], ...[1, 2, 3, 4, 5].map((k) => ['pointermove', { id: 34, type: 'touch', x: 900, y: 650 - k * 30, wait: 12 }]), ...pen(500, 400), ['pointerup', { id: 34, type: 'touch', x: 900, y: 500 }]]);
  v1 = await view();
  const s1 = await strokes();
  ok('a hand that lands before the pen is undone: the page does not jump', v1.top === v0.top, `${v0.top} → ${v1.top}`);
  ok('…and the pen still writes', s1 === s0 + 1, `${s0} → ${s1} strokes`);

  // 5. palm + little finger make a "pinch" just before the pen: the zoom goes back
  await win.waitForTimeout(4300);
  v0 = await view();
  await send([
    ['pointerdown', { id: 35, type: 'touch', x: 700, y: 600 }],
    ['pointerdown', { id: 36, type: 'touch', x: 800, y: 650, wait: 10 }],
    ...[1, 2, 3, 4].map((k) => ['pointermove', { id: 36, type: 'touch', x: 800 + k * 40, y: 650 + k * 20, wait: 12 }]),
    ...pen(500, 380),
    ['pointerup', { id: 35, type: 'touch', x: 700, y: 600 }],
    ['pointerup', { id: 36, type: 'touch', x: 960, y: 730 }],
  ]);
  v1 = await view();
  ok('a hand that "pinches" before the pen does not zoom or jump', v1.zoom === v0.zoom && v1.top === v0.top, `zoom ${v0.zoom} → ${v1.zoom}, top ${v0.top} → ${v1.top}`);

  // 6. a palm-sized contact is never a finger, even long after writing
  await win.waitForTimeout(4300);
  v0 = await view();
  await send(drag(37, 300, 500, 0, -200, { w: 90 }));
  v1 = await view();
  ok('a palm-sized contact never scrolls', v1.top === v0.top, `${v0.top} → ${v1.top}`);

  // 7. and an ordinary finger, away from writing, scrolls as before
  v0 = await view();
  await send(drag(38, 300, 500, 0, -200, { w: 24 }));
  v1 = await view();
  ok('an ordinary finger scrolls', v1.top > v0.top, `${v0.top} → ${v1.top}`);
  await shot('palm-1');
  await win.evaluate(() => window.__goodink.openDialog({ type: 'settings' }));
  await win.waitForTimeout(500);
  await win.getByText('Writing hand', { exact: true }).scrollIntoViewIfNeeded();
  await shot('palm-2-setting');
};
