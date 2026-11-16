// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseV2} from "./BaseV2.t.sol";
import {PersonalVaultV2} from "../../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy, AssetRule} from "../../src/v2/QuanletV2.sol";

/// The standalone toolkit (cli/, "quanlet v2 ...") computes every protocol 2.0 digest itself, so an offline
/// signer never trusts one it is handed. These tests compare each of its encoders with the contracts' own
/// view functions, and check that it recovers a pending policy from the proposing calldata (finding I-3).
contract CliV2Test is BaseV2 {
    function cli(string[] memory args) internal returns (bytes memory) {
        string[] memory cmd = new string[](args.length + 3);
        cmd[0] = "node";
        cmd[1] = "../cli/bin/quanlet.mjs";
        cmd[2] = "v2";
        for (uint256 i; i < args.length; ++i) cmd[i + 3] = args[i];
        return vm.ffi(cmd);
    }

    function csv(bytes32[5] memory ids) internal pure returns (string memory s) {
        s = vm.toString(ids[0]);
        for (uint256 i = 1; i < 5; ++i) s = string.concat(s, ",", vm.toString(ids[i]));
    }

    function richPolicy() internal view returns (Policy memory p) {
        p = flexible(5 ether, 1 ether, 20 days, 86_400, 0.01 ether);
    }

    function test_KeyIdAndRegistrationDigest() public {
        bytes memory pk = pkOf(P);
        string[] memory a = new string[](2);
        a[0] = "_v2keyid";
        a[1] = vm.toString(pk);
        bytes32 keyId = bytes32(cli(a));
        assertEq(keyId, keys.keyIdOf(pk));

        string[] memory r = new string[](6);
        r[0] = "_v2reg";
        r[1] = vm.toString(block.chainid);
        r[2] = vm.toString(address(keys));
        r[3] = vm.toString(keyId);
        r[4] = "1800000000";
        r[5] = "1800001800";
        assertEq(bytes32(cli(r)), keys.registrationDigest(keyId, 1_800_000_000, 1_800_001_800));
    }

    function test_PolicyHashAddressAndSetupDigest() public {
        Policy memory p = richPolicy();
        bytes32[5] memory ids = roleIds();
        bytes32 salt = keccak256("cli-v2-salt");

        string[] memory h = new string[](2);
        h[0] = "_v2policy";
        h[1] = vm.toString(abi.encode(p));
        assertEq(bytes32(cli(h)), keccak256(abi.encode(p)));

        string[] memory a = new string[](7);
        a[0] = "_v2predict";
        a[1] = vm.toString(address(factory));
        a[2] = vm.toString(address(keys));
        a[3] = csv(ids);
        a[4] = vm.toString(abi.encode(p));
        a[5] = vm.toString(salt);
        a[6] = vm.toString(ETH);
        // Fails when cli/abi/PersonalVaultV2.json is stale: run "node cli/scripts/sync.mjs" after forge build.
        assertEq(address(bytes20(cli(a))), factory.predictAddress(ids, p, salt));

        string[] memory s = new string[](11);
        for (uint256 i; i < 7; ++i) s[i] = a[i];
        s[0] = "_v2setup";
        s[7] = vm.toString(block.chainid);
        s[8] = vm.toString(factory.dependencyManifestHash());
        s[9] = "1800000000";
        s[10] = "1800001800";
        assertEq(bytes32(cli(s)), factory.setupDigest(ids, p, salt, 1_800_000_000, 1_800_001_800));
    }

    function test_ActionDigestsOnEveryLane() public {
        PersonalVaultV2 v = createVault(richPolicy());
        bytes32 ph = keccak256("params");
        for (uint8 lane = 1; lane <= 5; ++lane) {
            string[] memory d = new string[](12);
            d[0] = "_v2digest";
            d[1] = vm.toString(uint256(lane == 5 ? C.A_START_RECOVERY : C.A_TRANSFER));
            d[2] = vm.toString(uint256(lane));
            d[3] = vm.toString(block.chainid);
            d[4] = vm.toString(address(v));
            d[5] = vm.toString(uint256(v.authorityEpoch()));
            d[6] = vm.toString(uint256(v.policyEpoch()));
            d[7] = vm.toString(uint256(v.executionEpoch()));
            d[8] = "7";
            d[9] = vm.toString(ph);
            d[10] = "1800000000";
            d[11] = "1800001800";
            uint8 action = lane == 5 ? C.A_START_RECOVERY : C.A_TRANSFER;
            assertEq(bytes32(cli(d)), v.actionDigest(action, lane, 7, ph, 1_800_000_000, 1_800_001_800));
        }
    }

    function test_ConsentAndTransferHash() public {
        PersonalVaultV2 v = createVault(guarded());
        string[] memory c = new string[](4);
        c[0] = "_v2consent";
        c[1] = vm.toString(keccak256("digest"));
        c[2] = "2";
        c[3] = vm.toString(keccak256("new key"));
        assertEq(bytes32(cli(c)), v.consentDigest(keccak256("digest"), 2, keccak256("new key")));

        PersonalVaultV2.Transfer memory t = PersonalVaultV2.Transfer(2, ETH, bob, 1.5 ether, relay, 0.001 ether);
        string[] memory x = new string[](7);
        x[0] = "_v2transfer";
        x[1] = "2";
        x[2] = vm.toString(ETH);
        x[3] = vm.toString(address(bob));
        x[4] = vm.toString(uint256(1.5 ether));
        x[5] = vm.toString(address(relay));
        x[6] = vm.toString(uint256(0.001 ether));
        assertEq(bytes32(cli(x)), v.transferParamsHash(t));
    }

    /// The toolkit finds the pending policy in the proposing calldata, direct or nested, and only by its hash.
    function test_FindsPendingPolicyInCalldata() public {
        Policy memory p = richPolicy();
        PersonalVaultV2.Window memory w = win();
        bytes memory call = abi.encodeCall(PersonalVaultV2.updatePolicy, (p, w, hex"01", hex"02"));
        bytes32 h = keccak256(abi.encode(p));
        string[] memory f = new string[](3);
        f[0] = "_v2found";
        f[1] = vm.toString(call);
        f[2] = vm.toString(h);
        assertEq(cli(f), hex"01");
        // nested inside another call's bytes argument (a batch or relay contract)
        f[1] = vm.toString(abi.encodeWithSignature("relay(address,bytes)", address(0xBEEF), call));
        assertEq(cli(f), hex"01");
        // a different policy is not accepted
        f[2] = vm.toString(keccak256("another policy"));
        assertEq(cli(f), hex"00");
    }

    /// The published 2.0 vectors (cli/vectors/46630.v2.json): every key id matches KeyFactoryV2, and every
    /// registration, setup, action and consent signature verifies in the on-chain verifier.
    function test_SigningVectorsVerifyOnChain() public {
        string memory json = vm.readFile("../cli/vectors/46630.v2.json");
        string[10] memory names = ["P", "A", "G1", "G2", "G3", "NEW_P", "NEW_A", "NEW_G1", "NEW_G2", "NEW_G3"];
        for (uint256 i; i < names.length; ++i) {
            string memory k = string.concat(".keys.", names[i]);
            bytes memory pk = vm.parseJsonBytes(json, string.concat(k, ".publicKey"));
            assertEq(vm.parseJsonBytes32(json, string.concat(k, ".keyId")), keys.keyIdOf(pk));
            blobOf[names[i]] = _deployRaw(keys.preparedBlobOf(pk));
            _check(json, names[i], string.concat(k, ".registration.digest"), string.concat(k, ".registration.signature"));
            if (i < 5) _check(json, names[i], ".setup.digest", string.concat(".setup.signatures.", names[i]));
        }
        for (uint256 a; a < 11; ++a) {
            string memory base = string.concat(".actions[", vm.toString(a), "]");
            string[] memory slots = vm.parseJsonKeys(json, string.concat(base, ".signatures"));
            for (uint256 s; s < slots.length; ++s) {
                string memory at = string.concat(base, ".signatures.", slots[s]);
                _check(json, vm.parseJsonString(json, string.concat(at, ".key")), string.concat(base, ".digest"), string.concat(at, ".signature"));
            }
            string[] memory cons = vm.parseJsonKeys(json, string.concat(base, ".consents"));
            for (uint256 s; s < cons.length; ++s) {
                string memory at = string.concat(base, ".consents.", cons[s]);
                _check(json, vm.parseJsonString(json, string.concat(at, ".key")), string.concat(at, ".digest"), string.concat(at, ".signature"));
            }
        }
    }

    mapping(string => address) internal blobOf;

    function _check(string memory json, string memory key, string memory digestPath, string memory sigPath) internal view {
        bytes32 d = vm.parseJsonBytes32(json, digestPath);
        bytes memory sig = vm.parseJsonBytes(json, sigPath);
        assertTrue(verifier.verify(blobOf[key], abi.encodePacked(d), sig), sigPath);
    }
}
