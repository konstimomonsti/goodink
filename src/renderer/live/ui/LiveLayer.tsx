// Live Ink Intelligence in the editor: connects the engine to the viewport (marks, through the timing
// gate), the toolbar (status pill), the floating cards (insight card, AI selector), the mistake
// journal and a polite screen-reader announcer. Loaded lazily by the editor.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import type { TextObject } from '../../../shared/types';
import type { AiRegion, Viewport } from '../../engine/viewport';
import type { NotebookSession } from '../../engine/session';
import type { BBox } from '../contract';
import { textHeight } from '../../engine/render';
import { uid, clamp } from '../../lib/util';
import { toast } from '../../lib/store';
import type { Insight, JournalEntry, LiveStatus, LiveUiEngine, UiDecoration } from './engineApi';
import { createUiEngine } from './adapter';
import { StatusPill, setLive, useLive } from './StatusPill';
import { InsightCard } from './InsightCard';
import { AiCard } from './AiCard';
import { VoiceAsk } from './VoiceAsk';
import { CircleAsk } from './CircleAsk';
import { classify, enclosingLoops, inkOf } from '../recog/geom';
import { MarkGate } from './markGate';
import { PatternsDialog, loadJournal, saveJournal } from './Patterns';
import { LIVE_TUNING as T } from './tuning';

/** What the editor's viewport callbacks call into (set by the layer once it is loaded). */
export interface LiveBridge {
  onInkContext?(pageId: string, x: number, y: number, clientX: number, clientY: number): void;
  onAiRegion?(r: AiRegion | null): void;
  onPenActivity?(pageId: string, x: number, y: number, down: boolean): void;
}

type AiCardState = { id: string; region: AiRegion; pinned: boolean; question?: string };

/** Exam mode and paused pages outlive the layer (it unmounts when the tab is in the background). */
const sessionState = new Map<string, { gate: MarkGate }>();

export default function LiveLayer({ vp, s, slot, bridge, pageId }: { vp: Viewport; s: NotebookSession; slot: HTMLElement | null; bridge: MutableRefObject<LiveBridge>; pageId: string }) {
  const live = useLive();
  const [engine, setEngine] = useState<LiveUiEngine | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ mode: live.mode, state: 'idle', lastMs: null, tokens: 0, aiReady: false });
  const [card, setCard] = useState<Insight | null>(null);
  // the question a card was opened with by voice (answered as soon as it opens)
  const [cardQ, setCardQ] = useState<string | undefined>();
  const [ai, setAi] = useState<AiCardState[]>([]);
  // a loop just drawn with the pen around ink: offer to ask about it
  const [loop, setLoop] = useState<{ pageId: string; bbox: BBox; pts: number[] } | null>(null);
  const [patterns, setPatterns] = useState(false);
  const [journal, setJournal] = useState<JournalEntry[]>(() => loadJournal(s.id));
  const [announce, setAnnounce] = useState('');
  const [, setTick] = useState(0);
  const gate = (sessionState.get(s.id) ?? sessionState.set(s.id, { gate: new MarkGate() }).get(s.id)!).gate;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPen = useRef(0);
  const sigs = useRef(new Map<string, string>());
  const liveRef = useRef(live);
  liveRef.current = live;
  const engineRef = useRef<LiveUiEngine | null>(null);
  engineRef.current = engine;

  useEffect(() => {
    let on = true;
    let made: LiveUiEngine | null = null;
    void createUiEngine(s).then((e) => {
      if (!on) return e.dispose?.();
      made = e;
      setEngine(e);
      setStatus(e.status());
      if (gate.exam) e.setExam?.(true);
      for (const p of gate.paused) e.pausePage?.(p, true);
      // paused pages are remembered by the engine per notebook
      for (const p of s.pages) if (e.isPaused?.(p.id)) gate.paused.add(p.id);
    });
    return () => {
      on = false;
      made?.dispose?.();
    };
  }, [s, gate]);

  useEffect(() => engine?.onStatus(setStatus), [engine]);
  useEffect(() => engine?.setMode(live.mode), [engine, live.mode]);

  // ---- marks: engine → gate → viewport ----
  const record = useCallback(
    (entries: JournalEntry[]) => {
      if (!entries.length) return;
      setJournal((cur) => {
        const byId = new Map(cur.map((e) => [e.id, e]));
        for (const e of entries) byId.set(e.id, { ...byId.get(e.id), ...e, at: byId.get(e.id)?.at ?? e.at });
        const next = [...byId.values()];
        saveJournal(s.id, next);
        return next;
      });
    },
    [s.id],
  );

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    let next: number | null = null;
    const appeared: UiDecoration[] = [];
    for (const id of gate.pages()) {
      const r = gate.compute(id, vp.visiblePageBox(id));
      // only touch the page when what it shows changed (scrolling re-runs this)
      const sig = r.decos.map((d) => `${d.id}|${d.kind}|${d.text ?? ''}|${d.transient ? 1 : 0}|${d.bbox.join(',')}`).join(';');
      if (sigs.current.get(id) !== sig) {
        sigs.current.set(id, sig);
        vp.setLiveDecorations(id, r.decos);
      }
      appeared.push(...r.appeared);
      if (r.nextAt != null) next = next == null ? r.nextAt : Math.min(next, r.nextAt);
    }
    if (next != null) timer.current = setTimeout(flush, Math.max(16, next - performance.now()));
    if (appeared.length) {
      record(appeared.map((d) => ({ id: d.lineId || d.id, at: Date.now(), title: d.title ?? 'Mistake', pageId: d.pageId })));
      // a screen reader hears about it once the writer pauses
      if (announceTimer.current) clearTimeout(announceTimer.current);
      const say = () => {
        const wait = lastPen.current + T.announceAfterMs - performance.now();
        if (wait > 0) return void (announceTimer.current = setTimeout(say, wait));
        const n = appeared.length;
        setAnnounce(n === 1 ? `Possible mistake: ${appeared[0].title ?? 'check this step'}. Press Tab to reach it on the page.` : `${n} possible mistakes on the page. Press Tab to reach them.`);
      };
      say();
    }
    setTick((n) => n + 1); // exam "hidden" count in the pill
  }, [gate, record, vp]);

  useEffect(() => {
    gate.opts = { off: live.mode === 'off', showTicks: live.showTicks, underlineUnsure: live.underlineUnsure, engineTiming: !!(engine?.notePenActivity && engine.reveal) };
    flush();
  }, [gate, flush, engine, live.mode, live.showTicks, live.underlineUnsure]);

  useEffect(
    () =>
      engine?.onDecorations((id, d) => {
        gate.setRaw(id, d);
        flush();
      }),
    [engine, gate, flush],
  );
  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(announceTimer.current);
  }, []);
  // "per screen": which red marks show depends on what is in view
  useEffect(() => {
    let raf = 0;
    const off = vp.onView(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          flush();
        });
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [vp, flush]);

  // ---- viewport → layer ----
  useEffect(() => {
    bridge.current.onInkContext = (pid, x, y) => {
      const e = engineRef.current;
      if (!e) return;
      if (liveRef.current.mode === 'off') {
        toast('Live check is off.', { action: { label: 'Turn on', run: () => setLive({ mode: 'local' }) } });
        return;
      }
      if (gate.paused.has(pid)) {
        toast('Checking is paused on this page.', { action: { label: 'Resume', run: () => setPaused(pid, false) } });
        return;
      }
      const ins = e.insightAt(pid, x, y);
      if (ins) {
        setCardQ(undefined);
        setCard(ins);
      }
    };
    bridge.current.onAiRegion = (r) => {
      setAi((list) => {
        const kept = list.filter((c) => c.pinned);
        return r ? [...kept, { id: uid(), region: r, pinned: false }] : kept;
      });
    };
    bridge.current.onPenActivity = (pid, x, y, down) => {
      if (down) setLoop(null);
      else circledAt(pid);
      gate.penActivity(pid, x, y, down);
      lastPen.current = performance.now();
      engineRef.current?.notePenActivity?.(pid, x, y, down);
      // held red marks re-time themselves from the new pen-up
      if (!down) flush();
    };
    return () => {
      bridge.current.onInkContext = undefined;
      bridge.current.onAiRegion = undefined;
      bridge.current.onPenActivity = undefined;
    };
  });

  /** Was the stroke just finished a loop around ink? Only nearby strokes are looked at (cheap). */
  const circledAt = (pid: string) => {
    if (liveRef.current.mode === 'off') return;
    const c = s.content(pid);
    const last = c?.strokes[c.strokes.length - 1];
    if (!c || !last || last.kind !== 'pen' || last.shape || last.pts.length < 3 * 24) return;
    const [x0, y0, x1, y1] = last.bbox;
    const near = c.strokes.filter((k) => k.kind === 'pen' && !k.shape && k.bbox[0] < x1 && k.bbox[2] > x0 && k.bbox[1] < y1 && k.bbox[3] > y0);
    if (near.length < 2) return;
    const inks = near.map((k) => inkOf(k));
    const unit = classify(inks);
    const mine = inks[near.indexOf(last)];
    if (!enclosingLoops(inks, unit).has(mine)) return;
    const pts: number[] = [];
    for (let i = 0; i < last.pts.length; i += 3) pts.push(last.pts[i], last.pts[i + 1]);
    setLoop({ pageId: pid, bbox: last.bbox, pts });
  };
  const askLoop = () => {
    if (!loop) return;
    const region = { pageId: loop.pageId, pts: loop.pts, bbox: loop.bbox };
    setLoop(null);
    setAi((list) => [...list.filter((c) => c.pinned), { id: uid(), region, pinned: false }]);
  };
  const dismissLoop = useCallback(() => setLoop(null), []);

  // ---- pause, exam ----
  const setPaused = (pid: string, paused: boolean) => {
    if (paused) gate.paused.add(pid);
    else gate.paused.delete(pid);
    engineRef.current?.pausePage?.(pid, paused);
    flush();
  };
  const setExam = (on: boolean) => {
    gate.exam = on;
    gate.revealed = false;
    engineRef.current?.setExam?.(on);
    flush();
  };
  const reveal = () => {
    engineRef.current?.reveal?.();
    gate.revealAll();
    flush();
  };
  // -1: the engine holds the marks and does not say how many
  let hidden = gate.opts.engineTiming && gate.exam && !gate.revealed ? -1 : 0;
  if (!gate.opts.engineTiming && gate.exam && !gate.revealed) for (const id of gate.pages()) hidden += gate.compute(id).hidden;

  // ---- cards ----
  const closeAi = useCallback(
    (id: string) => {
      setAi((list) => {
        const c = list.find((x) => x.id === id);
        if (c && !c.pinned) vp.clearAiRegion();
        return list.filter((x) => x.id !== id);
      });
    },
    [vp],
  );
  const pinAi = (id: string, pinned: boolean) => {
    // a pinned card keeps its answer; the glow on the page goes so you can keep working
    if (pinned) vp.clearAiRegion();
    setAi((list) => list.map((x) => (x.id === id ? { ...x, pinned } : x)));
  };

  const setRing = useCallback(
    (pid: string | null, bbox?: BBox) => {
      gate.ring = pid && bbox ? { pageId: pid, bbox } : null;
      flush();
    },
    [gate, flush],
  );

  const convert = (ins: Insight) => {
    const c = s.content(ins.pageId);
    const recs = ins.check?.recognition.lines ?? [];
    if (!c || !recs.length) return;
    const ids = new Set(ins.block.lines.flatMap((l) => l.strokeIds));
    const [x0, y0, x1] = ins.block.bbox;
    const lineH = ins.block.lines.reduce((a, l) => a + (l.bbox[3] - l.bbox[1]), 0) / Math.max(1, ins.block.lines.length);
    const color = c.strokes.find((st) => ids.has(st.id))?.color ?? '#1b1b1f';
    const obj: TextObject = { id: uid(), type: 'text', x: x0, y: y0, w: Math.max(80, x1 - x0 + 24), h: 10, rot: 0, text: recs.map((r) => r.text).join('\n'), font: 'sans', size: clamp(Math.round(lineH * 0.62), 9, 48), color, align: 'left' };
    obj.h = textHeight(obj);
    s.commit(ins.pageId, { strokes: c.strokes.filter((st) => !ids.has(st.id)), objects: [...c.objects, obj] });
    setCard(null);
    toast('Converted to text', { kind: 'success', action: { label: 'Undo', run: () => s.undo() } });
  };

  /** Same problem, new numbers: a practice box under the block, written in like any other ink. */
  const practice = async (ins: Insight) => {
    const first = ins.check?.recognition.lines.find((l) => l.kind === 'math')?.text;
    if (!first) return;
    const { math } = await import('../math');
    const v = math.variant?.(first, Math.floor(Math.random() * 1e9));
    if (!v) return toast('No practice version for this one yet.');
    const c = s.content(ins.pageId);
    if (!c) return;
    const [x0, , x1, y1] = ins.block.bbox;
    const lineH = ins.block.lines[0] ? ins.block.lines[0].bbox[3] - ins.block.lines[0].bbox[1] : 20;
    const size = clamp(Math.round(lineH * 0.55), 11, 28);
    const obj: TextObject = { id: uid(), type: 'text', x: x0, y: y1 + lineH * 1.6, w: Math.max(200, x1 - x0 + 40), h: 10, rot: 0, text: `Practice · same problem, new numbers\n${v.problem}`, font: 'sans', size, color: '#2f5b8a', align: 'left', bgColor: '#eef3fa' };
    obj.h = textHeight(obj);
    s.commit(ins.pageId, { ...c, objects: [...c.objects, obj] });
    setCard(null);
    toast('Practice problem added below. Solve it right under the box; each step is checked.', { kind: 'success', ms: 6000, action: { label: 'Undo', run: () => s.undo() } });
  };

  /** Asked by voice: the tutor opens on the block being written, or on what is on screen. */
  const voiceAsk = (q: string) => {
    const t = engineRef.current?.deicticTarget?.();
    setRing(null);
    if (t) {
      setCardQ(q);
      setCard(t);
      return;
    }
    const region = vp.visibleRegion();
    if (!region) return toast('Open a page to ask about it.');
    setAi((list) => [...list.filter((c) => c.pinned), { id: uid(), region, pinned: false, question: q }]);
  };
  const voiceRing = (on: boolean) => {
    const t = on ? engineRef.current?.deicticTarget?.() : null;
    setRing(t ? t.pageId : null, t?.block.bbox);
  };

  const closeCard = useCallback(() => {
    setCard(null);
    setRing(null);
  }, [setRing]);

  const allJournal = engine?.journal ? mergeJournal(journal, engine.journal()) : journal;

  return (
    <>
      {slot &&
        createPortal(
          <>
          <VoiceAsk engine={engine} onAsk={voiceAsk} onListening={voiceRing} />
          <StatusPill
            status={{ ...status, mode: live.mode }}
            page={{ paused: gate.paused.has(pageId), onPause: (p) => setPaused(pageId, p) }}
            exam={{ on: gate.exam, hidden, onToggle: setExam, onReveal: reveal }}
            patterns={{ count: allJournal.length, open: () => setPatterns(true) }}
          />
          </>,
          slot,
        )}
      {engine &&
        card &&
        createPortal(
          <InsightCard
            key={card.block.id + (cardQ ?? "")}
            vp={vp}
            engine={engine}
            status={status}
            initial={card}
            question={cardQ}
            onEdited={() => (gate.noFixUntil = performance.now() + 5000)}
            onClose={closeCard}
            onConvert={convert}
            onPractice={(i) => void practice(i)}
            onListening={(on, ins) => setRing(on ? ins.pageId : null, ins.block.bbox)}
            onIssue={(e) => record([e])}
          />,
          document.body,
        )}
      {engine &&
        ai.map((c) =>
          createPortal(<AiCard key={c.id} vp={vp} engine={engine} status={status} region={c.region} question={c.question} pinned={c.pinned} onPin={(p) => pinAi(c.id, p)} onClose={() => closeAi(c.id)} onListening={(on) => {
              // "why?", "this": the block under the pen or written last gets a hairline ring while listening
              const t = on ? engine.deicticTarget?.() : null;
              setRing(t ? t.pageId : null, t?.block.bbox);
            }} />, document.body, c.id),
        )}
      {loop && createPortal(<CircleAsk vp={vp} pageId={loop.pageId} bbox={loop.bbox} onAsk={askLoop} onDismiss={dismissLoop} />, document.body)}
      {patterns && <PatternsDialog entries={allJournal} engine={engine} onClose={() => setPatterns(false)} />}
      {createPortal(
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>,
        document.body,
      )}
    </>
  );
}

function mergeJournal(a: JournalEntry[], b: JournalEntry[]) {
  const m = new Map(a.map((e) => [e.id, e]));
  for (const e of b) m.set(e.id, { ...m.get(e.id), ...e });
  return [...m.values()];
}
