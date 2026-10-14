export const uid = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...a);
    }, ms);
  };
  d.cancel = () => t && clearTimeout(t);
  return d;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
}

export function mimeFor(ext: string): string {
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', webm: 'audio/webm', bmp: 'image/bmp' } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}

export async function canvasToPng(c: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob = c instanceof HTMLCanvasElement ? await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png')) : await c.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

export const isMac = false;
export const modKey = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;
