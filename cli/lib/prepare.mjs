// Canonical ML-DSA-44 key preparation, the same bytes KeyFactory computes on chain (contracts/src/KeyPrep.sol)
// and contracts/script/prepare.py computes off chain. Used only to know a key's record id in advance.
import { shake128, shake256 } from '@noble/hashes/sha3.js';

const Q = 8380417n;
const N = 256;
export const PK_SIZE = 1312;
export const BLOB_SIZE = 20545;

const mod = (a) => Number(((a % Q) + Q) % Q);
const brv8 = (i) => {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b);
  return r;
};
const ZETAS = (() => {
  const pw = [1n];
  for (let i = 1; i < 256; i++) pw.push((pw[i - 1] * 1753n) % Q);
  return Array.from({ length: 256 }, (_, k) => pw[brv8(k)]);
})();

function ntt(a) {
  const w = a.map(BigInt);
  let m = 0;
  for (let len = 128; len >= 1; len >>= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const z = ZETAS[++m];
      for (let j = start; j < start + len; j++) {
        const t = (z * w[j + len]) % Q;
        w[j + len] = (w[j] - t + Q) % Q;
        w[j] = (w[j] + t) % Q;
      }
    }
  }
  return w.map(Number);
}

function rejNttPoly(seed) {
  let want = 3 * N + 96;
  for (;;) {
    const buf = shake128(seed, { dkLen: want });
    const out = [];
    for (let i = 0; i + 3 <= buf.length && out.length < N; i += 3) {
      const v = buf[i] | (buf[i + 1] << 8) | ((buf[i + 2] & 0x7f) << 16);
      if (v < 8380417) out.push(v);
    }
    if (out.length === N) return out;
    want *= 2;
  }
}

function compact32(coeffs, out, off) {
  for (let w = 0; w < 32; w++) {
    for (let s = 0; s < 8; s++) {
      const c = coeffs[8 * w + s];
      const p = off + w * 32 + (28 - 4 * s);
      out[p] = (c >>> 24) & 0xff;
      out[p + 1] = (c >>> 16) & 0xff;
      out[p + 2] = (c >>> 8) & 0xff;
      out[p + 3] = c & 0xff;
    }
  }
}

export function prepareBlob(pk) {
  if (pk.length !== PK_SIZE) throw new Error(`An ML-DSA-44 public key is ${PK_SIZE} bytes, not ${pk.length}.`);
  const blob = new Uint8Array(BLOB_SIZE);
  blob.set(shake256(pk, { dkLen: 64 }), 1);
  let off = 65;
  for (let r = 0; r < 4; r++) {
    const chunk = pk.subarray(32 + r * 320, 32 + (r + 1) * 320);
    const row = [];
    for (let i = 0; i < N; i++) {
      const bit = 10 * i;
      const b = bit >> 3;
      const v = (chunk[b] | (chunk[b + 1] << 8) | ((chunk[b + 2] ?? 0) << 16)) >> (bit & 7);
      row.push(mod(BigInt(v & 0x3ff) << 13n));
    }
    compact32(ntt(row), blob, off);
    off += 1024;
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const seed = new Uint8Array(34);
      seed.set(pk.subarray(0, 32));
      seed[32] = j;
      seed[33] = i;
      compact32(rejNttPoly(seed), blob, off);
      off += 1024;
    }
  }
  return blob;
}
