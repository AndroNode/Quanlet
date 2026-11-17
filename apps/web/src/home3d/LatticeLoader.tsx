import { useEffect, useRef } from 'react';
import { Q_PATH } from './shapes';
import { FETCH_SHARE, type LoadState } from './loader';

/**
 * The loader for the landing-page 3D scene, drawn on a 2D canvas so it appears at once on every device.
 *
 * It draws the scene's first frame, the lattice shell around the Q, with the same geometry and camera as the
 * WebGL stage, and builds it as the real download progresses: lattice nodes leave a loose cloud and lock into
 * the crystal from the top down, layer by layer, while a ring around it fills. The Q forms last, while the
 * stage builds its points and compiles its shaders. When the stage has rendered, the two pictures line up and
 * the page crossfades into the live 3D scene.
 *
 * If the device cannot run the 3D scene, the finished 2D crystal stays as the hero's picture.
 */

type Mode = 'loading' | 'fallback';

// Same lattice as shapes.ts state 0 and the same camera framing as stage.ts.
const SP = 0.56;
const R_IN = 2.05;
const R_OUT = 3.55;
const MARK_W = 2.6;
const SPIN = 0.07; // rad/s about Y, KEYS[0].speed
const TAN_H = Math.tan((35 * Math.PI) / 360);
const FLIGHT = 0.75; // s

type Pt = {
  x: number; y: number; z: number; // target in world units (lattice) or mark units
  sx: number; sy: number; // loose-cloud position, screen fraction from the centre
  ph: number; // drift phase
  u: number; // progress at which it locks in
  at: number; // time it started to fly in (-1 = not yet)
  size: number;
  mark: boolean;
};

function build(): Pt[] {
  let seed = 23;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts: Pt[] = [];
  const k = Math.ceil(R_OUT / SP);
  const nodes: Array<[number, number, number]> = [];
  for (let x = -k; x <= k; x += 1)
    for (let y = -k; y <= k; y += 1)
      for (let z = -k; z <= k; z += 1) {
        const p: [number, number, number] = [x * SP, y * SP, z * SP];
        const d = Math.hypot(...p);
        if (d >= R_IN && d <= R_OUT) nodes.push(p);
      }
  const cloud = () => {
    const a = rnd() * Math.PI * 2;
    const r = 0.55 + Math.sqrt(rnd()) * 0.9;
    return [Math.cos(a) * r, Math.sin(a) * r * 0.8] as const;
  };
  // Nodes lock in from the top layer down, with a soft, uneven front: a crystal growing.
  const layer = (y: number) => (R_OUT - y) / (2 * R_OUT);
  for (const [x, y, z] of nodes) {
    const [sx, sy] = cloud();
    pts.push({ x, y, z, sx, sy, ph: rnd() * 6.28, u: Math.min(0.995, 0.06 + 0.8 * layer(y) + 0.14 * rnd()) * FETCH_SHARE, at: -1, size: 1.55, mark: false });
  }
  // A sprinkle of edge points between neighbouring nodes, dimmer, as in the stage.
  const set = new Set(nodes.map((p) => p.map((v) => Math.round(v / SP)).join(',')));
  for (const p of nodes)
    for (const d of [[SP, 0, 0], [0, SP, 0], [0, 0, SP]] as const) {
      const q = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
      if (!set.has(q.map((v) => Math.round(v / SP)).join(',')) || rnd() > 0.45) continue;
      const f = 0.25 + rnd() * 0.5;
      const y = p[1] + (q[1]! - p[1]) * f;
      const [sx, sy] = cloud();
      pts.push({ x: p[0] + (q[0]! - p[0]) * f, y, z: p[2] + (q[2]! - p[2]) * f, sx, sy, ph: rnd() * 6.28, u: Math.min(0.995, 0.08 + 0.8 * layer(y) + 0.12 * rnd()) * FETCH_SHARE, at: -1, size: 0.6, mark: false });
    }
  // The Q: sampled from the brand path, half on its edges. It forms after the download, while the stage builds.
  const S = 200;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (g) {
    g.scale(S / 100, S / 100);
    g.fill(new Path2D(Q_PATH));
    const data = g.getImageData(0, 0, S, S).data;
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S && (data[(y * S + x) * 4 + 3] ?? 0) > 127;
    const fill: number[] = [];
    const edge: number[] = [];
    for (let y = 0; y < S; y += 1)
      for (let x = 0; x < S; x += 1) {
        if (!on(x, y)) continue;
        fill.push(x, y);
        if (!on(x - 2, y) || !on(x + 2, y) || !on(x, y - 2) || !on(x, y + 2)) edge.push(x, y);
      }
    for (let i = 0; i < 520 && fill.length; i += 1) {
      const e = rnd() < 0.55 && edge.length > 0;
      const src = e ? edge : fill;
      const j = Math.floor(rnd() * (src.length / 2)) * 2;
      const [sx, sy] = cloud();
      pts.push({
        x: ((src[j]! + rnd()) / S - 0.5) * MARK_W,
        y: -((src[j + 1]! + rnd()) / S - 0.5) * MARK_W,
        z: (rnd() - 0.5) * 0.18,
        sx: sx * 0.6, sy: sy * 0.6, ph: rnd() * 6.28,
        u: FETCH_SHARE + (1 - FETCH_SHARE) * (0.05 + 0.9 * rnd()),
        at: -1, size: e ? 1.4 : 1.05, mark: true,
      });
    }
  }
  return pts;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function LatticeLoader({
  state,
  mode,
  reduced,
  clock,
  onSettled,
}: {
  state: React.MutableRefObject<LoadState>;
  mode: Mode;
  reduced: boolean;
  /** Seconds the scene has turned; the stage starts from it so the two pictures line up at the crossfade. */
  clock: React.MutableRefObject<number>;
  /** Called once the stage is ready and every point has landed: time to crossfade. */
  onSettled?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const label = useRef<HTMLParagraphElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    const canvas = cv.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const pts = build();
    let raf = 0;
    let w = 0, h = 0, dpr = 1;
    let shown = 0; // eased progress for the ring
    let last = performance.now();
    let settled = false;
    let text = '';
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(canvas);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      const st = state.current;
      const fallback = modeRef.current === 'fallback';
      const t = (clock.current += reduced ? 0 : dt);
      // The loader belongs to the hero: it fades out as the page scrolls on, and stops drawing once gone.
      const vh = window.innerHeight || 1;
      const sf = Math.max(0, Math.min(1, 1 - (window.scrollY - vh * 0.25) / (vh * 0.55)));
      box.current?.style.setProperty('--sf', sf.toFixed(3));
      if (sf === 0) {
        // Out of sight: nothing to draw; if the stage is ready, hand over at once.
        if (!settled && !fallback && st.phase === 'ready') {
          settled = true;
          settledRef.current?.();
        }
        return;
      }

      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const nd = Math.min(2, window.devicePixelRatio || 1);
      if (cw !== w || ch !== h || nd !== dpr) {
        w = cw;
        h = ch;
        dpr = nd;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      // camera: as stage.ts frames state 0
      const portrait = w / h < 0.95;
      const fit = 4.05 * (portrait ? 1.2 : 1.45);
      const dist = portrait ? fit / (TAN_H * (w / h)) : fit / TAN_H;
      const f = h / 2 / TAN_H;
      const cx = 0.5 * w;
      const cy = (portrait ? 0.4 : 0.53) * h;
      const ppu = f / dist;
      const R = R_OUT * ppu;

      const p = fallback ? 1 : st.p;
      shown += (p - shown) * (reduced ? 1 : Math.min(1, dt * 5));

      // halo behind the mark, growing with progress
      const halo = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05);
      halo.addColorStop(0, `rgba(137,2,254,${0.1 + 0.22 * shown})`);
      halo.addColorStop(0.35, `rgba(137,2,254,${0.03 + 0.06 * shown})`);
      halo.addColorStop(1, 'rgba(137,2,254,0)');
      g.fillStyle = halo;
      g.fillRect(cx - R * 1.1, cy - R * 1.1, R * 2.2, R * 2.2);

      const a = SPIN * t;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ma = Math.sin(t * 0.42) * 0.32; // the mark's sway, as in the stage
      const cm = Math.cos(ma), sm = Math.sin(ma);
      let flying = 0;
      g.globalCompositeOperation = 'lighter';
      for (const q of pts) {
        // world -> view: lattice turns about Y; the mark sways about Y
        const c = q.mark ? cm : ca, s = q.mark ? sm : sa;
        const x = q.x * c + q.z * s;
        const z = -q.x * s + q.z * c;
        const k = f / (dist - z);
        const tx = cx + x * k;
        const ty = cy - q.y * k;
        const depth = (z + R_OUT) / (2 * R_OUT); // 0 back .. 1 front

        if (q.at < 0 && p >= q.u) q.at = reduced ? t - FLIGHT : t;
        const fly = q.at < 0 ? 0 : Math.min(1, (t - q.at) / FLIGHT);
        if (fly > 0 && fly < 1) flying += 1;
        // loose cloud: drifting points around the crystal
        const lx = cx + q.sx * R * 1.25 + Math.sin(t * 0.6 + q.ph) * 10;
        const ly = cy + q.sy * R * 1.25 + Math.cos(t * 0.5 + q.ph * 1.3) * 10;
        const e = easeOut(fly);
        const px = lx + (tx - lx) * e;
        const py = ly + (ty - ly) * e;
        // a point flashes as it locks in
        const flash = fly > 0 && fly < 1 ? 0 : q.at >= 0 ? Math.max(0, 1 - (t - q.at - FLIGHT) / 0.45) : 0;
        const base = q.mark ? 0.95 : 0.3 + 0.7 * depth;
        const twinkle = 0.5 + 0.5 * Math.sin(t * 2.1 + q.ph * 3);
        const alpha = fly === 0 ? 0.14 + 0.26 * twinkle : Math.min(1, (0.25 + 0.75 * e) * base + flash * 0.8);
        const size = (q.size * (fly === 0 ? 0.95 : 1 + flash * 0.9) * k) / 46;
        g.fillStyle = q.mark ? `rgba(${200 + 24 * e | 0},${150 + 64 * e | 0},255,${alpha})` : `rgba(${150 + 74 * depth | 0},${92 + 122 * depth | 0},255,${alpha})`;
        const r = Math.max(0.6, size);
        g.fillRect(px - r / 2, py - r / 2, r, r);
      }
      g.globalCompositeOperation = 'source-over';

      // progress ring: a fine track, the filled arc and a bright head
      if (!fallback && shown < 0.999) {
        const rr = R * 1.12;
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(201,163,255,0.12)';
        g.beginPath();
        g.arc(cx, cy, rr, 0, Math.PI * 2);
        g.stroke();
        const end = -Math.PI / 2 + shown * Math.PI * 2;
        g.lineWidth = 1.6;
        g.strokeStyle = 'rgba(201,163,255,0.85)';
        g.beginPath();
        g.arc(cx, cy, rr, -Math.PI / 2, end);
        g.stroke();
        const hx = cx + Math.cos(end) * rr, hy = cy + Math.sin(end) * rr;
        const head = g.createRadialGradient(hx, hy, 0, hx, hy, 14);
        head.addColorStop(0, 'rgba(255,255,255,0.95)');
        head.addColorStop(0.25, 'rgba(201,163,255,0.6)');
        head.addColorStop(1, 'rgba(137,2,254,0)');
        g.fillStyle = head;
        g.fillRect(hx - 14, hy - 14, 28, 28);
      }

      // status line, under the mark
      const next =
        fallback
          ? 'Lighter view: this device cannot run the 3D scene'
          : st.phase === 'retry'
            ? 'Slow connection. Trying again'
            : st.phase === 'build'
              ? `Placing ${st.points.toLocaleString('en-US')} points`
              : st.phase === 'compile' || st.phase === 'ready'
                ? 'Compiling shaders'
                : st.fetched >= 0
                  ? `Loading the 3D scene · ${Math.min(99, Math.floor(st.fetched * 100))}%`
                  : 'Loading the 3D scene';
      if (label.current) {
        if (next !== text) label.current.textContent = text = next;
        label.current.style.transform = `translate3d(-50%, ${(cy + MARK_W * 0.62 * ppu + 18).toFixed(1)}px, 0)`;
      }

      if (!settled && !fallback && st.phase === 'ready' && flying === 0 && pts.every((q) => q.at >= 0)) {
        settled = true;
        settledRef.current?.();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [state, reduced, clock]);

  return (
    <div className={`h3d-loader is-${mode}`} ref={box} aria-hidden>
      <canvas ref={cv} />
      <p className="h3d-loader-label" ref={label} />
    </div>
  );
}
