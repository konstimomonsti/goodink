// Adding a web page or YouTube video to a folder.
import { useState } from 'react';
import { Button, Field, Modal, Spinner } from '../ui/primitives';
import { addLink, folderPath, toast, useApp } from '../lib/store';
import { fetchPage } from '../lib/web';
import { youtubeId, youtubeInfo, youtubeUrl } from '../study/youtube';

export function AddLinkDialog({ folderId, onClose }: { folderId: string | null; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const where = folderPath(folderId).map((f) => f.title).join(' / ') || 'Home';
  const add = async () => {
    let u = url.trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    setBusy(true);
    try {
      const vid = youtubeId(u);
      if (vid) {
        const info = await youtubeInfo(vid);
        addLink({ kind: 'youtube', title: info.title, url: youtubeUrl(vid), author: info.author, folderId });
      } else {
        const page = await fetchPage(u);
        if (page.text.length < 40) throw new Error('No readable text was found on that page.');
        addLink({ kind: 'link', title: page.title, url: u, folderId });
      }
      toast(`Added to ${where}`, { kind: 'success' });
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: 'error', ms: 8000 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add a link or video"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!url.trim() || busy} onClick={() => void add()}>
            {busy ? <Spinner size={14} /> : null} Add to {where}
          </Button>
        </>
      }
    >
      <Field label="Web address or YouTube video" hint="An article, Wikipedia page or lecture notes, or a YouTube video. It opens inside goodink, and you can make flashcards from it in Study.">
        <input className="input" data-autofocus value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void add()} />
      </Field>
    </Modal>
  );
}

/** Every folder as a path ("Chemistry / Organic"), for choosing where something goes. */
export function FolderSelect({ value, onChange, extra, label = 'Folder' }: { value: string; onChange: (id: string) => void; extra?: React.ReactNode; label?: string }) {
  const folders = useApp((s) => s.library.folders);
  const live = folders.filter((f) => !f.deletedAt);
  const path = (id: string | null): string => {
    const f = live.find((x) => x.id === id);
    return f ? (f.parentId ? `${path(f.parentId)} / ${f.title}` : f.title) : '';
  };
  const options = live.map((f) => ({ id: f.id, label: path(f.id) })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <select className="input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Files (top level)</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
      {extra}
    </select>
  );
}
