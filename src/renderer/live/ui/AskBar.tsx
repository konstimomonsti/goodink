// The ask box of the insight card and the AI selector: text, microphone, send.
// The mic is push-to-talk: hold the button (or Space while the card has focus) and release to stop;
// a quick tap keeps it listening until the next tap. Partial text appears as you speak.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Square } from 'lucide-react';
import type { LiveUiEngine } from './engineApi';
import { useMic } from './useMic';
import { LIVE_TUNING as T } from './tuning';

export function AskBar({ engine, onSend, onStop, busy, disabled, placeholder, autoFocus, label = 'Ask about this', onListening }: { engine: LiveUiEngine | null; onSend: (text: string) => void; onStop?: () => void; busy?: boolean; disabled?: boolean; placeholder: string; autoFocus?: boolean; label?: string; onListening?: (on: boolean) => void }) {
  const [q, setQ] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // text typed before the mic started stays; dictation is added after it
  const base = useRef('');
  const mic = useMic(engine, (text, final) => {
    const t = [base.current.trimEnd(), text.trim()].filter(Boolean).join(' ');
    if (text || final) setQ(t || base.current);
    if (final) requestAnimationFrame(() => ta.current?.focus());
  });
  const recording = mic.state === 'recording' || mic.state === 'starting';
  const pressedAt = useRef(0);

  const listening = useRef(onListening);
  listening.current = onListening;
  useEffect(() => listening.current?.(recording), [recording]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(120, Math.max(22, el.scrollHeight))}px`;
  }, [q]);
  useEffect(() => {
    if (autoFocus) ta.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const begin = () => {
    if (disabled || mic.state === 'transcribing') return;
    base.current = q;
    pressedAt.current = performance.now();
    void mic.start();
  };
  // a long press is push-to-talk (release stops); a tap toggles
  const release = () => {
    if (performance.now() - pressedAt.current >= T.pttHoldMs) void mic.stop();
  };

  // Space held while the card has focus (and no text field does) talks too
  useEffect(() => {
    const card = form.current?.closest('.live-card') as HTMLElement | null;
    if (!card) return;
    const isField = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.('textarea, input, button, [contenteditable]');
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isField(e.target)) return;
      e.preventDefault();
      begin();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isField(e.target)) return;
      e.preventDefault();
      void mic.stop();
    };
    card.addEventListener('keydown', down);
    card.addEventListener('keyup', up);
    return () => {
      card.removeEventListener('keydown', down);
      card.removeEventListener('keyup', up);
    };
  });

  const send = () => {
    const t = q.trim();
    if (!t || busy || disabled) return;
    if (recording) void mic.stop();
    onSend(t);
    setQ('');
  };

  return (
    <form
      ref={form}
      className={`live-ask ${recording ? 'is-recording' : ''} ${mic.state === 'transcribing' ? 'is-transcribing' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="live-ask-field">
        <textarea
          ref={ta}
          rows={1}
          value={q}
          disabled={disabled}
          placeholder={recording ? 'Listening…' : mic.state === 'transcribing' ? 'Writing down what you said…' : placeholder}
          aria-label={label}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {recording && <canvas ref={mic.canvas} className="live-wave" aria-hidden="true" />}
      </div>
      <button
        type="button"
        className={`live-ask-mic ${recording ? 'is-on' : ''}`}
        aria-label={recording ? 'Stop recording' : 'Hold to talk'}
        aria-pressed={recording}
        title={recording ? 'Stop recording' : 'Hold to talk (or hold Space)'}
        disabled={disabled || mic.state === 'transcribing'}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (recording) void mic.stop();
          else begin();
        }}
        onPointerUp={() => recording && release()}
        onPointerCancel={() => recording && release()}
        onClick={(e) => {
          // keyboard activation (Enter on the button) toggles
          if (e.detail !== 0) return;
          if (recording) void mic.stop();
          else begin();
        }}
      >
        {recording ? <Square size={12} fill="currentColor" strokeWidth={0} /> : <Mic size={16} />}
      </button>
      {busy && onStop ? (
        <button type="button" className="live-ask-send is-stop" aria-label="Stop answer" title="Stop" onClick={onStop}>
          <Square size={11} fill="currentColor" strokeWidth={0} />
        </button>
      ) : (
        <button type="submit" className="live-ask-send" aria-label="Send" title="Send (Enter)" disabled={!q.trim() || busy || disabled}>
          <ArrowUp size={16} strokeWidth={2.4} />
        </button>
      )}
    </form>
  );
}
