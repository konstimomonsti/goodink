import { lazy, Suspense, useEffect, useState } from 'react';
import { BookOpen, X, Plus, PenTool, FileUp, Search as SearchIcon, Minus, Square, Copy } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useApp, activateTab, closeTab, closeDialog, dismissToast, openDialog, quickNote, pickPdfs, openFiles, updateSettings } from './lib/store';
import { api } from './lib/api';
import { isAndroid, modKey } from './lib/util';
import { Library } from './library/Library';
const Editor = lazy(() => import('./editor/Editor').then((m) => ({ default: m.Editor })));
const LinkView = lazy(() => import('./library/LinkView').then((m) => ({ default: m.LinkView })));
import { NewNotebookDialog, RenameDialog, MoveDialog, CoverDialog, ConfirmDialog, PasswordDialog, SettingsDialog, ShortcutsDialog, StorageDialog } from './library/Dialogs';
const ExportDialog = lazy(() => import('./editor/EditorDialogs').then((m) => ({ default: m.ExportDialog })));
const PageTemplateDialog = lazy(() => import('./editor/EditorDialogs').then((m) => ({ default: m.PageTemplateDialog })));
const AiDialog = lazy(() => import('./editor/AiDialogs').then((m) => ({ default: m.AiDialog })));
import { Button, Spinner } from './ui/primitives';

/** Minimise / maximise / close for the frameless window (Windows-style, right aligned). */
function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    void w.isMaximized().then(setMax);
    const un = w.onResized(() => void w.isMaximized().then(setMax));
    return () => void un.then((f) => f());
  }, []);
  const w = getCurrentWindow();
  return (
    <div className="win-controls">
      <button aria-label="Minimise" title="Minimise" onClick={() => void w.minimize()}>
        <Minus size={16} strokeWidth={1.5} />
      </button>
      <button aria-label={max ? 'Restore' : 'Maximise'} title={max ? 'Restore' : 'Maximise'} onClick={() => void w.toggleMaximize()}>
        {max ? <Copy size={13} strokeWidth={1.5} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} strokeWidth={1.5} />}
      </button>
      <button className="win-close" aria-label="Close" title="Close" onClick={() => void w.close()}>
        <X size={17} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function App() {
  const { ready, tabs, active, library, settings, askStorage } = useApp();
  const [dropping, setDropping] = useState(false);

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const st = useApp.getState();
      if (k === 'f11') {
        e.preventDefault();
        void api.toggleFullscreen();
        return;
      }
      if (k === 'f12' && e.shiftKey) {
        void api.devtools();
        return;
      }
      if (!modKey(e) || st.dialog || e.defaultPrevented) return;
      if (k === 'tab') {
        e.preventDefault();
        const order: (string | null)[] = [null, ...st.tabs];
        const i = order.indexOf(st.active);
        activateTab(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
      } else if (k === 'w' && st.active) {
        e.preventDefault();
        void closeTab(st.active);
      } else if (k === 'n' && e.shiftKey) {
        e.preventDefault();
        void quickNote();
      } else if (k === 'n') {
        e.preventDefault();
        openDialog({ type: 'new-notebook', folderId: st.folderId });
      } else if (k === 'o' && !e.shiftKey) {
        e.preventDefault();
        void pickPdfs();
      } else if (k === ',') {
        e.preventDefault();
        openDialog({ type: 'settings' });
      } else if (k === '/') {
        e.preventDefault();
        openDialog({ type: 'shortcuts' });
      } else if (k === 'f' && !st.active) {
        e.preventDefault();
        document.getElementById('lib-search')?.focus();
      } else if (k === 'p' && !st.active) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // startup marker for the benchmark: library painted, measured from navigation start
    if (ready)
      requestAnimationFrame(() =>
        Object.assign(window as unknown as Record<string, number>, { __bootMs: Math.round(performance.now()), __paintEpoch: Date.now() }),
      );
  }, [ready]);

  if (!ready)
    return (
      <div className="boot">
        <Spinner size={22} />
      </div>
    );

  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    if (active) return; // the editor handles images dropped on a page
    const files = [...e.dataTransfer.files];
    if (files.length) {
      e.preventDefault();
      void Promise.all(files.map((f) => api.pathForFile(f))).then((paths) => openFiles(paths.filter(Boolean)));
    }
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!active && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={onDrop}
    >
      <header className="titlebar">
        <div className="tabs" role="tablist" aria-label="Open notebooks">
          <button role="tab" aria-selected={!active} className={`tab tab-home ${!active ? 'is-active' : ''}`} onClick={() => activateTab(null)} title="Library (Ctrl+Tab cycles tabs)">
            <BookOpen size={15} />
            <span>Files</span>
          </button>
          {tabs.map((id) => {
            const nb = library.notebooks.find((n) => n.id === id) ?? library.links?.find((x) => x.id === id);
            return (
              <div key={id} role="tab" aria-selected={active === id} className={`tab ${active === id ? 'is-active' : ''}`} onMouseDown={(e) => e.button === 1 && void closeTab(id)}>
                <button className="tab-main" onClick={() => activateTab(id)} title={nb?.title}>
                  <span className="ellipsis">{nb?.title ?? 'Notebook'}</span>
                </button>
                <button className="tab-x" aria-label={`Close ${nb?.title}`} onClick={() => void closeTab(id)}>
                  <X size={13} />
                </button>
              </div>
            );
          })}
          <button className="tab-new" aria-label="New notebook" title="New notebook (Ctrl+N)" onClick={() => openDialog({ type: 'new-notebook', folderId: useApp.getState().folderId })}>
            <Plus size={15} />
          </button>
        </div>
        <div className="titlebar-drag" data-tauri-drag-region={isAndroid ? undefined : true} />
        {!isAndroid && <WindowControls />}
      </header>
      <div className="content">
        <div className="pane" hidden={!!active}>
          <Library />
        </div>
        {tabs.map((id) => (
          <div key={id} className="pane" hidden={active !== id}>
            <Suspense fallback={<div className="editor-msg"><Spinner size={22} /></div>}>
              {library.links?.some((x) => x.id === id) ? <LinkView id={id} active={active === id} /> : <Editor nbId={id} active={active === id} />}
            </Suspense>
          </div>
        ))}
      </div>
      {dropping && (
        <div className="drop-hint">
          <FileUp size={28} />
          <p>Drop PDFs, images or .gink backups to import them</p>
        </div>
      )}
      <Suspense fallback={null}>
        <DialogHost />
      </Suspense>
      <Toasts />
      {askStorage ? <StorageDialog /> : !settings.onboarded && <Onboarding />}
    </div>
  );
}

function DialogHost() {
  const d = useApp((s) => s.dialog);
  if (!d) return null;
  switch (d.type) {
    case 'new-notebook':
      return <NewNotebookDialog folderId={d.folderId} />;
    case 'rename':
      return <RenameDialog kind={d.kind} id={d.id} />;
    case 'move':
      return <MoveDialog ids={d.ids} />;
    case 'cover':
      return <CoverDialog nbId={d.nbId} />;
    case 'confirm':
      return <ConfirmDialog {...d} />;
    case 'password':
      return <PasswordDialog title={d.title} resolve={d.resolve} />;
    case 'settings':
      return <SettingsDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'export':
      return <ExportDialog nbId={d.nbId} pageIndex={d.pageIndex} />;
    case 'template':
      return <PageTemplateDialog nbId={d.nbId} />;
    case 'ai':
      return <AiDialog nbId={d.nbId} pageIndex={d.pageIndex} />;
    default:
      void closeDialog;
      return null;
  }
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind ?? 'info'}`}>
          <span>{t.msg}</span>
          {t.progress != null && (
            <span className="toast-bar">
              <span style={{ width: `${Math.round(t.progress * 100)}%` }} />
            </span>
          )}
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.progress == null && (
            <button className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Onboarding() {
  const [step, setStep] = useState(0);
  const steps = [
    { icon: <PenTool size={34} />, t: 'Paper that keeps up with your pen', b: 'Write with a Surface Pen or any Windows Ink stylus. Pressure, tilt-free shading and the eraser end all work. A mouse works too.' },
    { icon: <FileUp size={34} />, t: 'Bring your PDFs', b: 'Import lecture slides, papers or forms, write straight on them, and export a clean PDF with your notes on top.' },
    { icon: <SearchIcon size={34} />, t: 'Find anything you wrote', b: 'Your handwriting becomes searchable using the text recognition built into Windows. Everything stays on this PC.' },
  ];
  const s = steps[step];
  const done = () => updateSettings({ onboarded: true });
  return (
    <div className="scrim">
      <div className="modal modal-sm onboarding" role="dialog" aria-modal="true" aria-label="Welcome">
        <div className="onb-icon">{s.icon}</div>
        <h2>{s.t}</h2>
        <p>{s.b}</p>
        <div className="onb-dots" aria-hidden>
          {steps.map((_, i) => (
            <span key={i} className={i === step ? 'is-on' : ''} />
          ))}
        </div>
        <div className="onb-actions">
          <Button variant="ghost" onClick={done}>
            Skip
          </Button>
          {step < steps.length - 1 ? (
            <Button variant="primary" data-autofocus onClick={() => setStep(step + 1)}>
              Next
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                done();
                openDialog({ type: 'new-notebook', folderId: null });
              }}
            >
              Create my first notebook
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

