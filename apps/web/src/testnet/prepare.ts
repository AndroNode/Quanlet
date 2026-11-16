/**
 * Browser port of contracts/script/prepare.py (Fireblocks Labs, MIT): builds the 20,545-byte
 * key blob the on-chain ML-DSA-44 verifier reads. Must match prepare.py byte for byte; the
 * test in scripts/prepare-check.mjs compares both on random keys.
 *
 * Layout: 0x00 | tr = SHAKE256(pk, 64) | NTT(2^13 * t1) (4 polys) | ExpandA(rho) (16 polys, row-major)
 * Each poly is 32 big-endian 32-byte words; word w holds coefficients 8w..8w+7, coefficient
 * 8w+s at bit offset 32*s.
 */
import { shake128, shake256 } from '@noble/hashes/sha3.js';

const Q = 8380417;
const N = 256;
const D = 13;
const K = 4;
const L = 4;
export const PK_SIZE = 1312;
export const BLOB_SIZE = 20545;

const mulmod = (a: number, b: number) => Number((BigInt(a) * BigInt(b)) % BigInt(Q));
function powmod(b: number, e: number) {
  let r = 1n;
  let x = BigInt(b) % BigInt(Q);
  let k = e;
  while (k > 0) {
    if (k & 1) r = (r * x) % BigInt(Q);
    x = (x * x) % BigInt(Q);
    k >>= 1;
  }
  return Number(r);
}
const brv8 = (i: number) => {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b);
  return r;
};
const ZETAS = Array.from({ length: 256 }, (_, i) => powmod(1753, brv8(i)));

/** FIPS 204 Algorithm 41. */
function ntt(a: number[]): number[] {
  const w = a.slice();
  let m = 0;
  for (let len = 128; len >= 1; len >>= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const z = ZETAS[++m]!;
      for (let j = start; j < start + len; j++) {
        const t = mulmod(z, w[j + len]!);
        w[j + len] = (w[j]! - t + Q) % Q;
        w[j] = (w[j]! + t) % Q;
      }
    }
  }
  return w;
}

/** FIPS 204 Algorithm 30, same retry rule as prepare.py (prefix property keeps it deterministic). */
function rejNttPoly(seed: Uint8Array): number[] {
  let want = 3 * N + 96;
  for (;;) {
    const buf = shake128(seed, { dkLen: want });
    const out: number[] = [];
    for (let i = 0; i + 3 <= buf.length && out.length < N; i += 3) {
      const v = buf[i]! | (buf[i + 1]! << 8) | ((buf[i + 2]! & 0x7f) << 16);
      if (v < Q) out.push(v);
    }
    if (out.length === N) return out;
    want *= 2;
  }
}

function compact32(coeffs: number[], out: Uint8Array, off: number) {
  for (let w = 0; w < 32; w++) {
    // Big-endian 32-byte word; coefficient s sits at bit 32*s, so it lands in bytes [28-4s, 32-4s).
    for (let s = 0; s < 8; s++) {
      const c = coeffs[8 * w + s]!;
      const p = off + w * 32 + (28 - 4 * s);
      out[p] = (c >>> 24) & 0xff;
      out[p + 1] = (c >>> 16) & 0xff;
      out[p + 2] = (c >>> 8) & 0xff;
      out[p + 3] = c & 0xff;
    }
  }
}

export function prepareBlob(pk: Uint8Array): Uint8Array {
  if (pk.length !== PK_SIZE) throw new Error(`ML-DSA-44 public key must be ${PK_SIZE} bytes`);
  const rho = pk.slice(0, 32);
  const t1: number[][] = [];
  for (let r = 0; r < K; r++) {
    const chunk = pk.subarray(32 + r * 320, 32 + (r + 1) * 320);
    const row: number[] = [];
    for (let i = 0; i < N; i++) {
      const bit = 10 * i;
      const byte = bit >> 3;
      const sh = bit & 7;
      const v = (chunk[byte]! | (chunk[byte + 1]! << 8) | ((chunk[byte + 2] ?? 0) << 16)) >> sh;
      row.push(v & 0x3ff);
    }
    t1.push(row);
  }
  const blob = new Uint8Array(BLOB_SIZE);
  blob[0] = 0;
  blob.set(shake256(pk, { dkLen: 64 }), 1);
  let off = 65;
  for (let i = 0; i < K; i++) {
    compact32(ntt(t1[i]!.map((c) => (c << D) % Q)), blob, off);
    off += 1024;
  }
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < L; j++) {
      const seed = new Uint8Array(34);
      seed.set(rho);
      seed[32] = j;
      seed[33] = i;
      compact32(rejNttPoly(seed), blob, off);
      off += 1024;
    }
  }
  if (off !== BLOB_SIZE) throw new Error('blob size mismatch');
  return blob;
}
