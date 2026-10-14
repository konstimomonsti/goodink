// Red-precision corpus: the release gate for red marks (docs/live-ink/ARCHITECTURE.md §A.2: >= 98%).
// Writes right and wrong algebra steps with synthetic handwriting (real pen events), runs the whole
// pipeline (InkAnalyzer recognition -> CAS -> Smart-mode AI judge + blind re-solve against the
// mock provider) and counts red marks:
//   precision = red on a wrong step / all red marks;  recall = wrong steps marked red / wrong steps.
// The mock AI is deliberately unreliable (it flags right steps as wrong and agrees by mistake at
// set rates), so the gate measures the pipeline's safeguards, not a perfect oracle.
//
//   node tests/drive-tauri.mjs tests/live/red-precision.mjs src-tauri/target/debug/goodink.exe
//   env: RP_LIMIT=10 (first n items), RP_JUDGE_FP=0.25, RP_VERIFY_FP=0.1, RP_SEED=1,
//        RP_CAS=off (the CAS decides nothing, so every step goes to the AI: tests the AI safeguards)
import { startMockAi } from './mock-ai.mjs';
import { newNotebook, writeText, pageOrigin, clearPage } from './handwriting.mjs';

// [previous line, step, step is wrong, what the mistake is]
const CORPUS = [
  ['2x+3=7', '2x=4', false],
  ['2x+3=7', '2x=10', true, 'sign-move'],
  ['2x=4', 'x=2', false],
  ['2x=4', 'x=8', true, 'inverse-operation'],
  ['3x-5=10', '3x=15', false],
  ['3x-5=10', '3x=5', true, 'sign-move'],
  ['3x=15', 'x=5', false],
  ['5x=20', 'x=15', true, 'inverse-operation'],
  ['4x+8=0', '4x=-8', false],
  ['4x+8=0', '4x=8', true, 'sign-move'],
  ['x+7=12', 'x=5', false],
  ['x+7=12', 'x=19', true, 'sign-move'],
  ['2(x+3)=10', '2x+6=10', false],
  ['2(x+3)=10', '2x+3=10', true, 'distribute-first-term'],
  ['x/2=6', 'x=12', false],
  ['x/2=6', 'x=3', true, 'inverse-operation'],
  ['6x-4=2x+8', '4x=12', false],
  ['6x-4=2x+8', '4x=4', true, 'sign-move'],
  ['3(x-2)=9', 'x-2=3', false],
  ['3(x-2)=9', '3x-2=9', true, 'distribute-first-term'],
  ['10-x=4', 'x=6', false],
  ['10-x=4', 'x=14', true, 'sign-move'],
  ['7x=21', 'x=3', false],
  ['7x=21', 'x=14', true, 'inverse-operation'],
  ['2x+5=x+9', 'x=4', false],
  ['2x+5=x+9', 'x=14', true, 'sign-move'],
  ['8+2x=14', '2x=6', false],
  ['8+2x=14', '2x=22', true, 'sign-move'],
  ['9x-9=0', 'x=1', false],
  ['9x-9=0', 'x=0', true, 'arithmetic'],
  ['5(x+1)=15', 'x+1=3', false],
  ['5(x+1)=15', '5x+1=15', true, 'distribute-first-term'],
  ['12=3x', 'x=4', false],
  ['12=3x', 'x=9', true, 'sign-move'],
  ['(x+1)^2', 'x^2+2x+1', false],
  ['(x+1)^2', 'x^2+1', true, 'square-of-sum'],
  ['x^2-9', '(x-3)(x+3)', false],
  ['x^2-9', '(x-3)^2', true, 'other'],
  ['4x=2', 'x=1/2', false],
  ['4x=2', 'x=2', true, 'inverse-operation'],
];

const norm = (s) => s.replace(/\s+/g, '').replace(/[−–]/g, '-').replace(/[×·]/g, '*');
function lev(a, b) {
  const p = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let d = p[0];
    p[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = p[j];
      p[j] = Math.min(p[j] + 1, p[j - 1] + 1, d + (a[i - 1] === b[j - 1] ? 0 : 1));
      d = t;
    }
  }
  return p[b.length];
}
/** deterministic noise per (item, what) */
function chance(seed, i, what) {
  let h = 2166136261 ^ seed;
  for (const c of `${i}|${what}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

export default async ({ win, shot }) => {
  const limit = Number(process.env.RP_LIMIT ?? CORPUS.length);
  const judgeFp = Number(process.env.RP_JUDGE_FP ?? 0.25); // a right step judged wrong
  const verifyFp = Number(process.env.RP_VERIFY_FP ?? 0.1); // the re-solve agrees wrongly
  const seed = Number(process.env.RP_SEED ?? 1);
  const casOff = process.env.RP_CAS === 'off';
  let cur = null; // the item being written: what the image "shows"
  const mock = await startMockAi();
  const which = (local) => (lev(local, norm(cur.prev)) <= lev(local, norm(cur.step)) ? 'prev' : 'step');
  mock.set({
    judge: (local) => {
      const w = which(local);
      const truth = norm(w === 'prev' ? cur.prev : cur.step);
      const corrected = truth !== local ? truth : '';
      let wrong = w === 'step' && cur.wrong;
      if (w === 'step' && !cur.wrong && chance(seed, cur.i, 'judge') < judgeFp) wrong = true;
      const ex = wrong ? { verdict: 'error', wrong_span: truth.split('=').pop() ?? '', title: 'Check this step', detail: 'This does not follow from the line above.', hint: 'Compare with the line above.', fix: '', misconception: cur.tag ?? 'other' } : { verdict: 'ok', wrong_span: '', title: '', detail: '', hint: '', fix: '', misconception: '' };
      return { reading_ok: !corrected, corrected, latex: truth, ...ex, concept: 'Linear equations' };
    },
    verify: (step) => {
      // the verifier reads the image too: a transcription that is not what is written is not ok
      const isStep = step === norm(cur.step), isPrev = step === norm(cur.prev);
      if (!isStep && !isPrev) return { readingOk: false, work: '', valid: 'unsure', reason: 'The transcription does not match.' };
      let valid = isStep && cur.wrong ? 'no' : 'yes';
      if (isStep && !cur.wrong && chance(seed, cur.i, 'verify') < verifyFp) valid = 'no';
      return { readingOk: true, work: '', valid, reason: '' };
    },
  });
  const rows = [];
  try {
    await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
    await newNotebook(win, 'Red precision');
    await win.evaluate((base) => {
      const g = window.__goodink;
      const st = g.useApp.getState().settings;
      g.updateSettings({ live: { ...(st.live ?? {}), mode: 'off' }, ai: { provider: 'ollama', models: { ollama: 'mock-vision' }, efforts: {}, baseURLs: { ollama: base }, keys: ['ollama'] } });
    }, mock.openaiBase);
    const { pageId } = await pageOrigin(win);
    await win.evaluate(async ([pid, off]) => {
      const m = await import('/live/engine.ts');
      const cas = (await import('/live/math/index.ts')).math;
      const g = window.__goodink;
      const s = await g.getSession(g.useApp.getState().active);
      // RP_CAS=off: a CAS that decides nothing (as for maths beyond its reach); it still answers
      // 'unsure' when the judge's corrected reading is checked
      const math = off ? { ...cas, checkSteps: (lines) => ({ lines: lines.map((l) => ({ lineId: l.lineId, verdict: 'unsure' })), issues: [] }) } : cas;
      window.__rp = { e: new m.LiveEngine(s, { mode: 'smart', kv: null, math }), pid };
      window.__rp.e.decorations(pid);
    }, [pageId, casOff]);

    for (let i = 0; i < Math.min(limit, CORPUS.length); i++) {
      const [prev, step, wrong, tag] = CORPUS[i];
      cur = { i, prev, step, wrong, tag };
      await clearPage(win);
      await win.waitForTimeout(120);
      const before = mock.calls.length;
      await writeText(win, prev, { x: 80, y: 140, size: 30, seed: 100 + i });
      await writeText(win, step, { x: 80, y: 200, size: 30, seed: 200 + i });
      // settle (600 ms) + checks + the 900 ms red floor, then until nothing is pending
      await win.waitForTimeout(1700);
      await win.waitForFunction(() => {
        const st = window.__rp.e.stats();
        return st.pending === 0 && st.state !== 'checking';
      }, null, { timeout: 20000, polling: 100 }).catch(() => {});
      await win.waitForTimeout(300);
      const r = await win.evaluate(() => {
        const { e, pid } = window.__rp;
        const b = e.blockFor(pid, [0, 100, 600, 260]);
        const c = b && e.check(b.id);
        const lines = b ? [...b.lines].sort((x, y) => x.bbox[1] - y.bbox[1]) : [];
        const decos = e.decorations(pid);
        const red = (l) => !!l && decos.some((d) => d.kind === 'error' && d.lineId === l.id);
        const issue = c?.issues.find((x) => x.severity === 'error');
        return {
          nLines: lines.length,
          readings: c ? c.recognition.lines.map((l) => l.text) : [],
          prevRed: red(lines[0]),
          stepRed: red(lines[lines.length - 1]) && lines.length > 1,
          amber: decos.some((d) => d.kind === 'unsure'),
          source: issue?.source ?? '',
        };
      });
      const row = { i, prev, step, wrong, ...r, calls: mock.calls.length - before };
      rows.push(row);
      const tagRes = r.stepRed ? (wrong ? 'TP' : 'FP') : wrong ? 'FN' : 'TN';
      console.log(`${String(i).padStart(2)} ${wrong ? 'wrong' : 'right'} ${prev} -> ${step}: ${tagRes}${r.prevRed ? ' +FP(prev line red)' : ''} | read ${JSON.stringify(r.readings)} via ${r.source || '-'}${r.amber ? ', amber' : ''}, ${row.calls} AI calls`);
    }
    const tp = rows.filter((r) => r.wrong && r.stepRed).length;
    const fp = rows.filter((r) => !r.wrong && r.stepRed).length + rows.filter((r) => r.prevRed).length;
    const wrongN = rows.filter((r) => r.wrong).length;
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = wrongN ? tp / wrongN : 0;
    const misread = rows.filter((r) => r.readings.length !== 2 || norm(r.readings[1] ?? '') !== norm(r.step)).length;
    const bySrc = (src) => rows.filter((r) => r.stepRed && r.source === src).length;
    console.log(`\nitems ${rows.length} (${wrongN} wrong), red ${tp + fp}: TP ${tp}, FP ${fp}`);
    console.log(`red precision ${(precision * 100).toFixed(1)}% (gate >= 98%), recall ${(recall * 100).toFixed(1)}%`);
    console.log(`red from the CAS ${bySrc('local-cas')}, from AI + blind re-solve ${bySrc('ai-verified')}; local misreads ${misread}/${rows.length}; CAS ${casOff ? 'off' : 'on'}; mock judge false-error rate ${judgeFp}, re-solve false-agree rate ${verifyFp}`);
    console.log(precision >= 0.98 ? 'GATE PASSED' : 'GATE FAILED');
    await shot('tutor-red-precision-last');
  } finally {
    await win.evaluate(() => window.__rp?.e.dispose()).catch(() => {});
    await mock.close();
  }
};
