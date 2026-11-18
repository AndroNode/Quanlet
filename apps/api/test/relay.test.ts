import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { parseSigned, RelayError } from '../src/relay';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const assets = { fetch: async () => new Response('') } as unknown as Fetcher;
// A throwaway key used only by these tests (anvil's well-known first account).
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RELAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const env = (extra: Partial<Env> = {}): Env => ({ ASSETS: assets, RELEASE_MODE: 'mainnet', ...extra });
const post = (path: string, body: unknown, e: Env) =>
  worker.fetch(new Request(`https://quanlet.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': `10.0.0.${Math.floor(Math.random() * 250)}` } }), e, ctx);

const signed = (over: Record<string, unknown> = {}) => ({
  format: 'quanlet-v2-signed-transfer',
  version: 1,
  chainId: 4663,
  vault: '0x3D579C3B61fA81BA35Bd190696533d6e44cE2683',
  transfer: { route: 2, asset: '0x0000000000000000000000000000000000000000', recipient: '0x9d36efA69389EA4096Ed4E71EC23b90dA96d58f8', amount: '1000', feeRecipient: RELAYER, feeWei: '100000000000000' },
  window: { validAfter: '1', validUntil: String(Math.floor(Date.now() / 1000) + 600) },
  pSig: '0x01',
  aSig: '0x02',
  ...over,
});

describe('relayer', () => {
  it('is off without its key', async () => {
    const res = await worker.fetch(new Request('https://quanlet.test/api/relay'), env(), ctx);
    expect(await res.json()).toEqual({ enabled: false });
    expect((await post('/api/relay', signed(), env())).status).toBe(503);
  });

  it('refuses malformed, foreign-network and expired transfers before touching the chain', () => {
    expect(() => parseSigned({ format: 'x' }, 4663)).toThrow(RelayError);
    expect(() => parseSigned(signed({ chainId: 46630 }), 4663)).toThrow(/different network/);
    expect(() => parseSigned(signed({ vault: 'nope' }), 4663)).toThrow(/malformed/);
    expect(parseSigned(signed(), 4663).t.feeWei).toBe(100000000000000n);
  });

  it('only submits transfers that pay the relayer', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    try {
      const e = env({ RELAYER_PRIVATE_KEY: KEY });
      const other = signed({ transfer: { ...signed().transfer, feeRecipient: '0x0000000000000000000000000000000000000001' } });
      const r1 = await post('/api/relay', other, e);
      expect(r1.status).toBe(400);
      expect(((await r1.json()) as { error: string }).error).toContain(RELAYER);
      const r2 = await post('/api/relay', signed({ window: { validAfter: '1', validUntil: '2' } }), e);
      expect(r2.status).toBe(400);
      expect((await post('/api/relay', 'not json', e)).status).toBe(400);
      expect((await post('/api/relay/execute', { vault: 'x' }, e)).status).toBe(400);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
