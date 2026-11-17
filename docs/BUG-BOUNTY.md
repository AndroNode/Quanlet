# Bug bounty programme (draft)

Status: **draft, not launched, not funded.** The reward amounts below are a proposal. The budget, the platform
and the launch date are the project owner's decision. The whitepaper (v2.0, section 18, Gate 4) requires a funded
programme before any beta that accepts real assets.

## Proposed phases

| Phase | When | Funds at risk | Rewards |
| --- | --- | --- | --- |
| 0. Testnet programme | Now, self-run | None (testnet only) | Small fixed rewards, see below |
| 1. Beta programme | Before the first beta with real assets | Capped deposits | Full tiers below, funded in advance |
| 2. Mainnet programme | Mainnet launch | All deposits | Tiers raised in line with total value held |

Recommendation: start Phase 0 now on the testnet contracts, self-run through `SECURITY.md`. Move to a
platform such as Immunefi or Cantina for Phase 1, because they handle triage, payout escrow and reach
researchers who specialise in EVM.

## Scope

In scope (the files and code hashes in `contracts/deployments/46630.v2.release.json` for protocol 2.0 and
`contracts/deployments/46630.release.json` for protocol 1.0):

- Protocol 2.0: `PersonalVaultV2`, `VaultFactoryV2` (both testnet factories), `KeyFactoryV2`, and the rules in
  `docs/REVIEW-SCOPE-V2.md` §3 (for example: FAST spending beyond the granted allowance, an outflow while a change is
  pending, a signature accepted twice or outside its window, recovery that moves funds or that P or A can block).

- `PersonalVault`, `KeyFactory`, `VaultFactory` and the ML-DSA-44 verifier and its Keccak helper, as deployed
  on Robinhood Chain testnet at the addresses on the Docs page.
- On-chain key preparation (`KeyPrep`).
- The signing path in the command-line toolkit (`cli/`, including `quanlet v2`) and the website's vault pages:
  anything that makes a client sign something other than what it shows, or leaks key material.
- The key-backup format (Argon2id and XChaCha20-Poly1305).

Out of scope: the marketing pages, the Cloudflare Worker API, Robinhood Chain itself,
bridges, ERC-20 token contracts, third-party wallets, issues that need a compromised user device or a stolen
key, spam or denial of service that only costs the attacker gas (QR-06), and findings already listed in
`REVIEW-SCOPE.md` §7.

## Severity and proposed rewards

| Severity | Examples | Phase 0 (testnet) | Phase 1 (beta) |
| --- | --- | --- | --- |
| Critical | Withdraw from a vault without a valid owner signature; the verifier accepts a forged signature; recovery without the required signers; funds locked forever | US$5,000 | 10% of funds at risk, at least US$25,000, at most US$100,000 |
| High | Bypass a withdrawal delay or cancel window; make a client sign a different action than it shows; take a relay fee that was not signed | US$1,500 | US$10,000 |
| Medium | Block a vault's owner from acting for a long time at low cost; break a documented invariant without loss of funds | US$500 | US$2,500 |
| Low | Incorrect events or view functions, issues with a clear limit on harm | US$100 | US$500 |

Phase 0 total reserve suggestion: US$10,000. Phase 1 reserve: at least the largest critical reward, held
before launch.

## Rules

- Test only on testnet or a local fork. Never against other people's vaults or real funds.
- Report privately (see `SECURITY.md`); do not publish until the fix is deployed or 90 days have passed,
  whichever comes first, unless agreed otherwise.
- The first clear report of an issue gets the reward. Include steps or a test that reproduces it.
- No social engineering, phishing or attacks on the people or infrastructure behind Quanlet.
- Rewards are paid after the fix, in a currency agreed with the researcher. Sanctions and identity
  checks apply where the law requires them.

## Safe harbour

Research done in good faith under these rules is authorised. Quanlet will not take legal action against it
and will help if a third party does. If in doubt, ask first through the reporting channel.

## Before launch (checklist for the project owner)

- [ ] Choose the reporting address or platform and fill it in `SECURITY.md`.
- [ ] Decide the reward amounts and put the reserve aside.
- [ ] Decide who triages reports and how fast (proposal: acknowledge in 2 working days, assess in 7).
- [ ] Publish this page and `SECURITY.md` on the website.
