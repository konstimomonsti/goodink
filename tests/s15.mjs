// Smart pen: pen hover shows the tip preview; touch scrolls (not draws) on a pen PC.
export default async ({ win }) => {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Pen', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false }));
  await win.waitForTimeout(1500);
  const r = await win.evaluate(async () => {
    const vp = window.__editor.vp;
    const sc = document.querySelector('.gi-scroller');
    const b = document.querySelector('.gi-page').getBoundingClientRect();
    const fire = (type, kind, x, y, buttons) => sc.dispatchEvent(new PointerEvent(type, { pointerId: kind === 'pen' ? 3 : 7, pointerType: kind, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0, bubbles: true }));
    const out = { penSeenAtStart: vp.penSeen };
    fire('pointerrawupdate', 'pen', b.left + 200, b.top + 200, 0);
    out.hoverDot = !!vp.penHover;
    // finger drag on the page must scroll, not draw (wait out the palm window after pen hover)
    await new Promise((res) => setTimeout(res, 700));
    const before = sc.scrollTop;
    fire('pointerdown', 'touch', b.left + 300, b.top + 500, 1);
    for (let i = 1; i <= 10; i++) fire('pointermove', 'touch', b.left + 300, b.top + 500 - i * 20, 1);
    fire('pointerup', 'touch', b.left + 300, b.top + 300, 0);
    await new Promise((res) => setTimeout(res, 100));
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    out.touchStrokes = s.content(s.pages[0].id).strokes.length;
    out.touchScrolled = sc.scrollTop !== before;
    return out;
  });
  console.log('PEN', JSON.stringify(r));
};
