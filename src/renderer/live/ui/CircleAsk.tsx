// Circle to ask: a loop drawn with the pen around ink offers "Ask AI about this" next to it. It only
// offers: the tutor opens when the chip is tapped, and the chip fades by itself, so circling an
// answer in ordinary notes is never interrupted. The AI selector tool (A) does the same on purpose.
import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import type { Viewport } from '../../engine/viewport';
import type { BBox } from '../contract';
import { useAnchored } from './anchor';

/** how long the offer stays when it is not used */
export const CIRCLE_ASK_MS = 6000;

export function CircleAsk({ vp, pageId, bbox, onAsk, onDismiss }: { vp: Viewport; pageId: string; bbox: BBox; onAsk: () => void; onDismiss: () => void }) {
  const el = useRef<HTMLButtonElement>(null);
  useAnchored(vp, el, () => vp.pageRectToClient(pageId, bbox), [pageId, bbox], { prefer: ['right', 'above', 'below', 'left'] });
  useEffect(() => {
    const t = setTimeout(onDismiss, CIRCLE_ASK_MS);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onDismiss();
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', key);
    };
  }, [onDismiss]);
  return (
    <button ref={el} type="button" className="live-circle-ask" onPointerDown={(e) => e.stopPropagation()} onClick={onAsk} aria-label="Ask AI about what you circled">
      <Sparkles size={14} /> Ask AI about this
    </button>
  );
}
