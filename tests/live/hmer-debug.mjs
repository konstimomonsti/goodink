// Saves the HMER model input images (tests/shots/hmer-in-*.png) and compares decoding settings.
import fs from 'node:fs';
import { strokesFor } from './handwriting.mjs';

export default async ({ win }) => {
  const inv = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const texts = (process.env.HMER_TEXTS ?? String.raw`2x+3=7|\frac{x+1}{x-1}=2|x=2`).split('|');
  const variants = JSON.parse(process.env.HMER_VARIANTS ?? '[{"beam":1,"topK":1},{"beam":1,"topK":1,"model":"p2t-mfr-1.5"},{"beam":5,"topK":3}]');
  for (const [i, text] of texts.entries()) {
    const strokes = strokesFor(text, { size: 26, jitter: 0.5, seed: 3 }).map((s) => ({ pts: s.pts.flat() }));
    for (const v of variants) {
      const r = await inv('hmer_recognize', { req: { strokes, debugPng: true, ...v } });
      if (r.debugPng) fs.writeFileSync(`tests/shots/hmer-in-${i}.png`, Buffer.from(r.debugPng));
      console.log(JSON.stringify(v), text.padEnd(24), JSON.stringify(r.hyps.map((h) => [h.latex, +h.logp.toFixed(2)])), `enc ${r.encMs.toFixed(0)} dec ${r.decMs.toFixed(0)} steps ${r.steps}`);
    }
  }
};
