// The on-device math reader card in the Live check menu: "Download" without the model, "Installed"
// with it. GOODINK_HMER_DIR picks the models folder (an empty one for the first state).
//   SHOT=model-card-missing GOODINK_HMER_DIR=<empty dir> node tests/drive-tauri.mjs tests/live/model-card.mjs src-tauri/target/debug/goodink.exe
export default async ({ win, shot }) => {
  const { newNotebook } = await import('./handwriting.mjs');
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ live: { mode: 'smart', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Model');
  await win.locator('.live-pill').click();
  await win.locator('.live-model').waitFor({ timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(500);
  console.log('card:', (await win.locator('.live-model').innerText().catch(() => '(none)')).replace(/\n/g, ' | '));
  await shot(process.env.SHOT ?? 'model-card');
};
