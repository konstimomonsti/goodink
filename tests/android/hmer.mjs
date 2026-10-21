// The on-device math reader on Android: ONNX Runtime loads from the APK, the model downloads into
// app storage, and real pen ink (tests/fixtures/ink) is read line by line. Drives the app's debug
// WebView over the DevTools protocol (adb forward), so a debug APK must be running on the device/emulator.
//   node tests/android/hmer.mjs [fixture.json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const adb = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const sh = (...a) => execFileSync(adb, a, { encoding: 'utf8' });
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);

// the WebView's DevTools socket for goodink's process
const pid = sh('shell', 'pidof', 'app.goodink.notes').trim();
const sock = sh('shell', 'cat', '/proc/net/unix').split('\n').map((l) => l.trim().split(/\s+/).pop()).find((s) => s === `@webview_devtools_remote_${pid}`);
if (!sock) throw new Error('goodink is not running, or this is not a debug build');
sh('forward', 'tcp:9333', `localabstract:${sock.slice(1)}`);
// plain DevTools protocol: Playwright's connectOverCDP needs browser-level commands WebView lacks
const target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
};
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description ?? 'failed')) : resolve(m.result.result.value)));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
const invoke = (cmd, args) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

// 1. the runtime
const st = await invoke('hmer_status', { probe: true });
// runtime is a Rust Result: { Ok: <library> } or { Err: <why> }
ok('ONNX Runtime loads from the APK', !!st.runtime?.Ok, st.runtime?.Ok ?? st.runtime?.Err ?? JSON.stringify(st).slice(0, 160));

// 2. the model (120 MB, once)
let m = st.models.find((x) => x.id === st.defaultModel);
if (!m.installed) {
  const t0 = Date.now();
  await invoke('hmer_install', {});
  m = (await invoke('hmer_status', {})).models.find((x) => x.id === st.defaultModel);
  ok('the model downloads into app storage', m.installed, `${Math.round((Date.now() - t0) / 1000)} s`);
} else ok('the model is installed', true);

// 3. real pen ink, one line at a time (lines are the fixture's clear vertical bands)
const fx = JSON.parse(fs.readFileSync(process.argv[2] ?? 'tests/fixtures/ink/steps-fraction.json', 'utf8'));
const strokes = fx.strokes.map((s) => Array.from(new Float32Array(Uint8Array.from(Buffer.from(s.pts, 'base64')).buffer)));
const box = (p) => {
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < p.length; i += 3) (y0 = Math.min(y0, p[i])), (y1 = Math.max(y1, p[i]));
  return [y0, y1];
};
const items = strokes.map((p) => ({ p, b: box(p) })).sort((a, b) => a.b[0] - b.b[0]);
const lines = [];
for (const it of items) {
  const last = lines[lines.length - 1];
  if (last && it.b[0] < last.y1 - 4) (last.s.push(it.p), (last.y1 = Math.max(last.y1, it.b[1])));
  else lines.push({ s: [it.p], y1: it.b[1] });
}
console.log(fx.note);
for (const l of lines) {
  const t0 = Date.now();
  const r = await invoke('hmer_recognize', { req: { strokes: l.s.map((pts) => ({ pts })), topK: 3 } }).catch((e) => ({ error: String(e) }));
  const ms = Date.now() - t0;
  if (r.error) ok('a line is read', false, r.error);
  else console.log(`  ${r.hyps.map((h) => `${h.latex} (${h.prob.toFixed(2)})`).join('  |  ')}  [${ms} ms, ${r.ep ?? ''}]`);
}
ws.close();
