performance.mark('gi-main');
import './lib/polyfills';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { Present } from './present/Present';
import * as store from './lib/store';
import { boot, useApp } from './lib/store';
import { invoke } from '@tauri-apps/api/core';

// uncaught errors go to goodink.log (Rust: client_log), at most 20 per run
let reported = 0;
const report = (what: string, e: unknown) => {
  if (reported++ >= 20) return;
  const err = e as { message?: string; stack?: string } | undefined;
  void invoke('client_log', { msg: `${what}: ${err?.stack || err?.message || String(e)}` }).catch(() => undefined);
};
window.addEventListener('error', (e) => report('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e.reason));

if (new URLSearchParams(location.search).get('test') === '1') {
  (window as unknown as { __goodink: unknown }).__goodink = { ...store };
  void Promise.all([import('./engine/export'), import('./engine/pdf')]).then(([exporter, pdf]) => Object.assign((window as unknown as { __goodink: object }).__goodink, exporter, { pdfCacheStats: pdf.pdfCacheStats }));
}

// Touchpad pinches arrive as Ctrl+wheel. The notebook canvas zooms the page itself (engine/viewport);
// everywhere else the window must not zoom, from the touchpad or from Ctrl+plus/minus/0.
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['=', '+', '-', '_', '0'].includes(e.key)) e.preventDefault();
});

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (e, info) => report('render', { message: String((e as Error)?.message ?? e), stack: `${(e as Error)?.stack ?? ''}${info.componentStack ?? ''}` }),
});

if (location.hash === '#present') {
  document.documentElement.dataset.theme = 'dark';
  root.render(<Present />);
} else {
  root.render(<App />);
  boot().catch((e) => {
    console.error(e);
    report('boot', e);
    useApp.setState({ ready: true });
  });
}
