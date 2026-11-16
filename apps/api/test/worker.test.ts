import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const assets = { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher;

function env(kv?: unknown): Env {
  const CONFIG = kv === undefined ? undefined : ({ get: async () => kv } as unknown as KVNamespace);
  return { ASSETS: assets, CONFIG, RELEASE_MODE: 'testnet' };
}

const call = (path: string, e: Env = env()) => worker.fetch(new Request(`https://quanlet.test${path}`), e, ctx);

describe('worker', () => {
  it('reports health', async () => {
    const res = await call('/api/health');
    expect(await res.json()).toEqual({ ok: true, mode: 'testnet', chainId: 46630, rpc: 'public' });
  });

  it('reports the mainnet chain in mainnet mode', async () => {
    const res = await call('/api/health', { ...env(), RELEASE_MODE: 'mainnet' });
    expect(await res.json()).toEqual({ ok: true, mode: 'mainnet', chainId: 4663, rpc: 'public' });
  });

  it('serves safe defaults without KV and rejects bad KV config', async () => {
    const a = (await (await call('/api/config')).json()) as Record<string, unknown>;
    const b = (await (await call('/api/config', env({ nonsense: true, contractAddress: 'not-an-address' }))).json()) as Record<string, unknown>;
    expect(b).toEqual(a);
  });

  it('adds security headers to pages and API', async () => {
    for (const p of ['/', '/api/health', '/api/nope']) {
      const res = await call(p);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    }
    expect((await call('/api/nope')).status).toBe(404);
  });

  it('proxies read-only RPC with the Alchemy key and refuses write methods', async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      seen.push(`${u} ${init.body}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result: '0x1' }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const e = { ...env(), ALCHEMY_API_KEY: 'k3y' };
      const rpc = (b: unknown, en: Env = e) =>
        worker.fetch(new Request('https://quanlet.test/api/rpc', { method: 'POST', body: JSON.stringify(b) }), en, ctx);
      const ok = await rpc({ jsonrpc: '2.0', id: 7, method: 'eth_getBalance', params: ['0x0000000000000000000000000000000000000001', 'latest'] });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 7, result: '0x1' });
      expect(seen[0]).toContain('https://robinhood-testnet.g.alchemy.com/v2/k3y');
      expect(ok.headers.get('x-quanlet-rpc')).toBe('alchemy');
      for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'debug_traceTransaction']) {
        expect((await rpc({ jsonrpc: '2.0', id: 1, method: m, params: [] })).status).toBe(403);
      }
      expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }])).status).toBe(400);
      await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, env());
      expect(seen[1]).toContain('https://rpc.testnet.chain.robinhood.com');
      // Mainnet mode reads Robinhood Chain mainnet and never sends the testnet Alchemy key there.
      const m = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { ...e, RELEASE_MODE: 'mainnet' });
      expect(seen[2]).toContain('https://rpc.mainnet.chain.robinhood.com');
      expect(seen[2]).not.toContain('k3y');
      expect(m.headers.get('x-quanlet-rpc')).toBe('public');
      expect(seen.length).toBe(3);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('caches hashed assets forever', async () => {
    expect((await call('/assets/app.js')).headers.get('cache-control')).toContain('immutable');
  });
});
