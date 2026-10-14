export default async ({ win }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Dbg', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false }));
  await win.waitForTimeout(1500);
  await win.evaluate(() => { window.__ev = []; const sc = document.querySelector('.gi-scroller'); for (const t of ['pointerdown','pointermove','pointerrawupdate','pointerup','lostpointercapture']) sc.addEventListener(t, (e) => window.__ev.push(`${t} ${Math.round(e.clientX)},${Math.round(e.clientY)} b${e.buttons}`), true); });
  const box = await win.locator('.gi-page').first().boundingBox();
  for (let k = 0; k < 4; k++) {
    const x0 = box.x + 80 + k * 70, y0 = box.y + 140;
    await win.mouse.move(x0, y0);
    await win.mouse.down();
    for (let i = 1; i <= 16; i++) await win.mouse.move(x0 + i * 3, y0 + Math.sin(i / 2) * 14);
    await win.mouse.up();
    await win.waitForTimeout(140);
  }
  await win.waitForTimeout(300);
  const info = await win.evaluate(async () => {
    const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active);
    const c = s.content(s.pages[0].id);
    return c.strokes.map((st) => { const p = st.pts; const xs = []; for (let i = 0; i < p.length; i += 3) xs.push(`${p[i].toFixed(0)},${p[i+1].toFixed(0)}`); return xs.join(' '); });
  });
  info.forEach((l, i) => console.log('stroke', i, l));
  const ev = await win.evaluate(() => window.__ev);
  console.log(ev.filter((e) => !e.startsWith('pointerrawupdate')).slice(0, 30).join('\n'));
  console.log('raw count', ev.filter((e) => e.startsWith('pointerrawupdate')).length, 'sample', ev.filter((e) => e.startsWith('pointerrawupdate')).slice(0, 5).join(' | '));
};
