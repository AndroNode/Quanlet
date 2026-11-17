import { useEffect, useRef } from 'react';
import { Q_PATH } from './shapes';
import { FETCH_SHARE, type LoadState } from './loader';

/**
 * The landing page's opening while the 3D scene loads, drawn on a 2D canvas so it appears at once everywhere.
 *
 * The scene's own code arrives as bytes; the loader shows those bytes, live, as hex pairs drifting in a cloud.
 * As the download progresses, each pair dissolves into a point and locks into the lattice crystal that is the
 * scene's first frame (same geometry and camera as the WebGL stage), layer by layer from the top. The Q forms
 * last, while the stage builds its points and compiles its shaders. Data becomes structure.
 *
 * Around it, the real steps and a counter. When the stage has rendered, the veil opens from the centre onto
 * the live 3D scene, lined up with the 2D crystal, and the hero title rises.
 *
 * Without an intro (a later visit in the same session) the crystal assembles in place with a short label.
 * If the device cannot run the 3D scene, the finished 2D crystal stays as the hero's picture.
 */

type Mode = 'loading' | 'fallback';

const SP = 0.56;
const R_IN = 2.05;
const R_OUT = 3.55;
const MARK_W = 2.6;
const SPIN = 0.07;
const TAN_H = Math.tan((35 * Math.PI) / 360);
const FLIGHT = 0.8;
const HEX = '0123456789abcdef';

type Pt = {
  x: number; y: number; z: number;
  sx: number; sy: number; sc: number;
  ph: number;
  u: number;
  at: number;
  size: number;
  mark: boolean;
  glyph: boolean; // shows a byte while it waits
  i: number;
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
  // the cloud: a wide, flat drift of bytes around where the crystal will stand
  const cloud = (spread: number) => {
    const a = rnd() * Math.PI * 2;
    const r = 0.35 + Math.pow(rnd(), 0.7) * spread;
    return [Math.cos(a) * r * 1.35, Math.sin(a) * r * 0.78] as const;
  };
  const layer = (y: number) => (R_OUT - y) / (2 * R_OUT);
  let i = 0;
  for (const [x, y, z] of nodes) {
    const [sx, sy] = cloud(1.25);
    pts.push({ x, y, z, sx, sy, sc: 0.75 + rnd() * 0.5, ph: rnd() * 6.28, u: Math.min(0.995, 0.04 + 0.82 * layer(y) + 0.14 * rnd()) * FETCH_SHARE, at: -1, size: 1.55, mark: false, glyph: true, i: i++ });
  }
  const set = new Set(nodes.map((p) => p.map((v) => Math.round(v / SP)).join(',')));
  for (const p of nodes)
    for (const d of [[SP, 0, 0], [0, SP, 0], [0, 0, SP]] as const) {
      const q = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
      if (!set.has(q.map((v) => Math.round(v / SP)).join(',')) || rnd() > 0.45) continue;
      const f = 0.25 + rnd() * 0.5;
      const y = p[1] + (q[1]! - p[1]) * f;
      const [sx, sy] = cloud(1.25);
      pts.push({ x: p[0] + (q[0]! - p[0]) * f, y, z: p[2] + (q[2]! - p[2]) * f, sx, sy, sc: 1, ph: rnd() * 6.28, u: Math.min(0.995, 0.06 + 0.82 * layer(y) + 0.12 * rnd()) * FETCH_SHARE, at: -1, size: 0.6, mark: false, glyph: false, i: i++ });
    }
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
    for (let n = 0; n < 520 && fill.length; n += 1) {
      const e = rnd() < 0.55 && edge.length > 0;
      const src = e ? edge : fill;
      const j = Math.floor(rnd() * (src.length / 2)) * 2;
      const [sx, sy] = cloud(0.9);
      pts.push({
        x: ((src[j]! + rnd()) / S - 0.5) * MARK_W,
        y: -((src[j + 1]! + rnd()) / S - 0.5) * MARK_W,
        z: (rnd() - 0.5) * 0.18,
        sx, sy, sc: 0.7 + rnd() * 0.4, ph: rnd() * 6.28,
        u: FETCH_SHARE + (1 - FETCH_SHARE) * (0.04 + 0.92 * rnd()),
        at: -1, size: e ? 1.4 : 1.05, mark: true, glyph: n % 2 === 0, i: i++,
      });
    }
  }
  return pts;
}

/** Every byte as a hex pair, pre-drawn once: drawing ~1,400 of them per frame then costs little. */
function glyphAtlas(): { img: HTMLCanvasElement; cw: number; ch: number } {
  const cw = 34, ch = 22;
  const img = document.createElement('canvas');
  img.width = cw * 16;
  img.height = ch * 16;
  const g = img.getContext('2d');
  if (g) {
    g.font = '500 17px Geist, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgb(206,178,255)';
    for (let b = 0; b < 256; b += 1) g.fillText(HEX[b >> 4]! + HEX[b & 15]!, (b & 15) * cw + cw / 2, (b >> 4) * ch + ch / 2 + 1);
  }
  return { img, cw, ch };
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const kb = (n: number) => `${Math.round(n / 1024).toLocaleString('en-US')} KB`;

export function LatticeLoader({
  state,
  mode,
  reduced,
  clock,
  intro,
  onSettled,
  onExited,
}: {
  state: React.MutableRefObject<LoadState>;
  mode: Mode;
  reduced: boolean;
  /** Seconds the scene has turned; the stage starts from it so the two pictures line up at the crossfade. */
  clock: React.MutableRefObject<number>;
  /** Show the full-screen opening (first visit in a session). */
  intro: boolean;
  /** The stage is ready and every point has landed: show the 3D canvas. */
  onSettled?: () => void;
  /** The opening has opened onto the page. */
  onExited?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const label = useRef<HTMLParagraphElement>(null);
  const num = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLElement>(null);
  const steps = useRef<HTMLOListElement>(null);
  const skip = useRef<HTMLButtonElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const cb = useRef({ onSettled, onExited });
  cb.current = { onSettled, onExited };
  const skipAsked = useRef(false);

  useEffect(() => {
    const canvas = cv.current;
    const g = canvas?.getContext('2d');
    const root = box.current;
    if (!canvas || !g || !root) return;
    const pts = build();
    let atlas: ReturnType<typeof glyphAtlas> | null = null;
    (document.fonts?.load('500 17px Geist') ?? Promise.resolve()).catch(() => null).then(() => (atlas = glyphAtlas()));

    let raf = 0;
    let w = 0, h = 0, dpr = 1;
    let last = performance.now();
    let settled = false;
    let text = '';
    let shownP = 0;
    let numText = '';
    let stepKey = '';
    // opening: 'on' -> 'closing' (chrome fades) -> 'opening' (veil opens) -> 'off'
    let veilState: 'on' | 'closing' | 'opening' | 'off' = intro ? 'on' : 'off';
    let veilT = 0;
    let fadeOut = -1; // in-place crossfade start (no opening)
    let introAge = 0;
    const scrollLock = intro ? document.documentElement.style.overflow : null;
    if (intro) document.documentElement.style.overflow = 'hidden';
    const unlock = () => {
      if (scrollLock !== null) document.documentElement.style.overflow = scrollLock;
    };
    const startClose = () => {
      if (veilState !== 'on') return;
      veilState = 'closing';
      veilT = 0;
      root.classList.add('is-closing');
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const real = Math.min(0.25, (now - last) / 1000);
      const dt = Math.min(0.05, real);
      last = now;
      if (document.hidden) return;
      const st = state.current;
      const fallback = modeRef.current === 'fallback';
      const t = (clock.current += reduced ? 0 : dt);
      introAge += dt;

      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const nd = Math.min(2, window.devicePixelRatio || 1);
      if (cw !== w || ch !== h || nd !== dpr) {
        w = cw;
        h = ch;
        dpr = nd;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const portrait = w / h < 0.95;
      const fit = 4.05 * (portrait ? 1.2 : 1.45);
      const dist = portrait ? fit / (TAN_H * (w / h)) : fit / TAN_H;
      const f = h / 2 / TAN_H;
      const cx = 0.5 * w;
      const cy = (portrait ? 0.4 : 0.53) * h;
      const ppu = f / dist;
      const R = R_OUT * ppu;

      // ------------------------------------------------ the opening's state
      if (veilState === 'on') {
        if (skip.current && introAge > 4 && !skip.current.classList.contains('on')) skip.current.classList.add('on');
        if (fallback || settled || skipAsked.current) startClose();
      }
      if (veilState === 'closing' || veilState === 'opening') {
        veilT += real; // wall time: the opening keeps its pace on a slow device
        if (veilState === 'closing' && veilT > (reduced ? 0.05 : 0.38)) {
          veilState = 'opening';
          veilT = 0;
        }
        if (veilState === 'opening') {
          const dur = reduced ? 0.25 : 1.15;
          const k = Math.min(1, veilT / dur);
          const e = easeInOut(k);
          const hole = e * Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.15;
          const m = reduced
            ? ''
            : `radial-gradient(circle at ${cx.toFixed(0)}px ${cy.toFixed(0)}px, transparent ${hole.toFixed(0)}px, #000 ${(hole + 90).toFixed(0)}px)`;
          if (veil.current) {
            veil.current.style.setProperty('-webkit-mask-image', m);
            veil.current.style.setProperty('mask-image', m);
            if (reduced) veil.current.style.opacity = String(1 - k);
          }
          if (k >= 1) {
            veilState = 'off';
            root.classList.add('is-open');
            unlock();
            cb.current.onExited?.();
          }
        }
      }

      // the in-place crystal fades as the page scrolls on
      const vh = window.innerHeight || 1;
      const sf = veilState !== 'off' ? 1 : Math.max(0, Math.min(1, 1 - (window.scrollY - vh * 0.25) / (vh * 0.55)));
      root.style.setProperty('--sf', sf.toFixed(3));

      const p = fallback ? 1 : st.p;
      shownP += (p - shownP) * (reduced ? 1 : Math.min(1, dt * 6));

      // ------------------------------------------------ chrome: steps, counter, progress rule
      if (veilState === 'on' || veilState === 'closing') {
        const pct = Math.min(100, Math.floor(shownP * 100 + 0.0001));
        const n = String(pct).padStart(2, '0');
        if (num.current && n !== numText) num.current.textContent = numText = n;
        line.current?.style.setProperty('transform', `scaleX(${shownP.toFixed(4)})`);
        const idx = st.phase === 'fetch' || st.phase === 'retry' ? 0 : st.phase === 'build' ? 1 : st.phase === 'compile' ? 2 : 3;
        const fetchVal = st.phase === 'retry' ? 'Slow connection, trying again' : st.total ? `${kb(st.got)} of ${kb(st.total)}` : '';
        const key = `${idx}|${fetchVal}|${st.points}|${settled}`;
        if (steps.current && key !== stepKey) {
          stepKey = key;
          const li = steps.current.children;
          for (let s = 0; s < li.length; s += 1) (li[s] as HTMLElement).dataset.s = s < idx || (s === 3 && settled) ? 'done' : s === idx ? 'now' : 'todo';
          const v0 = li[0]?.querySelector('.ldr-v');
          if (v0) v0.textContent = fetchVal;
          const v1 = li[1]?.querySelector('.ldr-v');
          if (v1) v1.textContent = st.points ? `${st.points.toLocaleString('en-US')} points` : '';
        }
      }

      // in-place crossfade once the stage is live and there was no opening (or it was skipped)
      if (settled && veilState === 'off' && !fallback && fadeOut < 0) {
        fadeOut = t;
        root.classList.add('is-out');
      }
      if (sf === 0 && veilState === 'off') {
        if (!settled && !fallback && st.phase === 'ready') {
          settled = true;
          cb.current.onSettled?.();
        }
        return;
      }

      // ------------------------------------------------ the crystal
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // During the opening the 2D crystal hands over to the 3D one underneath as the veil passes it.
      let crystalAlpha = 1;
      if (veilState === 'opening' && !fallback && settled) crystalAlpha = Math.max(0, 1 - veilT / 0.7);
      if (veilState === 'off' && settled && !fallback) crystalAlpha = 0;
      g.globalAlpha = crystalAlpha;

      const halo = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.1);
      halo.addColorStop(0, `rgba(137,2,254,${0.08 + 0.26 * shownP})`);
      halo.addColorStop(0.35, `rgba(137,2,254,${0.03 + 0.07 * shownP})`);
      halo.addColorStop(1, 'rgba(137,2,254,0)');
      g.fillStyle = halo;
      g.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      const a = SPIN * t;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ma = Math.sin(t * 0.42) * 0.32;
      const cm = Math.cos(ma), sm = Math.sin(ma);
      const tail = st.tail;
      const tick = Math.floor(t * 9);
      let flying = 0;
      g.globalCompositeOperation = 'lighter';
      const gw = Math.max(9, Math.min(20, R * 0.06));
      for (const q of pts) {
        const c = q.mark ? cm : ca, s = q.mark ? sm : sa;
        const x = q.x * c + q.z * s;
        const z = -q.x * s + q.z * c;
        const k = f / (dist - z);
        const tx = cx + x * k;
        const ty = cy - q.y * k;
        const depth = (z + R_OUT) / (2 * R_OUT);

        if (q.at < 0 && p >= q.u) q.at = reduced ? t - FLIGHT : t;
        const fly = q.at < 0 ? 0 : Math.min(1, (t - q.at) / FLIGHT);
        if (fly > 0 && fly < 1) flying += 1;
        const lx = cx + q.sx * R * 1.3 + Math.sin(t * 0.5 + q.ph) * 12;
        const ly = cy + q.sy * R * 1.3 + Math.cos(t * 0.4 + q.ph * 1.3) * 9;
        const e = easeOut(fly);
        const px = lx + (tx - lx) * e;
        const py = ly + (ty - ly) * e;

        // the byte this point carries while it waits: real bytes of the scene's code as they stream in
        if (q.glyph && fly < 1 && atlas) {
          const byte = tail.length ? tail[(q.i * 37 + (tick + (q.i % 7)) * 13) % tail.length]! : (q.i * 73 + tick * 29) & 255;
          const tw = 0.5 + 0.5 * Math.sin(t * 2.4 + q.ph * 3);
          const ga = (fly === 0 ? 0.18 + 0.42 * tw : 0.6 * (1 - e)) * (q.mark ? 1.1 : 1);
          const s2 = gw * q.sc * (1 - 0.6 * e);
          g.globalAlpha = Math.min(1, ga) * crystalAlpha;
          g.drawImage(atlas.img, (byte & 15) * atlas.cw, (byte >> 4) * atlas.ch, atlas.cw, atlas.ch, px - s2 * 0.77, py - s2 * 0.5, s2 * 1.55, s2);
          g.globalAlpha = crystalAlpha;
        }
        if (fly === 0) continue;
        const flash = fly < 1 ? 0 : Math.max(0, 1 - (t - q.at - FLIGHT) / 0.5);
        const base = q.mark ? 0.95 : 0.3 + 0.7 * depth;
        const alpha = Math.min(1, e * base + flash * 0.85);
        const size = Math.max(0.6, (q.size * (1 + flash * 1.1) * k) / 46);
        g.fillStyle = q.mark ? `rgba(${(200 + 24 * e) | 0},${(150 + 64 * e) | 0},255,${alpha})` : `rgba(${(150 + 74 * depth) | 0},${(92 + 122 * depth) | 0},255,${alpha})`;
        g.fillRect(px - size / 2, py - size / 2, size, size);
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;

      // the opening: a pulse of light runs out from the crystal along the edge of the veil
      if (veilState === 'opening' && !reduced) {
        const k = Math.min(1, veilT / 1.15);
        const hole = easeInOut(k) * Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.15;
        const fade = Math.pow(1 - k, 1.4);
        if (hole > 4 && fade > 0.01) {
          const ring = g.createRadialGradient(cx, cy, Math.max(0, hole - 26), cx, cy, hole + 90);
          ring.addColorStop(0, 'rgba(137,2,254,0)');
          ring.addColorStop(0.2, `rgba(201,163,255,${0.55 * fade})`);
          ring.addColorStop(0.24, `rgba(255,255,255,${0.7 * fade})`);
          ring.addColorStop(0.32, `rgba(137,2,254,${0.25 * fade})`);
          ring.addColorStop(1, 'rgba(137,2,254,0)');
          g.globalCompositeOperation = 'lighter';
          g.fillStyle = ring;
          g.fillRect(0, 0, w, h);
          g.globalCompositeOperation = 'source-over';
        }
      }

      // in-place label (no opening, or after skipping it)
      const next = fallback
        ? 'Lighter view: this device cannot run the 3D scene'
        : veilState !== 'off'
          ? ''
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
        cb.current.onSettled?.();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      unlock();
    };
  }, [state, reduced, clock, intro]);

  return (
    <div className={`h3d-loader is-${mode}${intro ? ' has-intro' : ''}`} ref={box}>
      {intro && (
        <div className="ldr-veil" ref={veil}>
          <div className="ldr-chrome">
            <ol className="ldr-steps" ref={steps} aria-hidden>
              <li data-s="now">
                <span className="ldr-n">1</span>
                <span className="ldr-t">Fetching the scene</span>
                <span className="ldr-v" />
              </li>
              <li data-s="todo">
                <span className="ldr-n">2</span>
                <span className="ldr-t">Placing the lattice</span>
                <span className="ldr-v" />
              </li>
              <li data-s="todo">
                <span className="ldr-n">3</span>
                <span className="ldr-t">Compiling shaders</span>
                <span className="ldr-v" />
              </li>
              <li data-s="todo">
                <span className="ldr-n">4</span>
                <span className="ldr-t">First frame</span>
                <span className="ldr-v" />
              </li>
            </ol>
            <p className="ldr-count" aria-hidden>
              <span className="ldr-num" ref={num}>
                00
              </span>
              <span className="ldr-pct">%</span>
            </p>
            <button type="button" className="ldr-skip" ref={skip} onClick={() => (skipAsked.current = true)}>
              Continue without waiting
            </button>
            <span className="ldr-rule" aria-hidden>
              <i ref={line} />
            </span>
          </div>
        </div>
      )}
      <canvas ref={cv} aria-hidden />
      <p className="h3d-loader-label" ref={label} aria-hidden />
      {intro && (
        <p className="sr-only" role="status">
          Loading the 3D scene
        </p>
      )}
    </div>
  );
}
