import { Hono } from 'hono';
import { DEFAULT_CONFIG, parseConfig } from '@quanlet/config';
import { Relayer, RelayError, limited } from './relay';

export interface Env {
  ASSETS: Fetcher;
  CONFIG?: KVNamespace;
  RELEASE_MODE: string;
  /** Alchemy API key, set as a Worker secret. Never sent to the browser. */
  ALCHEMY_API_KEY?: string;
  /** Local development only: send RPC reads to this URL instead (for example a local test chain). */
  TESTNET_RPC_URL?: string;
  /** Mainnet mode only: the RPC for Robinhood Chain mainnet (defaults to the public endpoint). */
  MAINNET_RPC_URL?: string;
  /** Set on preview deployments: search engines are asked not to index them. */
  PREVIEW?: string;
  /** The relayer's own key (a Worker secret). It only pays gas; without it the relayer is off. */
  RELAYER_PRIVATE_KEY?: string;
  /** Where the relayer pays its earnings above its gas float (a plain variable; see relay.ts sweep). */
  RELAYER_PAYOUT?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Security headers on every API response; static assets get the same via the fetch wrapper below.
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

/** RELEASE_MODE = "mainnet" serves Robinhood Chain mainnet (with a VITE_QUANLET_NETWORK=mainnet build); anything else, testnet. */
const isMainnet = (e: Env) => e.RELEASE_MODE === 'mainnet';

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    mode: c.env.RELEASE_MODE,
    chainId: isMainnet(c.env) ? DEFAULT_CONFIG.networks.mainnet.chainId : DEFAULT_CONFIG.networks.testnet.chainId,
    rpc: isMainnet(c.env) ? (c.env.MAINNET_RPC_URL ? 'custom' : 'public') : c.env.ALCHEMY_API_KEY ? 'alchemy' : 'public',
  }),
);

/**
 * Read-only JSON-RPC proxy for the network this Worker serves. The browser calls /api/rpc and the
 * Worker adds the Alchemy key (testnet), so the key never ships in the site bundle. Only read methods
 * pass; anything that could send or sign is refused. Without a key it uses the public RPC.
 */
export const RPC_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
  'eth_getTransactionCount',
  'eth_gasPrice',
  'eth_estimateGas',
  'eth_getBlockByNumber',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'alchemy_getTokenBalances',
  'alchemy_getTokenMetadata',
]);
const ALCHEMY_TESTNET = 'https://robinhood-testnet.g.alchemy.com/v2/';

/** The RPC this Worker reads and sends through: the override, then Alchemy (testnet), then the public endpoint. */
function upstreamOf(e: Env): string {
  const main = isMainnet(e);
  const key = main ? undefined : e.ALCHEMY_API_KEY?.trim();
  const override = (main ? e.MAINNET_RPC_URL : e.TESTNET_RPC_URL)?.trim();
  return override || (key ? ALCHEMY_TESTNET + encodeURIComponent(key) : DEFAULT_CONFIG.networks[main ? 'mainnet' : 'testnet'].rpcUrl);
}
const RPC_ERR = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

app.post('/api/rpc', async (c) => {
  const text = await c.req.text();
  // Large enough for a key registration dry-run (about 50 KB of hex calldata).
  if (text.length > 131072) return c.json(RPC_ERR(null, -32600, 'Request too large'), 413);
  let body: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return c.json(RPC_ERR(null, -32700, 'Parse error'), 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json(RPC_ERR(null, -32600, 'Send one request at a time'), 400);
  if (typeof body.method !== 'string' || !RPC_METHODS.has(body.method)) return c.json(RPC_ERR(body.id, -32601, 'Method not allowed'), 403);
  const params = Array.isArray(body.params) ? body.params : [];
  const main = isMainnet(c.env);
  const key = main ? undefined : c.env.ALCHEMY_API_KEY?.trim();
  const override = (main ? c.env.MAINNET_RPC_URL : c.env.TESTNET_RPC_URL)?.trim();
  const upstream = upstreamOf(c.env);
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params }),
    });
    const out = await res.text();
    // Pass the JSON-RPC answer through. On an upstream HTTP error, hide the upstream URL and details.
    if (!res.ok) return c.json(RPC_ERR(body.id, -32603, `Upstream error ${res.status}`), 502);
    return c.body(out, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Quanlet-Rpc': override ? (main ? 'custom' : 'local') : key ? 'alchemy' : 'public' });
  } catch {
    return c.json(RPC_ERR(body.id, -32603, 'Upstream unreachable'), 502);
  }
});

/** FR-28: launch config from KV, validated; falls back to safe defaults. Never contains secrets. */
app.get('/api/config', async (c) => {
  let cfg = DEFAULT_CONFIG;
  try {
    const raw = await c.env.CONFIG?.get('config', 'json');
    if (raw) cfg = parseConfig(raw);
  } catch {
    /* keep defaults */
  }
  return c.json(cfg, 200, { 'Cache-Control': 'public, max-age=60' });
});

// ------------------------------------------------------------------ relayer (src/relay.ts)

let relayer: { key: string; mode: string; rpc: string; r: Relayer } | null = null;
function relayerOf(e: Env): Relayer | null {
  const key = e.RELAYER_PRIVATE_KEY?.trim();
  if (!key) return null;
  const rpc = upstreamOf(e);
  if (relayer && relayer.key === key && relayer.mode === e.RELEASE_MODE && relayer.rpc === rpc) return relayer.r;
  const main = isMainnet(e);
  const net = DEFAULT_CONFIG.networks[main ? 'mainnet' : 'testnet'];
  const dep = main ? DEFAULT_CONFIG.deployments.mainnetV2 : DEFAULT_CONFIG.deployments.testnetV2;
  const r = new Relayer({ chainId: net.chainId, name: net.name, rpcUrl: rpc, vaultCodehashes: dep?.vaultCodehashes ?? [] }, key);
  relayer = { key, mode: e.RELEASE_MODE, rpc, r };
  return r;
}

const relayFail = (c: { json: (b: unknown, s: number) => Response }, e: unknown) =>
  e instanceof RelayError ? c.json({ error: e.message, ...e.extra }, e.status) : c.json({ error: 'The relayer is unavailable. Send the transfer from your own wallet.' }, 502);

app.get('/api/relay', async (c) => {
  const r = relayerOf(c.env);
  if (!r) return c.json({ enabled: false }, 200, { 'Cache-Control': 'no-store' });
  try {
    return c.json(await r.status(), 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return relayFail(c, e);
  }
});

async function relayBody(c: { req: { text: () => Promise<string>; header: (n: string) => string | undefined } }) {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (limited(ip)) throw new RelayError(429, 'Too many requests. Wait a minute and try again.');
  const text = await c.req.text();
  if (text.length > 65536) throw new RelayError(413, 'Request too large.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RelayError(400, 'Send JSON.');
  }
}

app.post('/api/relay', async (c) => {
  const r = relayerOf(c.env);
  if (!r) return c.json({ error: 'The relayer is off on this site.' }, 503);
  try {
    const body = await relayBody(c);
    const vault = (body as { vault?: string })?.vault;
    if (typeof vault === 'string' && limited(`vault:${vault.toLowerCase()}`, 6, 600_000)) throw new RelayError(429, 'Too many relayed transfers for this vault. Wait a few minutes.');
    return c.json(await r.submit(body), 200);
  } catch (e) {
    return relayFail(c, e);
  }
});

app.post('/api/relay/execute', async (c) => {
  const r = relayerOf(c.env);
  if (!r) return c.json({ error: 'The relayer is off on this site.' }, 503);
  try {
    return c.json(await r.execute(await relayBody(c)), 200);
  } catch (e) {
    return relayFail(c, e);
  }
});

app.post('/api/relay/sweep', async (c) => {
  const r = relayerOf(c.env);
  if (!r) return c.json({ error: 'The relayer is off on this site.' }, 503);
  try {
    if (limited('sweep', 2, 600_000)) throw new RelayError(429, 'Paid out recently. Try again in a few minutes.');
    return c.json(await r.sweep(c.env.RELAYER_PAYOUT?.trim()), 200);
  } catch (e) {
    return relayFail(c, e);
  }
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const res = url.pathname.startsWith('/api/') ? await app.fetch(req, env, ctx) : await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    if (env.PREVIEW) out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    // Content-hashed files (build assets, fonts, sound sprites) never change under the same name.
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/sound/')) {
      out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return out;
  },
};
