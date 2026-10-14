// What the page shows of the engine's marks, and when (docs/live-ink/ARCHITECTURE.md §B):
//   red  no sooner than 900 ms after pen-up; held while the pen works on that line, until a 1.5 s
//        pause or the pen moves to a new line; at most 3 per page, the rest as a "+n" margin dot
//   amber and ticks at settle; ticks fade after 4 s unless "show ticks" is on
//   a fixed step gets one 600 ms green tick fade
//   exam mode hides everything until Reveal; a paused page shows nothing
// Pure logic, no DOM: the live layer feeds it and pushes the result to the viewport.
import type { BBox } from '../contract';
import type { UiDecoration } from './engineApi';
import { LIVE_TUNING as T } from './tuning';

export interface GateOptions {
  off: boolean;
  showTicks: boolean;
  underlineUnsure: boolean;
}

const vOverlap = (a: BBox, b: BBox) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > Math.min(a[3] - a[1], b[3] - b[1]) * 0.4;

export class MarkGate {
  private raw = new Map<string, UiDecoration[]>();
  /** red marks already released (they stay until the engine drops them) */
  private released = new Set<string>();
  private tickSeen = new Map<string, number>();
  private fixed = new Map<string, { d: UiDecoration; until: number }>();
  private recentErr: { pageId: string; bbox: BBox; at: number }[] = [];
  private pen = { pageId: '', x: 0, y: 0, down: false, upAt: -1e9 };
  readonly paused = new Set<string>();
  exam = false;
  revealed = false;
  ring: { pageId: string; bbox: BBox } | null = null;
  opts: GateOptions = { off: false, showTicks: false, underlineUnsure: true };

  constructor(private now: () => number = () => performance.now()) {}

  pages() {
    return [...this.raw.keys()];
  }

  /** The pen went down / up (from the viewport, twice per stroke). */
  penActivity(pageId: string, x: number, y: number, down: boolean) {
    this.pen.pageId = pageId;
    this.pen.x = x;
    this.pen.y = y;
    this.pen.down = down;
    if (!down) this.pen.upAt = this.now();
  }

  /** New marks from the engine for a page. Returns ids of steps that were just fixed. */
  setRaw(pageId: string, decos: UiDecoration[]) {
    const now = this.now();
    const before = this.raw.get(pageId) ?? [];
    const ids = new Set(decos.map((d) => d.id));
    for (const d of before)
      if (!ids.has(d.id) && d.kind === 'error') {
        this.released.delete(d.id);
        this.recentErr.push({ pageId, bbox: d.bbox, at: now });
      }
    this.recentErr = this.recentErr.filter((r) => now - r.at < T.fixedWindowMs);
    const had = new Set(before.map((d) => d.id));
    for (const d of decos) {
      if (d.kind !== 'ok' || had.has(d.id)) continue;
      const k = this.recentErr.findIndex((r) => r.pageId === pageId && vOverlap(r.bbox, d.bbox));
      if (k >= 0) {
        // an error on this line just turned into a correct step: the one small celebration
        this.recentErr.splice(k, 1);
        this.fixed.set(`fix:${d.id}`, { d: { ...d, id: `fix:${d.id}`, kind: 'fixed' }, until: now + T.fixedMs + 80 });
        this.tickSeen.set(d.id, -1e12); // its ordinary transient tick is replaced by the fix fade
      } else if (!this.tickSeen.has(d.id)) this.tickSeen.set(d.id, now);
    }
    this.raw.set(pageId, decos);
  }

  /** Release every held red mark now (exam Reveal). */
  revealAll() {
    this.revealed = true;
    for (const list of this.raw.values()) for (const d of list) if (d.kind === 'error') this.released.add(d.id);
  }

  /** When a held red mark may appear, or 0 if now. */
  private holdUntil(d: UiDecoration, pageId: string, now: number) {
    const p = this.pen;
    if (p.pageId !== pageId) return 0;
    const lineH = Math.max(4, d.bbox[3] - d.bbox[1]);
    const dy = Math.abs(p.y - (d.bbox[1] + d.bbox[3]) / 2);
    if (dy > lineH * T.redHoldLineHeights) return 0;
    if (p.down) return now + 250;
    let until = p.upAt + T.redAfterPenUpMs;
    // still on that same line: wait for a real pause
    if (dy <= lineH * T.newLineLineHeights) until = Math.max(until, p.upAt + T.redHoldPauseMs);
    return until > now ? until : 0;
  }

  /** What to draw on a page now, when to look again, and red marks that just appeared. */
  compute(pageId: string): { decos: UiDecoration[]; nextAt: number | null; appeared: UiDecoration[]; hidden: number } {
    const now = this.now();
    const out: UiDecoration[] = [];
    const appeared: UiDecoration[] = [];
    let nextAt: number | null = null;
    const later = (t: number) => (nextAt = nextAt == null ? t : Math.min(nextAt, t));
    if (this.opts.off || this.paused.has(pageId)) return { decos: out, nextAt, appeared, hidden: 0 };
    const raw = this.raw.get(pageId) ?? [];
    const hide = this.exam && !this.revealed;
    let hidden = 0;
    const reds: UiDecoration[] = [];
    for (const d of [...raw].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
      if (d.kind === 'error') {
        if (hide) {
          hidden++;
          continue;
        }
        if (!this.released.has(d.id)) {
          const t = this.holdUntil(d, pageId, now);
          if (t) {
            later(t);
            continue;
          }
          this.released.add(d.id);
          appeared.push(d);
        }
        reds.push(d);
      } else if (d.kind === 'unsure') {
        if (hide) hidden++;
        else if (this.opts.underlineUnsure) out.push(d);
      } else if (d.kind === 'ok') {
        if (hide) continue;
        if (this.opts.showTicks) out.push(d);
        else {
          const seen = this.tickSeen.get(d.id) ?? now;
          const end = seen + T.tickShowMs + T.tickFadeMs;
          if (now < end) {
            out.push({ ...d, transient: true });
            later(end);
          }
        }
      } else if (!hide) out.push(d); // results and future kinds
    }
    out.push(...reds.slice(0, T.maxRedPerPage));
    if (reds.length > T.maxRedPerPage) {
      const first = reds[T.maxRedPerPage];
      // in the margin left of the writing, level with the first mark that is not shown
      const left = Math.min(...reds.map((r) => r.bbox[0])) - Math.max(10, (first.bbox[3] - first.bbox[1]) * 0.6);
      out.push({ ...first, underline: { ...first.underline, x1: left, x2: left }, id: `more:${pageId}`, kind: 'more', text: `+${reds.length - T.maxRedPerPage}`, title: `${reds.length - T.maxRedPerPage} more` });
    }
    for (const [id, f] of this.fixed) {
      if (f.d.pageId !== pageId) continue;
      if (f.until <= now) this.fixed.delete(id);
      else {
        out.push(f.d);
        later(f.until);
      }
    }
    // reading order: Tab moves through the marks top to bottom, left to right
    out.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    if (this.ring?.pageId === pageId) out.push({ id: `ring:${pageId}`, pageId, kind: 'ring', bbox: this.ring.bbox, underline: { x1: 0, x2: 0, y: 0 }, blockId: '', lineId: '' });
    return { decos: out, nextAt, appeared, hidden };
  }
}
