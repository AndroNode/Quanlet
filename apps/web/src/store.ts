import { create } from 'zustand';
import { DEFAULT_CONFIG, parseConfig, type QuanletConfig } from '@quanlet/config';

interface UiStore {
  motion: 'on' | 'off';
  theme: 'dark' | 'light';
  config: QuanletConfig;
  /** Set by the homepage stage once the 3D scene renders; read by the intro hand-off. */
  stage: { ready: boolean; ringScreen?: () => { x: number; y: number; r: number } };
  setStage: (s: UiStore['stage']) => void;
  consoleOpen: boolean | null;
  setConsoleOpen: (o: boolean) => void;
  setMotion: (m: 'on' | 'off') => void;
  setTheme: (t: 'dark' | 'light') => void;
  loadConfig: () => Promise<void>;
}

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference lasts for this visit only */
  }
}

export const useUi = create<UiStore>((set) => ({
  motion: (document.documentElement.dataset.motion as 'on' | 'off') || 'on',
  // The brutalist theme is dark only.
  theme: 'dark',
  config: DEFAULT_CONFIG,
  stage: { ready: false },
  setStage: (stage) => set({ stage }),
  consoleOpen: null,
  setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
  setMotion: (m) => {
    document.documentElement.dataset.motion = m;
    writePref('quanlet.motion', m);
    set({ motion: m });
  },
  setTheme: (t) => {
    document.documentElement.dataset.theme = t;
    writePref('quanlet.theme', t);
    set({ theme: t });
  },
  loadConfig: async () => {
    // Launch values live in Cloudflare KV behind /api/config. The bundled defaults keep the site working without it.
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch('/api/config', { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) set({ config: parseConfig(await res.json()) });
    } catch {
      /* keep defaults */
    }
  },
}));

document.documentElement.dataset.theme = 'dark';
