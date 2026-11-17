import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { TARGET_NAME, short } from '../wallet';
import { STATE } from '../testnet/v2/chain';
import { Ext, link } from '../pages/Testnet';
import { VaultAppProvider, useVaultApp } from './context';
import { PendingCard, STATE_TEXT } from './panels';
import { BETA, IS_MAINNET, NET, VAULTS_OPEN, WORDS } from '../net';
import './app.css';

/**
 * The vault, split into four pages that share one state: Vault (set up, fund, keys), Payments (send, rules, queue),
 * Recovery (guardians) and Control (who can do what, brakes, key changes). Runs on the network this build serves
 * (net.ts): Robinhood Chain testnet, or mainnet once its contracts are deployed.
 */

export const APP_TABS: Array<[string, string, string]> = [
  ['/vault', 'Vault', 'Set up, fund and see your vault'],
  ['/payments', 'Payments', 'Send, set limits, see the queue'],
  ['/recovery', 'Recovery', 'Guardians and lost keys'],
  ['/control', 'Control', 'Brakes and key changes'],
];

function Icon({ name }: { name: string }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden className="app-ico">
      {name === '/vault' && (
        <g {...p}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="1" />
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 8.8V7M12 17v-1.8M15.2 12H17M7 12h1.8" />
        </g>
      )}
      {name === '/payments' && (
        <g {...p}>
          <path d="M4 8h13l-3-3M20 16H7l3 3" />
        </g>
      )}
      {name === '/recovery' && (
        <g {...p}>
          <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
          <path d="M4.5 4.5V9H9" />
          <circle cx="12" cy="12" r="1.6" />
        </g>
      )}
      {name === '/control' && (
        <g {...p}>
          <path d="M6 4v16M12 4v16M18 4v16" />
          <circle cx="6" cy="15" r="2" fill="currentColor" />
          <circle cx="12" cy="8" r="2" fill="currentColor" />
          <circle cx="18" cy="13" r="2" fill="currentColor" />
        </g>
      )}
    </svg>
  );
}

function AppFrame() {
  const app = useVaultApp();
  const { profile, view, activity, setActivity } = app;
  const pending = !!view && view.state !== STATE.Active;
  return (
    <div className="app">
      <div className="app-bar">
        <div className="wrap app-bar-in">
          <nav className="app-tabs" aria-label="Vault sections">
            {APP_TABS.map(([to, label]) => (
              <NavLink key={to} to={to} className="app-tab">
                <Icon name={to} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="app-status">
            <span className="chip ok" title={WORDS.chipTitle}>
              <span className="dot live" aria-hidden /> {TARGET_NAME}
            </span>
            {profile?.vault && (
              <button className="btn ghost xs" onClick={() => void app.refresh()} title="Read the vault from the chain again">
                Refresh
              </button>
            )}
            {profile?.vault && (
              <Link to="/vault" className={`chip ${pending ? 'warn' : ''}`} title={profile.vault}>
                Vault {short(profile.vault)}
                {view ? ` · ${STATE_TEXT[view.state]}` : ''}
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="wrap app-main">
        {IS_MAINNET && (
          <div className="notice app-beta" role="note">
            <strong>Capped beta.</strong> The contracts are new. Use only amounts you can afford to lose
            {BETA.vaultCapEth ? `; this site accepts up to ${BETA.vaultCapEth} ETH per vault` : ''}.
            {BETA.termsUrl && (
              <>
                {' '}
                <a href={BETA.termsUrl}>Read the beta terms and risk notice</a>.
              </>
            )}
          </div>
        )}
        {profile?.vault && view && pending && (
          <div className="app-pending">
            <PendingCard profile={profile} view={view} now={app.now} busy={app.busy} ready={app.ready} run={app.run} refresh={app.refresh} />
          </div>
        )}
        <Outlet />
      </div>
      {createPortal(
      <div className={`tn-activity app-toast ${activity ? activity.kind : ''}`} aria-live="polite" role="status">
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
      </div>,
      document.body,
      )}
    </div>
  );
}

/** A mainnet build before the contracts are deployed: no vault can be set up yet, and no chain is read. */
function NotOpen() {
  return (
    <div className="app">
      <div className="wrap app-main">
        <header className="app-head">
          <div>
            <h1>Vaults open after deployment</h1>
            <p className="app-lede">
              Quanlet vaults on {NET.name} open once the contracts are deployed and their code is checked against the published release. Nothing can be set up here
              yet, and this page reads no chain.
            </p>
          </div>
        </header>
        <section className="card stack">
          <h3>Until then</h3>
          <p className="muted">Read how a vault protects assets, and what it does not protect.</p>
          <div className="row">
            <Link className="btn primary" to="/how-it-works">
              How it works
            </Link>
            <Link className="btn ghost" to="/docs#gaps">
              Known gaps
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function VaultLayout() {
  if (!VAULTS_OPEN) return <NotOpen />;
  return (
    <VaultAppProvider>
      <AppFrame />
    </VaultAppProvider>
  );
}

/** Page title for the vault pages: what this page is for, in one line. */
export function AppHead({ title, lede, aside }: { title: string; lede: ReactNode; aside?: ReactNode }) {
  return (
    <header className="app-head">
      <div>
        <h1>{title}</h1>
        <p className="app-lede">{lede}</p>
      </div>
      {aside}
    </header>
  );
}

/** Shown on a page that needs a vault when this browser has none yet. */
export function NoVault({ what }: { what: string }) {
  return (
    <section className="card stack app-empty">
      <h3>No vault in this browser yet</h3>
      <p className="muted">{what} Set up a vault first: it takes six short steps{IS_MAINNET ? '' : ', and everything runs on the testnet'}.</p>
      <div className="row">
        <Link className="btn primary" to="/vault">
          Set up your vault
        </Link>
        <Link className="btn ghost" to="/vault#open">
          Open a vault I already have
        </Link>
      </div>
    </section>
  );
}
