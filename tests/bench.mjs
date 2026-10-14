// Performance benchmark: Electron 1.4.0 (baseline) vs the current Tauri build.
//   start  = launch → interactive library (warm profile, average of RUNS)
//   memory = whole process tree after importing a 60-slide PDF and paging through all of it
// usage: node tests/bench.mjs [--tauri-only]
import { _electron as electron, chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNS = 3;
const big = path.resolve('tests/fixtures/big.pdf');
const eProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-e-prof-'));
const tProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-t-prof-'));
const TAURI = 'src-tauri/target/release/goodink.exe';
const ELECTRON = 'builds/1.4.0/win-unpacked/goodink.exe';

function tree(rootPid) {
  const rows = JSON.parse(
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,CommandLine,Name | ConvertTo-Json -Compress"', { maxBuffer: 1 << 27 }).toString(),
  );
  const kids = new Map();
  for (const r of rows) (kids.get(r.ParentProcessId) ?? kids.set(r.ParentProcessId, []).get(r.ParentProcessId)).push(r);
  const out = { total: 0, byType: {} };
  const walk = (pid) => {
    const me = rows.find((r) => r.ProcessId === pid);
    if (me) {
      const t = /--type=([\w-]+)/.exec(me.CommandLine ?? '')?.[1] ?? (me.Name.startsWith('msedgewebview2') ? 'browser' : 'app');
      const mb = me.PrivatePageCount / 1048576;
      out.total += mb;
      out.byType[t] = Math.round((out.byType[t] ?? 0) + mb);
    }
    for (const k of kids.get(pid) ?? []) walk(k.ProcessId);
  };
  walk(rootPid);
  out.total = Math.round(out.total);
  return out;
}

async function workload(win) {
  await win.evaluate(() => window.__goodink.updateSettings({ onboarded: true }));
  await win.evaluate((p) => window.__goodink.importPdfFile(p), big);
  await win.waitForSelector('.gi-page');
  await win.waitForTimeout(1500);
  // page through the whole deck like a reader would
  for (let i = 0; i < 40; i++) {
    await win.evaluate(() => {
      const sc = document.querySelector('.gi-scroller');
      sc.scrollTop += sc.clientHeight * 0.9;
    });
    await win.waitForTimeout(120);
  }
  await win.waitForTimeout(3000);
  return win.evaluate(() => ({
    canvasMpx: Math.round([...document.querySelectorAll('canvas')].reduce((a, c) => a + c.width * c.height, 0) / 1e5) / 10,
    jsHeapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
    pdfCache: window.__goodink.pdfCacheStats?.() ?? null,
  }));
}

async function runElectron() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-bench-'));
  const t0 = performance.now();
  const app = await electron.launch({ executablePath: ELECTRON, env: { ...process.env, GOODINK_TEST: '1', GOODINK_LIBRARY: lib, GOODINK_PROFILE: eProfile } });
  const win = await app.firstWindow();
  await win.waitForSelector('.sidebar');
  const start = Math.round(performance.now() - t0);
  const inner = await workload(win);
  const mem = tree(app.process().pid);
  await app.close();
  return { start, mem, ...inner };
}

async function runTauri() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-bench-'));
  const port = 9800 + Math.floor(Math.random() * 100);
  const t0 = performance.now();
  const child = spawn(TAURI, [], {
    env: { ...process.env, GOODINK_TEST: '1', GOODINK_LIBRARY: lib, GOODINK_PROFILE: tProfile, GOODINK_CDP_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: path.join(tProfile, 'wv') },
    stdio: 'ignore',
  });
  let browser;
  while (!browser) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  const win = browser.contexts()[0].pages()[0];
  await win.waitForSelector('.sidebar');
  // the app itself records when the library became interactive (process start → first paint)
  const appStart = await win.evaluate(() => window.__bootMs ?? null);
  const start = Math.round(performance.now() - t0);
  const inner = await workload(win);
  const mem = tree(child.pid);
  await win.waitForTimeout(30000); // idle: the app trims itself
  const idle = tree(child.pid);
  await browser.close().catch(() => {});
  child.kill();
  return { start, appStart, mem, idle, ...inner };
}

const tauriOnly = process.argv.includes('--tauri-only');
const res = { electron: [], tauri: [] };
if (!tauriOnly) await runElectron();
await runTauri(); // warm-up, not counted
for (let i = 0; i < RUNS; i++) {
  if (!tauriOnly) res.electron.push(await runElectron());
  res.tauri.push(await runTauri());
}
const avg = (a, f) => Math.round(a.reduce((s, r) => s + f(r), 0) / a.length);
for (const [name, rs] of Object.entries(res)) {
  if (!rs.length) continue;
  const last = rs[rs.length - 1];
  console.log(
    `${name.padEnd(8)} start ${avg(rs, (r) => r.start)} ms${rs[0].appStart != null ? ` (in-app ${avg(rs, (r) => r.appStart)} ms)` : ''} | memory ${avg(rs, (r) => r.mem.total)} MB${rs[0].idle ? ` (idle ${avg(rs, (r) => r.idle.total)} MB)` : ''} | canvases ${last.canvasMpx} Mpx | JS heap ${last.jsHeapMB} MB | pdf cache ${JSON.stringify(last.pdfCache)} | by process ${JSON.stringify(last.mem.byType)}`,
  );
}
