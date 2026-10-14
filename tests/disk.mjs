// Scenario for tests/disk-run.mjs: goodink's folders are the folders on disk, both ways.
import fs from 'node:fs';
import path from 'node:path';

export default async ({ win, shot, lib }) => {
  const ok = (label, v) => console.log(`${v ? 'OK  ' : 'FAIL'} ${label}`);
  const has = (...p) => fs.existsSync(path.join(lib, ...p));
  const ls = (...p) => (fs.existsSync(path.join(lib, ...p)) ? fs.readdirSync(path.join(lib, ...p)).sort() : []);
  const g = (fn, arg) => win.evaluate(fn, arg);
  const state = () => g(() => window.__goodink.useApp.getState().library);
  const settle = async () => {
    await win.waitForTimeout(600);
    await g(() => window.__goodink.refreshFromDisk());
    await win.waitForTimeout(300);
  };

  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  // migration of the 2.x layout
  console.log('top level:', ls().join(' | '));
  ok('goodink files moved into .goodink', has('.goodink', 'library.json') && has('.goodink', 'study.json') && !has('library.json') && !has('notebooks'));
  ok('notebook in its folder: Physik/Mechanik.goodink', has('Physik', 'Mechanik.goodink', 'notebook.json'));
  ok('title made a valid name: "Top_ level_.goodink"', has('Top_ level_.goodink', 'notebook.json'));
  ok('link is a Windows shortcut', has('Physik', 'Ohmsches Gesetz.url') && fs.readFileSync(path.join(lib, 'Physik', 'Ohmsches Gesetz.url'), 'utf8').includes('URL=https://de.wikipedia.org/wiki/Ohmsches_Gesetz'));
  ok('trashed notebook in .goodink/trash', has('.goodink', 'trash', 'n3.goodink'));
  ok('folder id kept in a marker', fs.readFileSync(path.join(lib, 'Physik', '.goodink-folder'), 'utf8').trim() === 'f1');
  await shot('disk-01-files');

  // goodink → disk
  const chem = await g(() => window.__goodink.createFolder('Chemie', null));
  await settle();
  ok('new folder on disk', has('Chemie'));
  await g(([id]) => window.__goodink.moveItems(['n1'], id), [chem]);
  await settle();
  ok('moved notebook moved on disk', has('Chemie', 'Mechanik.goodink') && !has('Physik', 'Mechanik.goodink'));
  await g(([id]) => window.__goodink.patchFolder(id, { title: 'Chemie 1' }), [chem]);
  await settle();
  ok('renamed folder renamed on disk', has('Chemie 1', 'Mechanik.goodink') && !has('Chemie'));
  await g(() => window.__goodink.patchNotebook('n2', { title: 'Zusammenfassung' }));
  await settle();
  ok('renamed notebook renamed on disk', has('Zusammenfassung.goodink') && !has('Top_ level_.goodink'));
  // a notebook made now goes straight into its folder
  const made = await g(([id]) => window.__goodink.createNotebook({ title: 'Neu', folderId: id, cover: { style: 'solid', color: '#2f5b8a' }, template: { kind: 'blank', paper: 'white' }, size: 'a4', landscape: false, open: true }), [chem]);
  await settle();
  ok('new notebook in its folder', has('Chemie 1', 'Neu.goodink', 'notebook.json'));
  // writing still works after the notebook folder moved
  await win.getByRole('button', { name: 'Add page' }).first().click();
  await win.waitForTimeout(400);
  await g(([id]) => window.__goodink.moveItems([id], null), [made]);
  await settle();
  await win.getByRole('button', { name: 'Add page' }).first().click();
  await g(() => window.__goodink.flushAll());
  await win.waitForTimeout(500);
  const doc = JSON.parse(fs.readFileSync(path.join(lib, 'Neu.goodink', 'notebook.json'), 'utf8'));
  ok(`open notebook moved and kept writing: ${doc.pages.length} pages at top level`, doc.pages.length === 3 && !has('.goodink', 'staging', made));
  await win.getByRole('tab', { name: 'Files' }).click();

  // disk → goodink (as if done in Explorer)
  fs.mkdirSync(path.join(lib, 'Aus dem Explorer'));
  fs.writeFileSync(path.join(lib, 'Aus dem Explorer', 'Notizen.docx'), 'PK fake docx');
  fs.writeFileSync(path.join(lib, 'Aus dem Explorer', 'Video.url'), '[InternetShortcut]\r\nURL=https://www.youtube.com/watch?v=aircAruvnKk\r\n');
  fs.renameSync(path.join(lib, 'Physik'), path.join(lib, 'Physics'));
  fs.cpSync(path.join(lib, 'Zusammenfassung.goodink'), path.join(lib, 'Aus dem Explorer', 'Kopie.goodink'), { recursive: true });
  await settle();
  let L = await state();
  const fromExplorer = L.folders.find((f) => f.title === 'Aus dem Explorer');
  ok('folder made in Explorer appears', !!fromExplorer);
  ok('folder renamed in Explorer keeps its id', L.folders.find((f) => f.id === 'f1')?.title === 'Physics');
  ok('shortcut made in Explorer is a video link', L.links.some((x) => x.folderId === fromExplorer?.id && x.kind === 'youtube' && x.title === 'Video'));
  const copy = L.notebooks.find((n) => n.title === 'Kopie');
  ok(`notebook copied in Explorer gets its own id (${copy?.id})`, !!copy && copy.id !== 'n2' && copy.folderId === fromExplorer?.id);
  ok('other file listed', L.files.some((f) => f.name === 'Notizen.docx' && f.folderId === fromExplorer?.id));

  // the switch: notebooks only / all files
  await win.getByRole('button', { name: 'Open folder Aus dem Explorer' }).click();
  await win.getByRole('radio', { name: 'Notebooks' }).click();
  ok('Notebooks: no other files', (await win.locator('.file-card').count()) === 0);
  await win.getByRole('radio', { name: 'All files' }).click();
  ok('All files: Notizen.docx shown', (await win.locator('.file-card', { hasText: 'Notizen.docx' }).count()) === 1);
  await shot('disk-02-all-files');
  // rename a file in goodink
  await win.locator('.file-card', { hasText: 'Notizen.docx' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Rename' }).click();
  await win.locator('.modal input').fill('Protokoll.docx');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
  ok('file renamed on disk', has('Aus dem Explorer', 'Protokoll.docx') && !has('Aus dem Explorer', 'Notizen.docx'));
  // move the file into a folder by drag and drop of the card
  const target = await g(([p]) => window.__goodink.createFolder('Ablage', p), [fromExplorer.id]);
  await settle();
  await win.locator('.file-card', { hasText: 'Protokoll.docx' }).dragTo(win.locator('.folder-card', { hasText: 'Ablage' }));
  await settle();
  ok('file dragged into a folder moved on disk', has('Aus dem Explorer', 'Ablage', 'Protokoll.docx'));
  void target;

  // trash a folder with a file in it, restore it
  await g(([id]) => window.__goodink.trashItems([id]), [fromExplorer.id]);
  await settle();
  const inTrash = fs.readdirSync(path.join(lib, '.goodink', 'trash'), { recursive: true }).some((p) => String(p).endsWith('Protokoll.docx'));
  ok('trashed folder (with its file) in .goodink/trash', !has('Aus dem Explorer') && inTrash);
  L = await state();
  await g(([ids]) => window.__goodink.restoreItems(ids), [[fromExplorer.id, ...L.folders.filter((f) => f.deletedAt).map((f) => f.id), ...L.notebooks.filter((n) => n.deletedAt && n.id !== 'n3').map((n) => n.id), ...L.links.filter((x) => x.deletedAt).map((x) => x.id)]]);
  await settle();
  ok('restored with everything in it', has('Aus dem Explorer', 'Ablage', 'Protokoll.docx') && has('Aus dem Explorer', 'Kopie.goodink') && has('Aus dem Explorer', 'Video.url'));

  // deleted in Explorer: gone from goodink
  fs.rmSync(path.join(lib, 'Zusammenfassung.goodink'), { recursive: true });
  await settle();
  L = await state();
  ok('notebook deleted in Explorer is gone', !L.notebooks.some((n) => n.id === 'n2'));
  // deleted for good from the trash
  await g(() => window.__goodink.deleteForever(['n3'], true));
  await settle();
  ok('emptied from trash on disk', !has('.goodink', 'trash', 'n3.goodink'));
  await win.getByRole('button', { name: 'Files', exact: true }).first().click().catch(() => {});
  await shot('disk-03-end');
  console.log('final tree:', ls().join(' | '), '|| Aus dem Explorer:', ls('Aus dem Explorer').join(' | '));
};
