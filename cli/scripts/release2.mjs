// Builds the protocol 2.0 release manifest (whitepaper section 15) for one deployment:
//   node scripts/release2.mjs --chain 4663 [--deployment FILE] [--gate-b FILE] [--rpc URL] [--verified] [--out FILE]
//
// Records the source commit, compiler settings, SHA-256 of every contract, verifier and client source file, the
// deployed addresses with their live code hashes (read from --rpc), the supported assets and the smoke-test
// evidence. --verified marks the contracts as source-verified on the explorer (do that first). Read-only.
// Writes contracts/deployments/<chain>.v2.release.json unless --out says otherwise.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPublicClient, http, keccak256 } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const C = join(root, 'contracts');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const chainId = Number(arg('chain', '4663'));
const NAMES = { 4663: 'Robinhood Chain', 46630: 'Robinhood Chain testnet' };
const RPCS = { 4663: 'https://rpc.mainnet.chain.robinhood.com', 46630: 'https://rpc.testnet.chain.robinhood.com' };
const depPath = resolve(arg('deployment', join(C, 'deployments', `${chainId}.v2.json`)));
const gatePath = resolve(arg('gate-b', join(dirname(depPath), `${chainId}.v2.gate-b.json`)));
const out = resolve(arg('out', join(C, 'deployments', `${chainId}.v2.release.json`)));
const verified = process.argv.includes('--verified');
const dep = JSON.parse(readFileSync(depPath, 'utf8'));
if (dep.chainId !== chainId || dep.protocolVersion !== 2) throw new Error(`${depPath} is not a protocol 2.0 deployment on chain ${chainId}`);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const files = (dir, ext = '.sol') =>
  Object.fromEntries(
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith(ext))
      .sort()
      .map((f) => [`${dir}/${f}`, sha(join(root, dir, f))]),
  );
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'contracts/src', 'contracts/helpers', 'contracts/foundry.toml'], { cwd: root }).toString().trim();
if (dirty) throw new Error('contract sources differ from the commit; commit them first so the manifest names the released source');

const pc = createPublicClient({ transport: http(arg('rpc', RPCS[chainId]), { timeout: 30_000 }) });
if ((await pc.getChainId()) !== chainId) throw new Error('RPC is on another chain');
const live = async (address) => {
  const code = await pc.getCode({ address });
  if (!code || code === '0x') throw new Error(`no code at ${address}`);
  return { address, liveCodehash: keccak256(code), admin: null, upgradeable: false, sourceVerified: verified };
};

const contracts = {
  KeyFactoryV2: await live(dep.keyFactoryV2),
  VaultFactoryV2: await live(dep.vaultFactoryV2),
  ...Object.fromEntries(await Promise.all(dep.vaultCodeStores.map(async (a, i) => [`vaultCodeStore${i + 1}`, { ...(await live(a)), sourceVerified: false }]))),
  MLDSA44Verifier: await live(dep.verifier),
  F1600Helper: { ...(await live(dep.f1600Helper)), sourceVerified: false },
};
const gate = existsSync(gatePath) ? JSON.parse(readFileSync(gatePath, 'utf8')) : null;
if (gate) contracts.smokeVault = await live(gate.vault);

const manifest = {
  protocolVersion: 2,
  chainId,
  network: NAMES[chainId] ?? `chain ${chainId}`,
  sourceCommit: commit,
  deployedAtBlock: dep.deployedAtBlock,
  compiler: { solc: '0.8.30', viaIR: true, evmVersion: 'cancun', optimizer: true, optimizerRuns: 10000, bytecodeHash: 'none', cborMetadata: false },
  vaultCreationCodeHash: dep.vaultCreationCodeHash,
  dependencyManifestHash: dep.dependencyManifestHash,
  supportedAssets: dep.supportedAssets,
  contracts,
  source: { files: files('contracts/src/v2') },
  verifier: { files: files('contracts/src/verifier'), vendoredFrom: 'Fireblocks Labs ML-DSA-44 verifier (MIT)', helper: { file: 'contracts/helpers/f1600_170.hex', sha256: sha(join(C, 'helpers', 'f1600_170.hex')) } },
  client: { files: { ...files('apps/web/src/testnet/v2', '.ts'), ...files('cli/lib', '.mjs') } },
  evidence: {
    deployment: relative(root, depPath),
    liveSmoke: gate ? relative(root, gatePath) : null,
    smoke: gate && { fastOverAllowanceRefused: gate.fastOverAllowanceRefused, primaryOnlyProtectedRefused: gate.primaryOnlyProtectedRefused, vaultBalanceAfterWei: String(gate.vaultBalanceAfterWei) },
  },
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release manifest written to ${relative(process.cwd(), out)} (commit ${commit.slice(0, 7)})`);
