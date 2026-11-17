# Mainnet runbook

How protocol 2.0 goes live on Robinhood Chain mainnet (chain 4663). Mainnet launches directly, without a beta,
and supports ETH only (decided 17 November 2026). Every step below is either read-only or sends transactions only
from the deployer wallet, and only after the person who owns that wallet says go.

Commands run from the repository root unless a `cd` says otherwise. Foundry 1.x, Node 20 or later and pnpm are
needed. Robinhood Chain RPC: `https://rpc.mainnet.chain.robinhood.com`; explorer:
`https://robinhoodchain.blockscout.com`.

## 0. What the deployer wallet is, and how to supply it

- A **fresh** wallet used only for this deployment. After deployment it has no power over anything: the contracts
  have no owner, no admin, no pause and no upgrade path.
- Fund it with about **0.005 ETH on Robinhood Chain mainnet**. The fork rehearsal used about 0.0003 ETH for the
  deployment and 0.0005 ETH for the smoke test (of which 0.0002 ETH stays in the smoke vault); the rest covers L1
  data fees and gas-price changes.
- Its private key goes into a file that only this machine reads, never into chat, code, a commit or a log:

  ```sh
  umask 077
  printf 'DEPLOYER_PRIVATE_KEY=0x...\n' > contracts/mainnet.env   # *.env is git-ignored
  ```

  Each step that needs it loads it for that command only (`set -a; . ./mainnet.env; set +a`) and the scripts never
  print it. Delete the file when the launch is finished.

## 1. Freeze the release commit

1. All changes merged on `master`; `git status` clean.
2. `cd contracts && forge build && forge test` passes, and `pnpm -r typecheck && pnpm -r test` passes.
3. Note the commit hash: it is the source the release manifest names.

## 2. Rehearse on a fork (no key, nothing broadcast)

```sh
contracts/script/rehearse-mainnet.sh
```

Starts a local fork of mainnet, deploys with a throwaway key funded on the fork, runs the smoke test, writes a
release manifest and a copy of the site config, and runs the preflight. Every result lands in
`contracts/deployments/rehearsal/` (git-ignored). It must end with "All 25 checks passed". The vault creation code
hash must equal the testnet one (`0xea04…a59f`), which shows the build is the same.

## 3. Deploy

```sh
cd contracts
set -a; . ./mainnet.env; set +a
QUANLET_MAINNET_GO=I_ACCEPT_THE_MAINNET_GATES FOUNDRY_PROFILE=deploy \
  forge script script/DeployV2.s.sol --rpc-url robinhood_mainnet --broadcast --slow
```

Deploys the F1600 helper, the ML-DSA-44 verifier, KeyFactoryV2, the vault code stores and VaultFactoryV2 (ETH
only), then writes `contracts/deployments/4663.v2.json`. Without the gate phrase the script refuses to run on
mainnet. If it stops halfway, do not run it again blindly: read `broadcast/DeployV2.s.sol/4663/run-latest.json`,
see which contracts exist, and continue from there (or start over with a fresh run; nothing deployed is
privileged, so unused contracts are harmless).

## 4. Verify the source on the explorer

For each contract in `4663.v2.json` (KeyFactoryV2, VaultFactoryV2, MLDSA44Verifier), through Sourcify, which the
Blockscout explorer reads (its own API sits behind a browser check that scripts cannot pass):

```sh
forge verify-contract <address> <path>:<Contract> --chain 4663 --rpc-url robinhood_mainnet \
  --verifier sourcify --guess-constructor-args --watch
```

The helper and the code stores are raw bytecode with no Solidity source; the release manifest records their code
hashes instead.

## 5. Smoke test with a tiny amount

```sh
cd contracts
set -a; . ./mainnet.env; set +a
QUANLET_MAINNET_GO=I_ACCEPT_THE_MAINNET_GATES FOUNDRY_PROFILE=deploy \
  forge script script/SmokeV2.s.sol --rpc-url robinhood_mainnet --broadcast --slow
```

Registers five real ML-DSA-44 keys derived from the deployer key, creates a vault, deposits 0.0004 ETH, sends one
FAST and one protected transfer of 0.0001 ETH each back to the deployer, and checks that an over-allowance FAST
transfer and a primary-only protected transfer are refused. Writes `contracts/deployments/4663.v2.gate-b.json`.
0.0002 ETH stays in the smoke vault under the deployer's keys.

## 6. Release manifest

```sh
cd cli
node scripts/release2.mjs --chain 4663 --verified
```

Writes `contracts/deployments/4663.v2.release.json`: source commit, compiler settings, source file hashes, every
address with its live code hash, supported assets and the smoke-test evidence. Drop `--verified` if step 4 is not
done.

## 7. Site config and preflight

```sh
cd cli
node scripts/mainnet-config.mjs      # writes mainnetV2 into packages/config/src/index.ts
node scripts/mainnet-preflight.mjs   # read-only; must end with "All 25 checks passed"
```

The preflight checks that the chain is 4663; that every manifest address holds the expected code; that the
factories point at each other, support ETH only and hold exactly the vault code the local build produces; and
that the site config matches the manifest. Commit the manifests and the config change.

## 8. Switch the website

```sh
pnpm --filter @quanlet/web build:mainnet
```

Deploy that build with the Worker variable `RELEASE_MODE = "mainnet"`, so `/api/rpc` reads chain 4663. On a
mainnet build the vault pages open only when `mainnetV2` is set, show the risk notice
(`docs/RISK-NOTICE.md`) before the first deposit, and the Docs page lists the mainnet contracts. Keep a testnet
build deployed separately as a sandbox if wanted.

Then open the live site, create nothing, and check: the footer names Robinhood Chain, the Docs page lists the
same addresses as `4663.v2.json`, and the vault pages ask for chain 4663 in the wallet.

## 9. Afterwards

- Delete `contracts/mainnet.env`. The deployer wallet can be emptied; it controls nothing.
- Optional: a guardian recovery drill on mainnet with a tiny vault. It takes 7 days by design (the recovery delay
  cannot be shortened).
- Publish the commit to the public repository with the sync script.
