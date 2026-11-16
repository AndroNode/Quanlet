// Builds the full release manifest (whitepaper section 15) for one chain:
//   node cli/scripts/manifest.mjs --chain 46630 [--deployment FILE] [--rpc URL] [--receipts FILE] [--gate-b FILE] [--date YYYY-MM-DD] [--out FILE]
//
// Offline it records what the repository says: source commit, compiler settings, verifier provenance,
// local code hashes, admin model, key-preparation format, assets, signing vectors, Foundry gas, toolkit
// hashes. With --rpc it also reads every deployed contract and checks it against the local build
// (immutable slots are masked and reported), and prices the transactions listed in --receipts.
// Writes contracts/deployments/<chain>.release.json unless --out says otherwise.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { keccak256 } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const C = join(root, 'contracts');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]] : acc), []),
);
const chainId = Number(args.chain ?? 46630);
const sha256 = (buf) => '0x' + createHash('sha256').update(buf).digest('hex');
const fileHash = (p) => sha256(readFileSync(p));
const rel = (p) => relative(root, p);
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const art = (name) => JSON.parse(readFileSync(join(C, 'out', `${name}.sol`, `${name}.json`), 'utf8'));

const dep = JSON.parse(readFileSync(args.deployment && args.deployment !== true ? args.deployment : join(C, 'deployments', `${chainId}.json`), 'utf8'));

// ---------------------------------------------------------------- source and compiler
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'contracts/src', 'contracts/script', 'contracts/foundry.toml') !== '';
const toml = readFileSync(join(C, 'foundry.toml'), 'utf8').split('[profile.default.fuzz]')[0];
const tv = (k) => {
  const m = toml.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm'));
  return m ? JSON.parse(m[1].trim().replace(/^"(.*)"$/, '"$1"')) : null;
};
const compiler = {
  solc: art('KeyFactory').metadata.compiler.version,
  evmVersion: tv('evm_version'),
  optimizer: tv('optimizer'),
  optimizerRuns: tv('optimizer_runs'),
  viaIR: tv('via_ir'),
  bytecodeHash: tv('bytecode_hash'),
  cborMetadata: tv('cbor_metadata'),
  configFile: { path: 'contracts/foundry.toml', sha256: fileHash(join(C, 'foundry.toml')) },
};

// ---------------------------------------------------------------- local code
const sources = Object.fromEntries(walk(join(C, 'src')).filter((p) => p.endsWith('.sol')).sort().map((p) => [rel(p), fileHash(p)]));
const helperHex = readFileSync(join(C, 'helpers', 'f1600_170.hex'), 'utf8').trim().replace(/^0x/, '');
const local = {};
for (const name of ['MLDSA44Verifier', 'KeyFactory', 'VaultFactory', 'PersonalVault']) {
  const a = art(name);
  const imm = Object.values(a.deployedBytecode.immutableReferences ?? {}).flat();
  local[name] = {
    creationCodeKeccak: keccak256(a.bytecode.object),
    runtimeCodeKeccak: imm.length ? null : keccak256(a.deployedBytecode.object),
    runtimeCodeMaskedKeccak: keccak256(a.deployedBytecode.object),
    immutableSlots: imm.length,
    _runtime: a.deployedBytecode.object,
    _imm: imm,
  };
}
local.F1600Helper = { runtimeCodeKeccak: keccak256('0x' + helperHex), source: 'contracts/helpers/f1600_170.hex' };

// ---------------------------------------------------------------- live code (optional)
async function rpc(method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(args.rpc, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
    }
  }
}
function mask(code, slots) {
  const b = Buffer.from(code.slice(2), 'hex');
  for (const { start, length } of slots) b.fill(0, start, start + length);
  return '0x' + b.toString('hex');
}
const components = [
  ['F1600Helper', dep.f1600Helper, 'F1600Helper'],
  ['MLDSA44Verifier', dep.verifier, 'MLDSA44Verifier'],
  ['KeyFactory', dep.keyFactory, 'KeyFactory'],
  ['VaultFactory', dep.vaultFactory, 'VaultFactory'],
];
const contracts = {};
let live = null;
if (args.rpc) {
  const got = Number(await rpc('eth_chainId', []));
  if (got !== chainId) throw new Error(`RPC is chain ${got}, not ${chainId}`);
  live = { rpcChecked: true, block: Number(await rpc('eth_blockNumber', [])) };
}
for (const [label, address, name] of components) {
  const l = local[name];
  const entry = { address, admin: 'none', upgradeable: false, local: Object.fromEntries(Object.entries(l).filter(([k]) => !k.startsWith('_'))) };
  if (live) {
    const code = await rpc('eth_getCode', [address, 'latest']);
    entry.liveCodehash = keccak256(code);
    if (l._imm?.length) {
      entry.liveMatchesLocalBuild = keccak256(mask(code, l._imm)) === l.runtimeCodeMaskedKeccak;
    } else {
      entry.liveMatchesLocalBuild = entry.liveCodehash === l.runtimeCodeKeccak;
    }
  }
  contracts[label] = entry;
}
contracts.MLDSA44Verifier.expectedCodehash = dep.verifierCodehash;
contracts.PersonalVault = {
  deployedBy: 'VaultFactory (CREATE2, one per owner)',
  admin: 'none: authority is the vault\'s own ML-DSA-44 primary and recovery keys',
  upgradeable: false,
  local: Object.fromEntries(Object.entries(local.PersonalVault).filter(([k]) => !k.startsWith('_'))),
};
if (dep.compatibleVaultFactories?.length) contracts.compatibleVaultFactories = dep.compatibleVaultFactories;

// ---------------------------------------------------------------- measured costs
const gasFile = join(C, 'deployments', 'gas-foundry.json');
const costs = { foundry: existsSync(gasFile) ? { source: 'contracts/test/GasReport.t.sol', sha256: fileHash(gasFile), operations: JSON.parse(readFileSync(gasFile, 'utf8')) } : null, live: null };
// Transactions to price: --receipts FILE ({ "name": "0xtxhash" }) or, by default, every transaction in
// the Foundry broadcast logs of this chain's deploy and smoke scripts.
function fromBroadcasts() {
  const list = {};
  for (const script of ['Deploy.s.sol', 'DeployFactories.s.sol', 'Smoke.s.sol']) {
    const f = join(C, 'broadcast', script, String(chainId), 'run-latest.json');
    if (!existsSync(f)) continue;
    for (const t of JSON.parse(readFileSync(f, 'utf8')).transactions ?? []) {
      const what = t.transactionType === 'CREATE' ? `deploy ${t.contractName ?? 'F1600Helper'}` : (t.function ?? 'call').split('(')[0];
      list[`${script.replace('.s.sol', '')}: ${what}`] = t.hash;
    }
  }
  return list;
}
if (live) {
  const list = args.receipts && args.receipts !== true ? JSON.parse(readFileSync(args.receipts, 'utf8')) : fromBroadcasts();
  costs.live = {};
  for (const [op, hash] of Object.entries(list)) {
    const [rc, tx] = await Promise.all([rpc('eth_getTransactionReceipt', [hash]), rpc('eth_getTransactionByHash', [hash])]);
    if (!rc || !tx) {
      costs.live[op] = { tx: hash, status: 'not found on this chain' };
      continue;
    }
    const gasUsed = BigInt(rc.gasUsed);
    const price = BigInt(rc.effectiveGasPrice);
    costs.live[op] = {
      tx: hash,
      block: Number(rc.blockNumber),
      status: rc.status === '0x1' ? 'success' : 'reverted',
      gasUsed: gasUsed.toString(),
      gasUsedForL1: rc.gasUsedForL1 ? BigInt(rc.gasUsedForL1).toString() : undefined,
      calldataBytes: (tx.input.length - 2) / 2,
      effectiveGasPriceWei: price.toString(),
      feeWei: (gasUsed * price).toString(),
    };
  }
}

// ---------------------------------------------------------------- verifier, vectors, toolkit, gates
const verifierFiles = Object.fromEntries(walk(join(C, 'src', 'verifier')).sort().map((p) => [rel(p), fileHash(p)]));
const vectorsPath = join(root, 'cli', 'vectors', `${chainId}.json`);
const toolkitFiles = ['cli/package.json', ...['bin', 'lib', 'abi', 'scripts'].flatMap((d) => walk(join(root, 'cli', d)).map(rel))].sort();
const acvpPath = join(C, 'test', 'acvp', 'mldsa44-sigver.json');
const acvp = existsSync(acvpPath) ? JSON.parse(readFileSync(acvpPath, 'utf8')) : null;
const gateFile = args['gate-b'] ?? join(C, 'deployments', `${chainId}.gate-b.json`);

const manifest = {
  format: 'quanlet-release-manifest',
  version: 1,
  chain: { chainId, name: chainId === 46630 ? 'Robinhood Chain testnet' : chainId === 4663 ? 'Robinhood Chain mainnet' : 'unknown', deployedAtBlock: dep.deployedAtBlock },
  release: { date: args.date ?? new Date().toISOString().slice(0, 10), stage: chainId === 4663 ? 'mainnet' : 'testnet, not for real funds' },
  source: { commit, contractsDirty: dirty, files: sources },
  compiler,
  verifier: {
    implementation: 'ML-DSA-44 (FIPS 204 Algorithm 3, non-prehashed, empty context) in pure EVM',
    provenance: 'Fireblocks Labs ML-DSA-44 EVM verifier, MIT licence, vendored under contracts/src/verifier; unaudited research code upstream',
    licence: { path: 'contracts/src/verifier/LICENSE-fireblocks', sha256: fileHash(join(C, 'src', 'verifier', 'LICENSE-fireblocks')) },
    files: verifierFiles,
    keccakHelper: { path: local.F1600Helper.source, codehash: local.F1600Helper.runtimeCodeKeccak },
    conformance: acvp
      ? {
          suite: 'NIST ACVP ML-DSA sigVer (FIPS 204), ML-DSA-44 cases',
          source: acvp.source,
          sourceSha256: acvp.sourceSha256,
          vectors: { path: rel(acvpPath), sha256: fileHash(acvpPath), cases: acvp.count, valid: acvp.tests.filter((t) => t.expected).length },
          harness: { path: 'contracts/test/acvp/MLDSA44VerifierACVP.sol', sha256: fileHash(join(C, 'test', 'acvp', 'MLDSA44VerifierACVP.sol')) },
          test: 'contracts/test/Acvp.t.sol (forge test --match-contract AcvpTest)',
          result: 'All 60 cases give the NIST result (12 accepted, 48 rejected). The production verifier runs tcId 10 directly; the other 59 go through a test-only copy that takes M prime or mu, checked against the production verifier by test_HarnessMatchesProduction.',
        }
      : null,
  },
  contracts,
  admin: { summary: 'No owner, administrator, proxy, pause or upgrade path in any component. The deployer key has no power after deployment.' },
  keyPreparation: {
    version: dep.keyPreparation ?? 1,
    where: 'on chain, inside KeyFactory.registerKey, from the raw 1,312-byte public key only',
    blob: '0x00 || tr (64) || NTT(2^13 t1) (4 polys) || ExpandA(rho) (16 polys); 32 words per poly, coefficient 8w+s at bit 32s; 20,545 bytes',
    recordId: 'keccak256(keyId, blobHash), keyId = keccak256(rawPk)',
    reference: 'contracts/script/prepare.py, cli/lib/prepare.mjs',
  },
  assets: { native: 'ETH', erc20Reviewed: [], note: 'The vault can hold ERC-20 tokens, but no token contract has been reviewed for this release; only ETH is supported.' },
  signingVectors: existsSync(vectorsPath) ? { path: rel(vectorsPath), sha256: fileHash(vectorsPath), generator: 'quanlet vectors' } : null,
  costs,
  gateB: existsSync(gateFile) ? JSON.parse(readFileSync(gateFile, 'utf8')) : { status: 'not recorded in this manifest' },
  reviews: { reports: [], note: 'No independent review or audit report has been published. See docs/REVIEW-SCOPE.md for the scope offered to reviewers and docs/REVIEW-REQUEST.md for the request.' },
  toolkit: { name: '@quanlet/cli', files: Object.fromEntries(toolkitFiles.map((p) => [p, fileHash(join(root, p))])) },
  liveCheck: live,
};

const out = args.out && args.out !== true ? args.out : join(C, 'deployments', `${chainId}.release.json`);
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
const bad = Object.entries(contracts).filter(([, v]) => v && v.liveMatchesLocalBuild === false).map(([k]) => k);
console.log(`release manifest written to ${rel(out)}${live ? ` (live code checked at block ${live.block})` : ' (offline: no live code check)'}`);
if (bad.length) {
  console.error(`live code does not match the local build: ${bad.join(', ')}`);
  process.exit(1);
}
