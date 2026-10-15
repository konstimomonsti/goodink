// HMER vs InkAnalyzer in the real app: writes every math line of recog-corpus.mjs with synthetic pen
// input, then reads each line (as its own one-line block, so grouping errors don't count) with
//   ink  = the Windows InkAnalyzer backend + 2-D layout pass (live/recog/recognize.ts inkBackend)
//   hmer = the local model backend (live/recog/hmer.ts, src-tauri/src/hmer.rs)
//   fused = both, through makeRecognizer's confidence fusion
// and reports exact match on the linear text, top-k coverage and p50/p95 latency per line.
//   GOODINK_HMER_DIR=<models dir> node tests/drive-tauri.mjs tests/live/hmer-bench.mjs src-tauri/target/debug/goodink.exe
// Env: HMER_JITTERS=0.3,0.6  HMER_SEEDS=1  HMER_EP=cpu|dml  HMER_MODEL=p2t-mfr-1.5-int8  HMER_BEAM=5
// Results: tests/shots/hmer-bench.json. Skips when the model is not installed (tests never download).
import fs from 'node:fs';
import { newNotebook, writeText, clearPage, pageStrokes } from './handwriting.mjs';
import { corpus } from './recog-corpus.mjs';

const jitters = (process.env.HMER_JITTERS ?? '0.3,0.6').split(',').map(Number);
const seeds = (process.env.HMER_SEEDS ?? '1').split(',').map(Number);
const ep = process.env.HMER_EP ?? 'cpu';
const beam = Number(process.env.HMER_BEAM ?? 5);
const PER_PAGE = 8;

export default async ({ win }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  const st = await win.evaluate(() => window.__TAURI_INTERNALS__.invoke('hmer_status', { probe: true }));
  const model = process.env.HMER_MODEL ?? st.defaultModel;
  if (!st.models.find((m) => m.id === model)?.installed) return console.log(`SKIP: ${model} not installed in ${st.dir}`);
  await newNotebook(win, 'HMER bench');
  const warm = await win.evaluate(async ({ model, ep }) => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const R = await import('/live/recog/recognize.ts');
    const H = await import('/live/recog/hmer.ts');
    const { api } = await import('/lib/api.ts');
    const call = (s, o) => api.hmerRecognize(s, { ...o, model, ep });
    window.__hb = { R, H, api, call };
    const t = performance.now();
    await inv('ink_analyze', { req: { strokes: [] } });
    const t1 = performance.now();
    await inv('hmer_recognize', { req: { model, ep } });
    return { ink: t1 - t, hmer: performance.now() - t1 };
  }, { model, ep });
  console.log('warm-up ms', JSON.stringify(warm));

  const jobs = [];
  for (const jitter of jitters) for (const seed of seeds) for (const item of corpus.filter((c) => c.kind === 'math')) jobs.push({ ...item, jitter, seed });
  const rows = [];
  for (let p = 0; p < jobs.length; p += PER_PAGE) {
    const batch = jobs.slice(p, p + PER_PAGE);
    await clearPage(win);
    const groups = [];
    let seen = 0;
    for (let k = 0; k < batch.length; k++) {
      const j = batch[k];
      await writeText(win, j.write, { x: 60, y: 90 + k * 92, size: 24, jitter: j.jitter, seed: j.seed * 13 + Math.round(j.jitter * 10) });
      const { strokes } = await pageStrokes(win);
      groups.push(strokes.slice(seen).map((s) => s.id));
      seen = strokes.length;
    }
    const { pageId, strokes } = await pageStrokes(win);
    const res = await win.evaluate(
      async ({ pageId, strokes, groups, beam }) => {
        const { R, H, api, call } = window.__hb;
        const ss = strokes.map((s) => ({ ...s, pts: new Float32Array(s.pts) }));
        const map = new Map(ss.map((s) => [s.id, s]));
        const ink = R.inkBackend((st, o) => api.inkAnalyze(st, o));
        const hmer = H.hmerBackend(call, { topK: 5, beam });
        const out = [];
        for (const ids of groups) {
          const lineStrokes = ids.map((id) => map.get(id));
          const bb = lineStrokes.reduce((b, s) => [Math.min(b[0], s.bbox[0]), Math.min(b[1], s.bbox[1]), Math.max(b[2], s.bbox[2]), Math.max(b[3], s.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
          const line = { id: 'L' + ids[0], pageId, strokeIds: ids, bbox: bb };
          const block = { id: 'B' + ids[0], pageId, lines: [line], bbox: bb };
          const r = {};
          for (const [name, backends] of [['ink', [ink]], ['hmer', [hmer]], ['fused', [ink, hmer]]]) {
            const rec = R.makeRecognizer(backends); // fresh cache per run
            const t = performance.now();
            const b = await rec(block, map);
            const l = b.lines[0];
            r[name] = { ms: performance.now() - t, text: l.text, latex: l.latex, conf: l.confidence, alts: l.alternates, probs: l.alternateProbs ?? [], tokens: l.tokens.length, mapped: l.tokens.reduce((a, k) => a + k.strokeIds.length, 0) };
          }
          out.push(r);
        }
        return out;
      },
      { pageId, strokes, groups, beam },
    );
    batch.forEach((j, k) => rows.push({ ...j, ...Object.fromEntries(Object.entries(res[k]).map(([n, r]) => [n, { ...r, ok: r.text === j.expect, inTopK: r.text === j.expect || r.alts.includes(j.expect) }])) }));
    process.stdout.write('.');
  }
  console.log();
  const q = (a, f) => +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(1);
  const pct = (n, d) => ((100 * n) / Math.max(1, d)).toFixed(1) + '%';
  const summary = { lines: rows.length, model, ep, beam, warm };
  for (const n of ['ink', 'hmer', 'fused']) {
    const hi = rows.filter((r) => r[n].conf >= 0.9);
    summary[n] = {
      exact: pct(rows.filter((r) => r[n].ok).length, rows.length),
      topK: pct(rows.filter((r) => r[n].inTopK).length, rows.length),
      confident: `${pct(hi.length, rows.length)} of lines, ${pct(hi.filter((r) => r[n].ok).length, hi.length)} right`,
      p50: q(rows.map((r) => r[n].ms), 0.5),
      p95: q(rows.map((r) => r[n].ms), 0.95),
    };
  }
  for (const r of rows) if (!r.hmer.ok || !r.ink.ok) console.log(r.jitter, r.expect.padEnd(32), 'ink:', (r.ink.ok ? 'OK' : r.ink.text).padEnd(32), 'hmer:', r.hmer.ok ? 'OK' : r.hmer.text, r.hmer.conf.toFixed(2));
  console.log(JSON.stringify(summary, null, 2));
  fs.mkdirSync('tests/shots', { recursive: true });
  fs.writeFileSync('tests/shots/hmer-bench.json', JSON.stringify({ summary, rows }, null, 1));
};
