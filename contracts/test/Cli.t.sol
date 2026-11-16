// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {PersonalVault} from "../src/PersonalVault.sol";
import {QuanletConstants as C} from "../src/QuanletConstants.sol";

/// The standalone toolkit (cli/) computes every digest itself so an offline signer never trusts one it is
/// handed. These tests compare each of its encoders with the contracts' own view functions, and check that
/// its published signing vectors verify in the on-chain verifier.
contract CliTest is Base {
    function cli(string[] memory args) internal returns (bytes memory) {
        string[] memory cmd = new string[](args.length + 2);
        cmd[0] = "node";
        cmd[1] = "../cli/bin/quanlet.mjs";
        for (uint256 i; i < args.length; ++i) cmd[i + 2] = args[i];
        return vm.ffi(cmd);
    }

    function a1(string memory x) internal pure returns (string[] memory r) {
        r = new string[](1);
        r[0] = x;
    }

    function test_KeyRecordAndProofMessage() public {
        bytes memory pk = pkOf(P1);
        string[] memory args = new string[](2);
        args[0] = "_record";
        args[1] = vm.toString(pk);
        (bytes32 keyId, bytes32 blobHash, bytes32 recordId) = abi.decode(abi.encodePacked(cli(args), new bytes(0)), (bytes32, bytes32, bytes32));
        assertEq(keyId, keys.keyIdOf(pk));
        assertEq(blobHash, keccak256(keys.preparedBlobOf(pk)));
        assertEq(recordId, keys.recordIdOf(keyId, blobHash));

        string[] memory p = new string[](5);
        p[0] = "_pop";
        p[1] = vm.toString(block.chainid);
        p[2] = vm.toString(address(keys));
        p[3] = vm.toString(keyId);
        p[4] = vm.toString(blobHash);
        assertEq(bytes32(cli(p)), keys.popMessage(keyId, blobHash));
    }

    function test_VaultAddressAndSetupDigest() public {
        bytes32 pr = register(P1);
        bytes32[3] memory rr = [register(R1), register(R2), register(R3)];
        bytes32 salt = keccak256("cli-salt");
        string[] memory p = new string[](8);
        p[0] = "_predict";
        p[1] = vm.toString(address(factory));
        p[2] = vm.toString(address(keys));
        p[3] = vm.toString(pr);
        p[4] = vm.toString(rr[0]);
        p[5] = vm.toString(rr[1]);
        p[6] = vm.toString(rr[2]);
        p[7] = vm.toString(salt);
        // Fails when cli/abi/PersonalVault.json is stale: run "node cli/scripts/sync.mjs" after forge build.
        assertEq(address(bytes20(cli(p))), factory.predictAddress(pr, rr, salt));

        string[] memory s = new string[](9);
        s[0] = "_setup";
        s[1] = vm.toString(block.chainid);
        s[2] = vm.toString(address(factory));
        s[3] = vm.toString(address(keys));
        s[4] = vm.toString(pr);
        s[5] = string.concat(vm.toString(rr[0]), ",", vm.toString(rr[1]), ",", vm.toString(rr[2]));
        s[6] = vm.toString(salt);
        s[7] = "1800000000";
        s[8] = "1800001800";
        assertEq(bytes32(cli(s)), factory.setupDigest(pr, rr, salt, 1800000000, 1800001800));
    }

    function testFuzz_ActionDigestAndWithdrawalHash(uint8 action, uint64 ee, uint64 ae, uint256 nonce, bytes32 ph, uint64 va, address to, uint96 amt)
        public
    {
        PersonalVault v = createVault(P1, R1, R2, R3);
        // First against the vault itself (its epochs are 0 here), then with fuzzed epochs against the
        // Appendix C field list, which is exactly what actionDigest encodes.
        action = uint8(bound(action, 1, 6));
        va = uint64(bound(va, 0, type(uint64).max - 1800));
        string[] memory d = new string[](10);
        d[0] = "_digest";
        d[1] = vm.toString(uint256(action));
        d[2] = vm.toString(block.chainid);
        d[3] = vm.toString(address(v));
        d[4] = "0";
        d[5] = "0";
        d[6] = vm.toString(nonce);
        d[7] = vm.toString(ph);
        d[8] = vm.toString(uint256(va));
        d[9] = vm.toString(uint256(va) + 1800);
        assertEq(bytes32(cli(d)), v.actionDigest(action, nonce, ph, va, va + 1800));

        d[4] = vm.toString(uint256(ee));
        d[5] = vm.toString(uint256(ae));
        bytes32 expected = keccak256(
            abi.encode(C.DOMAIN_TAG, C.PROTOCOL_VERSION, block.chainid, address(v), action, ee, ae, nonce, ph, va, uint64(uint256(va) + 1800))
        );
        assertEq(bytes32(cli(d)), expected);

        string[] memory w = new string[](6);
        w[0] = "_withdrawal";
        w[1] = vm.toString(address(0));
        w[2] = vm.toString(to);
        w[3] = vm.toString(uint256(amt));
        w[4] = vm.toString(address(0));
        w[5] = "0";
        assertEq(bytes32(cli(w)), v.withdrawalParamsHash(address(0), to, amt, address(0), 0));
    }

    /// Every published vector signature verifies in the on-chain ML-DSA-44 verifier.
    function test_SigningVectorsVerifyOnChain() public {
        string memory json = string(cli(a1("vectors")));
        string[8] memory names =
            ["PRIMARY", "RECOVERY_0", "RECOVERY_1", "RECOVERY_2", "NEW_PRIMARY", "NEW_RECOVERY_0", "NEW_RECOVERY_1", "NEW_RECOVERY_2"];
        for (uint256 i; i < names.length; ++i) {
            bytes memory pk = vm.parseJsonBytes(json, string.concat(".keys.", names[i], ".publicKey"));
            assertEq(vm.parseJsonBytes32(json, string.concat(".keys.", names[i], ".keyId")), keys.keyIdOf(pk));
            address blob = _deployRaw(keys.preparedBlobOf(pk));
            bytes32 pop = vm.parseJsonBytes32(json, string.concat(".keys.", names[i], ".popMessage"));
            assertTrue(verifier.verify(blob, abi.encodePacked(pop), vm.parseJsonBytes(json, string.concat(".keys.", names[i], ".popSignature"))));
            if (i == 0) {
                bytes32 sd = vm.parseJsonBytes32(json, ".setup.digest");
                assertTrue(verifier.verify(blob, abi.encodePacked(sd), vm.parseJsonBytes(json, ".setup.signature")));
            }
        }
        uint256 n = 7;
        for (uint256 a; a < n; ++a) {
            string memory base = string.concat(".actions[", vm.toString(a), "]");
            bytes32 digest = vm.parseJsonBytes32(json, string.concat(base, ".digest"));
            string[] memory signerKeys = vm.parseJsonKeys(json, string.concat(base, ".signatures"));
            for (uint256 s; s < signerKeys.length; ++s) {
                bytes memory pk = vm.parseJsonBytes(json, string.concat(".keys.", signerKeys[s], ".publicKey"));
                address blob = _deployRaw(keys.preparedBlobOf(pk));
                bytes memory sig = vm.parseJsonBytes(json, string.concat(base, ".signatures.", signerKeys[s]));
                assertTrue(verifier.verify(blob, abi.encodePacked(digest), sig), string.concat("vector ", vm.toString(a)));
            }
        }
    }
}
