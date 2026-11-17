import { Link } from 'react-router-dom';
import { PageHead } from '../components/ui';
import { IS_MAINNET } from '../net';

const STEPS: Array<{ title: string; body: string; where: string; link: [string, string] }> = [
  {
    title: 'Create five independent keys',
    body: 'Generate the primary (P) and the independent approver (A) on separate signing devices, and each of the three guardian keys in its own custody environment. Export one encrypted backup per key and test a restore and signature for each.',
    where: 'On your devices',
    link: ['/vault', 'Make your keys'],
  },
  {
    title: 'Register keys and deploy the vault',
    body: 'KeyFactory prepares each public key onchain and activates it with proof of possession. All five keys sign the same setup digest, and the factory deploys the vault fully configured in one step, with no admin.',
    where: 'On chain',
    link: ['/vault', 'Create a vault'],
  },
  {
    title: 'Choose a policy, check, then fund',
    body: 'Guarded is the default: every payment needs P and A, with no timelock. Verify the deployed configuration through an independent RPC or local toolkit, send a small amount, and try each payment path before adding more.',
    where: 'On chain',
    link: ['/vault', 'Fund your vault'],
  },
  {
    title: 'Pay with two signatures',
    body: 'Both devices show the exact route, asset, amount, recipient and fee, and both keys sign the identical request. With no timelock elected it executes in the submitting transaction. Anyone can submit and pay gas, but gains no authority.',
    where: 'Signed on your devices, verified on chain',
    link: ['/payments', 'Send a payment'],
  },
  {
    title: 'Optional: a finite FAST allowance',
    body: 'P and A can grant the primary a finite, expiring allowance to approved recipients, at most 30 days long. Primary-only payments inside it execute at once. It never refills: renewing it needs both keys again.',
    where: 'On chain',
    link: ['/payments#rules', 'Set an allowance'],
  },
  {
    title: 'Optional: a timelock',
    body: 'Elect a 1, 24 or 72 hour delay for every protected payment. Queued payments can be executed by anyone for 7 days after they mature; either P or A can cancel one first. Lowering the delay waits out the current one.',
    where: 'On chain',
    link: ['/payments#rules', 'Set a delay'],
  },
];

export default function HowItWorks() {
  return (
    <div className="wrap page">
      <PageHead title="How it works" kind="how" facts={[['6', 'Steps, setup to payment'], ['2', 'Branches when things go wrong'], ['2', 'Signatures for every protected payment']]}>
        <p className="muted">From setup to payment, with recovery as the branch for a lost or stolen spending key. Each step links to the page where you can do it.</p>
      </PageHead>
      <div className="grid two">
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <p className="small">
                <span className="tag">{s.where}</span> <Link to={s.link[0]}>{s.link[1]} →</Link>
              </p>
            </li>
          ))}
        </ol>
        <div className="stack">
          <div className="card">
            <h3>Branch: a spending key is lost or stolen</h3>
            <ol className="small" style={{ paddingLeft: 18 }}>
              <li>Two of the three guardians propose a new primary and a new approver together.</li>
              <li>The moment it is accepted, outflows freeze, FAST is suspended and every queued withdrawal and pending spending approval becomes void.</li>
              <li>From day 7 until day 14, anyone can finalize; exactly the committed pair is installed.</li>
              <li>If nobody finalizes, anyone can clear the proposal from day 14; the old keys resume, with FAST still suspended.</li>
              <li>After recovery, FAST stays off until P and A enable it again; protected payments keep the elected timelock.</li>
            </ol>
            <Link to="/recovery">Start a recovery →</Link>
          </div>
          <div className="card">
            <h3>Branch: one key may be compromised</h3>
            <p className="small">
              A stolen primary alone cannot move the reserve; at most it can spend what remains of a FAST allowance. Either spending key can suspend FAST, invalidate pending approvals or cancel a queued payment on its own. If both spending keys are compromised, only a timelock and timely guardian recovery can help.
            </p>
            <Link to="/control">Use the safety actions →</Link>
          </div>
          <div className="card flat">
            <h3>Where it runs</h3>
            <p className="small">
              Key records, the vault, its policy, allowances and timers live on Robinhood Chain, and ML-DSA-44 signatures are verified by a contract. Your keys are made and kept on your devices. {IS_MAINNET ? 'Quanlet runs on Robinhood Chain mainnet, for ETH only.' : 'Quanlet runs on Robinhood Chain testnet today, where ETH has no value; mainnet follows the testnet.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
