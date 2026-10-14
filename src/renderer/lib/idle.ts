// Background work (saving, thumbnails, handwriting OCR) must never run while the pen is moving.
// The viewport reports input activity here; jobs wait for a quiet period and an idle frame.
let lastInput = 0;
let penDown = false;

export function markInput(down?: boolean) {
  lastInput = performance.now();
  if (down != null) penDown = down;
}

export function isBusy(quietMs: number) {
  return penDown || performance.now() - lastInput < quietMs;
}

/** Run fn once the pen has been still for quietMs (and the browser has an idle slice). */
export function whenIdle(fn: () => void, quietMs = 500): () => void {
  let cancelled = false;
  let t: ReturnType<typeof setTimeout> | undefined;
  let ric: number | undefined;
  const check = () => {
    if (cancelled) return;
    const wait = penDown ? quietMs : quietMs - (performance.now() - lastInput);
    if (wait > 0) {
      t = setTimeout(check, Math.max(30, wait));
      return;
    }
    ric = requestIdleCallback(
      () => {
        if (cancelled) return;
        if (isBusy(quietMs)) return check();
        fn();
      },
      { timeout: 2000 },
    );
  };
  check();
  return () => {
    cancelled = true;
    if (t) clearTimeout(t);
    if (ric != null) cancelIdleCallback(ric);
  };
}
