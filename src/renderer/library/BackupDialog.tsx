// "Back up…" for a folder or the whole library: one .gink file (restores everything, as a folder)
// or PDF (one file with bookmarks, or one PDF per notebook in a tree of folders).
import { useMemo, useState } from 'react';
import { Archive, FileText } from 'lucide-react';
import { useApp, closeDialog, treeOf, backupTreeGink, toast, updateToast, dismissToast, diskName } from '../lib/store';
import { api } from '../lib/api';
import { Button, Field, Modal, Segmented, Toggle } from '../ui/primitives';

type Format = 'gink' | 'pdf';
type PdfMode = 'one' | 'each';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mb = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`);

export function BackupDialog({ folderId }: { folderId: string | null }) {
  const library = useApp((s) => s.library);
  const [format, setFormat] = useState<Format>('gink');
  const [mode, setMode] = useState<PdfMode>('one');
  const [annotations, setAnnotations] = useState(true);
  const [templates, setTemplates] = useState(true);
  const t = useMemo(() => treeOf(folderId), [folderId, library]);
  const name = folderId ? (t.folders[0]?.title ?? 'Folder') : 'goodink library';
  const sub = folderId ? t.folders.length - 1 : t.folders.length;
  const unprintable = t.notebooks.filter((n) => n.lock || (n.kind ?? 'notebook') === 'flashcards').length;
  const pages = t.notebooks.reduce((a, n) => a + (n.pageCount ?? 0), 0);
  const empty = !t.notebooks.length && !t.links.length && !t.files.length && !sub;

  const summary = [plural(t.notebooks.length, 'notebook'), sub ? plural(sub, 'folder') : '', t.links.length ? plural(t.links.length, 'link') : '', t.files.length ? plural(t.files.length, 'other file') : '']
    .filter(Boolean)
    .join(' · ');

  const run = async () => {
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'gink') {
      const target = await api.saveDialog({ title: folderId ? 'Back up folder' : 'Back up everything', defaultPath: `${diskName(name)} ${date}.gink`, filters: [{ name: 'goodink backup', extensions: ['gink'] }] });
      if (!target) return;
      closeDialog();
      const tid = toast(`Backing up “${name}”…`, { progress: 0 });
      try {
        const bytes = await backupTreeGink(folderId, target, (d, n) => updateToast(tid, { progress: d / Math.max(1, n) }));
        dismissToast(tid);
        toast(`Backup saved (${mb(bytes)})`, { kind: 'success', action: api.showAction(target) });
      } catch (e) {
        dismissToast(tid);
        toast(`Backup failed: ${(e as Error).message ?? e}`, { kind: 'error', ms: 7000 });
      }
      return;
    }
    const target =
      mode === 'one'
        ? await api.saveDialog({ title: 'Save as PDF', defaultPath: `${diskName(name)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
        : await api.folderDialog();
    if (!target) return;
    closeDialog();
    let stop = false;
    const tid = toast(`Making PDF of “${name}”…`, { progress: 0, action: { label: 'Stop', run: () => (stop = true) } });
    try {
      const { treeToOnePdf, treeToPdfFiles } = await import('./backupPdf');
      const opts = {
        includeAnnotations: annotations,
        includeTemplates: templates,
        cancelled: () => stop,
        onProgress: (d: number, n: number, title: string) => updateToast(tid, { progress: d / Math.max(1, n), msg: title ? `PDF ${d + 1} of ${n}: ${title}` : 'Saving PDF…' }),
      };
      const r = mode === 'one' ? await treeToOnePdf(folderId, target, opts) : await treeToPdfFiles(folderId, target, opts);
      dismissToast(tid);
      if (!r.files.length) return void toast(stop ? 'Stopped: nothing was saved' : 'Nothing to print here', { kind: 'info' });
      const left = r.skipped.length ? ` · ${plural(r.skipped.length, 'locked notebook or deck', 'locked notebooks or decks')} left out` : '';
      const what = mode === 'one' ? `PDF saved: ${plural(r.notebooks, 'notebook')}, ${plural(r.pages, 'page')}` : `${plural(r.files.length, 'PDF')} saved`;
      toast(`${stop ? 'Stopped. ' : ''}${what}${left}`, { kind: 'success', ms: 7000, action: api.showAction(r.files[0]) });
    } catch (e) {
      dismissToast(tid);
      toast(`PDF export failed: ${(e as Error).message ?? e}`, { kind: 'error', ms: 7000 });
    }
  };

  return (
    <Modal
      title={folderId ? `Back up “${name}”` : 'Back up everything'}
      onClose={closeDialog}
      size="md"
      className="backup-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" disabled={empty || (format === 'pdf' && t.notebooks.length === unprintable)} onClick={() => void run()}>
            {format === 'gink' ? 'Back up…' : 'Save PDF…'}
          </Button>
        </>
      }
    >
      <p className="backup-summary">
        {empty ? 'This folder is empty.' : summary}
        {pages > 0 && <span className="muted"> · {plural(pages, 'page')}</span>}
      </p>
      <Field label="Save as">
        <div className="backup-formats" role="radiogroup" aria-label="Save as">
          <button type="button" role="radio" aria-checked={format === 'gink'} className={format === 'gink' ? 'is-on' : ''} onClick={() => setFormat('gink')}>
            <Archive size={20} />
            <span>
              <strong>goodink backup (.gink)</strong>
              <span className="muted small">Everything, ready to restore</span>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={format === 'pdf'} className={format === 'pdf' ? 'is-on' : ''} onClick={() => setFormat('pdf')}>
            <FileText size={20} />
            <span>
              <strong>PDF</strong>
              <span className="muted small">To read, print or share</span>
            </span>
          </button>
        </div>
      </Field>
      {format === 'gink' ? (
        <p className="muted small">
          One file with every notebook, imported PDF, image, recording, link and file{folderId ? ' in this folder and its folders' : ', and your settings and Study decks'}, with covers and colours. Open it in goodink to restore it as a
          folder. Nothing already in your library is replaced.
        </p>
      ) : (
        <>
          {api.canPickFolder && (
          <Field label="Files">
            <Segmented
              label="Files"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'one', label: 'One PDF with bookmarks', title: 'All notebooks in one PDF; folders and notebooks are bookmarks' },
                { value: 'each', label: 'A PDF per notebook', title: 'One PDF per notebook, in folders like the library’s' },
              ]}
            />
          </Field>
          )}
          <Toggle label="Include handwriting and annotations" checked={annotations} onChange={setAnnotations} />
          <Toggle label="Include paper templates" checked={templates} onChange={setTemplates} />
          {unprintable > 0 && (
            <p className="muted small">
              {plural(unprintable, 'locked notebook or flashcard deck', 'locked notebooks and flashcard decks')} {unprintable === 1 ? 'is' : 'are'} left out of the PDF. A .gink backup includes them.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
