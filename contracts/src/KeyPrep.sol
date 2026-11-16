// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {shake256Batch170} from "./verifier/FastKeccak170.sol";

/// @title KeyPrep
/// @notice On-chain canonical preparation of an ML-DSA-44 public key into the verifier's key blob.
///
/// Computes exactly what script/prepare.py computes, from the raw 1,312-byte FIPS 204 public key alone:
///   [    0 ..     1)  0x00
///   [    1 ..    65)  tr    = SHAKE256(pk, 64)
///   [   65 ..  4161)  t1hat = NTT(2^13 * t1), 4 polys
///   [ 4161 .. 20545)  Ahat  = ExpandA(rho), 16 polys row-major (i*4 + j)
/// Each poly is 32 words; word w holds coefficients 8w..8w+7, coefficient 8w+s at bit offset 32*s.
/// All coefficients are canonical (< q).
///
/// Keccak-f[1600] runs in the verifier's helper contract (bound by code hash by the caller).
/// Nothing here is supplied by the caller except the raw key, so the result cannot be forged.
library KeyPrep {
    uint256 internal constant Q = 8380417;
    uint256 internal constant BLOB_LENGTH = 20545;
    uint256 internal constant T1_OFF = 64; // payload offsets, i.e. from blob byte 1
    uint256 internal constant A_OFF = 4160;

    /// @param pk raw public key, already checked to be 1,312 bytes
    /// @param f1600 Keccak-f[1600] helper (raw entry: 800-byte state in, 800-byte state out)
    function prepare(bytes calldata pk, address f1600) internal view returns (bytes memory blob) {
        blob = new bytes(BLOB_LENGTH); // zero filled; byte 0 stays 0x00
        uint256 out;
        assembly ("memory-safe") {
            out := add(blob, 33)
        }

        // tr = SHAKE256(pk, 64)
        bytes memory tr = shake256Batch170(pk, 64, f1600);
        assembly ("memory-safe") {
            mcopy(out, add(tr, 32), 64)
        }

        // Powers of zeta = 1753, so zetas[k] = pw[brv8(k)].
        uint256[256] memory pw;
        assembly ("memory-safe") {
            let x := 1
            for { let i := 0 } lt(i, 256) { i := add(i, 1) } {
                mstore(add(pw, shl(5, i)), x)
                x := mulmod(x, 1753, Q)
            }
        }

        uint256[256] memory w;
        for (uint256 i; i < 4; ++i) {
            _t1Hat(pk, i, w, pw, out + T1_OFF + i * 1024);
        }

        uint256[25] memory st;
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                _rejNttPoly(pk, j, i, st, f1600, out + A_OFF + (i * 4 + j) * 1024);
            }
        }
    }

    /// NTT(2^13 * t1[i]) written as one packed poly at memory `dst`. FIPS 204 Algorithm 41.
    function _t1Hat(bytes calldata pk, uint256 i, uint256[256] memory w, uint256[256] memory pw, uint256 dst)
        private
        pure
    {
        assembly ("memory-safe") {
            function brv8(k) -> r {
                r := or(shr(4, and(k, 0xf0)), shl(4, and(k, 0x0f)))
                r := or(shr(2, and(r, 0xcc)), shl(2, and(r, 0x33)))
                r := or(shr(1, and(r, 0xaa)), shl(1, and(r, 0x55)))
            }

            // Unpack t1[i]: 256 coefficients of 10 bits, little-endian, 4 per 5 bytes.
            let src := add(pk.offset, add(32, mul(320, i)))
            for { let g := 0 } lt(g, 64) { g := add(g, 1) } {
                // The 5 bytes of group g sit in the top 5 bytes of this calldata word.
                let word := calldataload(add(src, mul(5, g)))
                let v := or(
                    or(byte(0, word), shl(8, byte(1, word))),
                    or(or(shl(16, byte(2, word)), shl(24, byte(3, word))), shl(32, byte(4, word)))
                )
                let p := add(w, shl(7, g))
                mstore(p, mod(shl(13, and(v, 0x3ff)), Q))
                mstore(add(p, 0x20), mod(shl(13, and(shr(10, v), 0x3ff)), Q))
                mstore(add(p, 0x40), mod(shl(13, and(shr(20, v), 0x3ff)), Q))
                mstore(add(p, 0x60), mod(shl(13, and(shr(30, v), 0x3ff)), Q))
            }

            // Forward NTT in the standard coefficient order.
            let m := 0
            for { let len := 128 } gt(len, 0) { len := shr(1, len) } {
                let off := shl(5, len)
                for { let start := 0 } lt(start, 256) { start := add(start, shl(1, len)) } {
                    m := add(m, 1)
                    let z := mload(add(pw, shl(5, brv8(m))))
                    let pa := add(w, shl(5, start))
                    let pe := add(pa, off)
                    for {} lt(pa, pe) { pa := add(pa, 0x20) } {
                        let pb := add(pa, off)
                        let t := mulmod(z, mload(pb), Q)
                        let a := mload(pa)
                        mstore(pb, addmod(a, sub(Q, t), Q))
                        mstore(pa, addmod(a, t, Q))
                    }
                }
            }

            // Pack: 8 coefficients per word, coefficient 8k+s at bit 32*s.
            for { let k := 0 } lt(k, 32) { k := add(k, 1) } {
                let p := add(w, shl(8, k))
                let acc := 0
                for { let s := 0 } lt(s, 8) { s := add(s, 1) } {
                    acc := or(acc, shl(shl(5, s), mload(add(p, shl(5, s)))))
                }
                mstore(add(dst, shl(5, k)), acc)
            }
        }
    }

    /// Ahat[i][j] = RejNTTPoly(rho || j || i), written as one packed poly at memory `dst`.
    /// FIPS 204 Algorithm 30 over SHAKE128 (rate 168 bytes = 56 three-byte samples per block).
    function _rejNttPoly(bytes calldata pk, uint256 j, uint256 i, uint256[25] memory st, address f1600, uint256 dst)
        private
        view
    {
        assembly ("memory-safe") {
            // Absorb rho || j || i with SHAKE padding (0x1f ... 0x80) into a fresh state of 64-bit lanes.
            for { let k := 0 } lt(k, 25) { k := add(k, 1) } { mstore(add(st, shl(5, k)), 0) }
            for { let k := 0 } lt(k, 4) { k := add(k, 1) } {
                let word := calldataload(add(pk.offset, shl(3, k)))
                let lane := 0
                for { let t := 0 } lt(t, 8) { t := add(t, 1) } {
                    lane := or(lane, shl(shl(3, t), byte(t, word)))
                }
                mstore(add(st, shl(5, k)), lane)
            }
            mstore(add(st, 0x80), or(or(j, shl(8, i)), shl(16, 0x1f)))
            mstore(add(st, 0x280), shl(56, 0x80)) // lane 20, byte 167

            let n := 0
            let acc := 0
            for {} lt(n, 256) {} {
                let ok := staticcall(gas(), f1600, st, 800, st, 800)
                if iszero(and(ok, eq(returndatasize(), 800))) {
                    mstore(0, 0)
                    revert(0, 0)
                }
                for { let b := 0 } and(lt(b, 168), lt(n, 256)) { b := add(b, 3) } {
                    let b1 := add(b, 1)
                    let b2 := add(b, 2)
                    let v := and(shr(shl(3, and(b, 7)), mload(add(st, shl(5, shr(3, b))))), 0xff)
                    v := or(v, shl(8, and(shr(shl(3, and(b1, 7)), mload(add(st, shl(5, shr(3, b1))))), 0xff)))
                    v := or(v, shl(16, and(shr(shl(3, and(b2, 7)), mload(add(st, shl(5, shr(3, b2))))), 0x7f)))
                    if lt(v, Q) {
                        let s := and(n, 7)
                        acc := or(acc, shl(shl(5, s), v))
                        if eq(s, 7) {
                            mstore(add(dst, shl(5, shr(3, n))), acc)
                            acc := 0
                        }
                        n := add(n, 1)
                    }
                }
            }
        }
    }
}
