// Smart placement for cards anchored to ink: beside the ink when there is room (right, then left),
// else below or above; always inside the canvas; follows scroll and zoom without React renders.
import { useLayoutEffect, type RefObject } from 'react';
import type { Viewport } from '../../engine/viewport';

export type Side = 'right' | 'left' | 'below' | 'above';

const GAP = 14; // card edge to ink, the arrow sits in this gap
const EDGE = 10;

export interface Placement {
  left: number;
  top: number;
  side: Side;
  /** arrow position along the card edge (px), or null when the ink is off screen */
  arrow: number | null;
  hidden: boolean;
}

export function place(a: DOMRect, w: number, h: number, bounds: DOMRect, prefer: Side[] | 'roomiest' = ['right', 'left', 'below', 'above']): Placement {
  if (prefer === 'roomiest') {
    // the side with the most free space first (the card never covers what it is about)
    const room: Record<Side, number> = { right: (bounds.right - a.right) / w, left: (a.left - bounds.left) / w, below: (bounds.bottom - a.bottom) / h, above: (a.top - bounds.top) / h };
    prefer = (Object.keys(room) as Side[]).sort((p, q) => room[q] - room[p]);
  }
  const bx0 = bounds.left + EDGE, by0 = bounds.top + EDGE, bx1 = bounds.right - EDGE, by1 = bounds.bottom - EDGE;
  const cx = a.left + a.width / 2, cy = a.top + a.height / 2;
  const clampX = (x: number) => Math.max(bx0, Math.min(x, bx1 - w));
  const clampY = (y: number) => Math.max(by0, Math.min(y, by1 - h));
  // the card's top sits a little above the ink's centre, so the arrow points near its top third
  const sideTop = clampY(cy - Math.min(56, h / 3));
  const tries: Record<Side, () => { left: number; top: number; fits: boolean }> = {
    right: () => ({ left: a.right + GAP, top: sideTop, fits: a.right + GAP + w <= bx1 }),
    left: () => ({ left: a.left - GAP - w, top: sideTop, fits: a.left - GAP - w >= bx0 }),
    below: () => ({ left: clampX(cx - w / 2), top: a.bottom + GAP, fits: a.bottom + GAP + h <= by1 }),
    above: () => ({ left: clampX(cx - w / 2), top: a.top - GAP - h, fits: a.top - GAP - h >= by0 }),
  };
  let side: Side = prefer[0];
  let pos = tries[side]();
  for (const s of prefer) {
    const t = tries[s]();
    if (t.fits) {
      side = s;
      pos = t;
      break;
    }
    if (s === prefer[prefer.length - 1]) {
      // nothing fits: the side with the most room, kept on screen (it may overlap the ink a bit)
      const room: Record<Side, number> = { right: bx1 - a.right, left: a.left - bx0, below: by1 - a.bottom, above: a.top - by0 };
      side = (Object.keys(room) as Side[]).sort((p, q) => room[q] - room[p])[0];
      pos = tries[side]();
    }
  }
  const left = clampX(pos.left), top = clampY(pos.top);
  const horiz = side === 'right' || side === 'left';
  const along = horiz ? cy - top : cx - left;
  const len = horiz ? h : w;
  const onScreen = cx >= bounds.left && cx <= bounds.right && cy >= bounds.top - 20 && cy <= bounds.bottom + 20;
  const arrowOk = onScreen && along >= 14 && along <= len - 14 && (horiz ? (side === 'right' ? left >= a.right + 4 : left + w <= a.left - 4) : side === 'below' ? top >= a.bottom + 4 : top + h <= a.top - 4);
  const far = a.bottom < bounds.top - 60 || a.top > bounds.bottom + 60 || a.right < bounds.left - 60 || a.left > bounds.right + 60;
  return { left, top, side, arrow: arrowOk ? Math.round(along) : null, hidden: far };
}

/**
 * Keep `card` placed next to `anchor()` (client rect). Writes styles directly on scroll/zoom/resize.
 * `frozen`: the card was moved by hand and keeps its own position.
 */
export function useAnchored(vp: Viewport, card: RefObject<HTMLElement | null>, anchor: () => DOMRect | null, deps: unknown[], opts: { frozen?: boolean; prefer?: Side[] | 'roomiest' } = {}) {
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || opts.frozen) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const a = anchor();
      if (!a) return;
      const p = place(a, el.offsetWidth, el.offsetHeight, vp.viewClientRect(), opts.prefer);
      el.style.left = `${Math.round(p.left)}px`;
      el.style.top = `${Math.round(p.top)}px`;
      el.dataset.side = p.side;
      el.classList.toggle('is-away', p.hidden);
      if (p.arrow == null) el.style.removeProperty('--arrow');
      else el.style.setProperty('--arrow', `${p.arrow}px`);
      el.dataset.arrow = p.arrow == null ? 'off' : 'on';
    };
    const later = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    const off = vp.onView(later);
    const ro = new ResizeObserver(later);
    ro.observe(el);
    window.addEventListener('resize', later);
    return () => {
      off();
      ro.disconnect();
      window.removeEventListener('resize', later);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, opts.frozen, ...deps]);
}
