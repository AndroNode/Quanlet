// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseV2} from "./BaseV2.t.sol";
import {PersonalVaultV2} from "../../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy} from "../../src/v2/QuanletV2.sol";

/// The read-only helpers that clients (the website, the CLI, wallets) rely on must agree with the encodings
/// the vault and factories actually check (Appendices A, C and E).
contract ViewsV2Test is BaseV2 {
    function test_KeyIdIsAppendixC() public {
        bytes memory pk = pkOf(N1);
        assertEq(keys.keyIdOf(pk), keccak256(abi.encode(keccak256("QUANLET_ML_DSA_44_FIPS204"), pk)));
        assertEq(keys.keyIdOf(pk), reg(N1));
    }

    function test_PreparedBlobMatchesRegisteredBlob() public {
        bytes memory pk = pkOf(N2);
        bytes memory blob = keys.preparedBlobOf(pk);
        bytes32 id = reg(N2);
        assertEq(keccak256(blob), keys.getRecord(id).blobHash);
        assertEq(keccak256(keys.getRecord(id).blob.code), keccak256(blob));
    }

    function test_PolicyAndTransferHashes() public {
        Policy memory p = flexible(0.1 ether, 0.05 ether, 10 days, 3_600, 0.001 ether);
        PersonalVaultV2 v = createVault(p);
        assertEq(v.policyHashOf(p), keccak256(abi.encode(p)));
        assertEq(v.policyHash(), keccak256(abi.encode(p)));
        assertEq(keccak256(abi.encode(v.getPolicy())), v.policyHash(), "getPolicy round-trips to the stored hash");
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_FAST, ETH, alice, 1 ether, relay, 2);
        assertEq(v.transferParamsHash(t), transferHash(t));
    }

    function test_FactoryViews() public {
        bytes32[5] memory ids = roleIds();
        Policy memory p = guarded();
        bytes32 ph = keccak256(abi.encode(p));
        assertEq(factory.configHash(ids, ph), keccak256(abi.encode(ids, factory.dependencyManifestHash(), ph)));
        address[] memory a = factory.supportedAssets();
        assertEq(a.length, 1);
        assertEq(a[0], ETH);
        address[] memory s = factory.codeStores();
        assertEq(s.length, 2);
        PersonalVaultV2 v = createVaultWith(factory, ids, [P, A, G1, G2, G3], p, keccak256("views"));
        assertEq(address(v), factory.predictAddress(ids, p, keccak256("views")));
        address[] memory va = v.supportedAssets();
        assertEq(va.length, 1);
        assertEq(va[0], ETH);
    }
}
