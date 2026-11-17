/**
 * Loading the landing-page 3D stage with real progress.
 *
 * The build writes the stage chunk's files and their exact sizes into index.html (see vite.config.ts,
 * <script id="q3d-manifest">). The page downloads those files itself, counting bytes as they stream in, so the
 * loader can show true progress; then import() runs the module straight from the HTTP cache (the files are served
 * immutable). In development there is no manifest, and the download phase is estimated from elapsed time.
 *
 * A download that stalls is retried once; if it fails again the page keeps the lighter 2D view.
 */

export type Phase = 'fetch' | 'retry' | 'build' | 'compile' | 'ready' | 'fallback';

/** Shared, mutable load state: written here and by the page, read every frame by the loader canvas. */
export interface LoadState {
  /** Overall progress 0..1 (download 0..FETCH_SHARE, then building and compiling). */
  p: number;
  phase: Phase;
  /** Download progress 0..1, or -1 when it can only be estimated. */
  fetched: number;
  /** Points the stage builds (shown while building). */
  points: number;
  /** Bytes received and expected (0 when unknown). */
  got: number;
  total: number;
  /** The latest bytes of the stage code as they arrive: the loader draws them. */
  tail: Uint8Array;
}

export const newLoadState = (): LoadState => ({ p: 0, phase: 'fetch', fetched: 0, points: 0, got: 0, total: 0, tail: new Uint8Array(0) });

export const FETCH_SHARE = 0.82;

type Manifest = { files: string[]; bytes: number };

function manifest(): Manifest | null {
  try {
    const el = document.getElementById('q3d-manifest');
    const m = el ? (JSON.parse(el.textContent || '') as Manifest) : null;
    return m && Array.isArray(m.files) && m.files.length && m.bytes > 0 ? m : null;
  } catch {
    return null;
  }
}

class Stalled extends Error {}

/** Downloads every file of the stage chunk, reporting decoded bytes. Aborts if nothing arrives for `stallMs`. */
async function download(m: Manifest, onBytes: (n: number, chunk: Uint8Array) => void, stallMs: number) {
  const ctrl = new AbortController();
  let last = performance.now();
  const watch = window.setInterval(() => {
    if (performance.now() - last > stallMs) ctrl.abort(new Stalled('stalled'));
  }, 500);
  let total = 0;
  try {
    await Promise.all(
      m.files.map(async (url) => {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'force-cache', credentials: 'same-origin' });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          last = performance.now();
          total += value.byteLength;
          onBytes(total, value);
        }
      }),
    );
  } finally {
    clearInterval(watch);
  }
}

/**
 * Brings in the stage module, updating `st` while it downloads. Resolves with the module, or rejects after one
 * retry. `stallMs` is how long a download may receive nothing before it is restarted.
 */
export async function loadStageModule(st: LoadState, stallMs = 12000): Promise<typeof import('./stage')> {
  const m = manifest();
  const setFetched = (f: number) => {
    st.fetched = Math.max(st.fetched, Math.min(1, f));
    st.p = Math.max(st.p, st.fetched * FETCH_SHARE);
  };
  if (!m) {
    // Development: no file list, so estimate the download from elapsed time and settle when the import resolves.
    st.fetched = -1;
    const t0 = performance.now();
    const tick = window.setInterval(() => {
      st.p = Math.max(st.p, FETCH_SHARE * (1 - Math.exp(-(performance.now() - t0) / 1500)));
    }, 100);
    try {
      return await import('./stage');
    } finally {
      clearInterval(tick);
      st.p = Math.max(st.p, FETCH_SHARE);
    }
  }
  st.total = m.bytes;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await download(
        m,
        (n, chunk) => {
          st.got = Math.min(n, m.bytes);
          st.tail = chunk.length > 4096 ? chunk.subarray(chunk.length - 4096) : chunk;
          setFetched(n / m.bytes);
        },
        stallMs,
      );
      setFetched(1);
      return await import('./stage');
    } catch (e) {
      if (attempt === 1) throw e;
      st.phase = 'retry';
      await new Promise((r) => setTimeout(r, 800));
      st.phase = 'fetch';
    }
  }
  throw new Error('unreachable');
}

/** WebGL 2 (three.js needs it) on a GPU that is not a slow software fallback. `force` skips the speed check. */
export function canRun3D(force = false): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', force ? {} : { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    (gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}

/** Resolves after `n` animation frames, so a status change is painted before heavy synchronous work. */
export const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (k: number) => (k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
