// Deterministic signing vectors for protocol 2.0 (whitepaper v2.0, Gate 1: byte-exact cross-language vectors).
// Keys come from public seeds, so anyone can regenerate them; signatures use deterministic ML-DSA-44 (FIPS 204,
// pure, empty context, rnd = 0), so any conforming implementation reproduces them byte for byte.
// These keys are public. Never use them for anything else.
import { keccak256, toBytes, bytesToHex } from 'viem';
import { keyFromSeed, sign, verify } from './protocol.mjs';
import {
  ACTION, ZERO, manifest2, keyIdOf2, registrationDigest, consentDigest, policyFrom, policyJson, policyHash, predictVault2, setupDigest2,
  requestDigest, laneAndParams, slotsOf,
} from './protocol2.mjs';

const seedOf = (name) => keccak256(toBytes(`QUANLET_PUBLIC_VECTOR_KEY_V2_${name}_DO_NOT_USE`));
const NAMES = ['P', 'A', 'G1', 'G2', 'G3', 'NEW_P', 'NEW_A', 'NEW_G1', 'NEW_G2', 'NEW_G3'];
const BEEF = '0x000000000000000000000000000000000000bEEF';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const FEE = '0x0000000000000000000000000000000000000FEE';

export function buildVectors2(chainId) {
  const m = manifest2(chainId);
  const T0 = 1_800_000_000;
  const W = { validAfter: T0, validUntil: T0 + 1800 }; // the longest window the contracts accept
  const keys = {};
  for (const n of NAMES) {
    const k = keyFromSeed(seedOf(n));
    const keyId = keyIdOf2(k.publicKey);
    const reg = registrationDigest({ chainId, keyFactory: m.keyFactory, keyId, ...W });
    keys[n] = { k, keyId, reg, regSig: sign(k, reg, true) };
  }
  const K = (n) => keys[n];
  const id = (n) => K(n).keyId;
  const byKeyId = Object.fromEntries(NAMES.map((n) => [id(n).toLowerCase(), n]));

  // Setup: a Flexible vault (1-hour protected delay, a FAST allowance for ETH to one recipient, a relay fee cap).
  const policy = policyFrom({
    protectedDelay: 3600, fastEnabled: true, resumeFast: true, maxFastFeeWei: '1000000000000000', fastFeeRecipients: [FEE],
    assetRules: [{ asset: ZERO, ceiling: '1000000000000000000', perActionCap: '100000000000000000', budgetValidAfter: T0, budgetValidUntil: T0 + 30 * 86400, recipients: [BEEF] }],
  });
  const roleIds = ['P', 'A', 'G1', 'G2', 'G3'].map(id);
  const salt = keccak256(toBytes('QUANLET_PUBLIC_VECTOR_SALT_V2'));
  const base = { chainId, vaultFactory: m.vaultFactory, keyFactory: m.keyFactory, roleIds, policy, salt, supportedAssets: m.supportedAssets, dependencyManifestHash: m.dependencyManifestHash, vaultCreationCodeHash: m.vaultCreationCodeHash, ...W };
  const vault = predictVault2(base);
  const setupDigest = setupDigest2(base);
  const setup = {
    ...base, policy: policyJson(policy), policyHash: policyHash(policy), expectedVault: vault, digest: setupDigest,
    signatures: Object.fromEntries(['P', 'A', 'G1', 'G2', 'G3'].map((n) => [n, sign(K(n).k, setupDigest, true)])),
  };

  const roles = { p: id('P'), a: id('A'), g1: id('G1'), g2: id('G2'), g3: id('G3') };
  const actions = [];
  const act = (label, action, counters, params) => {
    const req = { action, chainId, vault, roles, params, ...W };
    const [lane, paramsHash] = laneAndParams({ ...req, counters });
    req.counters = { lane, ...counters };
    const digest = requestDigest(req);
    const signatures = {};
    const consents = {};
    for (const s of slotsOf(req)) {
      const n = byKeyId[s.keyId.toLowerCase()];
      if (s.over === 'consent') {
        const c = consentDigest(digest, s.roleId, s.keyId);
        consents[s.slot] = { key: n, roleId: s.roleId, digest: c, signature: sign(K(n).k, c, true) };
        if (!verify(K(n).k.publicKey, c, consents[s.slot].signature)) throw new Error(`vector ${label} consent did not verify`);
      } else {
        signatures[s.slot] = { key: n, signature: sign(K(n).k, digest, true) };
        if (!verify(K(n).k.publicKey, digest, signatures[s.slot].signature)) throw new Error(`vector ${label} did not verify`);
      }
    }
    actions.push({ label, action, actionId: ACTION[action], ...req, paramsHash, digest, signatures, consents });
    return digest;
  };

  const c = (nonce, authorityEpoch = 1, policyEpoch = 1, executionEpoch = 1) => ({ nonce: String(nonce), authorityEpoch: String(authorityEpoch), policyEpoch: String(policyEpoch), executionEpoch: String(executionEpoch) });
  const tx = (route, recipient, amount, feeRecipient = ZERO, feeWei = '0') => ({ route, asset: ZERO, recipient, amount, feeRecipient, feeWei });
  act('FAST: 0.05 ETH to an allowed recipient with a 0.0005 ETH relay fee (primary alone)', 'transfer', c(0), tx('fast', BEEF, '50000000000000000', FEE, '500000000000000'));
  const t2 = act('protected: 2 ETH to any address (primary and approver)', 'transfer', c(1), tx('protected', DEAD, '2000000000000000000'));
  act('approver cancels the protected transfer (approver safety lane)', 'cancel', c(0), { role: 'a', id: t2 });
  act('primary invalidates pending spending (primary safety lane)', 'invalidate', c(0), { role: 'p' });
  act('approver suspends FAST (execution epoch moved by the invalidation)', 'suspend-fast', c(1, 1, 1, 2), { role: 'a' });
  const guarded = policyFrom({ protectedDelay: 86400, fastEnabled: false, resumeFast: false, maxFastFeeWei: 0, fastFeeRecipients: [], assetRules: [] });
  const pp = act('new policy: FAST off, 24-hour delay (primary and approver)', 'update-policy', c(0, 1, 1, 3), { policy: policyJson(guarded) });
  act('cancel the pending policy change (primary and approver)', 'cancel-admin', c(1, 1, 1, 4), { proposalId: pp });
  act('rotate the primary only; the new key consents (primary and approver)', 'replace-spending', c(2, 1, 1, 5), { newP: id('NEW_P'), newA: id('A') });
  const rp = act('recovery to a new primary and approver (guardians 1 and 3; both new keys consent)', 'start-recovery', c(0, 1, 1, 6), { newP: id('NEW_P'), newA: id('NEW_A'), guardians: [0, 2] });
  act('guardians 1 and 2 cancel the recovery (recovery lane binds the authority epoch only)', 'cancel-recovery', c(1, 1, 1, 7), { proposalId: rp, guardians: [0, 1] });
  act('replace all three guardians (primary, approver, guardians 2 and 3; each new guardian consents)', 'replace-guardians', c(2, 1, 1, 8), { newG: ['NEW_G1', 'NEW_G2', 'NEW_G3'].map(id), guardians: [1, 2] });

  return {
    format: 'quanlet-signing-vectors',
    version: 2,
    protocol: '2.0',
    note: 'Public test keys. Signatures are deterministic ML-DSA-44 (pure, empty context, rnd = 0) over the 32-byte digest. Counters are example values; a digest binds the counters the vault reports. Recovery-lane digests set the policy and execution epochs to zero. A window of 1800 s is the longest accepted.',
    chainId,
    keyFactory: m.keyFactory,
    vaultFactory: m.vaultFactory,
    keys: Object.fromEntries(
      NAMES.map((n) => [n, { seed: K(n).k.seed, publicKey: bytesToHex(K(n).k.publicKey), keyId: K(n).keyId, registration: { ...W, digest: K(n).reg, signature: K(n).regSig } }]),
    ),
    setup,
    actions,
  };
}
