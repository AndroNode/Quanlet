// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {KeyFactory} from "../src/KeyFactory.sol";
import {IMLDSAVerifier} from "../src/verifier/IMLDSAVerifier.sol";

/// Gate B: proves the ML-DSA-44 verifier runs correctly on the live chain, not just in Foundry's EVM.
///  1. registers a throwaway smoke-test key (the registration tx itself verifies a proof of possession
///     on-chain, so a successful receipt is already a pass), then
///  2. asks the chain's own node (eth_call over RPC) to verify a fresh signature (must be true) and a
///     tampered one (must be false).
///
///   FOUNDRY_PROFILE=deploy forge script script/Smoke.s.sol --rpc-url robinhood_testnet --broadcast   # registers
///   FOUNDRY_PROFILE=deploy forge script script/Smoke.s.sol --rpc-url robinhood_testnet               # verifies
///
/// The smoke key's seed is public on purpose. It never guards anything.
contract Smoke is Script {
    bytes32 constant SMOKE_SEED = keccak256("QUANLET_PUBLIC_SMOKE_TEST_KEY_DO_NOT_USE");

    function run() external {
        string memory manifest = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        KeyFactory keys = KeyFactory(vm.parseJsonAddress(manifest, ".keyFactory"));
        address verifier = address(keys.verifier());

        bytes memory pk = _ffi3("node", "test/ffi/mldsa.mjs", "pk", vm.toString(SMOKE_SEED));
        bytes memory blob = _ffiBlob(pk);
        bytes32 keyId = keys.keyIdOf(pk);
        bytes32 blobHash = keccak256(blob);
        bytes32 recordId = keys.recordIdOf(keyId, blobHash);

        if (!keys.getRecord(recordId).ready) {
            bytes memory pop = _sign(keys.popMessage(keyId, blobHash));
            uint256 pkey = vm.envUint("DEPLOYER_PRIVATE_KEY");
            vm.broadcast(pkey);
            keys.registerKey(pk, pop);
            // Broadcasts are sent after the script finishes, so the chain cannot see this key yet.
            console2.log("Smoke key registered (on-chain proof-of-possession check). Run again without --broadcast to finish.");
            return;
        }
        address blobAddr = keys.getRecord(recordId).blob;
        console2.log("smoke key blob", blobAddr);

        bytes32 message = keccak256(abi.encode("quanlet smoke", block.number));
        bytes memory sig = _sign(message);
        require(_remoteVerify(verifier, blobAddr, message, sig), "GATE B FAIL: valid signature rejected on chain");

        sig[100] = bytes1(uint8(sig[100]) ^ 0x01);
        require(!_remoteVerify(verifier, blobAddr, message, sig), "GATE B FAIL: tampered signature accepted on chain");
        console2.log("GATE B PASS: verifier accepts valid and rejects tampered signatures on chain", block.chainid);

        // Recorded for the release manifest (cli/scripts/manifest.mjs).
        string memory k = "gateB";
        vm.serializeString(k, "status", "pass");
        vm.serializeString(k, "method", "smoke key registered through KeyFactory (on-chain proof-of-possession check); chain node eth_call accepts a fresh signature and rejects a one-bit tamper");
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "checkedAtBlock", block.number);
        vm.serializeUint(k, "checkedAtTimestamp", block.timestamp);
        vm.serializeAddress(k, "keyFactory", address(keys));
        vm.serializeAddress(k, "verifier", verifier);
        vm.serializeBytes32(k, "smokeRecordId", recordId);
        string memory json = vm.serializeAddress(k, "smokeBlob", blobAddr);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".gate-b.json"));
    }

    /// eth_call executed by the chain's node, not by Foundry.
    function _remoteVerify(address verifier, address blob, bytes32 message, bytes memory sig) internal returns (bool) {
        bytes memory data = abi.encodeCall(IMLDSAVerifier.verify, (blob, abi.encodePacked(message), sig));
        string memory params =
            string.concat('[{"to":"', vm.toString(verifier), '","data":"', vm.toString(data), '","gas":"0x1c9c380"},"latest"]');
        bytes memory ret = vm.rpc("eth_call", params);
        return ret.length == 32 && abi.decode(ret, (bool));
    }

    function _sign(bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(SMOKE_SEED);
        cmd[4] = vm.toString(abi.encodePacked(digest));
        return vm.ffi(cmd);
    }

    function _ffiBlob(bytes memory pk) internal returns (bytes memory) {
        string[] memory cmd = new string[](3);
        cmd[0] = "sh";
        cmd[1] = "test/ffi/blob.sh";
        cmd[2] = vm.toString(pk);
        return vm.ffi(cmd);
    }

    function _ffi3(string memory a, string memory b, string memory c, string memory d) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = a;
        cmd[1] = b;
        cmd[2] = c;
        cmd[3] = d;
        return vm.ffi(cmd);
    }
}
