# NIST ACVP conformance: ML-DSA-44 verifier

Result (6 November 2026): **all 60 ML-DSA-44 signature-verification vectors from NIST give the NIST result**
when run through Quanlet's on-chain verifier code. NIST marks 12 of them valid and 48 invalid; the verifier
accepts exactly the 12 and rejects the other 48.

This is evidence of conformance, not an audit. It shows the verifier computes FIPS 204 verification correctly
on NIST's cases. It does not show the code is free of every bug, and it does not replace the independent
cryptography review (Track A in `REVIEW-SCOPE.md`).

## The vectors

- Source: NIST's ACVP server repository, `gen-val/json-files/ML-DSA-sigVer-FIPS204/internalProjection.json`
  (vsId 42), SHA-256 `47cdd6314c7f746d02421ffcba89d4dbc7bb875ac49e07a029fdfc26fba55437`.
- The expected results were also checked against the same folder's `expectedResults.json`.
- `contracts/test/acvp/convert.py` keeps the ML-DSA-44 cases and writes `contracts/test/acvp/mldsa44-sigver.json`.

| Group | NIST tcIds | What it tests | Valid / total |
| --- | --- | --- | --- |
| 1 | 1 to 15 | External interface, pure ML-DSA, with context strings | 3 / 15 |
| 2 | 16 to 30 | External interface, HashML-DSA over 12 pre-hash functions (SHA-2, SHA-3, SHAKE) | 3 / 15 |
| 7 | 91 to 105 | Internal interface, mu supplied by the caller | 3 / 15 |
| 8 | 106 to 120 | Internal interface, M' supplied directly | 3 / 15 |

The invalid cases cover a modified message and modified signature parts: the commitment hash (c tilde),
the response z, and the hint.

## How the vectors reach the verifier

Quanlet's verifier supports one mode only: pure ML-DSA-44 with an empty context. It builds
M' = 0x00 || 0x00 || M itself. Only one NIST case (tcId 10) uses that mode, so it runs on the production
verifier unchanged.

The other 59 use a context string, a pre-hash, or the internal interface. For these:

1. `convert.py` builds the M' that FIPS 204 specifies (Algorithms 2 and 4), or takes NIST's mu as given.
2. `contracts/test/acvp/MLDSA44VerifierACVP.sol` is a test-only copy of the production verifier. It differs
   in one place: it hashes tr || M' (or uses mu) instead of building M' itself. Signature decoding, the hint
   and norm checks, the NTTs, the matrix product, UseHint and the final hash are the production code.
3. `test_HarnessMatchesProduction` checks that the copy and the production verifier agree, on valid and
   tampered signatures, at six message lengths including the 734-byte length that takes a separate hashing path.

Each NIST public key is prepared on chain by `KeyFactory.preparedBlobOf`, the same code registration uses,
so key preparation is exercised too. `test_AcvpKeysPrepareLikeReference` checks it matches `prepare.py` for
every NIST key.

## Reproducing

```
cd contracts
forge test --match-contract AcvpTest       # 7 tests
python3 -I test/acvp/convert.py <internalProjection.json> > test/acvp/mldsa44-sigver.json
```

The release manifest records the vector file hash, the harness hash and the result under `verifier.conformance`.

## What this does not cover

- The ACVP sigVer set for ML-DSA-44 has 60 cases. It is a conformance check, not an exhaustive one.
- No second, independent verifier implementation has been compared on random inputs (differential fuzzing).
- Malformed hint encodings and z values at the exact bound are covered by NIST only in part; Track A should
  look at them directly.
