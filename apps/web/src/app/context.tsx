import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { TARGET_CHAIN, useWallet } from '../wallet';
import { ChainError, send } from '../testnet/chain';
import { useSessionKeys } from '../testnet/keyfile';
import { ERRORS, STATE, keyStatus, loadVault, type VaultView } from '../testnet/v2/chain';
import { NEXT_NAMES, ROLE_NAMES, getSlot, patchSlot, useProfileV2, type ProfileV2, type SlotName } from '../testnet/v2/profile';
import { eq, type Activity } from '../pages/Testnet';
import type { Note, RunFn } from './panels';

/**
 * Everything the four vault pages share: the keys and vault saved in this browser, the vault as read from the chain,
 * the wallet that pays gas, and one activity line for whatever is being signed or sent. Lives above the pages so
 * moving between Vault, Payments, Recovery and Control keeps keys loaded and transactions visible.
 */

export type SetupStep = 'wallet' | 'keys' | 'backup' | 'register' | 'create' | 'fund' | 'done';

interface VaultApp {
  profile: ProfileV2 | null;
  setProfile: (p: ProfileV2 | null) => void;
  view: VaultView | null;
  viewErr: string | null;
  activity: Activity;
  setActivity: (a: Activity) => void;
  busy: boolean;
  /** Wallet connected on the right network: transactions can be sent. */
  ready: boolean;
  run: RunFn;
  note: Note;
  recheck: () => Promise<void>;
  checking: boolean;
  refresh: () => Promise<void>;
  /** Chain time, ticking every second between reads. */
  now: number;
  allReady: boolean;
  allTested: boolean;
  step: SetupStep;
  forget: () => void;
}

const Ctx = createContext<VaultApp | null>(null);

export function useVaultApp(): VaultApp {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVaultApp outside VaultAppProvider');
  return v;
}

export function VaultAppProvider({ children }: { children: ReactNode }) {
  const w = useWallet();
  const { profile, set: setProfile, update } = useProfileV2();
  const [activity, setActivity] = useState<Activity>(null);
  const [view, setView] = useState<VaultView | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const busy = activity?.kind === 'busy';
  const ready = !!w.address && w.chainId === TARGET_CHAIN && !!w.active;

  const run: RunFn = useCallback(async (label, step, after) => {
    const st = useWallet.getState();
    if (!st.active || !st.address) return false;
    setActivity({ kind: 'busy', text: `${label}: preparing and signing…` });
    try {
      const tx = await step();
      if (!tx) {
        setActivity({ kind: 'ok', text: `${label}: nothing to do.` });
        return true;
      }
      setActivity({ kind: 'busy', text: `${label}: confirm in your wallet…` });
      const r = await send(st.active.provider, st.address as Address, tx, (hash) => setActivity({ kind: 'busy', text: `${label}: waiting for the chain…`, hash }), ERRORS);
      after?.(r);
      setActivity({ kind: 'ok', text: `${label}: done.`, hash: r.transactionHash });
      void useWallet.getState().refreshBalance();
      return true;
    } catch (e) {
      setActivity({ kind: 'err', text: `${label}: ${e instanceof ChainError ? e.message : (e as Error).message}` });
      return false;
    }
  }, []);
  const note: Note = useCallback((kind, text) => setActivity({ kind, text }), []);

  // ---------------------------------------------------------------- key status
  const [checking, setChecking] = useState(false);
  const recheck = useCallback(async () => {
    const p = useProfileV2.getState().profile;
    if (!p) return;
    setChecking(true);
    try {
      const names: SlotName[] = [...ROLE_NAMES, ...NEXT_NAMES.filter((n) => p.next?.[n])];
      const flags = await Promise.all(names.map((n) => (getSlot(p, n)!.ready ? true : keyStatus(getSlot(p, n)!.keyId).then((s) => s.ready))));
      useProfileV2.getState().update((q) => names.reduce((acc, n, i) => patchSlot(acc, n, (s) => ({ ...s, ready: flags[i]! })), q));
    } catch {
      /* offline: keep what we know */
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void recheck();
  }, [recheck]);

  // ---------------------------------------------------------------- vault state
  const refresh = useCallback(async () => {
    const p = useProfileV2.getState().profile;
    if (!p?.vault) return;
    try {
      setView(await loadVault(p.vault, p.withdrawals));
      setViewErr(null);
    } catch (e) {
      setViewErr((e as Error).message || 'Could not read the vault.');
    }
  }, []);
  useEffect(() => {
    if (!profile?.vault) {
      setView(null);
      return;
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(id);
  }, [profile?.vault, refresh]);

  // A finalized recovery, rotation or guardian change (here or elsewhere) moves the prepared keys into place.
  useEffect(() => {
    if (!view) return;
    const p = useProfileV2.getState().profile;
    if (p?.next) {
      const nx = { ...p.next };
      const keys = { ...p.keys };
      let changed = false;
      if (nx.np && eq(view.roles[0], nx.np.keyId)) (keys.p = nx.np), delete nx.np, (changed = true);
      if (nx.na && eq(view.roles[1], nx.na.keyId)) (keys.a = nx.na), delete nx.na, (changed = true);
      if (nx.ng1 && nx.ng2 && nx.ng3 && [nx.ng1, nx.ng2, nx.ng3].every((x, i) => eq(view.roles[2 + i], x.keyId))) {
        [keys.g1, keys.g2, keys.g3] = [nx.ng1, nx.ng2, nx.ng3];
        delete nx.ng1;
        delete nx.ng2;
        delete nx.ng3;
        changed = true;
      }
      if (changed) update((q) => ({ ...q, keys, next: Object.keys(nx).length ? nx : undefined }));
    }
    if (p?.pendingPolicy && view.state !== STATE.PendingPolicy) update((q) => ({ ...q, pendingPolicy: undefined }));
  }, [view, update]);

  // Countdowns move between refreshes.
  const [, setTick] = useState(0);
  const base = useRef({ chain: 0, at: 0 });
  useEffect(() => {
    if (view) base.current = { chain: view.now, at: Date.now() };
  }, [view]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const now = base.current.chain ? base.current.chain + Math.floor((Date.now() - base.current.at) / 1000) : Math.floor(Date.now() / 1000);

  const slots = profile ? ROLE_NAMES.map((n) => profile.keys[n]) : [];
  const allReady = slots.length === 5 && slots.every((s) => s.ready);
  const allTested = slots.length === 5 && slots.every((s) => s.ready || s.tested);
  const funded = !!view && view.assets.some((x) => x.balance > 0n);
  const step: SetupStep = !profile
    ? ready
      ? 'keys'
      : 'wallet'
    : !allTested
      ? 'backup'
      : !allReady
        ? ready
          ? 'register'
          : 'wallet'
        : !profile.vault
          ? ready
            ? 'create'
            : 'wallet'
          : !view
            ? 'done'
            : !funded
              ? ready
                ? 'fund'
                : 'wallet'
              : 'done';

  const forget = useCallback(() => {
    setProfile(null);
    setView(null);
    useSessionKeys.getState().clear();
  }, [setProfile]);

  const value = useMemo<VaultApp>(
    () => ({ profile, setProfile, view, viewErr, activity, setActivity, busy, ready, run, note, recheck, checking, refresh, now, allReady, allTested, step, forget }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, view, viewErr, activity, busy, ready, checking, now, allReady, allTested, step],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
