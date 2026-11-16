// "quanlet v2 ...": the standalone toolkit for protocol 2.0 vaults (five roles, FAST and PROTECTED routes).
// Same split flow as 1.x, and the same promise: the offline signer recomputes every digest from the request's
// readable fields, shows them, and signs only what it computed.
//
//   request (online)  ->  sign (offline, one key file at a time)  ->  assemble  ->  send (any wallet or this tool)
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, decodeAbiParameters, formatUnits, parseUnits, bytesToHex, hexToBytes, keccak256 } from 'viem';
import { sign, verify, addr, b32 } from './protocol.mjs';
import {
  ABI2, ERC20_ABI, MULTICALL_ABI, ACTION, ROLE, ROUTE, STATE, ROLE_NAMES, ROLE_TEXT, ZERO, DELAYS, FAST_HORIZON, ACCEPTANCE_MAX,
  REQ2, SIG2, SIGNED_TRANSFER, VAULT_V2_CREATION_CODE, POLICY_TUPLE, manifest2, keyIdOf2, registrationDigest, actionDigest2, consentDigest,
  transferHash, policyFrom, policyJson, encodePolicy, policyHash, sortAddresses, checkPolicyShape, predictVault2, setupDigest2,
  requestDigest, slotsOf, laneAndParams, policyFromInput, blocksAtTime,
} from './protocol2.mjs';
import { encryptKey2, decryptKey2, parseKeyFile2 } from './keyfile2.mjs';
import { out, fail, readJson, writeJson, password, confirmOrExit, client, checkChain, chainOf, rd, window, when, short } from './io.mjs';

const V = ABI2.Vault;
const eqi = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const DELAY_TEXT = { 0: 'no delay', 3600: '1 hour', 86400: '24 hours', 259200: '72 hours' };
const left = (s) => (s >= 86400 ? `${Math.round(s / 3600)} h` : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.max(0, Math.round(s / 60))} min`);

// ------------------------------------------------------------------ assets

async function assetInfo(pc, asset) {
  if (eqi(asset, ZERO)) return { asset: ZERO, symbol: 'ETH', decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    rd(pc, asset, ERC20_ABI, 'symbol').catch(() => `${asset.slice(0, 8)}…`),
    rd(pc, asset, ERC20_ABI, 'decimals').catch(() => 18),
  ]);
  return { asset, symbol, decimals: Number(decimals) };
}

/** --asset ETH | SYMBOL | ADDRESS, resolved against the assets this vault (or factory) supports. */
async function pickAsset(pc, supported, want) {
  if (!want || /^eth$/i.test(want)) return assetInfo(pc, ZERO);
  if (/^0x[0-9a-fA-F]{40}$/.test(want)) {
    if (!supported.some((a) => eqi(a, want))) fail(`asset ${want} is not supported here. Supported: ${supported.join(', ')}`);
    return assetInfo(pc, addr(want, '--asset'));
  }
  for (const a of supported) {
    const info = await assetInfo(pc, a);
    if (info.symbol.toLowerCase() === want.toLowerCase()) return info;
  }
  fail(`no supported asset has the symbol ${want}`);
}

const amountText = (v, info) => `${formatUnits(BigInt(v), info?.decimals ?? 18)} ${info?.symbol ?? 'ETH'}`;

// ------------------------------------------------------------------ policies

function parseDelay(v) {
  if (v === undefined) return 3600;
  const m = { none: 0, '0': 0, '1h': 3600, '24h': 86400, '72h': 259200, '1d': 86400, '3d': 259200 };
  const d = m[String(v).toLowerCase()] ?? Number(v);
  if (!DELAYS.includes(d)) fail('--delay must be none, 1h, 24h or 72h');
  return d;
}

/**
 * A policy from --policy FILE, or from flags for the common case: one asset with a FAST allowance.
 *   --delay none|1h|24h|72h   --fast-allowance AMOUNT --fast-cap AMOUNT --fast-to ADDR[,ADDR] [--fast-days N] [--fast-asset X]
 *   [--max-fee ETH --fee-to ADDR[,ADDR]]
 * The allowance is new FAST authority on top of what FAST has already spent (the counter never resets).
 */
async function policyFromFlags(pc, opt, { now, supported, spentOf }) {
  if (opt.policy) {
    const p = policyFrom(readJson(opt.policy, 'policy'));
    checkPolicyShape(p);
    return p;
  }
  const protectedDelay = parseDelay(opt.delay);
  if (opt['fast-allowance'] === undefined) {
    if (opt['fast-cap'] || opt['fast-to']) fail('--fast-cap and --fast-to need --fast-allowance');
    return { protectedDelay, fastEnabled: false, resumeFast: false, maxFastFeeWei: 0n, fastFeeRecipients: [], assetRules: [] };
  }
  const info = await pickAsset(pc, supported, opt['fast-asset']);
  const allowance = parseUnits(String(opt['fast-allowance']), info.decimals);
  const cap = parseUnits(String(opt['fast-cap'] ?? opt['fast-allowance']), info.decimals);
  if (allowance <= 0n || cap <= 0n) fail('the FAST allowance and cap must be positive');
  const recipients = sortAddresses(String(opt['fast-to'] ?? '').split(',').filter(Boolean).map((a, i) => addr(a, `--fast-to #${i + 1}`)));
  if (!recipients.length) fail('FAST needs --fast-to ADDR[,ADDR]: the only recipients FAST may pay');
  const days = Number(opt['fast-days'] ?? 30);
  if (!(days >= 1 && days <= 30)) fail('--fast-days must be 1..30');
  const from = BigInt(now - 60);
  const until = from + BigInt(Math.floor(days * 86400));
  if (until > BigInt(now + FAST_HORIZON)) fail('the allowance can last at most 30 days');
  if (until <= BigInt(now + protectedDelay)) fail('the allowance must outlast the protected delay');
  const fees = opt['max-fee'] ? sortAddresses(String(opt['fee-to'] ?? '').split(',').filter(Boolean).map((a, i) => addr(a, `--fee-to #${i + 1}`))) : [];
  if (opt['max-fee'] && !fees.length) fail('--max-fee needs --fee-to ADDR[,ADDR]');
  const p = {
    protectedDelay,
    fastEnabled: true,
    resumeFast: true,
    maxFastFeeWei: fees.length ? parseUnits(String(opt['max-fee']), 18) : 0n,
    fastFeeRecipients: fees,
    assetRules: [{ asset: info.asset, ceiling: (await spentOf(info.asset)) + allowance, perActionCap: cap, budgetValidAfter: from, budgetValidUntil: until, recipients }],
  };
  checkPolicyShape(p);
  return p;
}

function describePolicy(p, infos = {}) {
  const lines = [`delay        protected transfers wait ${DELAY_TEXT[p.protectedDelay] ?? `${p.protectedDelay} s`}`];
  if (!p.fastEnabled) return [...lines, 'FAST         off'];
  lines.push(`FAST         on${p.resumeFast ? ' (resumes if suspended)' : ''}`);
  for (const r of p.assetRules) {
    const i = infos[r.asset.toLowerCase()];
    lines.push(`allowance    ${i ? i.symbol : r.asset}: lifetime ceiling ${amountText(r.ceiling, i)}, at most ${amountText(r.perActionCap, i)} per transfer`);
    lines.push(`             valid ${when(r.budgetValidAfter)} to ${when(r.budgetValidUntil)}`);
    lines.push(`             only to ${r.recipients.join(', ')}`);
  }
  lines.push(`FAST fees    ${p.maxFastFeeWei ? `up to ${formatUnits(p.maxFastFeeWei, 18)} ETH to ${p.fastFeeRecipients.join(', ')}` : 'none'}`);
  return lines;
}

// ------------------------------------------------------------------ keys

async function keyNew(opt) {
  const chainId = chainOf(opt);
  const m = manifest2(chainId);
  const file = opt.out ?? fail('pass --out FILE');
  if (existsSync(file) && !opt.force) fail(`${file} exists`);
  const pw = await password(opt, true);
  const seed = bytesToHex(randomBytes(32));
  const kf = await encryptKey2({ seed, label: String(opt.label ?? 'Key'), password: pw, chainId, keyFactory: m.keyFactory });
  writeJson(file, kf, opt.force);
  out(`key id     ${kf.keyId}`);
  out('Keep this file and its password apart, and test it with "quanlet v2 key test" before relying on it.');
  out('The website opens this file too (Vault > Keys > open a backup).');
}

function keyShow(path) {
  const f = parseKeyFile2(readJson(path, 'key file'));
  out(`label        ${f.label}`);
  out(`protocol     2.0`);
  out(`chain        ${f.chainId}`);
  out(`made for     KeyFactoryV2 ${f.keyFactory}`);
  out(`key id       ${f.keyId}`);
  out(`kdf          argon2id m=${f.kdf.memKiB} KiB t=${f.kdf.passes} p=${f.kdf.lanes}`);
}

async function openKey(path, opt, chainId) {
  const f = parseKeyFile2(readJson(path, 'key file'));
  if (chainId !== undefined) {
    const m = manifest2(chainId);
    if (f.chainId !== chainId) fail(`this key file is for chain ${f.chainId}, the request is for chain ${chainId}`);
    if (!eqi(f.keyFactory, m.keyFactory)) fail(`this key file was made for KeyFactoryV2 ${f.keyFactory}, not ${m.keyFactory}`);
  }
  return { file: f, key: await decryptKey2(f, await password(opt)) };
}

async function keyTest(path, opt) {
  const { key, file } = await openKey(path, opt);
  const msg = bytesToHex(randomBytes(32));
  const ok = verify(key.publicKey, msg, sign(key, msg));
  out(ok ? `OK: ${file.label} opens, matches its header and signs (${short(file.keyId)}).` : 'FAILED: the restored key did not verify.');
  if (!ok) process.exit(1);
}

// ------------------------------------------------------------------ reading a vault

async function vaultState(pc, vault) {
  const r = (fn, args) => rd(pc, vault, V, fn, args);
  const [state, ae, pe, ee, roles, policy, fastSuspended, proposal, supported, kf, nonces] = await Promise.all([
    r('state'), r('authorityEpoch'), r('policyEpoch'), r('executionEpoch'), r('roles'), r('getPolicy'), r('fastSuspended'), r('getProposal'),
    r('supportedAssets'), r('keyFactory'), Promise.all([1, 2, 3, 4, 5].map((l) => r('nonceOf', [l]))),
  ]);
  return {
    state: Number(state),
    epochs: { authority: ae, policy: pe, execution: ee },
    roles: Object.fromEntries(ROLE_NAMES.map((n, i) => [n, roles[i].keyId.toLowerCase()])),
    policy: { ...policy, protectedDelay: Number(policy.protectedDelay), fastFeeRecipients: [...policy.fastFeeRecipients], assetRules: policy.assetRules.map((x) => ({ ...x, recipients: [...x.recipients] })) },
    fastSuspended,
    proposal: { ...proposal, kind: Number(proposal.kind) },
    supported: [...supported],
    keyFactory: kf,
    nonces,
  };
}

async function openVault(opt) {
  const chainId = chainOf(opt);
  const m = manifest2(chainId);
  const pc = client(opt, chainId);
  await checkChain(pc, chainId);
  const vault = addr(opt.vault ?? fail('pass --vault VAULT'), '--vault');
  const code = await pc.getCode({ address: vault });
  if (!code || code === '0x') fail(`no contract at ${vault}`);
  const s = await vaultState(pc, vault).catch(() => fail(`${vault} does not answer like a protocol 2.0 vault`));
  if (!eqi(s.keyFactory, m.keyFactory)) fail(`this vault uses KeyFactoryV2 ${s.keyFactory}, not the one in the bundled manifest (${m.keyFactory})`);
  return { chainId, m, pc, vault, s };
}

async function inspect(vaultArg, opt) {
  const { m, pc, vault, s } = await openVault({ ...opt, vault: vaultArg });
  const [factory, verifier, boundHash] = await Promise.all([rd(pc, vault, V, 'factory'), rd(pc, vault, V, 'verifier'), rd(pc, vault, V, 'verifierCodehash')]);
  const liveHash = keccak256((await pc.getCode({ address: verifier })) ?? '0x');
  const now = Number((await pc.getBlock()).timestamp);
  const infos = {};
  out(`vault            ${vault}`);
  out(`made by          VaultFactoryV2 ${factory}${[m.vaultFactory, ...m.compatibleVaultFactories].some((f) => eqi(f, factory)) ? '' : '  (not a factory in the bundled manifest)'}`);
  out(`state            ${STATE[s.state] ?? s.state}${s.state ? ' (outflows frozen)' : ''}`);
  out(`epochs           authority ${s.epochs.authority}, policy ${s.epochs.policy}, execution ${s.epochs.execution}`);
  out(`nonces           spend ${s.nonces[0]}, admin ${s.nonces[1]}, P safety ${s.nonces[2]}, A safety ${s.nonces[3]}, recovery ${s.nonces[4]}`);
  for (const n of ROLE_NAMES) out(`${ROLE_TEXT[n].padEnd(17)}${s.roles[n]}`);
  out(`verifier         ${verifier}  code hash ${liveHash === boundHash ? 'matches the vault binding' : 'DOES NOT MATCH the vault binding'}`);
  out('assets');
  for (const a of s.supported) {
    const info = await assetInfo(pc, a);
    infos[a.toLowerCase()] = info;
    const [bal, spent, rem] = await Promise.all([
      a === ZERO ? pc.getBalance({ address: vault }) : rd(pc, a, ERC20_ABI, 'balanceOf', [vault]),
      rd(pc, vault, V, 'spent', [a]),
      rd(pc, vault, V, 'getRemaining', [a]),
    ]);
    out(`  ${info.symbol.padEnd(6)} balance ${formatUnits(bal, info.decimals)}, FAST spent ${formatUnits(spent, info.decimals)}, FAST left now ${formatUnits(rem[0], info.decimals)}`);
  }
  out('rules');
  for (const l of describePolicy(s.policy, infos)) out(`  ${l}`);
  if (s.fastSuspended) out('  FAST is suspended (a safety brake was used)');
  if (s.state) {
    const pr = s.proposal;
    out(`pending change   ${STATE[pr.kind]}, id ${pr.id}`);
    out(`                 can finalize from ${when(pr.executableAt)}${now >= Number(pr.executableAt) ? ' (now)' : ` (in ${left(Number(pr.executableAt) - now)})`}, expires ${when(pr.expiresAt)}`);
    if (pr.kind === 1) out(`                 policy hash ${pr.payloadHash}. Run "quanlet v2 pending ${vault}" to find the policy and finalize it.`);
    else pr.keys.filter((k) => /[1-9a-f]/.test(k.slice(2))).forEach((k) => out(`                 new key ${k}`));
  }
  const ids = new Set(String(opt.ids ?? '').split(',').filter(Boolean).map((x) => b32(x, '--ids')));
  try {
    const logs = await pc.getContractEvents({ address: vault, abi: V, eventName: 'WithdrawalScheduled', fromBlock: BigInt(opt['from-block'] ?? m.deployedAtBlock) });
    for (const l of logs) ids.add(l.args.id.toLowerCase());
  } catch (e) {
    out(`(could not list protected transfers from logs: ${e.shortMessage ?? e.message}. Pass --ids ID,ID or --from-block N)`);
  }
  if (ids.size) out('protected transfers');
  for (const id of ids) {
    const w = await rd(pc, vault, V, 'getWithdrawal', [id]);
    const current = w.authorityEpoch === s.epochs.authority && w.policyEpoch === s.epochs.policy && w.executionEpoch === s.epochs.execution;
    const st = Number(w.status);
    const label = st === 1 ? (current ? (now >= Number(w.executableAt) ? 'ready to execute' : `waiting until ${when(w.executableAt)}`) : 'invalidated (can be pruned)') : ['none', 'queued', 'executed', 'cancelled'][st];
    const info = infos[w.asset.toLowerCase()] ?? (await assetInfo(pc, w.asset));
    out(`  ${id}  ${amountText(w.amount, info)} to ${w.recipient}  ${label}`);
  }
}

// ------------------------------------------------------------------ pending policy change (finding I-3)

/**
 * A delayed policy change stores only the policy's hash; finalizing needs the policy itself. This finds it in
 * the transaction that proposed it (the block whose timestamp is executableAt - delay), checks it against the
 * stored hash, and writes the finalize transaction. Any device can finalize, not only the one that signed.
 */
async function pending(vaultArg, opt) {
  const { chainId, m, pc, vault, s } = await openVault({ ...opt, vault: vaultArg });
  if (s.state !== 1) fail(s.state ? `the pending change is a ${STATE[s.state].toLowerCase()}, which needs no payload: use "quanlet v2 tx finalize --vault ${vault}"` : 'no change is pending');
  const pr = s.proposal;
  let policy = null;
  let where = '';
  if (opt.tx) {
    const tx = await pc.getTransaction({ hash: b32(opt.tx, '--tx') });
    policy = policyFromInput(tx.input, pr.payloadHash);
    if (!policy) fail(`transaction ${opt.tx} does not carry the pending policy (hash ${pr.payloadHash})`);
    where = `transaction ${tx.hash}`;
  } else {
    const t = Number(pr.executableAt) - s.policy.protectedDelay;
    const latest = Number(await pc.getBlockNumber());
    const lo = Number(opt['from-block'] ?? m.deployedAtBlock);
    const time = async (n) => Number((await pc.getBlock({ blockNumber: BigInt(n) })).timestamp);
    const range = await blocksAtTime(t, lo, latest, time);
    if (!range) fail(`no block at ${when(t)}. Pass the proposing transaction with --tx HASH.`);
    for (let n = range.from; n <= range.to && !policy; n++) {
      const b = await pc.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
      for (const tx of b.transactions) {
        policy = policyFromInput(tx.input, pr.payloadHash);
        if (policy) {
          where = `transaction ${tx.hash} (block ${n})`;
          break;
        }
      }
    }
    if (!policy) fail(`the proposing transaction was not found in blocks ${range.from}-${range.to}. Pass it with --tx HASH.`);
  }
  const infos = {};
  for (const a of s.supported) infos[a.toLowerCase()] = await assetInfo(pc, a);
  out(`found the pending policy in ${where}`);
  out(`its hash matches the vault's pending change ${pr.id}`);
  for (const l of describePolicy(policy, infos)) out(`  ${l}`);
  const now = Number((await pc.getBlock()).timestamp);
  out(now >= Number(pr.executableAt) ? 'it can be finalized now' : `it can be finalized from ${when(pr.executableAt)} (in ${left(Number(pr.executableAt) - now)})`);
  if (opt['policy-out']) writeJson(opt['policy-out'], policyJson(policy), opt.force);
  if (opt.out)
    writeJson(opt.out, {
      format: 'quanlet-tx', version: 1, chainId, to: vault, value: '0',
      data: encodeFunctionData({ abi: V, functionName: 'finalizeSecurityChange', args: [encodePolicy(policy)] }),
      description: `finalize the pending policy change on ${vault}`,
    }, opt.force);
}

// ------------------------------------------------------------------ requests (online)

const guardiansOpt = (opt) => {
  const g = String(opt.guardians ?? '').split(',').map(Number);
  if (g.length !== 2 || g.some((x) => ![1, 2, 3].includes(x)) || g[0] === g[1]) fail('--guardians needs two different guardians from 1,2,3, like --guardians 1,3');
  return g.map((x) => x - 1);
};
const roleOpt = (opt) => {
  const r = String(opt.role ?? '').toLowerCase();
  if (!['p', 'a'].includes(r)) fail('--role must be p (primary) or a (approver)');
  return r;
};

async function keyReady(pc, keyFactory, keyId, what) {
  const r = await rd(pc, keyFactory, ABI2.KeyFactory, 'getRecord', [b32(keyId, what)]);
  if (!r.ready) fail(`${what} ${keyId} is not registered and activated in KeyFactoryV2 ${keyFactory}`);
  return keyId.toLowerCase();
}

async function request(kind, opt) {
  const chainId = chainOf(opt);
  const m = manifest2(chainId);

  if (kind === 'register') {
    const f = parseKeyFile2(readJson(opt.key ?? fail('pass --key FILE'), 'key file'));
    if (f.chainId !== chainId || !eqi(f.keyFactory, m.keyFactory)) fail('this key file belongs to a different network or deployment');
    const pc = client(opt, chainId);
    await checkChain(pc, chainId);
    const rec = await rd(pc, m.keyFactory, ABI2.KeyFactory, 'getRecord', [f.keyId]);
    if (rec.ready) fail('this key is already registered and active');
    const w = await window(pc, opt);
    const req = { format: REQ2, version: 1, kind: 'register', chainId, keyFactory: m.keyFactory, multicall: m.multicall, keyId: f.keyId.toLowerCase(), label: f.label, registered: rec.blob !== ZERO, ...w };
    req.digest = registrationDigest(req);
    writeJson(opt.out, req, opt.force);
    return out(`sign it with that key within ${left(w.validUntil - Math.floor(Date.now() / 1000))}, then assemble and send.`);
  }

  const pc = client(opt, chainId);
  await checkChain(pc, chainId);

  if (kind === 'create-vault') {
    const ids = [
      await keyReady(pc, m.keyFactory, opt.p ?? fail('pass --p KEYID (primary)'), '--p'),
      await keyReady(pc, m.keyFactory, opt.a ?? fail('pass --a KEYID (approver)'), '--a'),
    ];
    const g = String(opt.g ?? '').split(',').filter(Boolean);
    if (g.length !== 3) fail('--g needs three guardian key ids, comma separated');
    for (const [i, x] of g.entries()) ids.push(await keyReady(pc, m.keyFactory, x, `--g #${i + 1}`));
    if (new Set(ids).size !== 5) fail('each role needs a different key');
    const [dm, codeHash, supported] = await Promise.all([
      rd(pc, m.vaultFactory, ABI2.VaultFactory, 'dependencyManifestHash'),
      rd(pc, m.vaultFactory, ABI2.VaultFactory, 'vaultCreationCodeHash'),
      rd(pc, m.vaultFactory, ABI2.VaultFactory, 'supportedAssets'),
    ]);
    if (!eqi(dm, m.dependencyManifestHash) || !eqi(codeHash, m.vaultCreationCodeHash) || supported.length !== m.supportedAssets.length || supported.some((a, i) => !eqi(a, m.supportedAssets[i])))
      fail('the factory on chain does not match the bundled manifest. Do not continue.');
    const now = Number((await pc.getBlock()).timestamp);
    const policy = await policyFromFlags(pc, opt, { now, supported: m.supportedAssets, spentOf: async () => 0n });
    const salt = opt.salt ? b32(opt.salt, '--salt') : bytesToHex(randomBytes(32));
    const setup = { chainId, vaultFactory: m.vaultFactory, keyFactory: m.keyFactory, roleIds: ids, policy, salt, supportedAssets: m.supportedAssets, dependencyManifestHash: m.dependencyManifestHash, vaultCreationCodeHash: m.vaultCreationCodeHash };
    const expectedVault = await rd(pc, m.vaultFactory, ABI2.VaultFactory, 'predictAddress', [ids, policy, salt]);
    if (!eqi(predictVault2(setup), expectedVault)) fail('the chain predicts a different vault address than this toolkit. Do not continue.');
    const w = await window(pc, opt);
    const chainDigest = await rd(pc, m.vaultFactory, ABI2.VaultFactory, 'setupDigest', [ids, policy, salt, BigInt(w.validAfter), BigInt(w.validUntil)]);
    const req = { format: REQ2, version: 1, kind: 'create-vault', ...setup, policy: policyJson(policy), expectedVault, ...w };
    req.digest = setupDigestOf(req);
    if (!eqi(chainDigest, req.digest)) fail('the factory computes a different setup digest than this toolkit. Do not continue.');
    writeJson(opt.out, req, opt.force);
    return out(`all five keys sign this. Valid ${when(w.validAfter)} to ${when(w.validUntil)}.`);
  }

  if (!(kind in ACTION)) fail(`unknown request kind "${kind}". See "quanlet v2 help".`);
  const { vault, s } = await openVault(opt);
  const pr = s.proposal;
  const needState = {
    'cancel-admin': [1, 2],
    'start-recovery': [0, 1, 2, 4],
    'cancel-recovery': [3, 4],
  }[kind] ?? [0];
  if (!needState.includes(s.state)) fail(s.state ? `the vault is in state "${STATE[s.state]}"; ${kind} is not possible now` : `${kind} needs a pending change, and none is pending`);

  let params;
  if (kind === 'transfer') {
    const info = await pickAsset(pc, s.supported, opt.asset);
    const route = String(opt.route ?? 'protected').toLowerCase();
    if (!(route in ROUTE)) fail('--route must be fast or protected');
    const amount = parseUnits(String(opt.amount ?? fail('pass --amount')), info.decimals);
    if (amount <= 0n) fail('the amount must be positive');
    const feeWei = opt.fee ? parseUnits(String(opt.fee), 18) : 0n;
    const feeRecipient = feeWei ? addr(opt['fee-to'], '--fee-to') : ZERO;
    const recipient = addr(opt.to, '--to');
    if (route === 'fast') {
      if (!s.policy.fastEnabled || s.fastSuspended) fail('FAST is off or suspended on this vault. Use --route protected.');
      const rule = s.policy.assetRules.find((r) => eqi(r.asset, info.asset));
      if (!rule || !rule.recipients.some((x) => eqi(x, recipient))) fail(`${recipient} is not on the FAST list for ${info.symbol}. Use --route protected.`);
      if (feeWei && (feeWei > s.policy.maxFastFeeWei || !s.policy.fastFeeRecipients.some((x) => eqi(x, feeRecipient))))
        fail('FAST may pay a relay fee only up to the policy maximum and only to its fee recipients.');
      const rem = await rd(pc, vault, V, 'getRemaining', [info.asset]);
      if (amount > rem[0]) fail(`FAST has ${amountText(rem[0], info)} left now. Use --route protected.`);
      if (amount > rem[2]) fail(`FAST allows at most ${amountText(rem[2], info)} per transfer.`);
    }
    params = { route, asset: info.asset, symbol: info.symbol, decimals: info.decimals, recipient, amount: amount.toString(), feeRecipient, feeWei: feeWei.toString() };
  } else if (kind === 'cancel') {
    params = { role: roleOpt(opt), id: b32(opt.id, '--id') };
  } else if (kind === 'invalidate' || kind === 'suspend-fast') {
    params = { role: roleOpt(opt) };
  } else if (kind === 'update-policy') {
    const now = Number((await pc.getBlock()).timestamp);
    const policy = await policyFromFlags(pc, opt, { now, supported: s.supported, spentOf: (a) => rd(pc, vault, V, 'spent', [a]) });
    params = { policy: policyJson(policy) };
  } else if (kind === 'replace-spending') {
    const newP = opt['new-p'] ? await keyReady(pc, s.keyFactory, opt['new-p'], '--new-p') : s.roles.p;
    const newA = opt['new-a'] ? await keyReady(pc, s.keyFactory, opt['new-a'], '--new-a') : s.roles.a;
    if (newP === s.roles.p && newA === s.roles.a) fail('pass --new-p KEYID and/or --new-a KEYID');
    params = { newP, newA };
  } else if (kind === 'cancel-admin' || kind === 'cancel-recovery') {
    params = { proposalId: pr.id, ...(kind === 'cancel-recovery' ? { guardians: guardiansOpt(opt) } : {}) };
  } else if (kind === 'start-recovery') {
    params = {
      newP: await keyReady(pc, s.keyFactory, opt['new-p'] ?? fail('pass --new-p KEYID'), '--new-p'),
      newA: await keyReady(pc, s.keyFactory, opt['new-a'] ?? fail('pass --new-a KEYID'), '--new-a'),
      guardians: guardiansOpt(opt),
    };
  } else if (kind === 'replace-guardians') {
    const g = String(opt.new ?? '').split(',').filter(Boolean);
    if (g.length !== 3) fail('--new needs three key ids, comma separated');
    params = { newG: await Promise.all(g.map((x, i) => keyReady(pc, s.keyFactory, x, `--new #${i + 1}`))), guardians: guardiansOpt(opt) };
  }

  const w = await window(pc, opt);
  const req = { format: REQ2, version: 1, kind: 'action', action: kind, chainId, vault, roles: s.roles, params, ...w };
  const [lane] = laneAndParams({ ...req, counters: { executionEpoch: s.epochs.execution.toString() } });
  req.counters = {
    lane,
    nonce: s.nonces[lane - 1].toString(),
    authorityEpoch: s.epochs.authority.toString(),
    policyEpoch: s.epochs.policy.toString(),
    executionEpoch: s.epochs.execution.toString(),
  };
  req.digest = requestDigest(req);
  const onChain = await rd(pc, vault, V, 'actionDigest', [ACTION[kind], lane, BigInt(req.counters.nonce), laneAndParams(req)[1], BigInt(w.validAfter), BigInt(w.validUntil)]);
  if (!eqi(onChain, req.digest)) fail('the vault computes a different digest than this toolkit. Do not continue.');
  req.needs = slotsOf(req).map((x) => (x.over === 'consent' ? `${x.slot} (consent of new key ${short(x.keyId)})` : ROLE_TEXT[x.slot]));
  writeJson(opt.out, req, opt.force);
  out(`needs signatures from: ${req.needs.join(', ')}. Valid ${when(w.validAfter)} to ${when(w.validUntil)}.`);
  if (kind === 'transfer') out(`transfer id ${req.digest}`);
}

/** Setup digest recomputed from a create-vault request; refuses a request that points at another deployment. */
function setupDigestOf(req) {
  const m = manifest2(req.chainId);
  const same = (a, b) => (Array.isArray(a) ? a.length === b.length && a.every((x, i) => eqi(x, b[i])) : eqi(a, b));
  for (const k of ['vaultFactory', 'keyFactory', 'dependencyManifestHash', 'vaultCreationCodeHash', 'supportedAssets'])
    if (!same(req[k], m[k])) throw new Error(`The request names a ${k} that is not the bundled deployment's. Do not sign it.`);
  if (req.validUntil <= req.validAfter || req.validUntil - req.validAfter > ACCEPTANCE_MAX) throw new Error('The request has an invalid acceptance window.');
  const policy = policyFrom(req.policy);
  const setup = { ...req, policy };
  if (!eqi(predictVault2(setup), req.expectedVault)) throw new Error('The request names a vault address this toolkit does not derive from its fields.');
  return setupDigest2(setup);
}

function digestOf(req) {
  if (req.format !== REQ2 || req.version !== 1) throw new Error('This is not a Quanlet 2.0 request file.');
  if (req.kind === 'register') {
    const m = manifest2(req.chainId);
    if (!eqi(req.keyFactory, m.keyFactory)) throw new Error('The request names a key factory that is not the bundled deployment\'s.');
    if (req.validUntil <= req.validAfter || req.validUntil - req.validAfter > ACCEPTANCE_MAX) throw new Error('The request has an invalid acceptance window.');
    return registrationDigest(req);
  }
  if (req.kind === 'create-vault') return setupDigestOf(req);
  if (req.kind === 'action') return requestDigest(req);
  throw new Error(`Unknown request kind "${req.kind}".`);
}

/** Who signs a request: register = the key itself; setup = all five roles; actions per protocol. */
function slotsFor(req) {
  if (req.kind === 'register') return [{ slot: 'key', keyId: req.keyId, over: 'action' }];
  if (req.kind === 'create-vault') return ROLE_NAMES.map((n, i) => ({ slot: n, keyId: req.roleIds[i], over: 'action' }));
  return slotsOf(req);
}

function describe(req) {
  const lines = [`network      chain ${req.chainId}, protocol 2.0`];
  if (req.kind === 'register') return [...lines, `action       register and activate key ${req.label} (${req.keyId})`, `in           KeyFactoryV2 ${req.keyFactory}`, `valid        ${when(req.validAfter)} to ${when(req.validUntil)}`];
  if (req.kind === 'create-vault')
    return [
      ...lines,
      `action       create a vault at ${req.expectedVault}`,
      ...ROLE_NAMES.map((n, i) => `${ROLE_TEXT[n].padEnd(13)}${req.roleIds[i]}`),
      ...describePolicy(policyFrom(req.policy)),
      `valid        ${when(req.validAfter)} to ${when(req.validUntil)}`,
    ];
  const p = req.params;
  const gText = (g) => `guardians ${g[0] + 1} and ${g[1] + 1}`;
  lines.push(`vault        ${req.vault}`, `action       ${req.action}`);
  if (req.action === 'transfer') {
    lines.push(`route        ${p.route === 'fast' ? 'FAST (primary alone, inside the allowance, pays at once)' : 'protected (primary and approver)'}`);
    lines.push(`send         ${amountText(p.amount, p)}${eqi(p.asset, ZERO) ? '' : ` (token ${p.asset})`}`, `to           ${p.recipient}`);
    lines.push(`relay fee    ${p.feeWei === '0' ? 'none' : `${formatUnits(BigInt(p.feeWei), 18)} ETH to ${p.feeRecipient}`}`);
  }
  if (req.action === 'cancel') lines.push(`transfer     ${p.id}`, `signed by    ${ROLE_TEXT[p.role]}`);
  if (req.action === 'invalidate') lines.push(`effect       every queued transfer of execution epoch ${req.counters.executionEpoch} becomes invalid`, `signed by    ${ROLE_TEXT[p.role]}`);
  if (req.action === 'suspend-fast') lines.push('effect       FAST stops until a new policy resumes it; queued transfers become invalid', `signed by    ${ROLE_TEXT[p.role]}`);
  if (req.action === 'update-policy') lines.push(...describePolicy(policyFrom(p.policy)));
  if (req.action === 'replace-spending') lines.push(`new primary  ${p.newP}`, `new approver ${p.newA}`);
  if (req.action === 'cancel-admin') lines.push(`cancels      pending change ${p.proposalId}`);
  if (req.action === 'start-recovery') lines.push(`new primary  ${p.newP}`, `new approver ${p.newA}`, `signed by    ${gText(p.guardians)}`, 'effect       freezes outflows; the new pair takes over after 7 days');
  if (req.action === 'replace-guardians') lines.push(...p.newG.map((k, i) => `new guard. ${i + 1} ${k}`), `signed by    primary, approver, ${gText(p.guardians)}`, 'effect       freezes outflows; the new guardians take over after 7 days');
  if (req.action === 'cancel-recovery') lines.push(`cancels      pending change ${p.proposalId}`, `signed by    ${gText(p.guardians)}`);
  const c = req.counters;
  lines.push(`counters     lane ${c.lane} nonce ${c.nonce}; epochs authority ${c.authorityEpoch}, policy ${c.policyEpoch}, execution ${c.executionEpoch}`);
  lines.push(`valid        ${when(req.validAfter)} to ${when(req.validUntil)}`);
  return lines;
}

// ------------------------------------------------------------------ sign (offline)

async function signCmd(reqPath, opt) {
  const req = readJson(reqPath, 'request');
  if (req.format !== REQ2) fail('this is not a Quanlet 2.0 request file (1.x requests use "quanlet sign")');
  const digest = digestOf(req);
  if (req.digest && !eqi(req.digest, digest)) fail('the digest written in the request does not match its fields. Do not sign it.');
  const { key, file } = await openKey(opt.key ?? fail('pass --key FILE'), opt, req.chainId);
  const keyId = keyIdOf2(key.publicKey);
  const mine = slotsFor(req).filter((x) => eqi(x.keyId, keyId));
  if (!mine.length) fail(`this key (${short(keyId)}) is not one of the signers this request needs: ${slotsFor(req).map((x) => x.slot).join(', ')}`);
  const what = mine.map((x) => (x.over === 'consent' ? `the new key's consent as ${x.slot}` : x.slot === 'key' ? 'the key itself' : ROLE_TEXT[x.slot]));
  process.stderr.write(['', ...describe(req), `signing as   ${what.join(' and ')} (${file.label})`, `digest       ${digest}`, ''].join('\n') + '\n');
  await confirmOrExit(opt);
  const sigs = mine.map((x) => {
    const over = x.over === 'consent' ? consentDigest(digest, x.roleId, keyId) : digest;
    const signature = sign(key, over);
    if (!verify(key.publicKey, over, signature)) fail('the signature did not verify');
    return { slot: x.slot, over: x.over, signature };
  });
  writeJson(opt.out, { format: SIG2, version: 1, digest, keyId, publicKey: bytesToHex(key.publicKey), sigs }, opt.force);
}

// ------------------------------------------------------------------ assemble

function collect(req, sigPaths) {
  const digest = digestOf(req);
  const bySlot = {};
  let publicKey;
  for (const path of sigPaths) {
    const s = readJson(path, 'signature');
    if (s.format !== SIG2) fail(`${path} is not a Quanlet 2.0 signature file`);
    const pk = hexToBytes(s.publicKey);
    if (keyIdOf2(pk) !== s.keyId.toLowerCase()) fail(`${path} names the wrong key id for its public key`);
    if (!eqi(s.digest, digest)) fail(`${path} was made for a different request`);
    for (const x of s.sigs) {
      const slot = slotsFor(req).find((y) => y.slot === x.slot && y.over === x.over);
      if (!slot || !eqi(slot.keyId, s.keyId)) fail(`${path}: key ${short(s.keyId)} is not the ${x.slot} of this request`);
      const over = x.over === 'consent' ? consentDigest(digest, slot.roleId, s.keyId) : digest;
      if (!verify(pk, over, x.signature)) fail(`${path}: the ${x.slot} signature does not verify`);
      bySlot[x.slot] = x.signature;
    }
    publicKey = s.publicKey;
  }
  const missing = slotsFor(req).filter((x) => !bySlot[x.slot]).map((x) => x.slot);
  if (missing.length) fail(`missing signatures: ${missing.join(', ')}`);
  return { digest, bySlot, publicKey };
}

function assemble(reqPath, sigPaths, opt) {
  const req = readJson(reqPath, 'request');
  if (req.format !== REQ2) fail('this is not a Quanlet 2.0 request file (1.x requests use "quanlet assemble")');
  const { digest, bySlot: S, publicKey } = collect(req, sigPaths);
  let to, data;
  if (req.kind === 'register') {
    const activate = encodeFunctionData({ abi: ABI2.KeyFactory, functionName: 'activateKey', args: [req.keyId, BigInt(req.validAfter), BigInt(req.validUntil), S.key] });
    if (req.registered) [to, data] = [req.keyFactory, activate];
    else {
      const register = encodeFunctionData({ abi: ABI2.KeyFactory, functionName: 'registerKey', args: [publicKey] });
      to = req.multicall;
      data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [[{ target: req.keyFactory, allowFailure: false, callData: register }, { target: req.keyFactory, allowFailure: false, callData: activate }]] });
    }
  } else if (req.kind === 'create-vault') {
    to = req.vaultFactory;
    data = encodeFunctionData({ abi: ABI2.VaultFactory, functionName: 'createVaultV2', args: [req.roleIds, policyFrom(req.policy), req.salt, BigInt(req.validAfter), BigInt(req.validUntil), ROLE_NAMES.map((n) => S[n])] });
  } else {
    to = req.vault;
    const p = req.params;
    const w = { validAfter: BigInt(req.validAfter), validUntil: BigInt(req.validUntil) };
    const g = () => ({ idx: p.guardians, sigs: p.guardians.map((i) => S[`g${i + 1}`]) });
    const t = () => ({ route: ROUTE[p.route], asset: p.asset, recipient: p.recipient, amount: BigInt(p.amount), feeRecipient: p.feeRecipient, feeWei: BigInt(p.feeWei) });
    const call = {
      transfer: () => ['submitTransfer', [t(), w, S.p, S.a ?? '0x']],
      cancel: () => ['cancelWithdrawal', [p.id, ROLE[p.role], w, S[p.role]]],
      invalidate: () => ['invalidateSpending', [ROLE[p.role], w, S[p.role]]],
      'suspend-fast': () => ['suspendFast', [ROLE[p.role], w, S[p.role]]],
      'update-policy': () => ['updatePolicy', [policyFrom(p.policy), w, S.p, S.a]],
      'replace-spending': () => ['replaceSpendingKeys', [p.newP, p.newA, w, S.p, S.a, S.newP ?? '0x', S.newA ?? '0x']],
      'cancel-admin': () => ['cancelAdminChange', [p.proposalId, w, S.p, S.a]],
      'start-recovery': () => ['startRecovery', [p.newP, p.newA, w, g(), S.newP, S.newA]],
      'replace-guardians': () => ['replaceGuardians', [p.newG, w, S.p, S.a, g(), [S.newG1, S.newG2, S.newG3]]],
      'cancel-recovery': () => ['cancelRecoveryChange', [p.proposalId, w, g()]],
    }[req.action]();
    data = encodeFunctionData({ abi: V, functionName: call[0], args: call[1] });
    if (req.action === 'transfer' && opt['signed-transfer']) {
      // The website's relay format: anyone can submit it; the signatures carry the authority.
      writeJson(opt['signed-transfer'], {
        format: SIGNED_TRANSFER, version: 1, chainId: req.chainId, vault: req.vault,
        transfer: { route: ROUTE[p.route], asset: p.asset, recipient: p.recipient, amount: p.amount, feeRecipient: p.feeRecipient, feeWei: p.feeWei },
        window: { validAfter: String(req.validAfter), validUntil: String(req.validUntil) },
        pSig: S.p, aSig: S.a ?? '0x', id: digest,
      }, opt.force);
    }
  }
  writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId: req.chainId, to, data, value: '0', description: describe(req).join('; ') }, opt.force);
}

/** A signed transfer exported from the website (or "assemble --signed-transfer"), as a transaction to send. */
function relay(path, opt) {
  const r = readJson(path, 'signed transfer');
  if (!r || r.format !== SIGNED_TRANSFER || r.version !== 1) fail('this is not a Quanlet signed transfer');
  const chainId = chainOf({ chain: opt.chain ?? r.chainId });
  manifest2(chainId);
  const t = r.transfer ?? {};
  const uint = (v) => typeof v === 'string' && /^\d{1,78}$/.test(v);
  if (![1, 2].includes(t.route) || !uint(t.amount) || !uint(t.feeWei) || !r.window || !uint(r.window.validAfter) || !uint(r.window.validUntil)) fail('the signed transfer is malformed');
  const vault = addr(r.vault, 'vault');
  const transfer = { route: t.route, asset: addr(t.asset, 'asset'), recipient: addr(t.recipient, 'recipient'), amount: BigInt(t.amount), feeRecipient: addr(t.feeRecipient, 'fee recipient'), feeWei: BigInt(t.feeWei) };
  const w = { validAfter: BigInt(r.window.validAfter), validUntil: BigInt(r.window.validUntil) };
  const data = encodeFunctionData({ abi: V, functionName: 'submitTransfer', args: [transfer, w, r.pSig, r.aSig] });
  out(`${t.route === 1 ? 'FAST' : 'protected'} transfer of ${formatUnits(transfer.amount, 18)} (base units ${t.amount}) to ${transfer.recipient}, valid until ${when(r.window.validUntil)}`);
  writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId, to: vault, data, value: '0', description: `relay a signed transfer to ${vault}` }, opt.force);
}

// ------------------------------------------------------------------ plain transactions (no signatures)

function plainTx(kind, opt) {
  const chainId = chainOf(opt);
  manifest2(chainId);
  const vault = addr(opt.vault, '--vault');
  const tx = (fn, args, description, to = vault, value = '0') => writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId, to, data: fn ? encodeFunctionData({ abi: V, functionName: fn, args }) : '0x', value, description }, opt.force);
  if (kind === 'execute') return tx('executeWithdrawal', [b32(opt.id, '--id')], `execute transfer ${opt.id} on ${vault}`);
  if (kind === 'prune') return tx('pruneWithdrawal', [b32(opt.id, '--id')], `remove stale transfer ${opt.id} on ${vault}`);
  if (kind === 'expire') return tx('expireSecurityChange', [], `clear the expired change on ${vault}`);
  if (kind === 'finalize') {
    const payload = opt.policy ? encodePolicy(policyFrom(readJson(opt.policy, 'policy'))) : '0x';
    return tx('finalizeSecurityChange', [payload], `finalize the pending change on ${vault}${opt.policy ? ' (policy)' : ''}`);
  }
  if (kind === 'deposit') {
    const amount = String(opt.amount ?? fail('pass --amount'));
    if (!opt.asset || /^eth$/i.test(opt.asset)) return tx(null, [], `deposit ${amount} ETH into ${vault}`, vault, parseUnits(amount, 18).toString());
    const token = addr(opt.asset, '--asset (a token address)');
    const decimals = Number(opt.decimals ?? 18);
    return writeJson(opt.out, { format: 'quanlet-tx', version: 1, chainId, to: token, value: '0', data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [vault, parseUnits(amount, decimals)] }), description: `deposit ${amount} of token ${token} into ${vault}` }, opt.force);
  }
  fail(`unknown tx "${kind}"`);
}

// ------------------------------------------------------------------ test hooks (contracts/test/v2/CliV2.t.sol)

function hook(name, a) {
  // Policies arrive as abi.encode(policy) and are decoded, then re-encoded by this toolkit's own encoder.
  const pol = (hex) => {
    const p = decodeAbiParameters([POLICY_TUPLE], hex)[0];
    return { ...p, protectedDelay: Number(p.protectedDelay), fastFeeRecipients: [...p.fastFeeRecipients], assetRules: p.assetRules.map((r) => ({ ...r, recipients: [...r.recipients] })) };
  };
  const list = (s) => (s ? s.split(',') : []);
  if (name === '_v2keyid') return out(keyIdOf2(a[0]));
  if (name === '_v2reg') return out(registrationDigest({ chainId: a[0], keyFactory: a[1], keyId: a[2], validAfter: a[3], validUntil: a[4] }));
  if (name === '_v2digest')
    return out(actionDigest2({ action: a[0], lane: a[1], chainId: a[2], vault: a[3], authorityEpoch: a[4], policyEpoch: a[5], executionEpoch: a[6], nonce: a[7], paramsHash: a[8], validAfter: a[9], validUntil: a[10] }));
  if (name === '_v2consent') return out(consentDigest(a[0], Number(a[1]), a[2]));
  if (name === '_v2transfer') return out(transferHash({ route: a[0], asset: a[1], recipient: a[2], amount: a[3], feeRecipient: a[4], feeWei: a[5] }));
  if (name === '_v2policy') return out(policyHash(pol(a[0])));
  if (name === '_v2found') return out(policyFromInput(a[0], a[1]) ? '0x01' : '0x00');
  const setup = () => ({ vaultFactory: a[0], keyFactory: a[1], roleIds: list(a[2]), policy: pol(a[3]), salt: a[4], supportedAssets: list(a[5]) });
  if (name === '_v2predict') return out(predictVault2(setup()));
  if (name === '_v2setup') return out(setupDigest2({ ...setup(), chainId: a[6], dependencyManifestHash: a[7], validAfter: a[8], validUntil: a[9] }));
  fail(`unknown hook ${name}`);
}

// ------------------------------------------------------------------ main

export const HELP2 = `quanlet v2: protocol 2.0 vaults (five keys: primary, approver, guardians 1-3)

Keys
  quanlet v2 key new --label NAME --out FILE     create an ML-DSA-44 key and its encrypted backup (opens on the website too)
  quanlet v2 key show FILE                       key id (no password)
  quanlet v2 key test FILE                       open the backup and sign a test message

Look
  quanlet v2 info                                the bundled 2.0 deployment
  quanlet v2 inspect VAULT [--ids ID,ID]         roles, rules, balances, allowance, pending change, transfers
  quanlet v2 pending VAULT [--out TX] [--tx HASH]
                                                 find a pending policy change on chain (from any device) and
                                                 write its finalize transaction

Signed actions: request (online) -> sign (offline) -> assemble -> send
  quanlet v2 request register --key FILE --out REQ
  quanlet v2 request create-vault --p ID --a ID --g ID,ID,ID [rules] [--salt HEX] --out REQ
  quanlet v2 request transfer --vault V --to ADDR --amount 0.1 [--asset ETH|SYMBOL|ADDR] [--route protected|fast]
                              [--fee 0.001 --fee-to ADDR] --out REQ
  quanlet v2 request cancel --vault V --id ID --role p|a --out REQ
  quanlet v2 request invalidate|suspend-fast --vault V --role p|a --out REQ
  quanlet v2 request update-policy --vault V [rules] --out REQ
  quanlet v2 request replace-spending --vault V [--new-p ID] [--new-a ID] --out REQ
  quanlet v2 request cancel-admin --vault V --out REQ
  quanlet v2 request start-recovery --vault V --new-p ID --new-a ID --guardians 1,3 --out REQ
  quanlet v2 request replace-guardians --vault V --new ID,ID,ID --guardians 1,2 --out REQ
  quanlet v2 request cancel-recovery --vault V --guardians 2,3 --out REQ
  quanlet v2 sign REQ --key FILE --out SIG       offline; recomputes the digest and shows what it signs
  quanlet v2 assemble REQ SIG [SIG...] --out TX [--signed-transfer FILE]
                                                 checks every signature, builds the transaction (and, for a
                                                 transfer, the website's relay file)
  quanlet v2 relay SIGNED.json --out TX          a signed transfer exported from the website
  quanlet v2 tx execute|prune --vault V --id ID --out TX
  quanlet v2 tx finalize|expire --vault V [--policy FILE] --out TX
  quanlet v2 tx deposit --vault V --amount 0.1 [--asset TOKEN --decimals 18] --out TX
  quanlet send TX [--dry-run]                    submit; the gas key comes from QUANLET_GAS_KEY

Other
  quanlet v2 vectors [--out FILE]                deterministic signing vectors for every 2.0 action

Rules (create-vault, update-policy)
  --delay none|1h|24h|72h                        how long protected transfers wait (default 1h)
  --fast-allowance 0.5 --fast-cap 0.1 --fast-to ADDR[,ADDR] [--fast-days 30] [--fast-asset ETH]
                                                 FAST: the primary alone may pay these recipients, up to the cap
                                                 per transfer and the allowance in total (default: FAST off)
  --max-fee 0.001 --fee-to ADDR[,ADDR]           relay fees FAST may pay
  --policy FILE                                  the whole policy as JSON instead

Options: --rpc URL (or QUANLET_RPC), --chain ID (default 46630), --password-env NAME, --yes, --force,
         --valid-after UNIX, --valid-for SECONDS (max 1800)`;

export async function v2(pos, opt) {
  const [sub, ...rest] = pos;
  if (!sub || sub === 'help') return out(HELP2);
  if (sub.startsWith('_')) return hook(sub, rest);
  if (sub === 'info') {
    const m = manifest2(chainOf(opt));
    return writeJson(null, { protocol: '2.0', manifest: m, bundledVaultCode: keccak256(VAULT_V2_CREATION_CODE) === m.vaultCreationCodeHash.toLowerCase() ? 'matches the pinned creation code hash' : 'DOES NOT MATCH' });
  }
  if (sub === 'key') {
    if (rest[0] === 'new') return keyNew(opt);
    if (rest[0] === 'show') return keyShow(rest[1] ?? fail('pass FILE'));
    if (rest[0] === 'test') return keyTest(rest[1] ?? fail('pass FILE'), opt);
    return fail('v2 key new | show | test');
  }
  if (sub === 'inspect') return inspect(rest[0] ?? opt.vault ?? fail('pass VAULT'), opt);
  if (sub === 'pending') return pending(rest[0] ?? opt.vault ?? fail('pass VAULT'), opt);
  if (sub === 'request') return request(rest[0] ?? fail('pass a request kind'), opt);
  if (sub === 'sign') return signCmd(rest[0] ?? fail('pass REQ'), opt);
  if (sub === 'assemble') return assemble(rest[0] ?? fail('pass REQ'), rest.slice(1), opt);
  if (sub === 'relay') return relay(rest[0] ?? fail('pass a signed transfer file'), opt);
  if (sub === 'tx') return plainTx(rest[0], opt);
  if (sub === 'vectors') {
    const { buildVectors2 } = await import('./vectors2.mjs');
    return writeJson(opt.out, buildVectors2(chainOf(opt)), opt.force);
  }
  fail(`unknown command "v2 ${sub}". Run "quanlet v2 help".`);
}
