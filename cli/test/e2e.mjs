// End-to-end run of the toolkit against a local dev chain that allows time travel (Hardhat or Anvil),
// with the contracts deployed by contracts/script/Deploy.s.sol. Every vault action goes through the
// split flow: request -> sign (offline step, key file + password) -> assemble -> send.
//   QUANLET_MANIFEST=local.json QUANLET_RPC=http://127.0.0.1:8545 QUANLET_GAS_KEY=0x<dev key> node test/e2e.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quanlet.mjs');
const RPC = process.env.QUANLET_RPC;
const d = mkdtempSync(join(tmpdir(), 'quanlet-e2e-'));
const f = (n) => join(d, n);
const env = { ...process.env, QPW: 'local test password 1' };
const q = (...args) => {
  const r = spawnSync('node', [bin, ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`quanlet ${args.join(' ')}\n${r.stderr}${r.stdout}`);
  return r.stdout;
};
const rpc = async (method, params = [], retry = 2) => {
  const go = () => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const res = await go().catch((e) => (retry ? null : Promise.reject(e)));
  if (!res) return rpc(method, params, retry - 1);
  const r = await res.json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
};
const travel = async (s) => {
  await rpc('evm_increaseTime', [s]);
  await rpc('evm_mine');
};
const log = (m) => console.log(`- ${m}`);
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pw = ['--password-env', 'QPW'];

const names = ['primary', 'r0', 'r1', 'r2', 'np'];
for (const n of names) q('key', 'new', '--label', n, '--out', f(`${n}.key.json`), ...pw);
const rec = Object.fromEntries(names.map((n) => [n, J(f(`${n}.key.json`)).recordId]));
log('5 keys created and backed up');
for (const n of names) {
  q('key', 'test', f(`${n}.key.json`), ...pw);
  q('request', 'register', '--key', f(`${n}.key.json`), '--out', f(`${n}.reg.req`));
  q('sign', f(`${n}.reg.req`), '--key', f(`${n}.key.json`), ...pw, '--yes', '--out', f(`${n}.reg.sig`));
  q('assemble', f(`${n}.reg.req`), f(`${n}.reg.sig`), '--out', f(`${n}.reg.tx`));
  q('send', f(`${n}.reg.tx`));
}
log('5 keys registered (KeyFactory prepared each one on chain)');

q('request', 'create-vault', '--primary', rec.primary, '--recovery', `${rec.r0},${rec.r1},${rec.r2}`, '--out', f('cv.req'));
const vault = J(f('cv.req')).expectedVault;
q('sign', f('cv.req'), '--key', f('primary.key.json'), ...pw, '--yes', '--out', f('cv.sig'));
q('assemble', f('cv.req'), f('cv.sig'), '--out', f('cv.tx'));
q('send', f('cv.tx'));
log(`vault created at ${vault}`);

q('tx', 'deposit', '--vault', vault, '--amount', '2', '--out', f('dep.tx'));
q('send', f('dep.tx'));
const to = '0x000000000000000000000000000000000000bEEF';
const before = BigInt(await rpc('eth_getBalance', [to, 'latest']));
q('request', 'schedule', '--vault', vault, '--to', to, '--amount', '0.25', '--out', f('w.req'));
const wid = J(f('w.req')).digest;
q('sign', f('w.req'), '--key', f('primary.key.json'), ...pw, '--yes', '--out', f('w.sig'));
q('assemble', f('w.req'), f('w.sig'), '--out', f('w.tx'));
q('send', f('w.tx'));
q('tx', 'execute', '--vault', vault, '--id', wid, '--out', f('x.tx'));
const early = spawnSync('node', [bin, 'send', f('x.tx')], { encoding: 'utf8', env });
if (early.status === 0) throw new Error('executed before the 24-hour delay');
await travel(86_400);
q('send', f('x.tx'));
const gained = BigInt(await rpc('eth_getBalance', [to, 'latest'])) - before;
if (gained !== 250000000000000000n) throw new Error(`recipient gained ${gained}`);
log('withdrawal of 0.25 ETH refused before 24 h, executed after');

// A signature from a key that is not needed is refused by the signer itself.
q('request', 'recovery', '--vault', vault, '--new-primary', rec.np, '--signers', '0,2', '--out', f('rc.req'));
const wrong = spawnSync('node', [bin, 'sign', f('rc.req'), '--key', f('r1.key.json'), ...pw, '--yes'], { encoding: 'utf8', env });
if (wrong.status === 0) throw new Error('recovery key 1 signed a request that needs 0 and 2');
q('sign', f('rc.req'), '--key', f('r0.key.json'), ...pw, '--yes', '--out', f('rc0.sig'));
q('sign', f('rc.req'), '--key', f('r2.key.json'), ...pw, '--yes', '--out', f('rc2.sig'));
q('assemble', f('rc.req'), f('rc0.sig'), f('rc2.sig'), '--out', f('rc.tx'));
q('send', f('rc.tx'));
log('recovery started by recovery keys 0 and 2');
const frozen = spawnSync('node', [bin, 'request', 'invalidate', '--vault', vault], { encoding: 'utf8', env });
if (frozen.status === 0) throw new Error('primary could act while a change is pending');
await travel(7 * 86_400);
q('tx', 'finalize', '--vault', vault, '--out', f('fin.tx'));
q('send', f('fin.tx'));
const info = q('inspect', vault);
if (!info.includes(J(f('np.key.json')).keyId)) throw new Error(`new primary not installed:\n${info}`);
log('recovery finalized after 7 days; the new primary is installed');

q('request', 'schedule', '--vault', vault, '--to', to, '--amount', '0.1', '--out', f('w2.req'));
const old = spawnSync('node', [bin, 'sign', f('w2.req'), '--key', f('primary.key.json'), ...pw, '--yes'], { encoding: 'utf8', env });
if (old.status === 0) throw new Error('the replaced primary was accepted as a signer');
q('sign', f('w2.req'), '--key', f('np.key.json'), ...pw, '--yes', '--out', f('w2.sig'));
q('assemble', f('w2.req'), f('w2.sig'), '--out', f('w2.tx'));
q('send', f('w2.tx'));
log('the new primary schedules; the old one is refused');
console.log(info);
console.log('e2e passed');
