/**
 * Encrypted backup of one ML-DSA-44 key, following the whitepaper's key backup profile (§4):
 * Argon2id v1.3 (64 MiB, 3 passes, 1 lane, 16-byte salt, 32-byte key), then XChaCha20-Poly1305
 * (24-byte nonce, 16-byte tag). The whole header is authenticated as associated data, so a changed
 * key id, KDF parameter or label makes the file fail to open. The body is seed (32) || public key (1312).
 * Each key gets its own file and its own password.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { create } from 'zustand';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { DEPLOYMENT, KEYFILE_FACTORIES, keyFromSeed, keyRecordOf } from './chain';
import { TARGET_CHAIN } from '../wallet';

export const FORMAT = 'quanlet-mldsa44-key';
export const MIN_PASSWORD = 12;
const KDF = { memKiB: 65536, passes: 3, lanes: 1 } as const;
/** Limits on what an imported file may ask for, so a crafted file cannot freeze the page. */
const BOUNDS = { memKiB: [19456, 262144], passes: [1, 10], lanes: [1, 4] } as const;
const SEED = 32;
const PK = 1312;

type Header = {
  format: typeof FORMAT;
  version: 1;
  alg: 'ML-DSA-44';
  label: string;
  keyId: Hex;
  recordId: Hex;
  chainId: number;
  vaultFactory: string;
  kdf: { alg: 'argon2id'; v: 19; memKiB: number; passes: number; lanes: number; salt: Hex };
  aead: { alg: 'xchacha20poly1305'; nonce: Hex };
};
export type KeyFile = Header & { ciphertext: Hex };

/** The associated data: the header with its fields in one fixed order. */
function aad(h: Header): Uint8Array {
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

function derive(password: string, salt: Uint8Array, k: { memKiB: number; passes: number; lanes: number }, onProgress?: (f: number) => void) {
  return argon2idAsync(password.normalize('NFC'), salt, { t: k.passes, m: k.memKiB, p: k.lanes, dkLen: 32, version: 0x13, onProgress });
}

const rand = (n: number) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

export async function encryptKey(seed: Hex, label: string, password: string, onProgress?: (f: number) => void): Promise<KeyFile> {
  if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const k = keyFromSeed(seed);
  const rec = keyRecordOf(k);
  const salt = rand(16);
  const nonce = rand(24);
  const header: Header = {
    format: FORMAT,
    version: 1,
    alg: 'ML-DSA-44',
    label: label.slice(0, 40),
    keyId: rec.keyId,
    recordId: rec.recordId,
    chainId: TARGET_CHAIN,
    vaultFactory: DEPLOYMENT.vaultFactory,
    kdf: { alg: 'argon2id', v: 19, ...KDF, salt: bytesToHex(salt) },
    aead: { alg: 'xchacha20poly1305', nonce: bytesToHex(nonce) },
  };
  const key = await derive(password, salt, KDF, onProgress);
  const body = new Uint8Array(SEED + PK);
  body.set(hexToBytes(seed), 0);
  body.set(k.publicKey, SEED);
  const ct = xchacha20poly1305(key, nonce, aad(header)).encrypt(body);
  key.fill(0);
  body.fill(0);
  return { ...header, ciphertext: bytesToHex(ct) };
}

const isHex = (v: unknown, bytes: number): v is Hex => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v);
const within = (v: unknown, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Check the file's shape before any expensive work. Returns the header, or throws a readable error. */
export function parseKeyFile(raw: unknown): KeyFile {
  const f = raw as KeyFile;
  if (!f || f.format !== FORMAT) throw new Error('This is not a Quanlet key backup file.');
  if (f.version !== 1 || f.alg !== 'ML-DSA-44') throw new Error('This key backup uses a version this page does not support.');
  if (!isHex(f.keyId, 32) || !isHex(f.recordId, 32) || typeof f.label !== 'string' || f.label.length > 40) throw new Error('The key backup header is malformed.');
  if (f.chainId !== TARGET_CHAIN || typeof f.vaultFactory !== 'string' || !KEYFILE_FACTORIES.includes(f.vaultFactory.toLowerCase()))
    throw new Error('This key backup belongs to a different network or deployment.');
  const k = f.kdf;
  if (!k || k.alg !== 'argon2id' || k.v !== 19 || !isHex(k.salt, 16) || !within(k.memKiB, BOUNDS.memKiB) || !within(k.passes, BOUNDS.passes) || !within(k.lanes, BOUNDS.lanes))
    throw new Error('The key backup asks for password settings outside the allowed range.');
  if (!f.aead || f.aead.alg !== 'xchacha20poly1305' || !isHex(f.aead.nonce, 24)) throw new Error('The key backup cipher settings are malformed.');
  if (!isHex(f.ciphertext, SEED + PK + 16)) throw new Error('The key backup body has the wrong length.');
  return f;
}

/**
 * Open a backup: derive the key, authenticate and decrypt, then recompute the public key from the
 * seed and check it against the body and the key id in the header. Returns the seed.
 */
export async function decryptKey(file: KeyFile, password: string, onProgress?: (f: number) => void): Promise<Hex> {
  const f = parseKeyFile(file);
  const key = await derive(password, hexToBytes(f.kdf.salt), f.kdf, onProgress);
  let body: Uint8Array;
  try {
    body = xchacha20poly1305(key, hexToBytes(f.aead.nonce), aad(f)).decrypt(hexToBytes(f.ciphertext));
  } catch {
    throw new Error('Wrong password, or the file was changed.');
  } finally {
    key.fill(0);
  }
  if (body.length !== SEED + PK) throw new Error('The key backup body has the wrong length.');
  const seed = bytesToHex(body.slice(0, SEED));
  const k = keyFromSeed(seed);
  const pkOk = bytesToHex(k.publicKey) === bytesToHex(body.slice(SEED));
  body.fill(0);
  const rec = keyRecordOf(k);
  if (!pkOk || rec.keyId.toLowerCase() !== f.keyId.toLowerCase() || rec.recordId.toLowerCase() !== f.recordId.toLowerCase())
    throw new Error('The key inside does not match its header. Do not use this file.');
  return seed;
}

/** Sign a fresh random message with the restored key and verify it with the recomputed public key. */
export function signTest(seed: Hex): boolean {
  const k = keyFromSeed(seed);
  const msg = rand(32);
  const sig = ml_dsa44.sign(msg, k.secretKey);
  return ml_dsa44.verify(sig, msg, k.publicKey);
}

export function downloadJson(obj: unknown, name: string) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const keyFileName = (label: string, recordId: Hex) =>
  `quanlet-testnet-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${recordId.slice(2, 10)}.key.json`;

/** Keys opened from a backup file for this visit only. Never written to storage. */
interface SessionKeys {
  seeds: Record<string, Hex>;
  put: (recordId: Hex, seed: Hex) => void;
  clear: () => void;
}
export const useSessionKeys = create<SessionKeys>((set) => ({
  seeds: {},
  put: (recordId, seed) => set((s) => ({ seeds: { ...s.seeds, [recordId.toLowerCase()]: seed } })),
  clear: () => set({ seeds: {} }),
}));
