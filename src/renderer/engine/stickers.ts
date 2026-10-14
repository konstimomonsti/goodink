// Built-in sticker collections. Every sticker is original vector art written here as SVG.

const svg = (w: number, h: number, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w * 4}" height="${h * 4}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;

export interface Sticker {
  id: string;
  label: string;
  w: number;
  h: number;
  src: string;
}

const star = (c: string) => svg(48, 48, `<path d="M24 4l5.9 12.6 13.8 1.6-10.2 9.4 2.8 13.6L24 34.4 11.7 41.2l2.8-13.6L4.3 18.2l13.8-1.6z" fill="${c}" stroke="#00000022" stroke-width="1.2" stroke-linejoin="round"/>`);
const heart = (c: string) => svg(48, 44, `<path d="M24 41S4 29 4 15.5C4 8.6 9.4 4 15 4c4 0 7.3 2.3 9 5.6C25.7 6.3 29 4 33 4c5.6 0 11 4.6 11 11.5C44 29 24 41 24 41z" fill="${c}" stroke="#00000022" stroke-width="1.2"/>`);
const note = (c: string, fold: string) => svg(80, 80, `<path d="M4 4h72v56L56 76H4z" fill="${c}"/><path d="M56 76V60h20z" fill="${fold}"/><path d="M4 4h72v4H4z" fill="#00000010"/>`);
const tab = (c: string, text: string) => svg(110, 34, `<rect x="1" y="1" width="108" height="32" rx="16" fill="${c}"/><text x="55" y="22" text-anchor="middle" font-family="Segoe UI, sans-serif" font-weight="700" font-size="14" fill="#fff">${text}</text>`);
const washi = (c: string, c2: string) => svg(160, 30, `<defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="12" fill="${c2}"/></pattern></defs><path d="M2 3l4 2-3 3 3 3-3 3 3 3-3 3 3 3-3 3 2 2h152l-2-2 3-3-3-3 3-3-3-3 3-3-3-3 3-3-3-3 2-2z" fill="${c}"/><path d="M2 3l4 2-3 3 3 3-3 3 3 3-3 3 3 3-3 3 2 2h152l-2-2 3-3-3-3 3-3-3-3 3-3-3-3 3-3-3-3 2-2z" fill="url(#p)" opacity=".35"/>`);
const arrow = (c: string) => svg(80, 40, `<path d="M4 20h58" stroke="${c}" stroke-width="6" stroke-linecap="round"/><path d="M52 6l20 14-20 14" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
const curvy = (c: string) => svg(80, 50, `<path d="M6 40C20 6 50 6 64 26" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"/><path d="M52 24l13 3 2-13" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`);
const check = (c: string) => svg(48, 48, `<circle cx="24" cy="24" r="21" fill="${c}"/><path d="M14 25l7 7 13-15" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`);
const cross = (c: string) => svg(48, 48, `<circle cx="24" cy="24" r="21" fill="${c}"/><path d="M16 16l16 16M32 16L16 32" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`);
const bang = (c: string) => svg(48, 48, `<path d="M24 3l21 39H3z" fill="${c}" stroke-linejoin="round"/><path d="M24 17v12" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="24" cy="36" r="2.8" fill="#fff"/>`);
const face = (bg: string, mouth: string) => svg(48, 48, `<circle cx="24" cy="24" r="21" fill="${bg}"/><circle cx="17" cy="20" r="3" fill="#3a2a10"/><circle cx="31" cy="20" r="3" fill="#3a2a10"/>${mouth}`);
const bulb = svg(48, 56, `<path d="M24 4a16 16 0 0 0-9 29c2 1.6 3 3.6 3 6v3h12v-3c0-2.4 1-4.4 3-6A16 16 0 0 0 24 4z" fill="#ffd54a" stroke="#c99700" stroke-width="1.5"/><rect x="18" y="44" width="12" height="4" rx="2" fill="#8a8a96"/><rect x="19" y="49" width="10" height="4" rx="2" fill="#8a8a96"/>`);
const pin = svg(40, 52, `<circle cx="20" cy="16" r="13" fill="#e5484d"/><circle cx="16" cy="12" r="4" fill="#ffffff66"/><path d="M20 29v20" stroke="#6b6b75" stroke-width="3" stroke-linecap="round"/>`);
const clip = svg(30, 70, `<path d="M10 60V14a7 7 0 0 1 14 0v44a10 10 0 0 1-20 0V20" fill="none" stroke="#8a8f9c" stroke-width="3.5" stroke-linecap="round"/>`);
const banner = (c: string) => svg(140, 40, `<path d="M0 8h16v26H0l6-13z" fill="${c}" opacity=".7"/><path d="M140 8h-16v26h16l-6-13z" fill="${c}" opacity=".7"/><rect x="12" y="2" width="116" height="30" rx="3" fill="${c}"/>`);
const calendar = svg(48, 48, `<rect x="4" y="8" width="40" height="36" rx="6" fill="#fff" stroke="#c22f2f" stroke-width="2"/><path d="M4 14a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v6H4z" fill="#c22f2f"/><path d="M14 4v8M34 4v8" stroke="#555" stroke-width="3" stroke-linecap="round"/>`);
const flag = (c: string) => svg(40, 48, `<path d="M8 4v42" stroke="#555" stroke-width="3" stroke-linecap="round"/><path d="M9 6h26l-6 9 6 9H9z" fill="${c}"/>`);
const bracket = (c: string) => svg(24, 120, `<path d="M20 4C10 4 10 10 10 20v26c0 8-4 12-8 14 4 2 8 6 8 14v26c0 10 0 16 10 16" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`);
const cloud = svg(90, 54, `<path d="M22 48a16 16 0 0 1-2-32 22 22 0 0 1 41-4 15 15 0 0 1 19 21 13 13 0 0 1-8 15z" fill="#eef4ff" stroke="#7d9cff" stroke-width="2"/>`);

export const STICKER_SETS: { name: string; items: Sticker[] }[] = [
  {
    name: 'Marks',
    items: [
      { id: 'star-y', label: 'Gold star', w: 36, h: 36, src: star('#ffc83d') },
      { id: 'star-p', label: 'Pink star', w: 36, h: 36, src: star('#ff7eb6') },
      { id: 'heart', label: 'Heart', w: 36, h: 33, src: heart('#ff5a6e') },
      { id: 'check', label: 'Done', w: 32, h: 32, src: check('#22a06b') },
      { id: 'cross', label: 'No', w: 32, h: 32, src: cross('#e5484d') },
      { id: 'bang', label: 'Important', w: 32, h: 32, src: bang('#f59e0b') },
      { id: 'bulb', label: 'Idea', w: 30, h: 35, src: bulb },
      { id: 'pin', label: 'Pin', w: 26, h: 34, src: pin },
      { id: 'flag', label: 'Flag', w: 28, h: 34, src: flag('#2b59d9') },
      { id: 'cal', label: 'Calendar', w: 32, h: 32, src: calendar },
    ],
  },
  {
    name: 'Faces',
    items: [
      { id: 'happy', label: 'Happy', w: 32, h: 32, src: face('#ffd54a', '<path d="M15 29c5 6 13 6 18 0" fill="none" stroke="#3a2a10" stroke-width="3" stroke-linecap="round"/>') },
      { id: 'meh', label: 'Meh', w: 32, h: 32, src: face('#ffd54a', '<path d="M16 31h16" stroke="#3a2a10" stroke-width="3" stroke-linecap="round"/>') },
      { id: 'sad', label: 'Sad', w: 32, h: 32, src: face('#ffd54a', '<path d="M15 34c5-6 13-6 18 0" fill="none" stroke="#3a2a10" stroke-width="3" stroke-linecap="round"/>') },
      { id: 'wow', label: 'Wow', w: 32, h: 32, src: face('#ffd54a', '<circle cx="24" cy="32" r="4.5" fill="#3a2a10"/>') },
      { id: 'love', label: 'Love', w: 32, h: 32, src: face('#ffb3c7', '<path d="M15 29c5 6 13 6 18 0" fill="none" stroke="#3a2a10" stroke-width="3" stroke-linecap="round"/>') },
    ],
  },
  {
    name: 'Notes & tabs',
    items: [
      { id: 'note-y', label: 'Yellow note', w: 90, h: 90, src: note('#fff1a8', '#f1dc6b') },
      { id: 'note-b', label: 'Blue note', w: 90, h: 90, src: note('#cfe3ff', '#a7c6f2') },
      { id: 'note-g', label: 'Green note', w: 90, h: 90, src: note('#cdf3d5', '#a3dcb0') },
      { id: 'note-p', label: 'Pink note', w: 90, h: 90, src: note('#ffd6e5', '#f2b0c9') },
      { id: 'tab-todo', label: 'To do tab', w: 82, h: 25, src: tab('#2b59d9', 'TO DO') },
      { id: 'tab-exam', label: 'Exam tab', w: 82, h: 25, src: tab('#c22f2f', 'EXAM') },
      { id: 'tab-idea', label: 'Idea tab', w: 82, h: 25, src: tab('#1d7a4a', 'IDEA') },
      { id: 'tab-review', label: 'Review tab', w: 82, h: 25, src: tab('#7c3aed', 'REVIEW') },
      { id: 'banner-b', label: 'Banner', w: 140, h: 40, src: banner('#7d9cff') },
      { id: 'banner-p', label: 'Banner pink', w: 140, h: 40, src: banner('#ff8fb1') },
      { id: 'cloud', label: 'Thought', w: 90, h: 54, src: cloud },
      { id: 'clip', label: 'Paper clip', w: 18, h: 42, src: clip },
    ],
  },
  {
    name: 'Washi',
    items: [
      { id: 'washi-mint', label: 'Mint washi', w: 140, h: 26, src: washi('#9fe3c9', '#ffffff') },
      { id: 'washi-rose', label: 'Rose washi', w: 140, h: 26, src: washi('#f7b5c8', '#ffffff') },
      { id: 'washi-sky', label: 'Sky washi', w: 140, h: 26, src: washi('#a9cbff', '#ffffff') },
      { id: 'washi-sun', label: 'Sun washi', w: 140, h: 26, src: washi('#ffd36e', '#fff6d6') },
    ],
  },
  {
    name: 'Arrows',
    items: [
      { id: 'arrow-k', label: 'Arrow', w: 60, h: 30, src: arrow('#1b1b1f') },
      { id: 'arrow-r', label: 'Red arrow', w: 60, h: 30, src: arrow('#c8202f') },
      { id: 'curvy-b', label: 'Curved arrow', w: 60, h: 38, src: curvy('#1f4fd1') },
      { id: 'bracket', label: 'Bracket', w: 16, h: 80, src: bracket('#1b1b1f') },
    ],
  },
];
