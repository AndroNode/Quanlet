// Quanlet protocol 2.0 encodings (whitepaper v2.0 Appendices A, B, C and E), computed locally so an offline
// signer never has to trust a digest it was handed. Each function matches a view function of the deployed
// 2.0 contracts; contracts/test/v2/CliV2.t.sol compares them.
//
// Five roles per vault: primary P, approver A, guardians G1-G3. FAST transfers need P alone (inside the
// policy's allowance); PROTECTED transfers need P and A and wait the protected delay. Guardians recover.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, keccak256, toBytes, bytesToHex, hexToBytes, getContractAddress, concat, decodeFunctionData, toFunctionSelector, getAbiItem } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', f), 'utf8'));

export const ABI2 = {
  KeyFactory: load('abi/KeyFactoryV2.json').abi,
  VaultFactory: load('abi/VaultFactoryV2.json').abi,
  Vault: load('abi/PersonalVaultV2.json').abi,
};
export const VAULT_V2_CREATION_CODE = load('abi/PersonalVaultV2.json').bytecode;
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL_ABI = [
  {
    type: 'function', name: 'aggregate3', stateMutability: 'payable',
    inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }],
    outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
  },
];
export const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

// ------------------------------------------------------------------ constants (contracts/src/v2/QuanletV2.sol)

export const ACTION_DOMAIN = keccak256(toBytes('QUANLET_ACTION_V2'));
export const CONSENT_DOMAIN = keccak256(toBytes('QUANLET_ROLE_CONSENT_V2'));
export const SETUP_DOMAIN = keccak256(toBytes('QUANLET_SETUP_V2'));
export const REGISTRATION_DOMAIN = keccak256(toBytes('QUANLET_KEY_REGISTRATION_V2'));
export const ALGORITHM_ID = keccak256(toBytes('QUANLET_ML_DSA_44_FIPS204'));
export const PROTOCOL_VERSION = 2;
export const ACCEPTANCE_MAX = 1800;
export const FAST_HORIZON = 2_592_000;
export const SECURITY_DELAY = 604_800;
export const ADMIN_WINDOW = 604_800;
export const DELAYS = [0, 3600, 86400, 259200];
export const ZERO = '0x0000000000000000000000000000000000000000';

export const ACTION = {
  transfer: 1, cancel: 2, invalidate: 3, 'suspend-fast': 4, 'update-policy': 5, 'replace-spending': 6,
  'cancel-admin': 7, 'start-recovery': 8, 'replace-guardians': 9, 'cancel-recovery': 10,
};
export const LANE = { spend: 1, admin: 2, pSafety: 3, aSafety: 4, recovery: 5 };
export const ROLE = { p: 1, a: 2, g1: 3, g2: 4, g3: 5 };
export const ROUTE = { fast: 1, protected: 2 };
export const STATE = ['Active', 'Pending policy change', 'Pending new spending keys', 'Pending recovery', 'Pending new guardians'];
export const ROLE_NAMES = ['p', 'a', 'g1', 'g2', 'g3'];
export const ROLE_TEXT = { p: 'primary', a: 'approver', g1: 'guardian 1', g2: 'guardian 2', g3: 'guardian 3' };

// ------------------------------------------------------------------ deployment manifest

/**
 * The 2.0 deployment for a chain: KeyFactoryV2 and its verifier from <chain>.v2.json, and the current
 * VaultFactoryV2 (with its supported assets and dependency manifest hash) from <chain>.v2.tokens.json when
 * present. QUANLET_V2_MANIFEST points at a file of the returned shape instead (a local chain, a new release).
 */
export function manifest2(chainId) {
  if (process.env.QUANLET_V2_MANIFEST) {
    const m = JSON.parse(readFileSync(process.env.QUANLET_V2_MANIFEST, 'utf8'));
    if (m.chainId !== chainId) throw new Error(`QUANLET_V2_MANIFEST is for chain ${m.chainId}, not ${chainId}.`);
    return m;
  }
  const basePath = join(here, '..', 'deployments', `${chainId}.v2.json`);
  if (!existsSync(basePath)) throw new Error(`No protocol 2.0 deployment manifest for chain ${chainId}.`);
  const base = load(`deployments/${chainId}.v2.json`);
  const cur = existsSync(join(here, '..', 'deployments', `${chainId}.v2.tokens.json`)) ? load(`deployments/${chainId}.v2.tokens.json`) : base;
  if (cur.keyFactoryV2.toLowerCase() !== base.keyFactoryV2.toLowerCase()) throw new Error('The 2.0 manifests name different key factories.');
  return {
    chainId,
    protocolVersion: 2,
    keyFactory: base.keyFactoryV2,
    verifier: base.verifier,
    verifierCodehash: base.verifierCodehash,
    f1600Helper: base.f1600Helper,
    multicall: MULTICALL3,
    vaultFactory: cur.vaultFactoryV2,
    dependencyManifestHash: cur.dependencyManifestHash,
    supportedAssets: cur.supportedAssets,
    vaultCreationCodeHash: cur.vaultCreationCodeHash,
    deployedAtBlock: base.deployedAtBlock,
    compatibleVaultFactories: cur === base ? [] : [base.vaultFactoryV2],
  };
}

// ------------------------------------------------------------------ hashing

const enc = (types, values) => keccak256(encodeAbiParameters(types.map((type) => ({ type })), values));

/** Appendix C key identifier: H(E(ALGORITHM_ID, rawPk)). */
export const keyIdOf2 = (pk) => enc(['bytes32', 'bytes'], [ALGORITHM_ID, typeof pk === 'string' ? pk : bytesToHex(pk)]);

/** Appendix E registration digest: what a key signs to activate its record in KeyFactoryV2. */
export const registrationDigest = ({ chainId, keyFactory, keyId, validAfter, validUntil }) =>
  enc(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint64', 'uint64'], [REGISTRATION_DOMAIN, BigInt(chainId), keyFactory, ALGORITHM_ID, keyId, BigInt(validAfter), BigInt(validUntil)]);

/** Appendix A action digest. The recovery lane binds the authority epoch only (policy and execution epochs are zero). */
export function actionDigest2({ chainId, vault, action, lane, authorityEpoch, policyEpoch, executionEpoch, nonce, paramsHash, validAfter, validUntil }) {
  const rec = Number(lane) === LANE.recovery;
  return enc(
    ['bytes32', 'uint32', 'uint256', 'address', 'uint8', 'uint8', 'uint64', 'uint64', 'uint64', 'uint256', 'bytes32', 'uint64', 'uint64'],
    [
      ACTION_DOMAIN, PROTOCOL_VERSION, BigInt(chainId), vault, Number(action), Number(lane), BigInt(authorityEpoch),
      rec ? 0n : BigInt(policyEpoch), rec ? 0n : BigInt(executionEpoch), BigInt(nonce), paramsHash, BigInt(validAfter), BigInt(validUntil),
    ],
  );
}

/** Appendix A role consent: a newly designated key consents to the exact action. */
export const consentDigest = (digest, roleId, newKeyId) => enc(['bytes32', 'bytes32', 'uint8', 'bytes32'], [CONSENT_DOMAIN, digest, roleId, newKeyId]);

export const transferHash = (t) =>
  enc(['uint8', 'address', 'address', 'uint256', 'address', 'uint256'], [Number(t.route), t.asset, t.recipient, BigInt(t.amount), t.feeRecipient, BigInt(t.feeWei)]);

export const POLICY_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'protectedDelay', type: 'uint32' },
    { name: 'fastEnabled', type: 'bool' },
    { name: 'resumeFast', type: 'bool' },
    { name: 'maxFastFeeWei', type: 'uint256' },
    { name: 'fastFeeRecipients', type: 'address[]' },
    {
      name: 'assetRules',
      type: 'tuple[]',
      components: [
        { name: 'asset', type: 'address' },
        { name: 'ceiling', type: 'uint256' },
        { name: 'perActionCap', type: 'uint256' },
        { name: 'budgetValidAfter', type: 'uint64' },
        { name: 'budgetValidUntil', type: 'uint64' },
        { name: 'recipients', type: 'address[]' },
      ],
    },
  ],
};

/** A policy with bigint fields, from its JSON form (amounts and dates as decimal strings or numbers). */
export function policyFrom(j) {
  if (!j || typeof j !== 'object') throw new Error('The policy is missing.');
  const u = (v, what) => {
    if (!(typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) throw new Error(`policy ${what} must be a whole number`);
    return BigInt(v);
  };
  const a = (v) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v ?? '')) throw new Error(`policy address "${v}" is not an address`);
    return v;
  };
  return {
    protectedDelay: Number(u(j.protectedDelay, 'protectedDelay')),
    fastEnabled: j.fastEnabled === true,
    resumeFast: j.resumeFast === true,
    maxFastFeeWei: u(j.maxFastFeeWei ?? 0, 'maxFastFeeWei'),
    fastFeeRecipients: (j.fastFeeRecipients ?? []).map(a),
    assetRules: (j.assetRules ?? []).map((r) => ({
      asset: a(r.asset),
      ceiling: u(r.ceiling, 'ceiling'),
      perActionCap: u(r.perActionCap, 'perActionCap'),
      budgetValidAfter: u(r.budgetValidAfter, 'budgetValidAfter'),
      budgetValidUntil: u(r.budgetValidUntil, 'budgetValidUntil'),
      recipients: (r.recipients ?? []).map(a),
    })),
  };
}

/** JSON form: every integer as a decimal string. */
export const policyJson = (p) => JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/** abi.encode(policy): the payload a delayed policy change is finalized with. */
export const encodePolicy = (p) => encodeAbiParameters([POLICY_TUPLE], [p]);
export const policyHash = (p) => keccak256(encodePolicy(p));

/** Sorted ascending and unique, as the contracts require for every address set. */
export function sortAddresses(list) {
  const seen = new Map();
  for (const x of list) seen.set(x.toLowerCase(), x);
  return [...seen.values()].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
}

/** Checks the rules the contract checks when a policy is proposed (except the vault-specific ones). */
export function checkPolicyShape(p) {
  if (!DELAYS.includes(p.protectedDelay)) throw new Error(`the protected delay must be one of ${DELAYS.join(', ')} seconds`);
  const sorted = (s) => s.every((x, i) => i === 0 || BigInt(x) > BigInt(s[i - 1]));
  if (!sorted(p.fastFeeRecipients) || p.fastFeeRecipients.length > 8) throw new Error('fee recipients must be sorted, unique and at most 8');
  if (!sorted(p.assetRules.map((r) => r.asset)) || p.assetRules.length > 16) throw new Error('asset rules must be sorted by asset, unique and at most 16');
  for (const r of p.assetRules) {
    if (!r.recipients.length || r.recipients.length > 16 || !sorted(r.recipients)) throw new Error('each allowance needs 1 to 16 recipients, sorted and unique');
    if (r.perActionCap === 0n) throw new Error('the per-transfer cap must be positive');
    if (r.budgetValidUntil <= r.budgetValidAfter || r.budgetValidUntil - r.budgetValidAfter > BigInt(FAST_HORIZON)) throw new Error('an allowance lasts at most 30 days');
  }
}

// ------------------------------------------------------------------ setup (Appendix E)

/** The vault address VaultFactoryV2 deploys for these roles and policy (CREATE2 over the pinned creation code). */
export function predictVault2({ vaultFactory, keyFactory, roleIds, policy, salt, supportedAssets, vaultCreationCodeHash }) {
  // The bundled code must be the code the factory pinned (its hash is in the deployment manifest).
  if (vaultCreationCodeHash && keccak256(VAULT_V2_CREATION_CODE) !== vaultCreationCodeHash.toLowerCase())
    throw new Error('The bundled PersonalVaultV2 creation code is not the one this deployment pinned. Run "node scripts/sync.mjs".');
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32[5]' }, POLICY_TUPLE, { type: 'address[]' }],
    [keyFactory, roleIds, policy, supportedAssets],
  );
  return getContractAddress({ opcode: 'CREATE2', from: vaultFactory, salt: hexToBytes(salt), bytecode: concat([VAULT_V2_CREATION_CODE, args]) });
}

export const configHash2 = ({ roleIds, dependencyManifestHash, policy }) => enc(['bytes32[5]', 'bytes32', 'bytes32'], [roleIds, dependencyManifestHash, policyHash(policy)]);

export function setupDigest2({ chainId, vaultFactory, keyFactory, roleIds, policy, salt, supportedAssets, dependencyManifestHash, validAfter, validUntil, vaultCreationCodeHash }) {
  const vault = predictVault2({ vaultFactory, keyFactory, roleIds, policy, salt, supportedAssets, vaultCreationCodeHash });
  return enc(
    ['bytes32', 'uint32', 'uint256', 'address', 'bytes32', 'bytes32', 'address', 'uint64', 'uint64'],
    [SETUP_DOMAIN, PROTOCOL_VERSION, BigInt(chainId), vaultFactory, salt, configHash2({ roleIds, dependencyManifestHash, policy }), vault, BigInt(validAfter), BigInt(validUntil)],
  );
}

// ------------------------------------------------------------------ pending policy change (finding I-3)

const UPDATE_POLICY = getAbiItem({ abi: ABI2.Vault, name: 'updatePolicy' });
const UPDATE_POLICY_SELECTOR = toFunctionSelector(UPDATE_POLICY).slice(2);

/**
 * Finds the policy a pending change will install from the calldata of the transaction that proposed it, so
 * any device can finalize it. Looks for updatePolicy calls in each transaction's input (direct, or nested in a
 * batch) and returns the first policy whose hash equals the proposal's payload hash.
 */
export function policyFromInput(input, payloadHash) {
  const hex = (input ?? '').toLowerCase().replace(/^0x/, '');
  for (let i = hex.indexOf(UPDATE_POLICY_SELECTOR); i >= 0; i = hex.indexOf(UPDATE_POLICY_SELECTOR, i + 2)) {
    if (i % 2) continue;
    try {
      const { args } = decodeFunctionData({ abi: [UPDATE_POLICY], data: `0x${hex.slice(i)}` });
      const p = args[0];
      const policy = {
        protectedDelay: Number(p.protectedDelay),
        fastEnabled: p.fastEnabled,
        resumeFast: p.resumeFast,
        maxFastFeeWei: p.maxFastFeeWei,
        fastFeeRecipients: [...p.fastFeeRecipients],
        assetRules: p.assetRules.map((r) => ({ ...r, recipients: [...r.recipients] })),
      };
      if (policyHash(policy) === payloadHash.toLowerCase()) return policy;
    } catch {
      // not a decodable call at this offset
    }
  }
  return null;
}

/**
 * The block range whose timestamp is exactly `t` (the proposal was opened at t = executableAt - delay).
 * `blockTime(n)` returns a block's timestamp; interpolation narrows fast, bisection guarantees the bound.
 */
export async function blocksAtTime(t, lo, hi, blockTime, maxSpan = 64) {
  let tLo = await blockTime(lo);
  let tHi = await blockTime(hi);
  if (tLo >= t) return { from: lo, to: lo, tLo };
  if (tHi < t) return null;
  for (let i = 0; hi - lo > 1; i++) {
    let m = i % 2 === 0 && tHi > tLo ? lo + Math.floor(((t - tLo) * (hi - lo)) / (tHi - tLo)) : lo + Math.floor((hi - lo) / 2);
    m = Math.min(hi - 1, Math.max(lo + 1, m));
    const tm = await blockTime(m);
    if (tm < t) (lo = m), (tLo = tm);
    else (hi = m), (tHi = tm);
  }
  if (tHi !== t) return null; // no block at that second
  let to = hi;
  while (to - hi < maxSpan && (await blockTime(to + 1).catch(() => t + 1)) === t) to++;
  return { from: hi, to };
}

// ------------------------------------------------------------------ requests

export const REQ2 = 'quanlet-v2-request';
export const SIG2 = 'quanlet-v2-signature';
export const SIGNED_TRANSFER = 'quanlet-v2-signed-transfer';

const safetyLane = (role) => (role === 'p' ? LANE.pSafety : LANE.aSafety);

/** The lane and paramsHash of an action request, recomputed from its readable fields. */
export function laneAndParams(req) {
  const p = req.params;
  switch (req.action) {
    case 'transfer':
      return [LANE.spend, transferHash({ route: ROUTE[p.route], asset: p.asset, recipient: p.recipient, amount: p.amount, feeRecipient: p.feeRecipient, feeWei: p.feeWei })];
    case 'cancel':
      return [safetyLane(p.role), enc(['bytes32'], [p.id])];
    case 'invalidate':
      return [safetyLane(p.role), enc(['uint64'], [BigInt(req.counters.executionEpoch)])];
    case 'suspend-fast':
      return [safetyLane(p.role), enc(['uint64', 'bool'], [BigInt(req.counters.executionEpoch), true])];
    case 'update-policy':
      return [LANE.admin, enc(['bytes32'], [policyHash(policyFrom(p.policy))])];
    case 'replace-spending':
      return [LANE.admin, enc(['bytes32', 'bytes32'], [p.newP, p.newA])];
    case 'cancel-admin':
      return [LANE.admin, enc(['bytes32'], [p.proposalId])];
    case 'start-recovery':
      return [LANE.recovery, enc(['bytes32', 'bytes32'], [p.newP, p.newA])];
    case 'replace-guardians':
      return [LANE.recovery, enc(['bytes32[3]'], [p.newG])];
    case 'cancel-recovery':
      return [LANE.recovery, enc(['bytes32'], [p.proposalId])];
    default:
      throw new Error(`Unknown action "${req.action}".`);
  }
}

/**
 * Who signs what for an action, from the request's role key ids and parameters:
 * [{ slot, keyId, over: 'action' | 'consent', roleId? }]. The slots are fixed by the protocol, not by the request.
 */
export function slotsOf(req) {
  const r = req.roles;
  const p = req.params;
  const g = (i) => ({ slot: `g${i + 1}`, keyId: r[`g${i + 1}`], over: 'action' });
  const pair = [{ slot: 'p', keyId: r.p, over: 'action' }, { slot: 'a', keyId: r.a, over: 'action' }];
  const consent = (slot, keyId, roleId) => ({ slot, keyId, over: 'consent', roleId });
  switch (req.action) {
    case 'transfer':
      return p.route === 'fast' ? [pair[0]] : pair;
    case 'cancel':
    case 'invalidate':
    case 'suspend-fast':
      return [{ slot: p.role, keyId: r[p.role], over: 'action' }];
    case 'update-policy':
    case 'cancel-admin':
      return pair;
    case 'replace-spending':
      return [
        ...pair,
        ...(p.newP.toLowerCase() !== r.p.toLowerCase() ? [consent('newP', p.newP, ROLE.p)] : []),
        ...(p.newA.toLowerCase() !== r.a.toLowerCase() ? [consent('newA', p.newA, ROLE.a)] : []),
      ];
    case 'start-recovery':
      return [...p.guardians.map(g), consent('newP', p.newP, ROLE.p), consent('newA', p.newA, ROLE.a)];
    case 'replace-guardians':
      return [...pair, ...p.guardians.map(g), ...p.newG.map((k, i) => consent(`newG${i + 1}`, k, ROLE.g1 + i))];
    case 'cancel-recovery':
      return p.guardians.map(g);
    default:
      throw new Error(`Unknown action "${req.action}".`);
  }
}

/** The 32 bytes the action's signers sign, recomputed from the request's fields. */
export function requestDigest(req) {
  if (req.validUntil <= req.validAfter || req.validUntil - req.validAfter > ACCEPTANCE_MAX) throw new Error('The request has an invalid acceptance window.');
  const [lane, paramsHash] = laneAndParams(req);
  if (Number(req.counters.lane) !== lane) throw new Error('The request names the wrong nonce lane for its action.');
  return actionDigest2({
    chainId: req.chainId, vault: req.vault, action: ACTION[req.action], lane, authorityEpoch: req.counters.authorityEpoch,
    policyEpoch: req.counters.policyEpoch, executionEpoch: req.counters.executionEpoch, nonce: req.counters.nonce, paramsHash,
    validAfter: req.validAfter, validUntil: req.validUntil,
  });
}

export const hexOf = (b) => bytesToHex(b);
