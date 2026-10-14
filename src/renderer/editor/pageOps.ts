import type { PageMeta, PageSizeId, Template } from '../../shared/types';
import { PAGE_SIZES } from '../../shared/types';
import type { NotebookSession } from '../engine/session';
import { uid } from '../lib/util';
import { toast } from '../lib/store';
import { strokeFromJSON, strokeToJSON } from '../engine/model';

function blankLike(p: PageMeta, template?: Template): PageMeta {
  // A new page after a PDF page keeps the PDF's size but gets plain paper.
  if (p.infinite) return { id: uid(), w: 3000, h: 3000, ox: -1500, oy: -1500, template: template ?? p.template, rotation: 0, infinite: true };
  return { id: uid(), w: p.w, h: p.h, template: template ?? (p.bg ? { kind: 'blank', paper: 'white' } : p.template), rotation: 0 };
}

export function addPage(s: NotebookSession, at: number, where: 'before' | 'after' | 'end' = 'after', template?: Template): number {
  const pages = [...s.pages];
  const ref = pages[Math.min(at, pages.length - 1)];
  const np = blankLike(ref, template);
  const idx = where === 'end' ? pages.length : where === 'before' ? at : at + 1;
  pages.splice(idx, 0, np);
  s.setPages(pages, { focus: np.id });
  return idx;
}

export async function duplicatePages(s: NotebookSession, indices: number[]): Promise<number> {
  const pages = [...s.pages];
  const sorted = [...indices].sort((a, b) => a - b);
  let offset = 0;
  let last = 0;
  for (const i of sorted) {
    const src = s.pages[i];
    const content = await s.ensure(src.id);
    const copy: PageMeta = { ...src, id: uid(), bookmarked: false };
    // deep-copy strokes so the two pages never share identities
    s.commit(copy.id, { strokes: content.strokes.map((st) => strokeFromJSON({ ...strokeToJSON(st), id: uid() })), objects: content.objects.map((o) => ({ ...o, id: uid() })) }, { record: false });
    last = i + 1 + offset;
    pages.splice(last, 0, copy);
    offset++;
  }
  s.setPages(pages, { focus: pages[last].id });
  return last;
}

export function deletePages(s: NotebookSession, indices: number[]) {
  if (indices.length >= s.pages.length) {
    toast('A notebook needs at least one page.', { kind: 'error' });
    return false;
  }
  const kill = new Set(indices.map((i) => s.pages[i].id));
  const next = s.pages.filter((p) => !kill.has(p.id));
  s.setPages(next, { focus: next[Math.min(indices[0], next.length - 1)].id });
  toast(`Deleted ${indices.length} page${indices.length === 1 ? '' : 's'}`, { action: { label: 'Undo', run: () => s.undo() } });
  return true;
}

export function movePages(s: NotebookSession, indices: number[], to: number) {
  const set = new Set(indices);
  const moving = s.pages.filter((_, i) => set.has(i));
  const rest = s.pages.filter((_, i) => !set.has(i));
  const before = s.pages.slice(0, to).filter((_, i) => !set.has(i)).length;
  rest.splice(before, 0, ...moving);
  if (rest.every((p, i) => p === s.pages[i])) return;
  s.setPages(rest, { focus: moving[0].id });
}

export function rotatePages(s: NotebookSession, indices: number[], dir: 1 | -1 = 1) {
  const set = new Set(indices);
  s.setPages(s.pages.map((p, i) => (set.has(i) ? { ...p, rotation: (((p.rotation + dir * 90) % 360) + 360) % 360 as PageMeta['rotation'] } : p)));
}

export function toggleBookmark(s: NotebookSession, i: number) {
  s.setPages(s.pages.map((p, k) => (k === i ? { ...p, bookmarked: !p.bookmarked } : p)));
}

export type PageLayout = { size: PageSizeId | 'infinite'; landscape: boolean };

function sized(p: PageMeta, layout: PageLayout): PageMeta {
  if (p.bg) return p; // PDF and image pages keep their own size
  if (layout.size === 'infinite') return p.infinite ? p : { ...p, w: 3000 + p.w, h: 3000 + p.h, ox: -1500, oy: -1500, infinite: true };
  const sz = PAGE_SIZES[layout.size];
  const [w, h] = layout.landscape ? [sz.h, sz.w] : [sz.w, sz.h];
  return { ...p, w, h, infinite: false, ox: undefined, oy: undefined };
}

/** Change paper template and page size together, as one undo step. */
export function setLayout(s: NotebookSession, indices: number[] | 'all', template: Template, layout: PageLayout | null) {
  const set = indices === 'all' ? null : new Set(indices);
  s.setPages(s.pages.map((p, i) => (!set || set.has(i) ? (layout ? sized({ ...p, template }, layout) : { ...p, template }) : p)));
}

export function addLayoutPage(s: NotebookSession, at: number, template: Template, layout: PageLayout | null): number {
  const pages = [...s.pages];
  const ref = pages[at];
  let np: PageMeta = { id: uid(), w: ref.w, h: ref.h, template, rotation: 0, infinite: ref.infinite };
  if (layout) np = sized(np, layout);
  else if (ref.bg) np = { ...np, template };
  if (np.infinite) np = { ...np, w: 3000, h: 3000, ox: -1500, oy: -1500 };
  pages.splice(at + 1, 0, np);
  s.setPages(pages, { focus: np.id });
  return at + 1;
}

export function setTemplate(s: NotebookSession, indices: number[] | 'all', template: Template) {
  const set = indices === 'all' ? null : new Set(indices);
  s.setPages(s.pages.map((p, i) => (!set || set.has(i) ? { ...p, template } : p)));
}

export function parseRange(input: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of input.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}
