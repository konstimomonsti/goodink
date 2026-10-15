// Critic round 1: does the app process die while the live engine settles on fresh ink?
// node tests/drive-tauri.mjs tests/live/critic-r1-crash.mjs src-tauri/target/debug/goodink.exe
import { execSync } from 'node:child_process';
import { newNotebook, writeText } from './handwriting.mjs';
export default async ({ win }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Crash');
  win.on('close', () => console.log('PAGE CLOSED at', new Date().toISOString(), execSync('tasklist /FI "IMAGENAME eq goodink.exe"').toString().split('\n').filter((l) => /goodink/.test(l)).length, 'goodink processes'));
  win.on('crash', () => console.log('RENDERER CRASH'));
  for (let i = 0; i < 4; i++) {
    await writeText(win, '2x+3=7', { x: 80, y: 120 + i * 140, size: 24, seed: 1 + i });
    await writeText(win, '2x=4', { x: 80, y: 160 + i * 140, size: 24, seed: 2 + i });
    await writeText(win, 'x=3', { x: 80, y: 200 + i * 140, size: 24, seed: 3 + i });
    console.log('wrote', i, new Date().toISOString());
    await win.waitForTimeout(2500);
    console.log('alive', i, await win.locator('.gi-live-mark.is-error').count());
  }
};
