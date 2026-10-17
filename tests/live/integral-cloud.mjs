// Complex maths through the cloud check: a handwritten definite integral is grouped as one line, the
// cloud gets a crop of the whole integral (limits included), reads it from the image, and its verdict
// stands over the on-device reading. Smart mode against the mock provider (no key stored).
//   node tests/drive-tauri.mjs tests/live/integral-cloud.mjs src-tauri/target/debug/goodink.exe
import { startMockAi } from './mock-ai.mjs';

const RIGHT = String.raw`\int_0^2 x^2\,dx=\frac{8}{3}`;
const WRONG = String.raw`\int_0^2 x^2\,dx=4`;

export default async ({ win, shot }) => {
  const { newNotebook, writeText, pageOrigin, pageStrokes } = await import('./handwriting.mjs');
  const mock = await startMockAi();
  // what the mock "sees" in the image, in writing order: the right integral, then the wrong one
  const shown = [RIGHT, WRONG];
  let judged = 0;
  mock.set({
    judge: () => {
      const reading = shown[Math.min(judged++, shown.length - 1)];
      const wrong = reading === WRONG;
      return { reading_ok: false, corrected: reading, latex: reading, step_kind: 'calculation', verdict: wrong ? 'error' : 'ok', wrong_span: wrong ? '4' : '', title: wrong ? 'Wrong value' : '', detail: wrong ? 'The antiderivative evaluated from $0$ to $2$ gives a different value.' : '', hint: wrong ? 'What is $\\frac{x^3}{3}$ at $x=2$?' : '', fix: wrong ? RIGHT : '', gap: '', misconception: wrong ? 'integration-limits' : '', concept: 'Definite integrals' };
    },
    verify: () => ({ readingOk: true, work: 'x^3/3 from 0 to 2 = 8/3', valid: 'no', reason: '8/3, not 4.' }),
  });
  const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  try {
    await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
    await win.waitForTimeout(1000);
    await win.evaluate((base) => {
      const g = window.__goodink;
      g.updateSettings({ holdToShape: false, live: { mode: 'smart', showTicks: true, underlineUnsure: true, autoCheck: true }, ai: { provider: 'ollama', models: { ollama: 'mock-vision' }, efforts: {}, baseURLs: { ollama: base }, keys: ['ollama'] } });
    }, mock.openaiBase);
    await newNotebook(win, 'Integrals');
    const { pageId } = await pageOrigin(win);

    // 1. a correct definite integral
    await writeText(win, String.raw`\int_{0}^{2}x^2dx=\frac{8}{3}`, { x: 90, y: 170, size: 34, seed: 5 });
    const n1 = (await pageStrokes(win)).length;
    await win.waitForTimeout(4000);
    const checks = mock.calls.filter((c) => c.kind === 'check');
    ok('the cloud checked the integral', checks.length >= 1, `${checks.length} judge call(s)`);
    const img = checks[0]?.images?.[0];
    ok('a crop of the integral was sent', !!img && img.w > 0, img ? `${img.w}x${img.h} px` : 'none');
    // grouping: the whole integral (sign, both limits, integrand, result) is one line
    const grouping = await win.evaluate(async ({ pid, n }) => {
      const recog = await import('/live/recog/index.ts');
      const g = window.__goodink;
      const s = await g.getSession(g.useApp.getState().active);
      const strokes = s.content(pid).strokes;
      const blocks = recog.groupInk(pid, strokes);
      return { blocks: blocks.length, lines: blocks.map((b) => b.lines.length), strokes: strokes.filter((st) => st.kind === 'pen').length, inLine0: blocks[0]?.lines[0]?.strokeIds.length ?? 0 };
    }, { pid: pageId, n: n1 });
    ok('the integral is grouped as one line', grouping.blocks === 1 && grouping.lines[0] === 1 && grouping.inLine0 === grouping.strokes, JSON.stringify(grouping));
    const errs1 = await win.locator('.gi-live-mark.is-error').count();
    ok('no red on the correct integral', errs1 === 0, `${errs1} red`);
    await shot('integral-01-right');

    // 2. a wrong value, in its own block further down
    await writeText(win, String.raw`\int_{0}^{2}x^2dx=4`, { x: 90, y: 330, size: 34, seed: 6 });
    await win.waitForTimeout(5000);
    const errs2 = await win.locator('.gi-live-mark.is-error').count();
    ok('the wrong integral is red after the cloud and the re-solve agree', errs2 === 1, `${errs2} red; ${mock.calls.filter((c) => c.kind === 'verify').length} verify call(s)`);
    await shot('integral-02-wrong');

    // 3. the card shows the cloud's reading of the integral, typeset
    const mark = win.locator('.gi-live-mark.is-error').first();
    if (await mark.count()) {
      const b = await mark.boundingBox();
      await win.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
      await win.waitForTimeout(800);
      const card = await win.locator('.live-card').innerText().catch(() => '');
      ok('the card opens with the integral', /∫|Wrong value/.test(card), card.slice(0, 160).replace(/\n/g, ' | '));
      await shot('integral-03-card');
    } else ok('the card opens with the integral', false, 'no red mark to open');
  } finally {
    mock.close();
  }
};
