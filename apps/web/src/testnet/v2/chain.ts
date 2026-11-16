/**
 * Protocol 2.0 on Robinhood Chain Testnet: five ML-DSA-44 roles (primary P, approver A, guardians G1-G3),
 * FAST and PROTECTED transfers, a finite allowance, an optional protected delay, and guardian recovery.
 * Keys are made and kept in this browser; the wallet only pays gas and sends what the user approves.
 * Reads and transactions reuse the 1.x plumbing (our /api/rpc proxy and the wallet's eth_sendTransaction).
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toBytes,
  toFunctionSelector,
  bytesToHex,
  formatUnits,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import { DEPLOYMENT_V2 } from '../../net';
import { TARGET_CHAIN as TARGET_CHAIN_ID, rpc } from '../../wallet';
import { chainTime, read, signDigest, type ErrorBook, type QKey, type Tx } from '../chain';

/** The 2.0 deployment of this build's network. On a mainnet build before deployment every address is zero and
 *  the vault pages never reach this code (see net.ts VAULTS_OPEN). */
export const V2 = DEPLOYMENT_V2 ?? {
  keyFactory: '0x0000000000000000000000000000000000000000',
  verifier: '0x0000000000000000000000000000000000000000',
  vaultFactory: '0x0000000000000000000000000000000000000000',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  manifestUrl: '',
  compatibleVaultFactories: [] as string[],
  tokens: [] as { symbol: string; name: string; address: string; decimals: number }[],
  deployedAtBlock: 0 as number | undefined,
};
export const KEY_FACTORY = V2.keyFactory as Address;
export const VAULT_FACTORY = V2.vaultFactory as Address;
/** Every VaultFactoryV2 on this KeyFactoryV2: vaults and vault info files from any of them open here. */
export const VAULT_FACTORIES = [VAULT_FACTORY, ...(V2.compatibleVaultFactories as Address[])];
export const MULTICALL = V2.multicall as Address;
export const ETH = '0x0000000000000000000000000000000000000000' as Address;

export type Asset = { symbol: string; name: string; address: Address; decimals: number };
export const ASSETS: Asset[] = [
  { symbol: 'ETH', name: 'Ether', address: ETH, decimals: 18 },
  ...V2.tokens.map((t) => ({ ...t, address: t.address as Address })),
];
export const assetOf = (a: string): Asset =>
  ASSETS.find((x) => x.address.toLowerCase() === a.toLowerCase()) ?? { symbol: `${a.slice(0, 6)}…`, name: 'Token', address: a as Address, decimals: 18 };
export const fmt = (v: bigint, a: string) => `${formatUnits(v, assetOf(a).decimals)} ${assetOf(a).symbol}`;

// ------------------------------------------------------------------ constants (contracts/src/v2/QuanletV2.sol)

export const ACTION = {
  TRANSFER: 1,
  CANCEL_WITHDRAWAL: 2,
  INVALIDATE: 3,
  SUSPEND_FAST: 4,
  UPDATE_POLICY: 5,
  REPLACE_SPENDING: 6,
  CANCEL_ADMIN: 7,
  START_RECOVERY: 8,
  REPLACE_GUARDIANS: 9,
  CANCEL_RECOVERY: 10,
} as const;
export const LANE = { SPEND: 1, ADMIN: 2, P_SAFETY: 3, A_SAFETY: 4, RECOVERY: 5 } as const;
export const ROLE = { P: 1, A: 2, G1: 3, G2: 4, G3: 5 } as const;
export const ROUTE = { FAST: 1, PROTECTED: 2 } as const;
export const DELAYS = [0, 3600, 86400, 259200] as const;
export const FAST_HORIZON = 2_592_000;
export const SECURITY_DELAY = 604_800;
export const STATE = { Active: 0, PendingPolicy: 1, PendingSpendingKeys: 2, PendingRecovery: 3, PendingGuardians: 4 } as const;
const ALGORITHM_ID = keccak256(toBytes('QUANLET_ML_DSA_44_FIPS204'));

// ------------------------------------------------------------------ ABIs

const STRUCTS = [
  'struct AssetRule { address asset; uint256 ceiling; uint256 perActionCap; uint64 budgetValidAfter; uint64 budgetValidUntil; address[] recipients; }',
  'struct Policy { uint32 protectedDelay; bool fastEnabled; bool resumeFast; uint256 maxFastFeeWei; address[] fastFeeRecipients; AssetRule[] assetRules; }',
] as const;

export const KEY_FACTORY_ABI = parseAbi([
  'struct KeyRecord { address blob; bytes32 blobHash; uint8 prepVersion; bool ready; }',
  'function keyIdOf(bytes rawPk) pure returns (bytes32)',
  'function registrationDigest(bytes32 keyId, uint64 validAfter, uint64 validUntil) view returns (bytes32)',
  'function registerKey(bytes rawPk) returns (bytes32)',
  'function activateKey(bytes32 keyId, uint64 validAfter, uint64 validUntil, bytes sig)',
  'function getRecord(bytes32 keyId) view returns (KeyRecord)',
  'event KeyRegistered(bytes32 indexed keyId, address blob, bytes32 blobHash, uint8 prepVersion)',
  'event KeyActivated(bytes32 indexed keyId)',
  'error BadPublicKeyLength()',
  'error DegenerateKey()',
  'error AlreadyRegistered()',
  'error NotRegistered()',
  'error AlreadyActive()',
  'error BlobDeployFailed()',
  'error BadProofOfPossession()',
  'error BadHelper()',
]);

export const VAULT_FACTORY_ABI = parseAbi([
  ...STRUCTS,
  'function predictAddress(bytes32[5] roleIds, Policy policy, bytes32 salt) view returns (address)',
  'function setupDigest(bytes32[5] roleIds, Policy policy, bytes32 salt, uint64 validAfter, uint64 validUntil) view returns (bytes32)',
  'function createVaultV2(bytes32[5] roleIds, Policy policy, bytes32 salt, uint64 validAfter, uint64 validUntil, bytes[5] sigs) returns (address)',
  'function dependencyManifestHash() view returns (bytes32)',
  'event VaultCreated(address indexed vault, bytes32[5] roleIds, bytes32 policyHash, bytes32 salt)',
  'error BadSetupSignature()',
  'error AlreadyDeployed()',
  'error BadCodeStore()',
  'error BadAssets()',
]);

export const VAULT_ABI = parseAbi([
  ...STRUCTS,
  'struct KeyRef { bytes32 keyId; address blob; bytes32 blobHash; }',
  'struct Transfer { uint8 route; address asset; address recipient; uint256 amount; address feeRecipient; uint256 feeWei; }',
  'struct Window { uint64 validAfter; uint64 validUntil; }',
  'struct GuardianSigs { uint8[2] idx; bytes[2] sigs; }',
  'struct Withdrawal { address asset; address recipient; uint256 amount; address feeRecipient; uint256 feeWei; uint64 authorityEpoch; uint64 policyEpoch; uint64 executionEpoch; uint64 executableAt; uint64 expiresAt; uint8 status; }',
  'struct Proposal { bytes32 id; uint8 kind; uint64 executableAt; uint64 expiresAt; bytes32 payloadHash; bytes32[3] keys; }',
  'function state() view returns (uint8)',
  'function authorityEpoch() view returns (uint64)',
  'function policyEpoch() view returns (uint64)',
  'function executionEpoch() view returns (uint64)',
  'function protectedDelay() view returns (uint32)',
  'function fastEnabled() view returns (bool)',
  'function fastSuspended() view returns (bool)',
  'function policyHash() view returns (bytes32)',
  'function spent(address asset) view returns (uint256)',
  'function nonceOf(uint8 lane) view returns (uint256)',
  'function roles() view returns (KeyRef[5])',
  'function getPolicy() view returns (Policy)',
  'function getRemaining(address asset) view returns (uint256 remaining, uint256 ceiling, uint256 perActionCap, uint64 validUntil)',
  'function getProposal() view returns (Proposal)',
  'function getWithdrawal(bytes32 id) view returns (Withdrawal)',
  'function supportedAssets() view returns (address[])',
  'function replaceSpendingKeys(bytes32 newP, bytes32 newA, Window w, bytes pSig, bytes aSig, bytes newPConsent, bytes newAConsent)',
  'function replaceGuardians(bytes32[3] newG, Window w, bytes pSig, bytes aSig, GuardianSigs g, bytes[3] consents)',
  'function policyHashOf(Policy p) pure returns (bytes32)',
  'function actionDigest(uint8 action, uint8 lane, uint256 nonce, bytes32 paramsHash, uint64 validAfter, uint64 validUntil) view returns (bytes32)',
  'function consentDigest(bytes32 digest, uint8 roleId, bytes32 newKeyId) pure returns (bytes32)',
  'function submitTransfer(Transfer t, Window w, bytes pSig, bytes aSig) returns (bytes32)',
  'function executeWithdrawal(bytes32 id)',
  'function pruneWithdrawal(bytes32 id)',
  'function cancelWithdrawal(bytes32 id, uint8 role, Window w, bytes sig)',
  'function invalidateSpending(uint8 role, Window w, bytes sig)',
  'function suspendFast(uint8 role, Window w, bytes sig)',
  'function updatePolicy(Policy p, Window w, bytes pSig, bytes aSig)',
  'function cancelAdminChange(bytes32 proposalId, Window w, bytes pSig, bytes aSig)',
  'function startRecovery(bytes32 newP, bytes32 newA, Window w, GuardianSigs g, bytes newPConsent, bytes newAConsent)',
  'function cancelRecoveryChange(bytes32 proposalId, Window w, GuardianSigs g)',
  'function finalizeSecurityChange(bytes policyPayload)',
  'function expireSecurityChange()',
  'event Deposited(address indexed from, uint256 amount)',
  'event TransferExecuted(bytes32 indexed id, uint8 route, address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei)',
  'event WithdrawalScheduled(bytes32 indexed id, uint64 indexed executionEpoch, address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei, uint64 executableAt, uint64 expiresAt)',
  'event WithdrawalExecuted(bytes32 indexed id, address indexed executor)',
  'event WithdrawalCancelled(bytes32 indexed id, uint8 role)',
  'error NotActive()',
  'error WrongState()',
  'error BadParams()',
  'error BadPolicy()',
  'error BadInterval()',
  'error RequestNotAccepted()',
  'error BadSignature()',
  'error UnexpectedSignature()',
  'error DuplicateSigner()',
  'error BadRole()',
  'error DuplicateKey()',
  'error KeyNotReady()',
  'error FastUnavailable()',
  'error AllowanceExceeded()',
  'error RecipientNotAllowed()',
  'error QueueFull()',
  'error NotQueued()',
  'error StaleEpoch()',
  'error TooEarly()',
  'error Expired()',
  'error NotExpired()',
  'error UnknownWithdrawal()',
  'error WrongProposal()',
  'error TransferFailed()',
  'error Reentrancy()',
  'error VerifierChanged()',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[])',
]);

export const ERRORS: ErrorBook = {
  abi: [...KEY_FACTORY_ABI, ...VAULT_FACTORY_ABI, ...VAULT_ABI].filter((x) => x.type === 'error') as Abi,
  text: {
    BadPublicKeyLength: 'The public key has the wrong length.',
    DegenerateKey: 'This key is too weak to register. Generate a new one.',
    AlreadyRegistered: 'This key is already registered.',
    NotRegistered: 'This key is not registered yet.',
    AlreadyActive: 'This key is already active.',
    BlobDeployFailed: 'The key data could not be stored on chain.',
    BadProofOfPossession: 'The key could not prove it holds its secret part.',
    BadHelper: 'The hashing helper contract changed. Stop and report this.',
    BadSetupSignature: 'One of the five setup signatures did not verify.',
    AlreadyDeployed: 'A vault already exists at this address.',
    BadCodeStore: 'The vault code store changed. Stop and report this.',
    BadAssets: 'The factory asset list is invalid.',
    NotActive: 'The vault is frozen by a pending security change.',
    WrongState: 'That is not possible in the vault’s current state.',
    BadParams: 'The amount, recipient or fee is not valid.',
    BadPolicy: 'The policy is not valid (check the allowance, dates and recipients).',
    BadInterval: 'The signed time window is invalid.',
    RequestNotAccepted: 'The signed request is outside its time window. Try again.',
    BadSignature: 'A signature did not verify.',
    UnexpectedSignature: 'A signature was sent that this action does not take.',
    DuplicateSigner: 'The same guardian was used twice.',
    BadRole: 'Unknown role.',
    DuplicateKey: 'Each role in a vault needs a different key.',
    KeyNotReady: 'One of the keys is not registered and activated yet.',
    FastUnavailable: 'FAST is off, suspended or outside its dates. Use the protected route.',
    AllowanceExceeded: 'This is more than the FAST allowance permits.',
    RecipientNotAllowed: 'That recipient is not on the FAST list. Use the protected route.',
    QueueFull: 'Too many protected transfers are already queued.',
    NotQueued: 'That transfer is no longer queued.',
    StaleEpoch: 'That transfer was invalidated by a freeze or a change.',
    TooEarly: 'The delay has not passed yet.',
    Expired: 'The window to execute has closed.',
    NotExpired: 'It has not expired yet.',
    UnknownWithdrawal: 'Unknown transfer.',
    WrongProposal: 'That is not the pending change.',
    TransferFailed: 'The transfer failed. Check the vault balance.',
    Reentrancy: 'Blocked a re-entrant call.',
    VerifierChanged: 'The verifier contract changed. Stop and report this.',
  },
};

// ------------------------------------------------------------------ types

export type AssetRule = {
  asset: Address;
  ceiling: bigint;
  perActionCap: bigint;
  budgetValidAfter: bigint;
  budgetValidUntil: bigint;
  recipients: readonly Address[];
};
export type Policy = {
  protectedDelay: number;
  fastEnabled: boolean;
  resumeFast: boolean;
  maxFastFeeWei: bigint;
  fastFeeRecipients: readonly Address[];
  assetRules: readonly AssetRule[];
};
export type Window = { validAfter: bigint; validUntil: bigint };
export type Transfer = { route: number; asset: Address; recipient: Address; amount: bigint; feeRecipient: Address; feeWei: bigint };

const POLICY_COMPONENTS = [
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
] as const;

/** abi.encode(policy): the payload a delayed policy change is finalized with. */
export const encodePolicy = (p: Policy): Hex => encodeAbiParameters([{ type: 'tuple', components: POLICY_COMPONENTS }], [p as never]);
export const policyHash = (p: Policy): Hex => keccak256(encodePolicy(p));

// ------------------------------------------------------------------ pending policy from the chain (finding I-3)

const UPDATE_POLICY = VAULT_ABI.find((x) => x.type === 'function' && x.name === 'updatePolicy')!;
const UPDATE_POLICY_SELECTOR = toFunctionSelector(UPDATE_POLICY as AbiFunction).slice(2);

/**
 * The policy carried by a transaction's input, if it is the one whose hash is `payloadHash`. Finds updatePolicy
 * calls sent straight to the vault or nested in another call (a batch or relay contract).
 */
export function policyFromInput(input: string, payloadHash: Hex): Policy | null {
  const hex = (input ?? '').toLowerCase().replace(/^0x/, '');
  for (let i = hex.indexOf(UPDATE_POLICY_SELECTOR); i >= 0; i = hex.indexOf(UPDATE_POLICY_SELECTOR, i + 2)) {
    if (i % 2) continue;
    try {
      const { args } = decodeFunctionData({ abi: [UPDATE_POLICY] as Abi, data: `0x${hex.slice(i)}` as Hex });
      const p = (args as readonly [Policy])[0];
      const policy: Policy = {
        protectedDelay: Number(p.protectedDelay),
        fastEnabled: p.fastEnabled,
        resumeFast: p.resumeFast,
        maxFastFeeWei: p.maxFastFeeWei,
        fastFeeRecipients: [...p.fastFeeRecipients],
        assetRules: p.assetRules.map((r) => ({ ...r, recipients: [...r.recipients] })),
      };
      if (policyHash(policy).toLowerCase() === payloadHash.toLowerCase()) return policy;
    } catch {
      // not a decodable call at this offset
    }
  }
  return null;
}

type RawBlock = { number: Hex; timestamp: Hex; transactions: Array<{ hash: Hex; input: string }> };
const blockAt = (n: number, full = false) => rpc<RawBlock | null>('eth_getBlockByNumber', [`0x${n.toString(16)}`, full]);

/**
 * Finds the policy a pending change will install in the transaction that proposed it, so any device can
 * finalize it. The proposal opened at t = executableAt - protectedDelay, so the transaction is in a block with
 * exactly that timestamp: interpolation search narrows to it, then each block at that second is read in full.
 * The policy is accepted only if its hash equals the one the vault stored.
 */
export async function findPendingPolicy(proposal: Proposal, protectedDelay: number): Promise<{ policy: Policy; tx: Hex } | null> {
  const t = Number(proposal.executableAt) - protectedDelay;
  const time = async (n: number) => {
    const b = await blockAt(n);
    if (!b) throw new Error('missing block');
    return Number(BigInt(b.timestamp));
  };
  let lo = V2.deployedAtBlock ?? 0;
  let hi = Number(BigInt(await rpc<Hex>('eth_blockNumber')));
  let tLo = await time(lo);
  let tHi = await time(hi);
  if (tLo > t || tHi < t) return null;
  for (let i = 0; hi - lo > 1 && i < 80; i++) {
    let m = i % 2 === 0 && tHi > tLo ? lo + Math.floor(((t - tLo) * (hi - lo)) / (tHi - tLo)) : lo + Math.floor((hi - lo) / 2);
    m = Math.min(hi - 1, Math.max(lo + 1, m));
    const tm = await time(m);
    if (tm < t) (lo = m), (tLo = tm);
    else (hi = m), (tHi = tm);
  }
  const first = tLo === t ? lo : hi;
  for (let n = first; n < first + 64; n++) {
    const b = await blockAt(n, true);
    if (!b || Number(BigInt(b.timestamp)) !== t) break;
    for (const tx of b.transactions) {
      const policy = policyFromInput(tx.input, proposal.payloadHash);
      if (policy) return { policy, tx: tx.hash };
    }
  }
  return null;
}

/** The pending policy from a transaction hash the user pastes (when the search above cannot find it). */
export async function pendingPolicyFromTx(hash: Hex, proposal: Proposal): Promise<Policy | null> {
  const tx = await rpc<{ input: string } | null>('eth_getTransactionByHash', [hash]);
  return tx ? policyFromInput(tx.input, proposal.payloadHash) : null;
}

/** JSON-safe form (bigints as decimal strings) for keeping a pending policy in the browser. */
export const policyToJson = (p: Policy) => JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
export const policyFromJson = (s: string): Policy => JSON.parse(s, (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

/** Recipients sorted ascending and unique, as the contract requires. */
export function sortAddresses(list: readonly string[]): Address[] {
  const seen = new Map<string, Address>();
  for (const a of list) seen.set(a.toLowerCase(), a as Address);
  return [...seen.values()].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
}

export type RuleChoice = { asset: Address; ceiling: bigint; cap: bigint };
export type PolicyChoice = {
  delay: number;
  fast: boolean;
  days: number;
  recipients: readonly string[];
  /** New FAST authority per asset, on top of what FAST has already spent (the counter never resets). */
  rules: readonly RuleChoice[];
  maxFee: bigint;
  feeRecipients: readonly string[];
};

/**
 * A policy from the page's choices. Each asset with an allowance gets a rule valid from now for `days` (at
 * most 30); its ceiling is the lifetime FAST debit so far plus the new allowance.
 */
export function buildPolicy(c: PolicyChoice, now: number, spent: Record<string, bigint> = {}): Policy {
  if (!c.fast) return { protectedDelay: c.delay, fastEnabled: false, resumeFast: false, maxFastFeeWei: 0n, fastFeeRecipients: [], assetRules: [] };
  const from = BigInt(now - 60);
  const days = Math.max(1, Math.min(30, Math.floor(c.days)));
  const until = from + BigInt(days * 86400);
  const recipients = sortAddresses(c.recipients);
  const rules = [...c.rules]
    .filter((r) => r.cap > 0n)
    .sort((x, y) => (BigInt(x.asset) < BigInt(y.asset) ? -1 : 1))
    .map((r) => ({
      asset: r.asset,
      ceiling: (spent[r.asset.toLowerCase()] ?? 0n) + r.ceiling,
      perActionCap: r.cap,
      budgetValidAfter: from,
      budgetValidUntil: until,
      recipients,
    }));
  const fees = c.maxFee > 0n ? sortAddresses(c.feeRecipients) : [];
  return { protectedDelay: c.delay, fastEnabled: true, resumeFast: true, maxFastFeeWei: fees.length ? c.maxFee : 0n, fastFeeRecipients: fees, assetRules: rules };
}

// ------------------------------------------------------------------ keys

/** Appendix C key identifier: H(E(ALGORITHM_ID, rawPk)). */
export const keyIdOf = (k: QKey): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [ALGORITHM_ID, bytesToHex(k.publicKey)]));

export type KeyStatus = { registered: boolean; ready: boolean };
export async function keyStatus(keyId: Hex): Promise<KeyStatus> {
  const r = await read<{ blob: Address; ready: boolean }>(KEY_FACTORY, KEY_FACTORY_ABI, 'getRecord', [keyId]);
  return { registered: r.blob !== ETH, ready: r.ready };
}

/** A signed request's acceptance window, from the chain's own clock (at most 30 minutes). */
export async function window(): Promise<Window> {
  const now = await chainTime();
  return { validAfter: BigInt(now - 60), validUntil: BigInt(now + 900) };
}

/**
 * Register and activate a key in one transaction (Multicall3: registerKey, then activateKey with a proof of
 * possession over the registration digest). Registration alone costs about 11 million gas, so each key gets
 * its own transaction. A key already registered but not active only needs the activation.
 */
export async function registerKeyTx(k: QKey): Promise<Tx | null> {
  const keyId = keyIdOf(k);
  const st = await keyStatus(keyId);
  if (st.ready) return null;
  const w = await window();
  const digest = await read<Hex>(KEY_FACTORY, KEY_FACTORY_ABI, 'registrationDigest', [keyId, w.validAfter, w.validUntil]);
  const activate = encodeFunctionData({ abi: KEY_FACTORY_ABI, functionName: 'activateKey', args: [keyId, w.validAfter, w.validUntil, signDigest(k, digest)] });
  if (st.registered) return { to: KEY_FACTORY, data: activate, label: 'Activate key' };
  const register = encodeFunctionData({ abi: KEY_FACTORY_ABI, functionName: 'registerKey', args: [bytesToHex(k.publicKey)] });
  // Surface a registration problem (weak key, already taken) with its own reason before the batch.
  await rpc('eth_call', [{ to: KEY_FACTORY, data: register }, 'latest']).catch(() => {
    throw new Error('This key cannot be registered. Generate a new one.');
  });
  return {
    to: MULTICALL,
    data: encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: 'aggregate3',
      args: [
        [
          { target: KEY_FACTORY, allowFailure: false, callData: register },
          { target: KEY_FACTORY, allowFailure: false, callData: activate },
        ],
      ],
    }),
    label: 'Register key',
  };
}

// ------------------------------------------------------------------ setup

export type RoleKeys = [QKey, QKey, QKey, QKey, QKey]; // P, A, G1, G2, G3

/** All five keys sign the identical Appendix E setup digest; the factory deploys the configured vault. */
export async function createVaultTx(keys: RoleKeys, policy: Policy, salt: Hex): Promise<{ tx: Tx; vault: Address }> {
  const ids = keys.map(keyIdOf) as [Hex, Hex, Hex, Hex, Hex];
  const vault = await read<Address>(VAULT_FACTORY, VAULT_FACTORY_ABI, 'predictAddress', [ids, policy, salt]);
  const w = await window();
  const digest = await read<Hex>(VAULT_FACTORY, VAULT_FACTORY_ABI, 'setupDigest', [ids, policy, salt, w.validAfter, w.validUntil]);
  const sigs = keys.map((k) => signDigest(k, digest)) as [Hex, Hex, Hex, Hex, Hex];
  return {
    vault,
    tx: {
      to: VAULT_FACTORY,
      data: encodeFunctionData({ abi: VAULT_FACTORY_ABI, functionName: 'createVaultV2', args: [ids, policy, salt, w.validAfter, w.validUntil, sigs] }),
      label: 'Create vault',
    },
  };
}

// ------------------------------------------------------------------ signing

const enc = (types: string[], values: unknown[]) => keccak256(encodeAbiParameters(types.map((type) => ({ type })), values));

async function digestFor(vault: Address, action: number, lane: number, paramsHash: Hex) {
  const [nonce, w] = await Promise.all([read<bigint>(vault, VAULT_ABI, 'nonceOf', [lane]), window()]);
  const digest = await read<Hex>(vault, VAULT_ABI, 'actionDigest', [action, lane, nonce, paramsHash, w.validAfter, w.validUntil]);
  return { digest, w };
}

export const transferHash = (t: Transfer) =>
  enc(['uint8', 'address', 'address', 'uint256', 'address', 'uint256'], [t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei]);

export type SignedTransfer = { vault: Address; t: Transfer; w: Window; pSig: Hex; aSig: Hex; id: Hex };

/** FAST: the primary alone, inside the allowance. PROTECTED: primary and approver over the same digest. */
export async function signTransfer(vault: Address, t: Transfer, p: QKey, a: QKey | null): Promise<SignedTransfer> {
  const { digest, w } = await digestFor(vault, ACTION.TRANSFER, LANE.SPEND, transferHash(t));
  return { vault, t, w, pSig: signDigest(p, digest), aSig: t.route === ROUTE.PROTECTED ? signDigest(a!, digest) : '0x', id: digest };
}

export const submitTx = (s: SignedTransfer): Tx => ({
  to: s.vault,
  data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'submitTransfer', args: [s.t, s.w, s.pSig, s.aSig] }),
  label: s.t.route === ROUTE.FAST ? 'FAST transfer' : 'Protected transfer',
});

export async function transferTx(vault: Address, t: Transfer, p: QKey, a: QKey | null): Promise<{ tx: Tx; id: Hex }> {
  const s = await signTransfer(vault, t, p, a);
  return { tx: submitTx(s), id: s.id };
}

// A signed transfer can be handed to anyone (a relayer) to submit: the signatures carry the authority,
// the submitter only pays gas and can change nothing. Any fee goes to the fee recipient that was signed.
export const SIGNED_FORMAT = 'quanlet-v2-signed-transfer';
export function exportSigned(s: SignedTransfer) {
  return {
    format: SIGNED_FORMAT,
    version: 1,
    chainId: TARGET_CHAIN_ID,
    vault: s.vault,
    transfer: { ...s.t, amount: s.t.amount.toString(), feeWei: s.t.feeWei.toString() },
    window: { validAfter: s.w.validAfter.toString(), validUntil: s.w.validUntil.toString() },
    pSig: s.pSig,
    aSig: s.aSig,
    id: s.id,
  };
}
const isAddr = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHexStr = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const isUint = (v: unknown) => typeof v === 'string' && /^\d{1,78}$/.test(v);
export function parseSigned(raw: unknown): SignedTransfer {
  const r = raw as ReturnType<typeof exportSigned>;
  if (!r || r.format !== SIGNED_FORMAT || r.version !== 1) throw new Error('This is not a Quanlet signed transfer.');
  if (r.chainId !== TARGET_CHAIN_ID) throw new Error('This signed transfer is for a different network.');
  const t = r.transfer;
  if (!isAddr(r.vault) || !t || ![1, 2].includes(t.route) || !isAddr(t.asset) || !isAddr(t.recipient) || !isAddr(t.feeRecipient) || !isUint(t.amount) || !isUint(t.feeWei))
    throw new Error('The signed transfer is malformed.');
  if (!r.window || !isUint(r.window.validAfter) || !isUint(r.window.validUntil) || !isHexStr(r.pSig) || !isHexStr(r.aSig)) throw new Error('The signed transfer is malformed.');
  return {
    vault: r.vault,
    t: { route: t.route, asset: t.asset, recipient: t.recipient, amount: BigInt(t.amount), feeRecipient: t.feeRecipient, feeWei: BigInt(t.feeWei) },
    w: { validAfter: BigInt(r.window.validAfter), validUntil: BigInt(r.window.validUntil) },
    pSig: r.pSig,
    aSig: r.aSig,
    id: (isHexStr(r.id) ? r.id : '0x') as Hex,
  };
}

/** Deposit: ETH is sent straight to the vault; a token is transferred to it from the wallet. */
export const depositTx = (vault: Address, asset: Address, value: bigint): Tx =>
  asset === ETH
    ? { to: vault, data: '0x', value, label: 'Deposit' }
    : { to: asset, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [vault, value] }), label: `Deposit ${assetOf(asset).symbol}` };

/** P and A rotate one or both spending keys; each new key consents to the exact action. */
export async function replaceSpendingTx(vault: Address, p: QKey, a: QKey, newP: QKey | null, newA: QKey | null): Promise<Tx> {
  const roles = await read<ReadonlyArray<{ keyId: Hex }>>(vault, VAULT_ABI, 'roles');
  const np = newP ? keyIdOf(newP) : roles[0]!.keyId;
  const na = newA ? keyIdOf(newA) : roles[1]!.keyId;
  const { digest, w } = await digestFor(vault, ACTION.REPLACE_SPENDING, LANE.ADMIN, enc(['bytes32', 'bytes32'], [np, na]));
  const cP = newP ? signDigest(newP, await read<Hex>(vault, VAULT_ABI, 'consentDigest', [digest, ROLE.P, np])) : '0x';
  const cA = newA ? signDigest(newA, await read<Hex>(vault, VAULT_ABI, 'consentDigest', [digest, ROLE.A, na])) : '0x';
  return {
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'replaceSpendingKeys', args: [np, na, w, signDigest(p, digest), signDigest(a, digest), cP, cA] }),
    label: 'Rotate spending keys',
  };
}

/** P, A and two current guardians replace all three guardians; each new guardian consents. Waits 7 days. */
export async function replaceGuardiansTx(vault: Address, p: QKey, a: QKey, guardians: [QKey, QKey], idx: [number, number], next: [QKey, QKey, QKey]): Promise<Tx> {
  const ng = next.map(keyIdOf) as [Hex, Hex, Hex];
  const { digest, w } = await digestFor(vault, ACTION.REPLACE_GUARDIANS, LANE.RECOVERY, enc(['bytes32[3]'], [ng]));
  const consents = (await Promise.all(ng.map((id, i) => read<Hex>(vault, VAULT_ABI, 'consentDigest', [digest, ROLE.G1 + i, id])))).map((d, i) => signDigest(next[i]!, d)) as [Hex, Hex, Hex];
  const g = { idx, sigs: [signDigest(guardians[0], digest), signDigest(guardians[1], digest)] as [Hex, Hex] };
  return {
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'replaceGuardians', args: [ng, w, signDigest(p, digest), signDigest(a, digest), g, consents] }),
    label: 'Replace guardians',
  };
}

/** Anyone may delete a queued entry that can never execute again (expired or invalidated); it frees its queue slot. */
export const pruneTx = (vault: Address, id: Hex): Tx => ({
  to: vault,
  data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'pruneWithdrawal', args: [id] }),
  label: 'Remove stale transfer',
});

export const executeTx = (vault: Address, id: Hex): Tx => ({
  to: vault,
  data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'executeWithdrawal', args: [id] }),
  label: 'Execute transfer',
});

/** Safety actions: P or A alone, each on its own lane. */
const safetyLane = (role: number) => (role === ROLE.P ? LANE.P_SAFETY : LANE.A_SAFETY);

export async function cancelTx(vault: Address, role: number, k: QKey, id: Hex): Promise<Tx> {
  const { digest, w } = await digestFor(vault, ACTION.CANCEL_WITHDRAWAL, safetyLane(role), enc(['bytes32'], [id]));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'cancelWithdrawal', args: [id, role, w, signDigest(k, digest)] }), label: 'Cancel transfer' };
}

export async function invalidateTx(vault: Address, role: number, k: QKey): Promise<Tx> {
  const epoch = await read<bigint>(vault, VAULT_ABI, 'executionEpoch');
  const { digest, w } = await digestFor(vault, ACTION.INVALIDATE, safetyLane(role), enc(['uint64'], [epoch]));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'invalidateSpending', args: [role, w, signDigest(k, digest)] }), label: 'Freeze pending transfers' };
}

export async function suspendFastTx(vault: Address, role: number, k: QKey): Promise<Tx> {
  const epoch = await read<bigint>(vault, VAULT_ABI, 'executionEpoch');
  const { digest, w } = await digestFor(vault, ACTION.SUSPEND_FAST, safetyLane(role), enc(['uint64', 'bool'], [epoch, true]));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'suspendFast', args: [role, w, signDigest(k, digest)] }), label: 'Suspend FAST' };
}

/** P and A replace the whole policy: at once with no protected delay, otherwise after exactly that delay. */
export async function updatePolicyTx(vault: Address, p: QKey, a: QKey, policy: Policy): Promise<Tx> {
  const { digest, w } = await digestFor(vault, ACTION.UPDATE_POLICY, LANE.ADMIN, enc(['bytes32'], [policyHash(policy)]));
  return {
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'updatePolicy', args: [policy, w, signDigest(p, digest), signDigest(a, digest)] }),
    label: 'Change policy',
  };
}

export async function cancelAdminTx(vault: Address, p: QKey, a: QKey, proposalId: Hex): Promise<Tx> {
  const { digest, w } = await digestFor(vault, ACTION.CANCEL_ADMIN, LANE.ADMIN, enc(['bytes32'], [proposalId]));
  return {
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'cancelAdminChange', args: [proposalId, w, signDigest(p, digest), signDigest(a, digest)] }),
    label: 'Cancel pending change',
  };
}

/** Two guardians propose a new spending pair; both new keys consent to the exact action. */
export async function startRecoveryTx(vault: Address, guardians: [QKey, QKey], idx: [number, number], newP: QKey, newA: QKey): Promise<Tx> {
  const np = keyIdOf(newP);
  const na = keyIdOf(newA);
  const { digest, w } = await digestFor(vault, ACTION.START_RECOVERY, LANE.RECOVERY, enc(['bytes32', 'bytes32'], [np, na]));
  const [cP, cA] = await Promise.all([
    read<Hex>(vault, VAULT_ABI, 'consentDigest', [digest, ROLE.P, np]),
    read<Hex>(vault, VAULT_ABI, 'consentDigest', [digest, ROLE.A, na]),
  ]);
  const g = { idx, sigs: [signDigest(guardians[0], digest), signDigest(guardians[1], digest)] as [Hex, Hex] };
  return {
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'startRecovery', args: [np, na, w, g, signDigest(newP, cP), signDigest(newA, cA)] }),
    label: 'Start recovery',
  };
}

export async function cancelRecoveryTx(vault: Address, guardians: [QKey, QKey], idx: [number, number], proposalId: Hex): Promise<Tx> {
  const { digest, w } = await digestFor(vault, ACTION.CANCEL_RECOVERY, LANE.RECOVERY, enc(['bytes32'], [proposalId]));
  const g = { idx, sigs: [signDigest(guardians[0], digest), signDigest(guardians[1], digest)] as [Hex, Hex] };
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'cancelRecoveryChange', args: [proposalId, w, g] }), label: 'Cancel recovery' };
}

export const finalizeTx = (vault: Address, policyPayload: Hex = '0x'): Tx => ({
  to: vault,
  data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'finalizeSecurityChange', args: [policyPayload] }),
  label: 'Finalize change',
});
export const expireTx = (vault: Address): Tx => ({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'expireSecurityChange' }), label: 'Clear expired change' });

// ------------------------------------------------------------------ vault view

export type Withdrawal = {
  id: Hex;
  asset: Address;
  recipient: Address;
  amount: bigint;
  feeRecipient: Address;
  feeWei: bigint;
  authorityEpoch: bigint;
  policyEpoch: bigint;
  executionEpoch: bigint;
  executableAt: bigint;
  expiresAt: bigint;
  status: number; // 0 none, 1 queued, 2 executed, 3 cancelled
};
export type Proposal = { id: Hex; kind: number; executableAt: bigint; expiresAt: bigint; payloadHash: Hex; keys: readonly Hex[] };
export type AssetView = { asset: Address; balance: bigint; spent: bigint; remaining: bigint };
export type VaultView = {
  balance: bigint; // ETH
  assets: AssetView[]; // every asset this vault supports, ETH first
  state: number;
  epochs: { authority: bigint; policy: bigint; execution: bigint };
  roles: Hex[]; // P, A, G1, G2, G3 key ids
  policy: Policy;
  fastSuspended: boolean;
  spent: bigint; // ETH
  remaining: bigint; // ETH
  proposal: Proposal;
  withdrawals: Withdrawal[];
  now: number;
};

/** True when an address answers like a protocol 2.0 vault. */
export async function isVaultV2(a: Address): Promise<boolean> {
  try {
    const code = await rpc<Hex>('eth_getCode', [a, 'latest']);
    if (!code || code === '0x') return false;
    await read(a, VAULT_ABI, 'roles');
    await read(a, VAULT_ABI, 'getRemaining', [ETH]);
    return true;
  } catch {
    return false;
  }
}

const balanceOfAsset = (asset: Address, who: Address) =>
  asset === ETH ? rpc<Hex>('eth_getBalance', [who, 'latest']).then((x) => BigInt(x)) : read<bigint>(asset, ERC20_ABI, 'balanceOf', [who]);
export const walletBalance = balanceOfAsset;

export async function loadVault(vault: Address, ids: Hex[]): Promise<VaultView> {
  const [supported, state, authority, policyE, execution, roles, policy, fastSuspended, proposal, now] = await Promise.all([
    read<readonly Address[]>(vault, VAULT_ABI, 'supportedAssets'),
    read<number>(vault, VAULT_ABI, 'state'),
    read<bigint>(vault, VAULT_ABI, 'authorityEpoch'),
    read<bigint>(vault, VAULT_ABI, 'policyEpoch'),
    read<bigint>(vault, VAULT_ABI, 'executionEpoch'),
    read<ReadonlyArray<{ keyId: Hex }>>(vault, VAULT_ABI, 'roles'),
    read<Policy>(vault, VAULT_ABI, 'getPolicy'),
    read<boolean>(vault, VAULT_ABI, 'fastSuspended'),
    read<Proposal>(vault, VAULT_ABI, 'getProposal'),
    chainTime(),
  ]);
  const assets = await Promise.all(
    supported.map(async (asset) => {
      const [balance, spent, rem] = await Promise.all([
        balanceOfAsset(asset, vault),
        read<bigint>(vault, VAULT_ABI, 'spent', [asset]),
        read<readonly [bigint, bigint, bigint, bigint]>(vault, VAULT_ABI, 'getRemaining', [asset]),
      ]);
      return { asset, balance, spent, remaining: rem[0] };
    }),
  );
  const withdrawals = await Promise.all(
    ids.map(async (id) => {
      const w = await read<Omit<Withdrawal, 'id'>>(vault, VAULT_ABI, 'getWithdrawal', [id]);
      return { ...w, id, status: Number(w.status) };
    }),
  );
  const eth = assets.find((x) => x.asset === ETH) ?? { balance: 0n, spent: 0n, remaining: 0n };
  return {
    balance: eth.balance,
    assets,
    state: Number(state),
    epochs: { authority, policy: policyE, execution },
    roles: roles.map((r) => r.keyId),
    policy: { ...policy, protectedDelay: Number(policy.protectedDelay) },
    fastSuspended,
    spent: eth.spent,
    remaining: eth.remaining,
    proposal: { ...proposal, kind: Number(proposal.kind) },
    withdrawals,
    now,
  };
}

/** The chain's clock (the policy dates are set from it, not from this computer). */
export const chainNowSafe = () => chainTime();
