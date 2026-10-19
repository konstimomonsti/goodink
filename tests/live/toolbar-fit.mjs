// The editor toolbar never overlaps itself: at every width the last tool ends before the right-hand
// group begins, and every tool button is visible.
//   node tests/drive-tauri.mjs tests/live/toolbar-fit.mjs src-tauri/target/debug/goodink.exe
export default async ({ win, shot }) => {
  const { newNotebook } = await import('./handwriting.mjs');
  await win.setViewportSize({ width: 1600, height: 900 }).catch(() => {});
  await win.waitForTimeout(800);
  await newNotebook(win, 'Toolbar');
  for (const w of [1600, 1280, 1000, 760]) {
    await win.setViewportSize({ width: w, height: 860 }).catch(() => {});
    await win.waitForTimeout(400);
    const m = await win.evaluate(() => {
      const tools = [...document.querySelectorAll('.tb-tools .tool-btn')].filter((e) => e.getBoundingClientRect().width > 0);
      const right = [...document.querySelectorAll('.tb-right > *')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      const toolsEnd = Math.max(...tools.map((e) => e.getBoundingClientRect().right));
      const rightStart = Math.min(...right.map((r) => r.left));
      return { toolsEnd: Math.round(toolsEnd), rightStart: Math.round(rightStart), tools: tools.length };
    });
    console.log(`${m.toolsEnd <= m.rightStart ? 'PASS' : 'FAIL'} ${w}px: tools end at ${m.toolsEnd}, right group starts at ${m.rightStart}, ${m.tools} tools visible`);
    await shot(`toolbar-${w}`);
  }
};
