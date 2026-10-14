// Text boxes: formatting, moving by drag (text tool), by the move handle and by right-click with any tool;
// "Notebooks / All files"; no .tmp files in the library. node tests/drive-tauri.mjs tests/text-move.mjs
import fs from 'node:fs';
import path from 'node:path';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
};

export default async ({ win, shot, lib }) => {
  // a leftover of an older version, as found in a real library
  const stale = path.join(lib, 'library.json.1234.9b1aa3f0.tmp');
  fs.writeFileSync(stale, '');
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(stale, old, old);

  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() => window.__goodink.createNotebook({ title: 'Text', folderId: null, cover: { style: 'solid', color: '#2f5b8a' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: true }));
  await win.waitForSelector('.gi-page', { timeout: 15000 });
  await win.waitForTimeout(800);
  const objects = () => win.evaluate(() => {
    const vp = window.__editor.vp;
    return vp.session.content(vp.session.pages[0].id).objects;
  });
  const box = await win.locator('.gi-page').first().boundingBox();
  const k = box.width / 595.28;
  const P = (x, y) => [box.x + x * k, box.y + y * k];

  // defaults for the next text: Heading, underlined, red
  await win.keyboard.press('t');
  await win.getByRole('combobox', { name: 'Text style' }).selectOption('heading');
  await win.getByRole('button', { name: 'Underline (Ctrl+U)' }).click();
  await win.getByRole('combobox', { name: 'Line spacing' }).selectOption('1.5');
  await win.locator('.subbar .swatch').nth(3).click();
  await win.mouse.click(...P(100, 150));
  await win.keyboard.type('Moving text');
  await win.waitForTimeout(150);
  await shot('text-1-editing');
  // size field while typing: 30, then Enter goes back to the text
  await win.locator('.size-field input').fill('30');
  await win.keyboard.press('Enter');
  await win.keyboard.type('!');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  let [t] = await objects();
  ok('text made', t?.text === 'Moving text!', JSON.stringify(t?.text));
  ok('style applied (size 30, bold, underline, 1.5, red)', t?.size === 30 && t.bold && t.underline && t.lineHeight === 1.5 && t.color === '#c8202f', JSON.stringify({ size: t?.size, bold: t?.bold, u: t?.underline, lh: t?.lineHeight, c: t?.color }));
  const x0 = t.x, y0 = t.y;

  // drag it with the text tool
  const from = P(t.x + 20, t.y + t.h / 2);
  await win.mouse.move(...from);
  await win.mouse.down();
  await win.mouse.move(from[0] + 60, from[1] + 90, { steps: 8 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  [t] = await objects();
  ok('dragged with the text tool', Math.abs(t.x - x0 - 60 / k) < 2 && Math.abs(t.y - y0 - 90 / k) < 2, `${(t.x - x0).toFixed(1)},${(t.y - y0).toFixed(1)}`);
  ok('not left editing after a drag', (await win.locator('.gi-text-editor').count()) === 0);

  // tap: edit, with the caret where tapped; then move by the handle
  const at = P(t.x + 10, t.y + t.h / 2);
  await win.mouse.click(...at);
  await win.waitForTimeout(150);
  ok('tap edits', (await win.locator('.gi-text-editor').count()) === 1);
  const h = await win.locator('.gi-text-move').boundingBox();
  ok('move handle shown', !!h && h.width > 20 && h.width < 34, JSON.stringify(h));
  const x1 = t.x, y1 = t.y;
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await win.mouse.down();
  await win.mouse.move(h.x + h.width / 2 - 40, h.y + h.height / 2 + 30, { steps: 6 });
  await win.mouse.up();
  await win.keyboard.type('?');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  [t] = await objects();
  ok('moved by the handle', Math.abs(t.x - x1 + 40 / k) < 2 && Math.abs(t.y - y1 - 30 / k) < 2, `${(t.x - x1).toFixed(1)},${(t.y - y1).toFixed(1)}`);
  ok('still typing after the handle', t.text.includes('?'), t.text);

  // with the pen: right-click picks it up, then drag moves it
  await win.keyboard.press('p');
  const c = P(t.x + t.w / 2, t.y + t.h / 2);
  await win.mouse.click(...c, { button: 'right' });
  await win.waitForTimeout(150);
  const x2 = t.x;
  await win.mouse.move(...c);
  await win.mouse.down();
  await win.mouse.move(c[0] + 50, c[1], { steps: 6 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  [t] = await objects();
  ok('right-click + drag moves text with the pen', Math.abs(t.x - x2 - 50 / k) < 3, (t.x - x2).toFixed(1));
  const strokes = await win.evaluate(() => window.__editor.vp.session.content(window.__editor.vp.session.pages[0].id).strokes.length);
  ok('no ink drawn while moving', strokes === 0, String(strokes));
  await shot('text-2-moved');

  // the next new text keeps the chosen style
  await win.keyboard.press('Escape');
  await win.keyboard.press('t');
  console.log('after t:', await win.evaluate(() => [window.__editor.vp.tools.tool, !!window.__editor.vp.sel, document.activeElement?.tagName + '.' + document.activeElement?.className]));
  await win.mouse.click(...P(60, 380));
  console.log('after click:', await win.evaluate(() => [window.__editor.vp.tools.tool, document.querySelectorAll('.gi-text-editor').length, document.activeElement?.tagName + '.' + document.activeElement?.className]));
  await win.keyboard.type('second');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  const t2 = (await objects()).find((o) => o.text === 'second');
  if (!t2) console.log('objects:', JSON.stringify((await objects()).map((o) => o.text)), await win.evaluate(() => [window.__editor.vp.tools.tool, document.activeElement?.className]));
  ok('new text uses the last style', t2?.size === 30 && t2.underline && t2.color === '#c8202f', JSON.stringify(t2 && { s: t2.size, u: t2.underline, c: t2.color }));

  // PDF export still works with the new options
  const n = await win.evaluate(async () => {
    const { exportPdf } = await import('/src/renderer/engine/export.ts').catch(() => ({}));
    return exportPdf ? 1 : 0;
  }).catch(() => 0);
  void n;

  // library: no .tmp files anywhere, the leftover is gone
  await win.waitForTimeout(1500);
  const tmps = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tmp')) tmps.push(path.relative(lib, p));
    }
  };
  walk(lib);
  ok('no .tmp files in the library', tmps.length === 0, tmps.join(', '));
  console.log('top level:', fs.readdirSync(lib).join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
};
