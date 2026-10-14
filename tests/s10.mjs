import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export default async ({ win, shot }) => {
  await win.waitForTimeout(1500);
  await shot('80-storage-prompt');
  console.log('prompt visible:', await win.getByText('Where should your notebooks be saved?').isVisible());
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-pick-'));
  const r = await win.evaluate((d) => window.gink.chooseLibrary(d), target);
  console.log('choose result', JSON.stringify(r), 'library.json copied:', fs.existsSync(path.join(r.path, 'library.json')) || fs.existsSync(path.join(r.path, 'notebooks')));
};
