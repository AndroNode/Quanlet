import { create } from 'zustand';
import type { Address, Hex } from 'viem';
import { ETH, KEY_FACTORY, VAULT_FACTORIES, VAULT_FACTORY } from './chain';
import { IS_MAINNET } from '../../net';

/**
 * The protocol 2.0 testnet vault this browser knows about: the five role keys (and two prepared replacement
 * keys during recovery), the chosen policy, the vault address and the transfers sent from here.
 * On testnet, seeds kept in the browser are stored in plain form. Every key also has its own encrypted backup
 * file, and the approver and guardians can be removed from the browser once their backup is tested.
 * On mainnet, a seed is never written to storage once its backup is tested (before that, no vault can use it):
 * it stays in memory for the visit, and later visits open the backup file to sign.
 */
export type Slot = {
  /** Absent when the key lives only in its encrypted backup file. */
  seed?: Hex;
  keyId: Hex;
  /** Registered and activated in KeyFactoryV2. */
  ready: boolean;
  backedUp?: boolean;
  tested?: boolean;
};
export type RoleName = 'p' | 'a' | 'g1' | 'g2' | 'g3';
export type NextName = 'np' | 'na' | 'ng1' | 'ng2' | 'ng3';
export type SlotName = RoleName | NextName;
export const ROLE_NAMES: RoleName[] = ['p', 'a', 'g1', 'g2', 'g3'];
export const LABEL: Record<SlotName, string> = {
  p: 'Primary key (P)',
  a: 'Approver key (A)',
  g1: 'Guardian 1',
  g2: 'Guardian 2',
  g3: 'Guardian 3',
  np: 'New primary key',
  na: 'New approver key',
  ng1: 'New guardian 1',
  ng2: 'New guardian 2',
  ng3: 'New guardian 3',
};
export const NEXT_NAMES: NextName[] = ['np', 'na', 'ng1', 'ng2', 'ng3'];

/** Allowance per asset (lower-case address): new FAST authority and the per-transfer limit, as typed. */
export type RuleDraft = { ceiling: string; cap: string };
export type PolicyDraft = {
  delay: number;
  fast: boolean;
  days: number;
  recipients: string[];
  rules: Record<string, RuleDraft>;
  maxFee: string;
  feeRecipients: string[];
};
export type HistoryItem = { id: Hex; route: 1 | 2; amount: string; recipient: Address; hash?: Hex; at: number; queued: boolean; relayed?: boolean };

export type ProfileV2 = {
  version: 2;
  chainId: number;
  keyFactory: Address;
  vaultFactory: Address;
  keys: Record<RoleName, Slot>;
  /** Keys prepared for a recovery, a rotation or a guardian replacement. */
  next?: Partial<Record<NextName, Slot>>;
  draft: PolicyDraft;
  salt?: Hex;
  vault?: Address;
  /** Queued protected transfers (ids). */
  withdrawals: Hex[];
  history: HistoryItem[];
  /** abi.encode of a delayed policy change started here, needed to finalize it (JSON with bigints as strings). */
  /** A delayed policy change: kept by the browser that signed it, or read from the proposing transaction (fromChain). */
  pendingPolicy?: { id?: Hex; json: string; fromChain?: boolean };
  createdAt: number;
};

const KEY = `quanlet.testnet.v2.kf.${KEY_FACTORY.toLowerCase()}`;
/** Where profiles were kept before a second factory was added (one key per factory). */
const OLD_KEYS = VAULT_FACTORIES.map((f) => `quanlet.testnet.v2.${f.toLowerCase()}`);

const hex32 = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const addr = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const slot = (v: unknown): v is Slot => !!v && typeof v === 'object' && hex32((v as Slot).keyId) && ((v as Slot).seed === undefined || hex32((v as Slot).seed));
const clean = (s: Slot): Slot => ({ ...(s.seed ? { seed: s.seed } : {}), keyId: s.keyId, ready: !!s.ready, backedUp: !!s.backedUp, tested: !!s.tested });

export const DEFAULT_DRAFT: PolicyDraft = {
  delay: 3600,
  fast: true,
  days: 30,
  recipients: [],
  rules: { [ETH]: { ceiling: '0.002', cap: '0.001' } },
  maxFee: '',
  feeRecipients: [],
};
const addrList = (v: unknown) => (Array.isArray(v) ? v.filter(addr) : []);

/** Accept only a well-formed profile for this deployment (used for imports too). */
export function validateV2(v: unknown): ProfileV2 | null {
  const p = v as ProfileV2;
  if (!p || p.version !== 2 || !p.keys || typeof p.keys !== 'object') return null;
  if (!ROLE_NAMES.every((n) => slot(p.keys[n]))) return null;
  if (!addr(p.vaultFactory) || !VAULT_FACTORIES.some((f) => f.toLowerCase() === p.vaultFactory.toLowerCase())) return null;
  if (p.vault !== undefined && !addr(p.vault)) return null;
  if (p.salt !== undefined && !hex32(p.salt)) return null;
  if (p.next !== undefined && (typeof p.next !== 'object' || !Object.values(p.next).every((x) => x === undefined || slot(x)))) return null;
  const d = (p.draft ?? DEFAULT_DRAFT) as PolicyDraft & { ceiling?: string; cap?: string };
  // Drafts saved before tokens kept one ETH allowance as ceiling/cap.
  const rawRules = d.rules && typeof d.rules === 'object' ? d.rules : d.ceiling !== undefined ? { [ETH]: { ceiling: String(d.ceiling), cap: String(d.cap ?? '') } } : DEFAULT_DRAFT.rules;
  const rules: Record<string, RuleDraft> = {};
  for (const [k, v] of Object.entries(rawRules)) if (addr(k) && v && typeof v === 'object') rules[k.toLowerCase()] = { ceiling: String(v.ceiling ?? ''), cap: String(v.cap ?? '') };
  const next = p.next ? Object.fromEntries(NEXT_NAMES.filter((n) => p.next![n]).map((n) => [n, clean(p.next![n]!)])) : undefined;
  return {
    version: 2,
    chainId: Number(p.chainId) || 0,
    keyFactory: KEY_FACTORY,
    // A vault keeps the factory it came from; a profile without a vault yet uses the current factory.
    vaultFactory: p.vault ? p.vaultFactory : VAULT_FACTORY,
    keys: Object.fromEntries(ROLE_NAMES.map((n) => [n, clean(p.keys[n])])) as ProfileV2['keys'],
    ...(next && Object.keys(next).length ? { next } : {}),
    draft: {
      delay: [0, 3600, 86400, 259200].includes(Number(d.delay)) ? Number(d.delay) : DEFAULT_DRAFT.delay,
      fast: !!d.fast,
      days: Math.max(1, Math.min(30, Number(d.days) || 30)),
      recipients: addrList(d.recipients),
      rules,
      maxFee: typeof d.maxFee === 'string' ? d.maxFee : '',
      feeRecipients: addrList(d.feeRecipients),
    },
    ...(p.salt ? { salt: p.salt } : {}),
    ...(p.vault ? { vault: p.vault } : {}),
    withdrawals: Array.isArray(p.withdrawals) ? p.withdrawals.filter(hex32) : [],
    history: Array.isArray(p.history) ? p.history.filter((h) => h && hex32(h.id) && addr(h.recipient)).slice(-50) : [],
    ...(p.pendingPolicy && typeof p.pendingPolicy.json === 'string' ? { pendingPolicy: p.pendingPolicy } : {}),
    createdAt: Number(p.createdAt) || Date.now(),
  };
}

function load(): ProfileV2 | null {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      const old = OLD_KEYS.find((k) => localStorage.getItem(k));
      if (old) {
        raw = localStorage.getItem(old);
        if (raw) localStorage.setItem(KEY, raw);
      }
    }
    return raw ? validateV2(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
/** What may be written to storage: on mainnet, no seed whose backup has been tested. */
function storable(p: ProfileV2): ProfileV2 {
  if (!IS_MAINNET) return p;
  const strip = (s: Slot): Slot => (s.tested ? (({ seed: _s, ...rest }) => rest)(s) : s);
  return {
    ...p,
    keys: Object.fromEntries(ROLE_NAMES.map((n) => [n, strip(p.keys[n])])) as ProfileV2['keys'],
    ...(p.next ? { next: Object.fromEntries(Object.entries(p.next).map(([k, v]) => [k, strip(v!)])) } : {}),
  };
}

function save(p: ProfileV2 | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(storable(p)));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the profile lasts for this visit only, so the backups matter */
  }
}

interface Store {
  profile: ProfileV2 | null;
  set: (p: ProfileV2 | null) => void;
  update: (fn: (p: ProfileV2) => ProfileV2) => void;
}
export const useProfileV2 = create<Store>((set, get) => ({
  profile: load(),
  set: (p) => {
    save(p);
    set({ profile: p });
  },
  update: (fn) => {
    const cur = get().profile;
    if (!cur) return;
    const next = fn(cur);
    save(next);
    set({ profile: next });
  },
}));

/** Vault details without key material: safe to keep with notes, useless to a thief. */
export function vaultInfoV2(p: ProfileV2): ProfileV2 {
  const strip = ({ seed: _s, ...rest }: Slot): Slot => rest;
  return {
    ...p,
    keys: Object.fromEntries(ROLE_NAMES.map((n) => [n, strip(p.keys[n])])) as ProfileV2['keys'],
    ...(p.next ? { next: Object.fromEntries(Object.entries(p.next).map(([k, v]) => [k, strip(v!)])) } : {}),
  };
}

const isNext = (n: SlotName): n is NextName => (NEXT_NAMES as string[]).includes(n);
export function getSlot(p: ProfileV2, n: SlotName): Slot | undefined {
  return isNext(n) ? p.next?.[n] : p.keys[n];
}
export function patchSlot(p: ProfileV2, n: SlotName, fn: (s: Slot) => Slot): ProfileV2 {
  if (isNext(n)) return p.next?.[n] ? { ...p, next: { ...p.next, [n]: fn(p.next[n]!) } } : p;
  return { ...p, keys: { ...p.keys, [n]: fn(p.keys[n]) } };
}
