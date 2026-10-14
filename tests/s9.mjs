import path from 'node:path';
export default async ({ win, shot }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.waitForTimeout(300);
  await shot('70-library-pdf-button');
  console.log('library button visible:', await win.getByRole('button', { name: 'Import PDF' }).first().isVisible());
  const id = await win.evaluate(() => window.__goodink.createNotebook({ title: 'Lecture notes', folderId: null, cover: { style: 'linen', color: '#2b59d9' }, template: { kind: 'ruled-college', paper: 'white' }, size: 'a4', landscape: false }));
  await win.waitForTimeout(1200);
  const at = await win.evaluate(([nb, p]) => window.__goodink.insertPdfIntoNotebook(nb, 0, p), [id, path.resolve('tests/fixtures/sample.pdf')]);
  await win.waitForTimeout(1500);
  const info = await win.evaluate(async (nb) => {
    const g = window.__goodink; const s = await g.getSession(nb);
    return { pages: s.pages.length, kinds: s.pages.map((p) => (p.bg ? 'pdf' + p.bg.page : p.template.kind)), search: s.searchDoc('Calvin').map((r) => r.pageNumber) };
  }, id);
  console.log('inserted at', at, JSON.stringify(info));
  await shot('71-editor-inserted');
  // undo removes the inserted pages in one step
  await win.keyboard.press('Control+z');
  await win.waitForTimeout(300);
  console.log('after undo pages:', await win.evaluate(async (nb) => (await window.__goodink.getSession(nb)).pages.length, id));
};
