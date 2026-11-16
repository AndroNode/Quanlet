import { create } from 'zustand';
import type { Address, Hex } from 'viem';
import { DEPLOYMENT } from './chain';

/**
 * The testnet vault this browser knows about: record ids, the vault address, and the seeds of the
 * keys the user chose to keep here. Kept in localStorage so a reload does not lose them.
 * TESTNET ONLY: kept seeds are stored in plain form. Each key also has its own encrypted backup
 * file, and recovery keys can be removed from the browser once their backup has been tested.
 */
export type KeySlot = {
  /** Absent when the key lives only in its encrypted backup file. */
  seed?: Hex;
  recordId: Hex;
  registered: boolean;
  /** An encrypted backup file was downloaded. */
  backedUp?: boolean;
  /** That file was opened again and signed a test message. */
  tested?: boolean;
};
export type Profile = {
  version: 1;
  chainId: number;
  keyFactory: Address;
  vaultFactory: Address;
  primary: KeySlot;
  recovery: [KeySlot, KeySlot, KeySlot];
  salt?: Hex;
  vault?: Address;
  withdrawals: Hex[];
  /** A replacement primary prepared for recovery. */
  nextPrimary?: KeySlot;
  /** A replacement recovery set being prepared. */
  nextRecovery?: [KeySlot, KeySlot, KeySlot];
  createdAt: number;
};

const KEY = `quanlet.testnet.v1.${DEPLOYMENT.vaultFactory.toLowerCase()}`;

function load(): Profile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? validate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function save(p: Profile | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the profile lasts for this visit only, so the backup matters */
  }
}

const hex32 = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const addr = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const slot = (v: unknown): v is KeySlot =>
  !!v && typeof v === 'object' && hex32((v as KeySlot).recordId) && ((v as KeySlot).seed === undefined || hex32((v as KeySlot).seed));
const clean = (s: KeySlot): KeySlot => ({
  ...(s.seed ? { seed: s.seed } : {}),
  recordId: s.recordId,
  registered: !!s.registered,
  backedUp: !!s.backedUp,
  tested: !!s.tested,
});
const triple = (v: unknown): v is [KeySlot, KeySlot, KeySlot] => Array.isArray(v) && v.length === 3 && v.every(slot);

/** Accept only a well-formed profile for this deployment (used for imports too). */
export function validate(v: unknown): Profile | null {
  const p = v as Profile;
  if (!p || p.version !== 1 || !slot(p.primary) || !triple(p.recovery)) return null;
  if (p.vault !== undefined && !addr(p.vault)) return null;
  if (p.salt !== undefined && !hex32(p.salt)) return null;
  if (p.nextPrimary !== undefined && !slot(p.nextPrimary)) return null;
  if (p.nextRecovery !== undefined && !triple(p.nextRecovery)) return null;
  if (!addr(p.vaultFactory) || p.vaultFactory.toLowerCase() !== DEPLOYMENT.vaultFactory.toLowerCase()) return null;
  return {
    version: 1,
    chainId: Number(p.chainId) || 0,
    keyFactory: p.keyFactory,
    vaultFactory: p.vaultFactory,
    primary: clean(p.primary),
    recovery: p.recovery.map(clean) as Profile['recovery'],
    ...(p.salt ? { salt: p.salt } : {}),
    ...(p.vault ? { vault: p.vault } : {}),
    withdrawals: Array.isArray(p.withdrawals) ? p.withdrawals.filter(hex32) : [],
    ...(p.nextPrimary ? { nextPrimary: clean(p.nextPrimary) } : {}),
    ...(p.nextRecovery ? { nextRecovery: p.nextRecovery.map(clean) as Profile['recovery'] } : {}),
    createdAt: Number(p.createdAt) || Date.now(),
  };
}

interface ProfileStore {
  profile: Profile | null;
  set: (p: Profile | null) => void;
  update: (fn: (p: Profile) => Profile) => void;
}

export const useProfile = create<ProfileStore>((set, get) => ({
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

/** Vault details without any key material: safe to keep with notes, useless to a thief. */
export function vaultInfo(p: Profile): Profile {
  const strip = ({ seed: _seed, ...rest }: KeySlot): KeySlot => rest;
  return {
    ...p,
    primary: strip(p.primary),
    recovery: p.recovery.map(strip) as Profile['recovery'],
    ...(p.nextPrimary ? { nextPrimary: strip(p.nextPrimary) } : {}),
    ...(p.nextRecovery ? { nextRecovery: p.nextRecovery.map(strip) as Profile['recovery'] } : {}),
  };
}

/** True for a file made by the first release, which kept every seed in one plain file. */
export const hasSeeds = (p: Profile) => [p.primary, ...p.recovery, p.nextPrimary, ...(p.nextRecovery ?? [])].some((s) => s?.seed);
