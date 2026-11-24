// The note editor of Anki's Add and Edit windows, in goodink's design: a rich-text box per field
// (collapsible, pinnable, with an HTML editor), a formatting toolbar (bold … subscript, text colour,
// highlight, clear formatting, lists and alignment, attach, record, MathJax, cloze) and a tag editor.
// Every action works by mouse, touch and keyboard, with Anki's shortcuts.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bold, Italic, Underline, Superscript, Subscript, Baseline, Highlighter, RemoveFormatting, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  IndentIncrease, IndentDecrease, Paperclip, Mic, Sigma, Code, Pin, ChevronDown, ChevronRight, X, Brackets, CircleStop,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { Button, IconButton, Menu, Modal, Popover, type MenuItem } from '../ui/primitives';
import { toast } from '../lib/store';
import { clozeNumbers, type NoteType } from './notetypes';
import { sanitizeCard } from './CardHtml';
import { platformName } from '../lib/util';

// ---- helpers ------------------------------------------------------------------------------------

const PASTE_TAGS = ['b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'br', 'div', 'p', 'span', 'ul', 'ol', 'li', 'img', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'code', 'pre', 'hr', 'font'];

/** Pasted HTML keeps its structure and basic formatting but not the page's fonts and layout (like Anki). */
function cleanPaste(html: string) {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: PASTE_TAGS, ALLOWED_ATTR: ['href', 'src', 'alt', 'color'] });
}

export const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

/** Images go into the note itself; big photos are scaled down so the collection stays small. */
export async function imageHtml(file: Blob, name = 'image') {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    if (file.size > 3_000_000) throw new Error('This image is larger than 3 MB.');
    return `<img src="${await readAsDataUrl(file)}" alt="${name.replace(/"/g, '')}">`;
  }
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const png = file.type === 'image/png' && c.width * c.height < 600_000;
  const out = await c.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.86 });
  return `<img src="${await readAsDataUrl(out)}" alt="${name.replace(/"/g, '')}">`;
}

async function mediaHtml(file: File) {
  if (file.type.startsWith('image/')) return imageHtml(file, file.name);
  if (file.type.startsWith('audio/')) {
    if (file.size > 8_000_000) throw new Error('This sound file is larger than 8 MB.');
    return `<audio controls src="${await readAsDataUrl(file)}"></audio>`;
  }
  throw new Error('Only pictures and sound files can be attached.');
}

const COLORS = ['#000000', '#5f6368', '#c0392b', '#d35400', '#b7950b', '#1e8449', '#2f5b8a', '#7d3c98'];
const MARKS = ['#fff59d', '#ffcc80', '#c5e1a5', '#b3e5fc', '#f8bbd0', '#e0e0e0'];
const loadPref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const savePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* not kept */
  }
};

// ---- the editor ---------------------------------------------------------------------------------

export interface NoteEditorHandle {
  focusField(i: number): void;
  /** run a toolbar action on the field last edited (for window-level shortcuts) */
  command(name: string): void;
}

interface Props {
  type: NoteType;
  fields: string[];
  onField: (i: number, html: string) => void;
  /** Add window: pinned fields keep their content */
  sticky?: Record<number, boolean>;
  onSticky?: (i: number) => void;
  /** a note with the same first field exists */
  duplicate?: ReactNode;
  disabled?: boolean;
}

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor({ type, fields, onField, sticky, onSticky, duplicate, disabled }, ref) {
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [htmlOpen, setHtmlOpen] = useState<Set<number>>(new Set());
  const [active, setActive] = useState(0);
  const last = useRef<{ field: number; range: Range | null }>({ field: 0, range: null });
  const [color, setColor] = useState(() => loadPref('goodink.textColor', '#c0392b'));
  const [mark, setMark] = useState(() => loadPref('goodink.markColor', '#fff59d'));
  const [pop, setPop] = useState<{ kind: 'color' | 'mark'; at: DOMRect } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [recording, setRecording] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const chord = useRef(0);

  // remember the caret of the field being edited, so toolbar buttons (and touch) act on it
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      if (!sel?.rangeCount) return;
      const i = boxes.current.findIndex((b) => b?.contains(sel.anchorNode));
      if (i >= 0) last.current = { field: i, range: sel.getRangeAt(0).cloneRange() };
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const emit = useCallback((i: number) => {
    const el = boxes.current[i];
    if (el) onField(i, el.innerHTML === '<br>' ? '' : el.innerHTML);
  }, [onField]);

  /** Put the caret back into the field last edited. */
  const restore = () => {
    // typing in a field: its own caret is the right one
    const focused = boxes.current.findIndex((b) => b && b === document.activeElement);
    if (focused >= 0) return { el: boxes.current[focused]!, field: focused };
    const { field, range } = last.current;
    const el = boxes.current[field] ?? boxes.current.find(Boolean);
    if (!el) return null;
    if (collapsed.has(field)) setCollapsed((s) => new Set([...s].filter((x) => x !== field)));
    if (document.activeElement !== el) el.focus();
    const sel = document.getSelection();
    if (range && el.contains(range.startContainer) && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (sel && !el.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return { el, field: boxes.current.indexOf(el) };
  };

  const exec = (cmd: string, value?: string) => {
    const at = restore();
    if (!at) return;
    document.execCommand('styleWithCSS', false, cmd === 'hiliteColor' || cmd === 'foreColor' ? 'true' : 'false');
    document.execCommand(cmd, false, value);
    emit(at.field);
  };

  const insertHtml = (html: string) => {
    const at = restore();
    if (!at) return;
    document.execCommand('insertHTML', false, html);
    emit(at.field);
  };

  /** Wrap the selection: text before and after, the selection kept as HTML. */
  const wrap = (before: string, after: string) => {
    const at = restore();
    if (!at) return;
    const sel = document.getSelection()!;
    const div = document.createElement('div');
    if (sel.rangeCount) div.append(sel.getRangeAt(0).cloneContents());
    const inner = div.innerHTML;
    document.execCommand('insertHTML', false, `${before}${inner}${after}`);
    // an empty wrap leaves the caret between the markers, ready to type
    if (!inner) {
      const s = document.getSelection();
      for (let k = 0; k < after.length; k++) s?.modify('move', 'backward', 'character');
    }
    emit(at.field);
  };

  const cloze = (same: boolean) => {
    if (type.kind !== 'cloze') {
      toast('Cloze deletions only work with a Cloze note type. Choose “Cloze” as the type first.', { kind: 'error' });
      return;
    }
    const all = boxes.current.map((b) => b?.innerHTML ?? '').join(' ');
    const max = Math.max(0, ...clozeNumbers(all));
    const n = same ? Math.max(1, max) : max + 1;
    wrap(`{{c${n}::`, '}}');
  };

  const clearFormat = () => {
    exec('removeFormat');
    exec('unlink');
  };

  const attach = async (files: FileList | File[]) => {
    for (const f of [...files]) {
      try {
        insertHtml(await mediaHtml(f));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { kind: 'error' });
      }
    }
  };

  const paragraphMenu = (e: { currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Bulleted list', icon: <List size={15} />, run: () => exec('insertUnorderedList') },
        { label: 'Numbered list', icon: <ListOrdered size={15} />, run: () => exec('insertOrderedList') },
        { separator: true, label: '' },
        { label: 'Align left', icon: <AlignLeft size={15} />, run: () => exec('justifyLeft') },
        { label: 'Center', icon: <AlignCenter size={15} />, run: () => exec('justifyCenter') },
        { label: 'Align right', icon: <AlignRight size={15} />, run: () => exec('justifyRight') },
        { label: 'Justify', icon: <AlignJustify size={15} />, run: () => exec('justifyFull') },
        { separator: true, label: '' },
        { label: 'Indent', icon: <IndentIncrease size={15} />, run: () => exec('indent') },
        { label: 'Outdent', icon: <IndentDecrease size={15} />, run: () => exec('outdent') },
      ],
    });
  };

  const mathMenu = (e: { currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'MathJax inline', shortcut: 'Ctrl+M, M', run: () => wrap('\\(', '\\)') },
        { label: 'MathJax block', shortcut: 'Ctrl+M, E', run: () => wrap('\\[', '\\]') },
        { label: 'MathJax chemistry', shortcut: 'Ctrl+M, C', run: () => wrap('\\(\\ce{', '}\\)') },
      ],
    });
  };

  const toggleHtml = (i: number) => setHtmlOpen((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])));

  const commands: Record<string, () => void> = {
    bold: () => exec('bold'),
    italic: () => exec('italic'),
    underline: () => exec('underline'),
    sup: () => exec('superscript'),
    sub: () => exec('subscript'),
    color: () => exec('foreColor', color),
    mark: () => exec('hiliteColor', mark),
    clear: clearFormat,
    attach: () => file.current?.click(),
    record: () => setRecording(true),
    cloze: () => cloze(false),
    clozeSame: () => cloze(true),
    mathInline: () => wrap('\\(', '\\)'),
    mathBlock: () => wrap('\\[', '\\]'),
    chem: () => wrap('\\(\\ce{', '}\\)'),
    html: () => toggleHtml(last.current.field),
  };

  useImperativeHandle(ref, () => ({
    focusField: (i) => {
      const el = boxes.current[i];
      if (!el) return;
      setCollapsed((s) => new Set([...s].filter((x) => x !== i)));
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(r);
    },
    command: (name) => commands[name]?.(),
  }));

  /** Anki's editor shortcuts inside a field. */
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>, i: number) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (['control', 'shift', 'alt', 'meta'].includes(k)) return; // a modifier on its own keeps a chord going
    if (chord.current && Date.now() - chord.current < 1500 && ctrl && ['m', 'e', 'c'].includes(k)) {
      e.preventDefault();
      chord.current = 0;
      if (k === 'm') commands.mathInline();
      else if (k === 'e') commands.mathBlock();
      else commands.chem();
      return;
    }
    chord.current = 0;
    let run: (() => void) | undefined;
    if (ctrl && !e.shiftKey && !e.altKey && k === 'm') {
      e.preventDefault();
      chord.current = Date.now();
      return;
    }
    if (ctrl && e.shiftKey && k === 'c') run = () => cloze(e.altKey);
    else if (ctrl && e.shiftKey && (e.key === '+' || e.key === '=' || e.code === 'Equal')) run = commands.sup;
    else if (ctrl && !e.shiftKey && (e.key === '=' || e.code === 'Equal')) run = commands.sub;
    else if (ctrl && k === 'r' && !e.shiftKey) run = clearFormat;
    else if (ctrl && e.shiftKey && k === 'x') run = () => toggleHtml(i);
    else if (e.key === 'F7') run = commands.color;
    else if (e.key === 'F8') run = () => setPop({ kind: 'color', at: (e.currentTarget as HTMLElement).getBoundingClientRect() });
    else if (e.key === 'F3') run = commands.attach;
    else if (e.key === 'F5') run = commands.record;
    else if (ctrl && e.shiftKey && k === 'v') {
      // paste as plain text
      e.preventDefault();
      void navigator.clipboard.readText().then((t) => {
        document.execCommand('insertText', false, t);
        emit(i);
      });
      return;
    }
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>, i: number) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('audio/'));
    const html = e.clipboardData.getData('text/html');
    if (files.length) {
      e.preventDefault();
      void attach(files);
    } else if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, cleanPaste(html));
      emit(i);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    const pos = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) {
      const i = boxes.current.findIndex((b) => b?.contains(pos.startContainer));
      if (i >= 0) last.current = { field: i, range: pos };
    }
    void attach(files);
  };

  const keepFocus = (e: React.SyntheticEvent) => e.preventDefault();
  const tool = (label: string, shortcut: string | undefined, icon: ReactNode, run: () => void, extra?: string) => (
    <IconButton label={label} shortcut={shortcut} className={extra} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={run} disabled={disabled}>
      {icon}
    </IconButton>
  );

  return (
    <div className="ne">
      <div className="ne-tools" role="toolbar" aria-label="Formatting">
        <div className="ne-group">
          {tool('Bold', 'Ctrl+B', <Bold size={16} />, commands.bold)}
          {tool('Italic', 'Ctrl+I', <Italic size={16} />, commands.italic)}
          {tool('Underline', 'Ctrl+U', <Underline size={16} />, commands.underline)}
          {tool('Superscript', 'Ctrl+Shift+=', <Superscript size={16} />, commands.sup)}
          {tool('Subscript', 'Ctrl+=', <Subscript size={16} />, commands.sub)}
        </div>
        <div className="ne-group">
          <span className="ne-split">
            {tool('Text colour', 'F7', <span className="ne-color"><Baseline size={16} /><i style={{ background: color }} /></span>, commands.color)}
            <IconButton label="Choose text colour" shortcut="F8" className="ne-caret" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={(e) => setPop({ kind: 'color', at: e.currentTarget.getBoundingClientRect() })} disabled={disabled}>
              <ChevronDown size={12} />
            </IconButton>
          </span>
          <span className="ne-split">
            {tool('Highlight', undefined, <span className="ne-color"><Highlighter size={16} /><i style={{ background: mark }} /></span>, commands.mark)}
            <IconButton label="Choose highlight colour" className="ne-caret" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={(e) => setPop({ kind: 'mark', at: e.currentTarget.getBoundingClientRect() })} disabled={disabled}>
              <ChevronDown size={12} />
            </IconButton>
          </span>
          {tool('Clear formatting', 'Ctrl+R', <RemoveFormatting size={16} />, clearFormat)}
        </div>
        <div className="ne-group">
          <IconButton label="Lists, alignment and indent" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={paragraphMenu} disabled={disabled}>
            <span className="ne-with-caret"><List size={16} /><ChevronDown size={12} /></span>
          </IconButton>
        </div>
        <div className="ne-group">
          {tool('Attach pictures or sound', 'F3', <Paperclip size={16} />, commands.attach)}
          {tool('Record audio', 'F5', <Mic size={16} />, commands.record)}
          <IconButton label="Formulas (MathJax)" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={mathMenu} disabled={disabled}>
            <span className="ne-with-caret"><Sigma size={16} /><ChevronDown size={12} /></span>
          </IconButton>
          {tool('Cloze deletion', 'Ctrl+Shift+C', <Brackets size={16} />, commands.cloze)}
        </div>
        <input ref={file} type="file" hidden multiple accept="image/*,audio/*" onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }} />
      </div>

      <div className="ne-fields">
        {type.fields.map((f, i) => {
          const isCollapsed = collapsed.has(i);
          const pinned = !!sticky?.[i];
          return (
            <div key={`${type.id}:${i}:${f.name}`} className={`ne-field ${active === i ? 'is-active' : ''} ${i === 0 && duplicate ? 'is-dup' : ''}`}>
              <div className="ne-field-head">
                <button type="button" className="ne-field-name" aria-expanded={!isCollapsed} onClick={() => setCollapsed((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))}>
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {f.name}
                </button>
                <span className="ne-field-actions">
                  <IconButton label={htmlOpen.has(i) ? 'Hide HTML editor' : 'Show HTML editor'} shortcut="Ctrl+Shift+X" active={htmlOpen.has(i)} onClick={() => toggleHtml(i)} tabIndex={-1}>
                    <Code size={14} />
                  </IconButton>
                  {onSticky && (
                    <IconButton label={pinned ? 'Unpin: clear after adding' : 'Pin: keep after adding'} active={pinned} aria-pressed={pinned} onClick={() => onSticky(i)} tabIndex={-1}>
                      <Pin size={14} />
                    </IconButton>
                  )}
                </span>
              </div>
              {isCollapsed ? (
                <button type="button" className="ne-collapsed" onClick={() => setCollapsed((s) => new Set([...s].filter((x) => x !== i)))} aria-label={`Show ${f.name}`}>
                  {fields[i] ? '…' : ''}
                </button>
              ) : (
                <>
                  <RichField
                    value={fields[i] ?? ''}
                    label={f.name}
                    disabled={disabled}
                    boxRef={(el) => (boxes.current[i] = el)}
                    onInput={() => emit(i)}
                    onFocus={() => {
                      setActive(i);
                      if (last.current.field !== i) last.current = { field: i, range: null };
                    }}
                    onKeyDown={(e) => onKey(e, i)}
                    onPaste={(e) => onPaste(e, i)}
                    onDrop={onDrop}
                  />
                  {htmlOpen.has(i) && <HtmlEditor value={fields[i] ?? ''} label={f.name} onChange={(v) => onField(i, v)} />}
                </>
              )}
              {i === 0 && duplicate}
            </div>
          );
        })}
      </div>

      {pop && (
        <Popover anchor={pop.at} onClose={() => setPop(null)} className="ne-pop">
          <div className="ne-swatches" role="listbox" aria-label={pop.kind === 'color' ? 'Text colour' : 'Highlight colour'}>
            {(pop.kind === 'color' ? COLORS : MARKS).map((c) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={(pop.kind === 'color' ? color : mark) === c}
                aria-label={c}
                className="ne-swatch"
                style={{ background: c }}
                onMouseDown={keepFocus}
                onClick={() => {
                  if (pop.kind === 'color') {
                    setColor(c);
                    savePref('goodink.textColor', c);
                    exec('foreColor', c);
                  } else {
                    setMark(c);
                    savePref('goodink.markColor', c);
                    exec('hiliteColor', c);
                  }
                  setPop(null);
                }}
              />
            ))}
          </div>
          <label className="ne-custom">
            Other colour
            <input
              type="color"
              value={pop.kind === 'color' ? color : mark}
              onChange={(e) => {
                const c = e.target.value;
                if (pop.kind === 'color') {
                  setColor(c);
                  savePref('goodink.textColor', c);
                } else {
                  setMark(c);
                  savePref('goodink.markColor', c);
                }
              }}
            />
          </label>
          {pop.kind === 'mark' && (
            <Button size="sm" variant="ghost" onMouseDown={keepFocus} onClick={() => { exec('hiliteColor', 'transparent'); setPop(null); }}>
              No highlight
            </Button>
          )}
        </Popover>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {recording && <RecordDialog onClose={() => setRecording(false)} onDone={(html) => { setRecording(false); insertHtml(html); }} />}
    </div>
  );
});

/** A contenteditable box that only takes the value from outside when it really changed there. */
function RichField({ value, label, disabled, boxRef, ...handlers }: {
  value: string;
  label: string;
  disabled?: boolean;
  boxRef: (el: HTMLDivElement | null) => void;
  onInput: () => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    const now = box.innerHTML === '<br>' ? '' : box.innerHTML;
    if (now !== value) box.innerHTML = sanitizeCard(value);
  }, [value]);
  return (
    <div
      ref={(x) => {
        el.current = x;
        boxRef(x);
      }}
      className="ne-rich"
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      spellCheck
      {...handlers}
    />
  );
}

/** The field's HTML, editable as text (Anki's "<>"). */
function HtmlEditor({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  return (
    <textarea
      className="ne-html"
      aria-label={`${label} HTML`}
      spellCheck={false}
      value={value}
      rows={Math.min(12, Math.max(3, value.split('\n').length + Math.ceil(value.length / 90)))}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ---- recording ----------------------------------------------------------------------------------

function RecordDialog({ onClose, onDone }: { onClose: () => void; onDone: (html: string) => void }) {
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const keep = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let live = true;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const r = new MediaRecorder(s, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '' , audioBitsPerSecond: 48000 });
        r.ondataavailable = (e) => chunks.current.push(e.data);
        r.onstop = async () => {
          stream?.getTracks().forEach((t) => t.stop());
          if (!keep.current) return;
          const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
          onDone(`<audio controls src="${await readAsDataUrl(blob)}"></audio>`);
        };
        r.start(250);
        rec.current = r;
        const t0 = Date.now();
        timer = window.setInterval(() => {
          const s2 = Math.floor((Date.now() - t0) / 1000);
          setSecs(s2);
          if (s2 >= 120) stop(true);
        }, 250);
      })
      .catch(() => setError(`goodink could not use a microphone. Check that one is connected and that ${platformName} allows goodink to use it.`));
    return () => {
      live = false;
      clearInterval(timer);
      if (rec.current?.state === 'recording') rec.current.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = (save: boolean) => {
    keep.current = save;
    if (rec.current?.state === 'recording') rec.current.stop();
    if (!save) onClose();
  };

  return (
    <Modal
      title="Record audio"
      onClose={() => stop(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => stop(false)}>Cancel</Button>
          <Button variant="primary" disabled={!!error || !rec.current} onClick={() => stop(true)} data-autofocus>
            <CircleStop size={15} /> Stop and add
          </Button>
        </>
      }
    >
      {error ? (
        <p className="field-hint">{error}</p>
      ) : (
        <div className="ne-rec" aria-live="polite">
          <span className="ne-rec-dot" aria-hidden />
          Recording… {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
          <span className="muted small">Press Enter to stop and add it to the field.</span>
        </div>
      )}
    </Modal>
  );
}

// ---- tags ---------------------------------------------------------------------------------------

export const TagEditor = forwardRef<HTMLInputElement, { tags: string[]; all: string[]; onChange: (t: string[]) => void }>(function TagEditor({ tags, all, onChange }, ref) {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return all.filter((t) => t.toLowerCase().includes(q) && !tags.includes(t)).sort((a, b) => +!a.toLowerCase().startsWith(q) - +!b.toLowerCase().startsWith(q) || a.localeCompare(b)).slice(0, 8);
  }, [text, all, tags]);
  const commit = (raw: string) => {
    const add = raw.split(/[\s,]+/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    if (add.length) onChange([...tags, ...add.filter((t, i) => !tags.includes(t) && add.indexOf(t) === i)]);
    setText('');
    setHi(0);
  };
  return (
    <div className="ne-tags" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      <span className="ne-tags-label">Tags</span>
      {tags.map((t) => (
        <span key={t} className="ne-tag">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)); }}>
            <X size={12} />
          </button>
        </span>
      ))}
      <span className="ne-tag-input">
        <input
          ref={ref}
          value={text}
          aria-label="Add tags"
          placeholder={tags.length ? '' : 'Add tags…'}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (text.trim()) commit(text);
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (/[\s,]$/.test(v)) commit(v);
            else {
              setText(v);
              setHi(0);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && (text.trim() || suggestions.length)) {
              e.preventDefault();
              commit(open && suggestions[hi] ? suggestions[hi] : text);
            } else if (e.key === 'Tab' && open && suggestions[hi] && text.trim()) {
              e.preventDefault();
              commit(suggestions[hi]);
            } else if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setHi((h) => (h + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setHi((h) => (h - 1 + suggestions.length) % suggestions.length);
            } else if (e.key === 'Backspace' && !text && tags.length) {
              e.preventDefault();
              setText(tags[tags.length - 1]);
              onChange(tags.slice(0, -1));
            }
          }}
        />
        {open && suggestions.length > 0 && (
          <ul className="ne-suggest" role="listbox" aria-label="Matching tags">
            {suggestions.map((s, i) => (
              <li key={s} role="option" aria-selected={i === hi} className={i === hi ? 'is-hi' : ''} onMouseDown={(e) => { e.preventDefault(); commit(s); }}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
});
