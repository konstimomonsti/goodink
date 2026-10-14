// Attribute GPU-process memory: run the reading workload, then switch things off one by one.
import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const big = path.resolve('tests/fixtures/big.pdf');
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-attr-'));
const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-attrl-'));
const port = 9700 + Math.floor(Math.random() * 90);
const child = spawn('src-tauri/target/release/goodink.exe', [], {
  env: { ...process.env, GOODINK_TEST: '1', GOODINK_LIBRARY: lib, GOODINK_PROFILE: prof, GOODINK_CDP_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: path.join(prof, 'wv') },
  stdio: 'ignore',
});
let browser;
while (!browser) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
const win = browser.contexts()[0].pages()[0];
await win.waitForSelector('.sidebar');

const gpu = () => {
  const rows = JSON.parse(execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,CommandLine | ConvertTo-Json -Compress"', { maxBuffer: 1 << 27 }).toString());
  const kids = (pid) => rows.filter((r) => r.ParentProcessId === pid);
  const all = [];
  const walk = (pid) => kids(pid).forEach((k) => (all.push(k), walk(k.ProcessId)));
  walk(child.pid);
  const pick = (t) => Math.round(all.filter((r) => (r.CommandLine ?? '').includes(`--type=${t}`)).reduce((a, r) => a + r.PrivatePageCount, 0) / 1048576);
  return `gpu ${pick('gpu-process')} MB, renderer ${pick('renderer')} MB`;
};
const step = async (label, fn) => {
  if (fn) await win.evaluate(fn);
  await win.waitForTimeout(2500);
  console.log(label.padEnd(44), gpu());
};

await step('library only (empty)');
await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
await win.evaluate((p) => window.__goodink.importPdfFile(p), big);
await win.waitForSelector('.gi-page');
for (let i = 0; i < 40; i++) {
  await win.evaluate(() => (document.querySelector('.gi-scroller').scrollTop += document.querySelector('.gi-scroller').clientHeight * 0.9));
  await win.waitForTimeout(120);
}
await step('after reading 60 slides');
const cdp = await win.context().newCDPSession(win);
await step('after OS memory-pressure signal', async () => {});
await cdp.send('Memory.simulatePressureNotification', { level: 'critical' });
await step('  …critical pressure sent');
await step('back to library (notebook closed)', async () => { const g = window.__goodink; await g.closeTab(g.useApp.getState().active); });
await cdp.send('Memory.simulatePressureNotification', { level: 'critical' });
await step('  …critical pressure sent');
await browser.close().catch(() => {});
child.kill();
