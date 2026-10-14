performance.mark('gi-main');
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { Present } from './present/Present';
import * as store from './lib/store';
import { boot, useApp } from './lib/store';

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

const root = createRoot(document.getElementById('root')!);

if (location.hash === '#present') {
  document.documentElement.dataset.theme = 'dark';
  root.render(<Present />);
} else {
  root.render(<App />);
  boot().catch((e) => {
    console.error(e);
    useApp.setState({ ready: true });
  });
}
