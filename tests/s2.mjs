const drawPath = async (win, pts) => {
  await win.mouse.move(pts[0][0], pts[0][1]);
  await win.mouse.down();
  for (const [x, y] of pts.slice(1)) await win.mouse.move(x, y, { steps: 2 });
  await win.mouse.up();
};
const wave = (x0, y0, w, amp, n = 40) => Array.from({ length: n }, (_, i) => [x0 + (w * i) / n, y0 + Math.sin(i / 3) * amp]);
const circle = (cx, cy, r, n = 40) => Array.from({ length: n + 2 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r * (1 + 0.04 * Math.sin(i)), cy + Math.sin((i / n) * Math.PI * 2) * r]);

export default async ({ win, shot }) => {
  await win.waitForTimeout(1200);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await win.getByRole('button', { name: 'New notebook' }).first().click();
  await win.waitForTimeout(300);
  await win.getByPlaceholder('Untitled notebook').fill('Biology lecture 3');
  await shot('03-new-notebook');
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.waitForTimeout(1200);
  await shot('04-editor-blank');
  const box = await win.locator('.gi-page').first().boundingBox();
  console.log('page box', JSON.stringify(box));
  const X = box.x, Y = box.y;
  // pen strokes
  for (let row = 0; row < 3; row++) await drawPath(win, wave(X + 80, Y + 140 + row * 40, 300, 6));
  // highlighter
  await win.keyboard.press('h');
  await drawPath(win, [[X + 80, Y + 180], [X + 250, Y + 181], [X + 380, Y + 180]]);
  // shape tool circle
  await win.keyboard.press('s');
  await drawPath(win, circle(X + 500, Y + 330, 60));
  await drawPath(win, [[X + 100, Y + 420], [X + 300, Y + 422], [X + 450, Y + 421]]);
  // text
  await win.keyboard.press('t');
  await win.mouse.click(X + 100, Y + 500);
  await win.waitForTimeout(200);
  await win.keyboard.type('Mitochondria are the powerhouse of the cell.');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  await win.keyboard.press('p');
  await win.waitForTimeout(800);
  await shot('05-editor-ink');
  // lasso the pen strokes
  await win.keyboard.press('l');
  await drawPath(win, [[X + 60, Y + 110], [X + 420, Y + 110], [X + 420, Y + 240], [X + 60, Y + 240], [X + 60, Y + 112]]);
  await win.waitForTimeout(400);
  await shot('06-lasso');
  // drag selection
  await win.mouse.move(X + 200, Y + 160);
  await win.mouse.down();
  await win.mouse.move(X + 260, Y + 620, { steps: 10 });
  await win.mouse.up();
  await win.waitForTimeout(400);
  await shot('07-moved');
  await win.keyboard.press('Control+z');
  await win.waitForTimeout(300);
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(800);
  await shot('08-two-pages');
  await win.waitForTimeout(1500);
};
