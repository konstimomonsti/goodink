// Memory manager: while you work everything stays warm; after IDLE_MS without any input the app
// trims (WebView2 low-memory mode + PDF engine caches). The first input restores normal mode, so
// the trim is never felt. Pages on screen keep their pixels throughout.
import { invoke } from '@tauri-apps/api/core';

const IDLE_MS = 20_000;
let low = false;
let last = performance.now();

export function startMemoryManager(trim: () => void) {
  const activity = () => {
    last = performance.now();
    if (low) {
      low = false;
      void invoke('memory_mode', { low: false }).catch(() => undefined);
    }
  };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) window.addEventListener(ev, activity, { capture: true, passive: true });
  setInterval(() => {
    if (low || performance.now() - last < IDLE_MS) return;
    low = true;
    trim();
    void invoke('memory_mode', { low: true }).catch(() => undefined);
  }, 5000);
}
