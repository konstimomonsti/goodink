// Critic round 1, scenario A: the REAL engine (Local mode, no AI) on worked problems, measured.
// Correct work (false reds?), one wrong last step, a wrong middle step (first error only + carried),
// live results, red timing vs pen-up, right-click with the pen tool, card rung 0, Esc, erase.
// node tests/drive-tauri.mjs tests/live/critic-r1-a.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText, pageOrigin } from './handwriting.mjs';

const P = 'critic-r1-';

export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.evaluate(() => window.__goodink.updateSettings({ holdToShape: false, live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }));
  await newNotebook(win, 'Critic A');
  await win.waitForTimeout(800);
  // record every mark appearance with a timestamp
  await win.evaluate(() => {
    window.__marks = [];
    const seen = new Set();
    const obs = new MutationObserver(() => {
      for (const g of document.querySelectorAll('.gi-live-mark')) {
        const k = g.getAttribute('class').replace(/ is-new| is-transient/g, '') + '|' + g.dataset.id;
        if (!seen.has(k)) {
          seen.add(k);
          const r = g.getBoundingClientRect();
          window.__marks.push({ t: performance.now(), k, box: [r.x, r.y, r.width, r.height].map(Math.round) });
        }
      }
      for (const k of [...seen]) {
        const id = k.split('|')[1];
        if (!document.querySelector(`.gi-live-mark[data-id="${CSS.escape(id)}"]`)) {
          seen.delete(k);
          window.__marks.push({ t: performance.now(), k: 'GONE ' + k });
        }
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const now = () => win.evaluate(() => performance.now());
  const marksSince = (t) => win.evaluate((t) => window.__marks.filter((m) => m.t > t).map((m) => ({ ...m, dt: Math.round(m.t - t) })), t);
  const o = await pageOrigin(win);
  const cl = (x, y) => [o.left + x * o.zoom, o.top + y * o.zoom];
  console.log('zoom', o.zoom);

  // 1. correct work, three lines
  await writeText(win, '2x+3=7', { x: 70, y: 110, size: 24, seed: 11 });
  await writeText(win, '2x=4', { x: 70, y: 150, size: 24, seed: 12 });
  await writeText(win, 'x=2', { x: 70, y: 190, size: 24, seed: 13 });
  let t = await now();
  await win.waitForTimeout(3000);
  console.log('A1 correct work marks:', JSON.stringify(await marksSince(t)));
  await shot(P + 'a1-correct');

  // 2. wrong last step, written with a natural pause per line; measure red timing after last pen-up
  await writeText(win, '2x+3=7', { x: 300, y: 110, size: 24, seed: 21 });
  await win.waitForTimeout(700);
  await writeText(win, '2x=4', { x: 300, y: 150, size: 24, seed: 22 });
  await win.waitForTimeout(700);
  await writeText(win, 'x=3', { x: 300, y: 190, size: 24, seed: 23 });
  t = await now();
  await win.waitForTimeout(3000);
  console.log('A2 wrong last step marks (dt from last pen-up):', JSON.stringify(await marksSince(t)));
  console.log('A2 line3 client y range', cl(300, 190 - 18)[1], cl(300, 190)[1]);
  await shot(P + 'a2-wrong-last');

  // 3. wrong middle step, next line carried correctly from it
  await writeText(win, '3x-5=10', { x: 70, y: 280, size: 24, seed: 31 });
  await writeText(win, '3x=5', { x: 70, y: 320, size: 24, seed: 32 });
  await writeText(win, 'x=5/3', { x: 70, y: 360, size: 24, seed: 33 });
  t = await now();
  await win.waitForTimeout(3000);
  console.log('A3 wrong middle marks:', JSON.stringify(await marksSince(t)));
  console.log('A3 line2 client y', cl(0, 320)[1], 'line3', cl(0, 360)[1]);

  // 4. live results with and without variables
  await writeText(win, '12+5=', { x: 300, y: 280, size: 24, seed: 41 });
  await writeText(win, 'a=3', { x: 300, y: 330, size: 24, seed: 42 });
  await writeText(win, '2a+1=', { x: 300, y: 370, size: 24, seed: 43 });
  t = await now();
  await win.waitForTimeout(3000);
  console.log('A4 results:', JSON.stringify(await marksSince(t)));
  await shot(P + 'a3-overview');

  // 5. hold: write a wrong line, then keep writing on the same line (pen active within 2 line heights)
  await writeText(win, '5x=20', { x: 70, y: 450, size: 24, seed: 51 });
  await writeText(win, 'x=5', { x: 70, y: 490, size: 24, seed: 52 });
  t = await now();
  for (let i = 0; i < 4; i++) {
    await win.waitForTimeout(500);
    await writeText(win, '7', { x: 200 + i * 20, y: 490, size: 24, seed: 60 + i }); // scribbling on the same line
  }
  const tLast = await now();
  await win.waitForTimeout(3000);
  console.log('A5 hold: first pen-up', 0, 'last nearby pen-up', Math.round(tLast - t), JSON.stringify(await marksSince(t)));

  // dump mark DOM for exact rendering checks
  const dom = await win.evaluate(() => [...document.querySelectorAll('.gi-live-mark')].map((g) => {
    const p = g.querySelector('path,text,circle');
    const cs = p ? getComputedStyle(p) : null;
    const r = g.getBoundingClientRect();
    return { cls: g.getAttribute('class'), id: g.dataset.id, aria: g.getAttribute('aria-label'), box: [r.x, r.y, r.width, r.height].map(Math.round), stroke: cs?.stroke, sw: p?.getAttribute('stroke-width'), op: cs?.opacity, text: g.textContent };
  }));
  console.log('DOM marks:', JSON.stringify(dom, null, 0));
  console.log('pill:', await win.locator('.live-pill').getAttribute('aria-label').catch(() => null));

  // 6. right-click with the PEN tool still active, on the wrong line of problem 2
  const errG = await win.locator('.gi-live-mark.is-error').first().boundingBox().catch(() => null);
  console.log('first error box', JSON.stringify(errG));
  const [rx, ry] = errG ? [errG.x + errG.width / 2, errG.y - 12] : cl(320, 182);
  const strokesBefore = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return s.content(s.pages[0].id).strokes.length; });
  await win.mouse.click(rx, ry, { button: 'right' });
  await win.waitForTimeout(900);
  const strokesAfter = await win.evaluate(async () => { const g = window.__goodink; const s = await g.getSession(g.useApp.getState().active); return s.content(s.pages[0].id).strokes.length; });
  const cardBox = await win.locator('.live-card').boundingBox().catch(() => null);
  console.log('A6 right-click in pen tool -> card:', JSON.stringify(cardBox), 'strokes', strokesBefore, '->', strokesAfter);
  await shot(P + 'a4-card-pen');
  if (cardBox) {
    await win.screenshot({ path: `tests/shots/${P}a5-card-crop.png`, clip: { x: Math.max(0, cardBox.x - 260), y: Math.max(0, cardBox.y - 20), width: Math.min(1440 - Math.max(0, cardBox.x - 260), cardBox.width + 290), height: Math.min(900 - Math.max(0, cardBox.y - 20), cardBox.height + 40) } });
    console.log('card text:', JSON.stringify(await win.locator('.live-card').innerText()));
    console.log('focused after open:', await win.evaluate(() => document.activeElement?.className + ' / ' + document.activeElement?.getAttribute('aria-label')));
    const fix = win.locator('.live-fix-btn');
    console.log('show fix disabled:', await fix.isDisabled().catch(() => 'n/a'), 'title', await fix.getAttribute('title').catch(() => null));
    // Hint with no AI configured
    const hint = win.getByRole('button', { name: /^Hint/ });
    if (await hint.count()) {
      await hint.first().click();
      await win.waitForTimeout(2500);
      console.log('after Hint (no AI):', JSON.stringify(await win.locator('.live-card').innerText()));
      await win.screenshot({ path: `tests/shots/${P}a6-hint-noai.png`, clip: await win.locator('.live-card').boundingBox() });
    }
    // Ask with no AI
    const inp = win.locator('.live-card textarea, .live-card input').last();
    await inp.fill('why is this wrong?').catch(() => {});
    await win.keyboard.press('Enter');
    await win.waitForTimeout(2500);
    console.log('after Ask (no AI):', JSON.stringify(await win.locator('.live-card').innerText().catch(() => 'card gone')));
    const cb2 = await win.locator('.live-card').boundingBox().catch(() => null);
    if (cb2) await win.screenshot({ path: `tests/shots/${P}a7-ask-noai.png`, clip: cb2 });
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
    console.log('after Esc: card?', await win.locator('.live-card').count(), 'focus', await win.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className));
  }

  // 7. Tab to marks, Enter opens
  await win.locator('.gi-scroller').focus().catch(() => {});
  const tabbed = [];
  for (let i = 0; i < 6; i++) {
    await win.keyboard.press('Tab');
    tabbed.push(await win.evaluate(() => (document.activeElement?.getAttribute('class') ?? document.activeElement?.tagName) + ' ' + (document.activeElement?.getAttribute('aria-label') ?? '')));
  }
  console.log('Tab order:', JSON.stringify(tabbed));

  // 8. erase: undo the wrong line x=5 of problem 5 / x=3 → mark gone within a frame?
  const tU = await now();
  await win.keyboard.press('Control+z');
  await win.waitForTimeout(1500);
  console.log('A8 undo last stroke:', JSON.stringify(await marksSince(tU)));
};
