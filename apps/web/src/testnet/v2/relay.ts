/**
 * The Quanlet relayer (apps/api/src/relay.ts): it submits a transfer your keys signed and pays its gas, for a fee in
 * ETH that the vault pays in the same transaction. Your keys sign the fee and the relayer's address; the relayer can
 * change nothing and has no power over the vault. Without it, the connected wallet pays the gas as before.
 */
import { create } from 'zustand';
import type { Address, Hex } from 'viem';
import { ChainError } from '../chain';
import { exportSigned, type SignedTransfer } from './chain';

export type RelayFees = { fast: bigint; protected: bigint; protectedDelayed: bigint; execute: bigint };
export type RelayStatus = { enabled: false } | { enabled: true; address: Address; accepting: boolean; fees: RelayFees };

interface RelayStore {
  status: RelayStatus | null;
  at: number;
  load: (force?: boolean) => Promise<void>;
}

export const useRelay = create<RelayStore>((set, get) => ({
  status: null,
  at: 0,
  load: async (force = false) => {
    if (!force && Date.now() - get().at < 60_000) return;
    set({ at: Date.now() });
    try {
      const r = (await (await fetch('/api/relay', { cache: 'no-store' })).json()) as Record<string, any>;
      if (!r.enabled || typeof r.address !== 'string' || !r.fees) return set({ status: { enabled: false } });
      const f = r.fees as Record<string, string>;
      set({
        status: {
          enabled: true,
          address: r.address as Address,
          accepting: !!r.accepting,
          fees: { fast: BigInt(f.fast ?? '0'), protected: BigInt(f.protected ?? '0'), protectedDelayed: BigInt(f.protectedDelayed ?? '0'), execute: BigInt(f.execute ?? '0') },
        },
      });
    } catch {
      set({ status: { enabled: false } });
    }
  },
}));

/** The relayer's address when it is on and taking transfers. */
export const relayAddress = (s: RelayStatus | null): Address | null => (s && s.enabled && s.accepting ? s.address : null);

async function post(path: string, body: unknown): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ChainError('The relayer could not be reached. Nothing was sent.');
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || typeof out.hash !== 'string') {
    const min = typeof out.minFeeWei === 'string' ? ' The fee went up: review the transfer again to get a new fee.' : '';
    throw new ChainError(`${out.error ?? 'The relayer refused the transfer.'}${min}`);
  }
  return out;
}

export async function relaySubmit(s: SignedTransfer): Promise<{ hash: Hex; queued: boolean }> {
  const out = await post('/api/relay', exportSigned(s));
  return { hash: out.hash as Hex, queued: !!out.queued };
}

export async function relayExecute(vault: Address, id: Hex): Promise<{ hash: Hex }> {
  const out = await post('/api/relay/execute', { vault, id });
  return { hash: out.hash as Hex };
}
