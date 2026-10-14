// Screenshots of the redesigned library and editor: node tests/drive-tauri.mjs tests/redesign.mjs
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.waitForTimeout(300);
  await shot('redesign-01-library-empty');

  for (const name of ['Chemistry', 'Thesis']) {
    await win.getByRole('button', { name: 'Folder', exact: true }).click();
    const input = win.locator('.modal input').first();
    await input.waitFor();
    await input.fill(name);
    await win.getByRole('button', { name: 'Save', exact: true }).click();
    await win.waitForTimeout(400);
  }
  for (const title of ['Organic Chemistry — Lecture 7', 'Morning pages', 'Meeting notes']) {
    await win.getByRole('button', { name: 'New', exact: true }).click();
    await win.getByRole('menuitem', { name: /Notebook/ }).click();
    await win.waitForTimeout(300);
    const name = win.locator('.modal input').first();
    await name.waitFor();
    await name.fill(title);
    await win.getByRole('button', { name: 'Create', exact: true }).click();
    await win.waitForTimeout(1200);
    await shot('redesign-02-editor');
    await win.getByRole('button', { name: 'Library' }).click();
    await win.waitForTimeout(500);
  }
  await shot('redesign-03-library');
  await win.getByRole('button', { name: /Open Organic/ }).first().click();
  await win.waitForTimeout(1200);
  await win.getByRole('button', { name: 'Page thumbnails' }).click();
  await win.waitForTimeout(500);
  await shot('redesign-04-editor-nav');
  await win.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await win.waitForTimeout(300);
  await shot('redesign-05-editor-dark');
  await win.getByRole('button', { name: 'Library' }).click();
  await win.waitForTimeout(400);
  await shot('redesign-06-library-dark');
};
