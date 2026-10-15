// Critic round 1, scenario E: erase → do marks clear within one frame? (REAL engine, Local mode)
// node tests/drive-tauri.mjs tests/live/critic-r1-e.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText } from './handwriting.mjs';
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Critic E');
  await writeText(win, '2x+3=7', { x: 80, y: 120, size: 24, seed: 1 });
  await writeText(win, '2x=4', { x: 80, y: 160, size: 24, seed: 2 });
  await writeText(win, 'x=3', { x: 80, y: 200, size: 24, seed: 3 });
  await win.waitForTimeout(2500);
  console.log('errors before erase:', await win.locator('.gi-live-mark.is-error').count());
  // remove the strokes of line 3 (bbox bottom > 180) the way the eraser commits, then count frames
  const r = await win.evaluate(async () => {
    const g = window.__goodink, vp = window.__editor.vp;
    const s = await g.getSession(g.useApp.getState().active);
    const id = s.pages[vp.pageIndexNow].id;
    const c = s.content(id);
    const keep = c.strokes.filter((st) => st.bbox[1] < 180);
    const t0 = performance.now();
    s.commit(id, { ...c, strokes: keep });
    let frames = 0;
    return await new Promise((res) => {
      const tick = () => {
        frames++;
        const n = document.querySelectorAll('.gi-live-mark.is-error').length;
        if (n === 0 || frames > 120) res({ frames, ms: Math.round(performance.now() - t0), left: n, removed: c.strokes.length - keep.length });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  console.log('erase -> red gone:', JSON.stringify(r));
};
