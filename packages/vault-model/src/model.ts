/**
 * Quanlet personal-vault rules (protocol 2.0) as a pure, local simulation.
 *
 * Mirrors whitepaper v2.0: five roles (primary P, independent approver A, guardians G1-G3), FAST and
 * PROTECTED transfer routes, finite non-replenishing allowances, an optional protected timelock,
 * P/A safety actions, delayed administration, two-of-three guardian recovery of the spending pair and
 * guardian replacement (sections 07-12, Appendices A, B and E).
 *
 * It is NOT cryptography: "approvals" are policy records, not ML-DSA signatures, and digests are short
 * demo identifiers, not transaction hashes. Every action returns a new state or a refusal with a reason.
 */
import {
  ACCEPTANCE_MAX,
  ADMIN_WINDOW,
  type AssetSymbol,
  DEFAULT_PROTECTED_DELAY,
  MAX_ACTIVE_QUEUE,
  MAX_FEE_RECIPIENTS,
  MAX_GRANT,
  MAX_RECIPIENTS,
  PROTECTED_DELAYS,
  SECURITY_DELAY,
  SECURITY_WINDOW,
  WITHDRAWAL_WINDOW,
  ZERO_ADDRESS,
  delayLabel,
} from './constants';
import { isAddress, validateRecipient } from './units';

// ---------- types ----------

export type KeyId = string; // e.g. 'P1', 'A1', 'G1', 'N1'
export type Signer = KeyId | 'ORDINARY_WALLET';
export type Role = 'P' | 'A' | 'G';

export interface KeyRecord {
  id: KeyId;
  label: string;
  /** Simulated KeyFactory readiness (canonical preparation + proof of possession). */
  ready: boolean;
  /** Simulated encrypted backup + local restore-and-sign test. */
  backupChecked: boolean;
  /** Demo fingerprint shown in the UI (not a real keccak256 key id). */
  demoKeyId: string;
}

export type VaultStatus = 'active' | 'pending';
export type Route = 'fast' | 'protected';

/** Appendix A action identifiers. */
export type ActionKind =
  | 'transfer' // 1
  | 'cancel' // 2
  | 'invalidate' // 3
  | 'suspendFast' // 4
  | 'updatePolicy' // 5
  | 'replaceSpendingKeys' // 6
  | 'cancelAdmin' // 7
  | 'startRecovery' // 8
  | 'replaceGuardians' // 9
  | 'cancelRecovery'; // 10

export const ACTION_ID: Record<ActionKind, number> = {
  transfer: 1,
  cancel: 2,
  invalidate: 3,
  suspendFast: 4,
  updatePolicy: 5,
  replaceSpendingKeys: 6,
  cancelAdmin: 7,
  startRecovery: 8,
  replaceGuardians: 9,
  cancelRecovery: 10,
};

/** Appendix A nonce lanes. */
export type Lane = 'spend' | 'admin' | 'pSafety' | 'aSafety' | 'recovery';
export const LANE_ID: Record<Lane, number> = { spend: 1, admin: 2, pSafety: 3, aSafety: 4, recovery: 5 };

export interface TransferParams {
  route: Route;
  asset: AssetSymbol;
  recipient: string;
  amount: bigint;
  feeWei: bigint;
  feeRecipient: string;
}
/** Kept for older call sites: a transfer request without its route. */
export type WithdrawalParams = Omit<TransferParams, 'route'>;

export interface Approval {
  signer: Signer;
  action: ActionKind;
  lane: Lane;
  paramsHash: string;
  nonce: number;
  authorityEpoch: number;
  policyEpoch: number;
  executionEpoch: number;
  validAfter: number;
  validUntil: number;
}

/** One FAST grant rule per asset (Appendix B AssetRule). */
export interface AssetRule {
  ceiling: bigint; // absolute lifetime ceiling; available = ceiling - spent
  perActionCap: bigint;
  validAfter: number;
  validUntil: number;
  recipients: string[];
}

export interface Policy {
  protectedDelay: number;
  fastEnabled: boolean;
  /** Clears a sticky FAST suspension, only on joint authorization (Appendix B). */
  resumeFast: boolean;
  maxFastFeeWei: bigint;
  fastFeeRecipients: string[];
  rules: Partial<Record<AssetSymbol, AssetRule>>;
}

export type WithdrawalStatus = 'queued' | 'executed' | 'cancelled';

export interface Withdrawal extends WithdrawalParams {
  id: string;
  epoch: number;
  acceptedAt: number;
  executableAt: number;
  expiresAt: number;
  status: WithdrawalStatus;
  executedAt?: number;
}

export type WithdrawalView = 'waiting' | 'executable' | 'expired' | 'invalidated' | 'executed' | 'cancelled';

export type ProposalKind = 'policy' | 'spendingKeys' | 'recovery' | 'guardians';

export interface SecurityProposal {
  id: string;
  kind: ProposalKind;
  /** policy: the full replacement policy */
  policy?: Policy;
  /** spendingKeys / recovery: [newP, newA]; guardians: [G1, G2, G3] */
  newKeys?: KeyId[];
  startedAt: number;
  executableAt: number;
  expiresAt: number;
}

export interface Vault {
  label: string; // non-fundable demo label, never a real address
  P: KeyId;
  A: KeyId;
  G: [KeyId, KeyId, KeyId];
  status: VaultStatus;
  authorityEpoch: number;
  policyEpoch: number;
  executionEpoch: number;
  nonces: Record<Lane, number>;
  policy: Policy;
  fastSuspended: boolean;
  /** Lifetime FAST debit per asset. Never resets. */
  spent: Record<AssetSymbol, bigint>;
  balances: Record<AssetSymbol, bigint>;
}

export type ActivityTone = 'ok' | 'refused' | 'info' | 'warn';

export interface ActivityEvent {
  seq: number;
  at: number;
  tone: ActivityTone;
  title: string;
  detail?: string;
}

export interface DemoState {
  clock: number; // monotonic simulated seconds
  keys: Record<KeyId, KeyRecord>;
  vault: Vault | null;
  queue: Withdrawal[];
  proposal: SecurityProposal | null;
  consumedApprovals: string[];
  activity: ActivityEvent[];
  seq: number;
  /** Optional public address preview. Never authority. */
  submitterPreview: string | null;
}

export type Refusal = { ok: false; code: string; message: string; state: DemoState };
export type Accepted = { ok: true; state: DemoState; message: string };
export type Result = Accepted | Refusal;

// ---------- helpers ----------

/** Small deterministic hash (FNV-1a 32-bit, twice) for demo identifiers. Not cryptographic. */
export function demoHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

const lc = (s: string) => s.trim().toLowerCase();

export function transferParamsHash(p: TransferParams): string {
  return demoHash(['tx', p.route, p.asset, lc(p.recipient), p.amount.toString(), lc(p.feeRecipient), p.feeWei.toString()].join('|'));
}
export function policyHash(p: Policy): string {
  const rules = (Object.keys(p.rules) as AssetSymbol[])
    .sort()
    .map((a) => {
      const r = p.rules[a]!;
      return [a, r.ceiling, r.perActionCap, r.validAfter, r.validUntil, r.recipients.map(lc).sort().join(',')].join(':');
    });
  return demoHash(['policy', p.protectedDelay, p.fastEnabled, p.resumeFast, p.maxFastFeeWei, p.fastFeeRecipients.map(lc).sort().join(','), ...rules].join('|'));
}
export const keysParamsHash = (keys: KeyId[]) => demoHash('keys|' + keys.join(','));
export const idParamsHash = (tag: string, id: string) => demoHash(tag + '|' + id);
export const epochParamsHash = (tag: string, epoch: number) => demoHash(tag + '|' + epoch);

function approvalFingerprint(a: Approval): string {
  return demoHash([a.signer, a.action, a.lane, a.paramsHash, a.nonce, a.authorityEpoch, a.policyEpoch, a.executionEpoch, a.validAfter, a.validUntil].join('|'));
}

function log(state: DemoState, tone: ActivityTone, title: string, detail?: string): DemoState {
  const seq = state.seq + 1;
  return { ...state, seq, activity: [{ seq, at: state.clock, tone, title, detail }, ...state.activity].slice(0, 200) };
}

function refuse(state: DemoState, code: string, message: string, logIt = true): Refusal {
  return { ok: false, code, message, state: logIt ? log(state, 'refused', 'Refused', message) : state };
}

function accept(state: DemoState, message: string, tone: ActivityTone = 'ok', detail?: string): Accepted {
  return { ok: true, message, state: log(state, tone, message, detail) };
}

function isRefusal(x: unknown): x is Refusal {
  return typeof x === 'object' && x !== null && (x as Refusal).ok === false;
}

function requireVault(state: DemoState): Vault | Refusal {
  if (!state.vault) return refuse(state, 'NO_VAULT', 'Create the demo vault first.');
  return state.vault;
}

function patchVault(state: DemoState, patch: Partial<Vault>): DemoState {
  return state.vault ? { ...state, vault: { ...state.vault, ...patch } } : state;
}

const bump = (v: Vault, lane: Lane): Record<Lane, number> => ({ ...v.nonces, [lane]: v.nonces[lane] + 1 });

export function roleOf(v: Vault, k: Signer): Role | null {
  if (k === v.P) return 'P';
  if (k === v.A) return 'A';
  if (v.G.includes(k)) return 'G';
  return null;
}

/** The nonce lane an action uses for a given signer (Appendix A). */
export function laneFor(v: Vault | null, action: ActionKind, signer: Signer): Lane {
  if (action === 'transfer') return 'spend';
  if (action === 'cancel' || action === 'invalidate' || action === 'suspendFast') return v && signer === v.A ? 'aSafety' : 'pSafety';
  if (action === 'updatePolicy' || action === 'replaceSpendingKeys' || action === 'cancelAdmin') return 'admin';
  return 'recovery';
}

// ---------- fixture ----------

const KEY_FIXTURE: Array<[KeyId, string]> = [
  ['P1', 'Primary · phone'],
  ['A1', 'Independent approver · second device'],
  ['G1', 'Guardian 1 · offline backup'],
  ['G2', 'Guardian 2 · trusted person'],
  ['G3', 'Guardian 3 · independent custodian'],
  ['N1', 'Replacement key N1'],
  ['N2', 'Replacement key N2'],
  ['N3', 'Replacement key N3'],
  ['N4', 'Replacement key N4'],
  ['N5', 'Replacement key N5'],
];

export const SETUP_ROLES: Array<[Role, KeyId]> = [
  ['P', 'P1'],
  ['A', 'A1'],
  ['G', 'G1'],
  ['G', 'G2'],
  ['G', 'G3'],
];

export function emptyPolicy(protectedDelay: number = DEFAULT_PROTECTED_DELAY): Policy {
  return { protectedDelay, fastEnabled: false, resumeFast: false, maxFastFeeWei: 0n, fastFeeRecipients: [], rules: {} };
}

export function initialState(): DemoState {
  const keys: Record<KeyId, KeyRecord> = {};
  for (const [id, label] of KEY_FIXTURE) {
    keys[id] = { id, label, ready: false, backupChecked: false, demoKeyId: 'fp-' + demoHash('demo-key|' + id).slice(0, 12) };
  }
  return {
    clock: 0,
    keys,
    vault: null,
    queue: [],
    proposal: null,
    consumedApprovals: [],
    activity: [{ seq: 0, at: 0, tone: 'info', title: 'Demo started', detail: 'Simulated data only. Reloading the page resets it.' }],
    seq: 0,
    submitterPreview: null,
  };
}

/** A ready, funded Guarded vault: the documented sample fixture used by Reset on feature pages. */
export function fundedFixture(): DemoState {
  let s = initialState();
  for (const id of Object.keys(s.keys)) s = { ...s, keys: { ...s.keys, [id]: { ...s.keys[id]!, ready: true, backupChecked: true } } };
  let r: Result = createVault(s, { P: 'P1', A: 'A1', G: ['G1', 'G2', 'G3'] });
  if (!r.ok) throw new Error(r.message);
  r = deposit(r.state, 'ETH', 2_000_000_000_000_000_000n); // 2 ETH
  if (!r.ok) throw new Error(r.message);
  r = deposit(r.state, 'USDG', 500_000_000n); // 500 USDG
  if (!r.ok) throw new Error(r.message);
  return {
    ...r.state,
    activity: [{ seq: r.state.seq + 1, at: 0, tone: 'info', title: 'Sample vault loaded', detail: 'Guarded: P1 + A1 sign every payment, no timelock, FAST off. Guardians G1-G3. 2 ETH and 500 USDG (simulated).' }],
    seq: r.state.seq + 1,
  };
}

// ---------- clock ----------

export function advanceClock(state: DemoState, seconds: number): Result {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(seconds)) {
    return refuse(state, 'BAD_CLOCK', 'The demo clock only moves forward by whole seconds.', false);
  }
  return accept({ ...state, clock: state.clock + seconds }, `Demo clock advanced by ${formatDuration(seconds)}`, 'info');
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s % 60}s`);
  return parts.join(' ');
}

// ---------- setup ----------

export function prepareKey(state: DemoState, id: KeyId): Result {
  const k = state.keys[id];
  if (!k) return refuse(state, 'UNKNOWN_KEY', `Unknown key ${id}.`);
  if (k.ready) return refuse(state, 'ALREADY_READY', `${id} is already ready.`, false);
  return accept({ ...state, keys: { ...state.keys, [id]: { ...k, ready: true } } }, `${id} registered and activated (simulated)`);
}

export function checkBackup(state: DemoState, id: KeyId): Result {
  const k = state.keys[id];
  if (!k) return refuse(state, 'UNKNOWN_KEY', `Unknown key ${id}.`);
  if (!k.ready) return refuse(state, 'NOT_READY', `Register ${id} before checking its backup.`);
  if (k.backupChecked) return refuse(state, 'ALREADY_CHECKED', `${id} backup already checked.`, false);
  return accept({ ...state, keys: { ...state.keys, [id]: { ...k, backupChecked: true } } }, `${id} backup restored and test-signed (simulated)`);
}

/**
 * Atomic setup (section 06, Appendix E): five distinct activated keys, each consenting to the same setup
 * digest. Default policy: no protected delay, FAST disabled.
 */
export function createVault(
  state: DemoState,
  cfg: { P: KeyId; A: KeyId; G: [KeyId, KeyId, KeyId]; protectedDelay?: number },
  consents?: KeyId[],
): Result {
  if (state.vault) return refuse(state, 'VAULT_EXISTS', 'A demo vault already exists. Reset to start over.');
  const ids = [cfg.P, cfg.A, ...cfg.G];
  if (new Set(ids).size !== 5) return refuse(state, 'DUPLICATE_KEYS', 'All five keys (P, A, G1, G2, G3) must be distinct.');
  for (const id of ids) {
    const k = state.keys[id];
    if (!k) return refuse(state, 'UNKNOWN_KEY', `Unknown key ${id}.`);
    if (!k.ready) return refuse(state, 'KEY_NOT_READY', `${id} is not registered and activated.`);
    if (!k.backupChecked) return refuse(state, 'BACKUP_UNCHECKED', `${id} backup and restore test is not done.`);
  }
  const signed = consents ?? ids;
  const missing = ids.filter((id) => !signed.includes(id));
  if (missing.length) return refuse(state, 'MISSING_CONSENT', `All five keys must sign the setup. Missing: ${missing.join(', ')}.`);
  const delay = cfg.protectedDelay ?? DEFAULT_PROTECTED_DELAY;
  if (!(PROTECTED_DELAYS as readonly number[]).includes(delay)) return refuse(state, 'BAD_DELAY', 'The protected delay must be 0, 1, 24 or 72 hours.');
  const vault: Vault = {
    label: 'demo-vault-' + demoHash(ids.join('|')).slice(0, 8),
    P: cfg.P,
    A: cfg.A,
    G: cfg.G,
    status: 'active',
    authorityEpoch: 1,
    policyEpoch: 1,
    executionEpoch: 1,
    nonces: { spend: 0, admin: 0, pSafety: 0, aSafety: 0, recovery: 0 },
    policy: emptyPolicy(delay),
    fastSuspended: false,
    spent: { ETH: 0n, USDG: 0n },
    balances: { ETH: 0n, USDG: 0n },
  };
  return accept(
    { ...state, vault },
    'Demo vault created',
    'ok',
    `P ${cfg.P}, A ${cfg.A}, guardians ${cfg.G.join(', ')}. Protected delay: ${delayLabel(delay)}. FAST disabled.`,
  );
}

export function deposit(state: DemoState, asset: AssetSymbol, amount: bigint): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  if (amount <= 0n) return refuse(state, 'BAD_AMOUNT', 'Deposit must be a positive amount.');
  const next = patchVault(state, { balances: { ...v.balances, [asset]: v.balances[asset] + amount } });
  const warn = v.status === 'pending';
  return accept(
    next,
    `Sample deposit added (${asset})`,
    warn ? 'warn' : 'ok',
    warn ? 'A security change is pending. Do not fund a vault under an unexpected recovery attempt. Deposits never refill a FAST allowance.' : undefined,
  );
}

export function setSubmitterPreview(state: DemoState, address: string | null): DemoState {
  return { ...state, submitterPreview: address };
}

// ---------- approvals (simulated signing) ----------

export function makeApproval(state: DemoState, signer: Signer, action: ActionKind, paramsHash: string, opts: { nonceOverride?: number; validFor?: number } = {}): Approval {
  const v = state.vault;
  const lane = laneFor(v, action, signer);
  const recovery = lane === 'recovery';
  return {
    signer,
    action,
    lane,
    paramsHash,
    nonce: opts.nonceOverride ?? (v ? v.nonces[lane] : 0),
    authorityEpoch: v?.authorityEpoch ?? 1,
    // Recovery approvals bind authority only, so spending-side epoch churn cannot void them (section 09).
    policyEpoch: recovery ? 0 : (v?.policyEpoch ?? 1),
    executionEpoch: recovery ? 0 : (v?.executionEpoch ?? 1),
    validAfter: state.clock,
    validUntil: state.clock + (opts.validFor ?? ACCEPTANCE_MAX),
  };
}

/** Freshness, lane, nonce, epochs and replay for one approval (section 09, Appendix A). */
function checkFrame(state: DemoState, v: Vault, a: Approval, action: ActionKind, paramsHash: string, lane: Lane): Refusal | null {
  if (a.action !== action) return refuse(state, 'WRONG_ACTION', 'This approval was signed for a different action.');
  if (a.lane !== lane) return refuse(state, 'WRONG_LANE', 'This approval uses the wrong nonce lane for its signer.');
  if (a.paramsHash !== paramsHash) return refuse(state, 'PARAMS_CHANGED', 'The request differs from what was approved. Fresh approvals are required.');
  if (state.consumedApprovals.includes(approvalFingerprint(a))) return refuse(state, 'REPLAY', 'This approval was already used. Each approval works once.');
  if (a.nonce !== v.nonces[lane]) return refuse(state, 'BAD_NONCE', `Approval nonce ${a.nonce} is not the next ${lane} nonce (${v.nonces[lane]}).`);
  if (a.authorityEpoch !== v.authorityEpoch) return refuse(state, 'STALE_AUTHORITY', 'Approval was made under an older key configuration.');
  if (lane === 'recovery') {
    if (a.policyEpoch !== 0 || a.executionEpoch !== 0) return refuse(state, 'BAD_EPOCH', 'Recovery approvals must leave the policy and execution epochs at zero.');
  } else {
    if (a.policyEpoch !== v.policyEpoch) return refuse(state, 'STALE_POLICY', `Approval is for policy epoch ${a.policyEpoch}; the vault is at ${v.policyEpoch}.`);
    if (a.executionEpoch !== v.executionEpoch) return refuse(state, 'STALE_EPOCH', `Approval is for execution epoch ${a.executionEpoch}; the vault is at ${v.executionEpoch}.`);
  }
  const span = a.validUntil - a.validAfter;
  if (span <= 0 || span > ACCEPTANCE_MAX) return refuse(state, 'BAD_INTERVAL', 'A signed acceptance interval must be longer than zero and at most 30 minutes.');
  if (state.clock < a.validAfter) return refuse(state, 'NOT_YET_VALID', 'Approval is not valid yet.');
  if (state.clock >= a.validUntil) return refuse(state, 'ACCEPTANCE_EXPIRED', 'Approval expired before it was submitted (30-minute acceptance window).');
  return null;
}

/** All required signers must sign identical bytes: same nonce, epochs and interval. */
function sameDigest(as: Approval[]): boolean {
  const f = (a: Approval) => [a.action, a.lane, a.paramsHash, a.nonce, a.authorityEpoch, a.policyEpoch, a.executionEpoch, a.validAfter, a.validUntil].join('|');
  return as.every((a) => f(a) === f(as[0]!));
}

function consume(state: DemoState, approvals: Approval[]): DemoState {
  return { ...state, consumedApprovals: [...state.consumedApprovals, ...approvals.map(approvalFingerprint)] };
}

function noOrdinary(state: DemoState, approvals: Approval[], what: string): Refusal | null {
  if (approvals.some((a) => a.signer === 'ORDINARY_WALLET')) {
    return refuse(state, 'ORDINARY_KEY', `Ordinary wallet key: it has no authority over this vault. ${what}`);
  }
  return null;
}

/** Exactly the current P and A, distinct, over the same digest. */
function requirePair(state: DemoState, v: Vault, approvals: Approval[], what: string): Refusal | null {
  const ord = noOrdinary(state, approvals, `${what} needs the primary and the independent approver.`);
  if (ord) return ord;
  const signers = approvals.map((a) => a.signer);
  if (new Set(signers).size !== signers.length) return refuse(state, 'DUPLICATE_SIGNER', 'The same key was counted twice. Duplicate signatures never count as two approvals.');
  const hasP = signers.includes(v.P);
  const hasA = signers.includes(v.A);
  const others = signers.filter((s) => s !== v.P && s !== v.A);
  if (others.length) return refuse(state, 'WRONG_ROLE', `${others.join(', ')} is not a current spending key. ${what} needs ${v.P} (P) and ${v.A} (A).`);
  if (hasP && !hasA) return refuse(state, 'APPROVER_REQUIRED', `${what} needs the independent approver ${v.A} as well as the primary. Waiting never substitutes for a missing signature.`);
  if (!hasP && hasA) return refuse(state, 'PRIMARY_REQUIRED', `${what} needs the primary ${v.P} as well as the approver.`);
  if (!hasP && !hasA) return refuse(state, 'NO_SIGNATURES', `${what} needs ${v.P} (P) and ${v.A} (A).`);
  if (!sameDigest(approvals)) return refuse(state, 'DIGEST_MISMATCH', 'Both keys must sign the identical request.');
  return null;
}

/** Two distinct current guardians, and only guardians. */
function requireGuardians(state: DemoState, v: Vault, approvals: Approval[], what: string): Refusal | null {
  const ord = noOrdinary(state, approvals, `${what} needs two current guardians.`);
  if (ord) return ord;
  const g = approvals.map((a) => a.signer);
  const outsider = g.find((s) => !v.G.includes(s));
  if (outsider) {
    if (outsider === v.P || outsider === v.A) return refuse(state, 'SPENDING_KEY_NOT_GUARDIAN', `${outsider} is a spending key, not a guardian. ${what} needs two of ${v.G.join(', ')}.`);
    return refuse(state, 'NOT_GUARDIAN', `${outsider} is not one of the current guardians.`);
  }
  if (new Set(g).size !== g.length) return refuse(state, 'DUPLICATE_SIGNER', 'The same guardian was counted twice. Two distinct guardians are required.');
  if (g.length < 2) return refuse(state, 'INSUFFICIENT_SIGNERS', `${what} needs two distinct current guardians.`);
  if (g.length > 2) return refuse(state, 'UNEXPECTED_SIGNATURES', 'Exactly two guardian signatures are expected.');
  if (!sameDigest(approvals)) return refuse(state, 'DIGEST_MISMATCH', 'Both guardians must sign the identical request.');
  return null;
}

/** A new key must be registered, activated and distinct from every role it would sit beside. */
function checkNewKeys(state: DemoState, ids: KeyId[], mustAvoid: KeyId[], consents: KeyId[] | undefined): Refusal | null {
  if (new Set(ids).size !== ids.length) return refuse(state, 'DUPLICATE_KEYS', 'New keys must be distinct from each other.');
  for (const id of ids) {
    const k = state.keys[id];
    if (!k) return refuse(state, 'UNKNOWN_KEY', `Unknown key ${id}.`);
    if (!k.ready) return refuse(state, 'KEY_NOT_READY', `${id} is not registered and activated.`);
    if (mustAvoid.includes(id)) return refuse(state, 'KEY_CONFLICT', `${id} already holds a role. All five roles must stay distinct.`);
  }
  const c = consents ?? ids;
  const missing = ids.filter((id) => !c.includes(id));
  if (missing.length) return refuse(state, 'MISSING_CONSENT', `Each new key must consent to the exact action. Missing: ${missing.join(', ')}.`);
  return null;
}

// ---------- policy and allowances ----------

export function validatePolicy(v: Vault, p: Policy, now: number): string | null {
  if (!(PROTECTED_DELAYS as readonly number[]).includes(p.protectedDelay)) return 'The protected delay must be 0, 1, 24 or 72 hours.';
  if (p.maxFastFeeWei < 0n) return 'The FAST fee cap cannot be negative.';
  if (p.fastFeeRecipients.length > MAX_FEE_RECIPIENTS) return `At most ${MAX_FEE_RECIPIENTS} FAST fee recipients.`;
  if (p.fastFeeRecipients.some((r) => validateRecipient(r))) return 'Every FAST fee recipient must be a full, nonzero address.';
  for (const [asset, r] of Object.entries(p.rules) as Array<[AssetSymbol, AssetRule]>) {
    if (!r.recipients.length) return `${asset}: a grant needs at least one approved recipient.`;
    if (r.recipients.length > MAX_RECIPIENTS) return `${asset}: at most ${MAX_RECIPIENTS} recipients.`;
    if (r.recipients.some((x) => validateRecipient(x))) return `${asset}: every recipient must be a full, nonzero address.`;
    if (new Set(r.recipients.map(lc)).size !== r.recipients.length) return `${asset}: recipients must be unique.`;
    if (r.perActionCap <= 0n) return `${asset}: the per-action cap must be positive.`;
    if (r.ceiling < v.spent[asset]) return `${asset}: the ceiling cannot be below the lifetime FAST debit already spent.`;
    const span = r.validUntil - r.validAfter;
    if (span <= 0 || span > MAX_GRANT) return `${asset}: a grant lasts more than zero and at most 30 days.`;
    if (r.validUntil > now + MAX_GRANT) return `${asset}: a grant can end at most 30 days after acceptance.`;
  }
  return null;
}

/**
 * Build a policy that grants B new units on top of the lifetime debit (section 08): the signed absolute
 * ceiling is spent + B at approval time. Other assets keep their current rules.
 */
export function grantPolicy(
  v: Vault,
  now: number,
  g: { asset: AssetSymbol; amount: bigint; perActionCap: bigint; days: number; recipients: string[]; maxFastFeeWei?: bigint; feeRecipients?: string[] },
): Policy {
  const rules = { ...v.policy.rules };
  rules[g.asset] = {
    ceiling: v.spent[g.asset] + g.amount,
    perActionCap: g.perActionCap,
    validAfter: now,
    validUntil: now + Math.round(g.days * 86_400),
    recipients: g.recipients,
  };
  return {
    ...v.policy,
    fastEnabled: true,
    resumeFast: true,
    maxFastFeeWei: g.maxFastFeeWei ?? v.policy.maxFastFeeWei,
    fastFeeRecipients: g.feeRecipients ?? v.policy.fastFeeRecipients,
    rules,
  };
}

export function available(v: Vault, asset: AssetSymbol): bigint {
  const r = v.policy.rules[asset];
  if (!r) return 0n;
  const a = r.ceiling - v.spent[asset];
  return a > 0n ? a : 0n;
}

export type FastState = 'disabled' | 'suspended' | 'active';
export function fastState(v: Vault): FastState {
  if (!v.policy.fastEnabled) return 'disabled';
  if (v.fastSuspended) return 'suspended';
  return 'active';
}

function installPolicy(v: Vault, p: Policy): Partial<Vault> {
  const policy: Policy = { ...p, resumeFast: false };
  return {
    policy,
    // resumeFast clears sticky suspension, but cannot override fastEnabled=false (Appendix B).
    fastSuspended: p.resumeFast && p.fastEnabled ? false : v.fastSuspended,
    policyEpoch: v.policyEpoch + 1,
    executionEpoch: v.executionEpoch + 1,
  };
}

// ---------- transfers ----------

export function validateTransfer(p: TransferParams): string | null {
  const r = validateRecipient(p.recipient);
  if (r) return r;
  if (p.amount <= 0n) return 'Amount must be greater than zero.';
  if (p.feeWei < 0n) return 'Fee cannot be negative.';
  const feeToZero = lc(p.feeRecipient) === ZERO_ADDRESS || p.feeRecipient.trim() === '';
  if (p.feeWei > 0n && feeToZero) return 'A nonzero fee needs a fee recipient address.';
  if (p.feeWei > 0n && !isAddress(p.feeRecipient)) return 'Fee recipient must be a full 0x address.';
  if (p.feeWei === 0n && !feeToZero) return 'A zero fee must have no fee recipient.';
  return null;
}
/** v1 name kept for callers that validate the parameters without a route. */
export const validateWithdrawalParams = (p: WithdrawalParams) => validateTransfer({ ...p, route: 'protected' });

export function activeQueue(state: DemoState): Withdrawal[] {
  const v = state.vault;
  if (!v) return [];
  return state.queue.filter((w) => w.status === 'queued' && w.epoch === v.executionEpoch && state.clock < w.expiresAt);
}

export function withdrawalView(state: DemoState, w: Withdrawal): WithdrawalView {
  if (w.status === 'executed') return 'executed';
  if (w.status === 'cancelled') return 'cancelled';
  if (!state.vault || w.epoch !== state.vault.executionEpoch) return 'invalidated';
  if (state.clock >= w.expiresAt) return 'expired';
  if (state.clock >= w.executableAt) return 'executable';
  return 'waiting';
}

function moveFunds(v: Vault, p: WithdrawalParams): Record<AssetSymbol, bigint> | string {
  const ethNeeded = (p.asset === 'ETH' ? p.amount : 0n) + p.feeWei;
  if (p.asset !== 'ETH' && v.balances[p.asset] < p.amount) return `Insufficient ${p.asset} balance. Nothing moved.`;
  if (v.balances.ETH < ethNeeded) return 'Insufficient ETH for the amount and fee. Nothing moved.';
  const b = { ...v.balances };
  b.ETH -= ethNeeded;
  if (p.asset !== 'ETH') b[p.asset] -= p.amount;
  return b;
}

/**
 * Submit a transfer (Appendix C submitTransfer). FAST: the primary alone, inside a finite allowance, executes
 * immediately or is rejected. PROTECTED: the primary and approver sign the identical request; it executes
 * immediately with delay 0, or is queued for the elected delay.
 */
export function submitTransfer(state: DemoState, p: TransferParams, approvals: Approval[], opts: { forceTransferFailure?: boolean } = {}): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  if (!approvals.length) return refuse(state, 'NO_SIGNATURES', 'A transfer needs at least one valid post-quantum signature.');
  const ord = noOrdinary(state, approvals, p.route === 'fast' ? 'A FAST payment needs the primary key.' : 'A protected payment needs the primary and the independent approver.');
  if (ord) return ord;
  if (v.status !== 'active') return refuse(state, 'FROZEN', 'A security change is pending. Every outflow and vault-paid fee is blocked.');
  const bad = validateTransfer(p);
  if (bad) return refuse(state, 'BAD_PARAMS', bad);
  const ph = transferParamsHash(p);

  if (p.route === 'fast') {
    if (approvals.length !== 1) return refuse(state, 'UNEXPECTED_SIGNATURES', 'A FAST payment carries exactly one signature: the primary.');
    const a = approvals[0]!;
    if (a.signer !== v.P) {
      if (a.signer === v.A) return refuse(state, 'WRONG_ROLE', 'The approver cannot spend alone. FAST payments are signed by the primary.');
      return refuse(state, 'WRONG_ROLE', `${a.signer} is not the current primary (${v.P}).`);
    }
    const fe = checkFrame(state, v, a, 'transfer', ph, 'spend');
    if (fe) return fe;
    const fs = fastState(v);
    if (fs === 'disabled') return refuse(state, 'FAST_DISABLED', 'FAST is disabled. Use the protected route with the approver, or grant a finite allowance with both keys.');
    if (fs === 'suspended') return refuse(state, 'FAST_SUSPENDED', 'FAST is suspended. Only a joint P + A policy request can resume it.');
    const rule = v.policy.rules[p.asset];
    if (!rule) return refuse(state, 'NO_ALLOWANCE', `No FAST allowance exists for ${p.asset}.`);
    if (state.clock < rule.validAfter || state.clock >= rule.validUntil) return refuse(state, 'ALLOWANCE_EXPIRED', `The ${p.asset} allowance is outside its validity window. Renewal needs both spending keys.`);
    if (!rule.recipients.map(lc).includes(lc(p.recipient))) return refuse(state, 'RECIPIENT_NOT_APPROVED', 'This recipient is not on the allowance. New destinations need the protected route with both keys.');
    // Debits (section 08): ETH debit = ETH amount + fee; ERC-20 debit = token amount, plus a separate ETH fee debit.
    const debits: Partial<Record<AssetSymbol, bigint>> = {};
    if (p.asset === 'ETH') debits.ETH = p.amount + p.feeWei;
    else {
      debits[p.asset] = p.amount;
      if (p.feeWei > 0n) debits.ETH = p.feeWei;
    }
    if (p.feeWei > 0n) {
      if (p.feeWei > v.policy.maxFastFeeWei) return refuse(state, 'FEE_CAP', 'The relay fee is above the FAST fee cap.');
      if (!v.policy.fastFeeRecipients.map(lc).includes(lc(p.feeRecipient))) return refuse(state, 'FEE_RECIPIENT_NOT_APPROVED', 'The fee recipient is not on the FAST fee-recipient list.');
      const ethRule = v.policy.rules.ETH;
      if (!ethRule || state.clock < ethRule.validAfter || state.clock >= ethRule.validUntil) return refuse(state, 'NO_FEE_BUDGET', 'A FAST fee needs an enabled, unexpired ETH allowance.');
    }
    for (const [asset, d] of Object.entries(debits) as Array<[AssetSymbol, bigint]>) {
      if (d === 0n) continue;
      const r = v.policy.rules[asset]!;
      if (d > r.perActionCap) return refuse(state, 'PER_ACTION_CAP', `This needs ${d} base units of ${asset}, above the per-action cap. Split payments never create more allowance.`);
      if (d > available(v, asset)) return refuse(state, 'ALLOWANCE_EXCEEDED', `Not enough ${asset} allowance left. It never refills: renewal needs both spending keys, and waiting does not help.`);
    }
    if (opts.forceTransferFailure) return refuse(state, 'TRANSFER_FAILED', 'Simulated transfer failure: the whole transaction reverted. No funds, fee, nonce or allowance were used.');
    const balances = moveFunds(v, p);
    if (typeof balances === 'string') return refuse(state, 'INSUFFICIENT', balances);
    const spent = { ...v.spent };
    for (const [asset, d] of Object.entries(debits) as Array<[AssetSymbol, bigint]>) spent[asset] += d;
    let next = consume(state, [a]);
    next = patchVault(next, { balances, spent, nonces: bump(v, 'spend') });
    return accept(next, 'FAST payment executed', 'ok', 'Primary only, inside the finite allowance. No Quanlet delay; the allowance is now lower and never refills by itself.');
  }

  // PROTECTED
  const pair = requirePair(state, v, approvals, 'A protected payment');
  if (pair) return pair;
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'transfer', ph, 'spend');
    if (fe) return fe;
  }
  if (v.policy.protectedDelay === 0) {
    if (opts.forceTransferFailure) return refuse(state, 'TRANSFER_FAILED', 'Simulated transfer failure: the whole transaction reverted. No funds, fee or nonce were used.');
    const balances = moveFunds(v, p);
    if (typeof balances === 'string') return refuse(state, 'INSUFFICIENT', balances);
    let next = consume(state, approvals);
    next = patchVault(next, { balances, nonces: bump(v, 'spend') });
    return accept(next, 'Protected payment executed', 'ok', 'Primary and approver signed the same request. No timelock is elected, so it executed in the submitting transaction.');
  }
  if (activeQueue(state).length >= MAX_ACTIVE_QUEUE) return refuse(state, 'QUEUE_FULL', `The queue already holds ${MAX_ACTIVE_QUEUE} live entries in this epoch.`);
  const id = 'wd-' + demoHash(approvals.map(approvalFingerprint).join('|')).slice(0, 10);
  const { route: _route, ...params } = p;
  const w: Withdrawal = {
    ...params,
    id,
    epoch: v.executionEpoch,
    acceptedAt: state.clock,
    executableAt: state.clock + v.policy.protectedDelay,
    expiresAt: state.clock + v.policy.protectedDelay + WITHDRAWAL_WINDOW,
    status: 'queued',
  };
  let next = consume(state, approvals);
  next = patchVault(next, { nonces: bump(v, 'spend') });
  next = { ...next, queue: [w, ...next.queue] };
  return accept(next, `Protected payment ${id} queued`, 'ok', `Executable after the elected ${delayLabel(v.policy.protectedDelay)} delay. No balance moved and no fee paid yet.`);
}

export function executeWithdrawal(state: DemoState, id: string, opts: { forceTransferFailure?: boolean } = {}): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const w = state.queue.find((x) => x.id === id);
  if (!w) return refuse(state, 'NO_ENTRY', `No withdrawal ${id}.`);
  if (v.status !== 'active') return refuse(state, 'FROZEN', 'A security change is pending. All outflows are frozen.');
  switch (withdrawalView(state, w)) {
    case 'executed':
      return refuse(state, 'ALREADY_EXECUTED', 'Already executed. An entry can run only once.');
    case 'cancelled':
      return refuse(state, 'CANCELLED', 'This withdrawal was cancelled.');
    case 'invalidated':
      return refuse(state, 'INVALIDATED', 'This withdrawal is from an old execution epoch and can never run.');
    case 'expired':
      return refuse(state, 'EXPIRED', 'The 7-day execution window has closed. Sign and submit again.');
    case 'waiting':
      return refuse(state, 'TOO_EARLY', `Not executable yet. ${formatDuration(w.executableAt - state.clock)} left in the elected delay.`);
    case 'executable':
      break;
  }
  if (opts.forceTransferFailure) return refuse(state, 'TRANSFER_FAILED', 'Simulated transfer failure: the whole execution reverted. No balance or fee moved; the entry can be retried.');
  const balances = moveFunds(v, w);
  if (typeof balances === 'string') return refuse(state, 'INSUFFICIENT', balances + ' Retry within the window.');
  let next = patchVault(state, { balances });
  next = { ...next, queue: next.queue.map((x) => (x.id === id ? { ...x, status: 'executed' as const, executedAt: state.clock } : x)) };
  return accept(next, `Withdrawal ${id} executed`, 'ok', 'Exact amount and fee transferred once (simulated). Anyone may submit execution.');
}

// ---------- safety actions (P or A alone) ----------

function safetySigner(state: DemoState, v: Vault, a: Approval, what: string): Refusal | null {
  const ord = noOrdinary(state, [a], `${what} needs the primary or the approver.`);
  if (ord) return ord;
  if (a.signer !== v.P && a.signer !== v.A) return refuse(state, 'WRONG_ROLE', `${what} needs the primary (${v.P}) or the approver (${v.A}).`);
  if (v.status !== 'active') return refuse(state, 'NOT_ACTIVE', 'A security change is pending; outflows are already blocked.');
  return null;
}

export function cancelWithdrawal(state: DemoState, id: string, a: Approval): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const s = safetySigner(state, v, a, 'Cancelling a queued withdrawal');
  if (s) return s;
  const w = state.queue.find((x) => x.id === id);
  if (!w) return refuse(state, 'NO_ENTRY', `No withdrawal ${id}.`);
  const view = withdrawalView(state, w);
  if (view === 'executed') return refuse(state, 'ALREADY_EXECUTED', 'This withdrawal already executed and cannot be cancelled.');
  if (view === 'cancelled') return refuse(state, 'ALREADY_CANCELLED', 'This withdrawal is already cancelled.');
  if (view === 'invalidated') return refuse(state, 'INVALIDATED', 'This withdrawal belongs to an old epoch and is already unusable.');
  const lane = laneFor(v, 'cancel', a.signer);
  const fe = checkFrame(state, v, a, 'cancel', idParamsHash('cancel', id), lane);
  if (fe) return fe;
  let next = consume(state, [a]);
  next = patchVault(next, { nonces: bump(v, lane) });
  next = { ...next, queue: next.queue.map((x) => (x.id === id ? { ...x, status: 'cancelled' as const } : x)) };
  return accept(next, `Withdrawal ${id} cancelled by ${a.signer === v.P ? 'P' : 'A'}`, 'ok', 'No platform fee. A real submission still pays network gas, and must land before execution.');
}

export function invalidateSpending(state: DemoState, a: Approval): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const s = safetySigner(state, v, a, 'Invalidating spending approvals');
  if (s) return s;
  const lane = laneFor(v, 'invalidate', a.signer);
  const fe = checkFrame(state, v, a, 'invalidate', epochParamsHash('invalidate', v.executionEpoch), lane);
  if (fe) return fe;
  let next = consume(state, [a]);
  next = patchVault(next, { nonces: bump(v, lane), executionEpoch: v.executionEpoch + 1 });
  return accept(next, `Execution epoch advanced to ${v.executionEpoch + 1}`, 'ok', 'Every queued withdrawal and unsubmitted spending approval is void. Lifetime FAST debit is unchanged.');
}
/** v1 name kept for callers. */
export const invalidatePending = invalidateSpending;

export function suspendFast(state: DemoState, a: Approval): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const s = safetySigner(state, v, a, 'Suspending FAST');
  if (s) return s;
  const lane = laneFor(v, 'suspendFast', a.signer);
  const fe = checkFrame(state, v, a, 'suspendFast', epochParamsHash('suspend', v.executionEpoch), lane);
  if (fe) return fe;
  let next = consume(state, [a]);
  next = patchVault(next, { nonces: bump(v, lane), fastSuspended: true, executionEpoch: v.executionEpoch + 1 });
  return accept(next, 'FAST suspended', 'warn', 'Primary-only payments stop until P and A jointly resume them. Spending approvals were invalidated too.');
}

// ---------- administration (P + A, governed by the current delay) ----------

function startOrApplyAdmin(state: DemoState, v: Vault, kind: 'policy' | 'spendingKeys', approvals: Approval[], payload: { policy?: Policy; newKeys?: KeyId[] }, what: string): Result {
  let next = consume(state, approvals);
  const nonces = bump(v, 'admin');
  const delay = v.policy.protectedDelay;
  if (delay === 0) {
    if (kind === 'policy') next = patchVault(next, { ...installPolicy(v, payload.policy!), nonces });
    else next = patchVault(next, { P: payload.newKeys![0]!, A: payload.newKeys![1]!, authorityEpoch: v.authorityEpoch + 1, executionEpoch: v.executionEpoch + 1, nonces });
    return accept(next, `${what} applied`, 'ok', 'No protected delay is elected, so the joint request applied atomically.');
  }
  const proposal: SecurityProposal = {
    id: 'sp-' + demoHash(approvals.map(approvalFingerprint).join('|')).slice(0, 10),
    kind,
    ...payload,
    startedAt: state.clock,
    executableAt: state.clock + delay,
    expiresAt: state.clock + delay + ADMIN_WINDOW,
  };
  next = patchVault(next, { status: 'pending', executionEpoch: v.executionEpoch + 1, nonces });
  next = { ...next, proposal };
  return accept(next, `${what} queued behind the current ${delayLabel(delay)} delay`, 'warn', 'Outflows are frozen until it is finalized, cancelled or expired. The current policy and keys stay installed meanwhile.');
}

export function updatePolicy(state: DemoState, policy: Policy, approvals: Approval[]): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  if (v.status !== 'active') return refuse(state, 'NOT_ACTIVE', 'A security change is pending. Policy changes wait until it resolves.');
  const pair = requirePair(state, v, approvals, 'A policy change');
  if (pair) return pair;
  const bad = validatePolicy(v, policy, state.clock);
  if (bad) return refuse(state, 'BAD_POLICY', bad);
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'updatePolicy', policyHash(policy), 'admin');
    if (fe) return fe;
  }
  return startOrApplyAdmin(state, v, 'policy', approvals, { policy }, 'Policy change');
}

export function replaceSpendingKeys(state: DemoState, newP: KeyId, newA: KeyId, approvals: Approval[], consents?: KeyId[]): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  if (v.status !== 'active') return refuse(state, 'NOT_ACTIVE', 'A security change is pending.');
  const pair = requirePair(state, v, approvals, 'Rotating spending keys');
  if (pair) return pair;
  if (newP === v.A && newA === v.P) return refuse(state, 'SWAP_NOT_ROTATION', 'Swapping P and A is not a valid rotation.');
  if (newP === newA) return refuse(state, 'DUPLICATE_KEYS', 'A key cannot be both primary and approver.');
  const introduced = [newP, newA].filter((k) => k !== v.P && k !== v.A);
  if (!introduced.length) return refuse(state, 'NO_CHANGE', 'Nothing to rotate.');
  const retained = [newP, newA].filter((k) => k === v.P || k === v.A);
  if (retained.some((k) => (k === v.P ? newP !== v.P : newA !== v.A))) return refuse(state, 'SWAP_NOT_ROTATION', 'A retained key must keep its role.');
  const nk = checkNewKeys(state, introduced, [...v.G, v.P, v.A], consents);
  if (nk) return nk;
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'replaceSpendingKeys', keysParamsHash([newP, newA]), 'admin');
    if (fe) return fe;
  }
  return startOrApplyAdmin(state, v, 'spendingKeys', approvals, { newKeys: [newP, newA] }, 'Spending-key rotation');
}

export function cancelAdminChange(state: DemoState, approvals: Approval[]): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const p = state.proposal;
  if (!p || (p.kind !== 'policy' && p.kind !== 'spendingKeys')) return refuse(state, 'NO_PROPOSAL', 'No pending policy or spending-key change.');
  const pair = requirePair(state, v, approvals, 'Cancelling an administrative change');
  if (pair) return pair;
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'cancelAdmin', idParamsHash('cancel-admin', p.id), 'admin');
    if (fe) return fe;
  }
  let next = consume(state, approvals);
  next = patchVault(next, { status: 'active', nonces: bump(v, 'admin'), executionEpoch: v.executionEpoch + 1 });
  next = { ...next, proposal: null };
  return accept(next, 'Administrative change cancelled', 'ok', 'Old configuration continues. Approvals made during the freeze stay invalid.');
}

// ---------- recovery and guardian replacement ----------

export function startRecovery(state: DemoState, newPair: [KeyId, KeyId], approvals: Approval[], consents?: KeyId[]): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  if (state.proposal?.kind === 'recovery') return refuse(state, 'PROPOSAL_EXISTS', 'A recovery is already live. It cannot be displaced.');
  const q = requireGuardians(state, v, approvals, 'Recovery');
  if (q) return q;
  const [nP, nA] = newPair;
  if (nP === nA) return refuse(state, 'DUPLICATE_KEYS', 'The new primary and new approver must be different keys.');
  const nk = checkNewKeys(state, [nP, nA], [v.P, v.A, ...v.G], consents);
  if (nk) return nk;
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'startRecovery', keysParamsHash([nP, nA]), 'recovery');
    if (fe) return fe;
  }
  const superseded = state.proposal;
  const proposal: SecurityProposal = {
    id: 'rp-' + demoHash(approvals.map(approvalFingerprint).join('|')).slice(0, 10),
    kind: 'recovery',
    newKeys: [nP, nA],
    startedAt: state.clock,
    executableAt: state.clock + SECURITY_DELAY,
    expiresAt: state.clock + SECURITY_DELAY + SECURITY_WINDOW,
  };
  let next = consume(state, approvals);
  next = patchVault(next, { status: 'pending', fastSuspended: true, executionEpoch: v.executionEpoch + 1, nonces: bump(v, 'recovery') });
  next = { ...next, proposal };
  return accept(
    next,
    'Recovery started',
    'warn',
    `Outflows frozen and FAST suspended at once. Queued withdrawals are void. ${nP} (P) and ${nA} (A) can be installed from day 7 until day 14.${superseded ? ` The pending ${superseded.kind} proposal was discarded.` : ''}`,
  );
}

export function replaceGuardians(state: DemoState, newG: [KeyId, KeyId, KeyId], approvals: Approval[], consents?: KeyId[]): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  if (v.status !== 'active' || state.proposal) return refuse(state, 'PROPOSAL_EXISTS', 'Only one security proposal may be live.');
  const ord = noOrdinary(state, approvals, 'Guardian replacement needs P, A and two current guardians.');
  if (ord) return ord;
  const spend = approvals.filter((a) => a.signer === v.P || a.signer === v.A);
  const guards = approvals.filter((a) => a.signer !== v.P && a.signer !== v.A);
  if (!spend.some((a) => a.signer === v.P) || !spend.some((a) => a.signer === v.A)) {
    return refuse(state, 'PAIR_REQUIRED', 'Guardian replacement needs the primary and the approver as well as two current guardians.');
  }
  const q = requireGuardians(state, v, guards, 'Guardian replacement');
  if (q) return q;
  const keep = newG.filter((k) => v.G.includes(k));
  const introduced = newG.filter((k) => !v.G.includes(k));
  if (new Set(newG).size !== 3) return refuse(state, 'DUPLICATE_KEYS', 'The three guardians must be distinct.');
  if (!introduced.length) return refuse(state, 'NO_CHANGE', 'Nothing to replace.');
  const nk = checkNewKeys(state, introduced, [v.P, v.A, ...keep], consents ?? newG);
  if (nk) return nk;
  const missing = newG.filter((k) => !(consents ?? newG).includes(k));
  if (missing.length) return refuse(state, 'MISSING_CONSENT', `All three designated guardians must consent. Missing: ${missing.join(', ')}.`);
  if (!sameDigest(approvals)) return refuse(state, 'DIGEST_MISMATCH', 'Every signer must approve the identical action.');
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'replaceGuardians', keysParamsHash(newG), 'recovery');
    if (fe) return fe;
  }
  const proposal: SecurityProposal = {
    id: 'gp-' + demoHash(approvals.map(approvalFingerprint).join('|')).slice(0, 10),
    kind: 'guardians',
    newKeys: newG,
    startedAt: state.clock,
    executableAt: state.clock + SECURITY_DELAY,
    expiresAt: state.clock + SECURITY_DELAY + SECURITY_WINDOW,
  };
  let next = consume(state, approvals);
  next = patchVault(next, { status: 'pending', executionEpoch: v.executionEpoch + 1, nonces: bump(v, 'recovery') });
  next = { ...next, proposal };
  return accept(next, 'Guardian replacement started', 'warn', `Outflows frozen. ${newG.join(', ')} can be installed from day 7 until day 14. Only the current guardian quorum can cancel it.`);
}

export function cancelRecoveryChange(state: DemoState, approvals: Approval[]): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const p = state.proposal;
  if (!p || (p.kind !== 'recovery' && p.kind !== 'guardians')) return refuse(state, 'NO_PROPOSAL', 'No pending recovery or guardian replacement.');
  if (approvals.some((a) => a.signer === v.P || a.signer === v.A)) {
    return refuse(state, 'SPENDING_KEYS_CANNOT_VETO', 'The primary and approver cannot veto recovery. Two current guardians must sign the cancellation.');
  }
  const q = requireGuardians(state, v, approvals, 'Cancelling a recovery proposal');
  if (q) return q;
  for (const a of approvals) {
    const fe = checkFrame(state, v, a, 'cancelRecovery', idParamsHash('cancel-recovery', p.id), 'recovery');
    if (fe) return fe;
  }
  let next = consume(state, approvals);
  next = patchVault(next, { status: 'active', nonces: bump(v, 'recovery'), executionEpoch: v.executionEpoch + 1 });
  next = { ...next, proposal: null };
  return accept(next, 'Proposal cancelled by two guardians', 'ok', 'Old authority resumes. FAST stays suspended, and withdrawals from before the proposal stay invalid.');
}

export function finalizeSecurityChange(state: DemoState): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const p = state.proposal;
  if (!p) return refuse(state, 'NO_PROPOSAL', 'No security proposal is pending.');
  if (state.clock < p.executableAt) return refuse(state, 'TOO_EARLY', `Finalization opens in ${formatDuration(p.executableAt - state.clock)}.`);
  if (state.clock >= p.expiresAt) return refuse(state, 'EXPIRED', 'The finalization window has closed. The proposal can only be expired.');
  let patch: Partial<Vault>;
  let what: string;
  if (p.kind === 'policy') {
    const bad = validatePolicy(v, p.policy!, p.startedAt);
    if (bad) return refuse(state, 'BAD_POLICY', `Recheck failed: ${bad}`);
    patch = installPolicy(v, p.policy!);
    what = 'Policy change installed';
  } else {
    const keys = p.newKeys!;
    const stillReady = keys.every((k) => state.keys[k]?.ready);
    if (!stillReady) return refuse(state, 'KEY_NOT_READY', 'Recheck failed: a committed key is not activated.');
    if (p.kind === 'spendingKeys') {
      patch = { P: keys[0]!, A: keys[1]!, authorityEpoch: v.authorityEpoch + 1, executionEpoch: v.executionEpoch + 1 };
      what = `${keys[0]} (P) and ${keys[1]} (A) installed`;
    } else if (p.kind === 'recovery') {
      // Recovery installs the pair, disables and suspends FAST, removes grant rules, keeps lifetime counters and the delay.
      patch = {
        P: keys[0]!,
        A: keys[1]!,
        policy: { ...v.policy, fastEnabled: false, resumeFast: false, rules: {} },
        fastSuspended: true,
        authorityEpoch: v.authorityEpoch + 1,
        policyEpoch: v.policyEpoch + 1,
        executionEpoch: v.executionEpoch + 1,
      };
      what = `Recovered: ${keys[0]} (P) and ${keys[1]} (A) installed`;
    } else {
      patch = { G: [keys[0]!, keys[1]!, keys[2]!], authorityEpoch: v.authorityEpoch + 1, executionEpoch: v.executionEpoch + 1 };
      what = `Guardians replaced with ${keys.join(', ')}`;
    }
  }
  let next = patchVault(state, { ...patch, status: 'active' });
  next = { ...next, proposal: null };
  const detail =
    p.kind === 'recovery'
      ? 'No funds moved. FAST is disabled until a new joint policy enables it; protected payments keep the elected delay.'
      : 'Anyone may submit finalization; it installs exactly what was committed.';
  return accept(next, what, 'ok', detail);
}

export function expireSecurityChange(state: DemoState): Result {
  const v = requireVault(state);
  if (isRefusal(v)) return v;
  const p = state.proposal;
  if (!p) return refuse(state, 'NO_PROPOSAL', 'No security proposal is pending.');
  if (state.clock < p.expiresAt) return refuse(state, 'NOT_EXPIRED', `The proposal can be expired in ${formatDuration(p.expiresAt - state.clock)}.`);
  let next = patchVault(state, { status: 'active', executionEpoch: v.executionEpoch + 1 });
  next = { ...next, proposal: null };
  return accept(next, 'Expired proposal cleared', 'ok', 'Old authority resumes; invalidated requests stay invalid. Expiry does not prove a compromise is resolved.');
}

// ---------- convenience for the UI ----------

/** Approvals for the current P and A over the same request. */
export function pairApprovals(state: DemoState, action: ActionKind, paramsHash: string): Approval[] {
  const v = state.vault!;
  return [makeApproval(state, v.P, action, paramsHash), makeApproval(state, v.A, action, paramsHash)];
}
