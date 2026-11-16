import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatEther, isAddress, parseEther, type Address, type Hex } from 'viem';
import { PageFacts, PageKicker, PageMark } from '../components/PageMarks';
import { EXPLORER, TARGET_CHAIN, TARGET_NAME, formatEth, short, useWallet } from '../wallet';
import {
  DEPLOYMENT,
  ChainError,
  VAULT_ABI,
  VAULT_FACTORY_ABI,
  cancelSecurityTx,
  cancelTx,
  createVaultTx,
  depositTx,
  eventsOf,
  executeTx,
  expireTx,
  finalizeTx,
  invalidateTx,
  isRegistered,
  isVault,
  keyFromSeed,
  keyRecordOf,
  loadVault,
  newSeed,
  registerKeyTx,
  replaceRecoverySetTx,
  scheduleTx,
  send,
  startRecoveryTx,
  type QKey,
  type Tx,
  type VaultView,
} from '../testnet/chain';
import { hasSeeds, useProfile, validate, vaultInfo, type KeySlot, type Profile } from '../testnet/profile';
import { MIN_PASSWORD, decryptKey, downloadJson, encryptKey, keyFileName, parseKeyFile, signTest, useSessionKeys } from '../testnet/keyfile';

const FAUCETS: Array<[string, string]> = [
  ['Robinhood faucet', 'https://faucet.testnet.chain.robinhood.com/'],
  ['Alchemy faucet', 'https://www.alchemy.com/faucets/robinhood-testnet'],
];
const DAY = 86400;

export const link = (path: string) => `${EXPLORER}/${path}`;
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

export function left(sec: number) {
  if (sec <= 0) return 'now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}
export const when = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function slotFor(seed: Hex): KeySlot {
  return { seed, recordId: keyRecordOf(keyFromSeed(seed)).recordId, registered: false, backedUp: false, tested: false };
}

// ---------------------------------------------------------------- key slots

type SlotRef = { g: 'primary' } | { g: 'recovery'; i: number } | { g: 'nextPrimary' } | { g: 'nextRecovery'; i: number };
const refName = (r: SlotRef) =>
  r.g === 'primary' ? 'Primary key' : r.g === 'recovery' ? `Recovery key ${r.i + 1}` : r.g === 'nextPrimary' ? 'New primary key' : `New recovery key ${r.i + 1}`;
/** Primary keys sign withdrawals, so a loaded primary goes back into the browser. Recovery keys loaded from a file stay in memory for this visit. */
const keepsSeed = (r: SlotRef) => r.g === 'primary' || r.g === 'nextPrimary';

function getSlot(p: Profile, r: SlotRef): KeySlot | undefined {
  if (r.g === 'primary') return p.primary;
  if (r.g === 'recovery') return p.recovery[r.i];
  if (r.g === 'nextPrimary') return p.nextPrimary;
  return p.nextRecovery?.[r.i];
}
function patchSlot(p: Profile, r: SlotRef, fn: (s: KeySlot) => KeySlot): Profile {
  if (r.g === 'primary') return { ...p, primary: fn(p.primary) };
  if (r.g === 'recovery') return { ...p, recovery: p.recovery.map((s, i) => (i === r.i ? fn(s) : s)) as Profile['recovery'] };
  if (r.g === 'nextPrimary') return p.nextPrimary ? { ...p, nextPrimary: fn(p.nextPrimary) } : p;
  return p.nextRecovery ? { ...p, nextRecovery: p.nextRecovery.map((s, i) => (i === r.i ? fn(s) : s)) as Profile['recovery'] } : p;
}
function allRefs(p: Profile): SlotRef[] {
  return [
    { g: 'primary' },
    ...[0, 1, 2].map((i) => ({ g: 'recovery', i }) as SlotRef),
    ...(p.nextPrimary ? [{ g: 'nextPrimary' } as SlotRef] : []),
    ...(p.nextRecovery ? [0, 1, 2].map((i) => ({ g: 'nextRecovery', i }) as SlotRef) : []),
  ];
}

/** The seed for a slot: kept in the browser, or opened from its backup for this visit. */
function useSeedOf() {
  const seeds = useSessionKeys((s) => s.seeds);
  return useCallback((s?: KeySlot) => (s ? s.seed ?? seeds[s.recordId.toLowerCase()] : undefined), [seeds]);
}

export type Activity = { kind: 'busy' | 'ok' | 'err'; text: string; hash?: Hex } | null;
type RunFn = (label: string, step: () => Promise<Tx | null>, after?: (r: Awaited<ReturnType<typeof send>>) => void) => Promise<boolean>;

export default function Testnet() {
  const w = useWallet();
  const { profile, set: setProfile, update } = useProfile();
  const seedOf = useSeedOf();
  const [activity, setActivity] = useState<Activity>(null);
  const [view, setView] = useState<VaultView | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const busy = activity?.kind === 'busy';
  const onTarget = w.chainId === TARGET_CHAIN;
  const ready = !!w.address && onTarget && !!w.active;

  /** Run one step: sign locally, send through the wallet, wait for the receipt. */
  const run: RunFn = useCallback(async (label, step, after) => {
    const st = useWallet.getState();
    if (!st.active || !st.address) return false;
    setActivity({ kind: 'busy', text: `${label}: preparing…` });
    try {
      const tx = await step();
      if (!tx) {
        setActivity({ kind: 'ok', text: `${label}: nothing to do.` });
        return true;
      }
      setActivity({ kind: 'busy', text: `${label}: confirm in your wallet…` });
      const r = await send(st.active.provider, st.address as Address, tx, (hash) => setActivity({ kind: 'busy', text: `${label}: waiting for the chain…`, hash }));
      after?.(r);
      setActivity({ kind: 'ok', text: `${label}: done.`, hash: r.transactionHash });
      void useWallet.getState().refreshBalance();
      return true;
    } catch (e) {
      setActivity({ kind: 'err', text: `${label}: ${e instanceof ChainError ? e.message : (e as Error).message}` });
      return false;
    }
  }, []);
  const note = useCallback((kind: 'ok' | 'err', text: string) => setActivity({ kind, text }), []);

  // ---------------------------------------------------------------- key registration state
  const [checking, setChecking] = useState(false);
  const recheck = useCallback(async () => {
    const p = useProfile.getState().profile;
    if (!p) return;
    setChecking(true);
    try {
      const refs = allRefs(p);
      const flags = await Promise.all(refs.map((r) => (getSlot(p, r)!.registered ? true : isRegistered(getSlot(p, r)!.recordId))));
      update((q) => refs.reduce((acc, r, i) => patchSlot(acc, r, (s) => ({ ...s, registered: flags[i]! })), q));
    } catch {
      /* offline: keep what we know */
    } finally {
      setChecking(false);
    }
  }, [update]);
  useEffect(() => {
    void recheck();
  }, [recheck]);

  // ---------------------------------------------------------------- vault state
  const refresh = useCallback(async () => {
    const p = useProfile.getState().profile;
    if (!p?.vault) return;
    try {
      setView(await loadVault(p.vault, p.withdrawals));
      setViewErr(null);
    } catch (e) {
      setViewErr((e as Error).message || 'Could not read the vault.');
    }
  }, []);
  useEffect(() => {
    if (!profile?.vault) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(id);
  }, [profile?.vault, refresh]);

  // A finalized change (here or from another device) moves the prepared keys into place.
  useEffect(() => {
    if (!view) return;
    const p = useProfile.getState().profile;
    if (!p) return;
    if (p.nextPrimary && eq(view.primaryRecord, p.nextPrimary.recordId) && !eq(p.primary.recordId, view.primaryRecord))
      update((q) => (q.nextPrimary ? { ...q, primary: q.nextPrimary, nextPrimary: undefined } : q));
    if (p.nextRecovery && view.recoveryRecords.every((r, i) => eq(r, p.nextRecovery![i]!.recordId)))
      update((q) => (q.nextRecovery ? { ...q, recovery: q.nextRecovery, nextRecovery: undefined } : q));
  }, [view, update]);

  // Local seconds ticker so countdowns move between refreshes.
  const [, setTick] = useState(0);
  const base = useRef({ chain: 0, at: 0 });
  useEffect(() => {
    if (view) base.current = { chain: view.now, at: Date.now() };
  }, [view]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const now = base.current.chain + Math.floor((Date.now() - base.current.at) / 1000);

  const slots = profile ? [profile.primary, ...profile.recovery] : [];
  const allRegistered = slots.length === 4 && slots.every((s) => s.registered);
  const allTested = slots.length === 4 && slots.every((s) => s.registered || s.tested);
  const step = !profile ? 1 : !allTested ? 2 : !allRegistered ? 3 : !profile.vault ? 4 : 5;
  const primarySeed = seedOf(profile?.primary);

  return (
    <div className="wrap page testnet">
      <header className="page-head ph ph-testnet ph-wide">
        <div className="ph-copy">
          <div className="eyebrow">
            <span className="chip ok">
              <span className="dot" aria-hidden /> Live · {TARGET_NAME}
            </span>
            <span className="chip warn">Protocol 1.0 contracts (earlier vaults)</span>
          </div>
          <PageKicker kind="testnet" />
          <h1>
            Testnet <em>vault</em>
          </h1>
          <p>
            Run a real Quanlet vault on {TARGET_NAME}. Your four ML-DSA-44 keys are made in this browser and sign every request here; your wallet only pays gas and
            sends what you approve. Testnet ETH has no value.
          </p>
          <PageFacts facts={[['Real', 'Contracts and keys'], ['4', 'ML-DSA-44 keys, made here'], ['$0', 'Value of testnet ETH']]} />
        </div>
        <PageMark kind="testnet" />
      </header>

      <div className="notice warn tn-version" role="note">
        <strong>This is the protocol 1.0 vault page</strong>
        It keeps vaults made before 16 November 2026 usable: one primary key, three recovery keys and a fixed 24-hour wait on every withdrawal. New vaults use protocol 2.0
        (primary plus approver, a finite FAST allowance, guardian recovery) on the <Link to="/testnet">2.0 vault page</Link>.
      </div>

      <ol className="tn-steps" aria-label="Progress">
        {['Wallet', 'Keys', 'Back up', 'Register', 'Vault'].map((s, i) => (
          <li key={s} className={i + 1 < step || (i === 0 && ready) ? 'done' : i + 1 === step || (i === 0 && !ready) ? 'now' : ''}>
            <span className="mono">{String(i + 1).padStart(2, '0')}</span> {s}
          </li>
        ))}
      </ol>

      <div className="grid two tn-grid">
        <WalletCard />

        {!profile && <StartCard onCreate={(p) => { setProfile(p); note('ok', 'Four keys created in this browser. Back up each one before you register it.'); }} onImport={setProfile} note={note} />}

        {profile && (
          <KeysCard profile={profile} busy={busy} ready={ready} run={run} recheck={recheck} checking={checking} note={note} />
        )}

        {profile && allRegistered && !profile.vault && (
          <section className="card stack">
            <h3>Create the vault</h3>
            <p className="muted">The primary key signs the exact setup and the vault address. The factory checks that signature on chain, then deploys your vault.</p>
            {!primarySeed && <p className="small muted">Load the primary key from its backup first.</p>}
            <button
              className="btn primary"
              disabled={!ready || busy || !primarySeed}
              onClick={() => {
                const salt = profile.salt ?? newSeed();
                if (!profile.salt) update((p) => ({ ...p, salt }));
                let predicted: Address | null = null;
                void run(
                  'Create vault',
                  async () => {
                    const r = await createVaultTx(keyFromSeed(primarySeed!), profile.recovery.map((x) => x.recordId) as [Hex, Hex, Hex], salt);
                    predicted = r.vault;
                    return r.tx;
                  },
                  (rc) => {
                    const ev = eventsOf(rc, VAULT_FACTORY_ABI).find((e) => e.eventName === 'VaultCreated');
                    const vault = ((ev?.args.vault as Address | undefined) ?? predicted)!;
                    update((p) => ({ ...p, vault }));
                  },
                );
              }}
            >
              Create my vault
            </button>
          </section>
        )}

        {profile?.vault && <VaultPanel profile={profile} view={view} viewErr={viewErr} now={now} busy={busy} ready={ready} run={run} refresh={refresh} />}

        {profile?.vault && view && <RecoveryPanel profile={profile} view={view} now={now} busy={busy} ready={ready} run={run} refresh={refresh} recheck={recheck} checking={checking} note={note} />}

        {profile?.vault && view && <ConfigPanel profile={profile} view={view} />}

        {profile && <BackupPanel profile={profile} onImport={setProfile} onForget={() => { setProfile(null); setView(null); useSessionKeys.getState().clear(); }} />}
      </div>

      <div className={`tn-activity ${activity ? activity.kind : ''}`} aria-live="polite" role="status">
        {activity && (
          <>
            {activity.kind === 'busy' && <span className="tn-spin" aria-hidden />}
            <span>{activity.text}</span>
            {activity.hash && <Ext href={link(`tx/${activity.hash}`)}>View transaction</Ext>}
            {activity.kind !== 'busy' && (
              <button className="btn ghost xs" onClick={() => setActivity(null)} aria-label="Dismiss">
                ×
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- panels

export function WalletCard() {
  const w = useWallet();
  const onTarget = w.chainId === TARGET_CHAIN;
  return (
    <section className="card stack">
      <h3>Wallet</h3>
      {!w.address ? (
        <>
          <p className="muted">Connect a browser wallet. It pays gas for each step and never sees your Quanlet keys.</p>
          <button className="btn primary" onClick={() => window.dispatchEvent(new Event('quanlet:wallet-open'))}>
            Connect wallet
          </button>
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Address</dt>
            <dd>
              <Ext href={link(`address/${w.address}`)}>{short(w.address)}</Ext>
            </dd>
            <dt>Network</dt>
            <dd>{onTarget ? TARGET_NAME : `Chain ${w.chainId ?? '?'}`}</dd>
            <dt>Balance</dt>
            <dd>{w.balance !== null ? `${formatEth(w.balance)} ETH` : '…'}</dd>
          </dl>
          {!onTarget && (
            <button className="btn primary" disabled={w.busy} onClick={() => void w.switchNetwork()}>
              Switch to {TARGET_NAME}
            </button>
          )}
          {onTarget && w.balance !== null && w.balance < parseEther('0.002') && (
            <div className="notice warn">
              <span>
                You need a little testnet ETH for gas. Get some free from {FAUCETS.map(([n, u], i) => (
                  <span key={u}>
                    {i ? ' or ' : ''}
                    <Ext href={u}>{n}</Ext>
                  </span>
                ))}
                , then refresh the balance.
              </span>
            </div>
          )}
          <div className="row">
            <button className="btn ghost sm" onClick={() => void w.refreshBalance()}>
              Refresh balance
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function StartCard({ onCreate, onImport, note }: { onCreate: (p: Profile) => void; onImport: (p: Profile) => void; note: (k: 'ok' | 'err', t: string) => void }) {
  const [addr, setAddr] = useState('');
  const [opening, setOpening] = useState(false);
  return (
    <section className="card stack">
      <h3>Create your keys</h3>
      <p className="muted">
        A vault needs four different post-quantum keys: one primary key that signs withdrawals, and three recovery keys. Any two recovery keys can replace a lost
        primary after a 7-day delay.
      </p>
      <div className="notice warn">
        <span>
          Next you will save each key to its own password-protected file and open it once to prove it works. Testnet only: never reuse these keys on mainnet.
        </span>
      </div>
      <button
        className="btn primary"
        onClick={() =>
          onCreate({
            version: 1,
            chainId: TARGET_CHAIN,
            keyFactory: DEPLOYMENT.keyFactory,
            vaultFactory: DEPLOYMENT.vaultFactory,
            primary: slotFor(newSeed()),
            recovery: [slotFor(newSeed()), slotFor(newSeed()), slotFor(newSeed())],
            withdrawals: [],
            createdAt: Date.now(),
          })
        }
      >
        Generate 4 ML-DSA-44 keys
      </button>
      <details className="tn-more">
        <summary>I already have a vault</summary>
        <p className="small muted">Open it by address, then load the primary key from its backup file. Or import a vault info file.</p>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            const a = addr.trim();
            if (!isAddress(a)) return;
            setOpening(true);
            try {
              if (!(await isVault(a as Address))) throw new Error('No Quanlet vault at that address on this network.');
              const v = await loadVault(a as Address, []);
              const s = (recordId: Hex): KeySlot => ({ recordId, registered: true, backedUp: true, tested: false });
              onImport({
                version: 1,
                chainId: TARGET_CHAIN,
                keyFactory: DEPLOYMENT.keyFactory,
                vaultFactory: DEPLOYMENT.vaultFactory,
                primary: s(v.primaryRecord),
                recovery: v.recoveryRecords.map(s) as Profile['recovery'],
                vault: a as Address,
                withdrawals: [],
                createdAt: Date.now(),
              });
              note('ok', 'Vault opened. Load the primary key from its backup file to sign withdrawals.');
            } catch (err) {
              note('err', (err as Error).message);
            } finally {
              setOpening(false);
            }
          }}
        >
          <input className="mono" aria-label="Vault address" placeholder="0x… vault address" value={addr} onChange={(e) => setAddr(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button className="btn sm" disabled={!isAddress(addr.trim()) || opening}>
            {opening ? 'Opening…' : 'Open'}
          </button>
        </form>
        <ImportButton onImport={onImport} />
      </details>
    </section>
  );
}

// -------------------------------------------------------------------- keys

function KeysCard({
  profile,
  busy,
  ready,
  run,
  recheck,
  checking,
  note,
}: {
  profile: Profile;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  recheck: () => Promise<void>;
  checking: boolean;
  note: (k: 'ok' | 'err', t: string) => void;
}) {
  const seedOf = useSeedOf();
  const update = useProfile((s) => s.update);
  const refs: SlotRef[] = [{ g: 'primary' }, { g: 'recovery', i: 0 }, { g: 'recovery', i: 1 }, { g: 'recovery', i: 2 }];
  const pending = refs.filter((r) => !getSlot(profile, r)!.registered);
  const canRegisterAll = pending.length > 0 && pending.every((r) => getSlot(profile, r)!.tested && seedOf(getSlot(profile, r)));
  const recoveryHere = profile.recovery.filter((s) => s.seed).length;
  const recoverySafe = profile.recovery.every((s) => s.tested && s.registered);
  const [confirm, setConfirm] = useState(false);

  return (
    <section className="card stack">
      <div className="tn-head">
        <h3>Your keys</h3>
        <button className="btn ghost xs" disabled={checking} onClick={() => void recheck()}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      <p className="muted small">
        Each key has its own backup file, locked with its own password (Argon2id, then XChaCha20-Poly1305). Open each file once to prove it works before the key is
        registered. Registering stores about 20 KB of key data on chain, so gas is higher than a normal transfer.
      </p>
      <ul className="tn-keylist">
        {refs.map((r) => (
          <KeyRow key={refName(r)} profile={profile} r={r} busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
        ))}
      </ul>
      {pending.length > 0 && (
        <div className="row">
          <button
            className="btn primary"
            disabled={!ready || busy || !canRegisterAll}
            onClick={async () => {
              for (const r of pending) {
                const s = getSlot(useProfile.getState().profile!, r)!;
                if (s.registered) continue;
                const seed = seedOf(s);
                if (!seed) break;
                const ok = await run(`Register ${refName(r).toLowerCase()}`, async () => ((await isRegistered(s.recordId)) ? null : registerKeyTx(keyFromSeed(seed))));
                await recheck();
                if (!ok) break;
              }
            }}
          >
            Register all {pending.length === 4 ? 'four' : 'remaining'} keys
          </button>
          {!canRegisterAll && <span className="small muted">Back up and test every key first.</span>}
        </div>
      )}
      {profile.vault && recoveryHere > 0 && (
        <div className="notice">
          <span>
            {recoveryHere} recovery {recoveryHere === 1 ? 'key is' : 'keys are'} still kept in this browser. Recovery keys are safer only in their backup files, ideally on
            different devices. You load two of them when you need them.
          </span>
          {recoverySafe && (
            <div className="row" style={{ marginTop: 8 }}>
              {!confirm ? (
                <button className="btn sm" onClick={() => setConfirm(true)}>
                  Remove recovery keys from this browser
                </button>
              ) : (
                <>
                  <span className="small">Their backup files will be the only copies.</span>
                  <button
                    className="btn sm"
                    onClick={() => {
                      update((p) => ({ ...p, recovery: p.recovery.map(({ seed: _s, ...rest }) => rest) as Profile['recovery'] }));
                      setConfirm(false);
                      note('ok', 'Recovery keys removed from this browser.');
                    }}
                  >
                    Remove
                  </button>
                  <button className="btn ghost sm" onClick={() => setConfirm(false)}>
                    Keep
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** One key: back it up, prove the backup opens and signs, register it, or load it from its file. */
function KeyRow({
  profile,
  r,
  busy,
  ready,
  run,
  recheck,
  note,
}: {
  profile: Profile;
  r: SlotRef;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  recheck: () => Promise<void>;
  note: (k: 'ok' | 'err', t: string) => void;
}) {
  const update = useProfile((s) => s.update);
  const putSession = useSessionKeys((s) => s.put);
  const seedOf = useSeedOf();
  const slot = getSlot(profile, r)!;
  const seed = seedOf(slot);
  const name = refName(r);
  const [mode, setMode] = useState<'none' | 'backup' | 'open' | 'remove'>('none');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reset = () => {
    setMode('none');
    setPw('');
    setPw2('');
    setFile(null);
    setErr(null);
    setProgress(null);
  };
  const working = progress !== null;
  const id = `k-${r.g}-${'i' in r ? r.i : 0}`;

  const where = slot.seed ? 'In this browser' : seed ? 'Loaded for this visit' : 'Backup file only';
  return (
    <li className="tn-keyrow" data-key={name}>
      <div className="tn-keyline">
        <div>
          <strong>{name}</strong>
          <div className="mono small muted">{short(slot.recordId)}</div>
        </div>
        <div className="tn-chips">
          <span className={`chip ${slot.tested ? 'ok' : slot.backedUp ? 'warn' : 'bad'}`}>{slot.tested ? 'Backup tested' : slot.backedUp ? 'Backup not tested' : 'No backup'}</span>
          <span className={`chip ${slot.registered ? 'ok' : ''}`}>{slot.registered ? 'Registered' : 'Not registered'}</span>
          <span className="chip">{where}</span>
        </div>
      </div>
      <div className="row tn-keyacts">
        {seed && (
          <button className="btn xs" disabled={working} onClick={() => (mode === 'backup' ? reset() : (reset(), setMode('backup')))}>
            {slot.backedUp ? 'Back up again' : 'Back up'}
          </button>
        )}
        {(slot.backedUp || !seed) && (
          <button className={`btn xs ${!slot.tested && slot.backedUp ? 'primary' : ''}`} disabled={working} onClick={() => (mode === 'open' ? reset() : (reset(), setMode('open')))}>
            {seed ? 'Test backup' : 'Load from backup'}
          </button>
        )}
        {!slot.registered && (
          <button
            className="btn xs"
            disabled={!ready || busy || !slot.tested || !seed}
            title={!slot.tested ? 'Test the backup first' : undefined}
            onClick={() => void run(`Register ${name.toLowerCase()}`, async () => ((await isRegistered(slot.recordId)) ? null : registerKeyTx(keyFromSeed(seed!)))).then(recheck)}
          >
            Register
          </button>
        )}
        {slot.seed && slot.tested && r.g !== 'primary' && r.g !== 'nextPrimary' && (
          <button className="btn ghost xs" onClick={() => (mode === 'remove' ? reset() : (reset(), setMode('remove')))}>
            Remove from browser
          </button>
        )}
      </div>

      {mode === 'backup' && seed && (
        <form
          className="tn-inline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw.length < MIN_PASSWORD) return setErr(`Use at least ${MIN_PASSWORD} characters.`);
            if (pw !== pw2) return setErr('The passwords do not match.');
            setErr(null);
            setProgress(0);
            try {
              const f = await encryptKey(seed, name, pw, (x) => setProgress(x));
              downloadJson(f, keyFileName(name, slot.recordId));
              update((p) => patchSlot(p, r, (s) => ({ ...s, backedUp: true, tested: false })));
              note('ok', `${name}: backup downloaded. Now test it by opening the file.`);
              reset();
              setMode('open');
            } catch (x) {
              setErr((x as Error).message);
              setProgress(null);
            }
          }}
        >
          <p className="small muted">Pick a password only you know, different for each key. Nobody can reset it; without it the file is useless.</p>
          <div className="field">
            <label htmlFor={`${id}-pw`}>Password for this key</label>
            <input id={`${id}-pw`} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-pw2`}>Repeat password</label>
            <input id={`${id}-pw2`} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          {err && <p className="small tn-err">{err}</p>}
          <div className="row">
            <button className="btn primary sm" disabled={working}>
              {working ? `Encrypting… ${Math.round((progress ?? 0) * 100)}%` : 'Encrypt and download'}
            </button>
            <button type="button" className="btn ghost sm" disabled={working} onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'open' && (
        <form
          className="tn-inline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!file) return setErr('Choose the backup file.');
            setErr(null);
            setProgress(0);
            try {
              const kf = parseKeyFile(JSON.parse(await file.text()));
              if (!eq(kf.recordId, slot.recordId)) throw new Error(`That file holds a different key (${short(kf.recordId)}), not ${name.toLowerCase()}.`);
              const opened = await decryptKey(kf, pw, (x) => setProgress(x));
              if (!signTest(opened)) throw new Error('The restored key could not sign a test message.');
              update((p) => patchSlot(p, r, (s) => ({ ...s, backedUp: true, tested: true, ...(!s.seed && keepsSeed(r) ? { seed: opened } : {}) })));
              if (!slot.seed && !keepsSeed(r)) putSession(slot.recordId, opened);
              note('ok', seed ? `${name}: the backup opened and signed a test message.` : `${name}: loaded from its backup${keepsSeed(r) ? '' : ' for this visit'}.`);
              reset();
            } catch (x) {
              setErr(x instanceof SyntaxError ? 'That file is not a Quanlet key backup.' : (x as Error).message);
              setProgress(null);
            }
          }}
        >
          <p className="small muted">
            {seed
              ? 'Choose the file you just saved and type its password. The page opens it, checks the key inside, and signs a test message.'
              : keepsSeed(r)
                ? 'Choose this key’s backup file. It is checked, then kept in this browser so it can sign.'
                : 'Choose this key’s backup file. It is checked and kept in memory only until you leave the page.'}
          </p>
          <div className="field">
            <input ref={fileRef} id={`${id}-file`} type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label={`${name} backup file`} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-open`}>Password</label>
            <input id={`${id}-open`} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
          {err && <p className="small tn-err">{err}</p>}
          <div className="row">
            <button className="btn primary sm" disabled={working}>
              {working ? `Opening… ${Math.round((progress ?? 0) * 100)}%` : seed ? 'Open and test' : 'Load key'}
            </button>
            <button type="button" className="btn ghost sm" disabled={working} onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'remove' && (
        <div className="tn-inline">
          <p className="small">The backup file becomes the only copy of {name.toLowerCase()}. You will load it when two recovery keys must sign.</p>
          <div className="row">
            <button
              className="btn sm"
              onClick={() => {
                update((p) => patchSlot(p, r, ({ seed: _s, ...rest }) => rest));
                note('ok', `${name} removed from this browser.`);
                reset();
              }}
            >
              Remove
            </button>
            <button className="btn ghost sm" onClick={reset}>
              Keep
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// -------------------------------------------------------------------- vault

function VaultPanel({
  profile,
  view,
  viewErr,
  now,
  busy,
  ready,
  run,
  refresh,
}: {
  profile: Profile;
  view: VaultView | null;
  viewErr: string | null;
  now: number;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  refresh: () => Promise<void>;
}) {
  const me = useWallet((s) => s.address);
  const update = useProfile((s) => s.update);
  const seedOf = useSeedOf();
  const vault = profile.vault!;
  const [dep, setDep] = useState('0.001');
  const [depOk, setDepOk] = useState(false);
  const [amt, setAmt] = useState('');
  const [to, setTo] = useState('');
  const [review, setReview] = useState<{ recipient: Address; amount: bigint } | null>(null);
  const recipient = (to.trim() || me || '') as string;
  const amountOk = (() => {
    try {
      return amt !== '' && parseEther(amt) > 0n;
    } catch {
      return false;
    }
  })();
  const pending = view?.status === 1;
  const seed = seedOf(profile.primary);
  const primary: QKey | null = seed ? keyFromSeed(seed) : null;
  const primaryMatches = !view || eq(view.primaryRecord, profile.primary.recordId);
  const canSign = !!primary && primaryMatches;
  const rows = useMemo(() => (view ? [...view.withdrawals].reverse() : []), [view]);
  useEffect(() => {
    if (!pending) setDepOk(false);
  }, [pending]);

  return (
    <section className="card stack tn-vault">
      <div className="tn-head">
        <h3>Your vault</h3>
        <span className={`chip ${pending ? 'warn' : 'ok'}`}>{view ? (pending ? 'Security change pending' : 'Active') : 'Loading…'}</span>
      </div>
      <dl className="kv">
        <dt>Address</dt>
        <dd>
          <Ext href={link(`address/${vault}`)}>{vault}</Ext>
        </dd>
        <dt>Balance</dt>
        <dd className="tn-big">{view ? `${formatEther(view.balance)} ETH` : '…'}</dd>
        <dt>Delay</dt>
        <dd>24 hours, then 7 days to execute</dd>
      </dl>
      {viewErr && <p className="small tn-err">{viewErr}</p>}
      {!primaryMatches && (
        <div className="notice warn">
          <span>The vault's primary key is not the one saved in this browser. Import the right backup to sign withdrawals.</span>
        </div>
      )}
      {primaryMatches && !primary && (
        <div className="notice warn">
          <span>Load the primary key from its backup file (in Your keys) to schedule, cancel or freeze withdrawals.</span>
        </div>
      )}

      <div className="tn-forms">
        <form
          className="tn-form"
          onSubmit={(e) => {
            e.preventDefault();
            let v: bigint;
            try {
              v = parseEther(dep);
            } catch {
              return;
            }
            if (pending && !depOk) return;
            void run('Deposit', async () => depositTx(vault, v)).then(refresh);
          }}
        >
          <h4>Deposit</h4>
          {pending && (
            <div className="notice warn tn-depwarn">
              <span>
                <strong>A security change is pending.</strong>
                Someone used two recovery keys to change this vault's keys. Withdrawals are frozen, and if you did not start it, new funds would go under the new keys
                once it is finalized. Cancel it first unless you started it.
              </span>
              <label className="tn-check">
                <input type="checkbox" checked={depOk} onChange={(e) => setDepOk(e.target.checked)} /> I started this change and still want to deposit
              </label>
            </div>
          )}
          <div className="field">
            <label htmlFor="tn-dep">Amount (ETH)</label>
            <input id="tn-dep" className="mono" inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} />
          </div>
          <button className="btn" disabled={!ready || busy || (pending && !depOk)}>
            {pending ? 'Deposit anyway' : 'Deposit to vault'}
          </button>
        </form>

        {!review ? (
          <form
            className="tn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!amountOk || !isAddress(recipient)) return;
              setReview({ recipient: recipient as Address, amount: parseEther(amt) });
            }}
          >
            <h4>Withdraw</h4>
            <div className="field">
              <label htmlFor="tn-amt">Amount (ETH)</label>
              <input id="tn-amt" className="mono" inputMode="decimal" placeholder="0.0005" value={amt} onChange={(e) => setAmt(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="tn-to">Recipient</label>
              <input id="tn-to" className="mono" placeholder={me ?? '0x…'} value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={to !== '' && !isAddress(to.trim())} />
            </div>
            <button className="btn primary" disabled={!ready || busy || pending || !amountOk || !isAddress(recipient) || !canSign}>
              Review withdrawal
            </button>
            <p className="small muted">You check every detail before the primary key signs.</p>
          </form>
        ) : (
          <div className="tn-form tn-review" aria-label="Review withdrawal">
            <h4>Check before signing</h4>
            <dl className="kv">
              <dt>Network</dt>
              <dd>
                {TARGET_NAME} ({TARGET_CHAIN})
              </dd>
              <dt>From vault</dt>
              <dd>{vault}</dd>
              <dt>To</dt>
              <dd className="tn-strong">{review.recipient}</dd>
              <dt>Amount</dt>
              <dd className="tn-strong">{formatEther(review.amount)} ETH</dd>
              <dt>Fee</dt>
              <dd>0 ETH (no relayer)</dd>
              <dt>Executable</dt>
              <dd>after about {when((view?.now || Math.floor(Date.now() / 1000)) + DAY)}</dd>
              <dt>Window</dt>
              <dd>7 days after that, then it expires</dd>
              <dt>Signed by</dt>
              <dd>Primary key {short(view?.primaryKeyId ?? profile.primary.recordId)}</dd>
            </dl>
            {eq(review.recipient, vault) && <p className="small tn-err">The recipient is the vault itself.</p>}
            {view && review.amount > view.balance && <p className="small tn-err">This is more than the vault holds now. Execution will fail unless you deposit more first.</p>}
            {me && !eq(review.recipient, me) && <p className="small muted">The recipient is not your connected wallet. Check the address character by character.</p>}
            <div className="row">
              <button
                className="btn primary"
                disabled={!ready || busy || pending || !canSign}
                onClick={() => {
                  const rv = review;
                  let id: Hex | null = null;
                  void run(
                    'Schedule withdrawal',
                    async () => {
                      const r = await scheduleTx(vault, primary!, rv.recipient, rv.amount);
                      id = r.id;
                      return r.tx;
                    },
                    (rc) => {
                      const ev = eventsOf(rc, VAULT_ABI).find((x) => x.eventName === 'WithdrawalScheduled');
                      const wid = ((ev?.args.id as Hex | undefined) ?? id)!;
                      update((p) => ({ ...p, withdrawals: p.withdrawals.includes(wid) ? p.withdrawals : [...p.withdrawals, wid] }));
                      setAmt('');
                      setReview(null);
                    },
                  ).then(refresh);
                }}
              >
                Sign and schedule
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setReview(null)}>
                Edit
              </button>
            </div>
          </div>
        )}
      </div>

      <h4>Withdrawals</h4>
      {rows.length === 0 ? (
        <p className="small muted">No withdrawals yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="tn-table">
            <thead>
              <tr>
                <th>Amount</th>
                <th>To</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const stale = x.status === 1 && view && x.epoch !== view.executionEpoch;
                const queued = x.status === 1 && !stale;
                const mature = queued && now >= Number(x.executableAt);
                const expired = queued && now >= Number(x.expiresAt);
                const label =
                  x.status === 2
                    ? 'Executed'
                    : x.status === 3
                      ? 'Cancelled'
                      : x.status === 0
                        ? 'Removed'
                        : stale
                          ? 'Invalidated'
                          : expired
                            ? 'Expired'
                            : mature
                              ? 'Ready to execute'
                              : `Waiting · ${left(Number(x.executableAt) - now)}`;
                return (
                  <tr key={x.id}>
                    <td className="mono">{formatEther(x.amount)} ETH</td>
                    <td className="mono" title={x.recipient}>
                      {short(x.recipient)}
                    </td>
                    <td>{label}</td>
                    <td className="tn-actions">
                      {queued && mature && !expired && (
                        <button className="btn primary sm" disabled={!ready || busy || pending} onClick={() => void run('Execute withdrawal', async () => executeTx(vault, x.id)).then(refresh)}>
                          Execute
                        </button>
                      )}
                      {queued && !expired && (
                        <button className="btn ghost sm" disabled={!ready || busy || !canSign} onClick={() => void run('Cancel withdrawal', () => cancelTx(vault, primary!, x.id)).then(refresh)}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button className="btn ghost sm" onClick={() => void refresh()}>
          Refresh
        </button>
        {view?.status === 0 && rows.some((x) => x.status === 1 && x.epoch === view.executionEpoch) && (
          <button className="btn ghost sm" disabled={!ready || busy || !canSign} onClick={() => void run('Freeze pending withdrawals', () => invalidateTx(vault, primary!)).then(refresh)}>
            Freeze all pending
          </button>
        )}
      </div>
    </section>
  );
}

/** What the vault is, read from the chain: the keys and counters that every signature is bound to. */
function ConfigPanel({ profile, view }: { profile: Profile; view: VaultView }) {
  const me = useWallet((s) => s.address);
  const localPrimary = eq(view.primaryRecord, profile.primary.recordId);
  const localRecovery = view.recoveryRecords.every((r, i) => eq(r, profile.recovery[i]!.recordId));
  return (
    <section className="card stack">
      <details className="tn-config">
        <summary>
          <h3>Vault configuration</h3>
          <span className="small muted">Read from the chain</span>
        </summary>
        <dl className="kv">
          <dt>Network</dt>
          <dd>
            {TARGET_NAME} ({TARGET_CHAIN})
          </dd>
          <dt>Connected wallet</dt>
          <dd>{me ?? 'Not connected'}</dd>
          <dt>Vault</dt>
          <dd>{profile.vault}</dd>
          <dt>Protocol version</dt>
          <dd>1</dd>
          <dt>Vault factory</dt>
          <dd>
            <Ext href={link(`address/${DEPLOYMENT.vaultFactory}`)}>{DEPLOYMENT.vaultFactory}</Ext>
          </dd>
          <dt>Key factory</dt>
          <dd>{DEPLOYMENT.keyFactory}</dd>
          <dt>Verifier</dt>
          <dd>{DEPLOYMENT.verifier}</dd>
          <dt>Primary key id</dt>
          <dd>
            {view.primaryKeyId} {localPrimary ? <span className="chip ok">matches this browser</span> : <span className="chip warn">not the local key</span>}
          </dd>
          {view.recoveryKeyIds.map((k, i) => (
            <FragmentKV key={k} label={`Recovery key ${i + 1} id`} value={k} />
          ))}
          <dt>Recovery set</dt>
          <dd>{localRecovery ? <span className="chip ok">matches this browser</span> : <span className="chip warn">differs from this browser</span>}</dd>
          <dt>Authority epoch</dt>
          <dd>{view.authorityEpoch.toString()}</dd>
          <dt>Execution epoch</dt>
          <dd>{view.executionEpoch.toString()}</dd>
          <dt>Withdrawal delay</dt>
          <dd>24 hours, 7-day window</dd>
          <dt>Security change delay</dt>
          <dd>7 days, 7-day window</dd>
        </dl>
      </details>
    </section>
  );
}
function FragmentKV({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

// -------------------------------------------------------------------- recovery

function RecoveryPanel({
  profile,
  view,
  now,
  busy,
  ready,
  run,
  refresh,
  recheck,
  checking,
  note,
}: {
  profile: Profile;
  view: VaultView;
  now: number;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  refresh: () => Promise<void>;
  recheck: () => Promise<void>;
  checking: boolean;
  note: (k: 'ok' | 'err', t: string) => void;
}) {
  const update = useProfile((s) => s.update);
  const seedOf = useSeedOf();
  const vault = profile.vault!;
  const [pair, setPair] = useState<[number, number]>([0, 1]);
  const [task, setTask] = useState<'primary' | 'recovery'>('primary');
  const pending = view.status === 1;
  const p = view.proposal;
  const recoveryMatches = view.recoveryRecords.every((r, i) => eq(r, profile.recovery[i]!.recordId));
  const pairSeeds = pair.map((i) => seedOf(profile.recovery[i]));
  const missing = pair.filter((_, j) => !pairSeeds[j]).map((i) => i + 1);
  const quorum = (): [QKey, QKey] => [keyFromSeed(pairSeeds[0]!), keyFromSeed(pairSeeds[1]!)];
  const primarySeed = seedOf(profile.primary);
  const nextP = profile.nextPrimary;
  const nextR = profile.nextRecovery;
  const ok = (s?: KeySlot) => !!s && s.registered && !!s.tested;
  const expired = pending && now >= Number(p.expiresAt);
  const canFinalize = pending && now >= Number(p.executableAt) && !expired;

  return (
    <section className="card stack tn-wide">
      <h3>Recovery and key changes</h3>
      <p className="muted">
        Any two recovery keys can install a new primary key. The primary and two recovery keys together can replace all three recovery keys. Each change waits 7
        days, freezes withdrawals, and can be cancelled by two recovery keys in that time.
      </p>
      {!recoveryMatches && (
        <div className="notice warn">
          <span>The vault's recovery keys differ from the ones saved here. Import the right vault info file.</span>
        </div>
      )}
      <div className="field">
        <label htmlFor="tn-pair">Recovery keys that sign</label>
        <select id="tn-pair" value={pair.join(',')} onChange={(e) => setPair(e.target.value.split(',').map(Number) as [number, number])}>
          <option value="0,1">Recovery keys 1 and 2</option>
          <option value="0,2">Recovery keys 1 and 3</option>
          <option value="1,2">Recovery keys 2 and 3</option>
        </select>
        {missing.length > 0 && (
          <p className="small muted">
            Recovery key {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} not loaded. Use “Load from backup” in Your keys.
          </p>
        )}
      </div>

      {!pending && (
        <>
          <div className="seg" role="tablist" aria-label="Change">
            <button role="tab" aria-selected={task === 'primary'} className={`btn sm ${task === 'primary' ? '' : 'ghost'}`} onClick={() => setTask('primary')}>
              Replace the primary key
            </button>
            <button role="tab" aria-selected={task === 'recovery'} className={`btn sm ${task === 'recovery' ? '' : 'ghost'}`} onClick={() => setTask('recovery')}>
              Replace the recovery keys
            </button>
          </div>

          {task === 'primary' &&
            (!nextP ? (
              <button className="btn" disabled={busy} onClick={() => update((q) => ({ ...q, nextPrimary: slotFor(newSeed()) }))}>
                Prepare a new primary key
              </button>
            ) : (
              <>
                <ul className="tn-keylist">
                  <KeyRow profile={profile} r={{ g: 'nextPrimary' }} busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
                </ul>
                <button
                  className="btn primary"
                  disabled={!ready || busy || !recoveryMatches || missing.length > 0 || !ok(nextP)}
                  onClick={() => void run('Start recovery', () => startRecoveryTx(vault, quorum(), pair, nextP.recordId)).then(refresh)}
                >
                  Start recovery to the new primary
                </button>
                {!ok(nextP) && <p className="small muted">Back up, test and register the new primary key first.</p>}
              </>
            ))}

          {task === 'recovery' &&
            (!nextR ? (
              <button
                className="btn"
                disabled={busy}
                onClick={() => update((q) => ({ ...q, nextRecovery: [slotFor(newSeed()), slotFor(newSeed()), slotFor(newSeed())] }))}
              >
                Prepare three new recovery keys
              </button>
            ) : (
              <>
                <div className="tn-head">
                  <span className="small muted">New recovery set</span>
                  <button className="btn ghost xs" disabled={checking} onClick={() => void recheck()}>
                    {checking ? 'Checking…' : 'Re-check'}
                  </button>
                </div>
                <ul className="tn-keylist">
                  {[0, 1, 2].map((i) => (
                    <KeyRow key={i} profile={profile} r={{ g: 'nextRecovery', i }} busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
                  ))}
                </ul>
                <button
                  className="btn primary"
                  disabled={!ready || busy || !recoveryMatches || missing.length > 0 || !primarySeed || !nextR.every(ok)}
                  onClick={() =>
                    void run('Start recovery key replacement', () =>
                      replaceRecoverySetTx(vault, keyFromSeed(primarySeed!), quorum(), pair, nextR.map((s) => s.recordId) as [Hex, Hex, Hex]),
                    ).then(refresh)
                  }
                >
                  Sign with primary and two recovery keys
                </button>
                {!nextR.every(ok) && <p className="small muted">Back up, test and register all three new keys first.</p>}
                {!primarySeed && <p className="small muted">The primary key must be loaded too.</p>}
              </>
            ))}
        </>
      )}

      {pending && (
        <>
          <dl className="kv">
            <dt>Change</dt>
            <dd>{p.kind === 1 ? `New primary key ${short(p.newRecords[0]!)}` : `New recovery keys ${p.newRecords.map((x) => short(x)).join(', ')}`}</dd>
            <dt>Started by this browser</dt>
            <dd>
              {(p.kind === 1 && eq(p.newRecords[0], nextP?.recordId)) || (p.kind === 2 && nextR?.every((s, i) => eq(s.recordId, p.newRecords[i])))
                ? 'Yes, the new keys are here'
                : 'No. If you did not start this, cancel it'}
            </dd>
            <dt>Can finalize</dt>
            <dd>{expired ? 'Window closed' : now >= Number(p.executableAt) ? 'Now' : `in ${left(Number(p.executableAt) - now)} (${when(Number(p.executableAt))})`}</dd>
            <dt>Expires</dt>
            <dd>{expired ? 'Expired' : `in ${left(Number(p.expiresAt) - now)}`}</dd>
          </dl>
          <div className="row">
            {!expired ? (
              <button className="btn primary" disabled={!ready || busy || !canFinalize} onClick={() => void run('Finalize security change', async () => finalizeTx(vault)).then(refresh)}>
                Finalize
              </button>
            ) : (
              <button className="btn primary" disabled={!ready || busy} onClick={() => void run('Clear expired change', async () => expireTx(vault)).then(refresh)}>
                Clear expired change
              </button>
            )}
            <button
              className="btn ghost"
              disabled={!ready || busy || !recoveryMatches || missing.length > 0}
              onClick={() => void run('Cancel security change', () => cancelSecurityTx(vault, quorum(), pair, p.id)).then(refresh)}
            >
              Cancel with recovery keys
            </button>
          </div>
          {expired && <p className="small muted">Nobody finalized it in time. Anyone can clear it, which unfreezes the vault; the old keys stay in charge.</p>}
        </>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- backup

function ImportButton({ onImport }: { onImport: (p: Profile) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            const raw = JSON.parse(await f.text());
            if (raw?.format === 'quanlet-mldsa44-key') {
              setMsg({ bad: true, text: 'That is a key backup. Open your vault first, then use “Load from backup” on the matching key.' });
              return;
            }
            const p = validate(raw);
            if (!p) throw new Error();
            onImport(p);
            setMsg(
              hasSeeds(p)
                ? { bad: true, text: 'Imported. This older file holds keys without a password: make encrypted backups of each key, then delete the old file.' }
                : null,
            );
          } catch {
            setMsg({ bad: true, text: 'That file is not a Quanlet vault info file for this deployment.' });
          }
        }}
      />
      <button className="btn ghost sm" onClick={() => ref.current?.click()}>
        Import vault info file
      </button>
      {msg && <p className={`small ${msg.bad ? 'tn-err' : ''}`}>{msg.text}</p>}
    </div>
  );
}

function BackupPanel({ profile, onImport, onForget }: { profile: Profile; onImport: (p: Profile) => void; onForget: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="card stack">
      <h3>Vault info</h3>
      <p className="muted">
        The vault info file lists the vault address, key ids and your withdrawals. It holds no keys, so it is safe to keep with your notes. To use the vault on another
        device, import it there, then load each key from its own backup file.
      </p>
      <div className="row">
        <button className="btn sm" onClick={() => downloadJson(vaultInfo(profile), `quanlet-testnet-vault-${(profile.vault ?? 'new').slice(0, 10)}.json`)}>
          Download vault info
        </button>
        <ImportButton onImport={onImport} />
      </div>
      {!confirm ? (
        <button className="btn ghost sm" onClick={() => setConfirm(true)}>
          Remove everything from this browser
        </button>
      ) : (
        <div className="notice warn">
          <span>This deletes the vault details and every key kept here. Without the key backup files you cannot use this vault again.</span>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => { onForget(); setConfirm(false); }}>
              Remove
            </button>
            <button className="btn ghost sm" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
