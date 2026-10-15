// HMER symbol-inventory check on the math coverage corpus, typeset (not handwritten): every
// expression of tests/live/corpus/src-expr-*.mjs is rendered with KaTeX in the app's WebView,
// screenshotted black on white, and read by hmer_recognize (png input). Scored with the corpus
// normaliser, per area and per structure. The PNGs go to $HMER_PNG_DIR (if set) so other models can
// be scored on the same images offline.
//   GOODINK_HMER_DIR=<models> node tests/drive-tauri.mjs tests/live/hmer-printed.mjs src-tauri/target/debug/goodink.exe
// Env: HMER_MODEL, HMER_EP=cpu|dml, HMER_LIMIT=n, HMER_PNG_DIR. Results: tests/shots/hmer-printed.json.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalize, features } from './corpus/normalize.mjs';

async function loadCorpus() {
  const dir = path.resolve('tests/live/corpus');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => /^src-expr-.*\.mjs$/.test(f)).sort()) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    for (const part of Object.values(m))
      for (const [area, topics] of Object.entries(part))
        for (const [topic, body] of Object.entries(topics))
          for (const line of String(body).split('\n')) {
            const mm = /^([LAD]) (.+)$/.exec(line.trim());
            if (mm) out.push({ area, topic, check: mm[1], latex: mm[2] });
          }
  }
  return out;
}

export default async ({ win }) => {
  const items = (await loadCorpus()).slice(0, Number(process.env.HMER_LIMIT ?? 1e9));
  const st = await win.evaluate(() => window.__TAURI_INTERNALS__.invoke('hmer_status', { probe: true }));
  const model = process.env.HMER_MODEL ?? st.defaultModel;
  const ep = process.env.HMER_EP ?? 'cpu';
  if (!st.models.find((m) => m.id === model)?.installed) return console.log(`SKIP: ${model} not installed in ${st.dir}`);
  const pngDir = process.env.HMER_PNG_DIR;
  if (pngDir) fs.mkdirSync(pngDir, { recursive: true });
  await win.evaluate(async () => {
    const k = await import('/@fs/C:/Users/konst/Desktop/goodink/node_modules/katex/dist/katex.mjs');
    window.__katex = k.default;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/@fs/C:/Users/konst/Desktop/goodink/node_modules/katex/dist/katex.min.css';
    document.head.appendChild(css);
    const box = document.createElement('div');
    box.id = 'hmer-box';
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;padding:12px;font-size:28px;display:inline-block';
    document.body.appendChild(box);
    await new Promise((r) => setTimeout(r, 500));
  });
  await win.evaluate(({ model, ep }) => window.__TAURI_INTERNALS__.invoke('hmer_recognize', { req: { model, ep } }), { model, ep });
  const box = win.locator('#hmer-box');
  const rows = [];
  for (const [i, it] of items.entries()) {
    const ok = await win.evaluate((tex) => {
      try {
        window.__katex.render(tex, document.getElementById('hmer-box'), { displayMode: true, throwOnError: true });
        return true;
      } catch {
        return false;
      }
    }, it.latex);
    if (!ok) continue;
    const png = await box.screenshot();
    if (pngDir) fs.writeFileSync(path.join(pngDir, `${i}.png`), png);
    const t = Date.now();
    const r = await win.evaluate(({ png, model, ep }) => window.__TAURI_INTERNALS__.invoke('hmer_recognize', { req: { png, model, ep, topK: 3, beam: 3 } }), { png: [...png], model, ep });
    const ms = Date.now() - t;
    const want = normalize(it.latex);
    const got = r.hyps.map((h) => {
      try {
        return normalize(h.latex);
      } catch {
        return h.latex;
      }
    });
    rows.push({ i, ...it, feats: features(it.latex), got: r.hyps[0]?.latex ?? '', ok: got[0] === want, topK: got.includes(want), ms, enc: r.encMs, dec: r.decMs });
    if (i % 25 === 0) process.stdout.write(`${i} `);
  }
  console.log();
  const table = (key) => {
    const g = {};
    for (const r of rows) for (const k of key(r)) (g[k] ??= []).push(r);
    return Object.fromEntries(Object.entries(g).map(([k, rs]) => [k, { n: rs.length, exact: +((100 * rs.filter((r) => r.ok).length) / rs.length).toFixed(1), topK: +((100 * rs.filter((r) => r.topK).length) / rs.length).toFixed(1) }]));
  };
  const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
  const summary = {
    model, ep, n: rows.length,
    exact: +((100 * rows.filter((r) => r.ok).length) / rows.length).toFixed(1),
    topK: +((100 * rows.filter((r) => r.topK).length) / rows.length).toFixed(1),
    p50: q(rows.map((r) => r.ms), 0.5), p95: q(rows.map((r) => r.ms), 0.95),
    byArea: table((r) => [r.area]),
    byFeature: table((r) => (r.feats.length ? r.feats : ['plain'])),
  };
  console.log(JSON.stringify(summary, null, 1));
  fs.mkdirSync('tests/shots', { recursive: true });
  fs.writeFileSync(`tests/shots/hmer-printed-${model}.json`, JSON.stringify({ summary, rows }, null, 1));
};
