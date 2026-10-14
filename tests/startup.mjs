// Fair startup comparison: OS process creation → the engine's own "largest contentful paint" of the
// library (timestamps from Windows and from Chromium, so the test harness adds nothing).
// usage: node tests/startup.mjs [runs]
import { _electron as electron, chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNS = Number(process.argv[2] ?? 5);
const TAURI = 'src-tauri/target/release/goodink.exe';
const ELECTRON = 'builds/1.4.0/win-unpacked/goodink.exe';
const eProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-se-'));
const tProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-st-'));

const created = (pid) =>
  Number(execSync(`powershell -NoProfile -Command "[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()"`).toString().trim());

// Electron 1.4 cannot be instrumented: the harness is attached from launch and stamps the moment the
// library appears (if anything this over-counts Electron by a frame or two).
async function harnessEpoch(win) {
  await win.waitForSelector('.sidebar', { timeout: 30000 });
  return win.evaluate(() => Date.now());
}
// The Tauri build stamps its own first library frame (requestAnimationFrame after render).
async function appEpoch(win) {
  await win.waitForFunction(() => window.__paintEpoch, null, { timeout: 30000 });
  return win.evaluate(() => window.__paintEpoch);
}

async function electronOnce() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-sl-'));
  const app = await electron.launch({ executablePath: ELECTRON, env: { ...process.env, GOODINK_TEST: '1', GOODINK_LIBRARY: lib, GOODINK_PROFILE: eProfile } });
  const win = await app.firstWindow();
  const t = (await harnessEpoch(win)) - created(app.process().pid);
  await app.close();
  return Math.round(t);
}

async function tauriOnce() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-sl-'));
  const port = 9600 + Math.floor(Math.random() * 90);
  const child = spawn(TAURI, [], {
    env: { ...process.env, GOODINK_TEST: '1', GOODINK_LIBRARY: lib, GOODINK_PROFILE: tProfile, GOODINK_CDP_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: path.join(tProfile, 'wv') },
    stdio: 'ignore',
  });
  let browser;
  while (!browser) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  const win = browser.contexts()[0].pages()[0];
  const paint = await appEpoch(win);
  const pc = created(child.pid);
  const t = paint - pc;
  const tl = await win.evaluate(() => window.__timeline);
  if (process.env.PAGE) console.log('  page:', JSON.stringify(await win.evaluate(() => {
    const m = (n) => Math.round(performance.getEntriesByName(n)[0]?.startTime ?? -1);
    const res = performance.getEntriesByType('resource').map((r) => `${r.name.split('/').pop().slice(0, 18)} ${Math.round(r.startTime)}→${Math.round(r.responseEnd)}`);
    const nav = performance.getEntriesByType('navigation')[0];
    return { htmlDone: Math.round(nav.responseEnd), domInteractive: Math.round(nav.domInteractive), mainStart: m('gi-main'), bootCall: m('gi-boot-call'), bootData: m('gi-boot-data'), res };
  })));
  if (process.env.TIMELINE) console.log('  window on screen', tl.shown - pc, 'ms |  exe→main', tl.main - pc, '| main→setup', tl.setup - tl.main, '| setup→window', tl.built - tl.setup, '| window→page start', tl.navigation - tl.built, '| page→data', tl.bootData - tl.navigation, '| data→paint', paint - tl.bootData);
  await browser.close().catch(() => {});
  child.kill();
  return Math.round(t);
}

await electronOnce();
await tauriOnce(); // warm-up (first launch builds caches), not counted
const e = [], t = [];
for (let i = 0; i < RUNS; i++) {
  e.push(await electronOnce());
  t.push(await tauriOnce());
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`electron runs ${JSON.stringify(e)} → median ${med(e)} ms`);
console.log(`tauri    runs ${JSON.stringify(t)} → median ${med(t)} ms`);
