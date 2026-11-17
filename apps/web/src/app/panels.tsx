import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatEther, formatUnits, isAddress, parseUnits, type Address, type Hex } from 'viem';
import { PageFacts, PageKicker, PageMark } from '../components/PageMarks';
import { TARGET_CHAIN, TARGET_NAME, short, useWallet } from '../wallet';
import { ChainError, eventsOf, keyFromSeed, newSeed, send, type QKey, type Tx } from '../testnet/chain';
import { MIN_PASSWORD, downloadJson, signTest, useSessionKeys } from '../testnet/keyfile';
import {
  ASSETS,
  DELAYS,
  ERRORS,
  ETH,
  KEY_FACTORY,
  ROLE,
  ROUTE,
  STATE,
  V2,
  VAULT_ABI,
  VAULT_FACTORY,
  VAULT_FACTORY_ABI,
  buildPolicy,
  cancelAdminTx,
  cancelRecoveryTx,
  cancelTx,
  chainNowSafe,
  createVaultTx,
  depositTx,
  encodePolicy,
  executeTx,
  pruneTx,
  expireTx,
  finalizeTx,
  findPendingPolicy,
  pendingPolicyFromTx,
  invalidateTx,
  isVaultV2,
  keyIdOf,
  keyStatus,
  loadVault,
  policyFromJson,
  policyHash,
  policyToJson,
  registerKeyTx,
  startRecoveryTx,
  suspendFastTx,
  transferTx,
  updatePolicyTx,
  assetOf,
  exportSigned,
  fmt,
  parseSigned,
  replaceGuardiansTx,
  replaceSpendingTx,
  signTransfer,
  submitTx,
  walletBalance,
  type Asset,
  type SignedTransfer,
  type Transfer,
  type Policy,
  type PolicyChoice,
  type RoleKeys,
  type VaultView,
} from '../testnet/v2/chain';
import { decryptKeyV2, encryptKeyV2, keyFileNameV2, parseKeyFileV2 } from '../testnet/v2/keyfile';
import {
  DEFAULT_DRAFT,
  LABEL,
  NEXT_NAMES,
  ROLE_NAMES,
  getSlot,
  patchSlot,
  useProfileV2,
  validateV2,
  vaultInfoV2,
  type HistoryItem,
  type NextName,
  type PolicyDraft,
  type RuleDraft,
  type ProfileV2,
  type RoleName,
  type Slot,
  type SlotName,
} from '../testnet/v2/profile';
import { Ext, WalletCard, eq, left, link, when, type Activity } from '../pages/Testnet';
import { IS_MAINNET, WORDS } from '../net';
import { RiskNotice, riskAccepted } from './RiskNotice';

export const DELAY_TEXT: Record<number, string> = { 0: 'No delay', 3600: '1 hour', 86400: '24 hours', 259200: '72 hours' };
export const STATE_TEXT: Record<number, string> = {
  [STATE.Active]: 'Active',
  [STATE.PendingPolicy]: 'Policy change pending',
  [STATE.PendingSpendingKeys]: 'Key rotation pending',
  [STATE.PendingRecovery]: 'Recovery pending',
  [STATE.PendingGuardians]: 'Guardian change pending',
};

export function slotFor(seed: Hex): Slot {
  return { seed, keyId: keyIdOf(keyFromSeed(seed)), ready: false, backedUp: false, tested: false };
}
/** Keys that sign often stay in the browser once loaded; the approver and guardians stay in memory for the visit. */
export const keepsSeed = (n: SlotName) => n === 'p' || n === 'np' || n === 'na';

export function useSeedOf() {
  const seeds = useSessionKeys((s) => s.seeds);
  return useCallback((s?: Slot) => (s ? s.seed ?? seeds[s.keyId.toLowerCase()] : undefined), [seeds]);
}

export function unitsOk(v: string, decimals = 18) {
  try {
    return v.trim() !== '' && parseUnits(v.trim(), decimals) > 0n;
  } catch {
    return false;
  }
}
export const units = (v: string, decimals = 18) => parseUnits(v.trim(), decimals);
export const ethOk = (v: string) => unitsOk(v, 18);
export const assetsOfVault = (view: VaultView | null): Asset[] => (view ? view.assets.map((x) => assetOf(x.asset)) : ASSETS);
export const ruleOf = (d: PolicyDraft, a: Asset) => d.rules[a.address.toLowerCase()];

/** Plain checks on a policy draft before anything is signed. Returns a problem or null. */
export function draftProblem(d: PolicyDraft, assets: Asset[], fallbackRecipient?: string): string | null {
  if (!d.fast) return null;
  const used = assets.filter((a) => {
    const r = ruleOf(d, a);
    return r && (r.ceiling.trim() || r.cap.trim());
  });
  if (used.length === 0) return 'Give at least one asset a FAST allowance, or turn FAST off.';
  for (const a of used) {
    const r = ruleOf(d, a)!;
    if (!unitsOk(r.ceiling, a.decimals)) return `Enter a ${a.symbol} allowance above zero (or clear both ${a.symbol} fields).`;
    if (!unitsOk(r.cap, a.decimals)) return `Enter a ${a.symbol} per-transfer limit above zero.`;
    if (units(r.cap, a.decimals) > units(r.ceiling, a.decimals)) return `The ${a.symbol} per-transfer limit is larger than its allowance.`;
  }
  const r = d.recipients.length ? d.recipients : fallbackRecipient ? [fallbackRecipient] : [];
  if (r.length === 0) return 'Add at least one FAST recipient.';
  if (r.length > 16) return 'At most 16 FAST recipients.';
  if (r.some((a) => !isAddress(a))) return 'One of the FAST recipients is not a valid address.';
  if (d.maxFee.trim() || d.feeRecipients.length) {
    if (!ethOk(d.maxFee)) return 'Enter the largest relayer fee FAST may pay (ETH), or clear the relayer fields.';
    if (d.feeRecipients.length === 0) return 'Add at least one relayer that FAST may pay.';
    if (d.feeRecipients.length > 8) return 'At most 8 relayers.';
    if (d.feeRecipients.some((a) => !isAddress(a))) return 'One of the relayer addresses is not valid.';
  }
  return null;
}
export function choiceOf(d: PolicyDraft, assets: Asset[], fallbackRecipient?: string): PolicyChoice {
  return {
    delay: d.delay,
    fast: d.fast,
    days: d.days,
    recipients: d.recipients.length ? d.recipients : fallbackRecipient ? [fallbackRecipient] : [],
    rules: d.fast
      ? assets.flatMap((a) => {
          const r = ruleOf(d, a);
          return r && unitsOk(r.ceiling, a.decimals) && unitsOk(r.cap, a.decimals) ? [{ asset: a.address, ceiling: units(r.ceiling, a.decimals), cap: units(r.cap, a.decimals) }] : [];
        })
      : [],
    maxFee: d.fast && ethOk(d.maxFee) ? units(d.maxFee) : 0n,
    feeRecipients: d.feeRecipients,
  };
}
export const spentMap = (v: VaultView) => Object.fromEntries(v.assets.map((x) => [x.asset.toLowerCase(), x.spent]));

export type RunFn = (label: string, step: () => Promise<Tx | null>, after?: (r: Awaited<ReturnType<typeof send>>) => void) => Promise<boolean>;
export type Note = (k: 'ok' | 'err', t: string) => void;

// -------------------------------------------------------------------- start

export function newProfile(): ProfileV2 {
  return {
    version: 2,
    chainId: TARGET_CHAIN,
    keyFactory: KEY_FACTORY,
    vaultFactory: VAULT_FACTORY,
    keys: Object.fromEntries(ROLE_NAMES.map((n) => [n, slotFor(newSeed())])) as ProfileV2['keys'],
    draft: { ...DEFAULT_DRAFT },
    withdrawals: [],
    history: [],
    createdAt: Date.now(),
  };
}

export function StartCard({ onCreate, onImport, note, openOnly }: { onCreate: (p: ProfileV2) => void; onImport: (p: ProfileV2) => void; note: Note; openOnly?: boolean }) {
  const [addr, setAddr] = useState('');
  const [opening, setOpening] = useState(false);
  const openForm = (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        const a = addr.trim();
        if (!isAddress(a)) return;
        setOpening(true);
        try {
          if (!(await isVaultV2(a as Address))) throw new Error('No protocol 2.0 vault at that address on this network. A 1.0 vault opens on the 1.0 page.');
          const v = await loadVault(a as Address, []);
          const s = (keyId: Hex): Slot => ({ keyId, ready: true, backedUp: true, tested: false });
          onImport({
            ...newProfile(),
            keys: Object.fromEntries(ROLE_NAMES.map((n, i) => [n, s(v.roles[i]!)])) as ProfileV2['keys'],
            vault: a as Address,
          });
          note('ok', 'Vault opened. Load the primary key (and the approver for protected transfers) from their backup files.');
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
  );
  if (openOnly)
    return (
      <section className="card stack">
        <h3>Open a vault you already have</h3>
        <p className="small muted">Enter its address, then load its keys from their backup files. Or import the vault info file you saved.</p>
        {openForm}
        <ImportButton onImport={onImport} />
      </section>
    );
  return (
    <section className="card stack">
      <p className="muted">Your vault answers to five post-quantum keys, each with one job:</p>
      <dl className="kv tn-roles">
        <dt>Primary (P)</dt>
        <dd>Signs every transfer. Alone, it can only send FAST: up to the allowance, to recipients you list.</dd>
        <dt>Approver (A)</dt>
        <dd>Co-signs everything else with the primary. On mainnet it belongs on a different device.</dd>
        <dt>Guardians (G1–G3)</dt>
        <dd>Any two can replace a lost primary and approver after 7 days. They can never move funds.</dd>
      </dl>
      <div className="notice warn">
        <span>Next you save each key to its own password-protected file and open it once to prove it works. {WORDS.keysWarning}</span>
      </div>
      <button className="btn primary" onClick={() => onCreate(newProfile())}>
        Create my five keys
      </button>
      <details className="tn-more">
        <summary>I already have a 2.0 vault</summary>
        <p className="small muted">Open it by address, then load its keys from their backup files. Or import a vault info file.</p>
        {openForm}
        <ImportButton onImport={onImport} />
      </details>
    </section>
  );
}

// -------------------------------------------------------------------- keys

export function KeysCard({
  profile,
  busy,
  ready,
  run,
  recheck,
  checking,
  note,
}: {
  profile: ProfileV2;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  recheck: () => Promise<void>;
  checking: boolean;
  note: Note;
}) {
  const seedOf = useSeedOf();
  const update = useProfileV2((s) => s.update);
  const pending = ROLE_NAMES.filter((n) => !profile.keys[n].ready);
  const canRegisterAll = pending.length > 0 && pending.every((n) => profile.keys[n].tested && seedOf(profile.keys[n]));
  const kept = (['a', 'g1', 'g2', 'g3'] as RoleName[]).filter((n) => profile.keys[n].seed);
  const safe = kept.every((n) => profile.keys[n].tested && profile.keys[n].ready);
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
        For each key: <b>Back up</b> saves it to a file locked with a password you choose, then <b>Test backup</b> opens that file to prove it works. Once all five are
        tested, register them: one transaction each, paid by your wallet.
      </p>
      <ul className="tn-keylist">
        {ROLE_NAMES.map((n) => (
          <KeyRow key={n} profile={profile} n={n} busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
        ))}
      </ul>
      {pending.length > 0 && (
        <div className="row">
          <button
            className="btn primary"
            disabled={!ready || busy || !canRegisterAll}
            onClick={async () => {
              for (const n of pending) {
                const s = useProfileV2.getState().profile!.keys[n];
                if (s.ready) continue;
                const seed = seedOf(s);
                if (!seed) break;
                const ok = await run(`Register ${LABEL[n].toLowerCase()}`, () => registerKeyTx(keyFromSeed(seed)));
                await recheck();
                if (!ok) break;
              }
            }}
          >
            Register {pending.length === 5 ? 'all five keys' : `the remaining ${pending.length === 1 ? 'key' : `${pending.length} keys`}`}
          </button>
          {!canRegisterAll && <span className="small muted">Back up and test every key first.</span>}
        </div>
      )}
      {profile.vault && kept.length > 0 && (
        <div className="notice">
          <span>
            {kept.map((n) => LABEL[n]).join(', ')} {kept.length === 1 ? 'is' : 'are'} still kept in this browser. The approver and guardians are safer only in their
            backup files, ideally on other devices. You load them when you need them.
          </span>
          {safe && (
            <div className="row" style={{ marginTop: 8 }}>
              {!confirm ? (
                <button className="btn sm" onClick={() => setConfirm(true)}>
                  Remove them from this browser
                </button>
              ) : (
                <>
                  <span className="small">Their backup files will be the only copies.</span>
                  <button
                    className="btn sm"
                    onClick={() => {
                      update((p) => kept.reduce((acc, n) => patchSlot(acc, n, ({ seed: _s, ...rest }) => rest), p));
                      setConfirm(false);
                      note('ok', 'Removed from this browser. Load each from its backup file when it must sign.');
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

export function KeyRow({ profile, n, busy, ready, run, recheck, note }: { profile: ProfileV2; n: SlotName; busy: boolean; ready: boolean; run: RunFn; recheck: () => Promise<void>; note: Note }) {
  const update = useProfileV2((s) => s.update);
  const putSession = useSessionKeys((s) => s.put);
  const seedOf = useSeedOf();
  const slot = getSlot(profile, n)!;
  const seed = seedOf(slot);
  const name = LABEL[n];
  const [mode, setMode] = useState<'none' | 'backup' | 'open' | 'remove'>('none');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reset = () => {
    setMode('none');
    setPw('');
    setPw2('');
    setFile(null);
    setErr(null);
    setProgress(null);
  };
  const working = progress !== null;
  const id = `k2-${n}`;
  const where = slot.seed ? 'In this browser' : seed ? 'Loaded for this visit' : 'Backup file only';
  return (
    <li className="tn-keyrow" data-key={name}>
      <div className="tn-keyline">
        <div>
          <strong>{name}</strong>
          <div className="mono small muted">{short(slot.keyId)}</div>
        </div>
        <div className="tn-chips">
          <span className={`chip ${slot.tested ? 'ok' : slot.backedUp ? 'warn' : 'bad'}`}>{slot.tested ? 'Backup tested' : slot.backedUp ? 'Backup not tested' : 'No backup'}</span>
          <span className={`chip ${slot.ready ? 'ok' : ''}`}>{slot.ready ? 'Registered' : 'Not registered'}</span>
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
        {!slot.ready && (
          <button
            className="btn xs"
            disabled={!ready || busy || !slot.tested || !seed}
            title={!slot.tested ? 'Test the backup first' : undefined}
            onClick={() => void run(`Register ${name.toLowerCase()}`, () => registerKeyTx(keyFromSeed(seed!))).then(recheck)}
          >
            Register
          </button>
        )}
        {slot.seed && slot.tested && !keepsSeed(n) && (
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
              const f = await encryptKeyV2(seed, name, pw, (x) => setProgress(x));
              downloadJson(f, keyFileNameV2(name, slot.keyId));
              update((p) => patchSlot(p, n, (s) => ({ ...s, backedUp: true, tested: false })));
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
              const kf = parseKeyFileV2(JSON.parse(await file.text()));
              if (!eq(kf.keyId, slot.keyId)) throw new Error(`That file holds a different key (${short(kf.keyId)}), not the ${name.toLowerCase()}.`);
              const opened = await decryptKeyV2(kf, pw, (x) => setProgress(x));
              if (!signTest(opened)) throw new Error('The restored key could not sign a test message.');
              update((p) => patchSlot(p, n, (s) => ({ ...s, backedUp: true, tested: true, ...(!s.seed && keepsSeed(n) ? { seed: opened } : {}) })));
              if (!slot.seed && !keepsSeed(n)) putSession(slot.keyId, opened);
              note('ok', seed ? `${name}: the backup opened and signed a test message.` : `${name}: loaded from its backup${keepsSeed(n) ? '' : ' for this visit'}.`);
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
              : keepsSeed(n)
                ? 'Choose this key’s backup file. It is checked, then kept in this browser so it can sign.'
                : 'Choose this key’s backup file. It is checked and kept in memory only until you leave the page.'}
          </p>
          <div className="field">
            <input id={`${id}-file`} type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label={`${name} backup file`} />
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
          <p className="small">The backup file becomes the only copy of the {name.toLowerCase()}. You load it when it must sign.</p>
          <div className="row">
            <button
              className="btn sm"
              onClick={() => {
                update((p) => patchSlot(p, n, ({ seed: _s, ...rest }) => rest));
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

// -------------------------------------------------------------------- policy form

export function PolicyFields({ d, set, me, idp, assets, topUp }: { d: PolicyDraft; set: (d: PolicyDraft) => void; me?: string | null; idp: string; assets: Asset[]; topUp?: boolean }) {
  const setRule = (a: Asset, k: keyof RuleDraft, v: string) => {
    const key = a.address.toLowerCase();
    set({ ...d, rules: { ...d.rules, [key]: { ceiling: '', cap: '', ...d.rules[key], [k]: v } } });
  };
  const list = (v: string) => v.split(/[\s,]+/).filter(Boolean);
  return (
    <div className="stack tn-policy">
      <div className="field">
        <label htmlFor={`${idp}-delay`}>Protected delay</label>
        <select id={`${idp}-delay`} value={d.delay} onChange={(e) => set({ ...d, delay: Number(e.target.value) })}>
          {DELAYS.map((x) => (
            <option key={x} value={x}>
              {DELAY_TEXT[x]}
            </option>
          ))}
        </select>
        <p className="small muted">How long a protected transfer (primary + approver) waits before it can be executed. Policy and key changes wait the same.</p>
      </div>
      <label className="tn-check">
        <input type="checkbox" checked={d.fast} onChange={(e) => set({ ...d, fast: e.target.checked })} /> Allow FAST transfers with the primary key alone
      </label>
      {d.fast && (
        <>
          <div className="tn-rules" role="group" aria-label="FAST allowance per asset">
            <div className="tn-rule tn-rule-head small muted" aria-hidden>
              <span>Asset</span>
              <span>{topUp ? 'New allowance' : 'Allowance (total)'}</span>
              <span>Per transfer (max)</span>
            </div>
            {assets.map((a) => {
              const r = ruleOf(d, a);
              return (
                <div className="tn-rule" key={a.address}>
                  <span className="mono" title={a.name}>
                    {a.symbol}
                  </span>
                  <input
                    className="mono"
                    inputMode="decimal"
                    aria-label={`${a.symbol} FAST allowance`}
                    placeholder="none"
                    value={r?.ceiling ?? ''}
                    onChange={(e) => setRule(a, 'ceiling', e.target.value)}
                  />
                  <input className="mono" inputMode="decimal" aria-label={`${a.symbol} per-transfer limit`} placeholder="none" value={r?.cap ?? ''} onChange={(e) => setRule(a, 'cap', e.target.value)} />
                </div>
              );
            })}
          </div>
          <p className="small muted">Leave an asset empty to keep it protected-only. The allowance never resets: once spent, both keys must grant more.</p>
          <div className="field">
            <label htmlFor={`${idp}-days`}>Valid for (days, up to 30)</label>
            <input id={`${idp}-days`} className="mono" inputMode="numeric" value={d.days} onChange={(e) => set({ ...d, days: Math.max(1, Math.min(30, Number(e.target.value.replace(/\D/g, '')) || 1)) })} />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-rec`}>FAST recipients (one address per line)</label>
            <textarea id={`${idp}-rec`} className="mono" rows={3} placeholder={me ?? '0x…'} value={d.recipients.join('\n')} onChange={(e) => set({ ...d, recipients: list(e.target.value) })} />
            <p className="small muted">{me ? 'Empty means your connected wallet only.' : 'Connect a wallet or add at least one address.'}</p>
          </div>
          <details className="tn-more" open={!!(d.maxFee || d.feeRecipients.length)}>
            <summary>Relayer fees (optional)</summary>
            <p className="small muted">
              A relayer can submit a signed transfer for you and be paid a fee in ETH from the vault. For FAST transfers the fee must go to a relayer listed here and stay
              under the maximum; it also counts against the ETH allowance. Protected transfers may pay any relayer.
            </p>
            <div className="field">
              <label htmlFor={`${idp}-fee`}>Largest FAST relayer fee (ETH)</label>
              <input id={`${idp}-fee`} className="mono" inputMode="decimal" placeholder="none" value={d.maxFee} onChange={(e) => set({ ...d, maxFee: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${idp}-relayers`}>Relayers FAST may pay (one address per line)</label>
              <textarea id={`${idp}-relayers`} className="mono" rows={2} placeholder="0x…" value={d.feeRecipients.join('\n')} onChange={(e) => set({ ...d, feeRecipients: list(e.target.value) })} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- setup

export function SetupCard({ profile, busy, ready, run, allReady }: { profile: ProfileV2; busy: boolean; ready: boolean; run: RunFn; allReady: boolean }) {
  const update = useProfileV2((s) => s.update);
  const me = useWallet((s) => s.address);
  const seedOf = useSeedOf();
  const d = profile.draft;
  const problem = draftProblem(d, ASSETS, me ?? undefined);
  const seeds = ROLE_NAMES.map((n) => seedOf(profile.keys[n]));
  const missing = ROLE_NAMES.filter((_, i) => !seeds[i]);
  return (
    <section className="card stack">
      <h3>Choose the policy and create the vault</h3>
      <p className="small">
        Two kinds of payment: <b>FAST</b> lets the primary key pay alone, but only up to an allowance and only to addresses you list. <b>Protected</b> payments need both
        keys and wait the delay you pick. You can change these rules later with both keys.
      </p>
      <p className="small muted">
        {ASSETS.length > 1
          ? `This vault can hold ETH and ${IS_MAINNET ? 'these tokens' : 'the test stock tokens from the official faucet'}: ${ASSETS.slice(1).map((a) => a.symbol).join(', ')}.`
          : 'This vault holds ETH.'}
      </p>
      <PolicyFields d={d} set={(x) => update((p) => ({ ...p, draft: x }))} me={me} idp="setup" assets={ASSETS} />
      {problem && <p className="small tn-err">{problem}</p>}
      <p className="muted small">
        All five keys sign the exact setup: the keys, this policy and the vault address. The factory checks the five signatures on chain, then deploys a vault that is
        fully configured from its first block.
      </p>
      {missing.length > 0 && <p className="small muted">Load {missing.map((n) => LABEL[n]).join(', ')} from {missing.length === 1 ? 'its backup' : 'their backups'} first.</p>}
      <button
        className="btn primary"
        disabled={!ready || busy || !allReady || !!problem || missing.length > 0}
        onClick={() => {
          const salt = profile.salt ?? newSeed();
          if (!profile.salt) update((p) => ({ ...p, salt }));
          let predicted: Address | null = null;
          void run(
            'Create vault',
            async () => {
              const policy = buildPolicy(choiceOf(d, ASSETS, me ?? undefined), await chainNowSafe());
              const r = await createVaultTx(seeds.map((s) => keyFromSeed(s!)) as RoleKeys, policy, salt);
              predicted = r.vault;
              return r.tx;
            },
            (rc) => {
              const ev = eventsOf(rc, VAULT_FACTORY_ABI).find((e) => e.eventName === 'VaultCreated');
              const vault = ((ev?.args.vault as Address | undefined) ?? predicted)!;
              update((p) => ({ ...p, vault, vaultFactory: VAULT_FACTORY }));
            },
          );
        }}
      >
        {allReady ? 'Sign with all five keys and create' : 'Register the five keys first'}
      </button>
    </section>
  );
}

// -------------------------------------------------------------------- vault

/** The keys this browser can sign with right now, checked against the vault's current roles. */
export function useSigners(profile: ProfileV2, view: VaultView | null) {
  const seedOf = useSeedOf();
  const pSeed = seedOf(profile.keys.p);
  const aSeed = seedOf(profile.keys.a);
  const pMatches = !view || eq(view.roles[0], profile.keys.p.keyId);
  const aMatches = !view || eq(view.roles[1], profile.keys.a.keyId);
  const P: QKey | null = pSeed && pMatches ? keyFromSeed(pSeed) : null;
  const A: QKey | null = aSeed && aMatches ? keyFromSeed(aSeed) : null;
  return { pSeed, aSeed, pMatches, aMatches, P, A, pending: !!view && view.state !== STATE.Active };
}

const liveRule = (now: number, r?: { budgetValidAfter: bigint; budgetValidUntil: bigint }) => !!r && now >= Number(r.budgetValidAfter) && now < Number(r.budgetValidUntil);

/** One line for each asset's FAST allowance, or why there is none. */
export function fastSummary(view: VaultView, now: number): Array<{ asset: Address; symbol: string; left: bigint; ceiling: bigint; cap: bigint; until: number; live: boolean }> {
  if (!view.policy.fastEnabled || view.fastSuspended) return [];
  return view.policy.assetRules.map((r) => ({
    asset: r.asset,
    symbol: assetOf(r.asset).symbol,
    left: view.assets.find((x) => eq(x.asset, r.asset))?.remaining ?? 0n,
    ceiling: r.ceiling,
    cap: r.perActionCap,
    until: Number(r.budgetValidUntil),
    live: liveRule(now, r),
  }));
}

/** Balances, state and limits at a glance. */
export function VaultSummary({ profile, view, viewErr, now }: { profile: ProfileV2; view: VaultView | null; viewErr: string | null; now: number }) {
  const { pSeed, pMatches, aMatches } = useSigners(profile, view);
  const vault = profile.vault!;
  const pending = !!view && view.state !== STATE.Active;
  const delay = view?.policy.protectedDelay ?? 0;
  const fast = view ? fastSummary(view, now) : [];
  return (
    <section className="card stack tn-vault tn-wide vs">
      <div className="tn-head">
        <h3>Your vault</h3>
        <span className={`chip ${pending ? 'warn' : 'ok'}`}>
          <span className="dot" aria-hidden /> {view ? STATE_TEXT[view.state] : 'Loading…'}
        </span>
      </div>
      <div className="vs-bal">
        <span className="vs-k">Balance</span>
        <span className="tn-big">{view ? `${formatEther(view.balance)} ETH` : '…'}</span>
        {view && view.assets.length > 1 && <span className="vs-tokens">{view.assets.slice(1).filter((x) => x.balance > 0n).map((x) => fmt(x.balance, x.asset)).join(' · ') || 'No tokens yet'}</span>}
      </div>
      <dl className="kv">
        <dt>Address</dt>
        <dd>
          <Ext href={link(`address/${vault}`)}>{vault}</Ext>
        </dd>
        <dt>FAST left</dt>
        <dd>
          {!view
            ? '…'
            : !view.policy.fastEnabled
              ? 'Off'
              : view.fastSuspended
                ? 'Suspended'
                : fast.length === 0
                  ? 'No allowance'
                  : fast.map((f) => `${fmt(f.left, f.asset)} (≤ ${formatUnits(f.cap, assetOf(f.asset).decimals)} each)`).join(' · ')}
        </dd>
        <dt>Protected</dt>
        <dd>{view ? (delay ? `Waits ${DELAY_TEXT[delay]}, then 7 days to execute` : 'Executes at once with both keys') : '…'}</dd>
      </dl>
      {viewErr && <p className="small tn-err">{viewErr}</p>}
      {(!pMatches || !aMatches) && (
        <div className="notice warn">
          <span>The vault’s {!pMatches ? 'primary' : 'approver'} key is not the one saved in this browser. Import the right backup or vault info file.</span>
        </div>
      )}
      {pMatches && !pSeed && (
        <div className="notice warn">
          <span>Load the primary key from its backup file (Vault › Keys) to send.</span>
        </div>
      )}
    </section>
  );
}

/** Move ETH or a supported token from the connected wallet into the vault. */
export function DepositForm({ profile, view, busy, ready, run, refresh }: { profile: ProfileV2; view: VaultView | null; busy: boolean; ready: boolean; run: RunFn; refresh: () => Promise<void> }) {
  const me = useWallet((s) => s.address);
  const vault = profile.vault!;
  const assets = assetsOfVault(view);
  const pending = !!view && view.state !== STATE.Active;
  const [depAsset, setDepAsset] = useState<Address>(ETH);
  const [dep, setDep] = useState('0.001');
  const [depOk, setDepOk] = useState(false);
  const [mine, setMine] = useState<bigint | null>(null);
  useEffect(() => {
    if (!pending) setDepOk(false);
  }, [pending]);
  useEffect(() => {
    let alive = true;
    setMine(null);
    if (me) void walletBalance(depAsset, me as Address).then((b) => alive && setMine(b)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [me, depAsset, busy]);
  const depA = assetOf(depAsset);
  const depAmount = unitsOk(dep, depA.decimals) ? units(dep, depA.decimals) : 0n;
  const tooMuch = mine !== null && depAmount > mine;
  const [risk, setRisk] = useState(() => !IS_MAINNET || riskAccepted());
  if (!risk) return <RiskNotice onAccept={() => setRisk(true)} />;
  return (
    <form
      className="tn-form card stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!depAmount || (pending && !depOk)) return;
        void run('Deposit', async () => depositTx(vault, depAsset, depAmount)).then(refresh);
      }}
    >
      <h3>Add funds</h3>
      <p className="small muted">From your connected wallet into the vault. Anyone can deposit; only your keys can take funds out.</p>
      {pending && (
        <div className="notice warn tn-depwarn">
          <span>
            <strong>A change is pending.</strong>
            Outflows are frozen. If you did not start this change, funds sent now would come under its new keys or policy once it is finalized. Cancel it first unless you
            started it.
          </span>
          <label className="tn-check">
            <input type="checkbox" checked={depOk} onChange={(e) => setDepOk(e.target.checked)} /> I started this change and still want to deposit
          </label>
        </div>
      )}
      <div className="row tn-two">
        {assets.length > 1 && (
          <div className="field">
            <label htmlFor="t2-dasset">Asset</label>
            <select id="t2-dasset" value={depAsset} onChange={(e) => setDepAsset(e.target.value as Address)}>
              {assets.map((a) => (
                <option key={a.address} value={a.address}>
                  {a.symbol} · {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="t2-dep">Amount ({depA.symbol})</label>
          <input id="t2-dep" className="mono" inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} aria-invalid={tooMuch} />
        </div>
      </div>
      {mine !== null && (
        <p className={`small ${tooMuch ? 'tn-err' : 'muted'}`}>
          Your wallet holds {fmt(mine, depAsset)}.{!IS_MAINNET && depAsset !== ETH && mine === 0n ? ' Get test stock tokens from the Robinhood faucet.' : ''}
        </p>
      )}
      <button className="btn primary" disabled={!ready || busy || !depAmount || (pending && !depOk) || tooMuch}>
        {pending ? 'Deposit anyway' : `Deposit ${depA.symbol}`}
      </button>
      {!ready && <p className="small muted">Connect your wallet to deposit.</p>}
    </form>
  );
}

/** Choose a route, fill in the payment, check it, then sign. */
export function SendForm({
  profile,
  view,
  now,
  busy,
  ready,
  run,
  refresh,
  note,
}: {
  profile: ProfileV2;
  view: VaultView | null;
  now: number;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  refresh: () => Promise<void>;
  note: Note;
}) {
  const me = useWallet((s) => s.address);
  const update = useProfileV2((s) => s.update);
  const { P, A, pending } = useSigners(profile, view);
  const vault = profile.vault!;
  const assets = assetsOfVault(view);
  const [asset, setAsset] = useState<Address>(ETH);
  const [amt, setAmt] = useState('');
  const [to, setTo] = useState('');
  const [route, setRoute] = useState<1 | 2>(ROUTE.FAST);
  const [feeTo, setFeeTo] = useState('');
  const [fee, setFee] = useState('');
  const [review, setReview] = useState<Transfer | null>(null);
  const [relayed, setRelayed] = useState<string | null>(null);
  const A_ = assetOf(asset);
  const recipient = (to.trim() || me || '') as string;
  const amount = unitsOk(amt, A_.decimals) ? units(amt, A_.decimals) : 0n;
  const feeOn = feeTo.trim() !== '' || fee.trim() !== '';
  const feeWei = feeOn && ethOk(fee) ? units(fee) : 0n;
  const feeProblem = feeOn ? (!isAddress(feeTo.trim()) ? 'Enter the relayer’s address.' : !ethOk(fee) ? 'Enter the relayer fee in ETH.' : null) : null;
  const av = view?.assets.find((x) => eq(x.asset, asset));
  const ethV = view?.assets.find((x) => x.asset === ETH);
  const rule = view?.policy.assetRules.find((r) => eq(r.asset, asset));
  const ethRule = view?.policy.assetRules.find((r) => r.asset === ETH);
  const fastOff = !view ? null : !view.policy.fastEnabled ? 'FAST is off in this vault’s rules.' : view.fastSuspended ? 'FAST is suspended. Grant a new allowance to resume it.' : null;
  const fastWhy = !view
    ? null
    : fastOff
      ? fastOff
      : !rule
          ? `There is no FAST allowance for ${A_.symbol}.`
          : !liveRule(now, rule)
            ? `The ${A_.symbol} allowance is outside its dates.`
            : amount > 0n && amount > rule.perActionCap
              ? `More than the per-transfer limit (${fmt(rule.perActionCap, asset)}).`
              : amount > 0n && asset === ETH && amount + feeWei > (av?.remaining ?? 0n)
                ? `More than the remaining allowance (${fmt(av?.remaining ?? 0n, asset)}${feeWei ? ', fee included' : ''}).`
                : amount > 0n && asset !== ETH && amount > (av?.remaining ?? 0n)
                  ? `More than the remaining allowance (${fmt(av?.remaining ?? 0n, asset)}).`
                  : isAddress(recipient) && !rule.recipients.some((r) => eq(r, recipient))
                    ? 'That recipient is not on the FAST list.'
                    : feeWei > 0n && feeWei > view.policy.maxFastFeeWei
                      ? `The fee is above the FAST maximum (${formatEther(view.policy.maxFastFeeWei)} ETH).`
                      : feeWei > 0n && !view.policy.fastFeeRecipients.some((r) => eq(r, feeTo.trim()))
                        ? 'That relayer is not one FAST may pay.'
                        : feeWei > 0n && asset !== ETH && (!liveRule(now, ethRule) || feeWei > (ethV?.remaining ?? 0n))
                          ? 'The fee needs ETH FAST allowance, which is missing or used up.'
                          : null;
  useEffect(() => {
    if (view && !view.policy.fastEnabled) setRoute(ROUTE.PROTECTED);
  }, [view]);
  const delay = view?.policy.protectedDelay ?? 0;
  const canSend = (route === ROUTE.FAST ? !!P && !fastWhy : !!P && !!A) && !feeProblem;
  const blocker = !ready
    ? 'Connect your wallet to pay the gas.'
    : pending
      ? 'Outflows are frozen while a change is pending.'
      : !P
        ? 'Load the primary key from its backup (Vault › Keys).'
        : route === ROUTE.PROTECTED && !A
          ? 'Load the approver key from its backup (Vault › Keys) to co-sign.'
          : null;
  const balanceHere = av?.balance ?? 0n;
  const record = (t: Transfer, id: Hex, extra: Partial<HistoryItem>) =>
    update((p) => ({
      ...p,
      history: [...p.history, { id, route: t.route as 1 | 2, amount: fmt(t.amount, t.asset), recipient: t.recipient, at: Date.now(), queued: false, ...extra }].slice(-50),
    }));

  if (review)
    return (
      <div className="card stack tn-form tn-review" aria-label="Review transfer">
        <h3>Check before signing</h3>
        <p className="small muted">Your keys sign exactly what is shown here. Nobody can change it afterwards.</p>
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
          <dd className="tn-strong">{fmt(review.amount, review.asset)}</dd>
          <dt>Route</dt>
          <dd>{review.route === ROUTE.FAST ? 'FAST: primary key alone, counted against the allowance' : 'Protected: primary and approver'}</dd>
          <dt>Arrives</dt>
          <dd>
            {review.route === ROUTE.FAST || !delay
              ? 'When the transaction is accepted'
              : `Executable after about ${when((view?.now || Math.floor(Date.now() / 1000)) + delay)}, then 7 days to execute`}
          </dd>
          <dt>Relayer fee</dt>
          <dd>{review.feeWei ? `${formatEther(review.feeWei)} ETH to ${review.feeRecipient}` : 'None'}</dd>
        </dl>
        {view && review.amount > (view.assets.find((x) => eq(x.asset, review.asset))?.balance ?? 0n) && <p className="small tn-err">This is more than the vault holds now.</p>}
        {me && !eq(review.recipient, me) && <p className="small muted">The recipient is not your connected wallet. Check the address character by character.</p>}
        {relayed ? (
          <div className="tn-inline stack">
            <p className="small">
              Signed. Give this to the relayer; anyone can submit it with “Submit a signed transfer”, and nobody can change it. It is valid for about 15 minutes, and only
              until this vault signs another transfer.
            </p>
            <textarea className="mono small" readOnly rows={5} value={relayed} aria-label="Signed transfer" onFocus={(e) => e.currentTarget.select()} />
            <div className="row">
              <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(relayed).then(() => note('ok', 'Signed transfer copied.'), () => {})}>
                Copy
              </button>
              <button className="btn ghost sm" onClick={() => (setReview(null), setRelayed(null), setAmt(''))}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button
              className="btn primary"
              disabled={!ready || busy || pending || !P || (review.route === ROUTE.PROTECTED && !A)}
              onClick={() => {
                const rv = review;
                let id: Hex | null = null;
                void run(
                  rv.route === ROUTE.FAST ? 'FAST transfer' : 'Protected transfer',
                  async () => {
                    const r = await transferTx(vault, rv, P!, rv.route === ROUTE.PROTECTED ? A : null);
                    id = r.id;
                    return r.tx;
                  },
                  (rc) => {
                    const evs = eventsOf(rc, VAULT_ABI);
                    const queued = evs.find((x) => x.eventName === 'WithdrawalScheduled');
                    const done = evs.find((x) => x.eventName === 'TransferExecuted');
                    const tid = ((queued?.args.id ?? done?.args.id) as Hex | undefined) ?? id!;
                    if (queued) update((p) => ({ ...p, withdrawals: p.withdrawals.includes(tid) ? p.withdrawals : [...p.withdrawals, tid] }));
                    record(rv, tid, { hash: rc.transactionHash, queued: !!queued });
                    setAmt('');
                    setReview(null);
                  },
                ).then(refresh);
              }}
            >
              {review.route === ROUTE.FAST ? 'Sign with primary and send' : 'Sign with both keys and send'}
            </button>
            <button
              className="btn ghost"
              disabled={busy || !P || (review.route === ROUTE.PROTECTED && !A)}
              title="Sign now and let someone else submit it"
              onClick={async () => {
                try {
                  const s = await signTransfer(vault, review, P!, review.route === ROUTE.PROTECTED ? A : null);
                  setRelayed(JSON.stringify(exportSigned(s), null, 2));
                  record(review, s.id, { relayed: true });
                } catch (x) {
                  note('err', (x as Error).message);
                }
              }}
            >
              Sign for a relayer
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setReview(null)}>
              Edit
            </button>
          </div>
        )}
      </div>
    );

  const fastFor = fastOff ? fastOff : pending ? 'Paused while a change is pending.' : !rule ? `No FAST allowance for ${A_.symbol}.` : `${fmt(av?.remaining ?? 0n, asset)} left · up to ${fmt(rule.perActionCap, asset)} each · listed recipients`;
  return (
    <form
      className="card stack tn-form send"
      onSubmit={(e) => {
        e.preventDefault();
        if (!amount || !isAddress(recipient) || !canSend) return;
        setRelayed(null);
        setReview({ route, asset, recipient: recipient as Address, amount, feeRecipient: feeWei ? (feeTo.trim() as Address) : ETH, feeWei });
      }}
    >
      <h3>Send a payment</h3>
      <div className="routes" role="radiogroup" aria-label="Route">
        <button type="button" role="radio" aria-checked={route === ROUTE.FAST} className={`route-opt${route === ROUTE.FAST ? ' on' : ''}`} onClick={() => setRoute(ROUTE.FAST)} disabled={!!view && !view.policy.fastEnabled}>
          <b>FAST · primary only</b>
          <span>For everyday payments inside your allowance. Arrives at once.</span>
          <small className={fastOff || !rule ? 'tn-err' : ''}>{fastFor}</small>
        </button>
        <button type="button" role="radio" aria-checked={route === ROUTE.PROTECTED} className={`route-opt${route === ROUTE.PROTECTED ? ' on' : ''}`} onClick={() => setRoute(ROUTE.PROTECTED)}>
          <b>Protected · primary + approver</b>
          <span>Any amount, any address. Both keys sign.</span>
          <small>{delay ? `Waits ${DELAY_TEXT[delay]}, then anyone can execute it` : 'Arrives at once'}</small>
        </button>
      </div>
      <div className="row tn-two">
        {assets.length > 1 && (
          <div className="field">
            <label htmlFor="t2-asset">Asset</label>
            <select id="t2-asset" value={asset} onChange={(e) => setAsset(e.target.value as Address)}>
              {assets.map((a) => (
                <option key={a.address} value={a.address}>
                  {a.symbol} · {fmt(view?.assets.find((x) => eq(x.asset, a.address))?.balance ?? 0n, a.address)} in vault
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="t2-amt">Amount ({A_.symbol})</label>
          <input id="t2-amt" className="mono" inputMode="decimal" placeholder="0.0005" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <p className="small muted">The vault holds {fmt(balanceHere, asset)}.</p>
        </div>
      </div>
      <div className="field">
        <label htmlFor="t2-to">Recipient</label>
        <input id="t2-to" className="mono" placeholder={me ?? '0x…'} value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={to !== '' && !isAddress(to.trim())} />
        <p className="small muted">{me ? 'Leave empty to send to your connected wallet.' : 'The address that receives the funds.'}</p>
      </div>
      <details className="tn-more" open={feeOn}>
        <summary>Pay a relayer fee (optional)</summary>
        <p className="small muted">The fee is paid in ETH from the vault to the relayer you name, in the same transaction.</p>
        <div className="row tn-two">
          <div className="field">
            <label htmlFor="t2-feeto">Relayer address</label>
            <input id="t2-feeto" className="mono" placeholder="0x…" value={feeTo} onChange={(e) => setFeeTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="t2-fee">Fee (ETH)</label>
            <input id="t2-fee" className="mono" inputMode="decimal" placeholder="0.0001" value={fee} onChange={(e) => setFee(e.target.value)} />
          </div>
        </div>
      </details>
      {feeProblem && <p className="small tn-err">{feeProblem}</p>}
      {route === ROUTE.FAST && fastWhy && <p className="small tn-err">{fastWhy}</p>}
      {blocker && <p className="small muted">{blocker}</p>}
      <button className="btn primary" disabled={!ready || busy || pending || !amount || !isAddress(recipient) || !canSend}>
        Review transfer
      </button>
    </form>
  );
}

/** Protected transfers waiting for their delay: execute, cancel or clear them. */
export function QueueTable({ profile, view, now, busy, ready, run, refresh }: { profile: ProfileV2; view: VaultView | null; now: number; busy: boolean; ready: boolean; run: RunFn; refresh: () => Promise<void> }) {
  const { P, A, pending } = useSigners(profile, view);
  const vault = profile.vault!;
  const delay = view?.policy.protectedDelay ?? 0;
  const rows = useMemo(() => (view ? [...view.withdrawals].reverse() : []), [view]);
  return (
    <section className="card stack">
      <h3>Queued payments</h3>
      <p className="small muted">Protected payments wait here for your delay. When one is ready anyone can execute it; until then either spending key can cancel it.</p>
      {rows.length === 0 ? (
        <p className="small muted">{delay ? 'Nothing queued.' : 'Nothing queued. With no delay, protected payments execute at once.'}</p>
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
                const current = !!view && x.executionEpoch === view.epochs.execution && x.policyEpoch === view.epochs.policy && x.authorityEpoch === view.epochs.authority;
                const queued = x.status === 1 && current;
                const mature = queued && now >= Number(x.executableAt);
                const expired = queued && now >= Number(x.expiresAt);
                const label =
                  x.status === 2
                    ? 'Executed'
                    : x.status === 3
                      ? 'Cancelled'
                      : x.status === 0
                        ? 'Removed'
                        : !current
                          ? 'Invalidated'
                          : expired
                            ? 'Expired'
                            : mature
                              ? 'Ready to execute'
                              : `Waiting · ${left(Number(x.executableAt) - now)}`;
                const canceller = P ? { role: ROLE.P, k: P } : A ? { role: ROLE.A, k: A } : null;
                return (
                  <tr key={x.id}>
                    <td className="mono">
                      {fmt(x.amount, x.asset)}
                      {x.feeWei ? <span className="small muted"> + {formatEther(x.feeWei)} ETH fee</span> : null}
                    </td>
                    <td className="mono" title={x.recipient}>
                      {short(x.recipient)}
                    </td>
                    <td>{label}</td>
                    <td className="tn-actions">
                      {mature && !expired && (
                        <button className="btn primary sm" disabled={!ready || busy || pending} onClick={() => void run('Execute transfer', async () => executeTx(vault, x.id)).then(refresh)}>
                          Execute
                        </button>
                      )}
                      {x.status === 1 && (expired || !current) && (
                        <button
                          className="btn ghost sm"
                          title="It can never execute; removing it frees a queue slot. Anyone may do this."
                          disabled={!ready || busy}
                          onClick={() => void run('Remove stale transfer', async () => pruneTx(vault, x.id)).then(refresh)}
                        >
                          Remove
                        </button>
                      )}
                      {queued && !expired && (
                        <button
                          className="btn ghost sm"
                          disabled={!ready || busy || pending || !canceller}
                          onClick={() => void run('Cancel transfer', () => cancelTx(vault, canceller!.role, canceller!.k, x.id)).then(refresh)}
                        >
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
    </section>
  );
}

/** Payments signed in this browser. */
export function HistoryList({ profile }: { profile: ProfileV2 }) {
  if (profile.history.length === 0) return null;
  return (
    <section className="card stack">
      <h3>Sent from this browser</h3>
      <ul className="tn-history">
        {[...profile.history].reverse().map((h) => (
          <li key={h.id} className="small">
            <span className="mono">{/\s/.test(h.amount) ? h.amount : `${h.amount} ETH`}</span> → <span className="mono">{short(h.recipient)}</span> · {h.route === 1 ? 'FAST' : 'Protected'}
            {h.queued ? ' (queued)' : ''}
            {h.relayed ? ' (signed for a relayer)' : ''} · {new Date(h.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            {h.hash && (
              <>
                {' '}
                · <Ext href={link(`tx/${h.hash}`)}>tx</Ext>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The two emergency brakes either spending key can pull alone. */
export function SafetyActions({ profile, view, busy, ready, run, refresh }: { profile: ProfileV2; view: VaultView | null; busy: boolean; ready: boolean; run: RunFn; refresh: () => Promise<void> }) {
  const { P, A } = useSigners(profile, view);
  const vault = profile.vault!;
  const fastOn = !!view?.policy.fastEnabled && !view.fastSuspended;
  return (
    <section className="card stack">
      <h3>If something looks wrong</h3>
      <p className="small muted">Either spending key alone can pull these brakes. Neither moves any funds, and a thief holding one key cannot undo them.</p>
      <div className="brakes">
        <div className="brake">
          <b>Freeze all queued transfers</b>
          <span className="small muted">Every queued payment and every signature not yet used stops working.</span>
          <SafetyButton label="Freeze all queued transfers" view={view} P={P} A={A} busy={busy} ready={ready} make={(role, k) => invalidateTx(vault, role, k)} run={run} refresh={refresh} />
        </div>
        <div className="brake">
          <b>Suspend FAST</b>
          <span className="small muted">The primary key can no longer pay alone. Both keys turn it back on by granting a new allowance.</span>
          {fastOn ? (
            <SafetyButton label="Suspend FAST" view={view} P={P} A={A} busy={busy} ready={ready} make={(role, k) => suspendFastTx(vault, role, k)} run={run} refresh={refresh} />
          ) : (
            <span className="chip">{view?.fastSuspended ? 'FAST is suspended' : 'FAST is off'}</span>
          )}
        </div>
      </div>
      {!P && !A && <p className="small muted">Load the primary or approver key (Vault › Keys) to use these.</p>}
    </section>
  );
}

// -------------------------------------------------------------------- relay

/** Submit a transfer someone signed: the signatures carry the authority, this wallet only pays gas. */
export function RelayCard({ busy, ready, run }: { busy: boolean; ready: boolean; run: RunFn }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [s, setS] = useState<SignedTransfer | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => window.clearInterval(id);
  }, []);
  const load = (raw: string) => {
    setText(raw);
    setS(null);
    setErr(null);
    if (!raw.trim()) return;
    try {
      setS(parseSigned(JSON.parse(raw)));
    } catch (x) {
      setErr(x instanceof SyntaxError ? 'That is not a signed transfer.' : (x as Error).message);
    }
  };
  const expired = !!s && now >= Number(s.w.validUntil);
  return (
    <section className="card stack">
      <details className="tn-config">
        <summary>
          <h3>Submit a signed transfer</h3>
          <span className="small muted">For relayers</span>
        </summary>
        <p className="small muted">
          Paste a transfer that a vault’s keys signed for a relayer. Your wallet pays the gas and cannot change anything: the vault checks the signatures, and any fee goes to
          the relayer named inside.
        </p>
        <textarea className="mono small" rows={5} placeholder='{"format": "quanlet-v2-signed-transfer", …}' value={text} onChange={(e) => load(e.target.value)} aria-label="Signed transfer" />
        {err && <p className="small tn-err">{err}</p>}
        {s && (
          <>
            <dl className="kv">
              <dt>Vault</dt>
              <dd className="mono small">{s.vault}</dd>
              <dt>Route</dt>
              <dd>{s.t.route === ROUTE.FAST ? 'FAST' : 'Protected'}</dd>
              <dt>Sends</dt>
              <dd>
                {fmt(s.t.amount, s.t.asset)} to <span className="mono small">{s.t.recipient}</span>
              </dd>
              <dt>Fee</dt>
              <dd>{s.t.feeWei ? `${formatEther(s.t.feeWei)} ETH to ${s.t.feeRecipient}` : 'None'}</dd>
              <dt>Valid</dt>
              <dd>{expired ? 'Expired' : `for ${left(Number(s.w.validUntil) - now)}`}</dd>
            </dl>
            <button className="btn primary sm" disabled={!ready || busy || expired} onClick={() => void run('Submit signed transfer', async () => submitTx(s)).then((ok) => ok && load(''))}>
              Submit with my wallet
            </button>
          </>
        )}
      </details>
    </section>
  );
}

export function SafetyButton({
  label,
  view,
  P,
  A,
  busy,
  ready,
  make,
  run,
  refresh,
}: {
  label: string;
  view: VaultView | null;
  P: QKey | null;
  A: QKey | null;
  busy: boolean;
  ready: boolean;
  make: (role: number, k: QKey) => Promise<Tx>;
  run: RunFn;
  refresh: () => Promise<void>;
}) {
  const signer = P ? { role: ROLE.P, k: P } : A ? { role: ROLE.A, k: A } : null;
  return (
    <button
      className="btn ghost sm"
      disabled={!ready || busy || !signer || !view || view.state !== STATE.Active}
      title={signer ? `Signed by the ${signer.role === ROLE.P ? 'primary' : 'approver'} key` : 'Load the primary or approver key'}
      onClick={() => void run(label, () => make(signer!.role, signer!.k)).then(refresh)}
    >
      {label}
    </button>
  );
}

// -------------------------------------------------------------------- policy

export function PolicyPanel({ profile, view, busy, ready, run, refresh }: { profile: ProfileV2; view: VaultView; busy: boolean; ready: boolean; run: RunFn; refresh: () => Promise<void> }) {
  const me = useWallet((s) => s.address);
  const update = useProfileV2((s) => s.update);
  const seedOf = useSeedOf();
  const vault = profile.vault!;
  const pol = view.policy;
  const assets = assetsOfVault(view);
  const [open, setOpen] = useState(false);
  const draftFromChain = (): PolicyDraft => {
    const rules: Record<string, RuleDraft> = {};
    for (const r of pol.assetRules) {
      const a = assetOf(r.asset);
      const sp = view.assets.find((x) => eq(x.asset, r.asset))?.spent ?? 0n;
      rules[r.asset.toLowerCase()] = { ceiling: formatUnits(r.ceiling > sp ? r.ceiling - sp : 0n, a.decimals), cap: formatUnits(r.perActionCap, a.decimals) };
    }
    if (!pol.assetRules.length) rules[ETH] = { ceiling: '0.002', cap: '0.001' };
    return {
      delay: pol.protectedDelay,
      fast: true,
      days: 30,
      recipients: pol.assetRules[0] ? [...pol.assetRules[0].recipients] : [],
      rules,
      maxFee: pol.maxFastFeeWei ? formatEther(pol.maxFastFeeWei) : '',
      feeRecipients: [...pol.fastFeeRecipients],
    };
  };
  const [d, setD] = useState<PolicyDraft>(draftFromChain);
  const pSeed = seedOf(profile.keys.p);
  const aSeed = seedOf(profile.keys.a);
  const both = pSeed && aSeed && eq(view.roles[0], profile.keys.p.keyId) && eq(view.roles[1], profile.keys.a.keyId);
  const problem = draftProblem(d, assets, me ?? undefined);
  return (
    <section className="card stack" id="rules">
      <h3>Payment rules</h3>
      <dl className="kv">
        <dt>Protected delay</dt>
        <dd>{DELAY_TEXT[pol.protectedDelay] ?? `${pol.protectedDelay} s`}</dd>
        <dt>FAST</dt>
        <dd>{!pol.fastEnabled ? 'Off' : view.fastSuspended ? 'On, but suspended' : 'On'}</dd>
      </dl>
      {pol.fastEnabled && pol.assetRules.length > 0 && (
        <div className="allows" aria-label="FAST allowance">
          {pol.assetRules.map((r) => {
            const a = assetOf(r.asset);
            const sp = view.assets.find((x) => eq(x.asset, r.asset))?.spent ?? 0n;
            const leftAmt = r.ceiling > sp ? r.ceiling - sp : 0n;
            const pct = r.ceiling > 0n ? Number((leftAmt * 1000n) / r.ceiling) / 10 : 0;
            return (
              <div className="allow" key={r.asset}>
                <div className="allow-top">
                  <b>{a.symbol} allowance</b>
                  <span>
                    {fmt(leftAmt, r.asset)} left of {fmt(r.ceiling, r.asset)}
                  </span>
                </div>
                <span className="allow-bar" aria-hidden>
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span className="small muted">
                  {formatUnits(sp, a.decimals)} of {fmt(r.ceiling, r.asset)} used · ≤ {formatUnits(r.perActionCap, a.decimals)} each · until {when(Number(r.budgetValidUntil))}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <dl className="kv">
        {pol.assetRules[0] && (
          <>
            <dt>Recipients</dt>
            <dd className="mono small">{pol.assetRules[0].recipients.map((r) => short(r)).join(', ')}</dd>
          </>
        )}
        {pol.maxFastFeeWei > 0n && (
          <>
            <dt>Relayer fees</dt>
            <dd>
              up to {formatEther(pol.maxFastFeeWei)} ETH to <span className="mono small">{pol.fastFeeRecipients.map((r) => short(r)).join(', ')}</span>
            </dd>
          </>
        )}
      </dl>
      <p className="small muted">
        Primary and approver change the rules together.
        {pol.protectedDelay ? ` It takes effect after the ${DELAY_TEXT[pol.protectedDelay]} delay; outflows are frozen until then.` : ' With no delay, it applies at once.'} A new
        allowance is what FAST may spend from now on; it also resumes a suspended FAST.
      </p>
      {!open ? (
        <button className="btn sm" disabled={view.state !== STATE.Active} onClick={() => (setD(draftFromChain()), setOpen(true))}>
          Change the rules
        </button>
      ) : (
        <div className="tn-inline stack">
          <PolicyFields d={d} set={setD} me={me} idp="upd" assets={assets} topUp />
          {problem && <p className="small tn-err">{problem}</p>}
          {!both && <p className="small muted">Load the primary and approver keys to sign.</p>}
          <div className="row">
            <button
              className="btn primary sm"
              disabled={!ready || busy || !!problem || !both || view.state !== STATE.Active}
              onClick={() => {
                let policy: Policy | null = null;
                void run(
                  'Change rules',
                  async () => {
                    policy = buildPolicy(choiceOf(d, assets, me ?? undefined), await chainNowSafe(), spentMap(view));
                    return updatePolicyTx(vault, keyFromSeed(pSeed!), keyFromSeed(aSeed!), policy);
                  },
                  () => {
                    if (pol.protectedDelay && policy) update((p) => ({ ...p, pendingPolicy: { json: policyToJson(policy!) } }));
                    setOpen(false);
                  },
                ).then(refresh);
              }}
            >
              Sign with both keys
            </button>
            <button className="btn ghost sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- key changes

/** Rotate the primary and/or approver (both sign; new keys consent), or replace all three guardians. */
export function KeyChangesPanel({
  only,
  profile,
  view,
  busy,
  ready,
  run,
  refresh,
  recheck,
  checking,
  note,
}: {
  only?: 'rotate' | 'guardians';
  profile: ProfileV2;
  view: VaultView;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  refresh: () => Promise<void>;
  recheck: () => Promise<void>;
  checking: boolean;
  note: Note;
}) {
  const update = useProfileV2((s) => s.update);
  const seedOf = useSeedOf();
  const vault = profile.vault!;
  const [chosen, setTask] = useState<'rotate' | 'guardians'>('rotate');
  const task = only ?? chosen;
  const [which, setWhich] = useState<'p' | 'a' | 'both'>('p');
  const [pair, setPair] = useState<[number, number]>([0, 1]);
  const next = profile.next ?? {};
  const pSeed = seedOf(profile.keys.p);
  const aSeed = seedOf(profile.keys.a);
  const spendingHere = !!pSeed && !!aSeed && eq(view.roles[0], profile.keys.p.keyId) && eq(view.roles[1], profile.keys.a.keyId);
  const ok = (s?: Slot) => !!s && s.ready && !!s.tested && !!seedOf(s);
  const gNames: RoleName[] = ['g1', 'g2', 'g3'];
  const gSeeds = pair.map((i) => seedOf(profile.keys[gNames[i]!]));
  const gMissing = pair.filter((_, j) => !gSeeds[j]).map((i) => i + 1);
  const active = view.state === STATE.Active;
  const delay = view.policy.protectedDelay;
  const wantP = which !== 'a';
  const wantA = which !== 'p';
  const rotReady = (!wantP || ok(next.np)) && (!wantA || ok(next.na));
  const ng = [next.ng1, next.ng2, next.ng3];
  const prep = (names: NextName[]) => update((q) => ({ ...q, next: { ...q.next, ...Object.fromEntries(names.filter((n) => !q.next?.[n]).map((n) => [n, slotFor(newSeed())])) } }));
  const discard = (names: NextName[]) =>
    update((q) => {
      const n = { ...q.next };
      names.forEach((k) => delete n[k]);
      return { ...q, next: Object.keys(n).length ? n : undefined };
    });
  return (
    <section className="card stack">
      <h3>{only === 'rotate' ? 'Replace the primary or approver' : only === 'guardians' ? 'Replace the guardians' : 'Change keys'}</h3>
      {!only && <div className="seg" role="tablist" aria-label="Change">
        <button role="tab" aria-selected={task === 'rotate'} className={`btn sm ${task === 'rotate' ? '' : 'ghost'}`} onClick={() => setTask('rotate')}>
          Rotate primary or approver
        </button>
        <button role="tab" aria-selected={task === 'guardians'} className={`btn sm ${task === 'guardians' ? '' : 'ghost'}`} onClick={() => setTask('guardians')}>
          Replace guardians
        </button>
      </div>}
      {!active && <p className="small muted">A change is pending (see above). Finish or cancel it first.</p>}

      {task === 'rotate' && (
        <>
          <p className="small muted">
            The current primary and approver sign together, and each new key consents.{' '}
            {delay ? `The change waits ${DELAY_TEXT[delay]} and freezes outflows meanwhile.` : 'With no protected delay it applies at once.'} Swapping the two roles is not allowed.
          </p>
          <div className="field">
            <label htmlFor="t2-which">Replace</label>
            <select id="t2-which" value={which} onChange={(e) => setWhich(e.target.value as 'p' | 'a' | 'both')}>
              <option value="p">The primary key</option>
              <option value="a">The approver key</option>
              <option value="both">Both</option>
            </select>
          </div>
          {(wantP && !next.np) || (wantA && !next.na) ? (
            <button className="btn sm" disabled={busy || !active} onClick={() => prep([...(wantP ? (['np'] as NextName[]) : []), ...(wantA ? (['na'] as NextName[]) : [])])}>
              Prepare the new {which === 'both' ? 'keys' : which === 'p' ? 'primary key' : 'approver key'}
            </button>
          ) : (
            <>
              <div className="tn-head">
                <span className="small muted">New {which === 'both' ? 'keys' : 'key'}</span>
                <button className="btn ghost xs" disabled={checking} onClick={() => void recheck()}>
                  {checking ? 'Checking…' : 'Re-check'}
                </button>
              </div>
              <ul className="tn-keylist">
                {wantP && <KeyRow profile={profile} n="np" busy={busy} ready={ready} run={run} recheck={recheck} note={note} />}
                {wantA && <KeyRow profile={profile} n="na" busy={busy} ready={ready} run={run} recheck={recheck} note={note} />}
              </ul>
              <button
                className="btn primary"
                disabled={!ready || busy || !active || !spendingHere || !rotReady}
                onClick={() =>
                  void run('Rotate spending keys', () =>
                    replaceSpendingTx(vault, keyFromSeed(pSeed!), keyFromSeed(aSeed!), wantP ? keyFromSeed(seedOf(next.np)!) : null, wantA ? keyFromSeed(seedOf(next.na)!) : null),
                  ).then(refresh)
                }
              >
                Sign with primary and approver
              </button>
              {!rotReady && <p className="small muted">Back up, test and register the new {which === 'both' ? 'keys' : 'key'} first.</p>}
              {!spendingHere && <p className="small muted">Load the current primary and approver keys to sign.</p>}
              <button className="btn ghost xs" disabled={busy} onClick={() => discard(['np', 'na'])}>
                Discard the prepared keys
              </button>
            </>
          )}
        </>
      )}

      {task === 'guardians' && (
        <>
          <p className="small muted">
            The primary, the approver and two current guardians sign together, and the three new guardians consent. The change waits 7 days, freezes outflows meanwhile,
            and two current guardians can cancel it.
          </p>
          {ng.some((s) => !s) ? (
            <button className="btn sm" disabled={busy || !active} onClick={() => prep(['ng1', 'ng2', 'ng3'])}>
              Prepare three new guardians
            </button>
          ) : (
            <>
              <div className="tn-head">
                <span className="small muted">New guardians</span>
                <button className="btn ghost xs" disabled={checking} onClick={() => void recheck()}>
                  {checking ? 'Checking…' : 'Re-check'}
                </button>
              </div>
              <ul className="tn-keylist">
                {(['ng1', 'ng2', 'ng3'] as NextName[]).map((n) => (
                  <KeyRow key={n} profile={profile} n={n} busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
                ))}
              </ul>
              <div className="field">
                <label htmlFor="t2-rgpair">Current guardians that sign</label>
                <select id="t2-rgpair" value={pair.join(',')} onChange={(e) => setPair(e.target.value.split(',').map(Number) as [number, number])}>
                  <option value="0,1">Guardians 1 and 2</option>
                  <option value="0,2">Guardians 1 and 3</option>
                  <option value="1,2">Guardians 2 and 3</option>
                </select>
                {gMissing.length > 0 && <p className="small muted">Guardian {gMissing.join(' and ')} {gMissing.length === 1 ? 'is' : 'are'} not loaded. Use “Load from backup” in Vault › Keys.</p>}
              </div>
              <button
                className="btn primary"
                disabled={!ready || busy || !active || !spendingHere || gMissing.length > 0 || !ng.every(ok)}
                onClick={() =>
                  void run('Replace guardians', () =>
                    replaceGuardiansTx(
                      vault,
                      keyFromSeed(pSeed!),
                      keyFromSeed(aSeed!),
                      [keyFromSeed(gSeeds[0]!), keyFromSeed(gSeeds[1]!)],
                      pair,
                      ng.map((s) => keyFromSeed(seedOf(s)!)) as [QKey, QKey, QKey],
                    ),
                  ).then(refresh)
                }
              >
                Sign with primary, approver and two guardians
              </button>
              {!ng.every(ok) && <p className="small muted">Back up, test and register all three new guardians first.</p>}
              {!spendingHere && <p className="small muted">Load the current primary and approver keys to sign.</p>}
              <button className="btn ghost xs" disabled={busy} onClick={() => discard(['ng1', 'ng2', 'ng3'])}>
                Discard the prepared keys
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- pending change

/** The rules a policy sets, in a few plain lines (shown for a pending policy change). */
export function policyLines(p: Policy): string[] {
  const lines = [p.protectedDelay ? `Protected transfers wait ${DELAY_TEXT[p.protectedDelay]?.toLowerCase() ?? `${p.protectedDelay} s`}` : 'Protected transfers execute at once'];
  if (!p.fastEnabled || !p.assetRules.length) return [...lines, 'FAST off'];
  for (const r of p.assetRules)
    lines.push(
      `FAST ${assetOf(r.asset).symbol}: up to ${fmt(r.perActionCap, r.asset)} per transfer, lifetime ceiling ${fmt(r.ceiling, r.asset)}, until ${when(Number(r.budgetValidUntil))}, to ${r.recipients.length === 1 ? short(r.recipients[0]!) : `${r.recipients.length} recipients`}`,
    );
  return lines;
}

type Lookup = 'idle' | 'searching' | 'found' | 'missing';

export function PendingCard({ profile, view, now, busy, ready, run, refresh }: { profile: ProfileV2; view: VaultView; now: number; busy: boolean; ready: boolean; run: RunFn; refresh: () => Promise<void> }) {
  const seedOf = useSeedOf();
  const update = useProfileV2((s) => s.update);
  const vault = profile.vault!;
  const pr = view.proposal;
  const [pair, setPair] = useState<[number, number]>([0, 1]);
  const [lookup, setLookup] = useState<Lookup>('idle');
  const [hash, setHash] = useState('');
  const [hashErr, setHashErr] = useState<string | null>(null);
  const expired = now >= Number(pr.expiresAt);
  const mature = now >= Number(pr.executableAt) && !expired;
  const isPolicy = view.state === STATE.PendingPolicy;
  const byGuardians = view.state === STATE.PendingRecovery || view.state === STATE.PendingGuardians;
  const stored = profile.pendingPolicy ? policyFromJson(profile.pendingPolicy.json) : null;
  const payload = stored && eq(policyHash(stored), pr.payloadHash) ? encodePolicy(stored) : null;
  const fromChain = !!payload && !!profile.pendingPolicy?.fromChain;
  const keep = useCallback(
    (policy: Policy) => update((p) => ({ ...p, pendingPolicy: { id: pr.id, json: policyToJson(policy), fromChain: true } })),
    [update, pr.id],
  );
  // A policy change started on another device: find the signed policy in the transaction that proposed it.
  useEffect(() => setLookup('idle'), [pr.id]);
  useEffect(() => {
    if (!isPolicy || payload || lookup !== 'idle') return;
    setLookup('searching');
    findPendingPolicy(pr, view.policy.protectedDelay)
      .then((r) => {
        if (r) keep(r.policy);
        setLookup(r ? 'found' : 'missing');
      })
      .catch(() => setLookup('missing'));
  }, [isPolicy, payload, lookup, pr, view.policy.protectedDelay, keep]);
  const fromHash = async () => {
    setHashErr(null);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) return setHashErr('Paste a transaction hash: 0x and 64 hex characters.');
    try {
      const policy = await pendingPolicyFromTx(hash.trim() as Hex, pr);
      if (!policy) return setHashErr('That transaction does not carry this change. Check the hash.');
      keep(policy);
      setLookup('found');
    } catch {
      setHashErr('Could not read that transaction. Try again.');
    }
  };
  const gNames: RoleName[] = ['g1', 'g2', 'g3'];
  const gSeeds = pair.map((i) => seedOf(profile.keys[gNames[i]!]));
  const pSeed = seedOf(profile.keys.p);
  const aSeed = seedOf(profile.keys.a);
  const nx = profile.next ?? {};
  const pairOurs = (eq(pr.keys[0], nx.np?.keyId) || eq(pr.keys[0], profile.keys.p.keyId)) && (eq(pr.keys[1], nx.na?.keyId) || eq(pr.keys[1], profile.keys.a.keyId));
  const ours =
    view.state === STATE.PendingRecovery || view.state === STATE.PendingSpendingKeys
      ? pairOurs
      : view.state === STATE.PendingGuardians
        ? [nx.ng1, nx.ng2, nx.ng3].every((x, i) => eq(pr.keys[i], x?.keyId))
        : !!payload && !fromChain;
  const what =
    view.state === STATE.PendingPolicy
      ? 'New payment rules'
      : view.state === STATE.PendingSpendingKeys
        ? `New spending keys ${short(pr.keys[0]!)} and ${short(pr.keys[1]!)}`
        : view.state === STATE.PendingRecovery
          ? `Recovery to new spending keys ${short(pr.keys[0]!)} and ${short(pr.keys[1]!)}`
          : `New guardians ${pr.keys.map((k) => short(k)).join(', ')}`;
  return (
    <section className="card stack tn-wide tn-pending">
      <div className="tn-head">
        <h3>{STATE_TEXT[view.state]}</h3>
        <span className="chip warn">Outflows frozen</span>
      </div>
      <dl className="kv">
        <dt>Change</dt>
        <dd>{what}</dd>
        {isPolicy && stored && payload && (
          <>
            <dt>New rules</dt>
            <dd>
              <ul className="plain">
                {policyLines(stored).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Started here</dt>
        <dd>
          {ours
            ? 'Yes'
            : fromChain
              ? 'No. The rules above were read from the transaction that started it. If you did not start it, cancel it.'
              : 'Not from this browser. If you did not start it, cancel it.'}
        </dd>
        <dt>Can finalize</dt>
        <dd>{expired ? 'Window closed' : mature ? 'Now' : `in ${left(Number(pr.executableAt) - now)} (${when(Number(pr.executableAt))})`}</dd>
        <dt>Expires</dt>
        <dd>{expired ? 'Expired' : `in ${left(Number(pr.expiresAt) - now)}`}</dd>
      </dl>
      {byGuardians && (
        <div className="field">
          <label htmlFor="t2-cpair">Guardians that sign a cancel</label>
          <select id="t2-cpair" value={pair.join(',')} onChange={(e) => setPair(e.target.value.split(',').map(Number) as [number, number])}>
            <option value="0,1">Guardians 1 and 2</option>
            <option value="0,2">Guardians 1 and 3</option>
            <option value="1,2">Guardians 2 and 3</option>
          </select>
        </div>
      )}
      <div className="row">
        {!expired ? (
          <button
            className="btn primary"
            disabled={!ready || busy || !mature || (isPolicy && !payload)}
            onClick={() => void run('Finalize change', async () => finalizeTx(vault, isPolicy ? payload! : '0x')).then(refresh)}
          >
            Finalize
          </button>
        ) : (
          <button className="btn primary" disabled={!ready || busy} onClick={() => void run('Clear expired change', async () => expireTx(vault)).then(refresh)}>
            Clear expired change
          </button>
        )}
        {!expired &&
          (byGuardians ? (
            <button
              className="btn ghost"
              disabled={!ready || busy || gSeeds.some((s) => !s)}
              onClick={() => void run('Cancel change', () => cancelRecoveryTx(vault, [keyFromSeed(gSeeds[0]!), keyFromSeed(gSeeds[1]!)], pair, pr.id)).then(refresh)}
            >
              Cancel with two guardians
            </button>
          ) : (
            <button
              className="btn ghost"
              disabled={!ready || busy || !pSeed || !aSeed}
              onClick={() => void run('Cancel change', () => cancelAdminTx(vault, keyFromSeed(pSeed!), keyFromSeed(aSeed!), pr.id)).then(refresh)}
            >
              Cancel with primary and approver
            </button>
          ))}
      </div>
      {isPolicy && !payload && lookup === 'searching' && <p className="small muted">Reading the new rules from the transaction that started this change…</p>}
      {isPolicy && !payload && lookup === 'missing' && (
        <div className="stack">
          <p className="small muted">
            The new rules could not be found automatically. Paste the hash of the transaction that started this change (from your wallet’s history or the explorer) to finalize it here.
          </p>
          <div className="row">
            <input aria-label="Transaction hash" placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} />
            <button className="btn sm" disabled={!hash.trim()} onClick={() => void fromHash()}>
              Read rules
            </button>
          </div>
          {hashErr && <p className="small tn-err">{hashErr}</p>}
        </div>
      )}
      {byGuardians && gSeeds.some((s) => !s) && <p className="small muted">Load both chosen guardians from their backups (Vault › Keys) to cancel.</p>}
      {expired && <p className="small muted">Nobody finalized it in time. Anyone can clear it, which unfreezes the vault; the current setup stays in charge.</p>}
    </section>
  );
}

// -------------------------------------------------------------------- recovery

export function RecoveryPanel({
  profile,
  view,
  busy,
  ready,
  run,
  refresh,
  recheck,
  checking,
  note,
}: {
  profile: ProfileV2;
  view: VaultView;
  busy: boolean;
  ready: boolean;
  run: RunFn;
  refresh: () => Promise<void>;
  recheck: () => Promise<void>;
  checking: boolean;
  note: Note;
}) {
  const update = useProfileV2((s) => s.update);
  const seedOf = useSeedOf();
  const vault = profile.vault!;
  const [pair, setPair] = useState<[number, number]>([0, 1]);
  const gNames: RoleName[] = ['g1', 'g2', 'g3'];
  const gSeeds = pair.map((i) => seedOf(profile.keys[gNames[i]!]));
  const missing = pair.filter((_, j) => !gSeeds[j]).map((i) => i + 1);
  const guardiansMatch = gNames.every((n, i) => eq(view.roles[2 + i], profile.keys[n].keyId));
  const next = profile.next?.np && profile.next?.na ? { np: profile.next.np, na: profile.next.na } : null;
  const ok = (s?: Slot) => !!s && s.ready && !!s.tested && !!seedOf(s);
  const recovering = view.state === STATE.PendingRecovery;
  return (
    <section className="card stack">
      <h3>Recovery</h3>
      <p className="muted small">
        If the primary or approver key is lost, any two guardians can install a new pair. Recovery freezes the vault and suspends FAST at once, waits 7 days, and can be
        cancelled by two guardians in that time. Afterwards FAST stays off until the new keys grant a new allowance.
      </p>
      {!guardiansMatch && (
        <div className="notice warn">
          <span>The vault’s guardians differ from the ones saved here. Import the right vault info file.</span>
        </div>
      )}
      {recovering ? (
        <p className="small muted">A recovery is pending (see above).</p>
      ) : !next ? (
        <button className="btn sm" disabled={busy} onClick={() => update((q) => ({ ...q, next: { ...q.next, np: q.next?.np ?? slotFor(newSeed()), na: q.next?.na ?? slotFor(newSeed()) } }))}>
          Prepare a new primary and approver
        </button>
      ) : (
        <>
          <div className="tn-head">
            <span className="small muted">New spending pair</span>
            <button className="btn ghost xs" disabled={checking} onClick={() => void recheck()}>
              {checking ? 'Checking…' : 'Re-check'}
            </button>
          </div>
          <ul className="tn-keylist">
            <KeyRow profile={profile} n="np" busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
            <KeyRow profile={profile} n="na" busy={busy} ready={ready} run={run} recheck={recheck} note={note} />
          </ul>
          <div className="field">
            <label htmlFor="t2-gpair">Guardians that sign</label>
            <select id="t2-gpair" value={pair.join(',')} onChange={(e) => setPair(e.target.value.split(',').map(Number) as [number, number])}>
              <option value="0,1">Guardians 1 and 2</option>
              <option value="0,2">Guardians 1 and 3</option>
              <option value="1,2">Guardians 2 and 3</option>
            </select>
            {missing.length > 0 && (
              <p className="small muted">
                Guardian {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} not loaded. Use “Load from backup” in Vault › Keys.
              </p>
            )}
          </div>
          <button
            className="btn primary"
            disabled={!ready || busy || !guardiansMatch || missing.length > 0 || !ok(next.np) || !ok(next.na)}
            onClick={() =>
              void run('Start recovery', () =>
                startRecoveryTx(vault, [keyFromSeed(gSeeds[0]!), keyFromSeed(gSeeds[1]!)], pair, keyFromSeed(seedOf(next.np)!), keyFromSeed(seedOf(next.na)!)),
              ).then(refresh)
            }
          >
            Start recovery with two guardians
          </button>
          {(!ok(next.np) || !ok(next.na)) && <p className="small muted">Back up, test and register both new keys first.</p>}
          <button
            className="btn ghost xs"
            disabled={busy}
            onClick={() =>
              update((q) => {
                const { np: _p, na: _a, ...rest } = q.next ?? {};
                return { ...q, next: Object.keys(rest).length ? rest : undefined };
              })
            }
          >
            Discard the prepared keys
          </button>
        </>
      )}
    </section>
  );
}

// -------------------------------------------------------------------- config

export function ConfigPanel({ profile, view }: { profile: ProfileV2; view: VaultView }) {
  const me = useWallet((s) => s.address);
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
          <dd>2</dd>
          <dt>Vault factory</dt>
          <dd>
            <Ext href={link(`address/${profile.vaultFactory}`)}>{profile.vaultFactory}</Ext>
          </dd>
          <dt>Assets</dt>
          <dd>{view.assets.map((x) => assetOf(x.asset).symbol).join(', ')}</dd>
          <dt>Key factory</dt>
          <dd>{KEY_FACTORY}</dd>
          <dt>Verifier</dt>
          <dd>{V2.verifier}</dd>
          {ROLE_NAMES.map((n, i) => (
            <KV key={n} label={LABEL[n]} value={view.roles[i]!} local={eq(view.roles[i], profile.keys[n].keyId)} />
          ))}
          <dt>Epochs</dt>
          <dd>
            authority {view.epochs.authority.toString()} · policy {view.epochs.policy.toString()} · execution {view.epochs.execution.toString()}
          </dd>
          <dt>Recovery delay</dt>
          <dd>7 days, then 7 days to finalize</dd>
        </dl>
      </details>
    </section>
  );
}
function KV({ label, value, local }: { label: string; value: string; local: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="mono small">{value}</span> {local ? <span className="chip ok">matches this browser</span> : <span className="chip warn">not the local key</span>}
      </dd>
    </>
  );
}

// -------------------------------------------------------------------- vault info

export function ImportButton({ onImport }: { onImport: (p: ProfileV2) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
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
              setMsg('That is a key backup. Open your vault first, then use “Load from backup” on the matching key.');
              return;
            }
            if (raw?.version === 1) {
              setMsg('That is a protocol 1.0 vault info file. Open it on the 1.0 vault page.');
              return;
            }
            const p = validateV2(raw);
            if (!p) throw new Error();
            onImport(p);
            setMsg(null);
          } catch {
            setMsg('That file is not a Quanlet 2.0 vault info file for this deployment.');
          }
        }}
      />
      <button className="btn ghost sm" onClick={() => ref.current?.click()}>
        Import vault info file
      </button>
      {msg && <p className="small tn-err">{msg}</p>}
    </div>
  );
}

export function InfoPanel({ profile, onImport, onForget }: { profile: ProfileV2; onImport: (p: ProfileV2) => void; onForget: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="card stack">
      <h3>Vault info</h3>
      <p className="muted">
        The vault info file lists the vault address, key ids, policy choices and transfers. It holds no keys, so it is safe to keep with your notes. To use the vault on
        another device, import it there, then load each key from its own backup file.
      </p>
      <div className="row">
        <button className="btn sm" onClick={() => downloadJson(vaultInfoV2(profile), `quanlet-v2-${WORDS.fileTag}-vault-${(profile.vault ?? 'new').slice(0, 10)}.json`)}>
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
            <button
              className="btn sm"
              onClick={() => {
                onForget();
                setConfirm(false);
              }}
            >
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
