// What a touchpad pinch does in this build: node tests/drive-tauri.mjs tests/pinch.mjs [exe]
export default async ({ win }) => {
  const cdp = await win.context().newCDPSession(win);
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.getByRole('button', { name: 'New', exact: true }).click();
  await win.getByRole('menuitem', { name: /^Notebook/ }).click();
  await win.locator('.modal input').first().fill('Pinch');
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.locator('.zoom-val:visible').waitFor();
  await win.evaluate(() => {
    window.__wheels = [];
    window.addEventListener('wheel', (e) => window.__wheels.push({ ctrl: e.ctrlKey, dy: Math.round(e.deltaY) }), { capture: true, passive: true });
  });
  const box = await win.locator('.ed-canvas:visible').boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (const scaleFactor of [0.5, 1.8]) {
    const before = await win.locator('.zoom-val:visible').innerText();
    await cdp.send('Input.synthesizePinchGesture', { ...at, scaleFactor, gestureSourceType: 'mouse' });
    await win.waitForTimeout(500);
    const w = await win.evaluate(() => window.__wheels.splice(0));
    console.log(`pinch ${scaleFactor}: page zoom ${before} → ${await win.locator('.zoom-val:visible').innerText()} | window zoom ${await win.evaluate(() => window.visualViewport.scale)} | wheel events ${w.length} (ctrl ${w.filter((x) => x.ctrl).length})`);
  }
  // Ctrl+wheel straight from the mouse, for comparison
  await win.mouse.move(at.x, at.y);
  await win.keyboard.down('Control');
  await win.mouse.wheel(0, 300);
  await win.keyboard.up('Control');
  await win.waitForTimeout(300);
  console.log('ctrl+wheel down: page zoom', await win.locator('.zoom-val:visible').innerText());
};
