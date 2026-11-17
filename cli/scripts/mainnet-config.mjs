// Writes the mainnet protocol 2.0 addresses into the site's config (packages/config/src/index.ts, the block between
// the mainnetV2:begin and mainnetV2:end markers) from the deployment manifest DeployV2 wrote.
//
//   node scripts/mainnet-config.mjs                                   # reads ../contracts/deployments/4663.v2.json
//   node scripts/mainnet-config.mjs --manifest <file> --config <file> # e.g. a fork rehearsal, written to a copy
//
// Only reads the chain (the deployment block's date). Run scripts/mainnet-preflight.mjs afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const manifestPath = arg('manifest', join(root, 'contracts', 'deployments', '4663.v2.json'));
const configPath = arg('config', join(root, 'packages', 'config', 'src', 'index.ts'));
const RPC = process.env.QUANLET_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (m.chainId !== 4663) throw new Error(`manifest is for chain ${m.chainId}, not Robinhood Chain mainnet (4663)`);
if (m.protocolVersion !== 2) throw new Error('manifest is not a protocol 2.0 deployment');
const assets = (m.supportedAssets ?? []).map((a) => a.toLowerCase());
if (assets.length !== 1 || assets[0] !== '0x0000000000000000000000000000000000000000') throw new Error('mainnet factory must support ETH only');

const pc = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
if ((await pc.getChainId()) !== 4663) throw new Error('QUANLET_RPC is not Robinhood Chain mainnet (4663)');
const block = await pc.getBlock({ blockNumber: BigInt(m.deployedAtBlock) });
const deployedOn = new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 10);

const rel = relative(root, manifestPath).split('\\').join('/');
const entry = {
  keyFactory: getAddress(m.keyFactoryV2),
  verifier: getAddress(m.verifier),
  vaultFactory: getAddress(m.vaultFactoryV2),
  multicall: MULTICALL3,
  manifestUrl: rel.startsWith('..') ? 'contracts/deployments/4663.v2.json' : rel,
  compatibleVaultFactories: [],
  tokens: [],
  deployedAtBlock: Number(m.deployedAtBlock),
  f1600Helper: getAddress(m.f1600Helper),
  vaultCodeStores: m.vaultCodeStores.map((a) => getAddress(a)),
  deployedOn,
};

const src = readFileSync(configPath, 'utf8');
const re = /( *)\/\/ mainnetV2:begin[^\n]*\n[\s\S]*?\n *\/\/ mainnetV2:end/;
const hit = src.match(re);
if (!hit) throw new Error('mainnetV2 markers not found in the config');
const pad = hit[1];
const body = JSON.stringify(entry, null, 2)
  .split('\n')
  .map((l, i) => (i === 0 ? l : pad + l).replace(/^(\s*)"(\w+)":/, '$1$2:'))
  .join('\n')
  .replace(/"/g, "'");
const block2 = `${pad}// mainnetV2:begin (written by cli/scripts/mainnet-config.mjs from contracts/deployments/4663.v2.json)\n${pad}mainnetV2: ${body},\n${pad}// mainnetV2:end`;
writeFileSync(configPath, src.replace(re, block2));
console.log(`mainnetV2 written to ${relative(process.cwd(), configPath)}: vault factory ${entry.vaultFactory}, block ${entry.deployedAtBlock} (${deployedOn})`);
