#!/usr/bin/env node
// Quanlet standalone toolkit (whitepaper section 10). Works without any Quanlet server: keys and backups,
// vault inspection over an RPC you choose, and a split online/offline signing flow.
//
//   request (online)  ->  sign (offline, with the key file)  ->  assemble  ->  send (any wallet or this tool)
//
// The offline signer never trusts a digest it is handed: it recomputes every digest from the request's
// readable fields, shows them, and signs only what it computed.
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createWalletClient, http, encodeFunctionData, formatUnits, parseUnits, bytesToHex, hexToBytes, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ABI, ACTION, ACCEPTANCE_MAX, DEFAULT_CHAIN, RPC, ZERO, manifest, actionDigest, paramsHashOf, withdrawalParamsHash,
  keyFromSeed, recordOf, popMessage, predictVault, setupDigest, sign, verify, keyIdOf, addr, b32,
} from '../lib/protocol.mjs';
import { encryptKey, decryptKey, parseKeyFile } from '../lib/keyfile.mjs';
import { parseArgs, out, fail, readJson, writeJson, password, confirmOrExit, client, checkChain, chainOf, rd, window, when, short } from '../lib/io.mjs';
import { v2 } from '../lib/v2.mjs';

const VERSION = '0.2.0';

// ------------------------------------------------------------------ arguments and io (lib/io.mjs)

// ------------------------------------------------------------------ keys

async function keyNew(opt) {
  const chainId = chainOf(opt);
  const m = manifest(chainId);
  const file = opt.out ?? fail('pass --out FILE');
  if (existsSync(file) && !opt.force) fail(`${file} exists`);
  const label = String(opt.label ?? 'Key');
  const pw = await password(opt, true);
  const seed = bytesToHex(randomBytes(32));
  const kf = await encryptKey({ seed, label, password: pw, chainId, vaultFactory: m.vaultFactory });
  writeJson(file, kf, opt.force);
  out(`key id     ${kf.keyId}`);
  out(`record id  ${kf.recordId}`);
  out('Keep this file and its password apart, and test it with "quanlet key test" before relying on it.');
}

function keyShow(path) {
  const f = parseKeyFile(readJson(path, 'key file'));
  out(`label        ${f.label}`);
  out(`chain        ${f.chainId}`);
  out(`made for     VaultFactory ${f.vaultFactory}`);
  out(`key id       ${f.keyId}`);
  out(`record id    ${f.recordId}`);
  out(`kdf          argon2id m=${f.kdf.memKiB} KiB t=${f.kdf.passes} p=${f.kdf.lanes}`);
}

async function openKey(path, opt) {
  const f = parseKeyFile(readJson(path, 'key file'));
  const k = await decryptKey(f, await password(opt));
  return { file: f, key: k };
}

async function keyTest(path, opt) {
  const { key, file } = await openKey(path, opt);
  const msg = bytesToHex(randomBytes(32));
  const ok = verify(key.publicKey, msg, sign(key, msg));
  out(ok ? `OK: ${file.label} opens, matches its header and signs (${short(file.keyId)}).` : 'FAILED: the restored key did not verify.');
  if (!ok) process.exit(1);
}

// ------------------------------------------------------------------ inspect

async function inspect(vault, opt) {
  const chainId = chainOf(opt);
  const m = manifest(chainId);
  const pc = client(opt, chainId);
  await checkChain(pc, chainId);
  const V = ABI.PersonalVault;
  vault = addr(vault, 'vault');
  const [status, ee, ae, pn, cn, primary, rec, prop, bal, kf, ver, vh] = await Promise.all([
    rd(pc, vault, V, 'status'), rd(pc, vault, V, 'executionEpoch'), rd(pc, vault, V, 'authorityEpoch'),
    rd(pc, vault, V, 'primaryNonce'), rd(pc, vault, V, 'controlNonce'), rd(pc, vault, V, 'primary'),
    rd(pc, vault, V, 'recoveryKeys'), rd(pc, vault, V, 'proposal'), pc.getBalance({ address: vault }),
    rd(pc, vault, V, 'keyFactory'), rd(pc, vault, V, 'verifier'), rd(pc, vault, V, 'verifierCodehash'),
  ]);
  const liveHash = keccak256((await pc.getCode({ address: ver })) ?? '0x');
  out(`vault            ${vault}`);
  out(`status           ${status === 0 ? 'Active' : 'Pending security change'}`);
  out(`balance          ${formatUnits(bal, 18)} ETH`);
  out(`execution epoch  ${ee}    authority epoch ${ae}`);
  out(`primary nonce    ${pn}    control nonce   ${cn}`);
  out(`primary key      ${primary.keyId} (record ${short(primary.recordId)})`);
  rec.forEach((r, i) => out(`recovery ${i}       ${r.keyId} (record ${short(r.recordId)})`));
  out(`KeyFactory       ${kf}${kf.toLowerCase() === m.keyFactory.toLowerCase() ? '' : '  (not the one in the bundled manifest)'}`);
  out(`verifier         ${ver}  code hash ${liveHash === vh ? 'matches the vault binding' : 'DOES NOT MATCH the vault binding'}`);
  if (status === 1) {
    out(`pending change   kind ${prop.kind === 1 ? 'new primary' : 'new recovery set'}, id ${prop.id}`);
    out(`                 can finalize from ${when(prop.executableAt)}, expires ${when(prop.expiresAt)}`);
    prop.newRecords.filter((r) => /[1-9a-f]/.test(r.slice(2))).forEach((r) => out(`                 record ${r}`));
  }
  try {
    const logs = await pc.getContractEvents({ address: vault, abi: V, eventName: 'WithdrawalScheduled', fromBlock: BigInt(opt['from-block'] ?? m.deployedAtBlock) });
    if (logs.length) out('withdrawals');
    for (const l of logs) {
      const w = await rd(pc, vault, V, 'getWithdrawal', [l.args.id]);
      const state = ['removed', 'queued', 'executed', 'cancelled'][w.status];
      const live = w.status === 1 && w.epoch === ee ? state : w.status === 1 ? 'invalidated' : state;
      out(`  ${l.args.id}  ${formatUnits(l.args.amount, 18)} to ${l.args.recipient}  ${live}  mature ${when(l.args.executableAt)}`);
    }
  } catch (e) {
    out(`(could not list withdrawals from logs: ${e.shortMessage ?? e.message}. Try --from-block N)`);
  }
}

// ------------------------------------------------------------------ requests (online)

const REQ = 'quanlet-request';

async function requestCmd(kind, opt) {
  const chainId = chainOf(opt);
  const m = manifest(chainId);

  if (kind === 'register') {
    const f = parseKeyFile(readJson(opt.key ?? fail('pass --key FILE'), 'key file'));
    // Only public data is needed; the public key is read from the key's own signature file later.
    const req = {
      format: REQ, version: 1, kind: 'register', chainId, keyFactory: m.keyFactory,
      keyId: f.keyId, recordId: f.recordId, label: f.label,
      note: 'Proof of possession for KeyFactory.registerKey. Sign it with this key only.',
    };
    return writeJson(opt.out, req, opt.force);
  }

  const pc = client(opt, chainId);
  await checkChain(pc, chainId);

  if (kind === 'create-vault') {
    const primaryRecord = b32(opt.primary, '--primary');
    const recoveryRecords = String(opt.recovery ?? '').split(',').map((r, i) => b32(r, `--recovery #${i + 1}`));
    if (recoveryRecords.length !== 3) fail('--recovery needs three record ids, comma separated');
    const salt = opt.salt ? b32(opt.salt, '--salt') : bytesToHex(randomBytes(32));
    for (const r of [primaryRecord, ...recoveryRecords]) {
      const rec = await rd(pc, m.keyFactory, ABI.KeyFactory, 'getRecord', [r]);
      if (!rec.ready) fail(`record ${r} is not registered in KeyFactory ${m.keyFactory}`);
    }
    const expectedVault = await rd(pc, m.vaultFactory, ABI.VaultFactory, 'predictAddress', [primaryRecord, recoveryRecords, salt]);
    const local = predictVault({ vaultFactory: m.vaultFactory, keyFactory: m.keyFactory, primaryRecord, recoveryRecords, salt });
    if (local.toLowerCase() !== expectedVault.toLowerCase()) fail('the chain predicts a different vault address than this toolkit. Do not continue.');
    const w = await window(pc, opt);
    const req = { format: REQ, version: 1, kind: 'create-vault', chainId, vaultFactory: m.vaultFactory, keyFactory: m.keyFactory, primaryRecord, recoveryRecords, salt, expectedVault, ...w };
    return writeJson(opt.out, req, opt.force);
  }

  if (!(kind in ACTION)) fail(`unknown request kind "${kind}". See "quanlet help".`);
  const V = ABI.PersonalVault;
  const vault = addr(opt.vault, '--vault');
  const [status, executionEpoch, authorityEpoch, primaryNonce, controlNonce, primary, rec] = await Promise.all([
    rd(pc, vault, V, 'status'), rd(pc, vault, V, 'executionEpoch'), rd(pc, vault, V, 'authorityEpoch'),
    rd(pc, vault, V, 'primaryNonce'), rd(pc, vault, V, 'controlNonce'), rd(pc, vault, V, 'primary'), rd(pc, vault, V, 'recoveryKeys'),
  ]);
  const kf = await rd(pc, vault, V, 'keyFactory');
  const quorum = ['recovery', 'replace-set', 'cancel-change'].includes(kind);
  const pendingOnly = kind === 'cancel-change';
  if (pendingOnly ? status !== 1 : status !== 0) fail(pendingOnly ? 'no security change is pending' : 'the vault has a pending security change; only the recovery keys can act until it closes');

  let signers;
  if (quorum) {
    signers = String(opt.signers ?? '').split(',').map(Number);
    if (signers.length !== 2 || signers.some((s) => ![0, 1, 2].includes(s)) || signers[0] === signers[1]) fail('--signers needs two different recovery indexes from 0,1,2, like --signers 0,2');
  }
  const keyIdOfRecord = async (r) => {
    const x = await rd(pc, kf, ABI.KeyFactory, 'getRecord', [b32(r, 'record id')]);
    if (!x.ready) fail(`record ${r} is not registered`);
    return { recordId: r.toLowerCase(), keyId: x.keyId };
  };

  let params = {};
  if (kind === 'schedule') {
    const asset = opt.asset ? addr(opt.asset, '--asset') : ZERO;
    const decimals = asset === ZERO ? 18 : Number(await rd(pc, asset, [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], 'decimals'));
    const amount = parseUnits(String(opt.amount ?? fail('pass --amount')), decimals);
    const feeWei = opt.fee ? parseUnits(String(opt.fee), 18) : 0n;
    const feeRecipient = feeWei ? addr(opt['fee-to'], '--fee-to') : ZERO;
    params = { asset, decimals, recipient: addr(opt.to, '--to'), amount: amount.toString(), feeRecipient, feeWei: feeWei.toString() };
    if (amount <= 0n) fail('the amount must be positive');
  } else if (kind === 'cancel') {
    params = { id: b32(opt.id, '--id') };
  } else if (kind === 'recovery') {
    params = { newPrimary: await keyIdOfRecord(opt['new-primary'] ?? fail('pass --new-primary RECORD')) };
  } else if (kind === 'replace-set') {
    const recs = String(opt.new ?? '').split(',');
    if (recs.length !== 3) fail('--new needs three record ids, comma separated');
    params = { newRecovery: await Promise.all(recs.map(keyIdOfRecord)) };
  } else if (kind === 'cancel-change') {
    params = { proposalId: (await rd(pc, vault, V, 'proposal')).id };
  }

  const w = await window(pc, opt);
  const req = {
    format: REQ, version: 1, kind: 'action', action: kind, chainId, vault,
    counters: {
      executionEpoch: executionEpoch.toString(), authorityEpoch: authorityEpoch.toString(),
      nonceKind: quorum ? 'control' : 'primary', nonce: (quorum ? controlNonce : primaryNonce).toString(),
    },
    params, ...w, signers,
    expectedSigners: {
      primary: primary.keyId,
      recovery: rec.map((r) => r.keyId),
    },
    needs: kind === 'replace-set' ? ['primary', `recovery ${signers[0]}`, `recovery ${signers[1]}`] : quorum ? signers.map((s) => `recovery ${s}`) : ['primary'],
  };
  req.digest = digestOf(req);
  writeJson(opt.out, req, opt.force);
  out(`needs signatures from: ${req.needs.join(', ')}. Valid ${when(w.validAfter)} to ${when(w.validUntil)}.`);
}

/** Recomputes the 32 bytes to sign from the request's own fields. */
function digestOf(req) {
  if (req.format !== REQ || req.version !== 1) throw new Error('This is not a Quanlet request file.');
  if (req.kind === 'register') return popMessage({ chainId: req.chainId, keyFactory: req.keyFactory, keyId: req.keyId, blobHash: req._blobHash });
  if (req.kind === 'create-vault') {
    const local = predictVault(req);
    if (local.toLowerCase() !== req.expectedVault.toLowerCase()) throw new Error('The request names a vault address this toolkit does not derive from its configuration.');
    return setupDigest(req);
  }
  if (req.validUntil <= req.validAfter || req.validUntil - req.validAfter > ACCEPTANCE_MAX) throw new Error('The request has an invalid acceptance window.');
  return actionDigest({
    chainId: req.chainId, vault: req.vault, action: ACTION[req.action],
    executionEpoch: req.counters.executionEpoch, authorityEpoch: req.counters.authorityEpoch, nonce: req.counters.nonce,
    paramsHash: paramsHashOf(req), validAfter: req.validAfter, validUntil: req.validUntil,
  });
}

function describe(req) {
  const lines = [`network      chain ${req.chainId}`];
  if (req.kind === 'register') return [...lines, `action       register key ${req.label} (${req.keyId}) in KeyFactory ${req.keyFactory}`];
  if (req.kind === 'create-vault')
    return [...lines, `action       create a vault at ${req.expectedVault}`, `primary      ${req.primaryRecord}`, ...req.recoveryRecords.map((r, i) => `recovery ${i}   ${r}`), `valid        ${when(req.validAfter)} to ${when(req.validUntil)}`];
  const p = req.params;
  lines.push(`vault        ${req.vault}`, `action       ${req.action}`);
  if (req.action === 'schedule') {
    lines.push(`send         ${formatUnits(BigInt(p.amount), p.decimals ?? 18)} ${p.asset === ZERO ? 'ETH' : `of token ${p.asset}`}`, `to           ${p.recipient}`);
    lines.push(`relay fee    ${p.feeWei === '0' ? 'none' : `${formatUnits(BigInt(p.feeWei), 18)} ETH to ${p.feeRecipient}`}`, 'delay        24 hours after it is accepted, then executable for 7 days');
  }
  if (req.action === 'cancel') lines.push(`withdrawal   ${p.id}`);
  if (req.action === 'invalidate') lines.push(`effect       every queued withdrawal of epoch ${req.counters.executionEpoch} becomes invalid`);
  if (req.action === 'recovery') lines.push(`new primary  key ${p.newPrimary.keyId}`, 'effect       freezes the vault; the new primary takes over after 7 days');
  if (req.action === 'replace-set') p.newRecovery.forEach((k, i) => lines.push(`new recov ${i}  key ${k.keyId}`));
  if (req.action === 'cancel-change') lines.push(`proposal     ${p.proposalId}`);
  lines.push(`counters     execution epoch ${req.counters.executionEpoch}, authority epoch ${req.counters.authorityEpoch}, ${req.counters.nonceKind} nonce ${req.counters.nonce}`);
  lines.push(`valid        ${when(req.validAfter)} to ${when(req.validUntil)}`);
  return lines;
}

// ------------------------------------------------------------------ sign (offline)

async function signCmd(reqPath, opt) {
  const req = readJson(reqPath, 'request');
  const { key, file } = await openKey(opt.key ?? fail('pass --key FILE'), opt);
  if (file.chainId !== req.chainId) fail(`this key file is for chain ${file.chainId}, the request is for chain ${req.chainId}`);
  const keyId = keyIdOf(key.publicKey);

  let role = 'key holder';
  if (req.kind === 'register') {
    if (keyId !== req.keyId.toLowerCase()) fail('this request registers a different key');
    req._blobHash = recordOf(key.publicKey).blobHash;
  } else if (req.kind === 'action') {
    const ex = req.expectedSigners;
    const roles = [];
    if (ex.primary.toLowerCase() === keyId) roles.push('primary');
    ex.recovery.forEach((r, i) => r.toLowerCase() === keyId && roles.push(`recovery ${i}`));
    const useful = roles.filter((r) => req.needs.includes(r));
    if (!useful.length) fail(`this key (${short(keyId)}) is not one of the signers this request needs: ${req.needs.join(', ')}`);
    role = useful[0];
  }
  const digest = digestOf(req);
  if (req.digest && req.digest.toLowerCase() !== digest) fail('the digest written in the request does not match its fields. Do not sign it.');
  process.stderr.write(['', ...describe(req), `signing as   ${role} (${file.label})`, `digest       ${digest}`, ''].join('\n') + '\n');
  await confirmOrExit(opt);
  const sig = sign(key, digest);
  if (!verify(key.publicKey, digest, sig)) fail('the signature did not verify');
  writeJson(opt.out, { format: 'quanlet-signature', version: 1, digest, keyId, role, publicKey: bytesToHex(key.publicKey), signature: sig }, opt.force);
}

// ------------------------------------------------------------------ assemble

function assemble(reqPath, sigPaths, opt) {
  const req = readJson(reqPath, 'request');
  const sigs = sigPaths.map((p) => readJson(p, 'signature'));
  for (const s of sigs) {
    if (s.format !== 'quanlet-signature') fail('not a signature file');
    if (keyIdOf(hexToBytes(s.publicKey)) !== s.keyId.toLowerCase()) fail('a signature file names the wrong key id for its public key');
  }
  if (req.kind === 'register') req._blobHash = recordOf(hexToBytes(sigs[0]?.publicKey ?? fail('pass the key\'s signature file'))).blobHash;
  const digest = digestOf(req);
  for (const s of sigs) if (s.digest.toLowerCase() !== digest || !verify(hexToBytes(s.publicKey), digest, s.signature)) fail(`signature by ${short(s.keyId)} is not over this request`);
  const by = (role) => sigs.find((s) => s.role === role)?.signature ?? fail(`missing the ${role} signature`);

  let to, data;
  if (req.kind === 'register') {
    to = req.keyFactory;
    data = encodeFunctionData({ abi: ABI.KeyFactory, functionName: 'registerKey', args: [sigs[0].publicKey, sigs[0].signature] });
  } else if (req.kind === 'create-vault') {
    to = req.vaultFactory;
    data = encodeFunctionData({ abi: ABI.VaultFactory, functionName: 'createVault', args: [req.primaryRecord, req.recoveryRecords, req.salt, BigInt(req.validAfter), BigInt(req.validUntil), sigs[0].signature] });
  } else {
    to = req.vault;
    const va = BigInt(req.validAfter), vu = BigInt(req.validUntil);
    const p = req.params;
    const quorum = () => ({ validAfter: va, validUntil: vu, signers: req.signers, sigs: req.signers.map((i) => by(`recovery ${i}`)) });
    const auth = () => ({ validAfter: va, validUntil: vu, sig: by('primary') });
    const V = ABI.PersonalVault;
    const call = {
      schedule: () => ['scheduleWithdrawal', [p.asset, p.recipient, BigInt(p.amount), p.feeRecipient, BigInt(p.feeWei), auth()]],
      cancel: () => ['cancelWithdrawal', [p.id, auth()]],
      invalidate: () => ['invalidatePendingRequests', [auth()]],
      recovery: () => ['startRecovery', [p.newPrimary.recordId, quorum()]],
      'replace-set': () => ['startRecoverySetReplacement', [p.newRecovery.map((k) => k.recordId), auth(), quorum()]],
      'cancel-change': () => ['cancelSecurityChange', [quorum()]],
    }[req.action]();
    data = encodeFunctionData({ abi: V, functionName: call[0], args: call[1] });
  }
  writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId: req.chainId, to, data, value: '0', description: describe(req).join('; ') }, opt.force);
}

function plainTx(kind, opt) {
  const chainId = chainOf(opt);
  const vault = addr(opt.vault, '--vault');
  const V = ABI.PersonalVault;
  const map = {
    execute: () => ['executeWithdrawal', [b32(opt.id, '--id')]],
    prune: () => ['pruneWithdrawal', [b32(opt.id, '--id')]],
    finalize: () => ['finalizeSecurityChange', []],
    deposit: () => null,
    expire: () => ['expireSecurityChange', []],
  };
  if (!map[kind]) fail(`unknown tx "${kind}"`);
  if (kind === 'deposit') {
    const value = parseUnits(String(opt.amount ?? fail('pass --amount')), 18);
    return writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId, to: vault, data: '0x', value: value.toString(), description: `deposit ${opt.amount} ETH into ${vault}` }, opt.force);
  }
  const [fn, args] = map[kind]();
  writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId, to: vault, data: encodeFunctionData({ abi: V, functionName: fn, args }), value: '0', description: `${fn} on ${vault}` }, opt.force);
}

async function send(txPath, opt) {
  const tx = readJson(txPath, 'transaction');
  if (tx.format !== 'quanlet-tx') fail('not a transaction file');
  const pc = client(opt, tx.chainId);
  await checkChain(pc, tx.chainId);
  const from = opt.from ? addr(opt.from, '--from') : undefined;
  await pc.call({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), account: from ?? (process.env[opt['gas-key-env'] ?? 'QUANLET_GAS_KEY'] ? privateKeyToAccount(process.env[opt['gas-key-env'] ?? 'QUANLET_GAS_KEY']).address : undefined) }).catch((e) => fail(`dry run reverted: ${e.shortMessage ?? e.message}`));
  out(`dry run ok: ${tx.description}`);
  if (opt['dry-run']) return;
  const pk = process.env[opt['gas-key-env'] ?? 'QUANLET_GAS_KEY'];
  if (!pk) fail('set QUANLET_GAS_KEY (an ordinary wallet that only pays gas; it has no authority over the vault), or send the to/data with any wallet.');
  const account = privateKeyToAccount(pk);
  const wc = createWalletClient({ account, transport: http(opt.rpc ?? process.env.QUANLET_RPC ?? RPC[tx.chainId]) });
  const chain = { id: tx.chainId, name: `chain ${tx.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } };
  const hash = await wc.sendTransaction({ chain, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
  out(`sent ${hash}`);
  const r = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  out(`${r.status === 'success' ? 'confirmed' : 'REVERTED'} in block ${r.blockNumber}, gas used ${r.gasUsed}`);
  if (r.status !== 'success') process.exit(1);
}

// ------------------------------------------------------------------ vectors

async function vectors(opt) {
  const { buildVectors } = await import('../lib/vectors.mjs');
  writeJson(opt.out, buildVectors(chainOf(opt)), opt.force);
}

// ------------------------------------------------------------------ test hooks (used by contracts/test/Cli.t.sol)

function hook(name, args) {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = args;
  if (name === '_digest')
    return out(actionDigest({ action: Number(a0), chainId: a1, vault: a2, executionEpoch: a3, authorityEpoch: a4, nonce: a5, paramsHash: a6, validAfter: a7, validUntil: a8 }));
  if (name === '_withdrawal') return out(withdrawalParamsHash({ asset: a0, recipient: a1, amount: a2, feeRecipient: a3, feeWei: a4 }));
  if (name === '_record') {
    const r = recordOf(hexToBytes(a0));
    return out(`${r.keyId}${r.blobHash.slice(2)}${r.recordId.slice(2)}`);
  }
  if (name === '_pop') return out(popMessage({ chainId: a0, keyFactory: a1, keyId: a2, blobHash: a3 }));
  if (name === '_predict') return out(predictVault({ vaultFactory: a0, keyFactory: a1, primaryRecord: a2, recoveryRecords: [a3, a4, a5], salt: a6 }));
  if (name === '_setup')
    return out(setupDigest({ chainId: a0, vaultFactory: a1, keyFactory: a2, primaryRecord: a3, recoveryRecords: a4.split(','), salt: a5, validAfter: a6, validUntil: a7 }));
  fail(`unknown hook ${name}`);
}

// ------------------------------------------------------------------ main

const HELP = `quanlet ${VERSION} — standalone Quanlet toolkit (no Quanlet server needed)

Keys
  quanlet key new --label NAME --out FILE        create an ML-DSA-44 key and its encrypted backup
  quanlet key show FILE                          key id and record id (no password)
  quanlet key test FILE                          open the backup and sign a test message

Look
  quanlet info                                   the bundled deployment manifest
  quanlet inspect VAULT                          configuration, counters, queue, pending change

Signed actions: request (online) -> sign (offline) -> assemble -> send
  quanlet request register --key FILE --out REQ
  quanlet request create-vault --primary REC --recovery REC,REC,REC [--salt HEX] --out REQ
  quanlet request schedule --vault V --to ADDR --amount 0.1 [--asset TOKEN] [--fee 0.001 --fee-to ADDR] --out REQ
  quanlet request cancel --vault V --id ID --out REQ
  quanlet request invalidate --vault V --out REQ
  quanlet request recovery --vault V --new-primary REC --signers 0,2 --out REQ
  quanlet request replace-set --vault V --new REC,REC,REC --signers 0,1 --out REQ
  quanlet request cancel-change --vault V --signers 1,2 --out REQ
  quanlet sign REQ --key FILE --out SIG          offline; recomputes the digest and shows what it signs
  quanlet assemble REQ SIG [SIG...] --out TX     checks every signature, builds the transaction
  quanlet tx execute|prune --vault V --id ID --out TX
  quanlet tx finalize|expire --vault V --out TX
  quanlet tx deposit --vault V --amount 0.1 --out TX
  quanlet send TX [--dry-run]                    submit; the gas key comes from QUANLET_GAS_KEY

Other
  quanlet vectors [--out FILE]                   deterministic signing vectors for every action

Protocol 2.0 vaults (five keys, FAST and protected routes)
  quanlet v2 help                                every 2.0 command

Options: --rpc URL (or QUANLET_RPC), --chain ID (default 46630), --password-env NAME, --yes, --force,
         --valid-after UNIX, --valid-for SECONDS (max 1800)`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') return out(HELP);
    if (cmd === 'version' || cmd === '--version') return out(VERSION);
    if (cmd.startsWith('_')) return hook(cmd, pos);
    if (cmd === 'info') return writeJson(null, { toolkit: VERSION, manifest: manifest(chainOf(opt)) });
    if (cmd === 'key') {
      if (pos[0] === 'new') return await keyNew(opt);
      if (pos[0] === 'show') return keyShow(pos[1] ?? fail('pass FILE'));
      if (pos[0] === 'test') return await keyTest(pos[1] ?? fail('pass FILE'), opt);
      return fail('key new | show | test');
    }
    if (cmd === 'inspect') return await inspect(pos[0] ?? fail('pass VAULT'), opt);
    if (cmd === 'request') return await requestCmd(pos[0] ?? fail('pass a request kind'), opt);
    if (cmd === 'sign') return await signCmd(pos[0] ?? fail('pass REQ'), opt);
    if (cmd === 'assemble') return assemble(pos[0] ?? fail('pass REQ'), pos.slice(1), opt);
    if (cmd === 'tx') return plainTx(pos[0], opt);
    if (cmd === 'send') return await send(pos[0] ?? fail('pass TX'), opt);
    if (cmd === 'vectors') return await vectors(opt);
    if (cmd === 'v2') return await v2(pos, opt);
    fail(`unknown command "${cmd}". Run "quanlet help".`);
  } catch (e) {
    fail(e.shortMessage ?? e.message);
  }
}

main();
