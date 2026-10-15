// Ask by voice: the toolbar mic opens the tutor only when asked.
// node tests/drive-tauri.mjs tests/live/voice-ask.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText } from './handwriting.mjs';
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Voice');
  await writeText(win, '2x+3=7', { x: 80, y: 140, size: 26, seed: 7 });
  await writeText(win, '2x=4', { x: 80, y: 190, size: 26, seed: 8 });
  await writeText(win, 'x=3', { x: 80, y: 240, size: 26, seed: 9 });
  await win.waitForTimeout(2500);
  const btn = win.getByRole('button', { name: 'Ask by voice' });
  console.log('mic button visible:', await btn.isVisible());
  console.log('cards open before asking:', await win.locator('.live-card').count());
  await shot('voice-01-toolbar');
  const box = await btn.boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.waitForTimeout(900);
  await shot('voice-02-listening');
  console.log('pop:', await win.locator('.live-voice-pop').innerText().catch(() => '(none)'));
  await win.mouse.up();
  await win.waitForTimeout(2500);
  await shot('voice-03-after');
  console.log('cards open after asking:', await win.locator('.live-card').count());
};
