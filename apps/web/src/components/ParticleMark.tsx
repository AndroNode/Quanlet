import { useEffect, useRef } from 'react';
import { Q_PATH } from '../home3d/shapes';

/**
 * The Quanlet mark drawn in points, as on the landing page, for page headers. Plain 2D canvas: a few hundred
 * points sampled from the mark, each drifting a little around its place. Decorative; still when motion is off.
 */
export function ParticleMark({ caption, className = '' }: { caption?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    // sample the mark once
    const S = 200;
    const src = document.createElement('canvas');
    src.width = src.height = S;
    const sg = src.getContext('2d', { willReadFrequently: true })!;
    sg.scale(S / 100, S / 100);
    sg.fillStyle = '#fff';
    sg.fill(new Path2D(Q_PATH));
    const data = sg.getImageData(0, 0, S, S).data;
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S && (data[(y * S + x) * 4 + 3] ?? 0) > 127;
    const fill: number[] = [], edge: number[] = [];
    for (let y = 0; y < S; y += 1)
      for (let x = 0; x < S; x += 1) {
        if (!on(x, y)) continue;
        fill.push(x, y);
        if (!on(x - 2, y) || !on(x + 2, y) || !on(x, y - 2) || !on(x, y + 2)) edge.push(x, y);
      }
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const N = 900;
    const pts = Array.from({ length: N }, () => {
      const list = rnd() < 0.5 ? edge : fill;
      const k = Math.floor(rnd() * (list.length / 2)) * 2;
      return { x: (list[k] ?? 0) + rnd(), y: (list[k + 1] ?? 0) + rnd(), p: rnd() * Math.PI * 2, s: 1 + rnd() * 1.1, e: list === edge };
    });
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
    let raf = 0, visible = true;
    const draw = (t: number) => {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr)) (cv.width = Math.round(w * dpr)), (cv.height = Math.round(h * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const glow = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      glow.addColorStop(0, 'rgba(137,2,254,0.32)');
      glow.addColorStop(1, 'rgba(137,2,254,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      const k = (w * 0.78) / S, ox = w * 0.11, oy = h * 0.11;
      for (const q of pts) {
        const dx = reduced ? 0 : Math.sin(t * 0.0009 + q.p) * 1.1;
        const dy = reduced ? 0 : Math.cos(t * 0.0011 + q.p * 1.3) * 1.1;
        const a = q.e ? 1 : 0.7 + 0.25 * Math.sin(t * 0.002 + q.p);
        g.fillStyle = q.e ? `rgba(206,170,255,${a})` : `rgba(150,60,255,${a})`;
        const r = q.s * (q.e ? 1.05 : 0.85);
        g.fillRect(ox + q.x * k + dx - r / 2, oy + q.y * k + dy - r / 2, r, r);
      }
      g.globalCompositeOperation = 'source-over';
    };
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (visible) draw(t);
    };
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(cv);
    if (reduced) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);
  return (
    <figure className={`pmark-p ${className}`} aria-hidden>
      <canvas ref={ref} />
      {caption && <figcaption className="caps">{caption}</figcaption>}
    </figure>
  );
}
