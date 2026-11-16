# Quanlet protocol 2.0: independent review package

Status: **no independent review has been done.** This package is what Quanlet hands to outside reviewers of
protocol 2.0 (whitepaper v2.0). Section 6 is an internal self-review by the development team; it is not
independent and does not count toward the review gate.

Before mainnet, the whitepaper requires at least one independent cryptography review and one independent
smart-contract review, every critical and high finding fixed and rechecked by the reviewer, a public list of any
finding left open, and a funded vulnerability programme before any beta that accepts real assets.

## 1. What to review

Review the commit named in `contracts/deployments/46630.v2.release.json` (`sourceCommit`). That manifest lists
SHA-256 hashes of every in-scope file, the compiler settings, and the live code hash of every deployed contract.

Compiler: solc 0.8.30, via-IR, EVM `cancun`, optimizer 10,000 runs, no metadata hash. One profile for every
contract: a clean `forge build` reproduces the deployed vault creation code exactly
(`keccak = 0xea0432ad261fc8ad7e2a32c2223513cc7bfcd407c16e21f01b1cb25716d2a59f`).

### Track A: smart contracts (protocol 2.0)

| Contract | Path | Lines | Role |
| --- | --- | --- | --- |
| PersonalVaultV2 | `contracts/src/v2/PersonalVaultV2.sol` | 868 | The vault: five roles, FAST and PROTECTED transfers, queue, safety actions, policy, rotation, recovery, guardian replacement |
| VaultFactoryV2 | `contracts/src/v2/VaultFactoryV2.sol` | 173 | Five-consent setup, CREATE2 from pinned code stores, dependency manifest |
| KeyFactoryV2 | `contracts/src/v2/KeyFactoryV2.sol` | 143 | Key registration (on-chain preparation) and activation by proof of possession |
| QuanletV2 | `contracts/src/v2/QuanletV2.sol` | 80 | Domains, action ids, lanes, roles, parameters, Policy and AssetRule types |

### Track B: cryptography (shared with protocol 1.0, unchanged)

| Component | Path | Question |
| --- | --- | --- |
| ML-DSA-44 verifier (vendored, Fireblocks Labs, MIT, unaudited upstream) | `contracts/src/verifier/*` | Correct FIPS 204 verification for ML-DSA-44, pure, empty context; rejects every malformed signature |
| Keccak-f[1600] helper | `contracts/helpers/f1600_170.hex` | Correct permutation; bound by code hash `0x4afb…817b` |
| On-chain key preparation | `contracts/src/KeyPrep.sol` | tr, NTT(t1·2^13), ExpandA match FIPS 204 |
| Degenerate-key filter | `KeyFactoryV2._isDegenerate` | Sound guard for the verifier's precondition |
| Message framing | `actionDigest`, `consentDigest`, `setupDigest`, `registrationDigest`; `apps/web/src/testnet/v2/chain.ts`, `cli/lib/protocol2.mjs` (checked against the contracts by `contracts/test/v2/CliV2.t.sol`) | Client and contract sign exactly the same 32 bytes; domains separate chain, contract, action, lane and epochs |
| Key backups (version 2) | `apps/web/src/testnet/v2/keyfile.ts`, `cli/lib/keyfile2.mjs` (each opens the other's files: `cli/test/webcompat.mjs`) | Argon2id parameters, XChaCha20-Poly1305 use, header authentication |
| Offline signer (2.0) | `cli/lib/v2.mjs` | The signer recomputes every digest from the request's readable fields, refuses requests that name another deployment, and signs only the slots its key holds |

**Out of scope:** the marketing website, the Cloudflare Worker API, Robinhood Chain
itself, bridges, and the ERC-20 issuers of supported tokens.

## 2. System summary

- **Roles.** P (primary) signs every transfer. A (approver) co-signs protected transfers and administration. G1–G3
  (guardians) exist only for recovery and guardian replacement. All five key ids are distinct.
- **Routes.** FAST: P alone, within a finite per-asset allowance (lifetime ceiling, per-action cap, validity window
  of at most 30 days, recipient list; optional relayer fee bounded by a maximum and a fee-recipient list, counted
  against the ETH allowance). PROTECTED: P and A; executes at once or after the elected delay (1 h, 24 h, 72 h),
  then within 7 days; anyone may execute.
- **Counters.** Lifetime FAST debit `spent[asset]` never resets. Five nonce lanes (spend, admin, P-safety,
  A-safety, recovery). Three epochs (authority, policy, execution); every change advances the execution epoch,
  which invalidates all pending approvals and queue entries.
- **Safety.** P or A alone can cancel a queued transfer, invalidate all pending spending, or suspend FAST.
- **Administration.** P and A replace the policy or rotate one or both spending keys (each new key consents);
  with a delay, the change waits that delay and freezes outflows meanwhile; P and A can cancel it.
- **Recovery.** Two guardians propose a new P and A (both consent); outflows freeze and FAST is suspended at once;
  7-day delay, 7-day window; two guardians can cancel; it supersedes any pending administrative or guardian change.
  After recovery FAST stays off until the new pair grants a new allowance.
- **Guardian replacement.** P, A and two guardians; the three new guardians consent; 7 days.
- **Setup.** All five keys sign one setup digest that commits the role ids, the policy, the dependency manifest
  (verifier, key factory, helper, creation code, supported assets) and the predicted address.
- No owner, admin, proxy, pause or arbitrary call anywhere.

## 3. Properties we ask reviewers to try to break

1. No outflow without P's signature over that exact transfer; PROTECTED also needs A.
2. FAST never moves more than the jointly granted allowance per asset, lifetime, including fees.
3. No outflow while any security proposal is pending.
4. A signature is usable once, on one chain, one vault, one action, one lane, one epoch tuple and inside its window.
5. Recovery cannot move funds and cannot be blocked by P or A.
6. Every queued transfer from an earlier epoch can never execute.
7. A copied setup transaction can only deploy the identical vault.
8. Tokens with transfer tax, rebasing or hooks cannot make the vault debit more than it pays.

## 4. Evidence

| Evidence | Where |
| --- | --- |
| 104 Foundry tests (1.0 and 2.0), including a stateful invariant run with real ML-DSA-44 signatures | `contracts/test/v2/*.t.sol` |
| Client-facing views pinned to the checked encodings | `contracts/test/v2/ViewsV2.t.sol` |
| Live smoke test on testnet: FAST and PROTECTED sent, over-allowance FAST and P-only PROTECTED refused | `contracts/deployments/46630.v2.gate-b.json` |
| 64 end-to-end checks of the website flow against a fork of chain 46630 (tokens, fees, relayed transfer, freeze and prune, rotation, guardian replacement, recovery) | development harness |
| The toolkit's 2.0 encoders compared with the contracts' views (digests, consent, policy hash, vault address, setup digest, pending-policy recovery) | `contracts/test/v2/CliV2.t.sol` |
| End-to-end toolkit run against a fork: 7 keys registered, five-key setup, FAST, protected with delay, cancel, delayed policy finalized from calldata, FAST suspended, guardian recovery, relayed transfer | `cli/test/e2e2.mjs` |
| Byte-exact signing vectors for every 2.0 action (keys, registration, setup, consents), each verified by the on-chain verifier | `cli/vectors/46630.v2.json`, `CliV2Test.test_SigningVectorsVerifyOnChain` |
| Live exit and backup-restoration drill on testnet with the toolkit only: keys restored from backups on a second machine, five-key setup, FAST, full exit by a protected transfer; vault `0xb417F32f809db281358aC403148053A2f91483f5` | `contracts/deployments/46630.v2.exit-drill.json`, `cli/scripts/drill2.mjs` |
| Gas per operation | `contracts/deployments/gas-foundry-v2.json` |
| Source verified on the testnet explorer | KeyFactoryV2, both VaultFactoryV2, MLDSA44Verifier, the smoke vault |

## 5. Static analysis (Slither 0.11.6, 81 detectors, 2.0 contracts)

| Detector | Count | Triage |
| --- | --- | --- |
| arbitrary-send-eth | 1 | By design: recipient and amount are signed by P (FAST, within allowance) or P and A |
| encode-packed-collision | 1 | False positive: init code = pinned creation code ++ abi.encode(args) |
| uninitialized-local | 2 | False positive: zero-initialised counter and an intentionally empty recovery policy |
| shadowing-local | 3 | Cosmetic (constructor parameters named like views) |
| calls-loop | 10 | Calls to the immutable verifier and key factory in fixed loops of 2–5 |
| timestamp | 11 | By design: timelocks and validity windows use chain time |

Line coverage could not be measured: `forge coverage` (optimizer off) hits "stack too deep" in the via-IR build.
Every state-changing external function is exercised by the tests.

## 6. Internal self-review (not independent)

| Id | Severity | Finding | Status |
| --- | --- | --- | --- |
| I-1 | Informational | Builds could pick either of two vault artifacts (a size-only compiler profile), so the bytecode depended on build order | Fixed: one profile; build reproduces the deployed code |
| I-2 | Low | Expired queue entries in the current epoch count toward the 32-entry limit until pruned | Accepted (anyone may prune); the website now offers Remove |
| I-3 | Informational | A delayed policy is stored only as its hash; finalizing needs the policy, which lives in the client that started it (and in that transaction's calldata) | Fixed in the clients: the website and `quanlet v2 pending` find the policy in the proposing transaction (the block at `executableAt - protectedDelay`) and accept it only if its hash equals the stored one |
| I-4 | Informational | Token support assumes plain ERC-20 behaviour; exact debit and credit checks make deviant tokens fail closed | Accepted; supported assets are fixed per factory |

## 7. Known limitations

- No hosted relayer; any wallet can submit a signed transfer.
- Mainnet supported assets are not decided.
