// Every timing and intensity of the Live Ink UI in one place (docs/live-ink/ARCHITECTURE.md §B), so
// feedback timing and mark loudness can be tuned without hunting through components.
// Units: ms, CSS px at 100% zoom (scaled with zoom where noted), or factors.
export const LIVE_TUNING = {
  // ---- when marks appear ----
  redAfterPenUpMs: 900, // red never sooner than this after pen-up
  redHoldPauseMs: 1500, // red near the pen waits for a pause this long…
  redHoldLineHeights: 2, // …while the pen is active within this many line heights
  newLineLineHeights: 0.8, // …or until the pen moves this far (a new line)
  maxRedPerPage: 3, // more collapse into a "+n" dot in the margin
  tickShowMs: 4000, // green ticks fade out after this unless "show ticks" is on
  tickFadeMs: 600,
  fixedMs: 600, // a fixed step: one soft green tick fade, the only celebration
  fixedWindowMs: 8000, // an error replaced by an ok line within this counts as fixed
  announceAfterMs: 2000, // polite live-region announcement after this pause

  // ---- input ----
  longPressMs: 450, // touch hold on ink → insight card
  longPressSlopPx: 6,
  tipDelayMs: 120,
  pttHoldMs: 280, // mic held longer than this = push-to-talk (release stops); shorter = toggle
  fixUnlockMs: 10_000, // "Show fix" unlocks after one hint or this long
  deicticMs: 10_000, // "why?" refers to the block written within this long

  // ---- red wave: 1.5 px at 100%, scaled with zoom ----
  wave: { widthAt100: 1.5, widthMin: 1, widthMax: 4, ampPerLineH: 0.07, ampMin: 1.5, ampMax: 3.6, lambdaPerAmp: 3.6, lambdaMin: 6, lambdaMax: 13, ampJitter: 0.32, drift: 0.22 },
  drawMs: 250, // draw-in, once
  // ---- amber dots: 55% opacity, scaled by confidence ----
  dots: { widthAt100: 1.6, widthMin: 1.2, widthMax: 3.6, gapPerWidth: 2.4, opacity: 0.55, minOpacityFactor: 0.55 },
  // ---- tick: ≤ 10 px, 40% ----
  tick: { sizePerLineH: 0.3, sizeMin: 6, sizeMax: 10, widthAt100: 1.4, opacity: 0.4 },
  // ---- ghost-ink results ----
  result: { opacity: 0.42, heightPerLineH: 0.78, gapPerLineH: 0.28, widthPerLineH: 0.075 },
  minMarkPx: 10,

  // ---- AI selector ----
  ai: { closePx: 24, dimLight: 0.13, dimDark: 0.32, dimInMs: 120, settleMs: 600, animateMs: 700, glowPx: 7, lineWidthPx: 2.25, spinMs: 2600 },
} as const;
