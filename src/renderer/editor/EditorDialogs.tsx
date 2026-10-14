import { useEffect, useState } from 'react';
import type { PageMeta, PageSizeId, Template } from '../../shared/types';
import { PAGE_SIZES } from '../../shared/types';
import { closeDialog, getSession, toast, updateToast, dismissToast, exportBackup, useApp } from '../lib/store';
import { api } from '../lib/api';
import { exportPagePng, exportPdf, pageDataUrl } from '../engine/export';
import type { NotebookSession } from '../engine/session';
import { Button, Field, Modal, Segmented, Toggle } from '../ui/primitives';
import { TemplateGrid } from '../library/Dialogs';
import { parseRange, setLayout, addLayoutPage, type PageLayout } from './pageOps';

function useSession(nbId: string) {
  const [s, setS] = useState<NotebookSession | null>(null);
  useEffect(() => {
    void getSession(nbId).then(setS);
  }, [nbId]);
  return s;
}

const safeName = (t: string) => t.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'notebook';

export function ExportDialog({ nbId, pageIndex }: { nbId: string; pageIndex?: number }) {
  const s = useSession(nbId);
  const [format, setFormat] = useState<'pdf' | 'png' | 'gink'>('pdf');
  const [range, setRange] = useState<'all' | 'current' | 'custom'>(pageIndex != null ? 'current' : 'all');
  const [custom, setCustom] = useState('');
  const [annotations, setAnnotations] = useState(true);
  const [templates, setTemplates] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const current = pageIndex ?? 0;
  const pages = range === 'all' ? s.pages.map((_, i) => i) : range === 'current' ? [current] : parseRange(custom, s.pages.length);

  const run = async () => {
    if (format === 'gink') {
      closeDialog();
      return void exportBackup(nbId);
    }
    if (!pages.length) return;
    const title = safeName(s.meta.title);
    if (format === 'pdf') {
      const target = await api.saveDialog({ title: 'Export PDF', defaultPath: `${title}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (!target) return;
      setBusy(true);
      closeDialog();
      const tid = toast('Exporting PDF…', { progress: 0 });
      try {
        await s.flush();
        const bytes = await exportPdf(s, { pages, includeAnnotations: annotations, includeTemplates: templates, onProgress: (d, t) => updateToast(tid, { progress: d / t }) });
        await api.writeFile(target, bytes);
        dismissToast(tid);
        toast('PDF exported', { kind: 'success', action: { label: 'Show', run: () => void api.revealFile(target) } });
      } catch (e) {
        dismissToast(tid);
        toast(`Export failed: ${(e as Error).message}`, { kind: 'error', ms: 7000 });
      }
    } else {
      const target = await api.saveDialog({ title: 'Export image', defaultPath: `${title}${pages.length > 1 ? ' - page 1' : ''}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (!target) return;
      setBusy(true);
      closeDialog();
      const tid = toast('Exporting images…', { progress: 0 });
      for (let k = 0; k < pages.length; k++) {
        const file = pages.length > 1 ? target.replace(/( - page 1)?\.png$/i, ` - page ${pages[k] + 1}.png`) : target;
        await api.writeFile(file, await exportPagePng(s, pages[k]));
        updateToast(tid, { progress: (k + 1) / pages.length });
      }
      dismissToast(tid);
      toast(`Exported ${pages.length} image${pages.length === 1 ? '' : 's'}`, { kind: 'success', action: { label: 'Show', run: () => void api.revealFile(target) } });
    }
  };

  return (
    <Modal
      title={`Export “${s.meta.title}”`}
      onClose={closeDialog}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || (format !== 'gink' && !pages.length)} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <Field label="Format">
        <Segmented label="Format" value={format} onChange={setFormat} options={[{ value: 'pdf', label: 'PDF' }, { value: 'png', label: 'Image (PNG)' }, { value: 'gink', label: 'Backup (.gink)' }]} />
      </Field>
      {format !== 'gink' && (
        <>
          <Field label="Pages">
            <Segmented label="Pages" value={range} onChange={setRange} options={[{ value: 'all', label: `All (${s.pages.length})` }, { value: 'current', label: `Page ${current + 1}` }, { value: 'custom', label: 'Range' }]} />
          </Field>
          {range === 'custom' && (
            <Field label="Page range" hint="For example 1-3, 6, 9-12">
              <input className="input" autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="1-3, 6" />
            </Field>
          )}
          {format === 'pdf' && (
            <>
              <Toggle label="Include handwriting and annotations" checked={annotations} onChange={setAnnotations} />
              <Toggle label="Include paper templates" checked={templates} onChange={setTemplates} />
            </>
          )}
        </>
      )}
      {format === 'gink' && <p className="muted small">A .gink file holds the whole notebook — pages, ink, PDFs, images and recordings — and can be opened by goodink on any PC.</p>}
    </Modal>
  );
}

export async function printNotebook(s: NotebookSession, pages?: number[]) {
  const list = pages ?? s.pages.map((_, i) => i);
  const tid = toast('Preparing pages for printing…', { progress: 0 });
  const urls: string[] = [];
  for (let k = 0; k < list.length; k++) {
    urls.push(await pageDataUrl(s, list[k], 1700));
    updateToast(tid, { progress: (k + 1) / list.length });
  }
  dismissToast(tid);
  await api.print(urls);
}

function closestSize(p: PageMeta): PageSizeId {
  const [a, b] = [Math.min(p.w, p.h), Math.max(p.w, p.h)];
  let best: PageSizeId = 'a4', d = Infinity;
  for (const [k, v] of Object.entries(PAGE_SIZES)) {
    const e = Math.abs(Math.min(v.w, v.h) - a) + Math.abs(Math.max(v.w, v.h) - b);
    if (e < d) {
      d = e;
      best = k as PageSizeId;
    }
  }
  return best;
}

export function PageTemplateDialog({ nbId }: { nbId: string }) {
  const s = useSession(nbId);
  const current = useApp((st) => st.pageOf[nbId] ?? 0);
  const [tpl, setTpl] = useState<Template | null>(null);
  const [scope, setScope] = useState<'this' | 'all' | 'new'>('this');
  const [size, setSize] = useState<PageSizeId | 'infinite' | 'keep'>('keep');
  const [landscape, setLandscape] = useState<boolean | null>(null);
  if (!s) return null;
  const idx = Math.min(current, s.pages.length - 1);
  const p = s.pages[idx];
  const value = tpl ?? p.template;
  const land = landscape ?? p.w > p.h;
  const layout: PageLayout | null = size === 'keep' ? (landscape != null && !p.infinite ? { size: closestSize(p), landscape: land } : null) : { size, landscape: land };
  const apply = () => {
    if (scope === 'this') setLayout(s, [idx], value, layout);
    else if (scope === 'all') setLayout(s, 'all', value, layout);
    else addLayoutPage(s, idx, value, layout);
    closeDialog();
  };
  const previewW = size === 'infinite' || (size === 'keep' && p.infinite) ? 600 : size === 'keep' ? (land === p.w > p.h ? p.w : p.h) : land ? PAGE_SIZES[size].h : PAGE_SIZES[size].w;
  const previewH = size === 'infinite' || (size === 'keep' && p.infinite) ? 600 : size === 'keep' ? (land === p.w > p.h ? p.h : p.w) : land ? PAGE_SIZES[size].w : PAGE_SIZES[size].h;
  return (
    <Modal title="Page layout" size="lg" onClose={closeDialog} footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={apply}>Apply</Button></>}>
      <Field label="Apply to">
        <Segmented label="Apply to" value={scope} onChange={setScope} options={[{ value: 'this', label: `This page (${idx + 1})` }, { value: 'all', label: 'All pages' }, { value: 'new', label: 'New page after this one' }]} />
      </Field>
      <div className="layout-row">
        <Field label="Page size" hint={size === 'infinite' ? 'One endless sheet that grows as you write.' : undefined}>
          <select className="input" value={size} onChange={(e) => setSize(e.target.value as PageSizeId | 'infinite' | 'keep')}>
            <option value="keep">Keep current size</option>
            {Object.entries(PAGE_SIZES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
            <option value="infinite">Infinite canvas</option>
          </select>
        </Field>
        {size !== 'infinite' && !(size === 'keep' && p.infinite) && (
          <Field label="Orientation">
            <Segmented label="Orientation" value={land ? 'l' : 'p'} onChange={(v) => setLandscape(v === 'l')} options={[{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }]} />
          </Field>
        )}
      </div>
      {p.bg && scope === 'this' && <p className="muted small">This page has a PDF or image background, so it keeps its size. The template is drawn over it; pick Blank to remove lines.</p>}
      <div className="tpl-scroll">
        <TemplateGrid value={value} onChange={setTpl} w={previewW} h={previewH} />
      </div>
    </Modal>
  );
}

