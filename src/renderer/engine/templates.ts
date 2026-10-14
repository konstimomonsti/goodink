// Paper templates as drawing primitives, so the same description renders to canvas and to PDF.
import type { PaperColor, Template, TemplateKind } from '../../shared/types';

export type Prim =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; c: string; dash?: number[] }
  | { t: 'dot'; x: number; y: number; r: number; c: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; c: string; lw: number; r?: number }
  | { t: 'text'; x: number; y: number; s: number; c: string; str: string };

export const PAPER: Record<PaperColor, { bg: string; line: string; strong: string; accent: string; label: string; ink: string }> = {
  white: { bg: '#ffffff', line: '#c8d3e6', strong: '#a9b6cd', accent: '#e8a0a0', label: '#9aa3b5', ink: '#1b1b1f' },
  cream: { bg: '#fbf6e8', line: '#dccfb2', strong: '#c7b691', accent: '#e3a58e', label: '#ad9d7c', ink: '#2a2418' },
  dark: { bg: '#24242a', line: '#3f3f48', strong: '#55555f', accent: '#7a4b4b', label: '#77778a', ink: '#f1f1f4' },
};

export const TEMPLATE_LIST: { kind: TemplateKind; label: string; group: 'Basic' | 'Writing' | 'Study' | 'Planning' }[] = [
  { kind: 'blank', label: 'Blank', group: 'Basic' },
  { kind: 'dotted', label: 'Dotted', group: 'Basic' },
  { kind: 'grid', label: 'Grid', group: 'Basic' },
  { kind: 'grid-small', label: 'Fine grid', group: 'Basic' },
  { kind: 'isometric', label: 'Isometric', group: 'Basic' },
  { kind: 'ruled-narrow', label: 'Narrow ruled', group: 'Writing' },
  { kind: 'ruled-college', label: 'College ruled', group: 'Writing' },
  { kind: 'ruled-wide', label: 'Wide ruled', group: 'Writing' },
  { kind: 'music', label: 'Music staff', group: 'Writing' },
  { kind: 'cornell', label: 'Cornell notes', group: 'Study' },
  { kind: 'flashcard', label: 'Flashcard', group: 'Study' },
  { kind: 'todo', label: 'Checklist', group: 'Planning' },
  { kind: 'daily', label: 'Day planner', group: 'Planning' },
  { kind: 'weekly', label: 'Week planner', group: 'Planning' },
];

const MM = 72 / 25.4;

function ruled(w: number, h: number, sp: number, p: (typeof PAPER)[PaperColor], margin: boolean): Prim[] {
  const out: Prim[] = [];
  const top = Math.max(sp * 2.6, 56);
  for (let y = top; y < h - sp * 0.6; y += sp) out.push({ t: 'line', x1: 0, y1: y, x2: w, y2: y, w: 0.6, c: p.line });
  // pages wider than any paper size are infinite canvases: keep the margin where it is as they grow
  const mx = w > 1500 ? 78 : w * 0.13;
  if (margin) out.push({ t: 'line', x1: mx, y1: 0, x2: mx, y2: h, w: 0.7, c: p.accent });
  return out;
}

export function templatePrims(t: Template, w: number, h: number): Prim[] {
  const p = PAPER[t.paper];
  const out: Prim[] = [];
  switch (t.kind) {
    case 'blank':
      return out;
    case 'ruled-narrow':
      return ruled(w, h, 6.35 * MM, p, true);
    case 'ruled-college':
      return ruled(w, h, 7.1 * MM, p, true);
    case 'ruled-wide':
      return ruled(w, h, 8.7 * MM, p, true);
    case 'grid':
    case 'grid-small': {
      const sp = t.kind === 'grid' ? 5 * MM : 3.5 * MM;
      const ox = (w % sp) / 2, oy = (h % sp) / 2;
      for (let x = ox; x <= w; x += sp) out.push({ t: 'line', x1: x, y1: 0, x2: x, y2: h, w: 0.45, c: p.line });
      for (let y = oy; y <= h; y += sp) out.push({ t: 'line', x1: 0, y1: y, x2: w, y2: y, w: 0.45, c: p.line });
      return out;
    }
    case 'dotted': {
      const sp = 5 * MM;
      const ox = (w % sp) / 2, oy = (h % sp) / 2;
      for (let y = oy; y <= h; y += sp) for (let x = ox; x <= w; x += sp) out.push({ t: 'dot', x, y, r: 0.75, c: p.strong });
      return out;
    }
    case 'isometric': {
      const sp = 6 * MM;
      const dy = (sp * Math.sqrt(3)) / 2;
      let row = 0;
      for (let y = dy / 2; y <= h; y += dy, row++) for (let x = row % 2 ? sp / 2 : 0; x <= w; x += sp) out.push({ t: 'dot', x, y, r: 0.7, c: p.strong });
      return out;
    }
    case 'cornell': {
      const sp = 7.1 * MM;
      const head = 70;
      const cue = w * 0.3;
      const summary = h * 0.78;
      out.push({ t: 'line', x1: 0, y1: head, x2: w, y2: head, w: 1.1, c: p.strong });
      for (let y = head + sp; y < summary - 4; y += sp) out.push({ t: 'line', x1: cue, y1: y, x2: w, y2: y, w: 0.55, c: p.line });
      out.push({ t: 'line', x1: cue, y1: head, x2: cue, y2: summary, w: 1.1, c: p.strong });
      out.push({ t: 'line', x1: 0, y1: summary, x2: w, y2: summary, w: 1.1, c: p.strong });
      out.push({ t: 'text', x: 18, y: head + 18, s: 8, c: p.label, str: 'CUES' });
      out.push({ t: 'text', x: cue + 14, y: head + 18, s: 8, c: p.label, str: 'NOTES' });
      out.push({ t: 'text', x: 18, y: summary + 18, s: 8, c: p.label, str: 'SUMMARY' });
      return out;
    }
    case 'music': {
      const gap = 7;
      const block = gap * 4 + 34;
      for (let y0 = 60; y0 + gap * 4 < h - 40; y0 += block)
        for (let i = 0; i < 5; i++) out.push({ t: 'line', x1: 36, y1: y0 + i * gap, x2: w - 36, y2: y0 + i * gap, w: 0.6, c: p.strong });
      return out;
    }
    case 'todo': {
      const sp = 9 * MM;
      out.push({ t: 'text', x: 40, y: 50, s: 9, c: p.label, str: 'TO DO' });
      out.push({ t: 'line', x1: 40, y1: 60, x2: w - 40, y2: 60, w: 1, c: p.strong });
      for (let y = 60 + sp; y < h - 30; y += sp) {
        out.push({ t: 'rect', x: 44, y: y - 15, w: 11, h: 11, c: p.strong, lw: 0.9, r: 2 });
        out.push({ t: 'line', x1: 66, y1: y, x2: w - 40, y2: y, w: 0.55, c: p.line });
      }
      return out;
    }
    case 'daily': {
      out.push({ t: 'text', x: 40, y: 48, s: 9, c: p.label, str: 'DATE' });
      out.push({ t: 'line', x1: 80, y1: 50, x2: w * 0.55, y2: 50, w: 0.8, c: p.strong });
      const top = 80, bottom = h - 40, hours = 16;
      const sp = (bottom - top) / hours;
      const split = w * 0.62;
      for (let i = 0; i <= hours; i++) {
        const y = top + i * sp;
        out.push({ t: 'line', x1: 40, y1: y, x2: split - 16, y2: y, w: i % 4 === 0 ? 0.9 : 0.5, c: i % 4 === 0 ? p.strong : p.line });
        if (i < hours) out.push({ t: 'text', x: 42, y: y + 11, s: 7, c: p.label, str: `${String(6 + i).padStart(2, '0')}:00` });
      }
      out.push({ t: 'text', x: split, y: top - 8, s: 8, c: p.label, str: 'PRIORITIES' });
      for (let i = 0; i < 6; i++) out.push({ t: 'rect', x: split, y: top + 6 + i * 26, w: 10, h: 10, c: p.strong, lw: 0.8, r: 2 });
      out.push({ t: 'text', x: split, y: top + 190, s: 8, c: p.label, str: 'NOTES' });
      for (let y = top + 210; y < bottom; y += 22) out.push({ t: 'line', x1: split, y1: y, x2: w - 40, y2: y, w: 0.5, c: p.line });
      return out;
    }
    case 'weekly': {
      const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY', 'NOTES'];
      const m = 32, top = 60;
      const cw = (w - m * 2 - 12) / 2, ch = (h - top - m - 36) / 4;
      out.push({ t: 'text', x: m, y: 40, s: 9, c: p.label, str: 'WEEK OF' });
      out.push({ t: 'line', x1: m + 52, y1: 42, x2: w * 0.5, y2: 42, w: 0.8, c: p.strong });
      days.forEach((d, i) => {
        const x = m + (i % 2) * (cw + 12), y = top + Math.floor(i / 2) * (ch + 12);
        out.push({ t: 'rect', x, y, w: cw, h: ch, c: p.strong, lw: 0.8, r: 6 });
        out.push({ t: 'text', x: x + 10, y: y + 16, s: 7.5, c: p.label, str: d });
      });
      return out;
    }
    case 'flashcard': {
      out.push({ t: 'line', x1: 24, y1: h / 2, x2: w - 24, y2: h / 2, w: 0.9, c: p.strong, dash: [5, 4] });
      out.push({ t: 'text', x: 24, y: 28, s: 8, c: p.label, str: 'FRONT' });
      out.push({ t: 'text', x: 24, y: h / 2 + 20, s: 8, c: p.label, str: 'BACK' });
      return out;
    }
  }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** clip (page units, x0,y0,x1,y1): skip primitives outside it — huge infinite pages draw only what is visible. */
export function drawPrims(ctx: Ctx, all: Prim[], clip?: [number, number, number, number]) {
  const prims = clip
    ? all.filter((p) =>
        p.t === 'line'
          ? Math.max(p.x1, p.x2) >= clip[0] && Math.min(p.x1, p.x2) <= clip[2] && Math.max(p.y1, p.y2) >= clip[1] && Math.min(p.y1, p.y2) <= clip[3]
          : p.t === 'dot'
            ? p.x >= clip[0] - 2 && p.x <= clip[2] + 2 && p.y >= clip[1] - 2 && p.y <= clip[3] + 2
            : p.x <= clip[2] && p.y <= clip[3] && p.x + (p.t === 'rect' ? p.w : 200) >= clip[0] && p.y + (p.t === 'rect' ? p.h : 20) >= clip[1],
      )
    : all;
  // Batch lines of the same style into one path: a grid page is hundreds of lines.
  let curKey = '';
  const flush = () => {
    if (curKey) ctx.stroke();
    curKey = '';
  };
  for (const pr of prims) {
    if (pr.t === 'line') {
      const key = `${pr.c}|${pr.w}|${pr.dash?.join(',') ?? ''}`;
      if (key !== curKey) {
        flush();
        curKey = key;
        ctx.strokeStyle = pr.c;
        ctx.lineWidth = pr.w;
        ctx.setLineDash(pr.dash ?? []);
        ctx.beginPath();
      }
      ctx.moveTo(pr.x1, pr.y1);
      ctx.lineTo(pr.x2, pr.y2);
    }
  }
  flush();
  ctx.setLineDash([]);
  let dotColor = '';
  for (const pr of prims) {
    if (pr.t === 'dot') {
      if (pr.c !== dotColor) {
        if (dotColor) ctx.fill();
        dotColor = pr.c;
        ctx.fillStyle = pr.c;
        ctx.beginPath();
      }
      ctx.moveTo(pr.x + pr.r, pr.y);
      ctx.arc(pr.x, pr.y, pr.r, 0, Math.PI * 2);
    }
  }
  if (dotColor) ctx.fill();
  for (const pr of prims) {
    if (pr.t === 'rect') {
      ctx.strokeStyle = pr.c;
      ctx.lineWidth = pr.lw;
      ctx.beginPath();
      ctx.roundRect(pr.x, pr.y, pr.w, pr.h, pr.r ?? 0);
      ctx.stroke();
    } else if (pr.t === 'text') {
      ctx.fillStyle = pr.c;
      ctx.font = `600 ${pr.s}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
      ctx.fillText(pr.str, pr.x, pr.y);
    }
  }
}

/**
 * Infinite canvas: periodic papers are anchored to the world origin and generated only for the
 * requested area, so the pattern never shifts as the page grows and huge pages stay cheap.
 */
export function worldPrims(t: Template, x0: number, y0: number, x1: number, y1: number, maxDots = 250_000): Prim[] {
  const p = PAPER[t.paper];
  const out: Prim[] = [];
  const range = (a: number, b: number, sp: number, f: (v: number) => void) => {
    for (let v = Math.ceil(a / sp) * sp; v <= b; v += sp) f(v);
  };
  switch (t.kind) {
    case 'ruled-narrow':
    case 'ruled-college':
    case 'ruled-wide': {
      const sp = (t.kind === 'ruled-narrow' ? 6.35 : t.kind === 'ruled-college' ? 7.1 : 8.7) * MM;
      range(y0, y1, sp, (y) => out.push({ t: 'line', x1: x0, y1: y, x2: x1, y2: y, w: 0.6, c: p.line }));
      if (78 >= x0 && 78 <= x1) out.push({ t: 'line', x1: 78, y1: y0, x2: 78, y2: y1, w: 0.7, c: p.accent });
      return out;
    }
    case 'grid':
    case 'grid-small': {
      const sp = t.kind === 'grid' ? 5 * MM : 3.5 * MM;
      range(x0, x1, sp, (x) => out.push({ t: 'line', x1: x, y1: y0, x2: x, y2: y1, w: 0.45, c: p.line }));
      range(y0, y1, sp, (y) => out.push({ t: 'line', x1: x0, y1: y, x2: x1, y2: y, w: 0.45, c: p.line }));
      return out;
    }
    case 'dotted': {
      const sp = 5 * MM;
      if (((x1 - x0) / sp) * ((y1 - y0) / sp) > maxDots) return out;
      range(y0, y1, sp, (y) => range(x0, x1, sp, (x) => out.push({ t: 'dot', x, y, r: 0.75, c: p.strong })));
      return out;
    }
    case 'isometric': {
      const sp = 6 * MM;
      const dy = (sp * Math.sqrt(3)) / 2;
      if (((x1 - x0) / sp) * ((y1 - y0) / dy) > maxDots) return out;
      range(y0, y1, dy, (y) => {
        const shift = Math.round(y / dy) % 2 ? sp / 2 : 0;
        range(x0 - shift, x1 - shift, sp, (x) => out.push({ t: 'dot', x: x + shift, y, r: 0.7, c: p.strong }));
      });
      return out;
    }
    case 'blank':
      return out;
    default:
      // layouts that are not repeating patterns sit once at the world origin
      return templatePrims(t, 595.28, 841.89);
  }
}

const primCache = new Map<string, Prim[]>();
export function cachedPrims(t: Template, w: number, h: number): Prim[] {
  const key = `${t.kind}|${t.paper}|${w.toFixed(1)}|${h.toFixed(1)}`;
  let p = primCache.get(key);
  if (!p) {
    p = templatePrims(t, w, h);
    if (primCache.size > 64) primCache.clear();
    primCache.set(key, p);
  }
  return p;
}
