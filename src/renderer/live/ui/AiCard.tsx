// The AI selector's card: quick actions for the region drawn with the AI tool, then the streamed
// answer with follow-ups. Anchored to the region; can be pinned (stays while you keep working),
// dragged by its header (then it stays where you put it) and closed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpenText, GraduationCap, Languages, ListChecks, ListOrdered, Pin, PinOff, ScrollText, Sparkles, X, CornerDownLeft } from 'lucide-react';
import type { AiRegion, Viewport } from '../../engine/viewport';
import type { LiveStatus, LiveUiEngine, QuickAction, RegionContext, Turn } from './engineApi';
import { IconButton } from '../../ui/primitives';
import { FreeAiSetup } from '../../editor/AiDialogs';
import { useAnchored } from './anchor';
import { StreamText } from './StreamText';
import { AskBar } from './AskBar';

type Msg = { role: 'user' | 'assistant'; text: string; streaming?: boolean; error?: boolean };

const ACTIONS: { id: QuickAction; label: string; ask: string; icon: React.ReactNode }[] = [
  { id: 'explain', label: 'Explain', ask: 'Explain this', icon: <BookOpenText size={15} /> },
  { id: 'check', label: 'Check my work', ask: 'Check my work', icon: <ListChecks size={15} /> },
  { id: 'solve', label: 'Solve step by step', ask: 'Solve this step by step', icon: <ListOrdered size={15} /> },
  { id: 'summarise', label: 'Summarise', ask: 'Summarise this', icon: <ScrollText size={15} /> },
  { id: 'translate', label: 'Translate', ask: 'Translate this', icon: <Languages size={15} /> },
  { id: 'flashcards', label: 'Make flashcards', ask: 'Make flashcards from this', icon: <GraduationCap size={15} /> },
];

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function AiCard({ vp, engine, status, region, pinned, onPin, onClose }: { vp: Viewport; engine: LiveUiEngine; status: LiveStatus; region: AiRegion; pinned: boolean; onPin: (p: boolean) => void; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [follow, setFollow] = useState<string[]>([]);
  const [moved, setMoved] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const ctx = useRef<Promise<RegionContext> | null>(null);

  // the region as an image, captured once while it is on screen
  if (!ctx.current)
    ctx.current = vp
      .captureRegion(region.pageId, region.pts)
      .catch(() => null)
      .then((img) => ({ pageId: region.pageId, pts: region.pts, bbox: region.bbox, image: img ? { mime: 'image/png' as const, data: b64(img.png), w: img.w, h: img.h } : null }));

  useAnchored(vp, card, () => vp.pageRectToClient(region.pageId, region.bbox), [region], { frozen: moved, prefer: 'roomiest' });
  useEffect(() => () => abort.current?.abort(), []);

  const busy = msgs.some((m) => m.streaming);
  useEffect(() => {
    if (!pinned) vp.setAiBusy(busy);
  }, [busy, pinned, vp]);
  useEffect(() => {
    const el = body.current;
    if (el && msgs.length) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pinned) return;
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (pinned || card.current?.contains(t) || t.closest?.('.popover, .menu, .toast, .modal, .live-card')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose, pinned]);

  const run = useCallback(
    async (q: string, action?: QuickAction) => {
      if (busy) return;
      const history: Turn[] = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
      setFollow([]);
      setMsgs((m) => [...m, { role: 'user', text: q }, { role: 'assistant', text: '', streaming: true }]);
      const setLast = (patch: Partial<Msg>) => setMsgs((m) => m.map((x, k) => (k === m.length - 1 ? { ...x, ...patch } : x)));
      abort.current = new AbortController();
      try {
        const region = await ctx.current!;
        const r = await engine.ask({ region, action }, q, history, { onDelta: (t) => setLast({ text: t }), signal: abort.current.signal });
        setLast({ text: r.text, streaming: false });
        setFollow(r.followUps.slice(0, 3));
      } catch (e) {
        if ((e as Error).name === 'AbortError') setLast({ streaming: false });
        else setLast({ text: (e as Error).message || 'Something went wrong.', streaming: false, error: true });
      }
    },
    [busy, engine, msgs],
  );

  // drag by the header: the card then keeps the place you gave it
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') || !card.current) return;
    const el = card.current;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    const mv = (ev: PointerEvent) => {
      const b = vp.viewClientRect();
      el.style.left = `${Math.round(Math.max(b.left + 4, Math.min(ev.clientX - sx, b.right - el.offsetWidth - 4)))}px`;
      el.style.top = `${Math.round(Math.max(b.top + 4, Math.min(ev.clientY - sy, b.bottom - 48)))}px`;
      el.dataset.arrow = 'off';
      if (!moved) setMoved(true);
    };
    const up = () => {
      el.classList.remove('is-dragging');
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div ref={card} className={`live-card live-ai ${pinned ? 'is-pinned' : ''} ${msgs.length ? 'has-chat' : ''}`} role="dialog" aria-label="Ask AI about the selection" tabIndex={-1} onPointerDown={(e) => e.stopPropagation()}>
      <span className="live-arrow" aria-hidden="true" />
      <header className="live-card-head is-drag" onPointerDown={drag}>
        <span className="live-ai-mark" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <span className="live-ai-title">{msgs.length ? 'AI' : 'Ask about this selection'}</span>
        <IconButton label={pinned ? 'Unpin' : 'Pin: keep this card open'} active={pinned} className="live-x" onClick={() => onPin(!pinned)}>
          {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </IconButton>
        <IconButton label="Close (Esc)" className="live-x" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="live-card-body" ref={body} onScroll={(e) => card.current?.classList.toggle('is-scrolled', e.currentTarget.scrollTop > 2)}>
        {!status.aiReady ? (
          <div className="live-setup">
            <p className="muted small">The AI selector sends the region you drew to an AI model. Set up free AI to use it; the live check on your handwriting keeps working without it.</p>
            <FreeAiSetup compact />
          </div>
        ) : msgs.length === 0 ? (
          <div className="live-actions" role="group" aria-label="Quick actions">
            {ACTIONS.map((a) => (
              <button key={a.id} type="button" className="live-action" onClick={() => void run(a.ask, a.id)}>
                {a.icon}
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <section className="live-chat" aria-live="polite">
            {msgs.map((m, k) =>
              m.role === 'user' ? (
                <div key={k} className="live-msg is-user">
                  {m.text}
                </div>
              ) : (
                <div key={k} className={`live-msg is-ai ${m.error ? 'is-error' : ''}`}>
                  {m.streaming && !m.text ? <span className="live-dots" aria-label="Thinking" /> : m.error ? m.text : <StreamText text={m.text} streaming={!!m.streaming} />}
                </div>
              ),
            )}
          </section>
        )}
        {follow.length > 0 && !busy && (
          <div className="live-follow">
            {follow.map((f) => (
              <button key={f} type="button" className="live-chip" onClick={() => void run(f)}>
                <CornerDownLeft size={12} /> {f}
              </button>
            ))}
          </div>
        )}
      </div>
      {status.aiReady && (
        <footer className="live-card-foot">
          <AskBar engine={engine} busy={busy} onStop={() => abort.current?.abort()} onSend={(q) => void run(q)} placeholder={msgs.length ? 'Ask a follow-up…' : 'Ask anything about it…'} label="Ask about the selection" autoFocus={!msgs.length && !matchMedia('(pointer: coarse)').matches} />
        </footer>
      )}
    </div>
  );
}
