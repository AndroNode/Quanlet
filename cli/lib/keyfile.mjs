// Encrypted backup of one ML-DSA-44 key, byte-compatible with the website's backups
// (apps/web/src/testnet/keyfile.ts): Argon2id v1.3 (64 MiB, 3 passes, 1 lane) then XChaCha20-Poly1305,
// with the whole header authenticated as associated data. Body = seed (32) || public key (1312).
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from 'node:crypto';
import { bytesToHex, hexToBytes } from 'viem';
import { keyFromSeed, recordOf } from './protocol.mjs';

export const FORMAT = 'quanlet-mldsa44-key';
export const MIN_PASSWORD = 12;
const KDF = { memKiB: 65536, passes: 3, lanes: 1 };
const BOUNDS = { memKiB: [19456, 262144], passes: [1, 10], lanes: [1, 4] };
const SEED = 32;
const PK = 1312;

function aad(h) {
  const fixed = {
    format: h.format,
    version: h.version,
    alg: h.alg,
    label: h.label,
    keyId: h.keyId.toLowerCase(),
    recordId: h.recordId.toLowerCase(),
    chainId: h.chainId,
    vaultFactory: h.vaultFactory.toLowerCase(),
    kdf: { alg: h.kdf.alg, v: h.kdf.v, memKiB: h.kdf.memKiB, passes: h.kdf.passes, lanes: h.kdf.lanes, salt: h.kdf.salt.toLowerCase() },
    aead: { alg: h.aead.alg, nonce: h.aead.nonce.toLowerCase() },
  };
  return new TextEncoder().encode(JSON.stringify(fixed));
}

const derive = (password, salt, k) =>
  argon2idAsync(password.normalize('NFC'), salt, { t: k.passes, m: k.memKiB, p: k.lanes, dkLen: 32, version: 0x13 });

export async function encryptKey({ seed, label, password, chainId, vaultFactory }) {
  if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const k = keyFromSeed(seed);
  const rec = recordOf(k.publicKey);
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const header = {
    format: FORMAT,
    version: 1,
    alg: 'ML-DSA-44',
    label: label.slice(0, 40),
    keyId: rec.keyId,
    recordId: rec.recordId,
    chainId,
    vaultFactory,
    kdf: { alg: 'argon2id', v: 19, ...KDF, salt: bytesToHex(salt) },
    aead: { alg: 'xchacha20poly1305', nonce: bytesToHex(nonce) },
  };
  const key = await derive(password, salt, KDF);
  const body = new Uint8Array(SEED + PK);
  body.set(hexToBytes(seed), 0);
  body.set(k.publicKey, SEED);
  const ct = xchacha20poly1305(key, nonce, aad(header)).encrypt(body);
  key.fill(0);
  body.fill(0);
  return { ...header, ciphertext: bytesToHex(ct) };
}

const isHex = (v, n) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(v);
const within = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

/** Checks the header before any expensive work. Network binding is checked by the caller. */
export function parseKeyFile(f) {
  if (!f || f.format !== FORMAT) throw new Error('This is not a Quanlet key backup file.');
  if (f.version !== 1 || f.alg !== 'ML-DSA-44') throw new Error('This key backup uses a version this toolkit does not support.');
  if (!isHex(f.keyId, 32) || !isHex(f.recordId, 32) || typeof f.label !== 'string' || f.label.length > 40) throw new Error('The key backup header is malformed.');
  if (!Number.isInteger(f.chainId) || typeof f.vaultFactory !== 'string') throw new Error('The key backup header is malformed.');
  const k = f.kdf;
  if (!k || k.alg !== 'argon2id' || k.v !== 19 || !isHex(k.salt, 16) || !within(k.memKiB, BOUNDS.memKiB) || !within(k.passes, BOUNDS.passes) || !within(k.lanes, BOUNDS.lanes))
    throw new Error('The key backup asks for password settings outside the allowed range.');
  if (!f.aead || f.aead.alg !== 'xchacha20poly1305' || !isHex(f.aead.nonce, 24)) throw new Error('The key backup cipher settings are malformed.');
  if (!isHex(f.ciphertext, SEED + PK + 16)) throw new Error('The key backup body has the wrong length.');
  return f;
}

/** Decrypts, then recomputes the public key, key id and record id and checks them against the header. */
export async function decryptKey(file, password) {
  const f = parseKeyFile(file);
  const key = await derive(password, hexToBytes(f.kdf.salt), f.kdf);
  let body;
  try {
    body = xchacha20poly1305(key, hexToBytes(f.aead.nonce), aad(f)).decrypt(hexToBytes(f.ciphertext));
  } catch {
    throw new Error('Wrong password, or the file was changed.');
  } finally {
    key.fill(0);
  }
  const seed = bytesToHex(body.slice(0, SEED));
  const k = keyFromSeed(seed);
  const pkOk = bytesToHex(k.publicKey) === bytesToHex(body.slice(SEED));
  body.fill(0);
  const rec = recordOf(k.publicKey);
  if (!pkOk || rec.keyId !== f.keyId.toLowerCase() || rec.recordId !== f.recordId.toLowerCase())
    throw new Error('The key inside does not match its header. Do not use this file.');
  return k;
}
