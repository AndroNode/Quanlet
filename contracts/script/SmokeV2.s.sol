// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {KeyFactoryV2} from "../src/v2/KeyFactoryV2.sol";
import {VaultFactoryV2} from "../src/v2/VaultFactoryV2.sol";
import {PersonalVaultV2} from "../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy, AssetRule} from "../src/v2/QuanletV2.sol";

/// Protocol 2.0 Gate B smoke test on a live chain, with real ML-DSA-44 keys and signatures (signed via FFI):
/// register and activate five keys (P, A, G1-G3), create a vault from five setup consents, fund it with a tiny
/// amount, then send one FAST transfer (P only, inside the granted allowance) and one PROTECTED transfer (P + A),
/// and check that a primary-only PROTECTED attempt and an over-allowance FAST attempt are refused.
///
///   FOUNDRY_PROFILE=deploy forge script script/SmokeV2.s.sol --rpc-url robinhood_testnet --broadcast
///
/// Reads DEPLOYER_PRIVATE_KEY. Key seeds are derived from it and never printed, so only the deployer can
/// control the smoke vault. Refuses to run on mainnet. Writes deployments/<chainId>.v2.gate-b.json.
contract SmokeV2 is Script {
    uint256 constant FUND = 0.0004 ether;
    uint256 constant STEP = 0.0001 ether;

    KeyFactoryV2 keys;
    VaultFactoryV2 factory;
    uint256 pk;

    function run() external {
        require(block.chainid != 4663, "smoke test is testnet only");
        string memory j = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".v2.json"));
        keys = KeyFactoryV2(vm.parseJsonAddress(j, ".keyFactoryV2"));
        factory = VaultFactoryV2(vm.parseJsonAddress(j, ".vaultFactoryV2"));
        pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address payable me = payable(vm.addr(pk));
        uint256 run_ = vm.envOr("QUANLET_SMOKE_RUN", uint256(block.timestamp));

        bytes32[5] memory seeds;
        bytes32[5] memory ids;
        for (uint256 i; i < 5; ++i) {
            seeds[i] = keccak256(abi.encode(pk, "quanlet-smoke-v2", run_, i));
        }

        vm.startBroadcast(pk);
        for (uint256 i; i < 5; ++i) {
            ids[i] = _register(seeds[i]);
        }

        // Policy: no delay, FAST on for ETH with a 0.0001 ETH lifetime allowance, recipient = the deployer.
        Policy memory p;
        p.fastEnabled = true;
        p.resumeFast = true;
        p.fastFeeRecipients = new address[](0);
        p.assetRules = new AssetRule[](1);
        address[] memory rec = new address[](1);
        rec[0] = me;
        p.assetRules[0] = AssetRule(address(0), STEP, STEP, uint64(block.timestamp), uint64(block.timestamp) + 30 days, rec);

        bytes32 salt = keccak256(abi.encode("quanlet-smoke-v2", run_));
        uint64 a = uint64(block.timestamp);
        bytes32 d = factory.setupDigest(ids, p, salt, a, a + 900);
        bytes[5] memory sigs;
        for (uint256 i; i < 5; ++i) {
            sigs[i] = _sign(seeds[i], d);
        }
        PersonalVaultV2 v = PersonalVaultV2(payable(factory.createVaultV2(ids, p, salt, a, a + 900, sigs)));
        (bool ok,) = address(v).call{value: FUND}("");
        require(ok, "fund failed");

        // FAST: P alone, inside the allowance.
        PersonalVaultV2.Transfer memory t = PersonalVaultV2.Transfer(C.ROUTE_FAST, address(0), me, STEP, address(0), 0);
        PersonalVaultV2.Window memory w = _win();
        v.submitTransfer(t, w, _sign(seeds[0], _digest(v, t, w)), "");

        // PROTECTED: P + A, delay 0, executes at once.
        t.route = C.ROUTE_PROTECTED;
        w = _win();
        d = _digest(v, t, w);
        v.submitTransfer(t, w, _sign(seeds[0], d), _sign(seeds[1], d));
        vm.stopBroadcast();

        // Refusals (simulated only, never broadcast).
        bool fastOver = _tries(v, C.ROUTE_FAST, seeds[0]);
        bool primaryOnlyProtected = _tries(v, C.ROUTE_PROTECTED, seeds[0]);
        require(!fastOver, "FAST over allowance was accepted");
        require(!primaryOnlyProtected, "primary-only PROTECTED was accepted");
        require(address(v).balance == FUND - 2 * STEP, "balance");
        require(v.spent(address(0)) == STEP, "lifetime debit");

        string memory k = "gateBv2";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "vault", address(v));
        vm.serializeBytes32(k, "policyHash", keccak256(abi.encode(p)));
        vm.serializeUint(k, "fundedWei", FUND);
        vm.serializeUint(k, "fastTransferWei", STEP);
        vm.serializeUint(k, "protectedTransferWei", STEP);
        vm.serializeBool(k, "fastOverAllowanceRefused", true);
        vm.serializeBool(k, "primaryOnlyProtectedRefused", true);
        string memory json = vm.serializeUint(k, "vaultBalanceAfterWei", address(v).balance);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".v2.gate-b.json"));
        console2.log("smoke vault", address(v));
    }

    function _register(bytes32 seed) internal returns (bytes32 id) {
        id = keys.registerKey(_pk(seed));
        uint64 a = uint64(block.timestamp);
        keys.activateKey(id, a, a + 900, _sign(seed, keys.registrationDigest(id, a, a + 900)));
    }

    function _tries(PersonalVaultV2 v, uint8 route, bytes32 seed) internal returns (bool accepted) {
        PersonalVaultV2.Transfer memory t = PersonalVaultV2.Transfer(route, address(0), vm.addr(pk), STEP, address(0), 0);
        PersonalVaultV2.Window memory w = _win();
        bytes memory s = _sign(seed, _digest(v, t, w));
        try v.submitTransfer(t, w, s, "") {
            accepted = true;
        } catch {}
    }

    function _win() internal view returns (PersonalVaultV2.Window memory w) {
        w.validAfter = uint64(block.timestamp);
        w.validUntil = w.validAfter + 900;
    }

    function _digest(PersonalVaultV2 v, PersonalVaultV2.Transfer memory t, PersonalVaultV2.Window memory w) internal view returns (bytes32) {
        bytes32 h = keccak256(abi.encode(t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei));
        return v.actionDigest(C.A_TRANSFER, C.LANE_SPEND, v.nonceOf(C.LANE_SPEND), h, w.validAfter, w.validUntil);
    }

    function _pk(bytes32 seed) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "pk";
        cmd[3] = vm.toString(seed);
        return vm.ffi(cmd);
    }

    function _sign(bytes32 seed, bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(seed);
        cmd[4] = vm.toString(abi.encodePacked(digest));
        return vm.ffi(cmd);
    }
}
