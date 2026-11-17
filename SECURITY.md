# Security policy

Quanlet is testnet software and must not hold real funds until the mainnet release.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

- Contact: **[reporting address to be set before launch]**
- Include what is affected, how to reproduce it (a Foundry test is ideal) and the impact you expect.
- We aim to acknowledge within 2 working days and give an assessment within 7.

Test only on Robinhood Chain testnet or a local fork, never against other people's vaults.

## Scope

The contracts in `contracts/src` (protocol 2.0 in `contracts/src/v2`), the ML-DSA-44 verifier and its helper, the
key backup format, and the signing path of the website's vault pages and the toolkit (`cli/`): anything that moves
funds without the required signatures, makes a client sign something other than what it shows, or leaks key
material. There is no paid reward programme.

## What is already known

Known issues and our own findings are listed in `docs/REVIEW-SCOPE.md` §7 and `docs/REVIEW-SCOPE-V2.md` §6. Conformance
with NIST's ML-DSA-44 test vectors is in `docs/ACVP.md`.
