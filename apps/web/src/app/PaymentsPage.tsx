import { AppHead, NoVault } from './Layout';
import { useVaultApp } from './context';
import { HistoryList, PolicyPanel, QueueTable, RelayCard, SendForm } from './panels';

/** Payments: send, the rules that limit sending, what is waiting, and what was sent. */
export default function PaymentsPage() {
  const { profile, view, now, busy, ready, run, refresh, note } = useVaultApp();
  return (
    <div className="page-app">
      <AppHead
        title="Payments"
        lede="Every payment is signed by your primary key. Small ones to people you listed go FAST with that key alone; anything else also needs your approver."
      />
      {!profile?.vault ? (
        <NoVault what="Payments leave from a vault." />
      ) : (
        <>
          <div className="app-grid pay">
            <SendForm profile={profile} view={view} now={now} busy={busy} ready={ready} run={run} refresh={refresh} note={note} />
            {view ? <PolicyPanel profile={profile} view={view} busy={busy} ready={ready} run={run} refresh={refresh} /> : <section className="card">Reading the vault…</section>}
          </div>
          <QueueTable profile={profile} view={view} now={now} busy={busy} ready={ready} run={run} refresh={refresh} />
          <HistoryList profile={profile} />
        </>
      )}
      <RelayCard busy={busy} ready={ready} run={run} />
    </div>
  );
}
