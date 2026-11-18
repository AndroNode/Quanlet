/**
 * Talking to the Quanlet contracts on Robinhood Chain Testnet.
 * Reads go through the site's own /api/rpc (Alchemy behind the Worker). Transactions are sent by
 * the connected browser wallet, which the user approves one by one. ML-DSA-44 keys live in this
 * browser; the wallet never sees them and they never leave the page.
 */
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import {
  bytesToHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { DEFAULT_CONFIG } from '@quanlet/config';
import { rpc, type Eip1193 } from '../wallet';
import { NET } from '../net';
import { prepareBlob } from './prepare';

// ------------------------------------------------------------------ deployment

type Deployment = { keyFactory: Address; vaultFactory: Address; verifier: Address };
const fromEnv = (() => {
  try {
    const raw = import.meta.env.VITE_QUANLET_TESTNET as string | undefined;
    return raw ? (JSON.parse(raw) as Deployment) : null;
  } catch {
    return null;
  }
})();
const dep = DEFAULT_CONFIG.deployments.testnet!;
/** The chain this build serves (net.ts): testnet, or mainnet on a mainnet build. Every send checks it. */
const TARGET_CHAIN_ID = NET.chainId;
export const DEPLOYMENT: Deployment = fromEnv ?? { keyFactory: dep.keyFactory as Address, vaultFactory: dep.vaultFactory as Address, verifier: dep.verifier as Address };
/** Key backups made for these VaultFactory addresses still open (same KeyFactory, so the records still count). */
export const KEYFILE_FACTORIES: string[] = [DEPLOYMENT.vaultFactory, ...(fromEnv ? [] : (dep.compatibleVaultFactories ?? []))].map((a) => a.toLowerCase());

// ------------------------------------------------------------------ ABIs

export const KEY_FACTORY_ABI = parseAbi([
  'function registerKey(bytes rawPk, bytes popSig) returns (bytes32)',
  'function getRecord(bytes32 recordId) view returns ((bytes32 keyId, address blob, bytes32 blobHash, uint8 prepVersion, bool ready))',
  'function recordOfKey(bytes32 keyId) view returns (bytes32)',
  'function popMessage(bytes32 keyId, bytes32 blobHash) view returns (bytes32)',
  'event KeyRegistered(bytes32 indexed recordId, bytes32 indexed keyId, address blob, bytes32 blobHash, uint8 prepVersion)',
  'error BadPublicKeyLength()',
  'error BadHelper()',
  'error DegenerateKey()',
  'error AlreadyRegistered()',
  'error BlobDeployFailed()',
  'error BadProofOfPossession()',
  'error VerifierChanged()',
]);

export const VAULT_FACTORY_ABI = parseAbi([
  'function predictAddress(bytes32 primaryRecord, bytes32[3] recoveryRecords, bytes32 salt) view returns (address)',
  'function setupDigest(bytes32 primaryRecord, bytes32[3] recoveryRecords, bytes32 salt, uint64 validAfter, uint64 validUntil) view returns (bytes32)',
  'function createVault(bytes32 primaryRecord, bytes32[3] recoveryRecords, bytes32 salt, uint64 validAfter, uint64 validUntil, bytes setupSig) returns (address)',
  'event VaultCreated(address indexed vault, bytes32 indexed primaryRecord, bytes32[3] recoveryRecords, bytes32 salt)',
  'error BadInterval()',
  'error RequestNotAccepted()',
  'error BadSetupSignature()',
  'error AlreadyDeployed()',
  'error KeyNotReady()',
]);

export const VAULT_ABI = parseAbi([
  'struct Auth { uint64 validAfter; uint64 validUntil; bytes sig; }',
  'struct QuorumAuth { uint64 validAfter; uint64 validUntil; uint8[2] signers; bytes[2] sigs; }',
  'struct KeyRef { bytes32 recordId; bytes32 keyId; address blob; bytes32 blobHash; }',
  'struct Withdrawal { address asset; address recipient; uint256 amount; address feeRecipient; uint256 feeWei; uint64 epoch; uint64 executableAt; uint64 expiresAt; uint8 status; }',
  'struct Proposal { bytes32 id; uint8 kind; uint64 executableAt; uint64 expiresAt; bytes32[3] newRecords; }',
  'function status() view returns (uint8)',
  'function executionEpoch() view returns (uint64)',
  'function authorityEpoch() view returns (uint64)',
  'function primaryNonce() view returns (uint256)',
  'function controlNonce() view returns (uint256)',
  'function primary() view returns (KeyRef)',
  'function recoveryKeys() view returns (KeyRef[3])',
  'function getWithdrawal(bytes32 id) view returns (Withdrawal)',
  'function proposal() view returns (Proposal)',
  'function keyFactory() view returns (address)',
  'function recoveryParamsHash(bytes32 newPrimaryKeyId) pure returns (bytes32)',
  'function recoverySetParamsHash(bytes32[3] newKeyIds) pure returns (bytes32)',
  'function actionDigest(uint8 action, uint256 nonce, bytes32 paramsHash, uint64 validAfter, uint64 validUntil) view returns (bytes32)',
  'function withdrawalParamsHash(address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei) pure returns (bytes32)',
  'function scheduleWithdrawal(address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei, Auth auth) returns (bytes32)',
  'function cancelWithdrawal(bytes32 id, Auth auth)',
  'function invalidatePendingRequests(Auth auth)',
  'function executeWithdrawal(bytes32 id)',
  'function startRecovery(bytes32 newPrimaryRecord, QuorumAuth auth)',
  'function startRecoverySetReplacement(bytes32[3] newRecords, Auth primaryAuth, QuorumAuth auth)',
  'function cancelSecurityChange(QuorumAuth auth)',
  'function finalizeSecurityChange()',
  'function expireSecurityChange()',
  'event Deposited(address indexed from, uint256 amount)',
  'event WithdrawalScheduled(bytes32 indexed id, uint64 indexed epoch, address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei, uint64 executableAt, uint64 expiresAt)',
  'event WithdrawalExecuted(bytes32 indexed id, address indexed executor)',
  'event WithdrawalCancelled(bytes32 indexed id)',
  'event SecurityChangeStarted(bytes32 indexed id, uint8 kind, bytes32[3] newRecords, uint64 executableAt, uint64 expiresAt)',
  'event SecurityChangeCancelled(bytes32 indexed id)',
  'event SecurityChangeFinalized(bytes32 indexed id, uint8 kind, bytes32[3] newRecords)',
  'event SecurityChangeExpired(bytes32 indexed id)',
  'error NotActive()',
  'error NotPending()',
  'error BadParams()',
  'error BadInterval()',
  'error RequestNotAccepted()',
  'error BadSignature()',
  'error DuplicateSigner()',
  'error BadSignerIndex()',
  'error QueueFull()',
  'error UnknownWithdrawal()',
  'error NotQueued()',
  'error StaleEpoch()',
  'error TooEarly()',
  'error Expired()',
  'error NotExpired()',
  'error TransferFailed()',
  'error KeyNotReady()',
  'error DuplicateKey()',
  'error Reentrancy()',
  'error VerifierChanged()',
]);

const ALL_ERRORS = [...KEY_FACTORY_ABI, ...VAULT_FACTORY_ABI, ...VAULT_ABI].filter((x) => x.type === 'error') as Abi;

/** Plain-language meaning of each contract error. */
const ERROR_TEXT: Record<string, string> = {
  BadPublicKeyLength: 'The public key has the wrong length.',
  BadHelper: 'The hashing helper contract changed. Stop and report this.',
  DegenerateKey: 'This key is too weak to register. Generate a new one.',
  AlreadyRegistered: 'This key is already registered.',
  BlobDeployFailed: 'The key data could not be stored on chain.',
  BadProofOfPossession: 'The key signature did not verify.',
  VerifierChanged: 'The verifier contract changed. Stop and report this.',
  BadInterval: 'The signed time window is invalid.',
  RequestNotAccepted: 'The signed request is outside its time window. Try again.',
  BadSetupSignature: 'The primary key signature on the vault setup did not verify.',
  AlreadyDeployed: 'A vault already exists at this address.',
  KeyNotReady: 'One of the keys is not registered yet.',
  NotActive: 'The vault is paused by a pending security change.',
  NotPending: 'There is no pending security change.',
  BadParams: 'The amount or recipient is not valid.',
  BadSignature: 'The ML-DSA-44 signature did not verify.',
  DuplicateSigner: 'The same recovery key was used twice.',
  BadSignerIndex: 'Unknown recovery key.',
  QueueFull: 'Too many withdrawals are already queued.',
  UnknownWithdrawal: 'Unknown withdrawal.',
  NotQueued: 'That withdrawal is no longer queued.',
  StaleEpoch: 'That withdrawal was invalidated by a freeze or security change.',
  TooEarly: 'The delay has not passed yet.',
  Expired: 'The window to execute has closed.',
  NotExpired: 'It has not expired yet.',
  TransferFailed: 'The transfer failed. Check the vault balance.',
  DuplicateKey: 'Each key in a vault must be different.',
  Reentrancy: 'Blocked a re-entrant call.',
};

// ------------------------------------------------------------------ reads

export async function read<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const out = await rpc<Hex>('eth_call', [{ to, data }, 'latest']);
  return decodeFunctionResult({ abi, functionName, data: out } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

export async function chainTime(): Promise<number> {
  const b = await rpc<{ timestamp: Hex; number: Hex }>('eth_getBlockByNumber', ['latest', false]);
  return Number(BigInt(b.timestamp));
}

export const balanceOf = async (a: Address) => BigInt(await rpc<Hex>('eth_getBalance', [a, 'latest']));

/** A signed request's acceptance window, from the chain's own clock (the contract allows 30 minutes at most). */
async function window(): Promise<{ validAfter: bigint; validUntil: bigint }> {
  const now = await chainTime();
  return { validAfter: BigInt(now - 60), validUntil: BigInt(now + 900) };
}

// ------------------------------------------------------------------ keys

export type QKey = { seed: Hex; publicKey: Uint8Array; secretKey: Uint8Array };

export function newSeed(): Hex {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return bytesToHex(s);
}

const keyCache = new Map<Hex, QKey>();
export function keyFromSeed(seed: Hex): QKey {
  const hit = keyCache.get(seed);
  if (hit) return hit;
  const k = ml_dsa44.keygen(hexToBytes(seed));
  const q = { seed, publicKey: k.publicKey, secretKey: k.secretKey };
  keyCache.set(seed, q);
  return q;
}

/** Pure ML-DSA-44, empty context, over the exact 32 digest bytes (whitepaper Appendix C). */
export const signDigest = (k: QKey, digest: Hex): Hex => bytesToHex(ml_dsa44.sign(hexToBytes(digest), k.secretKey));

/**
 * The key's record id. KeyFactory prepares the blob on chain; the same deterministic preparation runs
 * here only to know the blob hash in advance (it fixes the record id and the proof-of-possession message).
 */
const blobCache = new Map<Hex, Uint8Array>();
export function keyRecordOf(k: QKey) {
  let blob = blobCache.get(k.seed);
  if (!blob) {
    blob = prepareBlob(k.publicKey);
    blobCache.set(k.seed, blob);
  }
  const pk = bytesToHex(k.publicKey);
  const keyId = keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [1, pk]));
  const blobHash = keccak256(blob);
  const recordId = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [keyId, blobHash]));
  return { pk, blob: bytesToHex(blob), keyId, blobHash, recordId };
}

/** True when an address answers like a Quanlet vault. */
export async function isVault(a: Address): Promise<boolean> {
  try {
    const code = await rpc<Hex>('eth_getCode', [a, 'latest']);
    if (!code || code === '0x') return false;
    await read(a, VAULT_ABI, 'primary');
    return true;
  } catch {
    return false;
  }
}

export async function isRegistered(recordId: Hex): Promise<boolean> {
  const r = await read<{ ready: boolean }>(DEPLOYMENT.keyFactory, KEY_FACTORY_ABI, 'getRecord', [recordId]);
  return r.ready;
}

// ------------------------------------------------------------------ transactions

export type Tx = { to: Address; data: Hex; value?: bigint; label: string };
export type Receipt = { transactionHash: Hex; status: Hex; blockNumber: Hex; logs: Array<{ address: Address; topics: Hex[]; data: Hex }> };

export class ChainError extends Error {}

/** How to name a contract's custom errors in plain language (protocol 2.0 passes its own). */
export type ErrorBook = { abi: Abi; text: Record<string, string> };
const V1_ERRORS: ErrorBook = { abi: ALL_ERRORS, text: ERROR_TEXT };

function explain(e: unknown, book: ErrorBook = V1_ERRORS): string {
  const err = e as { message?: string; data?: unknown; code?: number };
  if (err?.code === 4001) return 'You rejected the transaction in your wallet.';
  const raw = typeof err?.data === 'string' ? err.data : (err?.data as { data?: string })?.data;
  if (typeof raw === 'string' && raw.startsWith('0x') && raw.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: book.abi, data: raw as Hex });
      return book.text[d.errorName] ?? d.errorName;
    } catch {
      /* fall through */
    }
  }
  const m = err?.message ?? String(e);
  const named = Object.keys(book.text).find((n) => m.includes(n));
  if (named) return book.text[named]!;
  if (/insufficient funds/i.test(m)) return 'Your wallet does not have enough testnet ETH for gas.';
  return m.length > 180 ? m.slice(0, 180) + '…' : m;
}

/** Dry-run through our RPC first so a revert shows its reason before the wallet pops up. */
async function preflight(from: Address, tx: Tx, book?: ErrorBook) {
  try {
    await rpc('eth_call', [{ from, to: tx.to, data: tx.data, value: tx.value ? '0x' + tx.value.toString(16) : undefined }, 'latest']);
  } catch (e) {
    throw new ChainError(explain(e, book));
  }
}

export async function waitReceipt(hash: Hex, timeoutMs = 180_000): Promise<Receipt> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new ChainError('The transaction is still pending. Check it on the explorer and refresh later.');
}

export async function send(provider: Eip1193, from: Address, tx: Tx, onHash?: (h: Hex) => void, book?: ErrorBook): Promise<Receipt> {
  await preflight(from, tx, book);
  // Ask the wallet itself, right before sending: never trust a cached network for a transaction that may carry ETH.
  const live = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  const liveId = typeof live === 'string' ? parseInt(live, 16) : typeof live === 'number' ? live : NaN;
  if (liveId !== TARGET_CHAIN_ID) {
    throw new ChainError(`Your wallet is not on ${NET.name} (chain ${TARGET_CHAIN_ID}). Switch networks, then try again. Nothing was sent.`);
  }
  let hash: Hex;
  try {
    hash = (await provider.request({
      method: 'eth_sendTransaction',
      // chainId lets the wallet refuse if the network changes between this check and its confirmation.
      params: [{ from, to: tx.to, data: tx.data, value: tx.value ? '0x' + tx.value.toString(16) : '0x0', chainId: '0x' + TARGET_CHAIN_ID.toString(16) }],
    })) as Hex;
  } catch (e) {
    throw new ChainError(explain(e, book));
  }
  onHash?.(hash);
  const r = await waitReceipt(hash);
  if (r.status !== '0x1') throw new ChainError('The transaction reverted on chain. Open it on the explorer for details.');
  return r;
}

export function eventsOf(r: Receipt, abi: Abi) {
  const out: Array<{ eventName: string; args: Record<string, unknown> }> = [];
  for (const l of r.logs) {
    try {
      const d = decodeEventLog({ abi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      out.push({ eventName: String(d.eventName), args: (d.args ?? {}) as unknown as Record<string, unknown> });
    } catch {
      /* not ours */
    }
  }
  return out;
}

// ------------------------------------------------------------------ protocol steps

export async function registerKeyTx(k: QKey): Promise<Tx> {
  const r = keyRecordOf(k);
  const msg = await read<Hex>(DEPLOYMENT.keyFactory, KEY_FACTORY_ABI, 'popMessage', [r.keyId, r.blobHash]);
  const pop = signDigest(k, msg);
  // Only the raw key and the proof travel: KeyFactory prepares the verifier data on chain itself.
  return { to: DEPLOYMENT.keyFactory, data: encodeFunctionData({ abi: KEY_FACTORY_ABI, functionName: 'registerKey', args: [r.pk, pop] }), label: 'Register key' };
}

export async function createVaultTx(primary: QKey, recovery: [Hex, Hex, Hex], salt: Hex): Promise<{ tx: Tx; vault: Address }> {
  const pr = keyRecordOf(primary).recordId;
  const vault = await read<Address>(DEPLOYMENT.vaultFactory, VAULT_FACTORY_ABI, 'predictAddress', [pr, recovery, salt]);
  const { validAfter, validUntil } = await window();
  const digest = await read<Hex>(DEPLOYMENT.vaultFactory, VAULT_FACTORY_ABI, 'setupDigest', [pr, recovery, salt, validAfter, validUntil]);
  const sig = signDigest(primary, digest);
  return {
    vault,
    tx: {
      to: DEPLOYMENT.vaultFactory,
      data: encodeFunctionData({ abi: VAULT_FACTORY_ABI, functionName: 'createVault', args: [pr, recovery, salt, validAfter, validUntil, sig] }),
      label: 'Create vault',
    },
  };
}

const ACTION = { SCHEDULE: 1, CANCEL: 2, INVALIDATE: 3, RECOVERY: 4, REPLACE_RECOVERY_SET: 5, CANCEL_SECURITY: 6 } as const;
const enc = (types: string[], values: unknown[]) =>
  keccak256(encodeAbiParameters(types.map((type) => ({ type })), values));

async function primaryAuth(vault: Address, k: QKey, action: number, paramsHash: Hex) {
  const nonce = await read<bigint>(vault, VAULT_ABI, 'primaryNonce');
  const { validAfter, validUntil } = await window();
  const digest = await read<Hex>(vault, VAULT_ABI, 'actionDigest', [action, nonce, paramsHash, validAfter, validUntil]);
  return { auth: { validAfter, validUntil, sig: signDigest(k, digest) }, digest };
}

async function quorumAuth(vault: Address, keys: [QKey, QKey], signers: [number, number], action: number, paramsHash: Hex) {
  const nonce = await read<bigint>(vault, VAULT_ABI, 'controlNonce');
  const { validAfter, validUntil } = await window();
  const digest = await read<Hex>(vault, VAULT_ABI, 'actionDigest', [action, nonce, paramsHash, validAfter, validUntil]);
  return { auth: { validAfter, validUntil, signers, sigs: [signDigest(keys[0], digest), signDigest(keys[1], digest)] as [Hex, Hex] }, digest };
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export async function scheduleTx(vault: Address, k: QKey, recipient: Address, amount: bigint): Promise<{ tx: Tx; id: Hex }> {
  const ph = enc(['address', 'address', 'uint256', 'address', 'uint256'], [ZERO, recipient, amount, ZERO, 0n]);
  const { auth, digest } = await primaryAuth(vault, k, ACTION.SCHEDULE, ph);
  return {
    id: digest,
    tx: { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'scheduleWithdrawal', args: [ZERO, recipient, amount, ZERO, 0n, auth] }), label: 'Schedule withdrawal' },
  };
}

export async function cancelTx(vault: Address, k: QKey, id: Hex): Promise<Tx> {
  const { auth } = await primaryAuth(vault, k, ACTION.CANCEL, enc(['bytes32'], [id]));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'cancelWithdrawal', args: [id, auth] }), label: 'Cancel withdrawal' };
}

export async function invalidateTx(vault: Address, k: QKey): Promise<Tx> {
  const epoch = await read<bigint>(vault, VAULT_ABI, 'executionEpoch');
  const { auth } = await primaryAuth(vault, k, ACTION.INVALIDATE, enc(['uint64'], [epoch]));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'invalidatePendingRequests', args: [auth] }), label: 'Freeze pending withdrawals' };
}

export const executeTx = (vault: Address, id: Hex): Tx => ({
  to: vault,
  data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'executeWithdrawal', args: [id] }),
  label: 'Execute withdrawal',
});

/** Key id of a registered record, read from the vault's own KeyFactory. */
async function keyIdOfRecord(vault: Address, recordId: Hex): Promise<Hex> {
  const kf = await read<Address>(vault, VAULT_ABI, 'keyFactory');
  const r = await read<{ keyId: Hex; ready: boolean }>(kf, KEY_FACTORY_ABI, 'getRecord', [recordId]);
  if (!r.ready) throw new ChainError('That key is not registered yet.');
  return r.keyId;
}

/**
 * Appendix C: recovery commits key identifiers. Vaults deployed before 6 Nov 2026 (no recoveryParamsHash view)
 * committed record ids instead, so those keep the old encoding.
 */
async function commitsKeyIds(vault: Address): Promise<boolean> {
  try {
    await read(vault, VAULT_ABI, 'recoveryParamsHash', ['0x' + '00'.repeat(32)]);
    return true;
  } catch {
    return false;
  }
}

async function recoveryHash(vault: Address, newPrimary: Hex): Promise<Hex> {
  if (!(await commitsKeyIds(vault))) return enc(['uint8', 'bytes32'], [1, newPrimary]);
  return enc(['uint8', 'bytes32'], [1, await keyIdOfRecord(vault, newPrimary)]);
}

async function recoverySetHash(vault: Address, newRecords: [Hex, Hex, Hex]): Promise<Hex> {
  if (!(await commitsKeyIds(vault))) return enc(['uint8', 'bytes32[3]'], [2, newRecords]);
  const ids = (await Promise.all(newRecords.map((r) => keyIdOfRecord(vault, r)))) as [Hex, Hex, Hex];
  return enc(['uint8', 'bytes32[3]'], [2, ids]);
}

export async function startRecoveryTx(vault: Address, keys: [QKey, QKey], signers: [number, number], newPrimary: Hex): Promise<Tx> {
  const { auth } = await quorumAuth(vault, keys, signers, ACTION.RECOVERY, await recoveryHash(vault, newPrimary));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'startRecovery', args: [newPrimary, auth] }), label: 'Start recovery' };
}

export async function cancelSecurityTx(vault: Address, keys: [QKey, QKey], signers: [number, number], proposalId: Hex): Promise<Tx> {
  const { auth } = await quorumAuth(vault, keys, signers, ACTION.CANCEL_SECURITY, enc(['bytes32'], [proposalId]));
  return { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'cancelSecurityChange', args: [auth] }), label: 'Cancel recovery' };
}

/** Replace all three recovery keys: the primary and two current recovery keys sign the same digest. */
export async function replaceRecoverySetTx(vault: Address, primary: QKey, keys: [QKey, QKey], signers: [number, number], newRecords: [Hex, Hex, Hex]): Promise<Tx> {
  const ph = await recoverySetHash(vault, newRecords);
  const { auth, digest } = await quorumAuth(vault, keys, signers, ACTION.REPLACE_RECOVERY_SET, ph);
  const primaryAuth = { validAfter: auth.validAfter, validUntil: auth.validUntil, sig: signDigest(primary, digest) };
  return {
    to: vault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'startRecoverySetReplacement', args: [newRecords, primaryAuth, auth] }),
    label: 'Start recovery key replacement',
  };
}

export const finalizeTx = (vault: Address): Tx => ({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'finalizeSecurityChange' }), label: 'Finalize security change' });

/** Anyone may clear a security change whose window closed without being finalized. */
export const expireTx = (vault: Address): Tx => ({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'expireSecurityChange' }), label: 'Clear expired change' });

export const depositTx = (vault: Address, value: bigint): Tx => ({ to: vault, data: '0x', value, label: 'Deposit' });

// ------------------------------------------------------------------ vault view

export type Withdrawal = {
  id: Hex;
  asset: Address;
  recipient: Address;
  amount: bigint;
  epoch: bigint;
  executableAt: bigint;
  expiresAt: bigint;
  status: number; // 0 none, 1 queued, 2 executed, 3 cancelled
};
export type VaultView = {
  balance: bigint;
  status: number; // 0 active, 1 pending security change
  executionEpoch: bigint;
  authorityEpoch: bigint;
  primaryRecord: Hex;
  primaryKeyId: Hex;
  recoveryRecords: Hex[];
  recoveryKeyIds: Hex[];
  proposal: { id: Hex; kind: number; executableAt: bigint; expiresAt: bigint; newRecords: readonly Hex[] };
  withdrawals: Withdrawal[];
  now: number;
};

export async function loadVault(vault: Address, ids: Hex[]): Promise<VaultView> {
  const [balance, status, executionEpoch, authorityEpoch, primary, recovery, proposal, now] = await Promise.all([
    balanceOf(vault),
    read<number>(vault, VAULT_ABI, 'status'),
    read<bigint>(vault, VAULT_ABI, 'executionEpoch'),
    read<bigint>(vault, VAULT_ABI, 'authorityEpoch'),
    read<{ recordId: Hex; keyId: Hex }>(vault, VAULT_ABI, 'primary'),
    read<ReadonlyArray<{ recordId: Hex; keyId: Hex }>>(vault, VAULT_ABI, 'recoveryKeys'),
    read<VaultView['proposal']>(vault, VAULT_ABI, 'proposal'),
    chainTime(),
  ]);
  const withdrawals = await Promise.all(
    ids.map(async (id) => ({ id, ...(await read<Omit<Withdrawal, 'id'>>(vault, VAULT_ABI, 'getWithdrawal', [id])) })),
  );
  return {
    balance,
    status: Number(status),
    executionEpoch,
    authorityEpoch,
    primaryRecord: primary.recordId,
    primaryKeyId: primary.keyId,
    recoveryRecords: recovery.map((r) => r.recordId),
    recoveryKeyIds: recovery.map((r) => r.keyId),
    proposal,
    withdrawals: withdrawals.map((w) => ({ ...w, status: Number(w.status) })),
    now,
  };
}
