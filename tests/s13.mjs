// Infinite canvas in all directions + PDFs placed on the page (not grabbed by lasso; right-click to move).
import path from 'node:path';
const sample = path.resolve('tests/fixtures/sample.pdf');
const onePage = path.resolve('tests/fixtures/one-page.pdf');

const draw = async (win, x, y, r = 30) => {
  await win.mouse.move(x, y);
  await win.mouse.down();
  for (let i = 0; i <= 24; i++) await win.mouse.move(x + Math.cos(i / 4) * r, y + Math.sin(i / 4) * r);
  await win.mouse.up();
};
const pageInfo = (win) =>
  win.evaluate(async () => {
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    const p = s.pages[0];
    const c = s.content(p.id);
    return { ox: p.ox, oy: p.oy, w: p.w, h: p.h, strokes: c.strokes.length, objects: c.objects.map((o) => o.type), pages: s.pages.length };
  });
// where is world point (0,0) on screen?
const originOnScreen = (win) =>
  win.evaluate(async () => {
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    const p = s.pages[0];
    const r = document.querySelector('.gi-page').getBoundingClientRect();
    const z = r.width / p.w;
    return [Math.round(r.x - (p.ox ?? 0) * z), Math.round(r.y - (p.oy ?? 0) * z)];
  });
const selCount = (win) => win.evaluate(() => (window.__editor.vp.sel ? `objects:${window.__editor.vp.sel.objectIds.size} strokes:${window.__editor.vp.sel.strokeIds.size}` : 'none'));

export default async ({ win, shot }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() =>
    window.__goodink.createNotebook({ title: 'Canvas', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'grid', paper: 'white' }, size: 'a4', landscape: false, infinite: true }),
  );
  await win.waitForTimeout(1500);
  console.log('new infinite page', JSON.stringify(await pageInfo(win)));
  const vb = await win.locator('.gi-scroller').boundingBox();
  await draw(win, vb.x + 300, vb.y + 250);

  // scroll to the far top-left edge and write there: the page must grow left/up without the view jumping
  await win.evaluate(() => {
    const sc = document.querySelector('.gi-scroller');
    sc.scrollLeft = 0;
    sc.scrollTop = 0;
  });
  await win.waitForTimeout(300);
  const o1 = await originOnScreen(win);
  const pg = await win.locator('.gi-page').boundingBox();
  await draw(win, pg.x + 120, pg.y + 120, 20);
  await win.waitForTimeout(500);
  const o2 = await originOnScreen(win);
  console.log('after writing at top-left edge', JSON.stringify(await pageInfo(win)), 'origin on screen before/after', JSON.stringify(o1), JSON.stringify(o2));
  await shot('100-grown-left');

  // back near the start; insert a 4-page PDF: placed on the canvas and not selected
  await win.evaluate(() => {
    const sc = document.querySelector('.gi-scroller');
    sc.scrollLeft = sc.scrollWidth / 2 - 600;
    sc.scrollTop = sc.scrollHeight / 2 - 400;
  });
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__editor.insertPdf(p), sample);
  await win.waitForTimeout(2500);
  console.log('after placing PDF', JSON.stringify(await pageInfo(win)), 'selected after insert:', await selCount(win));
  await shot('101-pdf-placed');

  const pdfBox = await win.evaluate(async () => {
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    const p = s.pages[0];
    const o = s.content(p.id).objects.find((x) => x.type === 'pdf');
    const r = document.querySelector('.gi-page').getBoundingClientRect();
    const z = r.width / p.w;
    return { x: r.x + (o.x - p.ox) * z, y: r.y + (o.y - p.oy) * z, w: o.w * z, h: o.h * z };
  });

  // lasso around it must not pick it up
  await win.keyboard.press('l');
  await win.mouse.move(pdfBox.x - 20, pdfBox.y - 20);
  await win.mouse.down();
  for (const [x, y] of [[pdfBox.x + pdfBox.w + 20, pdfBox.y - 20], [pdfBox.x + pdfBox.w + 20, pdfBox.y + 300], [pdfBox.x - 20, pdfBox.y + 300], [pdfBox.x - 20, pdfBox.y - 18]])
    await win.mouse.move(x, y, { steps: 5 });
  await win.mouse.up();
  console.log('lasso picked up something:', await selCount(win));

  // with the pen: right-click picks it up, then dragging moves it
  await win.keyboard.press('p');
  await win.mouse.click(pdfBox.x + 100, pdfBox.y + 100, { button: 'right' });
  await win.waitForTimeout(200);
  console.log('right-click selected:', await selCount(win));
  await win.mouse.move(pdfBox.x + 100, pdfBox.y + 100);
  await win.mouse.down();
  await win.mouse.move(pdfBox.x + 260, pdfBox.y + 160, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  const pos = await win.evaluate(async () => {
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    return s.content(s.pages[0].id).objects.filter((x) => x.type === 'pdf').map((o) => [Math.round(o.x), Math.round(o.y)]);
  });
  console.log('pdf positions after drag', JSON.stringify(pos));
  await shot('102-moved');

  // writing on top of a placed PDF with the pen draws ink (no accidental move)
  await win.keyboard.press('Escape');
  await draw(win, pdfBox.x + 300, pdfBox.y + 250, 25);
  await win.waitForTimeout(200);
  console.log('ink on top of PDF, selection:', await selCount(win), 'strokes:', (await pageInfo(win)).strokes);

  // long-press with the pen picks it up
  await win.mouse.move(pdfBox.x + 330, pdfBox.y + 330);
  await win.mouse.down();
  await win.waitForTimeout(750);
  await win.mouse.move(pdfBox.x + 380, pdfBox.y + 360, { steps: 6 });
  await win.mouse.up();
  await win.waitForTimeout(200);
  console.log('long-press selected:', await selCount(win), 'strokes (no dot added):', (await pageInfo(win)).strokes);

  console.log(
    'search Calvin ->',
    JSON.stringify(await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return s.searchDoc('Calvin').map((r) => r.pageNumber); })),
  );
  const n = await win.evaluate(async () => {
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    await s.flush();
    const b = await g.exportPdf(s, { pages: [0], includeAnnotations: true, includeTemplates: true });
    return b.length;
  });
  console.log('export bytes', n);

  // fixed A4 notebook: one-page PDF placed on the page; a 4-page PDF becomes new pages
  await win.evaluate(() =>
    window.__goodink.createNotebook({ title: 'A4', folderId: null, cover: { style: 'none', color: '#fff' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false }),
  );
  await win.waitForTimeout(1500);
  await win.evaluate((p) => window.__editor.insertPdf(p), onePage);
  await win.waitForTimeout(1500);
  console.log('A4 + one-page PDF', JSON.stringify(await pageInfo(win)));
  await shot('103-a4-onepage');
  await win.evaluate((p) => window.__editor.insertPdf(p), sample);
  await win.waitForTimeout(1500);
  console.log('A4 + 4-page PDF', JSON.stringify(await pageInfo(win)));
};
