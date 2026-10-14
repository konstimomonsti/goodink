import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { coverWebPreviews } from './overlays';
import { X } from 'lucide-react';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' };

export function Button({ variant = 'secondary', size = 'md', className = '', ...rest }: BtnProps) {
  return <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest} />;
}

export function IconButton({ label, active, className = '', shortcut, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; shortcut?: string }) {
  return <button type="button" aria-label={label} title={shortcut ? `${label} (${shortcut})` : label} aria-pressed={active} className={`icon-btn ${active ? 'is-active' : ''} ${className}`} {...rest} />;
}

export function Modal({ title, onClose, children, footer, size = 'sm', className = '' }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button:not(.modal-x)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal modal-${size} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton label="Close" className="modal-x" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Floating panel anchored to a rect. Closes on outside pointerdown and Escape. */
export function Popover({ anchor, onClose, children, placement = 'below', className = '', style }: { anchor: DOMRect; onClose: () => void; children: ReactNode; placement?: 'below' | 'above' | 'right'; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = placement === 'right' ? anchor.right + 8 : anchor.left + anchor.width / 2 - w / 2;
    let top = placement === 'below' ? anchor.bottom + 8 : placement === 'above' ? anchor.top - h - 8 : anchor.top;
    if (placement === 'below' && top + h > window.innerHeight - 8) top = anchor.top - h - 8;
    if (placement === 'above' && top < 48) top = anchor.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(44, Math.min(top, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [anchor, placement]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ ...style, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }} role="dialog">
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  run?: () => void;
  separator?: boolean;
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [focus, setFocus] = useState(-1);
  useLayoutEffect(() => {
    const el = ref.current!;
    setPos({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) });
    el.focus();
  }, [x, y]);
  // a native web preview would cover the menu; it steps aside while the menu is open
  useEffect(() => {
    coverWebPreviews(true);
    return () => coverWebPreviews(false);
  }, []);
  const actionable = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = actionable.indexOf(focus);
      const n = e.key === 'ArrowDown' ? (cur + 1) % actionable.length : (cur - 1 + actionable.length) % actionable.length;
      setFocus(actionable[n]);
    } else if (e.key === 'Enter' && focus >= 0) {
      items[focus].run?.();
      onClose();
    }
  };
  return createPortal(
    <div ref={ref} className="menu" role="menu" tabIndex={-1} style={pos} onKeyDown={onKey}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? 'is-danger' : ''} ${focus === i ? 'is-focus' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => {
              it.run?.();
              onClose();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.checked != null && <span className="menu-check">{it.checked ? '✓' : ''}</span>}
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  );
}

export function Swatch({ color, selected, onClick, onContextMenu, size = 22 }: { color: string; selected?: boolean; onClick?: () => void; onContextMenu?: (e: React.MouseEvent) => void; size?: number }) {
  return (
    <button
      type="button"
      className={`swatch ${selected ? 'is-on' : ''}`}
      style={{ ['--sw' as string]: color, width: size, height: size }}
      aria-label={`Colour ${color}`}
      aria-pressed={selected}
      onClick={onClick}
      onContextMenu={onContextMenu}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

/** Where to open a context menu: at the pointer, or at the element when the Menu key or Shift+F10 opened it. */
export function menuPoint(e: { clientX: number; clientY: number; currentTarget: EventTarget }) {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + 12, y: r.top + Math.min(r.height, 40) };
}
