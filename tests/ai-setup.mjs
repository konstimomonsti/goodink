// The free AI setup on a fresh install: node tests/drive-tauri.mjs tests/ai-setup.mjs
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.keyboard.press('Control+,');
  const ai = win.locator('.settings section', { has: win.getByRole('heading', { name: 'AI', exact: true }) });
  await ai.scrollIntoViewIfNeeded();
  // your real keys live in Windows Credential Manager; hide them from this test run only (nothing is deleted)
  await win.waitForTimeout(800);
  await win.evaluate(() => { const g = window.__goodink; g.updateSettings({ ai: { ...g.useApp.getState().settings.ai, keys: [] } }); });
  await win.waitForTimeout(300);
  console.log('free setup steps shown:', await ai.locator('.ai-quick-steps').isVisible(), '|', await ai.locator('.ai-quick').isVisible(), '| custom setup hidden:', !(await ai.locator('.ai-custom').isVisible()));
  await shot('ai-setup-01-free');
  await ai.getByRole('button', { name: /Customize/ }).click();
  console.log('custom setup after Customize:', await ai.locator('.ai-custom').isVisible());
  await shot('ai-setup-02-custom');
  // Ask AI with nothing set up offers the free setup right there
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: 'New', exact: true }).click();
  await win.getByRole('menuitem', { name: /^Notebook/ }).click();
  await win.locator('.modal input').first().fill('Fresh');
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.evaluate(() => { const g = window.__goodink; g.updateSettings({ ai: { ...g.useApp.getState().settings.ai, keys: [] } }); });
  await win.locator('.tb-ask:visible').click();
  await win.locator('.ask-panel').waitFor();
  console.log('ask panel offers free setup:', await win.locator('.ask-panel .ai-quick-steps').isVisible());
  await shot('ai-setup-03-ask');
};
