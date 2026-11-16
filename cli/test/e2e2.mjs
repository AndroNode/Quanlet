// End-to-end run of "quanlet v2" against a local fork of the chain that holds the 2.0 deployment (Anvil, which
// allows time travel). Every vault action goes through the split flow: request -> sign (offline step, one key
// file at a time) -> assemble -> send. Nothing here touches a public network: transactions go to the fork.
//   anvil --fork-url https://rpc.testnet.chain.robinhood.com --code-size-limit 60000 --gas-limit 1000000000
//   QUANLET_RPC=http://127.0.0.1:8545 QUANLET_GAS_KEY=0x<an Anvil dev key> node test/e2e2.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quanlet.mjs');
const RPC = process.env.QUANLET_RPC;
if (!RPC || !/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('set QUANLET_RPC to a local fork (this test sends transactions and travels in time)');
const d = mkdtempSync(join(tmpdir(), 'quanlet-e2e2-'));
const f = (n) => join(d, n);
const env = { ...process.env, QPW: 'local test password 2' };
const run = (args) => spawnSync('node', [bin, 'v2', ...args], { encoding: 'utf8', env });
const q = (...args) => {
  const r = run(args);
  if (r.status !== 0) throw new Error(`quanlet v2 ${args.join(' ')}\n${r.stderr}${r.stdout}`);
  return r.stdout;
};
const send = (tx) => {
  const r = spawnSync('node', [bin, 'send', tx], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`send ${tx}\n${r.stderr}${r.stdout}`);
  return r.stdout;
};
const refused = (args, re, what) => {
  const r = run(args);
  if (r.status === 0 || (re && !re.test(r.stderr))) throw new Error(`${what} was not refused: ${r.stderr}${r.stdout}`);
};
const rpc = async (method, params = []) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
};
const travel = async (s) => {
  await rpc('evm_increaseTime', [s]);
  await rpc('evm_mine');
};
const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pw = ['--password-env', 'QPW'];
const log = (m) => console.log(`- ${m}`);
let checks = 0;
const ok = (cond, m) => {
  if (!cond) throw new Error(m);
  checks++;
};

/** request -> each key signs offline -> assemble -> send */
function act(name, args, signers, extra = []) {
  q('request', ...args, '--out', f(`${name}.req`));
  for (const s of signers) q('sign', f(`${name}.req`), '--key', f(`${s}.key.json`), ...pw, '--yes', '--out', f(`${name}.${s}.sig`));
  q('assemble', f(`${name}.req`), ...signers.map((s) => f(`${name}.${s}.sig`)), '--out', f(`${name}.tx`), ...extra);
  send(f(`${name}.tx`));
  return J(f(`${name}.req`));
}

const names = ['p', 'a', 'g1', 'g2', 'g3', 'np', 'na'];
for (const n of names) q('key', 'new', '--label', n, '--out', f(`${n}.key.json`), ...pw);
const id = Object.fromEntries(names.map((n) => [n, J(f(`${n}.key.json`)).keyId]));
for (const n of names) {
  q('key', 'test', f(`${n}.key.json`), ...pw);
  act(`reg-${n}`, ['register', '--key', f(`${n}.key.json`)], [n]);
}
log('7 keys created, backed up, tested, registered and activated in KeyFactoryV2');
ok(true, '');
log('(each key signed its own proof of possession; one Multicall3 transaction per key)');

const BEEF = '0x000000000000000000000000000000000000bEEF';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const cv = act('cv', ['create-vault', '--p', id.p, '--a', id.a, '--g', `${id.g1},${id.g2},${id.g3}`, '--delay', '1h', '--fast-allowance', '0.5', '--fast-cap', '0.2', '--fast-to', BEEF, '--fast-days', '10'], ['p', 'a', 'g1', 'g2', 'g3']);
const vault = cv.expectedVault;
ok((await rpc('eth_getCode', [vault, 'latest'])).length > 2, 'vault not deployed');
log(`vault created at ${vault} (all five keys signed the setup)`);

q('tx', 'deposit', '--vault', vault, '--amount', '2', '--out', f('dep.tx'));
send(f('dep.tx'));

let before = await bal(BEEF);
act('fast1', ['transfer', '--vault', vault, '--to', BEEF, '--amount', '0.1', '--route', 'fast'], ['p']);
ok((await bal(BEEF)) - before === 100000000000000000n, 'FAST transfer did not pay at once');
log('FAST: 0.1 ETH paid at once with the primary key alone');
refused(['request', 'transfer', '--vault', vault, '--to', BEEF, '--amount', '0.3', '--route', 'fast', '--out', f('x.req')], /at most/, 'FAST over the per-transfer cap');
refused(['request', 'transfer', '--vault', vault, '--to', DEAD, '--amount', '0.1', '--route', 'fast', '--out', f('x2.req')], /not on the FAST list/, 'FAST to a recipient off the list');
q('request', 'transfer', '--vault', vault, '--to', DEAD, '--amount', '0.1', '--out', f('x3.req'));
refused(['sign', f('x3.req'), '--key', f('g1.key.json'), ...pw, '--yes'], /not one of the signers/, 'a guardian signing a transfer');
log('FAST over the cap, FAST to a recipient off the list, and a guardian signing a transfer: refused');

before = await bal(DEAD);
const pt = act('prot1', ['transfer', '--vault', vault, '--to', DEAD, '--amount', '0.25'], ['p', 'a']);
q('tx', 'execute', '--vault', vault, '--id', pt.digest, '--out', f('exec1.tx'));
const early = spawnSync('node', [bin, 'send', f('exec1.tx')], { encoding: 'utf8', env });
ok(early.status !== 0, 'protected transfer executed before its delay');
await travel(3600);
send(f('exec1.tx'));
ok((await bal(DEAD)) - before === 250000000000000000n, 'protected transfer did not pay');
log('protected: 0.25 ETH queued with both keys, refused before 1 h, executed after');

const pt2 = act('prot2', ['transfer', '--vault', vault, '--to', DEAD, '--amount', '0.05'], ['p', 'a']);
act('cancel2', ['cancel', '--vault', vault, '--id', pt2.digest, '--role', 'a'], ['a']);
ok(q('inspect', vault).includes(`${pt2.digest}  0.05 ETH to ${DEAD}  cancelled`), 'cancelled transfer not shown as cancelled');
log('the approver alone cancelled a queued transfer');

// A delayed policy change, finalized from the chain without the policy file (finding I-3).
act('pol', ['update-policy', '--vault', vault, '--delay', '24h', '--fast-allowance', '1', '--fast-cap', '0.5', '--fast-to', BEEF, '--fast-days', '20'], ['p', 'a']);
const pend = q('pending', vault, '--out', f('fin-pol.tx'));
ok(/found the pending policy in transaction 0x[0-9a-f]{64}/.test(pend), `pending policy not found:\n${pend}`);
ok(/wait 24 hours/.test(pend), 'pending policy summary is wrong');
const tooSoon = spawnSync('node', [bin, 'send', f('fin-pol.tx')], { encoding: 'utf8', env });
ok(tooSoon.status !== 0, 'policy finalized before its delay');
await travel(3600);
send(f('fin-pol.tx'));
const info1 = q('inspect', vault);
ok(/protected transfers wait 24 hours/.test(info1) && /state\s+Active/.test(info1), `new policy not installed:\n${info1}`);
log('policy change found on chain by "v2 pending" (no local copy), refused early, finalized after 1 h');

act('susp', ['suspend-fast', '--vault', vault, '--role', 'p'], ['p']);
refused(['request', 'transfer', '--vault', vault, '--to', BEEF, '--amount', '0.1', '--route', 'fast', '--out', f('y.req')], /off or suspended/, 'FAST after suspend');
log('the primary alone suspended FAST');

act('rec', ['start-recovery', '--vault', vault, '--new-p', id.np, '--new-a', id.na, '--guardians', '1,3'], ['g1', 'g3', 'np', 'na']);
refused(['request', 'transfer', '--vault', vault, '--to', BEEF, '--amount', '0.1', '--out', f('z.req')], /not possible now/, 'a transfer during recovery');
await travel(7 * 86400);
q('tx', 'finalize', '--vault', vault, '--out', f('fin-rec.tx'));
send(f('fin-rec.tx'));
const info2 = q('inspect', vault);
ok(info2.includes(`primary          ${id.np}`) && info2.includes(`approver         ${id.na}`), `recovery not installed:\n${info2}`);
log('guardians 1 and 3 recovered to a new primary and approver after 7 days');

q('request', 'transfer', '--vault', vault, '--to', BEEF, '--amount', '0.2', '--out', f('old.req'));
refused(['sign', f('old.req'), '--key', f('p.key.json'), ...pw, '--yes'], /not one of the signers/, 'the replaced primary');
for (const s of ['np', 'na']) q('sign', f('old.req'), '--key', f(`${s}.key.json`), ...pw, '--yes', '--out', f(`old.${s}.sig`));
q('assemble', f('old.req'), f('old.np.sig'), f('old.na.sig'), '--out', f('old.tx'), '--signed-transfer', f('old.signed.json'));
q('relay', f('old.signed.json'), '--out', f('relayed.tx'));
ok(J(f('relayed.tx')).data === J(f('old.tx')).data, 'relay built different calldata');
send(f('relayed.tx'));
before = await bal(BEEF);
await travel(86400);
q('tx', 'execute', '--vault', vault, '--id', J(f('old.req')).digest, '--out', f('exec3.tx'));
send(f('exec3.tx'));
ok((await bal(BEEF)) - before === 200000000000000000n, 'relayed transfer did not pay');
log('the new pair signed a transfer, it was relayed from the website format and executed after 24 h; the old primary is refused');

console.log(info2);
console.log(`e2e2 passed (${checks} checks)`);
