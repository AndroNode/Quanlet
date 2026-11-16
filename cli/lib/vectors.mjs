// Deterministic signing vectors for every Quanlet v1 action (whitepaper Appendix C, last paragraph).
// Keys come from public seeds, so anyone can regenerate the keys; signatures use deterministic ML-DSA-44
// (FIPS 204 with rnd = 0), so any conforming implementation reproduces them byte for byte.
// These keys are public. Never use them for anything else.
import { keccak256, toBytes, bytesToHex } from 'viem';
import {
  ACTION, ZERO, manifest, actionDigest, withdrawalParamsHash, cancelParamsHash, invalidateParamsHash, recoveryParamsHash,
  recoverySetParamsHash, cancelChangeParamsHash, keyFromSeed, recordOf, popMessage, predictVault, setupDigest, sign, verify,
} from './protocol.mjs';

const seedOf = (name) => keccak256(toBytes(`QUANLET_PUBLIC_VECTOR_KEY_${name}_DO_NOT_USE`));
const NAMES = ['PRIMARY', 'RECOVERY_0', 'RECOVERY_1', 'RECOVERY_2', 'NEW_PRIMARY', 'NEW_RECOVERY_0', 'NEW_RECOVERY_1', 'NEW_RECOVERY_2'];

export function buildVectors(chainId) {
  const m = manifest(chainId);
  const keys = {};
  for (const n of NAMES) {
    const k = keyFromSeed(seedOf(n));
    const r = recordOf(k.publicKey);
    const pop = popMessage({ chainId, keyFactory: m.keyFactory, keyId: r.keyId, blobHash: r.blobHash });
    keys[n] = { k, r, pop, popSig: sign(k, pop, true) };
  }
  const K = (n) => keys[n];
  const T0 = 1_800_000_000;
  const W = { validAfter: T0, validUntil: T0 + 1800 }; // the longest window the contracts accept

  const salt = keccak256(toBytes('QUANLET_PUBLIC_VECTOR_SALT'));
  const rec = ['RECOVERY_0', 'RECOVERY_1', 'RECOVERY_2'];
  const setup = {
    chainId, vaultFactory: m.vaultFactory, keyFactory: m.keyFactory, salt,
    primaryRecord: K('PRIMARY').r.recordId, recoveryRecords: rec.map((n) => K(n).r.recordId), ...W,
  };
  setup.expectedVault = predictVault(setup);
  setup.digest = setupDigest(setup);
  setup.signature = sign(K('PRIMARY').k, setup.digest, true);
  const vault = setup.expectedVault;

  const actions = [];
  const act = (label, action, counters, paramsHash, params, signers) => {
    const digest = actionDigest({ chainId, vault, action: ACTION[action], ...counters, paramsHash, ...W });
    const sigs = Object.fromEntries(signers.map((n) => [n, sign(K(n).k, digest, true)]));
    for (const n of signers) if (!verify(K(n).k.publicKey, digest, sigs[n])) throw new Error(`vector ${label} did not verify`);
    actions.push({ label, action, actionId: ACTION[action], vault, chainId, ...counters, params, paramsHash, ...W, digest, signatures: sigs });
    return digest;
  };

  const w1 = { asset: ZERO, recipient: '0x000000000000000000000000000000000000bEEF', amount: '1000000000000000000', feeRecipient: ZERO, feeWei: '0' };
  const id1 = act('schedule 1 ETH, no relay fee', 'schedule', { executionEpoch: 0, authorityEpoch: 0, nonce: 0 }, withdrawalParamsHash(w1), w1, ['PRIMARY']);
  const w2 = { asset: '0x00000000000000000000000000000000000070c3', recipient: '0x000000000000000000000000000000000000bEEF', amount: '2500000', feeRecipient: '0x0000000000000000000000000000000000000FEE', feeWei: '1000000000000000' };
  act('schedule an ERC-20 transfer with a fixed relay fee', 'schedule', { executionEpoch: 0, authorityEpoch: 0, nonce: 1 }, withdrawalParamsHash(w2), w2, ['PRIMARY']);
  act('cancel the first withdrawal', 'cancel', { executionEpoch: 0, authorityEpoch: 0, nonce: 2 }, cancelParamsHash(id1), { id: id1 }, ['PRIMARY']);
  act('invalidate execution epoch 0', 'invalidate', { executionEpoch: 0, authorityEpoch: 0, nonce: 3 }, invalidateParamsHash(0), { expectedExecutionEpoch: 0 }, ['PRIMARY']);
  const np = K('NEW_PRIMARY').r;
  const pid = act('start primary recovery (recovery 0 and 2)', 'recovery', { executionEpoch: 1, authorityEpoch: 0, nonce: 0 }, recoveryParamsHash(np.keyId), { newPrimaryKeyId: np.keyId, newPrimaryRecord: np.recordId, signers: [0, 2] }, ['RECOVERY_0', 'RECOVERY_2']);
  act('guardian cancellation after the execution epoch moved at recovery start (recovery 1 and 2)', 'cancel-change', { executionEpoch: 2, authorityEpoch: 0, nonce: 1 }, cancelChangeParamsHash(pid), { proposalId: pid, signers: [1, 2] }, ['RECOVERY_1', 'RECOVERY_2']);
  const ns = ['NEW_RECOVERY_0', 'NEW_RECOVERY_1', 'NEW_RECOVERY_2'].map((n) => K(n).r);
  act('replace the recovery set (primary plus recovery 0 and 1, one digest)', 'replace-set', { executionEpoch: 3, authorityEpoch: 0, nonce: 2 }, recoverySetParamsHash(ns.map((r) => r.keyId)), { newKeyIds: ns.map((r) => r.keyId), newRecords: ns.map((r) => r.recordId), signers: [0, 1] }, ['PRIMARY', 'RECOVERY_0', 'RECOVERY_1']);

  return {
    format: 'quanlet-signing-vectors',
    version: 1,
    note: 'Public test keys. Signatures are deterministic ML-DSA-44 (pure, empty context, rnd = 0) over the 32-byte digest. A window of 1800 s is the longest accepted; 1801 s is refused (BadInterval).',
    chainId,
    keyFactory: m.keyFactory,
    vaultFactory: m.vaultFactory,
    keys: Object.fromEntries(
      NAMES.map((n) => [n, { seed: K(n).k.seed, publicKey: bytesToHex(K(n).k.publicKey), keyId: K(n).r.keyId, blobHash: K(n).r.blobHash, recordId: K(n).r.recordId, popMessage: K(n).pop, popSignature: K(n).popSig }]),
    ),
    setup,
    actions,
  };
}
