// Content hashes for live checks: a block's key changes when any of its strokes is added, removed,
// moved or redrawn, and only then. Results (local and AI) are cached under these keys.
import type { InkBlock, Stroke } from '../contract';

/** 53-bit string hash (cyrb53), as 14 hex digits. Fast and well distributed; not cryptographic. */
export function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * The content key of a block: its strokes' ids, point counts and boxes relative to the block (so
 * moving the whole block keeps the key, redrawing or nudging one stroke changes it), line by line.
 */
export function blockKey(block: InkBlock, strokes: ReadonlyMap<string, Stroke>): string {
  const ox = block.bbox[0], oy = block.bbox[1];
  const q = (v: number) => Math.round(v * 2); // half-point resolution
  const parts: string[] = [];
  for (const line of block.lines) {
    const ids = [...line.strokeIds].sort();
    const ls: string[] = [];
    for (const id of ids) {
      const s = strokes.get(id);
      ls.push(s ? `${id}:${s.pts.length}:${q(s.bbox[0] - ox)},${q(s.bbox[1] - oy)},${q(s.bbox[2] - ox)},${q(s.bbox[3] - oy)}` : id);
    }
    parts.push(ls.join(';'));
  }
  return hash53(parts.join('|'));
}
