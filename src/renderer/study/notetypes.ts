// Anki-style note types: named fields, card templates ({{Field}}, {{FrontSide}}, {{cloze:Field}},
// {{type:Field}}, {{hint:Field}}, {{text:Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}}) and
// styling. A note holds one HTML value per field; a card is one template (or one cloze number) of a
// note. Pure functions, no app state, so they can be unit tested.

export interface FieldDef {
  name: string;
  /** keep its content after adding a note (Anki's pin) */
  sticky?: boolean;
}

export interface TemplateDef {
  name: string;
  front: string;
  back: string;
}

export interface NoteType {
  id: string;
  name: string;
  kind: 'standard' | 'cloze';
  fields: FieldDef[];
  templates: TemplateDef[];
  css: string;
}

export interface Note {
  id: string;
  typeId: string;
  /** HTML, in the order of the type's fields */
  fields: string[];
  tags: string[];
  created: number;
  modified: number;
  source?: { kind: 'notebook' | 'link' | 'pdf' | 'youtube'; id: string; label: string };
  /** a handwritten card from a notebook deck: the page is the card */
  page?: { nb: string; page: string };
}

export const DEFAULT_CSS = `.card {
  font-family: system-ui, sans-serif;
  font-size: 22px;
  line-height: 1.5;
  text-align: center;
  color: var(--card-text);
  background: transparent;
}

.cloze {
  font-weight: bold;
  color: var(--card-accent);
}`;

const t = (name: string, front: string, back: string): TemplateDef => ({ name, front, back });
const BACK = '{{FrontSide}}\n\n<hr id="answer">\n\n';

/** The note types every collection starts with, like Anki's. Fixed ids so they are found again. */
export const STOCK_TYPES: NoteType[] = [
  { id: 'nt-basic', name: 'Basic', kind: 'standard', fields: [{ name: 'Front' }, { name: 'Back' }], templates: [t('Card 1', '{{Front}}', `${BACK}{{Back}}`)], css: DEFAULT_CSS },
  {
    id: 'nt-basic-reversed',
    name: 'Basic (and reversed card)',
    kind: 'standard',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [t('Card 1', '{{Front}}', `${BACK}{{Back}}`), t('Card 2', '{{Back}}', `${BACK}{{Front}}`)],
    css: DEFAULT_CSS,
  },
  {
    id: 'nt-basic-optional',
    name: 'Basic (optional reversed card)',
    kind: 'standard',
    fields: [{ name: 'Front' }, { name: 'Back' }, { name: 'Add Reverse' }],
    templates: [t('Card 1', '{{Front}}', `${BACK}{{Back}}`), t('Card 2', '{{#Add Reverse}}{{Back}}{{/Add Reverse}}', `${BACK}{{Front}}`)],
    css: DEFAULT_CSS,
  },
  {
    id: 'nt-basic-typein',
    name: 'Basic (type in the answer)',
    kind: 'standard',
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [t('Card 1', '{{Front}}\n\n{{type:Back}}', '{{Front}}\n\n<hr id="answer">\n\n{{type:Back}}')],
    css: DEFAULT_CSS,
  },
  { id: 'nt-cloze', name: 'Cloze', kind: 'cloze', fields: [{ name: 'Text' }, { name: 'Back Extra' }], templates: [t('Cloze', '{{cloze:Text}}', '{{cloze:Text}}<br>\n{{Back Extra}}')], css: DEFAULT_CSS },
];

// ---- text helpers -------------------------------------------------------------------------------

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Plain text (as typed, or from the AI) as field HTML: escaped, line breaks kept. */
export const textToHtml = (s: string) => escapeHtml(s).replace(/\r?\n/g, '<br>');

/** Field HTML as plain text, for search, the browser table and duplicate checks. */
export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(p|div|li|h\d)\b[^>]*>/gi, '\n')
    .replace(/<(img|audio)\b[^>]*>/gi, (m) => (m.toLowerCase().startsWith('<img') ? ' [image] ' : ' [audio] '))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const isEmpty = (html: string | undefined) => !html || !htmlToText(html).trim() && !/<(img|audio)\b/i.test(html);

// ---- cloze --------------------------------------------------------------------------------------

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(html: string) {
  return [...new Set([...html.matchAll(CLOZE)].map((m) => +m[1]))].sort((a, b) => a - b);
}

function renderCloze(html: string, ord: number, side: 'q' | 'a') {
  return html.replace(CLOZE, (_, n: string, text: string, hint?: string) =>
    +n === ord ? (side === 'q' ? `<span class="cloze">[${hint ?? '…'}]</span>` : `<span class="cloze">${text}</span>`) : text,
  );
}

// ---- templates ----------------------------------------------------------------------------------

/** Where the type-in-the-answer box goes; swapped for an input after sanitizing. */
export const TYPE_MARK = '\u0001TYPEANS\u0001';

export interface RenderCtx {
  deck?: string;
  card?: string;
  /** what the learner typed, for {{type:…}} on the answer side */
  typed?: string;
  frontSide?: string;
}

/** {{#F}}…{{/F}} and {{^F}}…{{/F}}, innermost first. */
function sections(tpl: string, has: (name: string) => boolean) {
  let prev = '';
  let out = tpl;
  while (out !== prev) {
    prev = out;
    out = out.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/g, (_, kind: string, name: string, inner: string) => ((kind === '#') === has(name) ? inner : ''));
  }
  return out;
}

/** Compare a typed answer with the right one, like Anki: right parts green, wrong red, missing grey. */
export function compareTyped(typed: string, correct: string) {
  const a = typed.trim(), b = correct.trim();
  if (!a) return `<div class="typeans-result"><span class="typeans-missing">${escapeHtml(b)}</span></div>`;
  if (a === b) return `<div class="typeans-result"><span class="typeans-good">${escapeHtml(b)}</span></div>`;
  // longest common subsequence, character by character
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0;
  let typedOut = '', correctOut = '';
  const span = (cls: string, s: string) => (s ? `<span class="${cls}">${escapeHtml(s)}</span>` : '');
  let good = '', bad = '', miss = '';
  const flush = () => {
    typedOut += span('typeans-good', good) + span('typeans-bad', bad);
    correctOut += span('typeans-good', good) + span('typeans-missing', miss);
    good = bad = miss = '';
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (bad || miss) flush();
      good += a[i];
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
      if (good) flush();
      miss += b[j++];
    } else {
      if (good) flush();
      bad += a[i++];
    }
  }
  flush();
  return `<div class="typeans-result">${typedOut}<br><span class="typeans-arrow">↓</span><br>${correctOut}</div>`;
}

/** One side of a card as HTML (not yet sanitized). */
export function renderSide(type: NoteType, note: Note, ord: number, side: 'q' | 'a', ctx: RenderCtx = {}): string {
  const tpl = type.kind === 'cloze' ? type.templates[0] : type.templates[ord];
  if (!tpl) return '';
  const value = new Map(type.fields.map((f, i) => [f.name, note.fields[i] ?? '']));
  const src = sections(side === 'q' ? tpl.front : tpl.back, (name) => !isEmpty(value.get(name)));
  return src.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr: string) => {
    if (expr === 'FrontSide') return side === 'a' ? (ctx.frontSide ?? renderSide(type, note, ord, 'q', ctx).replace(TYPE_MARK, '')) : '';
    if (expr === 'Tags') return escapeHtml(note.tags.join(' '));
    if (expr === 'Type') return escapeHtml(type.name);
    if (expr === 'Deck') return escapeHtml(ctx.deck ?? '');
    if (expr === 'Subdeck') return escapeHtml((ctx.deck ?? '').split('::').pop() ?? '');
    if (expr === 'Card') return escapeHtml(ctx.card ?? tpl.name);
    const m = /^(\w+):(.+)$/.exec(expr);
    const filter = m?.[1];
    const name = (m ? m[2] : expr).trim();
    if (!value.has(name)) return `{unknown field ${escapeHtml(name)}}`;
    const v = value.get(name)!;
    if (filter === 'cloze') return type.kind === 'cloze' ? renderCloze(v, ord, side) : v;
    if (filter === 'text') return escapeHtml(htmlToText(v));
    if (filter === 'type') return side === 'q' ? TYPE_MARK : compareTyped(ctx.typed ?? '', htmlToText(type.kind === 'cloze' ? renderCloze(v, ord, 'a').replace(/<[^>]+>/g, '') : v));
    if (filter === 'hint') return isEmpty(v) ? '' : `<details class="hint"><summary>Show ${escapeHtml(name)}</summary>${v}</details>`;
    if (filter) return whole;
    return v;
  });
}

/** Which cards a note has: template indices whose front shows a field, or its cloze numbers. */
export function cardOrdinals(type: NoteType, note: Note): number[] {
  if (note.page) return [0];
  if (type.kind === 'cloze') {
    const used = new Set<string>();
    for (const m of type.templates[0]?.front.matchAll(/\{\{\s*cloze:\s*([^}]+?)\s*\}\}/g) ?? []) used.add(m[1]);
    const nums = new Set<number>();
    type.fields.forEach((f, i) => used.has(f.name) && clozeNumbers(note.fields[i] ?? '').forEach((n) => nums.add(n)));
    return [...nums].sort((a, b) => a - b);
  }
  const blank: Note = { ...note, fields: type.fields.map(() => '') };
  return type.templates.map((_, i) => i).filter((i) => {
    const q = renderSide(type, note, i, 'q');
    return htmlToText(q) !== htmlToText(renderSide(type, blank, i, 'q')) || /<(img|audio)\b/i.test(q) || q.includes(TYPE_MARK) && !isEmpty(note.fields[0]);
  });
}

/** The first field's text, for duplicate checks (Anki compares the first field). */
export const sortField = (note: Note) => htmlToText(note.fields[0] ?? '').toLowerCase();
