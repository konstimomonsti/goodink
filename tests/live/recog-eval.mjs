// Recognition accuracy + latency in the real app:
//   node tests/drive-tauri.mjs tests/live/recog-eval.mjs src-tauri/target/debug/goodink.exe
// Writes the corpus (recog-corpus.mjs) with synthetic pen input at several jitters/seeds, groups and
// recognises it with the live recog module in the page (Windows ink recogniser through ink_analyze),
// and reports exact match, character error rate, calibration and latency. Results also go to
// tests/shots/recog-eval.json. Env: RECOG_JITTERS=0.3,0.6,0.9  RECOG_SEEDS=1,2
import fs from 'node:fs';
import { newNotebook, writeText, clearPage, pageStrokes } from './handwriting.mjs';
import { corpus } from './recog-corpus.mjs';

const jitters = (process.env.RECOG_JITTERS ?? '0.3,0.6,0.9').split(',').map(Number);
const seeds = (process.env.RECOG_SEEDS ?? '1,2').split(',').map(Number);
const PER_PAGE = 8;

function cer(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / Math.max(1, b.length);
}

export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await newNotebook(win, 'Recognition eval');
  // load the module through Vite and warm the recogniser
  const warm = await win.evaluate(async () => {
    const m = await import('/live/recog/index.ts');
    window.__recog = m;
    const t = performance.now();
    await window.__TAURI_INTERNALS__.invoke('ink_analyze', { req: { strokes: [] } });
    return performance.now() - t;
  });
  console.log('warm-up', warm.toFixed(0), 'ms');

  const jobs = [];
  for (const jitter of jitters) for (const seed of seeds) for (const item of corpus) jobs.push({ ...item, jitter, seed });
  const rows = [];
  for (let p = 0; p < jobs.length; p += PER_PAGE) {
    const batch = jobs.slice(p, p + PER_PAGE);
    await clearPage(win);
    for (let k = 0; k < batch.length; k++) {
      const j = batch[k];
      await writeText(win, j.write, { x: 60, y: 90 + k * 92, size: 24, jitter: j.jitter, seed: j.seed * 13 + Math.round(j.jitter * 10) });
    }
    if (p === 0) await shot('recog-eval-page');
    const { pageId, strokes } = await pageStrokes(win);
    const res = await win.evaluate(
      async ({ pageId, strokes }) => {
        const m = window.__recog;
        const ss = strokes.map((s) => ({ ...s, pts: new Float32Array(s.pts) }));
        const t0 = performance.now();
        const blocks = m.groupInk(pageId, ss);
        const groupMs = performance.now() - t0;
        const map = new Map(ss.map((s) => [s.id, s]));
        const out = [];
        for (const b of blocks) {
          const t = performance.now();
          const r = await m.recognizeBlock(b, map);
          const ms = performance.now() - t;
          out.push({ y: b.bbox[1], lines: r.lines.map((l, i) => ({ y: b.lines[i].bbox[1], ms: ms / r.lines.length, text: l.text, kind: l.kind, conf: l.confidence, alts: l.alternates, probs: l.alternateProbs ?? [] })), ms, n: r.lines.length });
        }
        return { blocks: out, groupMs };
      },
      { pageId, strokes },
    );
    // blocks come back top to bottom, one per written item when grouping is right
    const blocks = res.blocks.sort((a, b) => a.y - b.y);
    batch.forEach((j, k) => {
      const top = 90 + k * 92 - 30, bottom = top + 92;
      // lines (not blocks: stacked items may group into one block) whose top falls in this slot
      const lines = blocks.flatMap((b) => b.lines).filter((l) => l.y >= top && l.y < bottom);
      const got = lines.map((l) => l.text).join(' | ');
      const conf = lines.length ? Math.min(...lines.map((l) => l.conf)) : 0;
      const alts = lines[0]?.alts ?? [];
      const ai = alts.indexOf(j.expect);
      rows.push({ ...j, got, ok: got === j.expect, conf, cer: cer(got, j.expect), ms: lines.reduce((a, l) => a + l.ms, 0), pExp: got === j.expect ? conf : ai >= 0 ? lines[0].probs[ai] ?? 0 : 0, groupMs: res.groupMs });
    });
  }

  // latency split for one typical line: Windows recogniser time vs the whole round trip
  await clearPage(win);
  await writeText(win, 'x^2-4=(x-2)(x+2)', { x: 60, y: 120, size: 24, jitter: 0.5, seed: 9 });
  const probe = await win.evaluate(async (strokes) => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const req = { strokes: strokes.map((s) => ({ pts: s.pts })) };
    const out = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      const r = await inv('ink_analyze', { req });
      out.push([performance.now() - t, r.ms]);
    }
    return out;
  }, (await pageStrokes(win)).strokes);
  const math = rows.filter((r) => r.kind === 'math'), text = rows.filter((r) => r.kind === 'text');
  const pct = (a, b) => ((100 * a) / Math.max(1, b)).toFixed(1) + '%';
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
  for (const r of rows) if (!r.ok) console.log('XX', r.jitter, r.seed, r.conf.toFixed(2), r.expect.padEnd(30), r.got);
  const summary = {
    lines: rows.length,
    math: { n: math.length, exact: pct(math.filter((r) => r.ok).length, math.length), cer: (100 * mean(math.map((r) => r.cer))).toFixed(2) + '%' },
    text: { n: text.length, exact: pct(text.filter((r) => r.ok).length, text.length), cer: (100 * mean(text.map((r) => r.cer))).toFixed(2) + '%' },
    byJitter: Object.fromEntries(jitters.map((j) => [j, pct(math.filter((r) => r.jitter === j && r.ok).length, math.filter((r) => r.jitter === j).length)])),
    confident: (() => {
      const hi = math.filter((r) => r.conf >= 0.9);
      return { share: pct(hi.length, math.length), accuracy: pct(hi.filter((r) => r.ok).length, hi.length) };
    })(),
    calibration: [[0, 0.5], [0.5, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 1.01]].map(([lo, hi]) => {
      const b = math.filter((r) => r.conf >= lo && r.conf < hi);
      return { bin: `${lo}-${hi}`, n: b.length, accuracy: pct(b.filter((r) => r.ok).length, b.length) };
    }),
    topKCoverage: pct(math.filter((r) => r.pExp >= 0.1).length, math.length),
    latencyPerLineMs: { p50: +q(rows.map((r) => r.ms), 0.5).toFixed(1), p95: +q(rows.map((r) => r.ms), 0.95).toFixed(1) },
    groupInkMs: { p50: +q(rows.map((r) => r.groupMs), 0.5).toFixed(2) },
    warmUpMs: Math.round(warm),
    probeLine: { roundTripP50: +q(probe.map((x) => x[0]), 0.5).toFixed(1), recogniserP50: +q(probe.map((x) => x[1]), 0.5).toFixed(1) },
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync('tests/shots/recog-eval.json', JSON.stringify({ summary, rows }, null, 1));
};
