// Every mark kind and the quiet-default controls, with the fake engine:
//   ghost-ink result, transient ticks, unsure dots with confidence, "+n" overflow, fixed-step fade,
//   keyboard focus on marks, exam mode + reveal, pause per page, "Your patterns".
// node tests/drive-tauri.mjs tests/live/ui-kinds.mjs src-tauri/target/debug/goodink.exe   (DARK=1 for dark)
import { openNotebook, pageBox, write, crop } from './ui-lib.mjs';

export default async ({ win, shot }) => {
  const dark = process.env.DARK === '1';
  const sfx = dark ? '-dark' : '';
  await win.evaluate(() => (window.__liveFake = { blockScripts: [['2x+3=7', '2x=4', 'x=3', 'x=2'], ['x=3', 'x=3', 'x=3', 'x=3', 'x=3'], ['12+5='], ['?5x=10']] }));
  await openNotebook(win, { dark });
  const pb = await pageBox(win);
  const X = pb.x + 90, Y = pb.y + 120, H = 26, G = 44;
  // block 1: worked problem with a mistake and a carried line
  for (const [k, t] of ['2x+3=7', '2x=4', 'x=3', 'x=2'].entries()) await write(win, t, X, Y + k * G, H);
  // block 2: a sum with a trailing "=" → live result; block 3: a shaky reading
  const r = await write(win, '12+5=', X + 330, Y, H);
  await write(win, '5x=10', X + 330, Y + 150, H);
  // block 4: five wrong lines → three marks and "+2"
  for (let k = 0; k < 5; k++) await write(win, 'x=3', X, Y + 260 + k * G, H);
  await win.waitForTimeout(700);
  await shot(`ui-40-settle-ticks${sfx}`);
  await win.waitForTimeout(1800);
  await shot(`ui-41-kinds${sfx}`);
  await crop(win, `ui-42-result-crop${sfx}`, { x: r.x0 - 20, y: r.y0 - 30, width: r.x1 - r.x0 + 140, height: H + 60 });
  console.log('kinds:', await win.locator('.gi-live-mark').evaluateAll((m) => m.map((e) => e.getAttribute('class').replace('gi-live-mark ', ''))));

  // hover tip on the unsure line
  const u = await win.locator('.gi-live-mark.is-unsure path').boundingBox();
  await win.keyboard.press('l');
  await win.mouse.move(u.x + u.width / 2, u.y);
  await win.waitForTimeout(400);
  await crop(win, `ui-43-unsure-tip${sfx}`, { x: u.x - 120, y: u.y - 60, width: u.width + 340, height: 120 });

  // zoomed result and marks
  await win.evaluate(() => window.__editor.vp.setZoom(3));
  await win.waitForTimeout(400);
  await win.evaluate(() => document.querySelector('.gi-live-mark.is-result')?.scrollIntoView({ block: 'center', inline: 'center' }));
  await win.waitForTimeout(500);
  const rr = await win.locator('.gi-live-mark.is-result').boundingBox();
  if (rr) await crop(win, `ui-44-result-zoom3${sfx}`, { x: rr.x - 260, y: rr.y - 60, width: rr.width + 300, height: rr.height + 100 });
  await win.evaluate(() => {
    window.__editor.vp.setZoom(1.6);
    window.__editor.vp.scrollToPage(0, false);
  });
  await win.waitForTimeout(3200);
  await shot(`ui-45-ticks-faded${sfx}`);

  // keyboard: Tab to the first mark, Enter opens its card
  await win.locator('.gi-scroller').focus();
  await win.keyboard.press('Tab');
  await win.waitForTimeout(150);
  console.log('focused mark:', await win.evaluate(() => document.activeElement?.getAttribute('aria-label')));
  const f = await win.locator('.gi-live-mark:focus').boundingBox().catch(() => null);
  if (f) await crop(win, `ui-46-mark-focus${sfx}`, { x: f.x - 140, y: f.y - 60, width: f.width + 280, height: f.height + 100 });
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
  console.log('card from keyboard:', await win.locator('.live-card').count());

  // fixed: correct the reading → the mark becomes one green tick fade
  await win.getByRole('button', { name: 'Edit reading' }).click();
  await win.locator('.live-edit').fill('x=2');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(150);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(250);
  const fx = await win.locator('.gi-live-mark.is-fixed').boundingBox().catch(() => null);
  if (fx) await crop(win, `ui-47-fixed${sfx}`, { x: fx.x - 160, y: fx.y - 50, width: fx.width + 220, height: fx.height + 90 });
  console.log('fixed mark seen:', !!fx);

  // exam mode from the pill: marks hide, the pill counts them; reveal brings them back together
  await win.locator('.live-pill').click();
  await win.locator('.live-pop').waitFor();
  await win.getByRole('switch', { name: /Exam mode/ }).click().catch(async () => win.locator('.live-pop .toggle-row', { hasText: 'Exam mode' }).locator('button').click());
  await win.waitForTimeout(300);
  const pop = await win.locator('.live-pop').boundingBox();
  await crop(win, `ui-48-exam-popover${sfx}`, { x: pop.x - 20, y: 0, width: pop.width + 40, height: pop.y + pop.height + 20 });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  await shot(`ui-49-exam-hidden${sfx}`);
  await win.locator('.live-pill').click();
  await win.getByRole('button', { name: /^Reveal/ }).click();
  await win.waitForTimeout(110);
  await shot(`ui-50-exam-reveal-mid${sfx}`);
  await win.waitForTimeout(600);
  await shot(`ui-51-exam-revealed${sfx}`);

  // pause this page
  await win.locator('.live-pill').click();
  await win.locator('.live-pop .toggle-row', { hasText: 'Pause checking' }).locator('button').click();
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  await shot(`ui-52-paused${sfx}`);
  console.log('marks while paused:', await win.locator('.gi-live-mark').count());
  await win.locator('.live-pill').click();
  await win.locator('.live-pop .toggle-row', { hasText: 'Pause checking' }).locator('button').click();
  await win.locator('.live-pop .toggle-row', { hasText: 'Exam mode' }).locator('button').click();

  // your patterns
  await win.getByRole('button', { name: /Your patterns/ }).click();
  await win.locator('.live-patterns').waitFor();
  await win.waitForTimeout(300);
  await shot(`ui-53-patterns${sfx}`);
  await win.getByRole('button', { name: 'Make flashcards' }).click();
  await win.waitForTimeout(800);
  await shot(`ui-54-flashcards-toast${sfx}`);
};
