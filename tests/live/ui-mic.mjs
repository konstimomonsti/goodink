// Touch long-press opens the card; mic recording with a live level meter; transcript lands in the box.
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--use-fake-device-for-media-stream --use-fake-ui-for-media-stream" \
//   node tests/drive-tauri.mjs tests/live/ui-mic.mjs src-tauri/target/debug/goodink.exe
import { openNotebook, pageBox, writeProblem, crop } from './ui-lib.mjs';

export default async ({ win, shot }) => {
  const dark = process.env.DARK === '1';
  const sfx = dark ? '-dark' : '';
  await openNotebook(win, { dark });
  const pb = await pageBox(win);
  const lines = await writeProblem(win, pb.x + 90, pb.y + 170);
  await win.waitForTimeout(1300);

  // long-press with a finger on the last line
  const cdp = await win.context().newCDPSession(win);
  const tx = (lines[2].x0 + lines[2].x1) / 2, ty = (lines[2].y0 + lines[2].y1) / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty, radiusX: 6, radiusY: 6, force: 0.5 }] });
  await win.waitForTimeout(470);
  await shot(`ui-30-longpress-pulse${sfx}`);
  await crop(win, `ui-30b-longpress-pulse-crop${sfx}`, { x: tx - 80, y: ty - 80, width: 160, height: 160 });
  await win.waitForTimeout(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await win.waitForTimeout(400);
  console.log('card after long-press:', await win.locator('.live-card').count());
  console.log('strokes after long-press:', await win.evaluate(() => window.__editor.vp.session.content(window.__editor.vp.session.pages[0].id).strokes.length));

  // mic
  // push-to-talk: hold the mic button
  const mb = await win.getByRole('button', { name: 'Hold to talk' }).boundingBox();
  await win.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await win.mouse.down();
  await win.waitForTimeout(1400);
  console.log('ring while listening:', await win.locator('.gi-live-mark.is-ring').count());
  const cb = await win.locator('.live-card').boundingBox();
  console.log('mic state:', await win.locator('.live-ask').getAttribute('class'));
  await crop(win, `ui-31-mic-recording${sfx}`, { x: cb.x - 20, y: cb.y + cb.height - 140, width: cb.width + 40, height: 160 });
  await win.mouse.up();
  await win.waitForTimeout(150);
  await crop(win, `ui-32-mic-transcribing${sfx}`, { x: cb.x - 20, y: cb.y + cb.height - 140, width: cb.width + 40, height: 160 });
  await win.waitForTimeout(900);
  await crop(win, `ui-33-mic-transcript${sfx}`, { x: cb.x - 20, y: cb.y + cb.height - 140, width: cb.width + 40, height: 160 });
  console.log('transcript:', await win.locator('.live-card textarea').inputValue());
};
