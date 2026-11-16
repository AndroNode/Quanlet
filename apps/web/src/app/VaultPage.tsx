import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatEther } from 'viem';
import { short, useWallet } from '../wallet';
import { ROLE_NAMES } from '../testnet/v2/profile';
import { WalletCard } from '../pages/Testnet';
import { AppHead } from './Layout';
import { useVaultApp, type SetupStep } from './context';
import { WORDS } from '../net';
import { DepositForm, InfoPanel, KeysCard, SetupCard, StartCard, VaultSummary } from './panels';

/**
 * Vault: the guided setup until the vault exists and holds funds, then the vault at a glance, its keys and its info file.
 * Setup is one list of six steps; only the current one is open, finished ones fold away with what they produced.
 */

const ORDER: Exclude<SetupStep, 'done'>[] = ['wallet', 'keys', 'backup', 'register', 'create', 'fund'];

function Step({ n, title, state, summary, children }: { n: number; title: string; state: 'done' | 'now' | 'todo'; summary: ReactNode; children?: ReactNode }) {
  const [peek, setPeek] = useState(false);
  const open = state === 'now' || (state === 'done' && peek);
  return (
    <li className={`wiz-step ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
      <div className="wiz-head">
        <span className="wiz-n" aria-hidden>
          {state === 'done' ? '✓' : n}
        </span>
        <div className="wiz-title">
          <b>{title}</b>
          <span className="wiz-sum">{summary}</span>
        </div>
        {state === 'done' && children && (
          <button className="btn ghost xs" onClick={() => setPeek(!peek)} aria-expanded={peek}>
            {peek ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {open && children && <div className="wiz-body">{children}</div>}
    </li>
  );
}

function Setup() {
  const app = useVaultApp();
  const { profile, view, step, ready, busy, run, note, recheck, checking, refresh, allReady, allTested } = app;
  const w = useWallet();
  const tested = profile ? ROLE_NAMES.filter((n) => profile.keys[n].tested || profile.keys[n].ready).length : 0;
  const registered = profile ? ROLE_NAMES.filter((n) => profile.keys[n].ready).length : 0;
  const funded = !!view && view.assets.some((x) => x.balance > 0n);
  const done: Record<(typeof ORDER)[number], boolean> = {
    wallet: ready,
    keys: !!profile,
    backup: allTested,
    register: allReady,
    create: !!profile?.vault,
    fund: funded,
  };
  const current = step === 'done' ? null : step;
  const state = (id: (typeof ORDER)[number]) => (id === current ? 'now' : done[id] ? 'done' : 'todo');
  const doneCount = ORDER.filter((id) => done[id]).length;
  return (
    <section className="wiz" aria-labelledby="wiz-h">
      <div className="wiz-top">
        <h2 id="wiz-h">Set up your vault</h2>
        <span className="wiz-count">
          {doneCount} of {ORDER.length} done
        </span>
        <span className="wiz-bar" aria-hidden>
          <i style={{ width: `${(doneCount / ORDER.length) * 100}%` }} />
        </span>
      </div>
      <ol className="wiz-list">
        <Step
          n={1}
          title="Connect a wallet"
          state={state('wallet')}
          summary={ready ? `Connected: ${short(w.address!)}${w.balance !== null ? ` · ${Number(formatEther(w.balance)).toFixed(4)} ETH` : ''}` : WORDS.gas}
        >
          <WalletCard />
        </Step>
        <Step n={2} title="Create your five keys" state={state('keys')} summary={profile ? 'Five keys made in this browser' : 'A primary key, an approver and three guardians, each with one job.'}>
          {!profile && (
            <StartCard
              onCreate={(p) => {
                app.setProfile(p);
                note('ok', 'Five keys created in this browser. Next, back up each one.');
              }}
              onImport={app.setProfile}
              note={note}
            />
          )}
        </Step>
        <Step n={3} title="Back up each key" state={state('backup')} summary={profile ? `${tested} of 5 backed up and tested` : 'Each key gets its own file and password. You open each file once to prove it works.'}>
          {profile && current === 'backup' && <KeysCard profile={profile} busy={busy} ready={ready} run={run} recheck={recheck} checking={checking} note={note} />}
        </Step>
        <Step n={4} title="Register the keys on chain" state={state('register')} summary={profile ? `${registered} of 5 registered` : 'One transaction per key, paid by your wallet.'}>
          {profile && current === 'register' && <KeysCard profile={profile} busy={busy} ready={ready} run={run} recheck={recheck} checking={checking} note={note} />}
        </Step>
        <Step
          n={5}
          title="Choose your rules and create the vault"
          state={state('create')}
          summary={profile?.vault ? `Vault ${short(profile.vault)}` : 'How much the primary key may pay alone, and how long protected payments wait.'}
        >
          {profile && !profile.vault && <SetupCard profile={profile} busy={busy} ready={ready} run={run} allReady={allReady} />}
        </Step>
        <Step n={6} title="Add funds" state={state('fund')} summary={funded ? 'Funded' : WORDS.funds}>
          {profile?.vault && !funded && <DepositForm profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} />}
        </Step>
      </ol>
    </section>
  );
}

export default function VaultPage() {
  const app = useVaultApp();
  const { profile, view, viewErr, now, step, busy, ready, run, refresh, note, recheck, checking } = app;
  const setupOpen = !profile?.vault || step !== 'done';
  return (
    <div className="page-app">
      <AppHead
        title="Vault"
        lede={
          profile?.vault
            ? 'Your vault at a glance: what it holds, what the primary key may still pay alone, and where your keys are.'
            : `A vault holds your assets and moves them only when your post-quantum keys sign. ${WORDS.intro}`
        }
      />

      {setupOpen && <Setup />}

      {profile?.vault && (
        <div className="app-grid">
          <VaultSummary profile={profile} view={view} viewErr={viewErr} now={now} />
          <section className="card stack quick">
            <h3>What would you like to do?</h3>
            <Link className="quick-a" to="/payments">
              <b>Send a payment</b>
              <span>FAST with the primary key, or protected with both keys.</span>
            </Link>
            <Link className="quick-a" to="/payments#rules">
              <b>Change payment rules</b>
              <span>The FAST allowance, its recipients and the protected delay.</span>
            </Link>
            <Link className="quick-a" to="/recovery">
              <b>Recover a lost key</b>
              <span>Two guardians install a new primary and approver.</span>
            </Link>
            <Link className="quick-a" to="/control">
              <b>Pull the brakes</b>
              <span>Freeze queued payments or suspend FAST with one key.</span>
            </Link>
          </section>
          {step === 'done' && <DepositForm profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} />}
        </div>
      )}

      {profile && (step === 'done' || !!profile.vault) && (
        <section className="app-sec" id="keys" aria-labelledby="keys-h">
          <h2 id="keys-h">Keys</h2>
          <p className="app-sub">
            Where each of your five keys is, and whether it is registered. A key that is not in this browser is loaded from its backup file when it has to sign.
          </p>
          <KeysCard profile={profile} busy={busy} ready={ready} run={run} recheck={recheck} checking={checking} note={note} />
        </section>
      )}

      {!profile && (
        <section className="app-sec" id="open" aria-labelledby="open-h">
          <h2 id="open-h">Already have a vault?</h2>
          <StartCard openOnly onCreate={() => {}} onImport={app.setProfile} note={note} />
        </section>
      )}

      {profile && (
        <section className="app-sec" id="open" aria-labelledby="info-h">
          <h2 id="info-h">Vault info file</h2>
          <InfoPanel profile={profile} onImport={app.setProfile} onForget={app.forget} />
        </section>
      )}
    </div>
  );
}
