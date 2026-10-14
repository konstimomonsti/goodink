// Palm rejection: a touch landing and moving while the pen writes must not disturb the stroke.
export default async ({ win, shot }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Palm', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false }));
  await win.waitForTimeout(1500);
  const result = await win.evaluate(async () => {
    const sc = document.querySelector('.gi-scroller');
    const r = document.querySelector('.gi-page').getBoundingClientRect();
    const fire = (type, id, kind, x, y, buttons, pressure) =>
      sc.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: kind, clientX: x, clientY: y, buttons, button: type === 'pointermove' ? -1 : 0, pressure, bubbles: true, isPrimary: kind === 'pen' }));
    const pen = (type, x, y, b, p) => fire(type, 2, 'pen', x, y, b, p);
    const palm = (type, x, y, b) => fire(type, 9, 'touch', x, y, b, 0.5);
    const x0 = r.left + 100, y0 = r.top + 150;
    pen('pointermove', x0, y0, 0, 0); // hover
    pen('pointerdown', x0, y0, 1, 0.4);
    for (let i = 1; i <= 40; i++) {
      pen('pointermove', x0 + i * 4, y0 + Math.sin(i / 4) * 20, 1, 0.3 + i / 80);
      if (i === 10) palm('pointerdown', x0 + 300, y0 + 400, 1);
      if (i > 10 && i < 30) palm('pointermove', x0 + 300 + i * 3, y0 + 400 + i, 1);
      if (i === 30) palm('pointerup', x0 + 390, y0 + 430, 0);
      await new Promise((res) => setTimeout(res, 8));
    }
    pen('pointerup', x0 + 160, y0 + Math.sin(10) * 20, 0, 0);
    await new Promise((res) => setTimeout(res, 200));
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    const c = s.content(s.pages[0].id);
    let maxJump = 0;
    for (const st of c.strokes) for (let i = 3; i < st.pts.length; i += 3) maxJump = Math.max(maxJump, Math.hypot(st.pts[i] - st.pts[i - 3], st.pts[i + 1] - st.pts[i - 2]));
    return { strokes: c.strokes.length, points: c.strokes[0]?.pts.length / 3, maxJump: +maxJump.toFixed(1), scrollTop: sc.scrollTop };
  });
  console.log('palm test', JSON.stringify(result));
  await shot('60-palm');
};
