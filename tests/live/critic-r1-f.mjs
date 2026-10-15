// Critic round 1, scenario F: why do live results not show on the real engine, and why is "a=3"
// red? Dumps the engine's own reading of each block (separate LiveEngine instance, Local mode).
// node tests/drive-tauri.mjs tests/live/critic-r1-f.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText, pageOrigin } from './handwriting.mjs';
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Critic F');
  await win.waitForFunction(() => !!window.__editor?.vp, null, { timeout: 15000 });
  const { pageId } = await pageOrigin(win);
  await win.evaluate(async (pid) => {
    const m = await import('/live/engine.ts');
    const g = window.__goodink;
    const s = await g.getSession(g.useApp.getState().active);
    const e = new m.LiveEngine(s, { mode: 'local' });
    e.decorations(pid);
    window.__lt = { e, pid };
  }, pageId);
  await writeText(win, '12+5=', { x: 300, y: 120, size: 24, seed: 41 });
  await writeText(win, '7×8=', { x: 300, y: 220, size: 24, seed: 44 });
  await writeText(win, 'a=3', { x: 80, y: 320, size: 24, seed: 42 });
  await writeText(win, '2a+1=', { x: 80, y: 360, size: 24, seed: 43 });
  await win.waitForTimeout(3500);
  const dump = await win.evaluate(() => {
    const { e, pid } = window.__lt;
    return [[280, 90, 420, 130], [280, 190, 420, 230], [60, 290, 200, 370]].map((bb) => {
      const b = e.blockFor(pid, bb);
      const c = b && e.check(b.id);
      return { bb, lines: c?.recognition.lines.map((l) => `${l.text} [${l.kind} ${l.confidence.toFixed(2)}] alts=${(l.alternates ?? []).slice(0, 3).map((a) => a.text ?? a).join('|')}`), verdicts: c?.lines.map((l) => l.verdict), issues: c?.issues.map((i) => `${i.severity}/${i.source}: ${i.title}`), decos: e.decorations(pid).filter((d) => d.blockId === b?.id).map((d) => `${d.kind}:${d.text ?? d.title ?? ''}`) };
    });
  });
  console.log(JSON.stringify(dump, null, 1));
};
