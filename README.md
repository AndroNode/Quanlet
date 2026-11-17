# Quanlet

Quanlet is a post-quantum personal vault on Robinhood Chain. Every withdrawal is signed with an
ML-DSA-44 key and waits 24 hours before anyone can execute it. A 2-of-3 recovery quorum can freeze
the vault and rotate the key with a 7-day delay. There is no admin and no upgrade path.

This repository holds the website, the Cloudflare Worker that serves it, the vault rules model,
and the smart contracts.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | Vite + React site: the landing page and the vault app (Vault, Payments, Recovery, Control) on Robinhood Chain testnet. |
| `apps/api` | Cloudflare Worker: serves the built site and `/api/health`, `/api/config`. |
| `packages/vault-model` | The 1.x protocol rules in TypeScript (timelocks, queue cap, epochs, recovery). No longer used by the site. |
| `packages/config` | Launch configuration schema (FR-28) with safe defaults. |
| `contracts` | Foundry project: protocol 1.x (`KeyFactory`, `VaultFactory`, `PersonalVault`), protocol 2.0 (`src/v2`), and the Fireblocks Labs ML-DSA-44 verifier. |
| `cli` | Standalone toolkit (`quanlet`, `quanlet v2`): keys, inspection, offline signing and transaction assembly without any Quanlet server. |

## Run it locally

Needs Node 20+, pnpm 9, and for contracts Foundry 1.7.1 and Python 3.

```sh
pnpm install
pnpm dev                       # website at http://localhost:5173
pnpm -r --filter '!@quanlet/contracts' test
cd contracts && forge test     # 104 tests with real ML-DSA-44 signatures (signed through node via ffi)
```

## Deploy

Everything deploys from GitHub Actions.

### Website (Cloudflare Workers)

`deploy-web.yml` runs only when started by hand (Actions tab, "Deploy website", Run workflow). Add two repository secrets:

- `CLOUDFLARE_API_TOKEN`: a token with the "Edit Cloudflare Workers" template permissions.
- `CLOUDFLARE_ACCOUNT_ID`

The Worker is named `quanlet` and is served at `quanlet.<your-subdomain>.workers.dev`. Add a
custom domain in the Cloudflare dashboard when ready.

Launch configuration (contract address, links, token state) is optional. Without it the site
shows safe defaults. See the comment in `apps/api/wrangler.toml` to turn on the KV namespace.

### Testnet vault page (`/testnet`)

The site's Testnet vault page runs the real protocol on Robinhood Chain Testnet. ML-DSA-44 keys are
generated in the browser (`@noble/post-quantum`) and registered with only the raw public key and a
proof of possession: KeyFactory prepares the verifier data on chain. The browser runs the same
preparation (`apps/web/src/testnet/prepare.ts`, a port of `contracts/script/prepare.py`;
`pnpm --filter @quanlet/web check:prepare` compares both byte for byte) only to know the record id in
advance. The connected wallet sends the transactions. Reads go through the Worker's read-only
`/api/rpc` proxy (Alchemy when `ALCHEMY_API_KEY` is set).

Each key is backed up to its own file (`apps/web/src/testnet/keyfile.ts`) using the whitepaper's
profile: Argon2id v1.3 (64 MiB, 3 passes, 1 lane) and XChaCha20-Poly1305, with the whole header
authenticated. A key must be restored from its file and sign a test message before it can be
registered. The primary seed stays in localStorage (testnet only); recovery keys can be removed from
the browser and loaded from their files for a single visit when two of them must sign.

End-to-end check against a local chain: start a node with chain id 46630, run
`node apps/web/scripts/local-deploy.mjs` to deploy `contracts/out`, build the web app with
`VITE_QUANLET_TESTNET='<printed JSON>'`, and run `wrangler dev --var TESTNET_RPC_URL:http://127.0.0.1:8545`.

### Contracts (Robinhood Chain)

`deploy-contracts.yml` is manual (Actions tab, "Deploy contracts", Run workflow). It:

1. runs the full test suite,
2. checks the RPC really is the chain you picked (46630 testnet, 4663 mainnet),
3. deploys the F1600 helper, verifier, `KeyFactory` and `VaultFactory`,
4. runs the Gate B smoke test: registers a throwaway key on chain, then asks the chain's own node
   to accept a valid ML-DSA-44 signature and reject a tampered one,
5. prints the manifest (`deployments/<chainId>.json`) in the run summary and uploads it.

Add the repository secret `DEPLOYER_PRIVATE_KEY` from a **new wallet used only for testnet**.
Deployment uses about 14M gas, plus about 6M for the smoke test; 0.05 testnet ETH is plenty. The
deployed contracts have no owner, so the deployer key has no power over them afterwards.

Mainnet refuses to deploy unless you type `I_ACCEPT_THE_MAINNET_GATES` in the workflow form.

## Key preparation (closed gate)

`KeyFactory.registerKey(rawPk, popSig)` takes only the 1,312-byte public key and a proof-of-possession
signature. `contracts/src/KeyPrep.sol` computes the 20,545-byte verifier blob on chain (tr by SHAKE256,
the NTT of t1, ExpandA by SHAKE128 rejection sampling, all through the code-hash-bound Keccak helper),
deploys it, checks the proof through it and marks the record ready. No prepared data is accepted from
outside. Tests compare the on-chain blob with `prepare.py` on 256 random keys plus fixed ones
(`forge test --match-contract KeyFactoryTest`).

Measured in Foundry: preparation about 6.4 million gas, a whole registration about 12.3 million gas
(preparation, blob publication and the proof check). That fits one Robinhood Chain transaction, so
the staged variant the whitepaper allows for smaller budgets is not needed.

## Standalone toolkit (`cli/`)

The whitepaper asks for a way to act on a vault without the website. `node cli/bin/quanlet.mjs v2 help` lists the
protocol 2.0 commands; `quanlet help` the 1.x ones. Every signed action is split so the key never has to be on a
networked machine:

```sh
quanlet v2 request transfer --vault 0x… --to 0x… --amount 0.1 --out t.req   # online: reads counters, writes a request
quanlet v2 sign t.req --key primary.key.json --out t.p.sig                 # offline: recomputes the digest, shows it, signs
quanlet v2 sign t.req --key approver.key.json --out t.a.sig
quanlet v2 assemble t.req t.p.sig t.a.sig --out t.tx                       # checks every signature
quanlet send t.tx                                                          # or send to/data with any wallet
```

Key backups are the website's format (each opens the other's files). `quanlet v2 pending VAULT` finds a delayed
policy change in the transaction that proposed it, so any device can finalize it. Tests: `node cli/test/run.mjs`
(offline), `node cli/test/webcompat.mjs` (website file formats), `cli/vectors/46630.v2.json` (signing vectors, rebuilt by
`quanlet v2 vectors`), `cli/scripts/drill2.mjs` (the live testnet exit drill, record in `contracts/deployments/46630.v2.exit-drill.json`), `cli/test/e2e2.mjs` (against a local fork, see its
header) and `forge test --match-contract CliV2Test` (encoders against the contracts).

## Release manifest and security notes

`node cli/scripts/manifest.mjs --chain 46630 --rpc <RPC URL>` writes `contracts/deployments/46630.release.json`,
the whitepaper section 17 manifest: source commit and file hashes, compiler settings, verifier provenance, every
contract's address and code hash (live code is compared with the local build, immutables masked), admin (none),
key preparation format, supported assets (ETH only), signing vectors (`cli/vectors/46630.json`), Foundry gas
(`GasReport.t.sol`) and live receipt costs, the Gate B record written by `Smoke.s.sol`, and toolkit file hashes.

`docs/REVIEW-SCOPE-V2.md` (protocol 2.0) and `docs/REVIEW-SCOPE.md` (1.x) are the security notes: scope, threat
model, properties to break, invariant evidence, known gaps and the internal self-review.

`docs/ACVP.md`: all 60 NIST ACVP ML-DSA-44 signature-verification vectors give the NIST result through the
on-chain verifier code (`forge test --match-contract AcvpTest`).

`SECURITY.md` says how to report a vulnerability. `docs/RISK-NOTICE.md` is the risk notice a person acknowledges
before their first deposit on mainnet.

## Before mainnet (open)

Mainnet launches directly (no beta), ETH only. `docs/MAINNET-RUNBOOK.md` has every step:

- **Deployer wallet**: a fresh wallet with about 0.005 ETH on Robinhood Chain, its key in a git-ignored env file.
- **Rehearsal**: `contracts/script/rehearse-mainnet.sh` runs the whole launch on a local mainnet fork (no key,
  nothing broadcast).
- **Deployment**: the deploy with the explicit go-ahead phrase, source verification and the release manifest
  (`cli/scripts/release2.mjs`).
- **Smoke test on mainnet**: a tiny vault with one FAST and one protected transfer and two refusals.
- **Site switch**: `cli/scripts/mainnet-config.mjs` writes `mainnetV2` into `packages/config`,
  `cli/scripts/mainnet-preflight.mjs` checks it against the chain, then a mainnet build.

## Licences

- Smart contracts (`contracts/`): MIT, see `contracts/LICENSE`. This matches the SPDX headers in every contract
  and the source already verified on the testnet explorer.
- Everything else (the website, the Worker API, the shared packages and the standalone toolkit): GNU Affero General
  Public License v3.0 only, see `LICENSE`. Anyone who runs a modified version as a network service must offer its
  source to that service's users.
- Third-party code keeps its own licence: `contracts/src/verifier` and `contracts/script/prepare.py` are from
  Fireblocks Labs (MIT, see `contracts/src/verifier/LICENSE-fireblocks`); `contracts/lib/forge-std` is MIT/Apache-2.0.
