export default async ({ win, shot }) => {
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true, theme: 'light' }));
  await win.evaluate(() => window.__goodink.openDialog({ type: 'new-notebook', folderId: null }));
  await win.waitForTimeout(300);
  const sel = win.locator('.newnb select');
  console.log('size options:', (await sel.locator('option').allInnerTexts()).join(' | '));
  await sel.selectOption('infinite');
  await win.waitForTimeout(200);
  await shot('93-new-size-infinite');
  console.log('orientation hidden for infinite:', (await win.getByRole('radiogroup', { name: 'Orientation' }).count()) === 0);
  await sel.selectOption('a4');
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.waitForTimeout(1500);
  // change this A4 page to an infinite canvas from the page layout dialog
  await win.evaluate(() => window.__goodink.openDialog({ type: 'template', nbId: window.__goodink.useApp.getState().active, scope: 'page' }));
  await win.waitForTimeout(400);
  const ps = win.locator('.layout-row select');
  console.log('layout options:', (await ps.locator('option').allInnerTexts()).join(' | '));
  await ps.selectOption('infinite');
  await shot('94-layout-dialog');
  await win.getByRole('button', { name: 'Apply' }).click();
  await win.waitForTimeout(800);
  const a = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return s.pages.map((p) => [Math.round(p.w), Math.round(p.h), !!p.infinite]); });
  // and to Letter landscape
  await win.evaluate(() => window.__goodink.openDialog({ type: 'template', nbId: window.__goodink.useApp.getState().active, scope: 'page' }));
  await win.waitForTimeout(300);
  await win.locator('.layout-row select').selectOption('letter');
  await win.getByRole('radio', { name: 'Landscape' }).click();
  await win.getByRole('button', { name: 'Apply' }).click();
  await win.waitForTimeout(800);
  const b = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return s.pages.map((p) => [Math.round(p.w), Math.round(p.h), !!p.infinite]); });
  console.log('A4 -> infinite:', JSON.stringify(a), ' -> Letter landscape:', JSON.stringify(b));
  await win.keyboard.press('Control+z');
  await win.waitForTimeout(300);
  const c = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return s.pages.map((p) => [Math.round(p.w), Math.round(p.h), !!p.infinite]); });
  console.log('undo ->', JSON.stringify(c));
};
