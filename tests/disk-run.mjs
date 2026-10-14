// The library on disk mirrors goodink's folders: node tests/disk-run.mjs
// Seeds a library the way goodink 2.x stored it (flat notebooks\<id>), then runs tests/disk.mjs on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'goodink-disk-'));
const now = Date.now();
const nb = (id, title, folderId, extra = {}) => ({ id, title, folderId, kind: 'notebook', cover: { style: 'solid', color: '#2f5b8a' }, favorite: false, pageCount: 1, firstPage: { w: 595, h: 842 }, createdAt: now - 1e6, updatedAt: now - 1e6, openedAt: 0, deletedAt: null, thumbVersion: 0, ...extra });
const library = {
  version: 1,
  folders: [{ id: 'f1', title: 'Physik', parentId: null, color: '#6c8eb5', createdAt: now - 1e6, updatedAt: now - 1e6, deletedAt: null }],
  notebooks: [nb('n1', 'Mechanik', 'f1'), nb('n2', 'Top: level?', null), nb('n3', 'Old', null, { deletedAt: now - 1000 })],
  links: [{ id: 'l1', kind: 'link', title: 'Ohmsches Gesetz', url: 'https://de.wikipedia.org/wiki/Ohmsches_Gesetz', folderId: 'f1', createdAt: now - 1e6, updatedAt: now - 1e6, openedAt: 0, deletedAt: null }],
};
fs.writeFileSync(path.join(lib, 'library.json'), JSON.stringify(library));
for (const id of ['n1', 'n2', 'n3']) {
  const dir = path.join(lib, 'notebooks', id);
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notebook.json'), JSON.stringify({ id, pages: [{ id: `${id}p1`, w: 595, h: 842, template: { kind: 'blank', paper: 'white' }, rotation: 0 }], outline: [], recordings: [], assets: {} }));
}
fs.writeFileSync(path.join(lib, 'study.json'), JSON.stringify({ v: 1, decks: [], cards: [], resources: [], revlog: [], imported: [] }));
console.log('library:', lib);
const r = spawnSync(process.execPath, ['tests/drive-tauri.mjs', 'tests/disk.mjs'], { env: { ...process.env, GI_LIB: lib }, stdio: 'inherit' });
process.exit(r.status ?? 1);
