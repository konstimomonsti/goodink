// HMER smoke test in the real app: runtime + model load, one line through hmer_recognize.
//   GOODINK_HMER_DIR=<dir with p2t-mfr-1.5-int8/> node tests/drive-tauri.mjs tests/live/hmer-smoke.mjs src-tauri/target/debug/goodink.exe
// Skips (and says so) when the model is not installed locally: tests never download.
import { strokesFor } from './handwriting.mjs';

export default async ({ win }) => {
  const inv = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const st = await inv('hmer_status', { probe: true });
  console.log('status', JSON.stringify(st));
  const model = process.env.HMER_MODEL ?? st.defaultModel;
  if (!st.models.find((m) => m.id === model)?.installed) return console.log(`SKIP: ${model} not installed in ${st.dir}`);
  for (const ep of (process.env.HMER_EPS ?? 'cpu,dml').split(',')) {
    const warm = await inv('hmer_recognize', { req: { model, ep } }).catch((e) => ({ error: String(e) }));
    console.log(ep, 'warm', JSON.stringify(warm));
    if (warm.error) continue;
    for (const text of ['2x+3=7', String.raw`\frac{x+1}{x-1}=2`, 'x=2']) {
      const strokes = strokesFor(text, { size: 26, jitter: 0.5, seed: 3 }).map((s) => ({ pts: s.pts.flat() }));
      const r = await inv('hmer_recognize', { req: { strokes, model, ep, topK: 3 } });
      console.log(ep, text.padEnd(24), JSON.stringify(r.hyps.map((h) => [h.latex, +h.prob.toFixed(3), +h.logp.toFixed(2)])), `ms ${r.ms.toFixed(0)} (render ${r.renderMs.toFixed(0)} enc ${r.encMs.toFixed(0)} dec ${r.decMs.toFixed(0)} steps ${r.steps})`);
    }
  }
};
