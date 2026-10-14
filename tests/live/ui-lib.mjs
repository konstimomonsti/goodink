// Shared helpers for the Live Ink UI scenarios (tests/live/ui-*.mjs).
// Writes simple handwriting with the mouse (pointer events through the real input path), opens a
// notebook with the scripted fake engine, and takes full and cropped screenshots.

// glyphs in a unit box: x 0..0.62, y 0 (top) .. 1 (baseline); each glyph is a list of strokes
const G = {
  '0': [[[0.3, 0], [0.08, 0.15], [0, 0.5], [0.08, 0.86], [0.3, 1], [0.52, 0.86], [0.6, 0.5], [0.52, 0.14], [0.3, 0]]],
  '1': [[[0.1, 0.2], [0.32, 0], [0.32, 1]]],
  '2': [[[0.04, 0.24], [0.14, 0.07], [0.32, 0], [0.5, 0.06], [0.58, 0.24], [0.5, 0.45], [0.02, 1], [0.62, 0.99]]],
  '3': [[[0.04, 0.12], [0.28, 0], [0.52, 0.1], [0.52, 0.32], [0.26, 0.47], [0.54, 0.6], [0.58, 0.84], [0.32, 1], [0.04, 0.9]]],
  '4': [[[0.44, 0], [0.02, 0.68], [0.62, 0.68]], [[0.46, 0.32], [0.46, 1]]],
  '5': [[[0.56, 0], [0.12, 0], [0.06, 0.44], [0.34, 0.38], [0.56, 0.56], [0.54, 0.86], [0.3, 1], [0.04, 0.9]]],
  '7': [[[0.02, 0.02], [0.6, 0], [0.22, 1]]],
  x: [[[0.02, 0.38], [0.56, 1]], [[0.56, 0.38], [0.02, 1]]],
  y: [[[0.02, 0.38], [0.3, 0.8]], [[0.58, 0.38], [0.2, 1.3]]],
  '+': [[[0.3, 0.36], [0.3, 0.96]], [[0.02, 0.66], [0.58, 0.66]]],
  '-': [[[0.04, 0.66], [0.56, 0.66]]],
  '=': [[[0.02, 0.54], [0.58, 0.54]], [[0.02, 0.82], [0.58, 0.82]]],
};

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

/** Write `text` with the mouse, baseline-left at client (x, y), glyph height h px. Returns the box. */
export async function write(win, text, x, y, h = 30) {
  let cx = x;
  const top = y - h;
  for (const ch of text) {
    if (ch === ' ') {
      cx += h * 0.45;
      continue;
    }
    const strokes = G[ch];
    if (!strokes) throw new Error(`no glyph for ${ch}`);
    const slant = 0.12;
    for (const s of strokes) {
      const pts = [];
      // densify each segment so the stroke has realistic sample spacing
      for (let k = 0; k < s.length - 1; k++) {
        const [ax, ay] = s[k], [bx, by] = s[k + 1];
        const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) * h / 3));
        for (let j = 0; j < n; j++) pts.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
      }
      pts.push(s[s.length - 1]);
      const P = ([u, v]) => [cx + (u + (1 - v) * slant) * h + rnd() * 0.6, top + v * h + rnd() * 0.6];
      const [sx, sy] = P(pts[0]);
      await win.mouse.move(sx, sy);
      await win.mouse.down();
      for (const p of pts.slice(1)) {
        const [px, py] = P(p);
        await win.mouse.move(px, py);
      }
      await win.mouse.up();
    }
    cx += h * 0.74;
  }
  return { x0: x, y0: top, x1: cx, y1: y };
}

/** Library → new blank notebook, with the fake live engine switched on. */
export async function openNotebook(win, { w = 1440, h = 900, dark = false, title = 'Algebra' } = {}) {
  await win.setViewportSize({ width: w, height: h }).catch(() => {});
  await win.evaluate(() => localStorage.setItem('goodink:live-fake', '1'));
  await win.waitForTimeout(1200);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  // no shape snapping while the test writes slowly
  await win.evaluate((d) => window.__goodink.updateSettings({ holdToShape: false, ...(d ? { theme: 'dark' } : {}) }), dark);
  await win.getByRole('button', { name: 'New', exact: true }).click();
  await win.getByRole('menuitem', { name: /^Notebook/ }).click();
  await win.locator('.modal input').first().waitFor();
  await win.locator('.modal input').first().fill(title);
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.locator('.gi-page').first().waitFor();
  await win.waitForTimeout(900);
}

export async function pageBox(win) {
  return win.locator('.gi-page').first().boundingBox();
}

/** The three-line worked problem with a mistake in the last line. */
export async function writeProblem(win, x, y, h = 30, gap = 54) {
  const a = await write(win, '2x+3=7', x, y, h);
  const b = await write(win, '2x=4', x, y + gap, h);
  const c = await write(win, 'x=3', x, y + gap * 2, h);
  return [a, b, c];
}

export const clipAround = (b, pad = 40, extra = {}) => ({ x: Math.max(0, b.x0 - pad), y: Math.max(0, b.y0 - pad), width: b.x1 - b.x0 + pad * 2 + (extra.w ?? 0), height: b.y1 - b.y0 + pad * 2 + (extra.h ?? 0) });

export async function crop(win, name, clip) {
  await win.screenshot({ path: `tests/shots/${name}.png`, clip });
}

export async function errors(win) {
  return win.evaluate(() => (window.__errs ?? []).slice());
}
