# Quanlet v1: security notes

Scope, threat model, invariant evidence and known gaps for protocol 1.x, with the development team's internal
self-review in section 7. Anyone examining the code can start here.

## 1. Scope

The exact files and their SHA-256 hashes are listed in the release manifest,
`contracts/deployments/46630.release.json` (`source.files`, `verifier.files`, `toolkit.files`). Review the commit
that manifest names.

### Track A: cryptography review

| Component | Path | Lines | Question for the reviewer |
| --- | --- | --- | --- |
| ML-DSA-44 verifier (vendored, Fireblocks Labs, MIT, unaudited upstream) | `contracts/src/verifier/*` | about 3,200 | Is it a correct FIPS 204 Algorithm 3 for ML-DSA-44, pure (non-prehashed) with an empty context? Does it reject every malformed signature (hint encoding, z bound, c tilde)? |
| Keccak-f[1600] helper | `contracts/helpers/f1600_170.hex`, raw entry used by `KeyPrep` | bytecode | Is the permutation correct for every input state? It is bound by code hash `0x4afb4435…817b`. |
| On-chain key preparation | `contracts/src/KeyPrep.sol` | 169 | Does it match FIPS 204 for tr = SHAKE256(pk, 64), NTT(t1·2^13) and ExpandA by RejNTTPoly, with canonical coefficients < q? |
| Degenerate-key filter | `KeyFactory._isDegenerate` | 20 | Is the floor (at least 512 of the 1,024 t1 coefficients with a lift above γ2) a sound guard for the verifier's precondition in its docs/SAFETY.md §3.1? |
| Message framing | `PersonalVault.actionDigest`, `VaultFactory.setupDigest`, `KeyFactory.popMessage`, `cli/lib/protocol.mjs` | — | Do the client and the contract sign exactly the same 32 bytes (Appendix C)? Are the domains separated across chain, contract, action and epoch? |
| Key backups | `cli/lib/keyfile.mjs`, `apps/web/src/testnet/keyfile.ts` | 272 | Argon2id parameters, XChaCha20-Poly1305 use, header authentication, nonce generation. |
| Reference preparation | `contracts/script/prepare.py`, `cli/lib/prepare.mjs`, `apps/web/src/testnet/prepare.ts` | 457 | Off-chain twins used by tests and clients. |

### Track B: smart-contract review

| Contract | Path | Lines |
| --- | --- | --- |
| PersonalVault | `contracts/src/PersonalVault.sol` | 473 |
| KeyFactory | `contracts/src/KeyFactory.sol` | 161 |
| VaultFactory | `contracts/src/VaultFactory.sol` | 90 |
| Constants | `contracts/src/QuanletConstants.sol` | 37 |

Deployment scripts (`contracts/script/*.s.sol`) and the manifest generator (`cli/scripts/manifest.mjs`) are in
scope for deployment integrity only.

**Out of scope:** the marketing website, the Cloudflare Worker API, the simulated demo pages,
Robinhood Chain itself, bridges, and ERC-20 issuers.

## 2. System summary

- **KeyFactory** takes a raw 1,312-byte ML-DSA-44 public key and a proof-of-possession signature. It
  computes the 20,545-byte verifier blob on chain and deploys it with CREATE2 (salt = keyId). It checks the proof
  through that blob, then stores `recordId = keccak(keyId, blobHash)`. Each key can be registered only once.
- **VaultFactory** deploys a **PersonalVault** with CREATE2 from one primary record and three recovery records. The
  primary must sign a setup digest that commits the configuration and the predicted address.
- **PersonalVault** has no owner, no proxy and no pause. Its rules:
  - Every outflow is a withdrawal signed by the primary. It matures after 24 hours, can be executed for 7 days, and
    anyone may execute it.
  - The primary can cancel a withdrawal, or invalidate every pending one by advancing the epoch.
  - Two of the three recovery keys can propose a new primary.
  - The primary plus two recovery keys can propose a new recovery set.
  - A proposal freezes all outflows. It can be finalized from day 7 and expired from day 14, and two recovery keys
    can cancel it.
- **Immutable bindings:**
  - The vault stores the verifier address and its code hash, and checks the hash on every verification.
  - KeyFactory binds the Keccak helper by code hash.
  - Each key blob is bound by its code hash.

### Trust assumptions

- Robinhood Chain (Arbitrum Nitro) executes EVM Cancun semantics correctly and keeps `block.timestamp` honest
  within normal sequencer bounds.
- Two recovery keys acting together are trusted with delayed ultimate control (§9). They can also freeze the vault
  over and over.
- Client devices that generate keys and sign are not compromised.

## 3. Threat model

| Attacker | Capability | Must not be able to |
| --- | --- | --- |
| Any EOA or contract (gas payer, relayer, MEV searcher) | Submit, reorder or copy any transaction; front-run | Move funds, shorten delays, change fees or recipients, gain authority, replay a request |
| Withdrawal recipient or fee recipient | Run code when paid; revert | Get paid more, skip the fee, consume another entry, leave a partial transfer |
| Holder of a stolen primary | Sign any primary action | Shorten the 24-hour delay, block a recovery quorum, act while a security change is pending |
| One stolen recovery key | Sign recovery actions | Reach a quorum alone, count twice |
| Two colluding recovery keys | Quorum | Act before the 7-day delay, or move assets (recovery only installs authority) |
| Malicious key registrant | Submit any 1,312-byte value | Register a key they cannot sign for, register a blob that differs from the canonical preparation, or register a degenerate key that the verifier mishandles |
| Quantum adversary | Breaks ECDSA | Gain any spending power: no ECDSA signature or `msg.sender` grants authority |

## 4. Appendix B invariants and where they are tested

All of the tests below live in `contracts/test`.

| # | Invariant | Evidence |
| --- | --- | --- |
| 1 | No outflow from ECDSA or the sender alone | `test_NoAuthorityFromSenderOrForeignKey`; fuzz `scheduleForged` and the random `caller` in `execute` |
| 2 | Every outflow is an exact mature withdrawal, fee included | `test_SignatureBindsExactParams`, `test_DelayAndWindowBoundaries`, `test_RecipientCannotSkipRelayFee`; fuzz `execute`, which checks the vault, recipient and relayer amounts, including a recipient that re-enters while paid; the invariant balance == deposits − paid out |
| 3 | A pending security change blocks all outflows | `test_PrimaryFrozenWhilePending`; fuzz predicts a refusal while pending; invariant: no queued entry of the current epoch while pending |
| 4 | Old epochs never become valid again | `test_CancelAndInvalidate`; fuzz checks that the epochs never decrease |
| 5 | Nobody can change the verifier, helper binding or delays | No setter exists; the invariant checks the verifier address and hash; `test_RejectsWrongHelper` |
| 6 | Nonces only increase | `test_ReplayRejected`; fuzz `replay`; the counter check runs after every step |
| 7 | Thresholds count distinct active keys signing the identical proposal | `test_RecoveryLifecycle`, `test_QuorumCancelsAndPrimaryCannot`, `test_RecoverySetReplacement`; fuzz `startRecovery` and `cancelSecurity` with duplicate and non-member signers |
| 8 | Keys are accepted only after canonical preparation and proof of possession | `KeyFactoryTest`: 256 random keys plus fixed keys compared with `prepare.py`, a wrong proof, a proof over another blob, a duplicate, a degenerate key, bad lengths, a wrong helper |
| 9 | A failed transfer leaves nothing half done | `test_InsufficientBalanceRevertsAtomically`, `test_FeeFailureRevertsTransfer`, `test_ReentrancyCannotDoubleSpend` |
| 10 | Core rights do not depend on a token or a hosted service | No token exists. The CLI e2e test (`cli/test/e2e.mjs`) runs setup, withdrawal and recovery against a bare node |

**Fuzz campaign** (`Invariant.t.sol`): 15 handler actions, 8 runs of depth 40, real ML-DSA-44 signatures through FFI.

- Every call predicts accept or refuse from the whitepaper rules alone, and any disagreement in either direction
  is a violation.
- Mutation checks run during development:
  - allowing invalidation while pending: caught;
  - letting a stale epoch execute: caught;
  - reading the fee after the recipient can delete the entry: caught by the fixed walk `VaultHandlerReach`.
- Caveat for reviewers: the random campaign is short because every step signs for real. The fixed walks pin the
  rarer paths. A longer campaign (`FOUNDRY_PROFILE=ci`, more runs) is a reasonable reviewer exercise.

## 5. §14 test areas: evidence and gaps

| Area | Evidence now | Gap |
| --- | --- | --- |
| Cryptographic conformance | All 60 NIST ACVP ML-DSA-44 sigVer vectors give the NIST result (`Acvp.t.sol`, see `docs/ACVP.md`); valid and invalid signatures through the on-chain verifier; the CLI cross-check (`Cli.t.sol`) proves that signatures from `@noble/post-quantum` verify on chain | 59 of the 60 NIST cases run through a test-only copy of the verifier, because the production verifier accepts only an empty context. No second independent verifier implementation is compared (differential fuzzing) |
| Key preparation | On-chain against `prepare.py` on 256 random keys; malformed keys refused; the blob is bound by code hash | A staged variant is not needed (12.35M gas in one transaction) |
| Request authorization | Cross-vault, cross-action, cross-epoch and replay rejection; acceptance-window boundaries | Cross-chain is covered by `block.chainid` in the digest; there is no separate fork test |
| Queue correctness | Delays, window edges, exact amounts, cancel, expiry, the cap of 32 | — |
| Recovery correctness | Every transition, distinct signers, stale proposals, set replacement, ordering in the fuzz | — |
| External interactions | Re-entrancy (ETH), reverting recipients, fee failure, ERC-20 that returns nothing, returns false, reverts or has lost its code (`test_Erc20ReturnVariants`) | Callback tokens (ERC-777 style) are only argued, not tested; no ERC-20 is supported in this release |
| Deployment integrity | Atomic CREATE2 setup, helper hash check, live code compared with the local build (immutables masked) by `manifest.mjs --rpc` | An independent reproduction of the verifier and helper builds is still needed |
| Operational independence | CLI: offline signing, `--dry-run`, any RPC, key files that work without the website | Reorg and downtime drills (§15 phase 2) have not been run |

## 6. Measured costs (Foundry, Cancun, via-IR, 10,000 optimizer runs)

Taken from `contracts/deployments/gas-foundry.json` (`GasReport.t.sol`). "Tx gas" is execution gas plus 21,000
plus calldata cost, an L1-style estimate. Live Robinhood Chain receipts, including the L1 data component and the
fee actually paid, are recorded in the release manifest (`costs.live`).

| Operation | Execution gas | Calldata (bytes) | Tx gas (est.) |
| --- | ---: | ---: | ---: |
| registerKey (prepare, publish blob, check proof) | 12,273,901 | 3,876 | 12,354,901 |
| createVault | 4,037,267 | 2,724 | 4,100,003 |
| scheduleWithdrawal | 1,344,395 | 2,756 | 1,405,435 |
| scheduleWithdrawal with a wrong key (refused) | 1,222,285 | 2,756 | 1,283,181 |
| cancelWithdrawal | 1,226,408 | 2,628 | 1,287,248 |
| invalidatePendingRequests | 1,244,881 | 2,596 | 1,305,209 |
| executeWithdrawal (ETH) | 39,218 | 36 | 60,782 |
| startRecovery (2 signatures) | 2,544,509 | 5,220 | 2,644,433 |
| cancelSecurityChange (2 signatures) | 2,447,389 | 5,188 | 2,546,789 |
| startRecoverySetReplacement (3 signatures) | 3,779,109 | 7,876 | 3,919,057 |
| finalizeSecurityChange | 9,574 to 15,465 | 4 | about 31,000 to 37,000 |

## 7. Internal self-review (not independent)

The development team reviewed the four contracts and the client signing path against the threat model above.
Severity uses the usual scale: critical, high, medium, low, info.

| Id | Severity | Finding | Status |
| --- | --- | --- | --- |
| QR-01 | Medium | **A recipient could skip the relay fee.** `executeWithdrawal` read the fee from storage after paying the recipient. A recipient contract could re-enter `pruneWithdrawal` (which was not lock-protected) to delete its own executed entry, so the fee read as zero and the relayer went unpaid, though the relayer had been promised payment on success. The vault never paid out more than was signed. | **Fixed.** The fields are copied to memory before any transfer, and `pruneWithdrawal` is now `nonReentrant`. Regression tests: `test_RecipientCannotSkipRelayFee` and a re-entering recipient in the fuzz handler. The fix needs a new VaultFactory; vaults made earlier on testnet keep the old behaviour. |
| QR-02 | Low | `_sendToken` treated a call to an address with no code as success. Scheduling already refuses assets without code, and Cancun's SELFDESTRUCT cannot remove code later, so this could not be reached. | **Fixed** as defence in depth: execution now refuses an asset without code. |
| QR-03 | Info | The degenerate-key filter is a heuristic floor, not a proof that the verifier is safe for every accepted key. | Open. |
| QR-04 | Info | Deposits are accepted while a security change is pending (needed so funds are never stuck). A user could fund a vault that is under an unexpected recovery. | By design; the interfaces warn the user. |
| QR-05 | Info | A fee recipient that reverts blocks that withdrawal until it expires; the owner must cancel and reschedule without a fee. This is the specified atomic fee behaviour. | By design; documented. |
| QR-06 | Info | Anyone can submit a request with an invalid signature. Verification costs the submitter about 1.22M gas, and the vault's state is not changed. | Accepted: the attacker pays. |
| QR-07 | Info | Anyone can copy a `createVault` transaction. The copy deploys the identical vault (the same records and salt), so the effect is the same. | Accepted. |
| QR-08 | Info | ERC-20 tokens with fees on transfer, rebasing or callbacks break "exact amount" reasoning. | No ERC-20 is supported in this release; each future token needs its own review. |
| QR-09 | High (risk acceptance) | The verifier is vendored, unaudited research code. Every vault's security rests on it. | Open: accepted risk; covered by the ACVP conformance suite. |

## 8. Reproducing

```
cd contracts
forge build
forge test                       # 47 tests, including the invariant campaign, the CLI cross-checks and NIST ACVP
forge test --match-contract GasReport   # rewrites deployments/gas-foundry.json
cd ../cli && node test/run.mjs   # offline toolkit tests
node cli/scripts/manifest.mjs --chain 46630 --rpc <RPC URL>   # rebuilds the release manifest and checks live code
```

Tests need `node` and `python3` for the FFI signer and the reference preparation.

## 9. Reporting

See `SECURITY.md` at the repository root. Please do not open public issues for vulnerabilities.
