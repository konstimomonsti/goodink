// A real web page inside goodink: a native WebView2 laid over this element's box. Unlike an <iframe>
// it shows every site (no "refused to connect"), and the page gets no app permissions: remote pages
// have no IPC access, so nothing on it can reach goodink or your files.
// A native view always sits above the HTML, so it hides while a dialog or menu would cover it.
import { useEffect, useRef, useState } from 'react';
import { Webview } from '@tauri-apps/api/webview';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { useApp } from '../lib/store';
import { uid } from '../lib/util';
import { api } from '../lib/api';
import { Spinner } from '../ui/primitives';
import { onCoverChange, webPreviewsCovered } from '../ui/overlays';


export function WebPreview({ url, visible = true }: { url: string; visible?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<Webview | null>(null);
  const [failed, setFailed] = useState(false);
  const [, setPlaced] = useState(0);
  const [covered, setCovered] = useState(webPreviewsCovered());
  const dialog = useApp((s) => s.dialog);
  const shown = visible && !dialog && !covered;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => onCoverChange(() => setCovered(webPreviewsCovered())), []);

  // one native view per page shown here
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    let wv: Webview | null = null;
    const label = `preview-${uid()}`;
    const r = el.getBoundingClientRect();
    api
      .webPreviewCreate(label, url, { x: r.left, y: r.top, width: r.width, height: r.height })
      .then(async () => {
        wv = await Webview.getByLabel(label);
        if (!live) return void wv?.close().catch(() => undefined);
        if (!wv) return setFailed(true);
        view.current = wv;
        setPlaced((n) => n + 1);
        await (shownRef.current ? wv.show() : wv.hide()).catch(() => undefined);
      })
      .catch((e) => {
        console.warn('web preview failed', e);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      view.current = null;
      void wv?.close().catch(() => undefined);
    };
  }, [url]);

  // follow the box: window resizes, panels opening, scrolling
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = '';
    const place = () => {
      const r = el.getBoundingClientRect();
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (key === last || !view.current) return;
      last = key;
      void view.current.setPosition(new LogicalPosition(r.left, r.top)).catch(() => undefined);
      void view.current.setSize(new LogicalSize(Math.max(1, r.width), Math.max(1, r.height))).catch(() => undefined);
    };
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    const t = setInterval(place, 500); // layout shifts nothing reports (e.g. a modal animating in)
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const wv = view.current;
    if (!wv) return;
    void (shown ? wv.show() : wv.hide()).catch(() => undefined);
  }, [shown, url]);

  return (
    <div ref={box} className="web-preview" aria-label={`Web page ${url}`} role="region">
      {failed ? <p className="muted">This page could not be shown here. Open it in a goodink window or your browser from the bar above.</p> : <Spinner size={20} />}
    </div>
  );
}
