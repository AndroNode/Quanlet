// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseV2} from "./BaseV2.t.sol";
import {PersonalVaultV2} from "../../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy} from "../../src/v2/QuanletV2.sol";

/// Execution gas of each protocol 2.0 operation (section 15 benchmarks), written to deployments/gas-foundry-v2.json.
contract GasV2Test is BaseV2 {
    string internal json;

    function _rec(string memory k, uint256 g) internal {
        json = vm.serializeUint("gas", k, g);
    }

    function test_GasReportV2() public {
        uint256 g = gasleft();
        bytes32 id = keys.registerKey(pkOf(N1));
        _rec("registerKey", g - gasleft());
        uint64 a = uint64(block.timestamp);
        bytes memory pop = sign(N1, keys.registrationDigest(id, a, a + 600));
        g = gasleft();
        keys.activateKey(id, a, a + 600, pop);
        _rec("activateKey", g - gasleft());

        bytes32[5] memory ids = roleIds();
        Policy memory p = flexible(0.10 ether, 0.05 ether, 20 days, 0, 0.002 ether);
        bytes32 salt = keccak256("gas");
        bytes32 d = factory.setupDigest(ids, p, salt, a, a + 600);
        bytes[5] memory sigs = [sign(P, d), sign(A, d), sign(G1, d), sign(G2, d), sign(G3, d)];
        g = gasleft();
        PersonalVaultV2 v = PersonalVaultV2(payable(factory.createVaultV2(ids, p, salt, a, a + 600, sigs)));
        _rec("createVaultV2_fiveConsents", g - gasleft());
        vm.deal(address(v), 10 ether);

        (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, relay, 0.001 ether);
        g = gasleft();
        v.submitTransfer(ft, fw, fs, "");
        _rec("fastTransfer_oneSignature", g - gasleft());

        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, bob, 1 ether, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        bytes memory as_ = sign(A, d);
        g = gasleft();
        v.submitTransfer(t, w, ps, as_);
        _rec("protectedTransfer_twoSignatures", g - gasleft());

        // Policy update (delay 0: applies at once) electing a 24-hour delay.
        Policy memory p2 = flexible(0.10 ether, 0.05 ether, 20 days, 86_400, 0.002 ether);
        w = win();
        (ps, as_,) = pairSigs(v, P, A, C.A_UPDATE_POLICY, keccak256(abi.encode(keccak256(abi.encode(p2)))), w);
        g = gasleft();
        v.updatePolicy(p2, w, ps, as_);
        _rec("updatePolicy_immediate", g - gasleft());

        t = xfer(C.ROUTE_PROTECTED, ETH, bob, 1 ether, relay, 0.001 ether);
        w = win();
        d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        ps = sign(P, d);
        as_ = sign(A, d);
        g = gasleft();
        bytes32 qid = v.submitTransfer(t, w, ps, as_);
        _rec("protectedTransfer_queue", g - gasleft());
        vm.warp(block.timestamp + 1 days);
        g = gasleft();
        v.executeWithdrawal(qid);
        _rec("executeWithdrawal", g - gasleft());

        // Guardian replacement: P + A + two guardians + three consents (seven signature checks).
        bytes32[3] memory ng = [reg(N2), reg(N3), reg(G3)];
        w = win();
        (PersonalVaultV2.GuardianSigs memory gs, bytes32 gd) = guardianSigs(v, 0, 1, C.A_REPLACE_GUARDIANS, keccak256(abi.encode(ng)), w);
        bytes[3] memory consents = [sign(N2, v.consentDigest(gd, 3, ng[0])), sign(N3, v.consentDigest(gd, 4, ng[1])), sign(G3, v.consentDigest(gd, 5, ng[2]))];
        ps = sign(P, gd);
        as_ = sign(A, gd);
        g = gasleft();
        v.replaceGuardians(ng, w, ps, as_, gs, consents);
        _rec("replaceGuardians_sevenSignatures", g - gasleft());
        vm.warp(block.timestamp + 7 days);
        g = gasleft();
        v.finalizeSecurityChange("");
        _rec("finalizeGuardians", g - gasleft());

        // Recovery start: two guardians + two consents.
        bytes32 np = reg(bytes32(uint256(0x6004)));
        bytes32 na = reg(bytes32(uint256(0x6005)));
        w = win();
        bytes32[3] memory cur = [bytes32(uint256(0x6002)), bytes32(uint256(0x6003)), G3];
        d = digestOf(v, C.A_START_RECOVERY, C.LANE_RECOVERY, keccak256(abi.encode(np, na)), w);
        gs.idx = [0, 1];
        gs.sigs = [sign(cur[0], d), sign(cur[1], d)];
        bytes memory c1 = sign(bytes32(uint256(0x6004)), v.consentDigest(d, C.ROLE_P, np));
        bytes memory c2 = sign(bytes32(uint256(0x6005)), v.consentDigest(d, C.ROLE_A, na));
        g = gasleft();
        v.startRecovery(np, na, w, gs, c1, c2);
        _rec("startRecovery_fourSignatures", g - gasleft());
        vm.warp(block.timestamp + 7 days);
        g = gasleft();
        v.finalizeSecurityChange("");
        _rec("finalizeRecovery", g - gasleft());

        vm.writeJson(json, "./deployments/gas-foundry-v2.json");
    }
}
