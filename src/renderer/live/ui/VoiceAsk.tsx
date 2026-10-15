// "Ask by voice": the toolbar mic that opens the tutor. The tutor never listens on its own; it opens
// only when asked, either here or with the AI selector. Hold to talk (release sends) or tap to start
// and tap again to send. What you said goes to the block you are writing (the one under the pen or
// written in the last few seconds), or to what is on screen when there is none.
import { useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { useMic } from './useMic';
import { LIVE_TUNING as T } from './tuning';
import type { LiveUiEngine } from './engineApi';

export function VoiceAsk({ engine, onAsk, onListening }: { engine: LiveUiEngine | null; onAsk: (question: string) => void; onListening?: (on: boolean) => void }) {
  const [partial, setPartial] = useState('');
  const pressedAt = useRef(0);
  const mic = useMic(engine, (text, final) => {
    if (!final) return setPartial(text);
    setPartial('');
    const q = text.trim();
    if (q) onAsk(q);
  });
  const recording = mic.state === 'recording' || mic.state === 'starting';
  const busy = mic.state === 'transcribing';

  const begin = () => {
    if (busy) return;
    pressedAt.current = performance.now();
    setPartial('');
    onListening?.(true);
    void mic.start();
  };
  const end = () => {
    onListening?.(false);
    void mic.stop();
  };

  return (
    <div className="live-voice">
      <button
        type="button"
        className={`live-voice-btn ${recording ? 'is-on' : ''}`}
        aria-label={recording ? 'Stop and ask' : 'Ask by voice'}
        aria-pressed={recording}
        title={recording ? 'Release or tap to ask' : 'Ask by voice: hold to talk'}
        disabled={busy}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (recording) end();
          else begin();
        }}
        onPointerUp={() => recording && performance.now() - pressedAt.current >= T.pttHoldMs && end()}
        onPointerCancel={() => recording && end()}
        onClick={(e) => {
          // keyboard activation toggles
          if (e.detail !== 0) return;
          if (recording) end();
          else begin();
        }}
      >
        {recording ? <Square size={11} fill="currentColor" strokeWidth={0} /> : <Mic size={16} />}
        <span className="live-voice-label">{recording ? 'Listening…' : 'Ask by voice'}</span>
      </button>
      {(recording || busy) && (
        <div className="live-voice-pop" role="status" aria-live="polite">
          {recording && <canvas ref={mic.canvas} className="live-wave" aria-hidden="true" />}
          <span className={`live-voice-text ${partial ? '' : 'is-hint'}`}>{busy ? 'Writing down what you said…' : partial || 'Listening… release to ask'}</span>
        </div>
      )}
    </div>
  );
}
