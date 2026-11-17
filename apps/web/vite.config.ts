import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { Rollup } from 'vite';
type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

/**
 * Writes the landing page's 3D stage chunk (and the chunks it imports) with their sizes into index.html, so the
 * page can download them itself and show real progress (src/home3d/loader.ts).
 */
function stageManifest(): Plugin {
  return {
    name: 'quanlet-stage-manifest',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle as OutputBundle | undefined;
        if (!bundle) return;
        const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === 'chunk');
        const entry = chunks.find((c) => c.isDynamicEntry && c.facadeModuleId?.replace(/\\/g, '/').endsWith('/src/home3d/stage.ts'));
        if (!entry) return;
        // The entry plus every chunk it imports that the page has not loaded already.
        const initial = new Set<string>();
        const walk = (name: string, into: Set<string>) => {
          const c = bundle[name] as OutputChunk | undefined;
          if (!c || c.type !== 'chunk' || into.has(name)) return;
          into.add(name);
          c.imports.forEach((i) => walk(i, into));
        };
        chunks.filter((c) => c.isEntry).forEach((c) => walk(c.fileName, initial));
        const need = new Set<string>();
        walk(entry.fileName, need);
        const files = [...need].filter((f) => !initial.has(f));
        const bytes = files.reduce((s, f) => s + Buffer.byteLength((bundle[f] as OutputChunk).code), 0);
        const json = JSON.stringify({ files: files.map((f) => `/${f}`), bytes });
        return [{ tag: 'script', attrs: { type: 'application/json', id: 'q3d-manifest' }, children: json, injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), stageManifest()],
  build: { target: 'es2022', sourcemap: true },
});
