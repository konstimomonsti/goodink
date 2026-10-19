// Links between notes: lasso -> Link -> pick a notebook; the badge opens it; the target's Links tab
// lists the backlink; [[#3]] typed in a text box links to page 3 of this notebook.
//   node tests/drive-tauri.mjs tests/live/note-links.mjs src-tauri/target/debug/goodink.exe
export default async ({ win, shot }) => {
  const { newNotebook, writeText, pageOrigin } = await import('./handwriting.mjs');
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  const active = () => win.evaluate(() => window.__goodink.useApp.getState().active);
  const titleOfActive = () => win.evaluate(() => { const g = window.__goodink.useApp.getState(); return g.library.notebooks.find((n) => n.id === g.active)?.title; });
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'off', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  // the target notebook exists but stays closed; the one we work in is opened
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Exercises', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: false }));
  await newNotebook(win, 'Lecture');
  for (let i = 0; i < 2; i++) {
    await win.getByRole('button', { name: 'Add page' }).first().click();
    await win.waitForTimeout(300);
  }
  await win.evaluate(() => window.__editor.vp.scrollToPage(0, false));
  await win.waitForTimeout(300);
  const lecture = await active();

  // 1. lasso some ink, Link -> Exercises
  const { bbox } = await writeText(win, 'see ex 3', { x: 100, y: 160, size: 30, seed: 4 });
  await win.waitForTimeout(300);
  await win.keyboard.press('l');
  const o = await pageOrigin(win);
  const c = ([x, y]) => [o.left + (x - o.ox) * o.zoom, o.top + (y - o.oy) * o.zoom];
  const loop = [[bbox[0] - 12, bbox[1] - 12], [bbox[2] + 12, bbox[1] - 12], [bbox[2] + 12, bbox[3] + 12], [bbox[0] - 12, bbox[3] + 12], [bbox[0] - 12, bbox[1] - 12]].map(c);
  await win.mouse.move(loop[0][0], loop[0][1]);
  await win.mouse.down();
  for (const [x, y] of loop.slice(1)) await win.mouse.move(x, y, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(400);
  await win.locator('.sel-btn', { hasText: 'Link' }).click();
  await win.getByRole('option', { name: /Exercises/ }).click();
  await win.locator('.modal').getByRole('button', { name: 'Link', exact: true }).click();
  await win.waitForTimeout(500);
  ok('the link badge appears over the selection', (await win.locator('.gi-link-badge').count()) === 1);
  await shot('links-01-badge');

  // 2. the badge opens the linked notebook
  await win.locator('.gi-link-badge').first().click();
  await win.waitForTimeout(1500);
  ok('tapping the badge opens the linked note', (await titleOfActive()) === 'Exercises', await titleOfActive());

  // 3. the target lists the backlink
  await win.getByRole('radio', { name: 'Links' }).click().catch(async () => win.getByText('Links', { exact: true }).click());
  await win.waitForTimeout(400);
  const back = await win.locator('.nav-text').innerText().catch(() => '');
  // innerText follows the label's text-transform (LINKED FROM)
  ok('the linked note shows where it is linked from', /Linked from[\s\S]*Lecture/i.test(back), back.replace(/\n/g, ' | ').slice(-70));
  const shifted = await win.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollLeft > 0 && !e.classList.contains('gi-scroller')).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} sl=${e.scrollLeft} sw=${e.scrollWidth} cw=${e.clientWidth}`));
  ok('nothing outside the page area is scrolled sideways', !shifted.length, JSON.stringify(shifted));
  await shot('links-02-backlinks');

  // 4. [[#3]] in a text box links to page 3 of this notebook
  await win.evaluate((id) => window.__goodink.useApp.setState({ active: id }), lecture);
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__editor.vp.scrollToPage(0, false));
  await win.keyboard.press('t');
  const o2 = await pageOrigin(win);
  await win.mouse.click(o2.left + (100 - o2.ox) * o2.zoom, o2.top + (320 - o2.oy) * o2.zoom);
  await win.waitForTimeout(300);
  await win.keyboard.type('Proof: [[#3]]');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(600);
  const badges = await win.locator('.gi-link-badge').count();
  ok('[[#3]] in a text box becomes a link', badges === 2, `${badges} badges`);
  await win.locator('.gi-link.is-typed .gi-link-badge').first().click().catch(() => {});
  await win.waitForTimeout(1200);
  const pageNow = await win.evaluate(() => window.__editor.vp.pageIndexNow);
  ok('it jumps to page 3', pageNow === 2, `page ${pageNow + 1}`);
  await shot('links-03-typed');
};
