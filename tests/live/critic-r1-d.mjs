// Critic round 1, scenario D: REAL engine in Smart mode against the mock AI provider (keyless
// 'ollama' pointed at tests/live/mock-ai.mjs). Card Ask before any hint (is the guard in the
// prompt?), AI hint, the AI selector: loop → glow → chip latency, card placement vs ink, the
// "Solve step by step" chip over wrong work, pin.
// node tests/drive-tauri.mjs tests/live/critic-r1-d.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText, pageOrigin } from './handwriting.mjs';
import { startMockAi } from './mock-ai.mjs';

const P = 'critic-r1-';

export default async ({ win, shot }) => {
  const mock = await startMockAi({ latency: 300 });
  try {
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await win.waitForTimeout(1200);
    await win.evaluate((base) => window.__goodink.updateSettings({ holdToShape: false, onboarded: true, live: { mode: 'smart', showTicks: false, underlineUnsure: true, autoCheck: true }, ai: { provider: 'ollama', models: { ollama: 'mock-vision' }, efforts: {}, baseURLs: { ollama: base }, keys: ['ollama'] } }), mock.openaiBase);
    await newNotebook(win, 'Critic D');
    const o = await pageOrigin(win);
    const cl = (x, y) => [o.left + (x - o.ox) * o.zoom, o.top + (y - o.oy) * o.zoom];
    await writeText(win, '2x+3=7', { x: 80, y: 120, size: 24, seed: 1 });
    await writeText(win, '2x=4', { x: 80, y: 160, size: 24, seed: 2 });
    const l3 = await writeText(win, 'x=3', { x: 80, y: 200, size: 24, seed: 3 });
    await win.waitForTimeout(3500);
    console.log('pill:', await win.locator('.live-pill').getAttribute('aria-label').catch(() => null), 'marks', await win.locator('.gi-live-mark.is-error').count());
    console.log('AI calls after writing:', JSON.stringify(mock.calls.map((c) => c.kind)));
    await shot(P + 'd1-smart-marks');
    const [c3x, c3y] = cl(l3.bbox[2] - 5, (l3.bbox[1] + l3.bbox[3]) / 2);
    await win.mouse.click(c3x, c3y, { button: 'right' });
    await win.locator('.live-card').waitFor({ timeout: 3000 });
    await win.waitForTimeout(400);
    // Ask before any hint: "what's the answer?"
    mock.reset();
    const inp = win.locator('.live-card textarea, .live-card input:not(.live-edit)').last();
    await inp.click();
    await inp.fill('just tell me the answer');
    await win.keyboard.press('Enter');
    await win.waitForTimeout(3500);
    const tut = mock.calls.find((c) => c.kind === 'tutor');
    console.log('tutor call system has guard:', tut ? /Never state the final answer/.test(tut.system ?? '') : 'no call', '| user excerpt:', JSON.stringify((tut?.user ?? '').slice(0, 400)));
    const cb = await win.locator('.live-card').boundingBox();
    await win.screenshot({ path: `tests/shots/${P}d2-ask-answer.png`, clip: { x: cb.x - 10, y: cb.y - 10, width: cb.width + 20, height: Math.min(900 - cb.y + 10, cb.height + 20) } });
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);

    // AI selector
    await win.keyboard.press('a');
    await win.waitForTimeout(200);
    const [ax, ay] = cl(70, 90), [bx, by] = cl(150, 210);
    const cx = (ax + bx) / 2, cy = (ay + by) / 2, rx = (bx - ax) / 2 + 30, ry = (by - ay) / 2 + 26;
    await win.mouse.move(cx + rx, cy);
    await win.mouse.down();
    for (let k = 1; k <= 66; k++) {
      const a = (k / 70) * Math.PI * 2; // stops ~5% short of closing: auto-close should kick in
      await win.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    await win.evaluate(() => {
      window.__chipAt = null;
      const t0 = performance.now();
      window.__relAt = t0;
      const tick = () => {
        if (document.querySelector('.live-ai button')) window.__chipAt = performance.now() - t0;
        else if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await win.mouse.up();
    await win.waitForTimeout(150);
    await shot(P + 'd3-selector-150ms');
    await win.waitForTimeout(900);
    console.log('chips visible after release (ms):', await win.evaluate(() => window.__chipAt));
    const ai = await win.locator('.live-ai').boundingBox().catch(() => null);
    const ink = [...cl(l3.bbox[0], 100), ...cl(l3.bbox[2] + 60, l3.bbox[3])];
    console.log('ai card', JSON.stringify(ai), 'ink', JSON.stringify(ink.map(Math.round)));
    await shot(P + 'd4-selector-card');
    console.log('chips:', JSON.stringify(await win.locator('.live-ai button').allInnerTexts()));
    mock.reset();
    const solve = win.getByRole('button', { name: /Solve step by step/ });
    if (await solve.count()) {
      await solve.click();
      await win.waitForTimeout(3500);
      const c = mock.calls.find((x) => x.kind === 'tutor' || x.kind === 'other');
      console.log('solve call kind', c?.kind, 'system guard', /Never state the final answer/.test(c?.system ?? ''), 'user excerpt', JSON.stringify((c?.user ?? '').slice(0, 300)));
      await shot(P + 'd5-selector-solve');
    }
    const pin = win.getByRole('button', { name: /Pin/i }).first();
    if (await pin.count()) {
      await pin.click();
      await win.waitForTimeout(400);
      await win.keyboard.press('Escape');
      await win.waitForTimeout(300);
      console.log('pinned card survives Esc:', await win.locator('.live-ai').count());
      await shot(P + 'd6-pinned');
    }
  } finally {
    await mock.close();
  }
};
