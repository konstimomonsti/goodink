import { useEffect, useRef } from 'react';
import type { Cover, CoverStyle, Template } from '../../shared/types';
import { cachedPrims, drawPrims, PAPER } from '../engine/templates';

export const COVER_COLORS = ['#2f3e66', '#2f5b8a', '#4f8a8f', '#3f7a5a', '#7f9a5e', '#c9a24c', '#c98a62', '#b0584f', '#9a5a7a', '#6f5f9e', '#5e6573', '#1c1f26', '#e9e2d0', '#ecd3d0', '#d3e1ec'];
export const COVER_STYLES: { style: CoverStyle; label: string }[] = [
  { style: 'none', label: 'No cover' },
  { style: 'solid', label: 'Solid' },
  { style: 'linen', label: 'Linen' },
  { style: 'leather', label: 'Leather' },
  { style: 'stripes', label: 'Stripes' },
  { style: 'dots', label: 'Dots' },
  { style: 'grid', label: 'Grid' },
  { style: 'gradient', label: 'Gradient' },
];

function patternFor(style: CoverStyle, color: string): React.CSSProperties {
  const light = 'rgba(255,255,255,.14)';
  const dark = 'rgba(0,0,0,.12)';
  switch (style) {
    case 'linen':
      return { background: `repeating-linear-gradient(0deg, ${light} 0 1px, transparent 1px 3px), repeating-linear-gradient(90deg, ${dark} 0 1px, transparent 1px 3px), ${color}` };
    case 'leather':
      return { background: `radial-gradient(circle at 30% 20%, rgba(255,255,255,.18), transparent 55%), radial-gradient(${dark} 1px, transparent 1.4px) 0 0/5px 5px, ${color}` };
    case 'stripes':
      return { background: `repeating-linear-gradient(135deg, ${light} 0 10px, transparent 10px 22px), ${color}` };
    case 'dots':
      return { background: `radial-gradient(${light} 2.2px, transparent 2.6px) 0 0/16px 16px, ${color}` };
    case 'grid':
      return { background: `linear-gradient(${light} 1px, transparent 1px) 0 0/14px 14px, linear-gradient(90deg, ${light} 1px, transparent 1px) 0 0/14px 14px, ${color}` };
    case 'gradient':
      return { background: `linear-gradient(150deg, ${color}, color-mix(in oklab, ${color} 72%, #ffffff) 50%, color-mix(in oklab, ${color} 65%, #000000))` };
    default:
      return { background: color };
  }
}

export function CoverArt({ cover, title, thumb, ratio, kind }: { cover: Cover; title: string; thumb?: string; ratio: number; kind: string }) {
  const style: React.CSSProperties = { aspectRatio: String(ratio) };
  if (cover.style === 'none') {
    return (
      <div className="cover cover-page" style={style}>
        {thumb ? <img src={thumb} alt="" draggable={false} loading="lazy" decoding="async" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <div className="cover-blank" />}
        {kind === 'pdf' && <span className="cover-badge">PDF</span>}
      </div>
    );
  }
  return (
    <div className="cover cover-art" style={{ ...style, ...patternFor(cover.style, cover.color) }}>
      <div className="cover-spine" />
      <div className="cover-plate">
        <span>{title}</span>
      </div>
    </div>
  );
}

export function TemplatePreview({ template, w, h, width = 96 }: { template: Template; w: number; h: number; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const s = (width / w) * dpr;
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = PAPER[template.paper].bg;
    ctx.fillRect(0, 0, w, h);
    drawPrims(ctx, cachedPrims(template, w, h));
  }, [template, w, h, width]);
  return <canvas ref={ref} className="tpl-canvas" style={{ width, height: (width * h) / w }} />;
}
