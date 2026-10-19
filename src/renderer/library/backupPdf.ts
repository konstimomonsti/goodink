// A folder or the whole library as PDF: one file with a bookmark per folder and notebook, or one
// PDF per notebook in a tree of folders like the library's. Each notebook goes through the normal
// exporter (ink as vectors, imported PDFs copied as they are) and is closed again unless it is open
// in a tab, so a big library never sits in memory at once. Locked notebooks and flashcard decks are
// left out (their pages are not plain pages to print).
import { PDFDocument, PDFHexString, PDFName, PDFNull, type PDFRef, type PDFPage } from 'pdf-lib';
import type { Folder, NotebookMeta } from '../../shared/types';
import { exportPdf } from '../engine/export';
import { diskName, getSession, sessions, treeOf, useApp, flushEverything } from '../lib/store';
import { api } from '../lib/api';

export interface TreePdfOptions {
  includeAnnotations: boolean;
  includeTemplates: boolean;
  onProgress?(done: number, total: number, title: string): void;
  /** checked between notebooks: stops early */
  cancelled?(): boolean;
}

export interface TreePdfResult {
  notebooks: number;
  pages: number;
  skipped: string[];
  files: string[];
}

/** Notebooks to print, in library order (folders depth-first, then by title), with the folder path. */
function plan(folderId: string | null) {
  const t = treeOf(folderId);
  const byFolder = (id: string | null) => t.notebooks.filter((n) => n.folderId === id).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  const pathOf = (f: Folder | undefined): Folder[] => {
    const out: Folder[] = [];
    const lib = useApp.getState().library;
    for (let x = f; x; x = lib.folders.find((y) => y.id === x!.parentId)) {
      out.unshift(x);
      if (x.id === folderId) break;
    }
    return out;
  };
  const order: { nb: NotebookMeta; path: Folder[] }[] = [];
  if (!folderId) for (const nb of byFolder(null)) order.push({ nb, path: [] });
  for (const f of t.folders) for (const nb of byFolder(f.id)) order.push({ nb, path: pathOf(f) });
  const printable = order.filter((o) => !o.nb.lock && (o.nb.kind ?? 'notebook') !== 'flashcards');
  const skipped = order.filter((o) => !printable.includes(o)).map((o) => o.nb.title);
  return { printable, skipped };
}

async function notebookPdf(nb: NotebookMeta, o: TreePdfOptions): Promise<{ bytes: Uint8Array; pages: number } | null> {
  const wasOpen = sessions.has(nb.id);
  const s = await getSession(nb.id);
  try {
    if (!s.pages.length) return null;
    const bytes = await exportPdf(s, { pages: s.pages.map((_, i) => i), includeAnnotations: o.includeAnnotations, includeTemplates: o.includeTemplates });
    return { bytes, pages: s.pages.length };
  } finally {
    if (!wasOpen && !useApp.getState().tabs.includes(nb.id)) {
      sessions.delete(nb.id);
      await s.close();
    }
  }
}

type Mark = { title: string; page: PDFPage; children: Mark[] };

/** Bookmarks (the PDF outline): one per folder, with its notebooks under it. */
function addOutline(doc: PDFDocument, marks: Mark[]) {
  if (!marks.length) return;
  const ctx = doc.context;
  const root = ctx.nextRef();
  const build = (list: Mark[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((m, i) => {
      const d = new Map<string, unknown>([
        ['Title', PDFHexString.fromText(m.title)],
        ['Parent', parent],
        ['Dest', ctx.obj([m.page.ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull])],
      ]);
      if (i > 0) d.set('Prev', refs[i - 1]);
      if (i < list.length - 1) d.set('Next', refs[i + 1]);
      if (m.children.length) {
        const sub = build(m.children, refs[i]);
        d.set('First', sub.first);
        d.set('Last', sub.last);
        // open folders show their notebooks
        d.set('Count', ctx.obj(sub.count));
        count += sub.count;
      }
      const dict = ctx.obj({});
      for (const [k, v] of d) dict.set(PDFName.of(k), v as never);
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const top = build(marks, root);
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Everything in one PDF, with bookmarks. */
export async function treeToOnePdf(folderId: string | null, target: string, o: TreePdfOptions): Promise<TreePdfResult> {
  await flushEverything();
  const { printable, skipped } = plan(folderId);
  const out = await PDFDocument.create();
  const title = folderId ? (useApp.getState().library.folders.find((f) => f.id === folderId)?.title ?? 'Folder') : 'goodink library';
  out.setTitle(title);
  out.setCreator('goodink');
  out.setProducer('goodink');
  const marks: Mark[] = [];
  // the bookmark list of each folder path, made on first use
  const folderMarks = new Map<string, Mark[]>();
  const listFor = (path: Folder[], page: PDFPage): Mark[] => {
    let list = marks;
    // a single folder's PDF starts inside that folder
    for (const f of folderId ? path.slice(1) : path) {
      let m = folderMarks.get(f.id);
      if (!m) {
        const mark: Mark = { title: f.title, page, children: [] };
        list.push(mark);
        folderMarks.set(f.id, mark.children);
        m = mark.children;
      }
      list = m;
    }
    return list;
  };
  let done = 0;
  for (const { nb, path } of printable) {
    if (o.cancelled?.()) break;
    o.onProgress?.(done, printable.length, nb.title);
    const pdf = await notebookPdf(nb, o);
    done++;
    if (!pdf) continue;
    const src = await PDFDocument.load(pdf.bytes, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    listFor(path, pages[0]).push({ title: nb.title, page: pages[0], children: [] });
  }
  o.onProgress?.(done, printable.length, '');
  addOutline(out, marks);
  const pageCount = out.getPageCount();
  if (!pageCount) return { notebooks: 0, pages: 0, skipped, files: [] };
  await api.writeFile(target, await out.save());
  return { notebooks: done, pages: pageCount, skipped, files: [target] };
}

/** One PDF per notebook, in folders named like the library's, inside `dir`. */
export async function treeToPdfFiles(folderId: string | null, dir: string, o: TreePdfOptions): Promise<TreePdfResult> {
  await flushEverything();
  const { printable, skipped } = plan(folderId);
  const top = diskName(folderId ? (useApp.getState().library.folders.find((f) => f.id === folderId)?.title ?? 'Folder') : 'goodink library');
  const sep = dir.includes('\\') ? '\\' : '/';
  const taken = new Set<string>();
  const files: string[] = [];
  let pages = 0;
  let done = 0;
  for (const { nb, path } of printable) {
    if (o.cancelled?.()) break;
    o.onProgress?.(done, printable.length, nb.title);
    const pdf = await notebookPdf(nb, o);
    done++;
    if (!pdf) continue;
    const parts = [dir.replace(/[\\/]+$/, ''), top, ...(folderId ? path.slice(1) : path).map((f) => diskName(f.title))];
    let file = [...parts, `${diskName(nb.title)}.pdf`].join(sep);
    for (let k = 2; taken.has(file.toLowerCase()); k++) file = [...parts, `${diskName(nb.title)} (${k}).pdf`].join(sep);
    taken.add(file.toLowerCase());
    await api.writeFile(file, pdf.bytes);
    files.push(file);
    pages += pdf.pages;
  }
  o.onProgress?.(done, printable.length, '');
  return { notebooks: files.length, pages, skipped, files };
}
