// Read-only check before the website switches to mainnet: the deployment manifest, the contracts live on chain,
// the local build and the site's config must all agree. Sends no transaction and needs no key.
//
//   node scripts/mainnet-preflight.mjs
//   node scripts/mainnet-preflight.mjs --manifest <file> --config <file> --rpc <url>   # e.g. a fork rehearsal
//
// Exits 1 if any check fails. Build the contracts first (forge build in contracts/) so the local vault
// creation code is the one being released.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http, keccak256, concat, getAddress, parseAbi, size, slice } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const manifestPath = resolve(arg('manifest', join(root, 'contracts', 'deployments', '4663.v2.json')));
const configPath = resolve(arg('config', join(root, 'packages', 'config', 'src', 'index.ts')));
const RPC = arg('rpc', process.env.QUANLET_RPC ?? 'https://rpc.mainnet.chain.robinhood.com');
const ETH = '0x0000000000000000000000000000000000000000';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MAX_CODE = 98_304;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));

if (!existsSync(manifestPath)) {
  console.error(`No deployment manifest at ${manifestPath}. Deploy first (docs/MAINNET-RUNBOOK.md).`);
  process.exit(1);
}
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pc = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
/** A view call, or null when the address has no such contract. */
const read = (address, fn, args = []) =>
  pc.readContract({ address, abi: parseAbi([fn]), functionName: fn.match(/function (\w+)/)[1], args }).catch(() => null);
const code = async (a) => (await pc.getCode({ address: a })) ?? '0x';

// Chain and manifest
const chainId = await pc.getChainId();
check('RPC is Robinhood Chain mainnet (4663)', chainId === 4663, `chain ${chainId}`);
check('Manifest is protocol 2.0 on chain 4663', m.chainId === 4663 && m.protocolVersion === 2, `chain ${m.chainId}, protocol ${m.protocolVersion}`);
check('Manifest supports ETH only', sameList(m.supportedAssets, [ETH]), JSON.stringify(m.supportedAssets));

// Live code matches the manifest
const [helperCode, verifierCode, keysCode, factoryCode, mcCode] = await Promise.all([m.f1600Helper, m.verifier, m.keyFactoryV2, m.vaultFactoryV2, MULTICALL3].map(code));
const f1600 = await read(m.keyFactoryV2, 'function F1600_CODEHASH() view returns (bytes32)');
check('F1600 helper has the expected code', size(helperCode) > 0 && same(keccak256(helperCode), f1600), m.f1600Helper);
check('Verifier code hash matches the manifest', size(verifierCode) > 0 && same(keccak256(verifierCode), m.verifierCodehash), m.verifier);
check('KeyFactoryV2 code hash matches the manifest', size(keysCode) > 0 && same(keccak256(keysCode), m.keyFactoryV2Codehash), m.keyFactoryV2);
check('VaultFactoryV2 is deployed', size(factoryCode) > 0, m.vaultFactoryV2);
check('Multicall3 is deployed', size(mcCode) > 0, MULTICALL3);

// Wiring between the contracts
const [kfVerifier, kfVerifierHash, kfHelper] = await Promise.all([
  read(m.keyFactoryV2, 'function verifier() view returns (address)'),
  read(m.keyFactoryV2, 'function verifierCodehash() view returns (bytes32)'),
  read(m.keyFactoryV2, 'function f1600Helper() view returns (address)'),
]);
check('KeyFactoryV2 uses the manifest verifier and helper', same(kfVerifier, m.verifier) && same(kfHelper, m.f1600Helper));
check('KeyFactoryV2 pins the verifier code hash', same(kfVerifierHash, keccak256(verifierCode)));
const [vfKeys, vfHash, vfDeps, vfAssets, vfStores] = await Promise.all([
  read(m.vaultFactoryV2, 'function keyFactory() view returns (address)'),
  read(m.vaultFactoryV2, 'function vaultCreationCodeHash() view returns (bytes32)'),
  read(m.vaultFactoryV2, 'function dependencyManifestHash() view returns (bytes32)'),
  read(m.vaultFactoryV2, 'function supportedAssets() view returns (address[])'),
  read(m.vaultFactoryV2, 'function codeStores() view returns (address[])'),
]);
check('VaultFactoryV2 uses the manifest KeyFactoryV2', same(vfKeys, m.keyFactoryV2));
check('VaultFactoryV2 supports ETH only', sameList(vfAssets, [ETH]), JSON.stringify(vfAssets));
check('VaultFactoryV2 code stores match the manifest', sameList(vfStores, m.vaultCodeStores));
check('Dependency manifest hash matches', same(vfDeps, m.dependencyManifestHash), vfDeps);
check('Vault creation code hash matches the manifest', same(vfHash, m.vaultCreationCodeHash), vfHash);
const stored = await Promise.all((vfStores ?? []).map(code));
const joined = stored.length ? concat(stored.map((c) => (size(c) > 1 ? slice(c, 1) : '0x'))) : '0x';
check('Code stores hold exactly that vault code', stored.length > 0 && same(keccak256(joined), vfHash), `${size(joined)} bytes`);

// Local build
const artifact = join(root, 'contracts', 'out', 'PersonalVaultV2.sol', 'PersonalVaultV2.json');
if (existsSync(artifact)) {
  const a = JSON.parse(readFileSync(artifact, 'utf8'));
  check('Local build produces the deployed vault code', same(keccak256(a.bytecode.object), vfHash));
  check(`Vault runtime fits the ${MAX_CODE.toLocaleString('en')}-byte limit`, size(a.deployedBytecode.object) <= MAX_CODE, `${size(a.deployedBytecode.object)} bytes`);
} else {
  check('Local build produces the deployed vault code', false, 'run forge build in contracts/ first');
}

// The site's config
const { DEFAULT_CONFIG, ConfigSchema } = await import(pathToFileURL(configPath).href);
const c = DEFAULT_CONFIG.deployments.mainnetV2;
const parsed = ConfigSchema.safeParse(DEFAULT_CONFIG);
check('Config passes its own schema', parsed.success, parsed.success ? '' : parsed.error.issues.map((i) => i.path.join('.')).join(', '));
check('Config has mainnetV2', !!c, c ? '' : 'run scripts/mainnet-config.mjs');
if (c) {
  check(
    'Config addresses match the manifest',
    same(c.keyFactory, m.keyFactoryV2) && same(c.vaultFactory, m.vaultFactoryV2) && same(c.verifier, m.verifier) && same(c.f1600Helper, m.f1600Helper) && sameList(c.vaultCodeStores, m.vaultCodeStores),
  );
  check('Config multicall is Multicall3', same(c.multicall, MULTICALL3));
  check('Config lists no tokens and no other factories', c.tokens.length === 0 && c.compatibleVaultFactories.length === 0);
  check('Config deployment block matches', c.deployedAtBlock === m.deployedAtBlock, String(c.deployedAtBlock));
  check('Config network is chain 4663', DEFAULT_CONFIG.networks.mainnet.chainId === 4663);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed. Vault factory ${getAddress(m.vaultFactoryV2)}.`);
process.exit(failed.length ? 1 : 0);
