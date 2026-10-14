// The Live Ink UI on the REAL engine (recogniser + CAS, Local mode, no AI): realistic pen handwriting,
// marks, the insight card, ghost-ink results.
// node tests/drive-tauri.mjs tests/live/ui-real.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText } from './handwriting.mjs';
import { crop } from './ui-lib.mjs';

export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Real engine');
  await win.waitForTimeout(800);
  await writeText(win, '2x+3=7', { x: 80, y: 120, size: 26, seed: 1 });
  await writeText(win, '2x=4', { x: 80, y: 160, size: 26, seed: 2 });
  await writeText(win, 'x=3', { x: 80, y: 200, size: 26, seed: 3 });
  await writeText(win, '12+5=', { x: 300, y: 120, size: 26, seed: 4 });
  await win.waitForTimeout(3000);
  await shot('ui-60-real-marks');
  console.log('marks:', await win.locator('.gi-live-mark').evaluateAll((m) => m.map((e) => e.getAttribute('class'))));
  console.log('pill:', await win.locator('.live-pill').getAttribute('aria-label'));
  const err = await win.locator('.gi-live-mark.is-error path, .gi-live-mark.is-unsure path').first().boundingBox().catch(() => null);
  const target = err ?? (await win.locator('.gi-page').first().boundingBox());
  const tx = err ? err.x + err.width / 2 : target.x + 140, ty = err ? err.y - 14 : target.y + 290;
  await win.keyboard.press('l');
  await win.mouse.click(tx, ty, { button: 'right' });
  await win.waitForTimeout(1200);
  const card = await win.locator('.live-card').boundingBox().catch(() => null);
  console.log('card:', !!card);
  if (card) await crop(win, 'ui-61-real-card', { x: card.x - 280, y: card.y - 20, width: card.width + 300, height: card.height + 40 });
  else await shot('ui-61-real-card');
};
