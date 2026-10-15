// Critic round 1, scenario B: REAL engine, Local mode, no AI. The insight card end to end with the
// pen tool active: right-click on the ink, rung 0 content, focus, Show fix gating, Hint/Ask with no
// AI, edit reading (can a student "fix" the reading to make it green?), Esc, erase → marks clear,
// rewrite correctly → fixed tick.
// node tests/drive-tauri.mjs tests/live/critic-r1-b.mjs src-tauri/target/debug/goodink.exe
import { newNotebook, writeText, pageOrigin } from './handwriting.mjs';

const P = 'critic-r1-';

export default async ({ win, shot }) => {
  const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900), dark = process.env.DARK === '1';
  const sfx = process.env.SFX ?? '';
  await win.setViewportSize({ width: W, height: H }).catch(() => {});
  await win.waitForTimeout(1200);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.evaluate((d) => window.__goodink.updateSettings({ holdToShape: false, ...(d ? { theme: 'dark' } : {}), live: { mode: 'local', showTicks: false, underlineUnsure: true, autoCheck: true } }), dark);
  await newNotebook(win, 'Critic B');
  await win.waitForTimeout(800);
  await win.evaluate(() => {
    window.__marks = [];
    const seen = new Set();
    new MutationObserver(() => {
      const cur = new Set();
      for (const g of document.querySelectorAll('.gi-live-mark')) {
        const k = g.getAttribute('class').replace(/ is-new| is-transient/g, '') + '|' + g.dataset.id;
        cur.add(k);
        if (!seen.has(k)) { seen.add(k); window.__marks.push({ t: performance.now(), k }); }
      }
      for (const k of [...seen]) if (!cur.has(k)) { seen.delete(k); window.__marks.push({ t: performance.now(), k: 'GONE ' + k }); }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const now = () => win.evaluate(() => performance.now());
  const since = (t) => win.evaluate((t) => window.__marks.filter((m) => m.t > t).map((m) => `${Math.round(m.t - t)}ms ${m.k}`), t);
  const o = await pageOrigin(win);
  const cl = (x, y) => [o.left + (x - o.ox) * o.zoom, o.top + (y - o.oy) * o.zoom];
  const X = Number(process.env.X ?? 80), Y = Number(process.env.Y ?? 120);
  await writeText(win, '2x+3=7', { x: X, y: Y, size: 24, seed: 1 });
  await writeText(win, '2x=4', { x: X, y: Y + 40, size: 24, seed: 2 });
  const l3 = await writeText(win, 'x=3', { x: X, y: Y + 80, size: 24, seed: 3 });
  let t = await now();
  await win.waitForTimeout(2500);
  console.log('marks:', JSON.stringify(await since(t)));
  await shot(P + 'b1-marks' + sfx);
  const err = await win.locator('.gi-live-mark.is-error path').first().boundingBox().catch(() => null);
  console.log('wave path box', JSON.stringify(err), 'line3 ink client box', JSON.stringify([...cl(l3.bbox[0], l3.bbox[1]), ...cl(l3.bbox[2], l3.bbox[3])].map(Math.round)));
  if (err) {
    await win.screenshot({ path: `tests/shots/${P}b2-wave-zoom${sfx}.png`, clip: { x: err.x - 40, y: err.y - 50, width: err.width + 80, height: 70 } });
  }
  // hover tip
  if (err) {
    await win.mouse.move(err.x + err.width / 2, err.y + 2);
    await win.waitForTimeout(700);
    const tip = await win.locator('.gi-live-tip.is-on').boundingBox().catch(() => null);
    console.log('tip', JSON.stringify(tip), JSON.stringify(await win.locator('.gi-live-tip').innerText().catch(() => '')));
    if (tip) await win.screenshot({ path: `tests/shots/${P}b3-tip${sfx}.png`, clip: { x: Math.max(0, Math.min(tip.x, err.x) - 30), y: Math.max(0, Math.min(tip.y, err.y) - 60), width: Math.max(tip.width, 120) + 80, height: 140 } });
  }
  // right-click on the ink of "3" with the pen tool active
  const [c3x, c3y] = cl(l3.bbox[2] - 5, (l3.bbox[1] + l3.bbox[3]) / 2);
  const t0 = await now();
  await win.mouse.click(c3x, c3y, { button: 'right' });
  await win.locator('.live-card').waitFor({ timeout: 3000 }).catch(() => {});
  const openMs = Math.round((await now()) - t0);
  const card = await win.locator('.live-card').boundingBox().catch(() => null);
  console.log('card after right-click (pen tool):', JSON.stringify(card), 'open ms', openMs, 'tool', await win.evaluate(() => window.__goodink?.useApp?.getState?.().tool ?? '?'));
  if (!card) return;
  await win.waitForTimeout(500);
  await shot(P + 'b4-card' + sfx);
  const crop = async (n) => {
    const b = await win.locator('.live-card').boundingBox();
    const x = Math.max(0, Math.min(b.x - 20, c3x - 200));
    await win.screenshot({ path: `tests/shots/${P}${n}${sfx}.png`, clip: { x, y: Math.max(0, b.y - 20), width: Math.min(W - x, b.x + b.width + 20 - x), height: Math.min(H - Math.max(0, b.y - 20), b.height + 40) } });
  };
  await crop('b5-card-crop');
  // overlap with ink?
  const inkClient = [...cl(X, Y - 24), ...cl(l3.bbox[2], l3.bbox[3])];
  const ov = !(card.x > inkClient[2] || card.x + card.width < inkClient[0] || card.y > inkClient[3] || card.y + card.height < inkClient[1]);
  console.log('card overlaps ink:', ov, 'inkbox', JSON.stringify(inkClient.map(Math.round)), 'in viewport:', card.x >= 0 && card.y >= 0 && card.x + card.width <= W && card.y + card.height <= H);
  console.log('card text rung0:', JSON.stringify(await win.locator('.live-card').innerText()));
  console.log('focus on open:', await win.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className} [${document.activeElement?.getAttribute('aria-label')}]`));
  const fix = win.locator('.live-fix-btn');
  console.log('Show fix disabled:', await fix.isDisabled().catch(() => 'n/a'), 'title:', await fix.getAttribute('title').catch(() => null));
  // type metrics of the card
  console.log('card styles:', JSON.stringify(await win.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const st = (s) => { const e = q(s); if (!e) return null; const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { font: `${c.fontWeight} ${c.fontSize}/${c.lineHeight}`, color: c.color, bg: c.backgroundColor, radius: c.borderRadius, shadow: c.boxShadow.slice(0, 80), pad: c.padding, w: Math.round(r.width), h: Math.round(r.height) }; };
    return { card: st('.live-card'), head: st('.live-card-head'), label: st('.live-label'), lines: st('.live-lines'), issueH: st('.live-issue h3, .live-issue strong, .live-issue b'), issue: st('.live-issue'), foot: st('.live-card-foot'), tool: st('.live-tool'), btn: st('.live-ladder button') };
  })));
  // Hint with no AI
  const hint = win.locator('.live-ladder button').first();
  console.log('ladder button label:', await hint.innerText().catch(() => null));
  await hint.click().catch((e) => console.log('hint click failed', e.message));
  await win.waitForTimeout(2500);
  console.log('after Hint (no AI):', JSON.stringify(await win.locator('.live-card').innerText()));
  await crop('b6-hint-noai');
  console.log('Show fix disabled after hint:', await fix.isDisabled().catch(() => 'n/a'));
  // Ask with no AI
  const inp = win.locator('.live-card textarea, .live-card input:not(.live-edit)').last();
  await inp.click().catch(() => {});
  await inp.fill('why is this wrong?').catch(() => {});
  await win.keyboard.press('Enter');
  await win.waitForTimeout(2500);
  console.log('after Ask (no AI):', JSON.stringify(await win.locator('.live-card').innerText()));
  await crop('b7-ask-noai');
  // Edit reading: change what was read from x=3 to x=2 (the ink still says 3)
  const edit = win.getByRole('button', { name: /Edit reading/ });
  if (await edit.count()) {
    await edit.first().click();
    await win.waitForTimeout(300);
    const ed = win.locator('.live-edit');
    console.log('edit field value:', await ed.inputValue().catch(() => null), 'count', await ed.count());
    await crop('b8-edit');
    await ed.fill('x=2').catch(() => {});
    const tE = await now();
    await win.keyboard.press('Enter');
    await win.waitForTimeout(800);
    console.log('after edit to x=2:', JSON.stringify(await win.locator('.live-card').innerText().catch(() => 'gone')), 'marks', JSON.stringify(await since(tE)));
    await crop('b9-edited');
    await shot(P + 'b9b-edited-page' + sfx);
  }
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  console.log('after Esc: card count', await win.locator('.live-card').count(), 'focus', await win.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`));
  // erase line 3 by undo ×3 (x = 2 strokes? = 2, 3 = 1) and time the mark removal
  const tU = await now();
  for (let i = 0; i < 5; i++) await win.keyboard.press('Control+z');
  await win.waitForTimeout(1500);
  console.log('after undo line 3:', JSON.stringify(await since(tU)));
  // rewrite correctly
  await writeText(win, 'x=2', { x: X, y: Y + 80, size: 24, seed: 9 });
  const tF = await now();
  await win.waitForTimeout(400);
  await shot(P + 'b10-fixed-400ms' + sfx);
  await win.waitForTimeout(2000);
  console.log('after rewrite x=2:', JSON.stringify(await since(tF)));
  await shot(P + 'b11-fixed' + sfx);
};
