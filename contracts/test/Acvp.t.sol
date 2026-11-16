// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {MLDSA44VerifierACVP} from "./acvp/MLDSA44VerifierACVP.sol";

/// NIST ACVP ML-DSA-44 sigVer vectors (FIPS 204), run through the on-chain verifier code.
///
/// Source: usnistgov/ACVP-Server gen-val/json-files/ML-DSA-sigVer-FIPS204/internalProjection.json.
/// test/acvp/mldsa44-sigver.json keeps the 60 ML-DSA-44 cases and, for each, the M' of FIPS 204
/// (built from message, context and pre-hash by the converter described in docs/ACVP.md) or the
/// supplied mu. Key blobs are prepared on-chain by KeyFactory.preparedBlobOf, the same code that
/// registration uses, so key preparation is covered by the vectors too.
contract AcvpTest is Base {
    MLDSA44VerifierACVP internal harness;
    string internal json;

    function setUp() public override {
        super.setUp();
        bytes memory helperRuntime = vm.parseBytes(string.concat("0x", _trim(vm.readFile("helpers/f1600_170.hex"))));
        harness = new MLDSA44VerifierACVP(_deployRaw(helperRuntime));
        json = vm.readFile("test/acvp/mldsa44-sigver.json");
    }

    function signBytes(bytes32 seed, bytes memory m) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(seed);
        cmd[4] = vm.toString(m);
        return vm.ffi(cmd);
    }

    function _key(uint256 i) internal pure returns (string memory) {
        return string.concat(".tests[", vm.toString(i), "]");
    }

    /// Runs vectors [from, to): the verifier core must accept exactly the cases NIST marks as passing.
    function _run(uint256 from, uint256 to, uint256 tgId) internal returns (uint256 ok) {
        assertEq(vm.parseJsonUint(json, ".count"), 60, "vector count");
        for (uint256 i = from; i < to; ++i) {
            string memory k = _key(i);
            assertEq(vm.parseJsonUint(json, string.concat(k, ".tgId")), tgId, "group");
            uint256 tcId = vm.parseJsonUint(json, string.concat(k, ".tcId"));
            bool expected = vm.parseJsonBool(json, string.concat(k, ".expected"));
            bool isMu = vm.parseJsonBool(json, string.concat(k, ".isMu"));
            bytes memory pk = vm.parseJsonBytes(json, string.concat(k, ".pk"));
            bytes memory data = vm.parseJsonBytes(json, string.concat(k, ".data"));
            bytes memory sig = vm.parseJsonBytes(json, string.concat(k, ".sig"));

            address blob = _deployRaw(keys.preparedBlobOf(pk));
            bool got = isMu ? harness.verifyMu(blob, data, sig) : harness.verifyMPrime(blob, data, sig);
            assertEq(got, expected, string.concat("ACVP tcId ", vm.toString(tcId)));
            if (got) ++ok;
        }
    }

    /// tg1: external interface, pure ML-DSA, with context strings (tcId 1-15).
    function test_AcvpPureWithContext() public {
        assertEq(_run(0, 15, 1), 3, "valid cases");
    }

    /// tg2: external interface, HashML-DSA over 12 pre-hash functions (tcId 16-30).
    function test_AcvpPreHash() public {
        assertEq(_run(15, 30, 2), 3, "valid cases");
    }

    /// tg7: internal interface with an externally supplied mu (tcId 91-105).
    function test_AcvpExternalMu() public {
        assertEq(_run(30, 45, 7), 3, "valid cases");
    }

    /// tg8: internal interface, M' given directly (tcId 106-120).
    function test_AcvpInternal() public {
        assertEq(_run(45, 60, 8), 3, "valid cases");
    }

    /// The production verifier on the vector it can take as-is (pure, empty context: tcId 10).
    function test_AcvpProductionVerifierEmptyContext() public {
        uint256 n = vm.parseJsonUint(json, ".count");
        uint256 ran;
        for (uint256 i; i < n; ++i) {
            string memory k = _key(i);
            if (!vm.parseJsonBool(json, string.concat(k, ".direct"))) continue;
            bool expected = vm.parseJsonBool(json, string.concat(k, ".expected"));
            bytes memory pk = vm.parseJsonBytes(json, string.concat(k, ".pk"));
            bytes memory m = vm.parseJsonBytes(json, string.concat(k, ".message"));
            bytes memory sig = vm.parseJsonBytes(json, string.concat(k, ".sig"));
            address blob = _deployRaw(keys.preparedBlobOf(pk));
            assertEq(verifier.verify(blob, m, sig), expected);
            assertEq(harness.verifyMPrime(blob, abi.encodePacked(hex"0000", m), sig), expected);
            ++ran;
        }
        assertEq(ran, 1);
    }

    /// The harness and the production verifier agree: production verify(M) == harness verifyMPrime(0x00||0x00||M),
    /// for valid and tampered signatures over many message lengths, including the 734-byte special case.
    function test_HarnessMatchesProduction() public {
        bytes memory pk = pkOf(P1);
        address blob = _deployRaw(keys.preparedBlobOf(pk));
        uint256[6] memory lens = [uint256(0), 1, 32, 733, 734, 1500];
        for (uint256 j; j < lens.length; ++j) {
            bytes memory m = new bytes(lens[j]);
            for (uint256 b; b < m.length; ++b) m[b] = bytes1(uint8(b * 7 + j));
            bytes memory sig = signBytes(P1, m);
            assertTrue(verifier.verify(blob, m, sig), "production accepts");
            assertTrue(harness.verifyMPrime(blob, abi.encodePacked(hex"0000", m), sig), "harness accepts");
            sig[100] ^= 0x01;
            assertFalse(verifier.verify(blob, m, sig));
            assertFalse(harness.verifyMPrime(blob, abi.encodePacked(hex"0000", m), sig));
        }
    }

    /// On-chain key preparation equals prepare.py (the reference preparation) for every ACVP key.
    function test_AcvpKeysPrepareLikeReference() public {
        uint256 n = vm.parseJsonUint(json, ".count");
        bytes32 last;
        for (uint256 i; i < n; ++i) {
            bytes memory pk = vm.parseJsonBytes(json, string.concat(_key(i), ".pk"));
            if (keccak256(pk) == last) continue;
            last = keccak256(pk);
            assertEq(keccak256(keys.preparedBlobOf(pk)), keccak256(blobOf(pk)));
        }
    }
}
