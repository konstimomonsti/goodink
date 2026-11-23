// OneNote import: node tests/drive-tauri.mjs tests/onenote.mjs src-tauri/target/debug/goodink.exe
// ONENOTE=<path to a .onetoc2, .onepkg or .one> picks the file (OneNote files are personal: none ship
// with the repo). Checks the folder/notebook tree, then opens the first notebook and shoots it.
export default async ({ win, shot }) => {
  const file = process.env.ONENOTE;
  if (!file) throw new Error('set ONENOTE to a OneNote file');
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await shot('onenote-0-home');

  const t0 = Date.now();
  const r = await win.evaluate((f) => window.__goodink.importOneNote(f, null), file);
  if (!r) throw new Error('import failed (see the toast)');
  console.log(`imported in ${Date.now() - t0} ms: ${r.notebooks.length} notebooks, top ${r.path}, warnings ${JSON.stringify(r.warnings)}`);
  const lib = await win.evaluate(() => window.__goodink.useApp.getState().library);
  for (const n of r.notebooks) {
    const m = lib.notebooks.find((x) => x.id === n.id);
    if (!m) throw new Error(`notebook ${n.title} missing from the library`);
    console.log(`  ${m.title}: ${m.pageCount} page(s), folder ${lib.folders.find((f) => f.id === m.folderId)?.title}, cover ${m.cover.color}`);
  }
  await win.waitForTimeout(500);
  await shot('onenote-1-toast');

  if (r.top) await win.evaluate((id) => window.__goodink.showSection('all', id), r.top);
  await win.waitForTimeout(800);
  await shot('onenote-2-folder');

  const first = r.notebooks[0];
  await win.evaluate((id) => window.__goodink.openNotebook(id), first.id);
  await win.waitForTimeout(4000);
  await shot('onenote-3-page');
};
