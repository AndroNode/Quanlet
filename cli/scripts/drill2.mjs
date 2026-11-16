// Live exit and backup-restoration drill for protocol 2.0 (whitepaper v2.0, Gate 3), run with the standalone
// toolkit only: no website, no Quanlet server. ETH only, small amounts, on Robinhood Chain testnet.
//
//   1. five keys are made on one "machine" (directory) and backed up;
//   2. the backups are copied to a second, fresh directory and restored there (open + test sign);
//   3. every signature from then on comes from the restored backups;
//   4. the keys are registered, a vault is set up, funded, pays FAST, and is emptied by a protected transfer.
//
//   QUANLET_GAS_KEY=0x... node scripts/drill2.mjs --amount 0.001 --out ../contracts/deployments/46630.v2.exit-drill.json
// The gas key only pays gas and receives the exit; it has no authority over the vault. It is never printed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'quanlet.mjs');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const RPC = process.env.QUANLET_RPC ?? 'https://rpc.testnet.chain.robinhood.com';
if (!process.env.QUANLET_GAS_KEY) throw new Error('set QUANLET_GAS_KEY');
const me = privateKeyToAccount(process.env.QUANLET_GAS_KEY).address;
const pc = createPublicClient({ transport: http(RPC, { timeout: 60_000 }) });
if ((await pc.getChainId()) !== 46630) throw new Error('this drill runs on Robinhood Chain testnet (46630) only');
const amount = arg('amount', '0.001');
if (parseEther(amount) > parseEther('0.002')) throw new Error('keep the drill small: at most 0.002 ETH');

const root = mkdtempSync(join(tmpdir(), 'quanlet-drill-'));
const machineA = join(root, 'machine-a');
const machineB = join(root, 'machine-b');
mkdirSync(machineA);
mkdirSync(machineB);
const env = { ...process.env, QUANLET_RPC: RPC, QPW: `drill ${randomBytes(12).toString('hex')}` };
const pw = ['--password-env', 'QPW'];
const q = (...args) => {
  const r = spawnSync('node', [bin, ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`quanlet ${args.join(' ')}\n${r.stderr}${r.stdout}`);
  return r.stdout;
};
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const record = { drill: 'protocol 2.0 exit and backup restoration, toolkit only', chainId: 46630, startedAt: new Date().toISOString(), payer: me, steps: [] };
const txs = [];
async function send(label, txFile) {
  const out = q('send', txFile);
  const hash = out.match(/sent (0x[0-9a-f]{64})/)[1];
  const r = await pc.getTransactionReceipt({ hash });
  const fee = r.gasUsed * r.effectiveGasPrice + (r.l1Fee ?? 0n);
  txs.push({ label, hash, block: Number(r.blockNumber), gasUsed: r.gasUsed.toString(), feeWei: fee.toString() });
  console.log(`- ${label}: ${hash} (gas ${r.gasUsed})`);
  return hash;
}
const step = (s) => {
  record.steps.push(s);
  console.log(`# ${s}`);
};

const roles = ['primary', 'approver', 'guardian-1', 'guardian-2', 'guardian-3'];
for (const n of roles) q('v2', 'key', 'new', '--label', n, '--out', join(machineA, `${n}.key.json`), ...pw);
step('five keys made and backed up on machine A');
for (const n of roles) {
  copyFileSync(join(machineA, `${n}.key.json`), join(machineB, `${n}.key.json`));
  q('v2', 'key', 'test', join(machineB, `${n}.key.json`), ...pw);
}
step('backups copied to machine B and restored there (each opened and test-signed); machine B signs from here on');
const kf = (n) => join(machineB, `${n}.key.json`);
const id = Object.fromEntries(roles.map((n) => [n, J(kf(n)).keyId]));
record.keyIds = id;

const f = (n) => join(root, n);
async function act(label, args, signers) {
  q('v2', 'request', ...args, '--out', f(`${label}.req`));
  for (const s of signers) q('v2', 'sign', f(`${label}.req`), '--key', kf(s), ...pw, '--yes', '--out', f(`${label}.${s}.sig`));
  q('v2', 'assemble', f(`${label}.req`), ...signers.map((s) => f(`${label}.${s}.sig`)), '--out', f(`${label}.tx`));
  await send(label, f(`${label}.tx`));
  return J(f(`${label}.req`));
}

for (const n of roles) await act(`register ${n}`, ['register', '--key', kf(n)], [n]);
step('five keys registered and activated in KeyFactoryV2, each proving possession');

const fastAllowance = (Number(amount) * 0.4).toFixed(6);
const fastCap = (Number(amount) * 0.2).toFixed(6);
const cv = await act('create vault', ['create-vault', '--p', id.primary, '--a', id.approver, '--g', `${id['guardian-1']},${id['guardian-2']},${id['guardian-3']}`, '--delay', 'none', '--fast-allowance', fastAllowance, '--fast-cap', fastCap, '--fast-to', me, '--fast-days', '7'], roles);
const vault = cv.expectedVault;
record.vault = vault;
step(`vault ${vault} created by all five keys: protected transfers execute at once, FAST up to ${fastCap} ETH per transfer and ${fastAllowance} ETH in total to the payer`);

q('v2', 'tx', 'deposit', '--vault', vault, '--amount', amount, '--out', f('deposit.tx'));
await send('deposit', f('deposit.tx'));
step(`${amount} ETH deposited`);

await act('FAST transfer', ['transfer', '--vault', vault, '--to', me, '--amount', fastCap, '--route', 'fast'], ['primary']);
step(`FAST: ${fastCap} ETH paid to the payer with the primary key alone`);

const left = await pc.getBalance({ address: vault });
await act('exit', ['transfer', '--vault', vault, '--to', me, '--amount', formatEther(left)], ['primary', 'approver']);
const after = await pc.getBalance({ address: vault });
if (after !== 0n) throw new Error(`the vault still holds ${formatEther(after)} ETH`);
step(`exit: the remaining ${formatEther(left)} ETH left the vault in one protected transfer signed by primary and approver; vault balance 0`);

record.inspect = q('v2', 'inspect', vault).trim().split('\n');
record.transactions = txs;
record.totalFeeWei = txs.reduce((s, t) => s + BigInt(t.feeWei), 0n).toString();
record.finishedAt = new Date().toISOString();
const outPath = arg('out');
if (outPath) writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
console.log(`drill passed; total fees ${formatEther(BigInt(record.totalFeeWei))} ETH`);
