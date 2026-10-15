// The insight card: opened from recognised ink (right-click, pen barrel, long-press). Shows what was
// read (editable), the verdict and why, a hint ladder that never gives the answer before asked,
// Copy LaTeX / Convert to text, and an ask box (keyboard or voice) whose answers stream in.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, CircleAlert, CircleHelp, CircleCheck, Pencil, ScanText, Sparkles, X, Lightbulb, Footprints, Wand2, WifiOff, CornerDownLeft, Shuffle, MessageCircleQuestion } from 'lucide-react';
import type { Insight, Issue, LineRecognition } from '../contract';
import type { JournalEntry, LiveStatus, LiveUiEngine, Turn } from './engineApi';
import { LIVE_TUNING as T } from './tuning';
import type { Viewport } from '../../engine/viewport';
import { MathHtml, RichText } from '../../ui/Math';
import { Button, IconButton, Spinner } from '../../ui/primitives';
import { toast } from '../../lib/store';
import { FreeAiSetup } from '../../editor/AiDialogs';
import { useAnchored } from './anchor';
import { lineTex } from './latex';
import { StreamText } from './StreamText';
import { AskBar } from './AskBar';

type Msg = { role: 'user' | 'assistant'; text: string; streaming?: boolean; error?: boolean; label?: string };
type HintStep = { level: 1 | 2 | 3; text: string; streaming: boolean; error?: boolean };

const HINT_LABEL = { 1: 'Hint', 2: 'Next step', 3: 'Fix' } as const;
const HINT_NEXT = { 1: 'Hint', 2: 'Next step', 3: 'Show fix' } as const;
const HINT_ICON = { 1: <Lightbulb size={14} />, 2: <Footprints size={14} />, 3: <Wand2 size={14} /> } as const;

export function InsightCard({ vp, engine, status, initial, question, onClose, onConvert, onPractice, onListening, onIssue }: { vp: Viewport; engine: LiveUiEngine; status: LiveStatus; initial: Insight; question?: string; onClose: () => void; onConvert: (ins: Insight) => void; onPractice?: (ins: Insight) => void; onListening?: (on: boolean, ins: Insight) => void; onIssue?: (e: JournalEntry) => void }) {
  const [ins, setIns] = useState(initial);
  const [editing, setEditing] = useState<{ lineId: string; text: string } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [hints, setHints] = useState<HintStep[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [follow, setFollow] = useState<string[]>([]);
  const [setup, setSetup] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  // the engine's updates keep the line the card is about
  useEffect(() => engine.onInsight(initial.block.id, (i) => setIns((cur) => ({ ...i, focusLineId: cur.focusLineId ?? i.focusLineId }))), [engine, initial.block.id]);
  // "Show fix" unlocks after one hint, or after a while of thinking on your own
  const [fixOpen, setFixOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFixOpen(true), T.fixUnlockMs);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => () => abort.current?.abort(), []);

  // beside the whole block, with the arrow pointing at the line the card is about
  const anchorLine = ins.block.lines.find((l) => l.id === (ins.focusLineId ?? ins.check?.issues[0]?.lineId)) ?? null;
  useAnchored(
    vp,
    card,
    () => {
      const b = vp.pageRectToClient(ins.pageId, ins.block.bbox);
      const l = anchorLine && vp.pageRectToClient(ins.pageId, anchorLine.bbox);
      return b && l ? new DOMRect(b.x, l.y, b.width, l.height) : b;
    },
    [ins.block.bbox, ins.pageId, anchorLine],
  );

  // focus moves into the card; Esc closes it (or ends the reading edit first)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    card.current?.focus({ preventScroll: true });
    return () => {
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (editing) setEditing(null);
      else onClose();
    };
    // a pointer down outside the card (on the page, the toolbar…) closes it
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (card.current?.contains(t) || t.closest?.('.popover, .menu, .toast, .modal')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [editing, onClose]);

  const check = ins.check;
  const recs = check?.recognition.lines ?? [];
  const issues = check?.issues ?? [];
  const focusId = ins.focusLineId ?? issues[0]?.lineId ?? recs[0]?.lineId ?? null;
  const issue: Issue | null = issues.find((i) => i.lineId === focusId) ?? issues.find((i) => i.severity === 'error') ?? issues[0] ?? null;
  const verdict = rechecking || !check ? 'pending' : issue?.severity === 'error' ? 'error' : issue?.severity === 'unsure' ? 'unsure' : check.lines.some((l) => l.verdict === 'ok') ? 'ok' : 'none';
  const lowRead = recs.find((r) => r.lineId === focusId)?.confidence ?? 1;
  const busy = msgs.some((m) => m.streaming) || hints.some((h) => h.streaming);
  const carried = !!check?.lines.some((l) => l.carried);
  const hasFix = hints.some((h) => h.level === 3);
  const nextLevel = Math.min(2, hints.filter((h) => h.level < 3).length + 1) as 1 | 2;
  const canNext = hints.filter((h) => h.level < 3).length < 2 && !hasFix;

  // confirmed mistakes go to the journal ("Your patterns")
  useEffect(() => {
    if (!check || !issue || issue.severity !== 'error') return;
    const line = recs.find((r) => r.lineId === issue.lineId)?.text;
    onIssue?.({ id: issue.lineId, at: Date.now(), title: issue.title, tag: issue.misconception, line, fix: issue.fix, detail: issue.detail, pageId: ins.pageId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check, issue?.lineId, issue?.title]);

  // keep the newest streamed text in view
  useEffect(() => {
    const el = body.current;
    if (el && (busy || msgs.length)) el.scrollTop = el.scrollHeight;
  }, [msgs, hints, busy]);

  const latexAll = useMemo(() => recs.map((r) => r.latex || r.text).join(' \\\\\n'), [recs]);

  const saveReading = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    setEditing(null);
    if (!text || text === recs.find((r) => r.lineId === editing.lineId)?.text) return;
    setRechecking(true);
    setHints([]);
    try {
      const c = await engine.recheck(ins.block.id, editing.lineId, text);
      if (c) setIns((cur) => ({ ...cur, check: c, focusLineId: editing.lineId }));
    } catch {
      toast('Could not re-check this line.', { kind: 'error' });
    } finally {
      setRechecking(false);
    }
  };

  const nextHint = async (level: 1 | 2 | 3) => {
    if (busy || hints.some((h) => h.level === level)) return;
    if (level === 1) setFixOpen(true);
    abort.current = new AbortController();
    setHints((h) => [...h, { level, text: '', streaming: true }]);
    const set = (patch: Partial<HintStep>) => setHints((h) => h.map((x) => (x.level === level ? { ...x, ...patch } : x)));
    try {
      const text = await engine.hint(ins, level, { onDelta: (t) => set({ text: t }), signal: abort.current.signal });
      set({ text, streaming: false });
    } catch (e) {
      // without AI, the local check's own hint and fix still work
      const local = level === 1 ? issue?.hint : level === 3 && issue?.fix ? `The line should read $${issue.fix}$.` : undefined;
      if (local) set({ text: local, streaming: false });
      else if ((e as Error).name === 'AbortError') set({ streaming: false });
      else {
        set({ text: status.aiReady ? 'Could not get a hint right now. Try again in a moment.' : 'The next step needs AI. Set up free AI below.', streaming: false, error: true });
        if (!status.aiReady) setSetup(true);
      }
    }
  };

  const ask = useCallback(
    async (q: string) => {
      if (!status.aiReady) {
        setSetup(true);
        return;
      }
      const history: Turn[] = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
      setFollow([]);
      setMsgs((m) => [...m, { role: 'user', text: q }, { role: 'assistant', text: '', streaming: true }]);
      const setLast = (patch: Partial<Msg>) => setMsgs((m) => m.map((x, k) => (k === m.length - 1 ? { ...x, ...patch } : x)));
      abort.current = new AbortController();
      try {
        const r = await engine.ask({ insight: ins }, q, history, { onDelta: (t) => setLast({ text: t }), signal: abort.current.signal });
        setLast({ text: r.text, streaming: false });
        setFollow(r.followUps.slice(0, 3));
      } catch (e) {
        if ((e as Error).name === 'AbortError') setLast({ streaming: false });
        else setLast({ text: (e as Error).message || 'Something went wrong.', streaming: false, error: true });
      }
    },
    [engine, ins, msgs, status.aiReady],
  );

  // opened by a spoken question: answer it straight away, once
  const asked = useRef(false);
  useEffect(() => {
    if (!question || asked.current) return;
    asked.current = true;
    void ask(question);
  }, [question, ask]);

  /** Explain-back: one short comprehension question once the fix is shown. */
  const quiz = async () => {
    if (busy) return;
    if (!status.aiReady) return setSetup(true);
    setMsgs((m) => [...m, { role: 'assistant', text: '', streaming: true, label: 'Check yourself' }]);
    const setLast = (patch: Partial<Msg>) => setMsgs((m) => m.map((x, k) => (k === m.length - 1 ? { ...x, ...patch } : x)));
    abort.current = new AbortController();
    try {
      const opts = { onDelta: (t: string) => setLast({ text: t }), signal: abort.current.signal };
      const text = engine.explainBack
        ? await engine.explainBack(ins, opts)
        : (await engine.ask({ insight: ins }, 'Ask me one short question that checks I understood this fix. Do not answer it.', [], opts)).text;
      setLast({ text, streaming: false });
    } catch (e) {
      setLast({ text: (e as Error).name === 'AbortError' ? '' : (e as Error).message, streaming: false, error: (e as Error).name !== 'AbortError' });
    }
  };

  const copyLatex = () => void navigator.clipboard.writeText(latexAll).then(() => toast('LaTeX copied'));

  return (
    <div ref={card} className={`live-card is-${verdict}`} role="dialog" aria-label="Insight about your handwriting" tabIndex={-1} onPointerDown={(e) => e.stopPropagation()}>
      <span className="live-arrow" aria-hidden="true" />
      <header className="live-card-head">
        <VerdictChip verdict={verdict} />
        <span className="live-src" title={check ? `Checked in ${check.ms} ms` : undefined}>
          {check && !rechecking ? sourceLabel(check.via, issue) : ''}
        </span>
        <IconButton label="Close (Esc)" className="live-x" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>

      <div className="live-card-body" ref={body} onScroll={(e) => card.current?.classList.toggle('is-scrolled', e.currentTarget.scrollTop > 2)}>
        {status.state === 'offline' && (
          <p className="live-banner">
            <WifiOff size={14} /> Offline: checked on this PC only.
          </p>
        )}
        <section className="live-reading" aria-label="What I read">
          <div className="live-label">
            <span>{lowRead < 0.8 ? 'Is this what you wrote?' : 'I read'}</span>
            {recs.length > 0 && !editing && (
              <button type="button" className={`live-link ${lowRead < 0.8 ? 'is-strong' : ''}`} onClick={() => setEditing({ lineId: focusId ?? recs[0].lineId, text: recs.find((r) => r.lineId === focusId)?.text ?? recs[0].text })}>
                <Pencil size={12} /> Edit reading
              </button>
            )}
          </div>
          {!check && !rechecking ? (
            <div className="live-skel" aria-label="Reading your handwriting">
              <span />
              <span />
            </div>
          ) : (
            <ol className="live-lines">
              {recs.map((r) => (
                <ReadingLine key={r.lineId} r={r} issue={issues.find((i) => i.lineId === r.lineId) ?? null} focus={r.lineId === focusId} editing={editing?.lineId === r.lineId ? editing.text : null} onEdit={(text) => setEditing({ lineId: r.lineId, text })} onSave={() => void saveReading()} onCancel={() => setEditing(null)} />
              ))}
            </ol>
          )}
        </section>

        {verdict === 'pending' && (
          <p className="live-status" aria-live="polite">
            <Spinner size={13} /> {rechecking ? 'Checking again…' : status.slow ? 'Taking a little longer than usual…' : 'Checking your work…'}
          </p>
        )}
        {verdict !== 'pending' && issue && (
          <section className={`live-issue is-${issue.severity}`} aria-live="polite">
            <h3>{issue.title}</h3>
            <p>
              <RichText text={issue.detail} />
            </p>
            {carried && issue.severity === 'error' && (
              <p className="live-carried">
                <Check size={13} /> Your next steps follow correctly from this.
              </p>
            )}
          </section>
        )}
        {verdict === 'ok' && (
          <section className="live-issue is-ok" aria-live="polite">
            <h3>Every step checks out</h3>
            <p>Each line follows from the one before it.</p>
          </section>
        )}

        {verdict === 'error' && (
          <section className="live-hints" aria-label="Hints">
            {hints.map((h) => (
              <div key={h.level} className={`live-hint ${h.error ? 'is-error' : ''}`}>
                <span className="live-hint-k">
                  {HINT_ICON[h.level]} {HINT_LABEL[h.level]}
                </span>
                {h.streaming && !h.text ? <span className="live-dots" aria-label="Thinking" /> : <StreamText text={h.text} streaming={h.streaming} />}
              </div>
            ))}
            {!hasFix ? (
              <div className="live-ladder" role="group" aria-label="Help, one step at a time">
                {canNext && (
                  <Button size="sm" variant={hints.length ? 'secondary' : 'primary'} disabled={busy} onClick={() => void nextHint(nextLevel)}>
                    {HINT_ICON[nextLevel]} {HINT_NEXT[nextLevel]}
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="live-fix-btn" disabled={busy || !fixOpen} title={fixOpen ? 'Show the corrected step' : 'Try a hint first'} onClick={() => void nextHint(3)}>
                  {HINT_ICON[3]} {HINT_NEXT[3]}
                </Button>
                <span className="live-steps" aria-label={`${hints.length} of 3 steps shown`}>
                  {[1, 2, 3].map((k) => (
                    <i key={k} className={hints.some((h) => h.level === k) ? 'is-done' : k === nextLevel && canNext ? 'is-next' : ''} />
                  ))}
                </span>
              </div>
            ) : (
              !busy &&
              !msgs.some((m) => m.label) && (
                <div className="live-ladder">
                  <Button size="sm" variant="secondary" onClick={() => void quiz()}>
                    <MessageCircleQuestion size={14} /> Check I got it
                  </Button>
                </div>
              )
            )}
          </section>
        )}

        {msgs.length > 0 && (
          <section className="live-chat" aria-live="polite">
            {msgs.map((m, k) =>
              m.role === 'user' ? (
                <div key={k} className="live-msg is-user">
                  {m.text}
                </div>
              ) : (
                <div key={k} className={`live-msg is-ai ${m.error ? 'is-error' : ''} ${m.label ? 'is-quiz' : ''}`}>
                  {m.label && <span className="live-hint-k">{m.label}</span>}
                  {m.streaming && !m.text ? <span className="live-dots" aria-label="Thinking" /> : m.error ? m.text : <StreamText text={m.text} streaming={!!m.streaming} />}
                </div>
              ),
            )}
          </section>
        )}
        {follow.length > 0 && !busy && (
          <div className="live-follow">
            {follow.map((f) => (
              <button key={f} type="button" className="live-chip" onClick={() => void ask(f)}>
                <CornerDownLeft size={12} /> {f}
              </button>
            ))}
          </div>
        )}
        {setup && (
          <div className="live-setup">
            <FreeAiSetup compact />
          </div>
        )}
      </div>

      <footer className="live-card-foot">
        <div className="live-tools">
          <button type="button" className="live-tool" onClick={copyLatex} disabled={!recs.length}>
            <Copy size={14} /> Copy LaTeX
          </button>
          <button type="button" className="live-tool" onClick={() => onConvert(ins)} disabled={!recs.length}>
            <ScanText size={14} /> To text
          </button>
          {onPractice && recs.some((r) => r.kind === 'math') && (verdict === 'error' || verdict === 'ok') && (
            <button type="button" className="live-tool" onClick={() => onPractice(ins)} title="A practice problem like this one with different numbers, placed below and checked as you write">
              <Shuffle size={14} /> New numbers
            </button>
          )}
          {!status.aiReady && !setup && (
            <button type="button" className="live-tool is-accent" onClick={() => setSetup(true)}>
              <Sparkles size={14} /> Set up free AI
            </button>
          )}
        </div>
        <AskBar engine={engine} busy={busy} onStop={() => abort.current?.abort()} onSend={(q) => void ask(q)} placeholder={msgs.length ? 'Ask a follow-up…' : 'Ask about this step…'} label="Ask about this step" onListening={(on) => onListening?.(on, ins)} />
      </footer>
    </div>
  );
}

function ReadingLine({ r, issue, focus, editing, onEdit, onSave, onCancel }: { r: LineRecognition; issue: Issue | null; focus: boolean; editing: string | null; onEdit: (t: string) => void; onSave: () => void; onCancel: () => void }) {
  const tex = lineTex(r, issue);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing != null) input.current?.select();
  }, [editing != null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (editing != null)
    return (
      <li className="live-line is-editing">
        <input
          ref={input}
          className="input live-edit"
          value={editing}
          spellCheck={false}
          aria-label="Correct the reading"
          onChange={(e) => onEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSave();
            }
          }}
        />
        <span className="live-edit-row">
          <span className="muted small">Fix what I misread; it is checked again.</span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={onSave}>
            <Check size={14} /> Check
          </Button>
        </span>
      </li>
    );
  return (
    <li className={`live-line ${focus ? 'is-focus' : ''} ${issue ? `is-${issue.severity}` : ''}`} title={r.text}>
      {tex ? <MathHtml tex={tex} display={false} /> : <span className="live-prose">{r.text}</span>}
    </li>
  );
}

function VerdictChip({ verdict }: { verdict: 'pending' | 'error' | 'unsure' | 'ok' | 'none' }) {
  const v = {
    pending: { icon: <Spinner size={12} />, label: 'Checking' },
    error: { icon: <CircleAlert size={14} />, label: 'Mistake' },
    unsure: { icon: <CircleHelp size={14} />, label: 'Not sure' },
    ok: { icon: <CircleCheck size={14} />, label: 'Correct' },
    none: { icon: <Check size={14} />, label: 'Read' },
  }[verdict];
  return (
    <span className={`live-verdict is-${verdict}`} role="status">
      {v.icon}
      {v.label}
    </span>
  );
}

function sourceLabel(via: 'local' | 'ai' | 'cache', issue: Issue | null) {
  if (issue?.source === 'ai-verified') return 'AI · double-checked';
  if (issue?.source === 'ai' || via === 'ai') return 'Checked by AI';
  return 'Checked on this PC';
}
