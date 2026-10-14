import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Folder as FolderIcon, Home } from 'lucide-react';
import type { Cover, PageSizeId, PaperColor, Template, TemplateKind } from '../../shared/types';
import { PAGE_SIZES } from '../../shared/types';
import { useApp, closeDialog, createNotebook, patchNotebook, patchFolder, patchLink, moveItems, updateSettings, toast, changeLibraryFolder, renameFile } from '../lib/store';
import { api } from '../lib/api';
import { Button, Field, Modal, Segmented, Toggle } from '../ui/primitives';
import { CoverArt, COVER_COLORS, COVER_STYLES, TemplatePreview } from './CoverArt';
import { TEMPLATE_LIST } from '../engine/templates';
// the AI section pulls in the provider SDKs, so it loads only when Settings opens
const AiSettingsSection = lazy(() => import('../editor/AiDialogs').then((m) => ({ default: m.AiSettingsSection })));

export function TemplateGrid({ value, onChange, w, h }: { value: Template; onChange: (t: Template) => void; w: number; h: number }) {
  const groups = [...new Set(TEMPLATE_LIST.map((t) => t.group))];
  return (
    <div className="tpl-picker">
      <div className="tpl-paper">
        <span className="field-label">Paper</span>
        <Segmented<PaperColor>
          label="Paper colour"
          value={value.paper}
          onChange={(paper) => onChange({ ...value, paper })}
          options={[
            { value: 'white', label: 'White' },
            { value: 'cream', label: 'Cream' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
      {groups.map((g) => (
        <div key={g} className="tpl-group">
          <h3>{g}</h3>
          <div className="tpl-grid" role="radiogroup" aria-label={`${g} templates`}>
            {TEMPLATE_LIST.filter((t) => t.group === g).map((t) => (
              <button key={t.kind} role="radio" aria-checked={value.kind === t.kind} className={`tpl-item ${value.kind === t.kind ? 'is-on' : ''}`} onClick={() => onChange({ ...value, kind: t.kind as TemplateKind })}>
                <TemplatePreview template={{ kind: t.kind, paper: value.paper }} w={w} h={h} width={w > h ? 104 : 74} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CoverPicker({ value, onChange, title }: { value: Cover; onChange: (c: Cover) => void; title: string }) {
  return (
    <div className="cover-picker">
      <div className="cover-styles" role="radiogroup" aria-label="Cover style">
        {COVER_STYLES.map((s) => (
          <button key={s.style} role="radio" aria-checked={value.style === s.style} className={`cover-opt ${value.style === s.style ? 'is-on' : ''}`} onClick={() => onChange({ ...value, style: s.style })}>
            <CoverArt cover={{ style: s.style, color: value.color }} title={s.style === 'none' ? '' : title || 'Notebook'} ratio={0.75} kind="notebook" />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      {value.style !== 'none' && (
        <div className="cover-colors" role="radiogroup" aria-label="Cover colour">
          {COVER_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={value.color === c} aria-label={`Colour ${c}`} className={`swatch ${value.color === c ? 'is-on' : ''}`} style={{ ['--sw' as string]: c, width: 26, height: 26 }} onClick={() => onChange({ ...value, color: c })} />
          ))}
          <input type="color" aria-label="Custom cover colour" value={value.color} onChange={(e) => onChange({ ...value, color: e.target.value })} />
        </div>
      )}
    </div>
  );
}

export function NewNotebookDialog({ folderId }: { folderId: string | null }) {
  const settings = useApp((s) => s.settings);
  const [title, setTitle] = useState('');
  const [cover, setCover] = useState<Cover>({ style: 'linen', color: COVER_COLORS[Math.floor(Math.random() * 10)] });
  const [template, setTemplate] = useState<Template>(settings.defaultTemplate);
  const [size, setSize] = useState<PageSizeId>(settings.defaultSize);
  const [landscape, setLandscape] = useState(settings.defaultOrientation === 'landscape');
  const [infinite, setInfinite] = useState(false);
  const [tab, setTab] = useState<'cover' | 'paper'>('paper');
  const sz = PAGE_SIZES[size];
  const [w, h] = infinite ? [600, 600] : landscape ? [sz.h, sz.w] : [sz.w, sz.h];
  const submit = () => {
    closeDialog();
    void createNotebook({ title, folderId, cover, template, size, landscape, infinite });
    updateSettings({ defaultTemplate: template, defaultSize: size, defaultOrientation: landscape ? 'landscape' : 'portrait' });
  };
  return (
    <Modal
      title="New notebook"
      size="lg"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="newnb">
        <div className="newnb-side">
          <div className="newnb-preview">
            <CoverArt cover={cover} title={title || 'Untitled notebook'} ratio={w / h} kind="notebook" />
          </div>
          <Field label="Title">
            <input className="input" data-autofocus placeholder="Untitled notebook" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          {(
            <>
              <Field label="Size" hint={infinite ? 'One endless sheet that grows as you write.' : undefined}>
                <select
                  className="input"
                  value={infinite ? 'infinite' : size}
                  onChange={(e) => {
                    if (e.target.value === 'infinite') setInfinite(true);
                    else {
                      setInfinite(false);
                      setSize(e.target.value as PageSizeId);
                    }
                  }}
                >
                  {Object.entries(PAGE_SIZES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                  <option value="infinite">Infinite canvas</option>
                </select>
              </Field>
              {!infinite && (
                <Field label="Orientation">
                  <Segmented label="Orientation" value={landscape ? 'l' : 'p'} onChange={(v) => setLandscape(v === 'l')} options={[{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }]} />
                </Field>
              )}
            </>
          )}
        </div>
        <div className="newnb-main">
          <Segmented label="Choose" value={tab} onChange={setTab} options={[{ value: 'paper', label: 'Paper' }, { value: 'cover', label: 'Cover' }]} />
          <div className="newnb-scroll">
            {tab === 'cover' ? <CoverPicker value={cover} onChange={setCover} title={title} /> : <TemplateGrid value={template} onChange={setTemplate} w={w} h={h} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function RenameDialog({ kind, id }: { kind: 'notebook' | 'folder' | 'link' | 'file'; id: string }) {
  const lib = useApp((s) => s.library);
  const file = kind === 'file' ? lib.files?.find((f) => f.rel === id) : undefined;
  const item = kind === 'notebook' ? lib.notebooks.find((n) => n.id === id) : kind === 'link' ? lib.links?.find((x) => x.id === id) : kind === 'file' ? (file && { title: file.name }) : lib.folders.find((f) => f.id === id);
  const [title, setTitle] = useState(item?.title ?? '');
  const submit = () => {
    const t = title.trim();
    if (!t) return;
    if (kind === 'file') void renameFile(id, t);
    else if (kind === 'notebook') patchNotebook(id, { title: t, updatedAt: Date.now() });
    else if (kind === 'link') patchLink(id, { title: t });
    else patchFolder(id, { title: t });
    closeDialog();
  };
  return (
    <Modal title={kind === 'notebook' ? 'Rename notebook' : kind === 'link' || kind === 'file' ? 'Rename' : 'Rename folder'} onClose={closeDialog} footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button variant="primary" disabled={!title.trim()} onClick={submit}>Save</Button></>}>
      <Field label="Name">
        <input
          className="input"
          data-autofocus
          value={title}
          maxLength={kind === 'file' ? 240 : 120}
          // a file: select the name without its extension, like Explorer
          onFocus={(e) => (kind === 'file' && /\.[^.]+$/.test(title) ? e.currentTarget.setSelectionRange(0, title.lastIndexOf('.')) : e.currentTarget.select())}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </Field>
    </Modal>
  );
}

export function MoveDialog({ ids }: { ids: string[] }) {
  const folders = useApp((s) => s.library.folders.filter((f) => !f.deletedAt));
  const [target, setTarget] = useState<string | null>(null);
  const blocked = useMemo(() => {
    const out = new Set<string>();
    const add = (id: string) => {
      out.add(id);
      folders.filter((f) => f.parentId === id).forEach((f) => add(f.id));
    };
    ids.forEach((id) => folders.some((f) => f.id === id) && add(id));
    return out;
  }, [folders, ids]);
  const tree = (parent: string | null, depth: number): React.ReactNode =>
    folders
      .filter((f) => f.parentId === parent && !blocked.has(f.id))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((f) => (
        <div key={f.id}>
          <button className={`move-row ${target === f.id ? 'is-on' : ''}`} style={{ paddingLeft: 12 + depth * 18 }} onClick={() => setTarget(f.id)}>
            <FolderIcon size={16} style={{ color: f.color }} /> {f.title}
          </button>
          {tree(f.id, depth + 1)}
        </div>
      ));
  return (
    <Modal title={`Move ${ids.length} item${ids.length === 1 ? '' : 's'}`} onClose={closeDialog} footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={() => { moveItems(ids, target); useApp.setState({ picked: [] }); closeDialog(); toast('Moved'); }}>Move here</Button></>}>
      <div className="move-list" role="listbox">
        <button className={`move-row ${target === null ? 'is-on' : ''}`} onClick={() => setTarget(null)}>
          <Home size={16} /> Files (top level)
        </button>
        {tree(null, 1)}
      </div>
    </Modal>
  );
}

export function CoverDialog({ nbId }: { nbId: string }) {
  const nb = useApp((s) => s.library.notebooks.find((n) => n.id === nbId));
  const [cover, setCover] = useState<Cover>(nb?.cover ?? { style: 'solid', color: COVER_COLORS[0] });
  if (!nb) return null;
  return (
    <Modal title="Change cover" size="md" onClose={closeDialog} footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={() => { patchNotebook(nbId, { cover }); closeDialog(); }}>Apply</Button></>}>
      <CoverPicker value={cover} onChange={setCover} title={nb.title} />
    </Modal>
  );
}

export function ConfirmDialog({ title, body, ok, run, danger }: { title: string; body: string; ok: string; run: () => void; danger?: boolean }) {
  return (
    <Modal title={title} onClose={closeDialog} footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button data-autofocus variant={danger ? 'danger' : 'primary'} onClick={() => { closeDialog(); run(); }}>{ok}</Button></>}>
      <p>{body}</p>
    </Modal>
  );
}

export function PasswordDialog({ title, resolve }: { title: string; resolve: (pw: string | null) => void }) {
  const [pw, setPw] = useState('');
  const done = (v: string | null) => {
    closeDialog();
    resolve(v);
  };
  return (
    <Modal title={title} onClose={() => done(null)} footer={<><Button variant="ghost" onClick={() => done(null)}>Cancel</Button><Button variant="primary" disabled={!pw} onClick={() => done(pw)}>OK</Button></>}>
      <Field label="Password">
        <input className="input" type="password" data-autofocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && done(pw)} />
      </Field>
    </Modal>
  );
}

export function SettingsDialog() {
  const s = useApp((st) => st.settings);
  const [path, setPath] = useState('');
  const [version, setVersion] = useState('');
  useEffect(() => {
    void api.libraryPath().then(setPath);
    void api.version().then(setVersion);
  }, []);
  return (
    <Modal title="Settings" size="md" onClose={closeDialog} className="settings">
      <section>
        <h3>Appearance</h3>
        <Field label="Theme">
          <Segmented label="Theme" value={s.theme} onChange={(theme) => updateSettings({ theme })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Field>
        <Field label="Page scrolling">
          <Segmented label="Scroll direction" value={s.scrollDir} onChange={(scrollDir) => updateSettings({ scrollDir })} options={[{ value: 'vertical', label: 'Vertical' }, { value: 'horizontal', label: 'Horizontal' }]} />
        </Field>
      </section>
      <section>
        <h3>Pen & touch</h3>
        <Field label="Fingers and pen" hint="Automatic: on PCs with a pen, fingers scroll and zoom and only the pen writes; without a pen fingers write. “Fingers draw” lets one finger use the current tool on any PC; two fingers always scroll and zoom. Holding a finger still on a placed PDF page or image picks it up.">
          <Segmented label="Stylus mode" value={s.stylusMode} onChange={(stylusMode) => updateSettings({ stylusMode })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'penOnly', label: 'Pen only' }, { value: 'touch', label: 'Fingers draw' }]} />
        </Field>
        <Toggle label="Pressure sensitivity" hint="Line weight follows how hard you press." checked={s.pressure} onChange={(pressure) => updateSettings({ pressure })} />
        <Toggle label="Hold to draw shapes" hint="Pause at the end of a stroke to snap it into a clean shape." checked={s.holdToShape} onChange={(holdToShape) => updateSettings({ holdToShape })} />
        <Field label={`Hold delay: ${s.holdDelayMs} ms`}>
          <input type="range" min={300} max={1200} step={50} value={s.holdDelayMs} onChange={(e) => updateSettings({ holdDelayMs: +e.target.value })} />
        </Field>
        <Toggle label="Straight highlighter" hint="Highlighter strokes are always straight lines." checked={s.straightHighlighter} onChange={(straightHighlighter) => updateSettings({ straightHighlighter })} />
      </section>
      <section>
        <h3>Eraser</h3>
        <Field label="Eraser">
          <Segmented label="Eraser mode" value={s.eraserMode} onChange={(eraserMode) => updateSettings({ eraserMode })} options={[{ value: 'precise', label: 'Precise' }, { value: 'stroke', label: 'Whole stroke' }]} />
        </Field>
        <Toggle label="Erase highlighter only" checked={s.eraserHighlighterOnly} onChange={(eraserHighlighterOnly) => updateSettings({ eraserHighlighterOnly })} />
        <Toggle label="Switch back after erasing" hint="Return to the previous tool when you lift the eraser." checked={s.eraserAutoDeselect} onChange={(eraserAutoDeselect) => updateSettings({ eraserAutoDeselect })} />
      </section>
      <Suspense fallback={null}>
        <AiSettingsSection />
      </Suspense>
      <section>
        <h3>Search</h3>
        <Toggle label="Make handwriting searchable" hint="Uses the text recognition built into Windows. Nothing leaves this PC." checked={s.ocrEnabled} onChange={(ocrEnabled) => updateSettings({ ocrEnabled })} />
      </section>
      <section>
        <h3>Storage</h3>
        <p className="muted small">Your library is stored at</p>
        <code className="path">{path}</code>
        <div className="row">
          <Button size="sm" onClick={() => void api.revealFile(path + '\\library.json')}>
            Show in Explorer
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const dir = await api.folderDialog();
              if (dir) await changeLibraryFolder(dir);
            }}
          >
            Move library… (e.g. into OneDrive)
          </Button>
        </div>
      </section>
      <p className="muted small about">goodink {version} · Handwriting and PDF notes for Windows</p>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Pen / Highlighter / Eraser', 'P / H / E'],
  ['Lasso / Shapes / Text', 'L / S / T'],
  ['Image / Tape / Laser pointer', 'I / U / K'],
  ['Thickness presets', '1 / 2 / 3'],
  ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
  ['Cut / Copy / Paste / Duplicate', 'Ctrl+X / C / V / D'],
  ['Select all on page', 'Ctrl+A'],
  ['Delete selection', 'Delete'],
  ['Zoom in / out / reset', 'Ctrl + / Ctrl − / Ctrl+0'],
  ['Fit width / Fit page', 'Ctrl+1 / Ctrl+2'],
  ['Pan', 'Space + drag, middle mouse'],
  ['Next / previous page', 'Page Down / Page Up'],
  ['New page after this one', 'Ctrl+Enter'],
  ['Bookmark page', 'Ctrl+B'],
  ['Find in notebook', 'Ctrl+F'],
  ['Page thumbnails', 'Ctrl+\\'],
  ['Export / Print', 'Ctrl+E / Ctrl+P'],
  ['Present', 'F5'],
  ['Next tab / Close tab', 'Ctrl+Tab / Ctrl+W'],
  ['New notebook / Quick note', 'Ctrl+N / Ctrl+Shift+N'],
  ['Import PDF as notebook', 'Ctrl+O'],
  ['Insert PDF pages into notebook', 'Ctrl+Shift+O'],
  ['Full screen', 'F11'],
  ['Settings', 'Ctrl+,'],
];

export function ShortcutsDialog() {
  return (
    <Modal title="Keyboard shortcuts" size="md" onClose={closeDialog}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>
                <kbd>{b}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Pen tip with the eraser end or barrel button held erases, whatever tool is selected.</p>
    </Modal>
  );
}

/** Asked once (first launch, or an install that never confirmed it): where do notebooks live? */
export function StorageDialog() {
  const [current, setCurrent] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.libraryInfo().then((i) => setCurrent(i.path));
  }, []);
  const target = folder ? `${folder}\goodink Notebooks` : current;
  const confirm = async () => {
    setBusy(true);
    if (!(await changeLibraryFolder(folder))) setBusy(false);
  };
  return (
    <div className="scrim">
      <div className="modal modal-md storage" role="dialog" aria-modal="true" aria-label="Choose where to save your notebooks">
        <header className="modal-head">
          <h2>Where should your notebooks be saved?</h2>
        </header>
        <div className="modal-body">
          <p className="muted">All notebooks, imported PDFs, images and recordings are kept in one folder on this PC. Pick a OneDrive or Dropbox folder if you want them backed up or available on another computer.</p>
          <Field label="Notebooks will be saved in">
            <code className="path">{target || '…'}</code>
          </Field>
          <Button
            onClick={async () => {
              const dir = await api.folderDialog();
              if (dir) setFolder(dir);
            }}
          >
            Choose a different folder…
          </Button>
          {folder && (
            <Button variant="ghost" onClick={() => setFolder(null)}>
              Use the default folder
            </Button>
          )}
          <p className="muted small" style={{ marginTop: 16 }}>
            You can change this later in Settings → Storage.{folder ? ' Your existing notebooks are copied over.' : ''}
          </p>
        </div>
        <footer className="modal-foot">
          <Button variant="primary" data-autofocus disabled={busy || !target} onClick={() => void confirm()}>
            {busy ? 'Saving…' : 'Save notebooks here'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
