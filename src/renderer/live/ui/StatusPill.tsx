// "Live check" pill in the editor toolbar: mode, a state dot, last latency and tokens this session.
// Click: a popover to switch mode, with one line on what each mode costs and sends.
import { useRef, useState } from 'react';
import { Check, ChevronRight, Cpu, Eye, Gauge, Power, Repeat2, Sparkles, Zap } from 'lucide-react';
import { DEFAULT_LIVE, type LiveSettings } from '../../../shared/types';
import { openDialog, updateSettings, useApp } from '../../lib/store';
import { Popover, Toggle } from '../../ui/primitives';
import type { LiveMode, LiveStatus } from './engineApi';
import { HandwritingModel } from './HandwritingModel';

export const MODES: { id: LiveMode; label: string; line: string; icon: React.ReactNode }[] = [
  { id: 'off', label: 'Off', line: 'Nothing is checked.', icon: <Power size={15} /> },
  { id: 'local', label: 'Local', line: 'Free and private. Nothing leaves your PC.', icon: <Cpu size={15} /> },
  { id: 'smart', label: 'Smart', line: 'Instant check on this PC, then the AI model checks every formula.', icon: <Gauge size={15} /> },
  { id: 'max', label: 'Max', line: 'AI checks every step and double-checks mistakes. Most tokens.', icon: <Zap size={15} /> },
];

export const useLive = (): LiveSettings => {
  const raw = useApp((st) => st.settings.live);
  return raw ?? DEFAULT_LIVE;
};
export const setLive = (patch: Partial<LiveSettings>) => updateSettings({ live: { ...DEFAULT_LIVE, ...useApp.getState().settings.live, ...patch } });

export function fmtMs(ms: number | null) {
  if (ms == null) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}
export function fmtTokens(n: number) {
  return n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export interface PillExtras {
  page?: { paused: boolean; onPause: (p: boolean) => void };
  exam?: { on: boolean; hidden: number; onToggle: (on: boolean) => void; onReveal: () => void };
  patterns?: { count: number; open: () => void };
}

export function StatusPill({ status, page, exam, patterns }: { status: LiveStatus } & PillExtras) {
  const live = useLive();
  const [open, setOpen] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const mode = MODES.find((m) => m.id === live.mode)!;
  const state = live.mode === 'off' ? 'off' : page?.paused ? 'paused' : status.state;
  const stateText = state === 'off' ? 'off' : state === 'paused' ? 'paused on this page' : state === 'checking' ? 'checking' : state === 'offline' ? 'offline, local check only' : state === 'busy' ? 'AI busy, retrying' : state === 'error' ? 'had a problem' : 'ready';
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`live-pill is-${state} ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        aria-label={`Live check: ${mode.label}, ${stateText}`}
        title={`Live check: ${mode.label} (${stateText})`}
        onClick={() => setOpen(open ? null : btn.current!.getBoundingClientRect())}
      >
        <span className="live-pill-dot" aria-hidden="true" />
        <span className="live-pill-label">Live check</span>
        <span className="live-pill-mode">{state === 'paused' ? 'Paused' : mode.label}</span>
        {exam?.on && live.mode !== 'off' && (
          <span className="live-pill-exam">
            Exam{exam.hidden > 0 && <b aria-label={`${exam.hidden} hidden`}>{exam.hidden}</b>}
          </span>
        )}
        {live.mode !== 'off' && !exam?.on && (status.lastMs != null || status.tokens > 0) && (
          <span className="live-pill-meta">
            {fmtMs(status.lastMs)}
            {live.mode !== 'local' && status.tokens > 0 && <span className="live-pill-tokens"> · {fmtTokens(status.tokens)}</span>}
          </span>
        )}
      </button>
      {open && (
        <Popover anchor={open} onClose={() => setOpen(null)} className="live-pop">
          <LiveModePicker status={status} onDone={() => setOpen(null)} />
          {live.mode !== 'off' && (page || exam || patterns) && (
            <div className="live-pop-extra">
              {exam?.on && exam.hidden !== 0 && (
                <button
                  type="button"
                  className="btn btn-primary btn-md full live-reveal"
                  onClick={() => {
                    exam.onReveal();
                    setOpen(null);
                  }}
                >
                  <Eye size={16} /> {exam.hidden > 0 ? `Reveal ${exam.hidden} mark${exam.hidden === 1 ? '' : 's'}` : 'Reveal marks'}
                </button>
              )}
              {page && <Toggle label="Pause checking on this page" checked={page.paused} onChange={page.onPause} />}
              {exam && <Toggle label="Exam mode" hint="Keep checking quietly; marks show only when you reveal them." checked={exam.on} onChange={exam.onToggle} />}
              {patterns && (
                <button
                  type="button"
                  className="live-pop-row"
                  onClick={() => {
                    setOpen(null);
                    patterns.open();
                  }}
                >
                  <Repeat2 size={15} />
                  <span>Your patterns</span>
                  <span className="live-pop-count">{patterns.count || ''}</span>
                  <ChevronRight size={15} />
                </button>
              )}
            </div>
          )}
        </Popover>
      )}
    </>
  );
}

export function LiveModePicker({ status, onDone, compact = false }: { status: LiveStatus; onDone?: () => void; compact?: boolean }) {
  const live = useLive();
  return (
    <div className="live-modes">
      {!compact && (
        <div className="live-pop-head">
          <span className="live-pop-title">Live check</span>
          <span className="live-pop-sub">Checks handwritten maths as you write.</span>
        </div>
      )}
      <div role="radiogroup" aria-label="Live check mode" className="live-mode-list">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={live.mode === m.id}
            className={`live-mode ${live.mode === m.id ? 'is-on' : ''}`}
            onClick={() => {
              setLive({ mode: m.id });
              if (m.id !== live.mode) onDone?.();
            }}
          >
            <span className="live-mode-icon">{m.icon}</span>
            <span className="live-mode-text">
              <span className="live-mode-label">
                {m.label}
                {m.id === 'smart' && <span className="live-tag">Recommended</span>}
                {(m.id === 'smart' || m.id === 'max') && !status.aiReady && <span className="live-tag is-muted">needs AI</span>}
              </span>
              <span className="live-mode-line">{m.line}</span>
            </span>
            <span className="live-mode-check">{live.mode === m.id && <Check size={15} strokeWidth={2.4} />}</span>
          </button>
        ))}
      </div>
      {live.mode !== 'off' && <HandwritingModel />}
      {!compact && (
        <>
          <div className="live-pop-stats" aria-live="polite">
            <span>
              <b>{fmtMs(status.lastMs)}</b> last check
            </span>
            <span>
              <b>{fmtTokens(status.tokens)}</b> tokens this session
            </span>
          </div>
          <div className="live-pop-toggles">
            <Toggle label="Mark unsure steps" checked={live.underlineUnsure} onChange={(underlineUnsure) => setLive({ underlineUnsure })} />
            <Toggle label="Tick correct lines" checked={live.showTicks} onChange={(showTicks) => setLive({ showTicks })} />
          </div>
          <button
            type="button"
            className="live-pop-more"
            onClick={() => {
              onDone?.();
              openDialog({ type: 'settings' });
            }}
          >
            <Sparkles size={14} /> AI settings…
          </button>
        </>
      )}
    </div>
  );
}

/** Settings → AI: the same choices, plus automatic checking. */
export function LiveSettingsSection({ status }: { status?: LiveStatus }) {
  const live = useLive();
  const keys = useApp((a) => a.settings.ai?.keys.length ?? 0);
  const st: LiveStatus = status ?? { mode: live.mode, state: 'idle', lastMs: null, tokens: 0, aiReady: keys > 0 };
  return (
    <div className="live-settings">
      <h3 className="ai-sub">Live check of handwritten maths</h3>
      <LiveModePicker status={st} compact />
      <Toggle label="Check automatically" hint="Check each step when you lift the pen. Off: only when you right-click or long-press your writing." checked={live.autoCheck} onChange={(autoCheck) => setLive({ autoCheck })} />
      <Toggle label="Mark unsure steps" hint="A quiet amber dotted line where the check is not sure." checked={live.underlineUnsure} onChange={(underlineUnsure) => setLive({ underlineUnsure })} />
      <Toggle label="Tick correct lines" hint="A small green tick at the end of each verified line." checked={live.showTicks} onChange={(showTicks) => setLive({ showTicks })} />
    </div>
  );
}
