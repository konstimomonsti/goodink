import { useEffect, useRef, useState } from 'react';
import { Search, X, Mic, Square, Play, Pause, Trash2, Plus, ChevronUp, ChevronDown } from 'lucide-react';
import type { NotebookSession } from '../engine/session';
import type { Viewport } from '../engine/viewport';
import { STICKER_SETS } from '../engine/stickers';
import { useApp, saveElements, toast } from '../lib/store';
import { uid } from '../lib/util';
import { strokeFromJSON, strokeToJSON, objectBBox } from '../engine/model';
import { bboxUnion, type BBox } from '../engine/geometry';
import { drawInk, drawTexts } from '../engine/render';
import { drawStroke } from '../engine/ink';
import { Button, IconButton, Segmented } from '../ui/primitives';
import type { SavedElement } from '../../shared/types';

export function SearchPanel({ s, vp, onClose, initial }: { s: NotebookSession; vp: Viewport | null; onClose: () => void; initial?: string }) {
  const [q, setQ] = useState(initial ?? '');
  const [i, setI] = useState(0);
  const results = q.trim().length >= 1 ? s.searchDoc(q) : [];
  const go = (k: number) => {
    const r = results[k];
    if (!r || !vp) return;
    setI(k);
    const idx = s.pageIndex(r.pageId);
    const boxes = s.findOnPage(r.pageId, q);
    vp.scrollToPage(idx, true, boxes[0]?.[1]);
    vp.setHighlights(r.pageId, boxes);
  };
  useEffect(() => () => vp?.setHighlights(null, []), [vp]);
  useEffect(() => {
    if (initial) setTimeout(() => go(0), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <aside className="panel" aria-label="Find in notebook">
      <header className="panel-head">
        <div className="lib-search panel-search">
          <Search size={15} />
          <input
            autoFocus
            placeholder="Find in this notebook"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') go(e.shiftKey ? (i - 1 + results.length) % Math.max(1, results.length) : (i + 1) % Math.max(1, results.length));
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <IconButton label="Previous match" onClick={() => go((i - 1 + results.length) % Math.max(1, results.length))} disabled={!results.length}>
          <ChevronUp size={16} />
        </IconButton>
        <IconButton label="Next match" onClick={() => go((i + 1) % Math.max(1, results.length))} disabled={!results.length}>
          <ChevronDown size={16} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="panel-body">
        {q && !results.length && <p className="muted small pad">Nothing found. New handwriting becomes searchable a few seconds after you stop writing.</p>}
        <ul className="hit-list">
          {results.map((r, k) => (
            <li key={r.pageId}>
              <button className={k === i ? 'is-on' : ''} onClick={() => go(k)}>
                <span className="hit-title">
                  Page {r.pageNumber} <span className={`hit-src src-${r.source}`}>{r.source === 'ocr' ? 'handwriting' : r.source === 'pdf' ? 'PDF' : 'typed'}</span>
                </span>
                <span className="hit-snippet">{r.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function elementPreview(el: SavedElement): string {
  const pad = 4;
  const [w, h] = [el.w + pad * 2, el.h + pad * 2];
  const sc = Math.min(120 / w, 90 / h, 3);
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * sc);
  c.height = Math.ceil(h * sc);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(sc, 0, 0, sc, pad * sc, pad * sc);
  const strokes = el.strokes.map(strokeFromJSON);
  for (const s of strokes) if (s.kind === 'highlighter') drawStroke(ctx, s);
  drawInk(ctx, strokes);
  drawTexts(ctx, el.objects);
  return c.toDataURL();
}

export function ElementsPanel({ vp, onClose }: { vp: Viewport | null; onClose: () => void }) {
  const elements = useApp((s) => s.elements);
  const [tab, setTab] = useState<'stickers' | 'mine'>('stickers');
  const [, setSel] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSel((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const hasSel = !!vp?.sel;
  const saveSelection = () => {
    const items = vp?.selectionItems();
    if (!items || !vp?.sel) return;
    if (items.objects.some((o) => o.type === 'image' && o.src.startsWith('asset:'))) {
      toast('Photos stay in their notebook, so elements can only hold ink, shapes, text and stickers.', { kind: 'error' });
    }
    const objects = items.objects.filter((o) => o.type !== 'pdf' && !(o.type === 'image' && o.src.startsWith('asset:')));
    let b: BBox | null = null;
    for (const st of items.strokes) b = bboxUnion(b, st.bbox);
    for (const o of objects) b = bboxUnion(b, objectBBox(o));
    if (!b) return;
    const [x0, y0] = b;
    const el: SavedElement = {
      id: uid(),
      title: 'Element',
      createdAt: Date.now(),
      w: b[2] - b[0],
      h: b[3] - b[1],
      strokes: items.strokes.map((st) => {
        const j = strokeToJSON(st);
        const pts = strokeFromJSON(j).pts.slice();
        for (let k = 0; k < pts.length; k += 3) {
          pts[k] -= x0;
          pts[k + 1] -= y0;
        }
        return strokeToJSON({ ...st, pts });
      }),
      objects: objects.map((o) => ({ ...o, x: o.x - x0, y: o.y - y0 })),
    };
    saveElements([el, ...elements]);
    setTab('mine');
    toast('Saved to your elements');
  };
  return (
    <aside className="panel" aria-label="Elements">
      <header className="panel-head">
        <Segmented label="Elements" value={tab} onChange={setTab} options={[{ value: 'stickers', label: 'Stickers' }, { value: 'mine', label: 'My elements' }]} />
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="panel-body">
        {tab === 'stickers' &&
          STICKER_SETS.map((set) => (
            <section key={set.name} className="sticker-set">
              <h3>{set.name}</h3>
              <div className="sticker-grid">
                {set.items.map((st) => (
                  <button key={st.id} className="sticker" title={st.label} aria-label={`Insert ${st.label}`} onClick={() => vp && vp.insertImageObject(vp.session.pages[vp.pageIndexNow].id, st.src, st.w, st.h)}>
                    <img src={st.src} alt="" draggable={false} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        {tab === 'mine' && (
          <>
            <Button size="sm" disabled={!hasSel} onClick={saveSelection} className="full">
              <Plus size={15} /> Save selection as element
            </Button>
            {!hasSel && <p className="muted small pad">Select something with the lasso, then save it here to reuse it in any notebook.</p>}
            <div className="sticker-grid mine">
              {elements.map((el) => (
                <div key={el.id} className="sticker mine-item">
                  <button
                    title="Insert"
                    onClick={() => {
                      const strokes = el.strokes.map((j) => strokeFromJSON(j));
                      vp?.insertElement(strokes, el.objects, [0, 0, el.w, el.h]);
                    }}
                  >
                    <ElementThumb el={el} />
                  </button>
                  <IconButton label="Delete element" className="mine-del" onClick={() => saveElements(elements.filter((x) => x.id !== el.id))}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

const previewCache = new Map<string, string>();
function ElementThumb({ el }: { el: SavedElement }) {
  let url = previewCache.get(el.id);
  if (!url) {
    url = elementPreview(el);
    previewCache.set(el.id, url);
  }
  return <img src={url} alt="" draggable={false} />;
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function AudioPanel({ s, currentPageId, onClose }: { s: NotebookSession; currentPageId: string; onClose: () => void }) {
  const [, force] = useState(0);
  const [rec, setRec] = useState<{ mr: MediaRecorder; started: number; chunks: Blob[]; stream: MediaStream } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<string, string>());
  const [pos, setPos] = useState(0);
  useEffect(() => s.on((e) => e.type === 'doc' && force((n) => n + 1)), [s]);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [rec]);
  useEffect(
    () => () => {
      audio.current?.pause();
      for (const u of urls.current.values()) URL.revokeObjectURL(u);
      rec?.stream.getTracks().forEach((t) => t.stop());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.start(1000);
      setRec({ mr, started: Date.now(), chunks, stream });
    } catch {
      toast('No microphone available. Check Windows privacy settings for microphone access.', { kind: 'error', ms: 6000 });
    }
  };

  const stop = async () => {
    if (!rec) return;
    const { mr, chunks, started, stream } = rec;
    await new Promise<void>((r) => {
      mr.onstop = () => r();
      mr.stop();
    });
    stream.getTracks().forEach((t) => t.stop());
    setRec(null);
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const asset = await s.addAsset(bytes, 'webm');
    const d = new Date(started);
    s.patchDoc({
      recordings: [
        ...s.doc.recordings,
        { id: uid(), asset, title: `Recording ${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`, duration: (Date.now() - started) / 1000, createdAt: started, pageId: currentPageId },
      ],
    });
  };

  const play = async (id: string, asset: string) => {
    if (playing === id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    let url = urls.current.get(asset);
    if (!url) {
      url = URL.createObjectURL(new Blob([(await s.assetBytes(asset)) as BlobPart], { type: 'audio/webm' }));
      urls.current.set(asset, url);
    }
    audio.current?.pause();
    const a = new Audio(url);
    audio.current = a;
    a.ontimeupdate = () => setPos(a.currentTime);
    a.onended = () => setPlaying(null);
    await a.play();
    setPlaying(id);
  };

  return (
    <aside className="panel" aria-label="Recordings">
      <header className="panel-head">
        <h2 className="panel-title">Recordings</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="panel-body">
        <div className={`rec-box ${rec ? 'is-rec' : ''}`}>
          {rec ? (
            <>
              <span className="rec-dot" aria-hidden />
              <span className="rec-time">{fmt((now - rec.started) / 1000)}</span>
              <Button variant="danger" onClick={() => void stop()}>
                <Square size={14} fill="currentColor" /> Stop
              </Button>
            </>
          ) : (
            <Button variant="primary" className="full" onClick={() => void start()}>
              <Mic size={16} /> Record audio
            </Button>
          )}
        </div>
        {s.doc.recordings.length === 0 && !rec && <p className="muted small pad">Record a lecture or meeting while you write. Recordings are saved inside this notebook.</p>}
        <ul className="rec-list">
          {[...s.doc.recordings].reverse().map((r) => (
            <li key={r.id}>
              <IconButton label={playing === r.id ? 'Pause' : 'Play'} onClick={() => void play(r.id, r.asset)}>
                {playing === r.id ? <Pause size={16} /> : <Play size={16} />}
              </IconButton>
              <div className="rec-meta">
                <span className="ellipsis">{r.title}</span>
                <span className="muted small">
                  {playing === r.id ? `${fmt(pos)} / ` : ''}
                  {fmt(r.duration)}
                </span>
                {playing === r.id && (
                  <input
                    type="range"
                    min={0}
                    max={r.duration}
                    step={0.1}
                    value={pos}
                    aria-label="Seek"
                    onChange={(e) => {
                      if (audio.current) audio.current.currentTime = +e.target.value;
                    }}
                  />
                )}
              </div>
              <IconButton label="Delete recording" onClick={() => s.patchDoc({ recordings: s.doc.recordings.filter((x) => x.id !== r.id) })}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
