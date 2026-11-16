import { AppHead, NoVault } from './Layout';
import { useVaultApp } from './context';
import { ConfigPanel, KeyChangesPanel, SafetyActions } from './panels';

/** Who may do what is fixed in the contract; this table is that rule, written out. */
const POWERS: Array<[string, string, string, string, string]> = [
  ['Pay within the FAST allowance', 'Yes', 'No', 'No', 'No'],
  ['Make a protected payment', 'With A', 'With P', 'No', 'No'],
  ['Cancel a queued payment', 'Yes', 'Yes', 'No', 'No'],
  ['Freeze queued payments, suspend FAST', 'Yes', 'Yes', 'No', 'No'],
  ['Change the payment rules', 'With A', 'With P', 'No', 'No'],
  ['Replace the primary or approver', 'With A', 'With P', 'Two of three', 'No'],
  ['Replace the guardians', 'With A + two G', 'With P + two G', 'Two, with P and A', 'No'],
  ['Cancel a pending rules or key change', 'With A', 'With P', 'No', 'No'],
  ['Cancel a recovery or guardian change', 'No', 'No', 'Two of three', 'No'],
  ['Execute a ready payment or change', 'Yes', 'Yes', 'Yes', 'Yes'],
];

export default function ControlPage() {
  const { profile, view, busy, ready, run, refresh, recheck, checking, note } = useVaultApp();
  return (
    <div className="page-app">
      <AppHead title="Control" lede="Who can do what in your vault, the brakes either spending key can pull alone, and how to replace a spending key." />
      <section className="card stack">
        <h3>Who can do what</h3>
        <div className="table-wrap">
          <table className="powers2">
            <thead>
              <tr>
                <th>Action</th>
                <th>Primary</th>
                <th>Approver</th>
                <th>Guardians</th>
                <th>Any wallet</th>
              </tr>
            </thead>
            <tbody>
              {POWERS.map(([a, ...cells]) => (
                <tr key={a}>
                  <th scope="row">{a}</th>
                  {cells.map((c, i) => (
                    <td key={i} className={c === 'No' ? 'no' : c === 'Yes' ? 'yes' : 'with'}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">“Any wallet” pays gas. It can carry a payment or change your keys already signed; it cannot make or alter one.</p>
      </section>
      {!profile?.vault ? (
        <NoVault what="Brakes and key changes act on a vault." />
      ) : (
        <>
          <SafetyActions profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} />
          {view && (
            <div className="app-grid">
              <KeyChangesPanel only="rotate" profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} recheck={recheck} checking={checking} note={note} />
              <ConfigPanel profile={profile} view={view} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
