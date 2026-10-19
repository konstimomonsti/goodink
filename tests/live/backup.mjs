// Backing up a folder and the whole library: .gink (restored as a new folder with covers, colours
// and favourites, the originals untouched) and PDF (one file with bookmarks, or one per notebook).
//   node tests/drive-tauri.mjs tests/live/backup.mjs src-tauri/target/debug/goodink.exe
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFHexString } from 'pdf-lib';

export default async ({ win, shot }) => {
  const { writeText } = await import('./handwriting.mjs');
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'goodink-backup-'));
  win.on('response', (r) => r.status() >= 400 && console.log('HTTP', r.status(), r.url()));
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, live: { mode: 'off', showTicks: false, underlineUnsure: true, autoCheck: true } }));

  // Algebra/ (red) with Limits (favourite, red cover) and Week 1/Integrals (handwriting); Diary at the top
  const ids = await win.evaluate(async () => {
    const g = window.__goodink;
    const nb = (title, folderId, color) => g.createNotebook({ title, folderId, cover: { style: 'solid', color }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: false });
    const algebra = g.createFolder('Algebra', null);
    g.patchFolder(algebra, { color: '#c2410c' });
    const week = g.createFolder('Week 1', algebra);
    const limits = await nb('Limits', algebra, '#b91c1c');
    g.toggleFavorite(limits);
    await nb('Integrals', week, '#1d4ed8');
    await nb('Diary', null, '#15803d');
    return { algebra, week, limits };
  });
  // some ink in Integrals
  await win.evaluate(async () => {
    const g = window.__goodink;
    const id = g.useApp.getState().library.notebooks.find((n) => n.title === 'Integrals').id;
    await g.openNotebook(id);
  });
  await win.waitForTimeout(1200);
  await writeText(win, 'x^2 dx', { x: 100, y: 160, size: 34, seed: 2 });
  await win.waitForTimeout(400);
  await win.evaluate(() => window.__goodink.activateTab(null));
  await win.waitForTimeout(2500);

  // the dialog, for a folder and for everything, light and dark
  await win.evaluate((id) => window.__goodink.openDialog({ type: 'backup', folderId: id }), ids.algebra);
  await win.waitForTimeout(500);
  ok('the folder dialog counts what is inside', /2 notebooks · 1 folder/.test(await win.locator('.backup-summary').innerText()), await win.locator('.backup-summary').innerText());
  await shot('backup-01-folder-gink');
  await win.getByRole('radio', { name: /PDF/ }).click();
  await win.waitForTimeout(200);
  await shot('backup-02-folder-pdf');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__goodink.updateSettings({ theme: 'dark' }));
  await win.evaluate(() => window.__goodink.openDialog({ type: 'backup', folderId: null }));
  await win.waitForTimeout(500);
  ok('the library dialog counts everything', /3 notebooks · 2 folders/.test(await win.locator('.backup-summary').innerText()), await win.locator('.backup-summary').innerText());
  await shot('backup-03-everything-dark');
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.__goodink.updateSettings({ theme: 'light' }));

  // 1. the folder as .gink
  const ginkFolder = path.join(out, 'Algebra.gink');
  const bytes = await win.evaluate(([id, t]) => window.__goodink.backupTreeGink(id, t), [ids.algebra, ginkFolder]);
  ok('the folder backup is written', fs.existsSync(ginkFolder) && bytes > 0, `${fs.existsSync(ginkFolder) ? fs.statSync(ginkFolder).size : 0} bytes`);
  const before = await win.evaluate(() => window.__goodink.useApp.getState().library.notebooks.filter((n) => !n.deletedAt).length);
  await win.evaluate((f) => window.__goodink.importBackup(f), ginkFolder);
  await win.waitForTimeout(1500);
  const lib = await win.evaluate(() => window.__goodink.useApp.getState().library);
  const live = lib.notebooks.filter((n) => !n.deletedAt);
  ok('restoring adds the folder’s two notebooks', live.length === before + 2, `${before} → ${live.length}`);
  const copies = live.filter((n) => n.title === 'Limits');
  const copy = copies.find((n) => n.id !== ids.limits);
  ok('the restored notebook has a new id and keeps its cover and favourite', !!copy && copy.cover.color === '#b91c1c' && copy.favorite === true, JSON.stringify(copy && { cover: copy.cover, fav: copy.favorite }));
  const restoredTop = lib.folders.find((f) => f.id === copy?.folderId);
  ok('it lands in a new folder next to the original, with its colour', !!restoredTop && restoredTop.id !== ids.algebra && restoredTop.color === '#c2410c', restoredTop && `${restoredTop.title} ${restoredTop.color}`);
  const restoredWeek = lib.folders.find((f) => f.parentId === restoredTop?.id && f.title === 'Week 1');
  const integrals2 = live.find((n) => n.title === 'Integrals' && n.folderId === restoredWeek?.id);
  ok('subfolders and their notebooks come back', !!integrals2);
  ok('the original folder is untouched', lib.folders.find((f) => f.id === ids.algebra)?.title === 'Algebra' && live.some((n) => n.id === ids.limits && n.folderId === ids.algebra));
  const ink = integrals2 && (await win.evaluate(async (id) => {
    const s = await window.__goodink.getSession(id);
    const c = await s.ensure(s.pages[0].id);
    return c.strokes?.length ?? c.ink?.length ?? 0;
  }, integrals2.id));
  ok('the handwriting comes back', ink > 0, `${ink} strokes`);
  await win.evaluate(() => window.__goodink.showSection('all', null));
  await win.waitForTimeout(600);
  await shot('backup-04-restored');

  // 2. the whole library as .gink, restored as one folder
  const ginkAll = path.join(out, 'everything.gink');
  await win.evaluate((t) => window.__goodink.backupTreeGink(null, t), ginkAll);
  const n0 = (await win.evaluate(() => window.__goodink.useApp.getState().library.notebooks.filter((n) => !n.deletedAt).length));
  await win.evaluate((f) => window.__goodink.importBackup(f), ginkAll);
  await win.waitForTimeout(1500);
  const lib2 = await win.evaluate(() => window.__goodink.useApp.getState().library);
  const n1 = lib2.notebooks.filter((n) => !n.deletedAt).length;
  ok('restoring the library brings every notebook back once more', n1 === n0 * 2, `${n0} → ${n1}`);
  ok('…inside one new folder', lib2.folders.some((f) => /goodink library/.test(f.title) && f.parentId === null), lib2.folders.map((f) => f.title).join(', '));

  // 3. PDF: one file with bookmarks
  const onePdf = path.join(out, 'Algebra.pdf');
  const r1 = await win.evaluate(async ([id, t]) => {
    const m = await import('/library/backupPdf.ts');
    return m.treeToOnePdf(id, t, { includeAnnotations: true, includeTemplates: true });
  }, [ids.algebra, onePdf]);
  const doc = await PDFDocument.load(fs.readFileSync(onePdf));
  // the outline: Week 1 (a folder) and Limits at the top level of a single folder's PDF
  const outline = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
  const titles = [];
  for (let it = outline?.lookup(PDFName.of('First')); it; it = it.lookup(PDFName.of('Next'))) {
    titles.push(it.lookup(PDFName.of('Title'), PDFHexString).decodeText());
    for (let c = it.lookup(PDFName.of('First')); c; c = c.lookup(PDFName.of('Next'))) titles.push('  ' + c.lookup(PDFName.of('Title'), PDFHexString).decodeText());
  }
  ok('one PDF with every page of the folder', doc.getPageCount() === r1.pages && r1.notebooks === 2, `${doc.getPageCount()} pages, ${r1.notebooks} notebooks`);
  ok('…with bookmarks for folders and notebooks', titles.join('|') === 'Limits|Week 1|  Integrals' && String(doc.catalog.get(PDFName.of('PageMode'))) === '/UseOutlines', titles.join('|'));

  // 4. PDF: one per notebook, in folders
  const r2 = await win.evaluate(async ([t]) => {
    const m = await import('/library/backupPdf.ts');
    return m.treeToPdfFiles(null, t, { includeAnnotations: true, includeTemplates: true });
  }, [path.join(out, 'pdfs')]);
  const files = r2.files.map((f) => path.relative(path.join(out, 'pdfs'), f).replace(/\\/g, '/'));
  ok('one PDF per notebook in a tree like the library', files.includes('goodink library/Diary.pdf') && files.includes('goodink library/Algebra/Week 1/Integrals.pdf') && files.every((f) => fs.existsSync(path.join(out, 'pdfs', f))), files.slice(0, 6).join(' | '));
  const errors = await win.evaluate(() => window.__errors ?? []);
  ok('no errors', !errors.length, JSON.stringify(errors).slice(0, 200));
  console.log('out', out);
};
