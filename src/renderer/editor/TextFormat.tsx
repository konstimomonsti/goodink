// Text settings: used for the text box being edited and, with the Text tool, for how new text looks.
import { useEffect, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Minus, Plus, Strikethrough, Underline } from 'lucide-react';
import type { TextStyle } from '../../shared/types';
import { TEXT_FONTS, LINE_HEIGHT } from '../engine/render';
import { IconButton, Swatch } from '../ui/primitives';

const COLORS = ['#1b1b1f', '#5f6673', '#1f4fd1', '#c8202f', '#1d7f45', '#9a5b00', '#7c3aed', '#d9468c'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 64, 72, 96];
const SPACING = [1, 1.15, LINE_HEIGHT, 1.5, 2];
const FILLS: { value: string; label: string }[] = [
  { value: '', label: 'No fill' },
  { value: '#fff6b3', label: 'Yellow' },
  { value: '#e2ecff', label: 'Blue' },
  { value: '#e3f7e8', label: 'Green' },
  { value: '#ffe3ec', label: 'Pink' },
  { value: '#efe7ff', label: 'Purple' },
  { value: '#f1f2f4', label: 'Grey' },
  { value: '#ffffff', label: 'White' },
];
/** Text styles like in a word processor: one click for a heading or body text. */
const STYLES: { id: string; label: string; style: Partial<TextStyle> }[] = [
  { id: 'title', label: 'Title', style: { size: 32, bold: true, italic: false } },
  { id: 'heading', label: 'Heading', style: { size: 22, bold: true, italic: false } },
  { id: 'subheading', label: 'Subheading', style: { size: 17, bold: true, italic: false } },
  { id: 'body', label: 'Body', style: { size: 14, bold: false, italic: false } },
  { id: 'small', label: 'Small', style: { size: 11, bold: false, italic: false } },
];

const keep = (e: React.MouseEvent) => e.preventDefault(); // the text being typed keeps its caret

export function TextFormat({ value, onChange }: { value: TextStyle; onChange: (patch: Partial<TextStyle>) => void }) {
  const styleId = STYLES.find((s) => s.style.size === value.size && !!s.style.bold === !!value.bold && !value.italic)?.id ?? '';
  const spacing = value.lineHeight ?? LINE_HEIGHT;
  return (
    <>
      <select className="input input-sm" aria-label="Text style" title="Text style" value={styleId} onChange={(e) => onChange(STYLES.find((s) => s.id === e.target.value)!.style)}>
        {!styleId && <option value="">Custom</option>}
        {STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <select className="input input-sm" aria-label="Font" title="Font" value={value.font} onChange={(e) => onChange({ font: e.target.value })} style={{ maxWidth: 140 }}>
        {TEXT_FONTS.map((f) => (
          <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>
            {f.label}
          </option>
        ))}
      </select>
      <SizeField value={value.size} onChange={(size) => onChange({ size })} />
      <span className="tb-sep" />
      <IconButton label="Bold (Ctrl+B)" active={!!value.bold} onMouseDown={keep} onClick={() => onChange({ bold: !value.bold })}>
        <Bold size={16} />
      </IconButton>
      <IconButton label="Italic (Ctrl+I)" active={!!value.italic} onMouseDown={keep} onClick={() => onChange({ italic: !value.italic })}>
        <Italic size={16} />
      </IconButton>
      <IconButton label="Underline (Ctrl+U)" active={!!value.underline} onMouseDown={keep} onClick={() => onChange({ underline: !value.underline })}>
        <Underline size={16} />
      </IconButton>
      <IconButton label="Strikethrough" active={!!value.strike} onMouseDown={keep} onClick={() => onChange({ strike: !value.strike })}>
        <Strikethrough size={16} />
      </IconButton>
      <span className="tb-sep" />
      {(['left', 'center', 'right'] as const).map((a) => (
        <IconButton key={a} label={`Align ${a}`} active={(value.align ?? 'left') === a} onMouseDown={keep} onClick={() => onChange({ align: a })}>
          {a === 'left' ? <AlignLeft size={16} /> : a === 'center' ? <AlignCenter size={16} /> : <AlignRight size={16} />}
        </IconButton>
      ))}
      <select className="input input-sm" aria-label="Line spacing" title="Line spacing" value={spacing} onChange={(e) => onChange({ lineHeight: +e.target.value })}>
        {SPACING.map((n) => (
          <option key={n} value={n}>
            {n === LINE_HEIGHT ? `${n} (normal)` : n.toFixed(n === 1.15 ? 2 : 1)}
          </option>
        ))}
      </select>
      <span className="tb-sep" />
      <div className="colors" onMouseDown={keep}>
        {COLORS.map((c) => (
          <Swatch key={c} color={c} selected={value.color.toLowerCase() === c} onClick={() => onChange({ color: c })} />
        ))}
        <label className={`swatch swatch-custom ${COLORS.includes(value.color.toLowerCase()) ? '' : 'is-on'}`} title="Any colour" style={{ width: 22, height: 22, ['--sw' as string]: COLORS.includes(value.color.toLowerCase()) ? 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' : value.color }}>
          <input type="color" aria-label="Any colour" value={value.color} onChange={(e) => onChange({ color: e.target.value })} />
        </label>
      </div>
      <span className="tb-sep" />
      <select className="input input-sm" aria-label="Fill" title="Fill behind the text" value={value.bgColor ?? ''} onChange={(e) => onChange({ bgColor: e.target.value || undefined })}>
        {FILLS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </>
  );
}

/** Font size: type any size, step with − / +, or pick a common one. */
function SizeField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (n: number) => {
    const v = Math.round(Math.min(288, Math.max(4, n)) * 2) / 2;
    if (Number.isFinite(v) && v !== value) onChange(v);
    else setDraft(String(value));
  };
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? SIZES.find((s) => s > value) ?? value + 8 : [...SIZES].reverse().find((s) => s < value) ?? Math.max(4, value - 1);
    commit(next);
  };
  return (
    <div className="size-field" title="Font size">
      <IconButton label="Smaller" onMouseDown={keep} onClick={() => step(-1)}>
        <Minus size={14} />
      </IconButton>
      <input
        className="input input-sm"
        aria-label="Size"
        list="gi-text-sizes"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          // picked from the list: apply right away
          if (SIZES.includes(+e.target.value) && (e.nativeEvent as InputEvent).inputType === undefined) commit(+e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.preventDefault(), commit(parseFloat(draft)));
          if (e.key === 'ArrowUp') (e.preventDefault(), step(1));
          if (e.key === 'ArrowDown') (e.preventDefault(), step(-1));
          if (e.key === 'Escape') setDraft(String(value));
        }}
        onBlur={() => commit(parseFloat(draft))}
      />
      <datalist id="gi-text-sizes">
        {SIZES.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <IconButton label="Bigger" onMouseDown={keep} onClick={() => step(1)}>
        <Plus size={14} />
      </IconButton>
    </div>
  );
}
