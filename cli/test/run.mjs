// Offline tests for the toolkit: key file round trip and tamper checks, preparation against prepare.py,
// deterministic vectors, and the signer refusing requests whose fields do not match their digest.
//   node test/run.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { bytesToHex, keccak256 } from 'viem';
import { prepareBlob } from '../lib/prepare.mjs';
import { keyFromSeed, recordOf } from '../lib/protocol.mjs';
import { encryptKey, decryptKey } from '../lib/keyfile.mjs';
import { buildVectors } from '../lib/vectors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'quanlet.mjs');
const prepPy = join(here, '..', '..', 'contracts', 'script', 'prepare.py');
const dir = mkdtempSync(join(tmpdir(), 'quanlet-cli-'));
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${a} != ${b}`);
};
const throwsLike = async (fn, re) => {
  try {
    await fn();
  } catch (e) {
    if (re.test(e.message)) return;
    throw new Error(`wrong error: ${e.message}`);
  }
  throw new Error('did not throw');
};
const cli = (args, env = {}) => spawnSync('node', [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

await t('preparation matches prepare.py on 5 random keys', () => {
  for (let i = 0; i < 5; i++) {
    const k = keyFromSeed(bytesToHex(randomBytes(32)));
    const py = execFileSync('python3', [prepPy, bytesToHex(k.publicKey)], { encoding: 'utf8' }).trim();
    eq(bytesToHex(prepareBlob(k.publicKey)).slice(2), py, 'blob');
  }
});

const seed = bytesToHex(randomBytes(32));
const PW = 'correct horse battery';
const kf = await encryptKey({ seed, label: 'Test key', password: PW, chainId: 46630, vaultFactory: '0x' + '11'.repeat(20) });

await t('key file opens with the right password and matches its header', async () => {
  const k = await decryptKey(kf, PW);
  eq(k.seed, seed, 'seed');
  eq(recordOf(k.publicKey).recordId, kf.recordId, 'record id');
});
await t('wrong password is refused', () => throwsLike(() => decryptKey(kf, PW + '!'), /Wrong password/));
await t('changed header is refused', () => throwsLike(() => decryptKey({ ...kf, label: 'Other' }, PW), /Wrong password|changed/));
await t('oversized KDF is refused before any work', () => throwsLike(() => decryptKey({ ...kf, kdf: { ...kf.kdf, memKiB: 4_000_000 } }, PW), /outside the allowed range/));
await t('short password is refused', () => throwsLike(() => encryptKey({ seed, label: 'x', password: 'short', chainId: 46630, vaultFactory: kf.vaultFactory }), /at least 12/));

await t('vectors are deterministic and self-verifying', () => {
  const a = buildVectors(46630);
  const b = buildVectors(46630);
  eq(JSON.stringify(a), JSON.stringify(b), 'vectors differ between runs');
  eq(a.actions.length, 7, 'action count');
});

await t('offline signer recomputes the digest and refuses a tampered request', () => {
  const keyPath = join(dir, 'k.key.json');
  writeFileSync(keyPath, JSON.stringify(kf));
  const vault = '0x' + '22'.repeat(20);
  const req = {
    format: 'quanlet-request', version: 1, kind: 'action', action: 'schedule', chainId: 46630, vault,
    counters: { executionEpoch: '0', authorityEpoch: '0', nonceKind: 'primary', nonce: '0' },
    params: { asset: '0x0000000000000000000000000000000000000000', decimals: 18, recipient: '0x000000000000000000000000000000000000bEEF', amount: '1000', feeRecipient: '0x0000000000000000000000000000000000000000', feeWei: '0' },
    validAfter: 1800000000, validUntil: 1800001800,
    expectedSigners: { primary: kf.keyId, recovery: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), '0x' + '03'.repeat(32)] },
    needs: ['primary'],
  };
  const reqPath = join(dir, 'req.json');
  writeFileSync(reqPath, JSON.stringify(req));
  const ok = cli(['sign', reqPath, '--key', keyPath, '--password-env', 'QPW', '--yes', '--out', join(dir, 'sig.json')], { QPW: PW });
  eq(ok.status, 0, `sign failed: ${ok.stderr}`);
  if (!/send\s+0\.000000000000001 ETH/.test(ok.stderr) || !/0x000000000000000000000000000000000000bEEF/.test(ok.stderr)) throw new Error('summary does not show amount and recipient');
  const sig = JSON.parse(readFileSync(join(dir, 'sig.json'), 'utf8'));
  // A request whose written digest belongs to other fields (say, another recipient) is refused.
  writeFileSync(reqPath, JSON.stringify({ ...req, digest: sig.digest, params: { ...req.params, recipient: '0x000000000000000000000000000000000000dEaD' } }));
  const bad = cli(['sign', reqPath, '--key', keyPath, '--password-env', 'QPW', '--yes'], { QPW: PW });
  if (bad.status === 0 || !/does not match its fields/.test(bad.stderr)) throw new Error(`tampered request was signed: ${bad.stderr}`);
  // A key that is not a needed signer is refused.
  writeFileSync(reqPath, JSON.stringify({ ...req, expectedSigners: { ...req.expectedSigners, primary: '0x' + '09'.repeat(32) } }));
  const wrong = cli(['sign', reqPath, '--key', keyPath, '--password-env', 'QPW', '--yes'], { QPW: PW });
  if (wrong.status === 0 || !/not one of the signers/.test(wrong.stderr)) throw new Error('signed with a key that is not needed');
  // assemble checks the signature against the request
  writeFileSync(reqPath, JSON.stringify(req));
  const asm = cli(['assemble', reqPath, join(dir, 'sig.json')]);
  eq(asm.status, 0, `assemble failed: ${asm.stderr}`);
  const tx = JSON.parse(asm.stdout);
  eq(tx.to.toLowerCase(), vault, 'tx target');
  if (!tx.data.startsWith('0x')) throw new Error('no calldata');
  writeFileSync(reqPath, JSON.stringify({ ...req, params: { ...req.params, amount: '1001' } }));
  const asm2 = cli(['assemble', reqPath, join(dir, 'sig.json')]);
  if (asm2.status === 0) throw new Error('assembled a signature over different fields');
});

await t('acceptance window longer than 1800 s is refused', () => {
  const reqPath = join(dir, 'req2.json');
  const r = JSON.parse(readFileSync(join(dir, 'req.json'), 'utf8'));
  writeFileSync(reqPath, JSON.stringify({ ...r, params: { ...r.params, amount: '1000' }, validUntil: r.validAfter + 1801 }));
  const res = cli(['assemble', reqPath, join(dir, 'sig.json')]);
  if (res.status === 0 || !/acceptance window/.test(res.stderr)) throw new Error('long window accepted');
});

// ------------------------------------------------------------------ protocol 2.0

const { encryptKey2, decryptKey2 } = await import('../lib/keyfile2.mjs');
const P2 = await import('../lib/protocol2.mjs');
const m2 = P2.manifest2(46630);
const v2seed = (n) => keccak256(new TextEncoder().encode(`cli test key ${n}`));
const v2files = {};
for (const n of ['p', 'a', 'g1', 'g2', 'g3', 'np', 'na']) {
  v2files[n] = join(dir, `v2-${n}.key.json`);
  const f = await encryptKey2({ seed: v2seed(n), label: n, password: PW, chainId: 46630, keyFactory: m2.keyFactory });
  writeFileSync(v2files[n], JSON.stringify(f));
}
const idOf = (n) => JSON.parse(readFileSync(v2files[n], 'utf8')).keyId;

await t('2.0 key file round trip, and 1.x files are told apart', async () => {
  const f = JSON.parse(readFileSync(v2files.p, 'utf8'));
  const k = await decryptKey2(f, PW);
  eq(P2.keyIdOf2(k.publicKey), f.keyId.toLowerCase(), 'key id');
  await throwsLike(() => decryptKey2({ ...f, label: 'other' }, PW), /Wrong password|changed/);
  await throwsLike(() => decryptKey2(kf, PW), /protocol 1\.x/);
  const show = cli(['v2', 'key', 'show', v2files.p]);
  eq(show.status, 0, show.stderr);
  if (!show.stdout.includes(f.keyId)) throw new Error('key show does not print the key id');
  const old = cli(['v2', 'key', 'show', join(dir, 'k.key.json')]);
  if (old.status === 0 || !/protocol 1\.x/.test(old.stderr)) throw new Error('a 1.x key file was shown as 2.0');
});

const vault2 = '0x' + '33'.repeat(20);
const roles2 = { p: idOf('p'), a: idOf('a'), g1: idOf('g1'), g2: idOf('g2'), g3: idOf('g3') };
const baseReq = (action, params, lane) => ({
  format: 'quanlet-v2-request', version: 1, kind: 'action', action, chainId: 46630, vault: vault2, roles: roles2, params,
  validAfter: 1800000000, validUntil: 1800001800,
  counters: { lane, nonce: '3', authorityEpoch: '1', policyEpoch: '2', executionEpoch: '5' },
});
const sign2 = (req, who, out) => {
  const p = join(dir, `${out}.req.json`);
  writeFileSync(p, JSON.stringify(req));
  return cli(['v2', 'sign', p, '--key', v2files[who], '--password-env', 'QPW', '--yes', '--out', join(dir, `${out}.${who}.sig`)], { QPW: PW });
};

await t('2.0 protected transfer: both keys sign, tampering and stray signers are refused, assemble checks all', () => {
  const req = baseReq('transfer', { route: 'protected', asset: P2.ZERO, symbol: 'ETH', decimals: 18, recipient: '0x000000000000000000000000000000000000bEEF', amount: '250000000000000000', feeRecipient: P2.ZERO, feeWei: '0' }, 1);
  const s1 = sign2(req, 'p', 'tr');
  eq(s1.status, 0, s1.stderr);
  if (!/send\s+0\.25 ETH/.test(s1.stderr) || !/protected/.test(s1.stderr)) throw new Error('summary does not show the amount and route');
  const s2 = sign2(req, 'a', 'tr');
  eq(s2.status, 0, s2.stderr);
  const g = sign2(req, 'g1', 'tr');
  if (g.status === 0 || !/not one of the signers/.test(g.stderr)) throw new Error('a guardian signed a transfer');
  const bad = sign2({ ...req, digest: P2.requestDigest(req), params: { ...req.params, recipient: '0x000000000000000000000000000000000000dEaD' } }, 'p', 'tr-bad');
  if (bad.status === 0 || !/does not match its fields/.test(bad.stderr)) throw new Error('signed a request whose digest belongs to other fields');
  const reqPath = join(dir, 'tr.req.json');
  const only = cli(['v2', 'assemble', reqPath, join(dir, 'tr.p.sig')]);
  if (only.status === 0 || !/missing signatures: a/.test(only.stderr)) throw new Error('assembled without the approver');
  const asm = cli(['v2', 'assemble', reqPath, join(dir, 'tr.p.sig'), join(dir, 'tr.a.sig'), '--signed-transfer', join(dir, 'tr.signed.json')]);
  eq(asm.status, 0, asm.stderr);
  const lines = asm.stdout.split('\n');
  const tx = JSON.parse(lines.slice(lines.findIndex((l) => l.startsWith('{'))).join('\n'));
  eq(tx.to.toLowerCase(), vault2, 'tx target');
  const signed = JSON.parse(readFileSync(join(dir, 'tr.signed.json'), 'utf8'));
  eq(signed.format, 'quanlet-v2-signed-transfer', 'relay format');
  eq(signed.id, P2.requestDigest(req), 'transfer id');
  const rel = cli(['v2', 'relay', join(dir, 'tr.signed.json')]);
  eq(rel.status, 0, rel.stderr);
  if (!rel.stdout.includes(tx.data)) throw new Error('relay built different calldata than assemble');
  writeFileSync(reqPath, JSON.stringify({ ...req, params: { ...req.params, amount: '250000000000000001' } }));
  const asm2 = cli(['v2', 'assemble', reqPath, join(dir, 'tr.p.sig'), join(dir, 'tr.a.sig')]);
  if (asm2.status === 0) throw new Error('assembled signatures over different fields');
});

await t('2.0 recovery: two guardians sign the action, the new keys sign their consent', () => {
  const req = baseReq('start-recovery', { newP: idOf('np'), newA: idOf('na'), guardians: [0, 2] }, 5);
  for (const who of ['g1', 'g3', 'np', 'na']) eq(sign2(req, who, 'rc').status, 0, `${who} could not sign`);
  const g2 = sign2(req, 'g2', 'rc');
  if (g2.status === 0) throw new Error('guardian 2 signed a request that needs guardians 1 and 3');
  const sig = JSON.parse(readFileSync(join(dir, 'rc.np.sig'), 'utf8'));
  eq(sig.sigs[0].over, 'consent', 'new key signs consent');
  const asm = cli(['v2', 'assemble', join(dir, 'rc.req.json'), ...['g1', 'g3', 'np', 'na'].map((w) => join(dir, `rc.${w}.sig`))]);
  eq(asm.status, 0, asm.stderr);
  // the recovery lane ignores the policy and execution epochs
  eq(P2.requestDigest(req), P2.requestDigest({ ...req, counters: { ...req.counters, policyEpoch: '9', executionEpoch: '9' } }), 'recovery digest binds only the authority epoch');
});

await t('2.0 setup requests that point at another deployment are refused', () => {
  const policy = { protectedDelay: '3600', fastEnabled: false, resumeFast: false, maxFastFeeWei: '0', fastFeeRecipients: [], assetRules: [] };
  const ids = ['p', 'a', 'g1', 'g2', 'g3'].map(idOf);
  const setup = { chainId: 46630, vaultFactory: m2.vaultFactory, keyFactory: m2.keyFactory, roleIds: ids, salt: '0x' + '44'.repeat(32), supportedAssets: m2.supportedAssets, dependencyManifestHash: m2.dependencyManifestHash, vaultCreationCodeHash: m2.vaultCreationCodeHash };
  const expectedVault = P2.predictVault2({ ...setup, policy: P2.policyFrom(policy) });
  const req = { format: 'quanlet-v2-request', version: 1, kind: 'create-vault', ...setup, policy, expectedVault, validAfter: 1800000000, validUntil: 1800001800 };
  eq(sign2(req, 'g2', 'cv').status, 0, 'a role could not sign the setup');
  const other = sign2({ ...req, vaultFactory: '0x' + '55'.repeat(20) }, 'g2', 'cv-bad');
  if (other.status === 0 || !/not the bundled deployment/.test(other.stderr)) throw new Error('signed a setup for another factory');
  const moved = sign2({ ...req, expectedVault: '0x' + '66'.repeat(20) }, 'g2', 'cv-bad2');
  if (moved.status === 0 || !/vault address/.test(moved.stderr)) throw new Error('signed a setup naming another vault address');
});

await t('pending policy search finds the exact second', async () => {
  const times = Array.from({ length: 5000 }, (_, i) => 1_000_000 + Math.floor(i / 3) * 2); // three blocks per timestamp, gaps
  const at = async (n) => times[n];
  const r = await P2.blocksAtTime(1_000_000 + 1000, 0, times.length - 1, at);
  eq(r.from, 1500, 'first block');
  eq(r.to, 1502, 'last block');
  eq(await P2.blocksAtTime(1_000_001, 0, times.length - 1, at), null, 'no block at an odd second');
});

await t('2.0 vectors are deterministic, self-verifying and match the published file', async () => {
  const { buildVectors2 } = await import('../lib/vectors2.mjs');
  const a = JSON.stringify(buildVectors2(46630));
  eq(a, JSON.stringify(buildVectors2(46630)), 'vectors differ between runs');
  eq(a, JSON.stringify(JSON.parse(readFileSync(join(here, '..', 'vectors', '46630.v2.json'), 'utf8'))), 'cli/vectors/46630.v2.json is stale: run "quanlet v2 vectors --out vectors/46630.v2.json --force"');
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
