// Native web previews (library/WebPreview) sit above all HTML, so anything that pops up over them
// (menus, popovers) says so here while it is open, and the previews hide meanwhile.
let count = 0;
const listeners = new Set<() => void>();

export function coverWebPreviews(on: boolean) {
  count = Math.max(0, count + (on ? 1 : -1));
  listeners.forEach((l) => l());
}

export const webPreviewsCovered = () => count > 0;

export function onCoverChange(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
