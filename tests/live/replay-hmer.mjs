// Reads every line of a saved page (real pen ink) with the local math model and with the Windows
// recogniser, side by side. Needs the model files (GOODINK_HMER_DIR) and the dev server.
//   PAGE=page.json GOODINK_HMER_DIR=<models> node tests/drive-tauri.mjs tests/live/replay-hmer.mjs src-tauri/target/debug/goodink.exe
import fs from 'node:fs';
export default async ({ win }) => {
  const page = JSON.parse(fs.readFileSync(process.env.PAGE, 'utf8'));
  const { newNotebook, pageOrigin } = await import('./handwriting.mjs');
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(800);
  await win.evaluate(() => window.__goodink.updateSettings({ live: { mode: 'off', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'HMER replay');
  const { pageId } = await pageOrigin(win);
  const out = await win.evaluate(async ({ pid, strokes, model }) => {
    const modelM = await import('/engine/model.ts');
    const recog = await import('/live/recog/index.ts');
    const { api } = await import('/lib/api.ts');
    const st = strokes.map((j) => modelM.strokeFromJSON(j));
    const map = new Map(st.map((x) => [x.id, x]));
    const res = [];
    for (const b of recog.groupInk(pid, st)) {
      const ink = await recog.recognizeBlock(b, map);
      for (const [i, line] of b.lines.entries()) {
        const pts = line.strokeIds.map((id) => map.get(id).pts);
        const t0 = performance.now();
        let h;
        try {
          h = await api.hmerRecognize(pts, { model, topK: 3 });
        } catch (e) {
          h = { error: String(e) };
        }
        res.push({ windows: ink.lines[i].text, model: h.hyps ? h.hyps.map((x) => `${x.latex} (${x.prob.toFixed(2)})`) : h.error, ms: Math.round(performance.now() - t0) });
      }
    }
    return res;
  }, { pid: pageId, strokes: page.strokes, model: process.env.HMER_MODEL ?? 'p2t-mfr-1.5' });
  for (const r of out) console.log(`windows: ${r.windows.padEnd(16)} | model: ${Array.isArray(r.model) ? r.model.join('  |  ') : r.model}  [${r.ms} ms]`);
};
