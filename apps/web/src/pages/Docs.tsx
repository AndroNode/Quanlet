import { useEffect, type ReactNode } from 'react';
import { useRelay } from '../testnet/v2/relay';
import { PageFacts, PageMark } from '../components/PageMarks';
import { useUi } from '../store';
import { DEFAULT_CONFIG } from '@quanlet/config';
import { IS_MAINNET } from '../net';

const MAINNET_V2 = DEFAULT_CONFIG.deployments.mainnetV2;
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Protocol 2.0 on Robinhood Chain mainnet, from packages/config (written from contracts/deployments/4663.v2.json). */
const MAINNET: Array<[string, string]> = MAINNET_V2
  ? [
      ['KeyFactoryV2', MAINNET_V2.keyFactory],
      ['VaultFactoryV2 (ETH only)', MAINNET_V2.vaultFactory],
      ...MAINNET_V2.vaultCodeStores.map((a, i): [string, string] => [`Vault code store ${i + 1}`, a]),
      ['ML-DSA-44 verifier', MAINNET_V2.verifier],
      ...(MAINNET_V2.f1600Helper ? [['F1600 helper', MAINNET_V2.f1600Helper] as [string, string]] : []),
    ]
  : [];
const LIVE_SINCE = MAINNET_V2?.deployedOn ? longDate(MAINNET_V2.deployedOn) : null;


// From contracts/deployments/46630.v2.json and 46630.v2.tokens.json (protocol 2.0 testnet contracts).
const TESTNET_V2: Array<[string, string]> = [
  ['KeyFactoryV2', '0x3cc65726274462e15c031956dD0560400e25Caf5'],
  ['VaultFactoryV2 (ETH and test stock tokens)', '0x8bA8297d0ddd6DE27E127C0b1B18102805AE99bC'],
  ['VaultFactoryV2 (ETH only, first)', '0xE8A8F2F714f06fdd83630958FD23503872549db3'],
  ['Vault code store 1', '0x1a4104a075b3CF6b9ecC86015462893beA2B43e7'],
  ['Vault code store 2', '0x741d809e810dCFdEE6D97cC4866d2e87429E69aC'],
  ['ML-DSA-44 verifier (shared)', '0xb968d948271dc4F0DE95E904E7f6B09AE23D780c'],
  ['F1600 helper (shared)', '0xEB38AaA050e8ce2d0E56d735c607b9496af9F003'],
];
// From contracts/deployments/46630.json (protocol 1.0 testnet contracts, kept for earlier vaults).
const TESTNET: Array<[string, string]> = [
  ['KeyFactory', '0x68335F07BC58F1057b59bBFb378e804eFaC7Db0d'],
  ['VaultFactory', '0xE8cB1b0B90142C55068af0f212030f93847049B3'],
  ['ML-DSA-44 verifier', '0xb968d948271dc4F0DE95E904E7f6B09AE23D780c'],
  ['F1600 helper', '0xEB38AaA050e8ce2d0E56d735c607b9496af9F003'],
];

function DeployTable({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="table-wrap">
      <table className="deploy">
        <tbody>
          {rows.map(([name, addr]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td style={{ overflowWrap: 'anywhere' }}>{addr}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTIONS: Array<{ id: string; title: string; ref: string; body: ReactNode }> = [
  {
    id: 'status',
    title: 'Release status',
    ref: '§§01, 18',
    body: (
      <>
        {IS_MAINNET ? (
          <p>
            {MAINNET_V2
              ? `${LIVE_SINCE ? `Quanlet has run protocol 2.0 on Robinhood Chain mainnet since ${LIVE_SINCE}` : 'Quanlet runs protocol 2.0 on Robinhood Chain mainnet'}. Vaults hold ETH only. The whitepaper specifies protocol 2.0. Deployed features and contract addresses are identified by release manifests, not by the whitepaper.`
              : 'Quanlet is preparing its Robinhood Chain mainnet deployment; the mainnet contracts are not deployed yet. The whitepaper specifies protocol 2.0. Deployed features and contract addresses are identified by release manifests, not by the whitepaper.'}
          </p>
        ) : (
          <p>As of 16 November 2026, Quanlet is at the testnet stage and mainnet is not live. The whitepaper specifies protocol 2.0. Deployed features and contract addresses are identified by release manifests, not by the whitepaper.</p>
        )}
        <p>
          Release follows these stages: encoding conformance; cryptographic and chain feasibility; a complete personal-vault testnet; production personal vaults; then separate product expansion. Availability is set by completed gates, never by a calendar or token milestone.
        </p>
        {IS_MAINNET ? (
          MAINNET_V2 && <p>The vault on this website runs the protocol 2.0 contracts listed below on Robinhood Chain mainnet. Deposits are real ETH.</p>
        ) : (
          <p>The vault on this website runs the protocol 2.0 contracts listed below on Robinhood Chain testnet, where ETH has no value.</p>
        )}
      </>
    ),
  },
  ...(IS_MAINNET && MAINNET_V2
    ? [
        {
          id: 'mainnet',
          title: 'Mainnet deployment',
          ref: 'chain 4663',
          body: (
            <>
              <p>
                Robinhood Chain (chain id 4663). Five keys per vault, FAST and protected routes, an optional protected delay and guardian recovery, as described on this page. Vaults hold ETH only; tokens sent to a vault cannot be moved out of it. The contracts have no owner, no pause and no upgrade path.
              </p>
              <DeployTable rows={MAINNET} />
            </>
          ),
        },
      ]
    : []),
  {
    id: 'testnet',
    title: 'Testnet deployment',
    ref: 'chain 46630',
    body: (
      <>
        <p>
          Robinhood Chain testnet (chain id 46630). Protocol 2.0 was deployed on 16 November 2026: five keys per vault, FAST and protected routes, an optional protected delay and guardian recovery, as described on this page. New vaults can hold ETH and the five test stock tokens from the official Robinhood faucet (TSLA, AMZN, PLTR, NFLX, AMD); vaults from the first factory hold ETH only. Both factories share one key factory. The contracts have no owner and no upgrade path. Testnet only: never send real funds.
        </p>
        <DeployTable rows={TESTNET_V2} />
        <p>
          The earlier protocol 1.0 contracts stay on chain so vaults made before 16 November keep working on the 1.0 vault page. They implement one primary key, three recovery keys and a fixed 24-hour withdrawal delay.
        </p>
        <DeployTable rows={TESTNET} />
      </>
    ),
  },
  {
    id: 'roles',
    title: 'Keys and roles',
    ref: '§§02, 04',
    body: (
      <>
        <p>
          A vault has five independent ML-DSA-44 keys. The primary (P) initiates payments. The independent approver (A) co-signs protected payments and administrative changes, and cannot spend alone. Three guardians (G1, G2, G3) exist only for recovery. All five key identifiers must be distinct.
        </p>
        <p>
          The wallet or relayer that submits a transaction pays gas and gains no authority. Transaction sender, an ordinary wallet signature, a platform login or a token balance never grants spending power. Connecting a wallet does not protect balances outside the vault.
        </p>
        <p>The same person may control P and A, but their signing material and approval devices must be separate. Two keys on one infected device are not independent.</p>
      </>
    ),
  },
  {
    id: 'routes',
    title: 'Payment routes and policy',
    ref: '§07',
    body: (
      <>
        <p>
          <strong>Guarded</strong> is the default: every transfer needs P and A, and there is no waiting period. <strong>Flexible</strong> is an explicit opt-in that adds a finite FAST allowance for primary-only payments to approved addresses. Every payment outside that allowance still needs both keys.
        </p>
        <ul>
          <li>FAST: P signs; executes immediately if the allowance, recipient, asset and fee checks pass, or is rejected. It never silently falls back to a timer.</li>
          <li>PROTECTED with no timelock: P and A sign the identical request; it executes in the submitting transaction.</li>
          <li>PROTECTED with a timelock: the same two signatures create a queue entry that executes only after the elected delay.</li>
        </ul>
        <p>The route is signed. A relay cannot downgrade a protected payment, change the destination, raise the fee or create a delayed fallback. Limits are integer amounts in each asset's own units; there is no price oracle and no dollar cap.</p>
      </>
    ),
  },
  {
    id: 'allowance',
    title: 'FAST allowance',
    ref: '§08',
    body: (
      <>
        <p>
          Each asset has a lifetime FAST debit and an absolute ceiling approved by both keys. The amount available is the ceiling minus the debit. The debit only ever rises: deposits, time, policy edits, key rotation, recovery and epoch changes never reset it. A new grant of B units sets the ceiling to the current debit plus B.
        </p>
        <ul>
          <li>An ETH payment debits the amount plus the exact relay fee. A token payment debits the token, and any ETH fee is debited from the ETH allowance.</li>
          <li>Each grant has a per-action cap, up to 16 approved recipients per asset, and lasts at most 30 days. Renewal needs fresh P and A approvals; unused authority expires.</li>
          <li>Example: with 0.10 ETH remaining and a 0.05 ETH per-action cap, two 0.04 ETH payments with a 0.001 ETH fee leave 0.018 ETH, and a further 0.02 ETH payment is rejected however long you wait.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'timelock',
    title: 'Optional timelock',
    ref: '§10',
    body: (
      <ul>
        <li>The protected delay is 0, 1, 24 or 72 hours; zero is the default. A nonzero delay applies to every protected payment and cannot be waived, even by P and A together.</li>
        <li>A FAST allowance stays immediate even under a timelock. To delay every withdrawal, disable FAST.</li>
        <li>Queued payments become executable after the delay and expire 604,800 seconds (7 days) later. Anyone may execute a mature entry; at most 32 live entries exist per execution epoch, and the queue reserves no balance.</li>
        <li>Either P or A can cancel a queued payment, invalidate all spending approvals or suspend FAST on its own. These actions restrict spending but never expand it.</li>
        <li>A timelock gives time to detect and stop a request; it does not stop a theft that goes unnoticed.</li>
      </ul>
    ),
  },
  {
    id: 'execution',
    title: 'Signatures, nonces and fees',
    ref: '§09, App. A',
    body: (
      <ul>
        <li>A signature is valid only from validAfter until just before validUntil, a span of at most 1,800 seconds. All required signers sign identical bytes; duplicate keys never count twice.</li>
        <li>Five separate nonce lanes (spending, administration, primary safety, approver safety, recovery) and three epochs (authority, policy, execution) prevent replay. Recovery approvals bind only the authority epoch, so spending-side changes cannot void them.</li>
        <li>An asset payment and its optional fixed ETH relay fee succeed together or the whole transaction reverts. Cancellation, recovery, configuration and key setup never draw fees from the vault.</li>
      </ul>
    ),
  },
  {
    id: 'admin',
    title: 'Policy and key changes',
    ref: '§11',
    body: (
      <>
        <p>
          Granting or renewing an allowance, editing recipients, choosing the timelock, resuming FAST and rotating a spending key all need both current spending keys. With no timelock they apply at once. With a timelock they wait out the current delay, so lowering 24 hours to zero still takes 24 hours.
        </p>
        <p>
          A delayed change freezes outflows until it is finalized, cancelled by P and A, or expired 7 days after it matures. Only one security proposal is live at a time. A key cannot be both primary and approver, a guardian cannot hold a spending role, and there is no way to lower the signature requirement to one.
        </p>
      </>
    ),
  },
  {
    id: 'recovery',
    title: 'Recovery and guardians',
    ref: '§12',
    body: (
      <>
        <p>
          Any two current guardians can propose a new primary and a new approver together. The moment it is accepted, outflows freeze, FAST is suspended and queued payments and spending approvals are invalidated. Anyone can finalize from day 7 until just before day 14; from day 14 anyone can clear it. Recovery can preempt any other pending proposal, but not another recovery.
        </p>
        <p>
          Two current guardians can cancel; the current P and A cannot veto. Finalization installs exactly the committed pair, disables FAST and keeps the timelock and lifetime counters. Recovery never transfers assets. Replacing the guardians needs P, A and two current guardians plus consent from all three designated guardians, with a fixed 7-day delay.
        </p>
        <p>Without the spending pair and without a guardian quorum, funds are inaccessible. There is no support or login reset.</p>
      </>
    ),
  },
  {
    id: 'setup',
    title: 'Setup and key custody',
    ref: '§§05, 06',
    body: (
      <>
        <p>
          Quanlet uses ML-DSA-44 (FIPS 204): 1,312-byte public keys and 2,420-byte signatures over a 32-byte action digest, with an empty context. KeyFactory prepares each raw key onchain and activates it with a registration-only proof of possession.
        </p>
        <p>
          Each key is generated on its intended device with operating-system randomness and backed up to its own encrypted file (Argon2id, 64 MiB, three passes; XChaCha20-Poly1305), with its own password and a restore-and-sign check. All five keys sign the same setup digest, and the factory deploys the vault atomically. Check the deployed configuration, start with a small transfer and rehearse every enabled path before adding more.
        </p>
      </>
    ),
  },
  {
    id: 'immutability',
    title: 'Immutability and independence',
    ref: '§§04, 13, 16',
    body: (
      <p>
        Vault contracts are non-upgradeable, with no proxy administrator, operator pause, platform withdrawal power or reset key. Owners change only the policy fields and roles the code allows. Migration is an ordinary authorized transfer to a separately deployed vault. A serious flaw cannot be patched in place. The protocol calls for a standalone command-line toolkit so owners can act through any RPC if the website, relay or alerts fail. It is published with the source code (cli/ in the repository); a separate local signing interface is not.
      </p>
    ),
  },
  {
    id: 'fees',
    title: 'Fees and token policy',
    ref: '§14',
    body: (
      <>
        <p>The core vault charges no exit fee and no percentage of assets. Network gas is paid in ETH by the submitter. An optional relay may quote a fixed ETH charge that the required signers approve and that is paid only with a successful transfer.</p>
        <p>Custody, signing, recovery and withdrawals need no Quanlet token. No yield, staking reward, revenue share or buyback is part of the protocol, and no token vote can change a vault's owner, weaken signatures or block an exit.</p>
      </>
    ),
  },
  {
    id: 'limits',
    title: 'Limits',
    ref: '§§03, 16',
    body: (
      <ul>
        <li>Quanlet protects a vault's authorization path. It does not make Robinhood Chain, bridges, token issuers, ordinary wallets, signing devices or connected apps quantum-resistant.</li>
        <li>A stolen primary alone can spend only a remaining FAST allowance. If both spending keys are compromised, the whole balance is exposed; only an elected timelock and timely guardian action can help.</li>
        <li>Two colluding guardians can take control after the delay and repeatedly freeze the vault.</li>
        <li>Independent approvals cannot stop you approving a harmful payment on both devices.</li>
        <li>Balances, requests, configuration and recovery events are public onchain. No insurance, restitution or investment return is offered. "Instant" means no extra Quanlet delay, not instant network finality.</li>
      </ul>
    ),
  },
  {
    id: 'roadmap',
    title: 'Later products',
    ref: '§14',
    body: (
      <ul>
        <li>Quanlet Treasury: three-of-five independent spending approvals with a separately defined recovery policy.</li>
        <li>Quanlet Account: reviewed application execution with budgets, targets and expiry bound to each permission.</li>
        <li>Quanlet Guard and SDK: permission and dependency reports; key creation, encoding, signing and submission tools.</li>
      </ul>
    ),
  },
];

const FAQ: Array<[string, string]> = [
  [
    'Is it live?',
    IS_MAINNET && MAINNET_V2
      ? `Yes. ${LIVE_SINCE ? `Quanlet has been live on Robinhood Chain mainnet since ${LIVE_SINCE}` : 'Quanlet is live on Robinhood Chain mainnet'}, for ETH only. The protocol 2.0 testnet stays deployed for practice, where ETH has no value.`
      : 'Not on mainnet. As of 16 November 2026 Quanlet is at the testnet stage. The vault runs the protocol 2.0 contracts on Robinhood Chain testnet, where ETH has no value. Nothing here holds real funds yet.',
  ],
  ['Does connecting my wallet protect it?', 'No. Connecting shares a public address and nothing else. Only assets moved into a configured Quanlet vault fall under its rules.'],
  ['Do withdrawals have to wait?', 'Not by default. A protected payment signed by both the primary and the approver executes at once unless you elect a 1, 24 or 72 hour timelock. FAST payments inside a finite allowance are also immediate.'],
  ['What if my primary key is stolen?', 'Alone it cannot move the reserve, because protected payments also need the approver. If you enabled a FAST allowance, a thief can spend only what is left of it before it expires. The approver can suspend FAST and invalidate approvals, and two guardians can start recovery.'],
  ['Can the Quanlet team withdraw my funds?', 'No. Vaults have no administrator or upgrade path. The operator can run or stop hosted services, but cannot move funds, reset keys or change vault rules.'],
  ['Can I recover a lost key?', 'Yes, while two guardians are available: any two of your three guardians can replace the primary and the approver together after 7 days. Without the spending pair and without a guardian quorum, the funds cannot be recovered.'],
  ['What if two guardians collude?', 'They can replace your spending pair after the 7-day delay and can repeatedly freeze the vault. Neither the spending keys nor one honest guardian can veto them, so choose independent guardians.'],
  ['Is all of Robinhood Chain quantum-resistant?', 'No. Quanlet uses post-quantum signatures for vault authorization only. The chain, bridges, token contracts and your other accounts keep their own security.'],
  ['Do I need a token?', 'No. Custody, signing, recovery and withdrawals work without any token. The QUANLET token on Robinhood Chain (0x62cc5a8Ad309c306fC744d901517Fa38993a5235) is separate from the vault contracts and gives no power over any vault.'],
  ['Are withdrawals free?', 'The vault charges no exit fee. Someone still pays network gas in ETH, and an optional relay may charge a fixed ETH fee that the required signers see and approve.'],
];

export default function Docs() {
  const cfg = useUi((s) => s.config);
  const relay = useRelay((s) => s.status);
  const loadRelay = useRelay((s) => s.load);
  useEffect(() => void loadRelay(), [loadRelay]);
  const relayOn = !!relay?.enabled;
  return (
    <div className="wrap page">
      <header className="page-head ph ph-docs">
        <div className="ph-copy">
          <div className="eyebrow">
            <span className="chip">{cfg.docsVersion} · 13 November 2026</span>
          </div>
          <h1>Docs</h1>
          <p className="muted">A plain summary of the Quanlet technical whitepaper v2.0 (protocol 2.0). Section numbers refer to the whitepaper, which is the source of truth for protocol rules.</p>
          <PageFacts facts={[[String(SECTIONS.length), 'Sections on this page'], ['v2.0', 'Whitepaper'], ['§ refs', 'Match the whitepaper']]} />
        </div>
        <PageMark kind="docs" />
      </header>
      <div className="docs-layout">
        <nav className="toc" aria-label="On this page">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.title}
            </a>
          ))}
          <a href="#faq">FAQ</a>
          <a href="#gaps">Known gaps</a>
        </nav>
        <div className="prose">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`h-${s.id}`}>
              <h2 id={`h-${s.id}`}>
                {s.title} <span className="tag">Whitepaper {s.ref}</span>
              </h2>
              {s.body}
            </section>
          ))}
          <section id="faq" aria-labelledby="h-faq">
            <h2 id="h-faq">FAQ</h2>
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p style={{ marginTop: 8 }}>{a}</p>
              </details>
            ))}
          </section>
          <section id="gaps" aria-labelledby="h-gaps">
            <h2 id="h-gaps">Known gaps</h2>
            <ul>
              {relayOn ? (
                <li>
                  The Quanlet relayer can send a signed transfer and pay its gas, for a small ETH fee the vault pays in the same transaction. Your keys sign the fee and the relayer’s address, so it can change nothing and holds no power over any vault. FAST pays it only if your payment rules list it.
                </li>
              ) : (
                <li>There is no hosted relayer: the vault pages can sign a transfer for a relayer and submit one, but nobody runs a relayer service yet.</li>
              )}
              <li>The deployed 2.0 vault contract is 26,712 bytes, larger than Ethereum’s 24,576-byte limit. Robinhood Chain testnet and mainnet both accept contracts up to 98,304 bytes.</li>
              {!(IS_MAINNET && MAINNET_V2) && <li>No mainnet address has been published.</li>}
              {IS_MAINNET && MAINNET_V2 && <li>Mainnet vaults hold ETH only. Supporting tokens needs a new vault factory; existing vaults keep the assets they were created with.</li>}
              <li>The onchain verifier gives NIST's result on all 60 official ML-DSA-44 signature-verification test vectors (ACVP). That shows it follows FIPS 204 on those cases.</li>
              <li>Protocol 2.0 gas, measured in Foundry: registering and activating a key about 12.6 million, creating a vault with five consents about 13.5 million, a FAST transfer about 1.7 million, a protected transfer about 3.2 million, and starting a recovery about 6.4 million.</li>
              <li>The source code and the standalone toolkit are published on GitHub (contracts MIT, everything else AGPL-3.0). A separate local signing interface is not published.</li>
              <li>The official X account is @Quanlet_XYZ. Support channels are not announced.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
