// The goodink document model. Shared by the main process (storage) and renderer (engine/UI).
// Coordinates are page units: PDF points (1/72 inch), origin top-left, y down.

export type Id = string;

export interface Folder {
  id: Id;
  title: string;
  parentId: Id | null;
  color: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type CoverStyle = 'none' | 'solid' | 'linen' | 'stripes' | 'dots' | 'grid' | 'gradient' | 'leather';

export interface Cover {
  style: CoverStyle; // 'none' shows the first page as the cover
  color: string;
}

export interface NotebookMeta {
  id: Id;
  title: string;
  folderId: Id | null;
  kind: 'notebook' | 'pdf' | 'flashcards';
  cover: Cover;
  favorite: boolean;
  pageCount: number;
  firstPage: { w: number; h: number };
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  deletedAt: number | null;
  thumbVersion: number;
  lock?: { salt: string; hash: string } | null;
}

export interface Library {
  version: 1;
  folders: Folder[];
  notebooks: NotebookMeta[];
  /** web pages and videos kept in folders next to notebooks (missing in older libraries) */
  links?: LinkItem[];
  /** every link between notes, for backlinks (missing in older libraries) */
  noteLinks?: LinkRef[];
  /** other files in the library's folders on disk (not saved: read from disk) */
  files?: FileItem[];
}

/** A file in a library folder that goodink did not make (a Word document, a photo, a PDF …). */
export interface FileItem {
  /** path inside the library, with "/" */
  rel: string;
  name: string;
  folderId: Id | null;
  size: number;
  modified: number;
}

/** What is on disk (from the backend after every save, and when goodink comes back to the front). */
export interface DiskScan {
  folders: { id: Id; name: string; parent: Id | null; created: number }[];
  notebooks: { id: Id; name?: string; parent?: Id | null; pages?: number; w?: number; h?: number; staged?: boolean }[];
  links: { id: Id; name: string; parent: Id | null; url: string; kind: string; author: string; modified: number }[];
  files: { rel: string; name: string; parent: Id | null; size: number; modified: number }[];
  trashed: Id[];
}

/** A web page or YouTube video in the library. It opens in its own tab (reader or player). */
export interface LinkItem {
  id: Id;
  kind: 'link' | 'youtube';
  title: string;
  url: string;
  /** YouTube: the channel */
  author?: string;
  folderId: Id | null;
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  deletedAt: number | null;
}

export type TemplateKind =
  | 'blank'
  | 'ruled-narrow'
  | 'ruled-college'
  | 'ruled-wide'
  | 'grid-small'
  | 'grid'
  | 'dotted'
  | 'isometric'
  | 'cornell'
  | 'music'
  | 'todo'
  | 'daily'
  | 'weekly'
  | 'flashcard';

export type PaperColor = 'white' | 'cream' | 'dark';

export interface Template {
  kind: TemplateKind;
  paper: PaperColor;
}

export type PageBackground =
  | { type: 'pdf'; asset: Id; page: number } // page index, 0-based
  | { type: 'image'; asset: Id };

export interface PageMeta {
  id: Id;
  w: number;
  h: number;
  template: Template;
  bg?: PageBackground;
  rotation: 0 | 90 | 180 | 270;
  bookmarked?: boolean;
  /** Infinite canvas: the page grows in every direction as you write near an edge. */
  infinite?: boolean;
  /** Infinite canvas only: world coordinate of the page's top-left corner (content never moves). */
  ox?: number;
  oy?: number;
  /** links to other notes drawn over parts of this page (page units) */
  links?: NoteLink[];
}

/** A link from an area of a page to another notebook, or one page of it (like Obsidian or Goodnotes). */
export interface NoteLink {
  id: Id;
  x: number;
  y: number;
  w: number;
  h: number;
  /** target notebook */
  nb: Id;
  /** target page; none = the notebook where it was last left */
  page?: Id;
}

/** One link in the library-wide index, so a page knows what links to it (backlinks). */
export interface LinkRef {
  fromNb: Id;
  fromPage: Id;
  toNb: Id;
  toPage?: Id;
  /** 'area' = drawn with Link on a selection; 'typed' = [[Name]] in a text box */
  kind: 'area' | 'typed';
}

export interface OutlineEntry {
  id: Id;
  title: string;
  pageId: Id;
}

export interface Recording {
  id: Id;
  asset: Id;
  title: string;
  duration: number; // seconds
  createdAt: number;
  pageId?: Id;
}

export interface Flashcard {
  id: Id;
  pageId?: Id; // old notebook decks: the card's page (top half = front, bottom half = back)
  ease: number;
  interval: number; // days
  due: number; // epoch ms
  // Anki scheduler state (renderer/engine/srs.ts); missing on cards saved by older versions
  state?: 'new' | 'learning' | 'review' | 'relearning';
  remaining?: number; // learning steps left
  lapses?: number;
  reps?: number;
  leech?: boolean;
  lastReview?: number; // epoch ms
}

export interface NotebookDoc {
  id: Id;
  pages: PageMeta[];
  outline: OutlineEntry[];
  recordings: Recording[];
  flashcards?: Flashcard[];
  studyLog?: { day: number; newCount: number; reviewCount: number };
  assets: Record<Id, { ext: string; name?: string; bytes: number }>;
}

export type PenKind = 'fountain' | 'ball' | 'brush';
export type StrokeKind = 'pen' | 'highlighter' | 'tape';

/** Serialized stroke (on disk). `pts` is base64 of a Float32Array of x,y,pressure triples. */
export interface StrokeJSON {
  id: Id;
  k: StrokeKind;
  pen?: PenKind;
  c: string; // colour #rrggbb
  w: number; // base width in page units
  pts: string;
  shape?: 1; // geometric shape: rendered as a constant-width polyline
  closed?: 1;
  rev?: 1; // tape revealed
}

export interface TextObject {
  id: Id;
  type: 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  text: string;
  font: string;
  size: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align: 'left' | 'center' | 'right';
  /** line spacing as a multiple of the size (default 1.3) */
  lineHeight?: number;
  bgColor?: string;
}

/** How new text looks: everything of a text box but where it is and what it says. */
export type TextStyle = Pick<TextObject, 'font' | 'size' | 'color' | 'bold' | 'italic' | 'underline' | 'strike' | 'align' | 'lineHeight' | 'bgColor'>;

export interface ImageObject {
  id: Id;
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  /** 'asset:<id>' for stored images, or a data: URL for small vector stickers */
  src: string;
}

/** A PDF page placed on a notebook page like a picture, drawn sharp as vector content. */
export interface PdfObject {
  id: Id;
  type: 'pdf';
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  asset: Id;
  page: number; // 0-based page in the PDF asset
  pw: number; // natural PDF page size in points
  ph: number;
}

export type PageObject = TextObject | ImageObject | PdfObject;

export interface PageJSON {
  v: 1;
  strokes: StrokeJSON[];
  objects: PageObject[];
}

export interface SavedElement {
  id: Id;
  title: string;
  createdAt: number;
  w: number;
  h: number;
  strokes: StrokeJSON[];
  objects: PageObject[];
}

export interface SearchWord {
  t: string;
  b: [number, number, number, number]; // x, y, w, h in page units
}

export interface PageIndex {
  typed: SearchWord[];
  pdf: SearchWord[];
  ocr: SearchWord[];
  ocrStamp: number; // content version the OCR was computed for
}

export interface NotebookIndex {
  pages: Record<Id, PageIndex>;
}

export interface SearchHit {
  notebookId: Id;
  notebookTitle: string;
  pageId: Id;
  pageNumber: number;
  snippet: string;
  source: 'title' | 'typed' | 'pdf' | 'ocr';
}

export type ThemePref = 'system' | 'light' | 'dark';

export interface PenPreset {
  colors: string[];
  sizes: [number, number, number];
}

export interface Settings {
  theme: ThemePref;
  scrollDir: 'vertical' | 'horizontal';
  /** auto: fingers draw until a pen is used; penOnly: fingers always scroll; touch: fingers always draw */
  stylusMode: 'auto' | 'penOnly' | 'touch';
  /** which hand holds the pen: palm rejection ignores touches where that hand rests */
  writingHand: 'right' | 'left';
  holdToShape: boolean;
  holdDelayMs: number;
  eraserMode: 'stroke' | 'precise';
  eraserHighlighterOnly: boolean;
  eraserAutoDeselect: boolean;
  straightHighlighter: boolean;
  lassoAutoDeselect: boolean;
  penKind: PenKind;
  penColors: string[];
  penSizes: [number, number, number];
  hlColors: string[];
  hlSizes: [number, number, number];
  pressure: boolean;
  defaultTemplate: Template;
  defaultSize: PageSizeId;
  defaultOrientation: 'portrait' | 'landscape';
  sort: 'modified' | 'created' | 'title' | 'opened';
  view: 'grid' | 'list';
  /** Files: goodink's notebooks (and links) only, or every file in the folders */
  filesView?: 'notebooks' | 'all';
  ocrEnabled: boolean;
  onboarded: boolean;
  libraryPath: string | null;
  laserMode: 'dot' | 'trail';
  /** how new text boxes look */
  textStyle?: TextStyle;
  /** a pen has been used on this PC: fingers scroll from the first touch */
  penDevice?: boolean;
  ai?: AiSettings;
  /** Live Ink Intelligence: live checking of handwritten math and the insight card */
  live?: LiveSettings;
}

/** off: nothing runs · local: on-device only · smart: local first, AI when needed · max: AI on every block */
export type LiveModeSetting = 'off' | 'local' | 'smart' | 'max';

export interface LiveSettings {
  mode: LiveModeSetting;
  /** small green tick at the end of verified lines */
  showTicks: boolean;
  /** quiet amber dotted underline where the check is unsure */
  underlineUnsure: boolean;
  /** check automatically when the pen settles (otherwise only on request) */
  autoCheck: boolean;
}

export const DEFAULT_LIVE: LiveSettings = { mode: 'smart', showTicks: false, underlineUnsure: true, autoCheck: true };

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'mistral' | 'deepseek' | 'groq' | 'openrouter' | 'ollama' | 'custom';

/** AI provider choices. The API keys themselves are in Windows Credential Manager, never here. */
export interface AiSettings {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  efforts: Partial<Record<ProviderId, string>>;
  baseURLs: Partial<Record<ProviderId, string>>;
  /** providers with a key saved (kept in sync by the settings screen) */
  keys: ProviderId[];
}

export type PageSizeId = 'a4' | 'letter' | 'a5' | 'legal' | 'widescreen' | 'square';

export const PAGE_SIZES: Record<PageSizeId, { label: string; w: number; h: number }> = {
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  letter: { label: 'US Letter', w: 612, h: 792 },
  a5: { label: 'A5', w: 419.53, h: 595.28 },
  legal: { label: 'US Legal', w: 612, h: 1008 },
  widescreen: { label: 'Widescreen 16:9', w: 1024, h: 576 },
  square: { label: 'Square', w: 720, h: 720 },
};

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  scrollDir: 'vertical',
  stylusMode: 'auto',
  writingHand: 'right',
  holdToShape: true,
  holdDelayMs: 550,
  eraserMode: 'precise',
  eraserHighlighterOnly: false,
  eraserAutoDeselect: false,
  straightHighlighter: false,
  lassoAutoDeselect: false,
  penKind: 'fountain',
  penColors: ['#1b1b1f', '#1f4fd1', '#c8202f', '#1d7f45'],
  penSizes: [1.2, 2.2, 4],
  hlColors: ['#ffe066', '#9ef0a8', '#ffb3d1'],
  hlSizes: [10, 16, 24],
  pressure: true,
  defaultTemplate: { kind: 'ruled-college', paper: 'white' },
  defaultSize: 'a4',
  defaultOrientation: 'portrait',
  sort: 'modified',
  view: 'grid',
  ocrEnabled: true,
  onboarded: false,
  libraryPath: null,
  laserMode: 'trail',
};

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
