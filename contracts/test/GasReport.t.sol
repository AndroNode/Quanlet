// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {PersonalVault} from "../src/PersonalVault.sol";
import {QuanletConstants as C} from "../src/QuanletConstants.sol";

/// Measures every operation in Foundry's EVM (whitepaper section 14 gas tests) and writes
/// deployments/gas-foundry.json for the release manifest. Execution gas is measured around the call;
/// calldata bytes are the exact ABI encoding; intrinsic21k + calldata cost is added as an estimate of the
/// full L2 transaction gas. Live chain fees come from receipts (cli/scripts/manifest.mjs --cost).
contract GasReport is Base {
    string internal constant K = "gas";
    string internal json;

    function _cd(bytes memory data) internal pure returns (uint256 c) {
        for (uint256 i; i < data.length; ++i) c += data[i] == 0 ? 4 : 16;
    }

    function _record(string memory name, uint256 execGas, bytes memory data) internal {
        string memory o = name;
        vm.serializeUint(o, "executionGas", execGas);
        vm.serializeUint(o, "calldataBytes", data.length);
        string memory r = vm.serializeUint(o, "estimatedTxGas", execGas + 21_000 + _cd(data));
        json = vm.serializeString(K, name, r);
        emit log_named_uint(name, execGas);
    }

    function _call(string memory name, address to, bytes memory data) internal returns (bytes memory ret) {
        uint256 g = gasleft();
        bool ok;
        (ok, ret) = to.call(data);
        uint256 used = g - gasleft();
        require(ok, name);
        _record(name, used, data);
    }

    function test_WriteGasReport() public {
        // key registration (on-chain preparation + blob publication + proof of possession)
        bytes32[8] memory seeds = [P1, R1, R2, R3, N1, N2, N3, bytes32(uint256(0x4001))];
        bytes32[8] memory recs;
        for (uint256 i; i < 8; ++i) {
            bytes memory pk = pkOf(seeds[i]);
            bytes memory pop = sign(seeds[i], keys.popMessage(keys.keyIdOf(pk), keccak256(blobOf(pk))));
            bytes memory ret = _call(i == 0 ? "registerKey" : string.concat("registerKey#", vm.toString(i)), address(keys), abi.encodeCall(keys.registerKey, (pk, pop)));
            recs[i] = abi.decode(ret, (bytes32));
            recordOf[seeds[i]] = recs[i];
        }

        // vault creation
        bytes32[3] memory rr = [recs[1], recs[2], recs[3]];
        uint64 a = uint64(vm.getBlockTimestamp());
        bytes32 salt = keccak256("gas");
        bytes memory setupSig = sign(P1, factory.setupDigest(recs[0], rr, salt, a, a + 600));
        bytes memory ret = _call("createVault", address(factory), abi.encodeCall(factory.createVault, (recs[0], rr, salt, a, a + 600, setupSig)));
        PersonalVault v = PersonalVault(payable(abi.decode(ret, (address))));
        vm.deal(address(v), 10 ether);

        // withdrawals
        bytes32 ph = v.withdrawalParamsHash(address(0), address(0xBEEF), 1 ether, address(0), 0);
        PersonalVault.Auth memory au = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph);
        ret = _call("scheduleWithdrawal", address(v), abi.encodeCall(v.scheduleWithdrawal, (address(0), address(0xBEEF), 1 ether, address(0), 0, au)));
        bytes32 id = abi.decode(ret, (bytes32));
        bytes32 ph2 = v.withdrawalParamsHash(address(0), address(0xBEEF), 2 ether, address(0xFEE), 0.001 ether);
        au = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph2);
        ret = _call("scheduleWithdrawal (with relay fee)", address(v), abi.encodeCall(v.scheduleWithdrawal, (address(0), address(0xBEEF), 2 ether, address(0xFEE), 0.001 ether, au)));
        bytes32 id2 = abi.decode(ret, (bytes32));

        // an adversarially invalid signature: the full verification still runs before the revert
        PersonalVault.Auth memory bad = primaryAuth(v, R1, C.ACTION_SCHEDULE, ph);
        bytes memory badCall = abi.encodeCall(v.scheduleWithdrawal, (address(0), address(0xBEEF), 1 ether, address(0), 0, bad));
        uint256 g = gasleft();
        (bool okBad,) = address(v).call(badCall);
        uint256 usedBad = g - gasleft();
        require(!okBad, "bad signature accepted");
        _record("scheduleWithdrawal rejected (wrong key)", usedBad, badCall);

        _call("cancelWithdrawal", address(v), abi.encodeCall(v.cancelWithdrawal, (id2, primaryAuth(v, P1, C.ACTION_CANCEL, keccak256(abi.encode(id2))))));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _call("executeWithdrawal (ETH)", address(v), abi.encodeCall(v.executeWithdrawal, (id)));
        _call(
            "invalidatePendingRequests",
            address(v),
            abi.encodeCall(v.invalidatePendingRequests, (primaryAuth(v, P1, C.ACTION_INVALIDATE, keccak256(abi.encode(v.executionEpoch())))))
        );

        // recovery: two signatures
        PersonalVault.QuorumAuth memory q = quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, v.recoveryParamsHash(kid(recs[4])));
        _call("startRecovery (2 signatures)", address(v), abi.encodeCall(v.startRecovery, (recs[4], q)));
        bytes32 pid = v.proposal().id;
        q = quorumAuth(v, R2, 1, R3, 2, C.ACTION_CANCEL_SECURITY, keccak256(abi.encode(pid)));
        _call("cancelSecurityChange (2 signatures)", address(v), abi.encodeCall(v.cancelSecurityChange, (q)));
        q = quorumAuth(v, R1, 0, R3, 2, C.ACTION_RECOVERY, v.recoveryParamsHash(kid(recs[4])));
        _call("startRecovery (again)", address(v), abi.encodeCall(v.startRecovery, (recs[4], q)));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _call("finalizeSecurityChange (primary)", address(v), abi.encodeCall(v.finalizeSecurityChange, ()));

        // recovery-set replacement: three signatures over one digest
        bytes32[3] memory nrs = [recs[5], recs[6], recs[7]];
        bytes32 sph = v.recoverySetParamsHash([kid(nrs[0]), kid(nrs[1]), kid(nrs[2])]);
        PersonalVault.QuorumAuth memory sq = quorumAuth(v, R1, 0, R2, 1, C.ACTION_REPLACE_RECOVERY_SET, sph);
        PersonalVault.Auth memory pa;
        pa.validAfter = sq.validAfter;
        pa.validUntil = sq.validUntil;
        pa.sig = sign(N1, v.actionDigest(C.ACTION_REPLACE_RECOVERY_SET, v.controlNonce(), sph, sq.validAfter, sq.validUntil));
        _call("startRecoverySetReplacement (3 signatures)", address(v), abi.encodeCall(v.startRecoverySetReplacement, (nrs, pa, sq)));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _call("finalizeSecurityChange (recovery set)", address(v), abi.encodeCall(v.finalizeSecurityChange, ()));

        vm.writeJson(json, "deployments/gas-foundry.json");
    }
}
