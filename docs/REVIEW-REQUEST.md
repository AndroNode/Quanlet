# Independent review: request and shortlist

Status: **draft, not sent.** No firm has been contacted. The project owner decides which firms to approach and sends the
request herself (or approves it being sent).

The whitepaper (§14) requires, before mainnet, at least one independent cryptography review and one
independent smart-contract review, with every critical and high finding fixed and rechecked. The scope for
both is in `REVIEW-SCOPE.md`.

## Recommendation

- Use **two different firms**, one per track. Two separate teams find more than one team doing both, and the
  cryptography track needs lattice and FIPS 204 experience that most smart-contract shops do not have.
- Ask **three firms per track** for a quote, then choose on experience with the specific area, availability and
  price.
- Run Track A (cryptography) first or in parallel. QR-09, the unaudited verifier, is the largest risk, and a
  finding there could change the contracts.
- Freeze a commit for the review and record it in the release manifest. Fixes go on a branch the reviewer rechecks.

## Shortlist

This list is from general reputation in public audit work. Before contacting anyone, check each firm's current
services, availability and published reports on its own website. Inclusion here is not an endorsement.

### Track A: cryptography (ML-DSA-44 verifier, key preparation, signing format, key backups)

| Firm | Why it fits |
| --- | --- |
| NCC Group, Cryptography Services | Long record of reviewing cryptographic implementations, including post-quantum work |
| Trail of Bits, Cryptography team | Cryptography and EVM experience in one firm; publishes its reports |
| Quarkslab | Cryptographic implementation reviews; publishes reports |
| Kudelski Security | Cryptography reviews for blockchain projects |
| zkSecurity | Reviews of advanced cryptography deployed on chain |

### Track B: smart contracts (PersonalVault, KeyFactory, VaultFactory, deployment)

| Firm | Why it fits |
| --- | --- |
| OpenZeppelin | Large public audit record for vaults and account contracts |
| ChainSecurity | Solidity reviews with formal methods |
| Spearbit (Cantina) | Panel of independent senior reviewers |
| Zellic | EVM reviews, including low-level and assembly-heavy code |
| Consensys Diligence | Long-standing Ethereum audit team |

## Rough size and budget (planning estimate only)

Quotes will differ. These figures are a guess for budgeting, not a price from any firm.

| Track | Code | Likely effort |
| --- | --- | --- |
| A, cryptography | about 3,200 lines of verifier (much of it assembly), 169 lines of key preparation, signing and backup code in two clients | 2 to 4 reviewer-weeks |
| B, smart contracts | about 760 lines of Solidity plus deployment scripts | 1 to 2 reviewer-weeks |

At typical market rates for senior reviewers this suggests a combined budget somewhere between about
US$40,000 and US$150,000, plus a fix review.

## Request letter (draft)

> **Subject:** Review request: Quanlet, post-quantum ML-DSA-44 vault on an EVM chain
>
> Hello,
>
> Quanlet is a self-custody vault whose withdrawals and recovery are authorised by ML-DSA-44 (FIPS 204)
> signatures, verified on chain in pure EVM. It runs on Robinhood Chain testnet today and holds no real
> funds. Before any beta with real assets we want an independent **[cryptography | smart-contract]** review.
>
> **Scope.** [Track A: the vendored ML-DSA-44 verifier (Fireblocks Labs, MIT, unaudited upstream, about
> 3,200 lines), on-chain key preparation (169 lines), the degenerate-key filter, the signed-message format and
> the key-backup format.] [Track B: PersonalVault, KeyFactory and VaultFactory (about 760 lines of Solidity) and
> the deployment scripts.] The full scope, threat model, invariants, test evidence, known gaps and our own
> self-review findings are in the attached `REVIEW-SCOPE.md`. File hashes and the commit are in the release
> manifest.
>
> **What exists already.** 47 Foundry tests including an invariant campaign; all 60 NIST ACVP ML-DSA-44
> signature-verification vectors give the NIST result; live testnet code matches the build byte for byte.
> There is no owner, proxy, pause or upgrade path.
>
> **What we ask.** Please tell us whether you can take this on, your earliest start date, the effort you
> estimate, your price, and whether a fix review is included. We would like the final report to be public.
>
> Thank you,
> [Name], Quanlet
> [contact address]

## After choosing a firm

1. Freeze the commit; regenerate the release manifest at that commit.
2. Give the reviewer the repository, `REVIEW-SCOPE.md`, `ACVP.md` and the manifest.
3. Track findings in a private list; fix critical and high first; ask the reviewer to recheck.
4. Publish the report and a public list explaining any open finding (§14). Add the report to
   `reviews.reports` in the manifest.
