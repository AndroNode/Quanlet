/**
 * Encrypted backup of one protocol 2.0 ML-DSA-44 key. Same profile as 1.x (Argon2id v1.3, 64 MiB, 3 passes,
 * then XChaCha20-Poly1305 with the whole header as associated data; body = seed || public key), but the
 * header names the 2.0 key id and KeyFactoryV2 instead of a 1.x record. Version 2 files and version 1 files
 * cannot be opened on each other's page.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { keyFromSeed } from '../chain';
import { TARGET_CHAIN } from '../../wallet';
import { FORMAT, MIN_PASSWORD } from '../keyfile';
import { KEY_FACTORY, keyIdOf } from './chain';
import { WORDS } from '../../net';

const KDF = { memKiB: 65536, passes: 3, lanes: 1 } as const;
const BOUNDS = { memKiB: [19456, 262144], passes: [1, 10], lanes: [1, 4] } as const;
const SEED = 32;
const PK = 1312;

type Header = {
  format: typeof FORMAT;
  version: 2;
  protocol: 2;
  alg: 'ML-DSA-44';
  label: string;
  keyId: Hex;
  chainId: number;
  keyFactory: string;
  kdf: { alg: 'argon2id'; v: 19; memKiB: number; passes: number; lanes: number; salt: Hex };
  aead: { alg: 'xchacha20poly1305'; nonce: Hex };
};
export type KeyFileV2 = Header & { ciphertext: Hex };

function aad(h: Header): Uint8Array {
  const fixed = {
    format: h.format,
    version: h.version,
    protocol: h.protocol,
    alg: h.alg,
    label: h.label,
    keyId: h.keyId.toLowerCase(),
    chainId: h.chainId,
    keyFactory: h.keyFactory.toLowerCase(),
    kdf: { alg: h.kdf.alg, v: h.kdf.v, memKiB: h.kdf.memKiB, passes: h.kdf.passes, lanes: h.kdf.lanes, salt: h.kdf.salt.toLowerCase() },
    aead: { alg: h.aead.alg, nonce: h.aead.nonce.toLowerCase() },
  };
  return new TextEncoder().encode(JSON.stringify(fixed));
}

const derive = (password: string, salt: Uint8Array, k: { memKiB: number; passes: number; lanes: number }, onProgress?: (f: number) => void) =>
  argon2idAsync(password.normalize('NFC'), salt, { t: k.passes, m: k.memKiB, p: k.lanes, dkLen: 32, version: 0x13, onProgress });

const rand = (n: number) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

export async function encryptKeyV2(seed: Hex, label: string, password: string, onProgress?: (f: number) => void): Promise<KeyFileV2> {
  if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const k = keyFromSeed(seed);
  const salt = rand(16);
  const nonce = rand(24);
  const header: Header = {
    format: FORMAT,
    version: 2,
    protocol: 2,
    alg: 'ML-DSA-44',
    label: label.slice(0, 40),
    keyId: keyIdOf(k),
    chainId: TARGET_CHAIN,
    keyFactory: KEY_FACTORY,
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

export function parseKeyFileV2(raw: unknown): KeyFileV2 {
  const f = raw as KeyFileV2;
  if (!f || f.format !== FORMAT) throw new Error('This is not a Quanlet key backup file.');
  if ((f as { version: number }).version === 1) throw new Error('This is a protocol 1.x key backup. Open it on the 1.x vault page.');
  if (f.version !== 2 || f.protocol !== 2 || f.alg !== 'ML-DSA-44') throw new Error('This key backup uses a version this page does not support.');
  if (!isHex(f.keyId, 32) || typeof f.label !== 'string' || f.label.length > 40) throw new Error('The key backup header is malformed.');
  if (f.chainId !== TARGET_CHAIN || typeof f.keyFactory !== 'string' || f.keyFactory.toLowerCase() !== KEY_FACTORY.toLowerCase())
    throw new Error('This key backup belongs to a different network or deployment.');
  const k = f.kdf;
  if (!k || k.alg !== 'argon2id' || k.v !== 19 || !isHex(k.salt, 16) || !within(k.memKiB, BOUNDS.memKiB) || !within(k.passes, BOUNDS.passes) || !within(k.lanes, BOUNDS.lanes))
    throw new Error('The key backup asks for password settings outside the allowed range.');
  if (!f.aead || f.aead.alg !== 'xchacha20poly1305' || !isHex(f.aead.nonce, 24)) throw new Error('The key backup cipher settings are malformed.');
  if (!isHex(f.ciphertext, SEED + PK + 16)) throw new Error('The key backup body has the wrong length.');
  return f;
}

/** Open a backup, then recompute the public key and key id from the seed and check them against the file. */
export async function decryptKeyV2(file: KeyFileV2, password: string, onProgress?: (f: number) => void): Promise<Hex> {
  const f = parseKeyFileV2(file);
  const key = await derive(password, hexToBytes(f.kdf.salt), f.kdf, onProgress);
  let body: Uint8Array;
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
  if (!pkOk || keyIdOf(k).toLowerCase() !== f.keyId.toLowerCase()) throw new Error('The key inside does not match its header. Do not use this file.');
  return seed;
}

export const keyFileNameV2 = (label: string, keyId: Hex) => `quanlet-v2-${WORDS.fileTag}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${keyId.slice(2, 10)}.key.json`;
