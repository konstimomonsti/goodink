import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/** The audience window: the current page, full screen, plus the presenter's laser pointer. */
export function Present() {
  const [frame, setFrame] = useState<{ src: string; w: number; h: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const laser = useRef<{ x: number; y: number; t: number }[]>([]);

  useEffect(() => api.on('present:frame', (f) => setFrame(f)), []);
  useEffect(() => api.on('present:laser', (pts) => (laser.current = pts)), []);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = canvas.current, im = img.current;
      if (c && im) {
        const r = im.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== Math.round(window.innerWidth * dpr)) {
          c.width = Math.round(window.innerWidth * dpr);
          c.height = Math.round(window.innerHeight * dpr);
        }
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, c.width, c.height);
        const now = performance.now();
        const pts = laser.current;
        const P = (p: { x: number; y: number }) => [(r.left + p.x * r.width) * dpr, (r.top + p.y * r.height) * dpr];
        ctx.lineCap = 'round';
        for (let k = 1; k < pts.length; k++) {
          const age = (now - pts[k].t) / 900;
          if (age >= 1 || age < -5) continue;
          const [ax, ay] = P(pts[k - 1]);
          const [bx, by] = P(pts[k]);
          ctx.globalAlpha = Math.max(0, 1 - age);
          ctx.strokeStyle = '#ff3b30';
          ctx.shadowColor = '#ff3b30';
          ctx.shadowBlur = 14 * dpr;
          ctx.lineWidth = 6 * dpr;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
        const last = pts[pts.length - 1];
        if (last && now - last.t < 900) {
          const [x, y] = P(last);
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#ff3b30';
          ctx.beginPath();
          ctx.arc(x, y, 8 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="present">
      {frame ? <img ref={img} src={frame.src} alt="Presented page" /> : <p className="present-wait">Waiting for the presenter…</p>}
      <canvas ref={canvas} className="present-laser" />
    </div>
  );
}
