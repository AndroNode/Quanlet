// Quanlet v1 encodings (whitepaper Appendix C), computed locally so an offline signer never has to trust
// a digest it was handed. Every function here matches a view function of the deployed contracts; the
// contracts' own tests compare them (contracts/test/Cli.t.sol).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, keccak256, toBytes, bytesToHex, hexToBytes, getContractAddress, concat, isAddress, getAddress } from 'viem';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { prepareBlob } from './prepare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', f), 'utf8'));

export const ABI = {
  KeyFactory: load('abi/KeyFactory.json').abi,
  VaultFactory: load('abi/VaultFactory.json').abi,
  PersonalVault: load('abi/PersonalVault.json').abi,
  Verifier: load('abi/MLDSA44Verifier.json').abi,
};
export const VAULT_CREATION_CODE = load('abi/PersonalVault.json').bytecode;

export const MANIFESTS = Object.fromEntries(
  readdirSync(join(here, '..', 'deployments'))
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => [Number(f.slice(0, -5)), load(`deployments/${f}`)]),
);
export const DEFAULT_CHAIN = 46630;
export const RPC = { 46630: 'https://rpc.testnet.chain.robinhood.com', 4663: 'https://rpc.mainnet.chain.robinhood.com' };

export function manifest(chainId = DEFAULT_CHAIN) {
  // QUANLET_MANIFEST points at another manifest file, for a local chain or a newer release.
  if (process.env.QUANLET_MANIFEST) {
    const m = JSON.parse(readFileSync(process.env.QUANLET_MANIFEST, 'utf8'));
    if (m.chainId !== chainId) throw new Error(`QUANLET_MANIFEST is for chain ${m.chainId}, not ${chainId}.`);
    return m;
  }
  const m = MANIFESTS[chainId];
  if (!m) throw new Error(`No deployment manifest for chain ${chainId}.`);
  return m;
}

export const DOMAIN_TAG = keccak256(toBytes('QUANLET_ACTION_V1'));
export const SETUP_TAG = keccak256(toBytes('QUANLET_SETUP_V1'));
export const POP_TAG = keccak256(toBytes('QUANLET_KEY_POP_V1'));
export const PROTOCOL_VERSION = 1;
export const ACTION = { schedule: 1, cancel: 2, invalidate: 3, recovery: 4, 'replace-set': 5, 'cancel-change': 6 };
export const ACTION_NAME = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k]));
export const ACCEPTANCE_MAX = 1800;
export const ZERO = '0x0000000000000000000000000000000000000000';

const enc = (types, values) => keccak256(encodeAbiParameters(types.map((type) => ({ type })), values));

export function actionDigest({ chainId, vault, action, executionEpoch, authorityEpoch, nonce, paramsHash, validAfter, validUntil }) {
  return enc(
    ['bytes32', 'uint32', 'uint256', 'address', 'uint8', 'uint64', 'uint64', 'uint256', 'bytes32', 'uint64', 'uint64'],
    [DOMAIN_TAG, PROTOCOL_VERSION, BigInt(chainId), vault, action, BigInt(executionEpoch), BigInt(authorityEpoch), BigInt(nonce), paramsHash, BigInt(validAfter), BigInt(validUntil)],
  );
}

export const withdrawalParamsHash = ({ asset, recipient, amount, feeRecipient, feeWei }) =>
  enc(['address', 'address', 'uint256', 'address', 'uint256'], [asset, recipient, BigInt(amount), feeRecipient, BigInt(feeWei)]);
export const cancelParamsHash = (id) => enc(['bytes32'], [id]);
export const invalidateParamsHash = (epoch) => enc(['uint64'], [BigInt(epoch)]);
export const recoveryParamsHash = (newPrimaryKeyId) => enc(['uint8', 'bytes32'], [1, newPrimaryKeyId]);
export const recoverySetParamsHash = (keyIds) => enc(['uint8', 'bytes32[3]'], [2, keyIds]);
export const cancelChangeParamsHash = (proposalId) => enc(['bytes32'], [proposalId]);

/** paramsHash of a request, recomputed from its human-readable fields. */
export function paramsHashOf(req) {
  const p = req.params;
  switch (req.action) {
    case 'schedule':
      return withdrawalParamsHash(p);
    case 'cancel':
      return cancelParamsHash(p.id);
    case 'invalidate':
      return invalidateParamsHash(req.counters.executionEpoch);
    case 'recovery':
      return recoveryParamsHash(p.newPrimary.keyId);
    case 'replace-set':
      return recoverySetParamsHash(p.newRecovery.map((k) => k.keyId));
    case 'cancel-change':
      return cancelChangeParamsHash(p.proposalId);
    default:
      throw new Error(`Unknown action "${req.action}".`);
  }
}

// ------------------------------------------------------------------ keys and records

export const keyIdOf = (pk) => enc(['uint8', 'bytes'], [1, bytesToHex(pk)]);
export const recordIdOf = (keyId, blobHash) => enc(['bytes32', 'bytes32'], [keyId, blobHash]);
export const popMessage = ({ chainId, keyFactory, keyId, blobHash }) =>
  enc(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32'], [POP_TAG, BigInt(chainId), keyFactory, keyId, blobHash]);

export function keyFromSeed(seedHex) {
  const k = ml_dsa44.keygen(hexToBytes(seedHex));
  return { seed: seedHex, publicKey: k.publicKey, secretKey: k.secretKey };
}

export function recordOf(publicKey) {
  const blob = prepareBlob(publicKey);
  const keyId = keyIdOf(publicKey);
  const blobHash = keccak256(blob);
  return { keyId, blobHash, recordId: recordIdOf(keyId, blobHash) };
}

/** Pure ML-DSA-44, empty context, over the 32 digest bytes (Appendix C). `deterministic` is for vectors only. */
export function sign(key, digest, deterministic = false) {
  return bytesToHex(ml_dsa44.sign(hexToBytes(digest), key.secretKey, deterministic ? { extraEntropy: false } : undefined));
}
export const verify = (publicKey, digest, sig) => ml_dsa44.verify(hexToBytes(sig), hexToBytes(digest), publicKey);

// ------------------------------------------------------------------ vault setup

export function predictVault({ vaultFactory, keyFactory, primaryRecord, recoveryRecords, salt }) {
  const args = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32[3]' }], [keyFactory, primaryRecord, recoveryRecords]);
  return getContractAddress({ opcode: 'CREATE2', from: vaultFactory, salt: hexToBytes(salt), bytecode: concat([VAULT_CREATION_CODE, args]) });
}

export function setupDigest({ chainId, vaultFactory, keyFactory, primaryRecord, recoveryRecords, salt, validAfter, validUntil, expectedVault }) {
  const configHash = enc(['bytes32', 'bytes32[3]'], [primaryRecord, recoveryRecords]);
  const vault = expectedVault ?? predictVault({ vaultFactory, keyFactory, primaryRecord, recoveryRecords, salt });
  return enc(
    ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'address', 'uint64', 'uint64'],
    [SETUP_TAG, BigInt(chainId), vaultFactory, salt, configHash, vault, BigInt(validAfter), BigInt(validUntil)],
  );
}

export const addr = (v, what) => {
  if (!isAddress(v ?? '', { strict: false })) throw new Error(`${what} must be an address, got "${v}".`);
  return getAddress(v);
};
export const b32 = (v, what) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v ?? '')) throw new Error(`${what} must be 32 bytes of hex (0x + 64 digits), got "${v}".`);
  return v.toLowerCase();
};
