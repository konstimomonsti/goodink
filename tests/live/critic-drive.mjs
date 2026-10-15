// Critic copy of drive-tauri.mjs that keeps the exe's stdout/stderr and exit code (crash hunting).
// Test harness for the Tauri build: starts goodink.exe with a scratch library and a DevTools port
// on its WebView2, connects Playwright over CDP and runs a scenario file (same API as drive.mjs).
// usage: node tests/drive-tauri.mjs <scenario.mjs> [path\to\goodink.exe]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const exe = process.argv[3] ?? 'src-tauri/target/release/goodink.exe';
const lib = process.env.GI_LIB ?? fs.mkdtempSync(path.join(os.tmpdir(), 'goodink-lib-'));
const profile = process.env.GOODINK_PROFILE ?? fs.mkdtempSync(path.join(os.tmpdir(), 'goodink-prof-'));
const port = 9300 + Math.floor(Math.random() * 500);
const env = { ...process.env, GOODINK_TEST: '1', GOODINK_PROFILE: profile, GOODINK_CDP_PORT: String(port) };
if (!process.env.NO_LIB) env.GOODINK_LIBRARY = lib;
// a private WebView2 data folder per run, so runs never share state with each other or the user
env.WEBVIEW2_USER_DATA_FOLDER = path.join(profile, 'webview');

const child = spawn(exe, [], { env: { ...env, RUST_BACKTRACE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (d) => process.stdout.write('[exe] ' + d)); child.stderr.on('data', (d) => process.stdout.write('[exe-err] ' + d)); child.on('exit', (c, s) => console.log('[exe] EXIT code', c, 'signal', s, c != null ? '0x' + (c >>> 0).toString(16) : ''));
let browser;
for (let i = 0; i < 100 && !browser; i++) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (!browser) {
  console.error('could not connect to WebView2');
  child.kill();
  process.exit(1);
}
const ctx = browser.contexts()[0];
let win = ctx.pages().find((p) => !p.url().includes('#present'));
for (let i = 0; !win && i < 50; i++) {
  await new Promise((r) => setTimeout(r, 100));
  win = ctx.pages().find((p) => !p.url().includes('#present'));
}
const logs = [];
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.gink, null, { timeout: 15000 });
const shot = (n) => win.screenshot({ path: `tests/shots/${n}.png` });
const app = { close: async () => { await browser.close().catch(() => {}); child.kill(); } };
const scenario = await import(pathToFileURL(path.resolve(process.argv[2])).href);
try {
  await scenario.default({ app, win, shot, lib, browser, profile });
} catch (e) {
  console.error('SCENARIO FAILED', e);
  await shot('failure').catch(() => {});
} finally {
  console.log(logs.slice(-40).join('\n'));
  await browser.close().catch(() => {});
  child.kill();
}
