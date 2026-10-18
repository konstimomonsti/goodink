// Replays a saved page (strokes JSON, e.g. from a user's notebook) through the real recogniser and the
// CAS, and prints the grouping and the readings. Debug exe + dev server:
//   PAGE=path/to/page.json node tests/drive-tauri.mjs tests/live/replay-page.mjs src-tauri/target/debug/goodink.exe
import fs from 'node:fs';
export default async ({ win, shot }) => {
  const page = JSON.parse(fs.readFileSync(process.env.PAGE, 'utf8'));
  const { newNotebook, pageOrigin } = await import('./handwriting.mjs');
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await win.waitForTimeout(1000);
  await win.evaluate(() => window.__goodink.updateSettings({ live: { mode: 'local', showTicks: true, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Replay');
  const { pageId } = await pageOrigin(win);
  const out = await win.evaluate(async ({ pid, strokes }) => {
    const model = await import('/engine/model.ts');
    const recog = await import('/live/recog/index.ts');
    const math = (await import('/live/math/index.ts')).math;
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    const st = strokes.map((j) => model.strokeFromJSON(j));
    const c = s.content(pid);
    s.commit(pid, { strokes: st, objects: c.objects });
    const map = new Map(st.map((x) => [x.id, x]));
    const blocks = recog.groupInk(pid, st);
    const res = [];
    for (const b of blocks) {
      const r = await recog.recognizeBlock(b, map);
      const chk = math.checkSteps(r.lines);
      res.push({ members: b.lines.map((l) => l.strokeIds.map((id) => map.get(id).bbox.map(Math.round).join(',')).join('  ')), bbox: b.bbox.map(Math.round), lines: r.lines.map((l, i) => `${l.text}  [${l.kind} ${l.confidence.toFixed(2)}] strokes=${b.lines[i].strokeIds.length} alts=${l.alternates.slice(0, 3).join('|')} -> ${chk.lines[i]?.verdict}`) });
    }
    return res;
  }, { pid: pageId, strokes: page.strokes });
  console.log(JSON.stringify(out, null, 1));
  await win.waitForTimeout(2500);
  await shot('replay-user');
};
