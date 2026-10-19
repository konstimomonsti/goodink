// Which elements are scrolled sideways, and can the library (Files) scroll? Diagnostics for layout bugs.
//   node tests/drive-tauri.mjs tests/live/scroll-probe.mjs src-tauri/target/debug/goodink.exe
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  // enough notebooks that the Files grid is taller than the window
  await win.evaluate(async () => {
    for (let i = 0; i < 40; i++) await window.__goodink.createNotebook({ title: `Notebook ${i + 1}`, folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: false });
  });
  await win.waitForTimeout(1000);
  const info = await win.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const scrollY = el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(cs.overflowY);
      if (scrollY || el.scrollLeft || el.scrollTop) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} overflowY=${cs.overflowY} sh=${el.scrollHeight} ch=${el.clientHeight} st=${el.scrollTop} sl=${el.scrollLeft}`);
    }
    return { out, html: [document.documentElement.scrollHeight, innerHeight], body: getComputedStyle(document.body).overflow };
  });
  console.log(JSON.stringify(info, null, 1));
  // try the mouse wheel over the grid
  await win.mouse.move(640, 600);
  await win.mouse.wheel(0, 900);
  await win.waitForTimeout(600);
  const after = await win.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} st=${e.scrollTop}`));
  console.log('after wheel:', JSON.stringify(after));
  await shot('scroll-probe');
};
