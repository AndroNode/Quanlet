// Checks that the toolkit and the website read each other's protocol 2.0 files: key backups both ways, and a
// transfer signed here relays on the website. Runs only inside the monorepo (it bundles the website's own code).
//   node test/webcompat.mjs
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { encryptKey2, decryptKey2 } from '../lib/keyfile2.mjs';
import { manifest2 } from '../lib/protocol2.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', 'apps', 'web');
if (!existsSync(join(web, 'src', 'testnet', 'v2', 'keyfile.ts'))) {
  console.log('skipped: the website sources are not next to this toolkit');
  process.exit(0);
}
const req = createRequire(createRequire(join(web, 'package.json')).resolve('vite'));
const esbuild = req('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'quanlet-webcompat-'));
const entry = join(dir, 'entry.ts');
writeFileSync(
  entry,
  `export { encryptKeyV2, decryptKeyV2 } from ${JSON.stringify(join(web, 'src/testnet/v2/keyfile.ts'))};
   export { parseSigned, submitTx } from ${JSON.stringify(join(web, 'src/testnet/v2/chain.ts'))};`,
);
const bundle = join(dir, 'web.mjs');
await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
  define: { 'import.meta.env': '{}' }, nodePaths: [join(web, 'node_modules')],
});
const W = await import(pathToFileURL(bundle).href);

let failed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};
const PW = 'correct horse battery';
const seed = keccak256(toBytes('webcompat key'));
const m = manifest2(46630);

await t('a key backup made on the website opens in the toolkit', async () => {
  const f = await W.encryptKeyV2(seed, 'Web key', PW);
  const k = await decryptKey2(f, PW);
  if (k.seed !== seed) throw new Error('different seed');
});
await t('a key backup made by the toolkit opens on the website', async () => {
  const f = await encryptKey2({ seed, label: 'CLI key', password: PW, chainId: 46630, keyFactory: m.keyFactory });
  const s = await W.decryptKeyV2(JSON.parse(JSON.stringify(f)), PW);
  if (s !== seed) throw new Error('different seed');
});
await t('a transfer signed by the toolkit relays on the website with the same calldata', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const bin = join(here, '..', 'bin', 'quanlet.mjs');
  const key = join(dir, 'p.key.json');
  const f = await encryptKey2({ seed, label: 'p', password: PW, chainId: 46630, keyFactory: m.keyFactory });
  writeFileSync(key, JSON.stringify(f));
  const req = {
    format: 'quanlet-v2-request', version: 1, kind: 'action', action: 'transfer', chainId: 46630, vault: '0x' + '33'.repeat(20),
    roles: { p: f.keyId, a: '0x' + '0a'.repeat(32), g1: '0x' + '01'.repeat(32), g2: '0x' + '02'.repeat(32), g3: '0x' + '03'.repeat(32) },
    params: { route: 'fast', asset: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, recipient: '0x000000000000000000000000000000000000bEEF', amount: '1000', feeRecipient: '0x0000000000000000000000000000000000007E1A', feeWei: '5' },
    validAfter: 1800000000, validUntil: 1800001800, counters: { lane: 1, nonce: '0', authorityEpoch: '1', policyEpoch: '1', executionEpoch: '1' },
  };
  writeFileSync(join(dir, 'tr.req'), JSON.stringify(req));
  const run = (args) => {
    const r = spawnSync('node', [bin, 'v2', ...args], { encoding: 'utf8', env: { ...process.env, QPW: PW } });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  run(['sign', join(dir, 'tr.req'), '--key', key, '--password-env', 'QPW', '--yes', '--out', join(dir, 'tr.sig')]);
  run(['assemble', join(dir, 'tr.req'), join(dir, 'tr.sig'), '--out', join(dir, 'tr.tx'), '--signed-transfer', join(dir, 'tr.signed')]);
  const s = W.parseSigned(JSON.parse(readFileSync(join(dir, 'tr.signed'), 'utf8')));
  if (W.submitTx(s).data !== JSON.parse(readFileSync(join(dir, 'tr.tx'), 'utf8')).data) throw new Error('different calldata');
});
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
