import { Link } from 'react-router-dom';
import { ROLE_NAMES, LABEL } from '../testnet/v2/profile';
import { eq } from '../pages/Testnet';
import { AppHead, NoVault } from './Layout';
import { useVaultApp } from './context';
import { KeyChangesPanel, RecoveryPanel, useSeedOf } from './panels';

/** Recovery: what guardians can and cannot do, the recovery itself, and replacing the guardians. */
export default function RecoveryPage() {
  const { profile, view, busy, ready, run, refresh, recheck, checking, note } = useVaultApp();
  const seedOf = useSeedOf();
  return (
    <div className="page-app">
      <AppHead
        title="Recovery"
        lede="Lost your primary or approver key? Any two of your three guardians can hand the vault to a new pair. Guardians can never move funds."
      />
      <section className="card stack rec-how" aria-label="How recovery works">
        <ol className="rec-steps">
          <li>
            <b>Two guardians start it</b>
            <span>They name a new primary and approver. Outflows freeze and FAST stops at once.</span>
          </li>
          <li>
            <b>Seven days to object</b>
            <span>Any two guardians can cancel in this time. Nothing can leave the vault.</span>
          </li>
          <li>
            <b>Anyone finalizes</b>
            <span>Over the next seven days. The new pair takes over; FAST stays off until they grant a new allowance.</span>
          </li>
        </ol>
      </section>
      {!profile?.vault ? (
        <NoVault what="Recovery acts on a vault." />
      ) : !view ? (
        <section className="card">Reading the vault…</section>
      ) : (
        <>
          <section className="card stack">
            <h3>Your guardians</h3>
            <ul className="g-list">
              {ROLE_NAMES.slice(2).map((n, i) => {
                const s = profile.keys[n];
                const here = !!seedOf(s);
                const match = eq(view.roles[2 + i], s.keyId);
                return (
                  <li key={n} className="g-item">
                    <b>{LABEL[n]}</b>
                    <span className={`chip ${match ? 'ok' : 'warn'}`}>{match ? 'Matches the vault' : 'Not the vault’s guardian'}</span>
                    <span className="chip">{here ? 'Loaded in this browser' : 'Backup file only'}</span>
                  </li>
                );
              })}
            </ul>
            <p className="small muted">
              A guardian that has to sign is loaded from its backup file on the <Link to="/vault#keys">Vault › Keys</Link> list. Keep guardian files on other devices or
              with people you trust.
            </p>
          </section>
          <div className="app-grid">
            <RecoveryPanel profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} recheck={recheck} checking={checking} note={note} />
            <KeyChangesPanel only="guardians" profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} recheck={recheck} checking={checking} note={note} />
          </div>
        </>
      )}
    </div>
  );
}
