// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MLDSA44Verifier} from "../src/verifier/MLDSA44Verifier.sol";
import {IMLDSAVerifier} from "../src/verifier/IMLDSAVerifier.sol";
import {KeyFactory} from "../src/KeyFactory.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys the Quanlet protocol: F1600 helper, ML-DSA-44 verifier, KeyFactory, VaultFactory.
/// Nothing deployed here has an owner or an upgrade path, so the deployer key holds no power afterwards.
///
///   FOUNDRY_PROFILE=deploy forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
///
/// Reads DEPLOYER_PRIVATE_KEY from the environment. Writes deployments/<chainId>.json.
/// Mainnet (4663) refuses to run unless QUANLET_MAINNET_GO=I_ACCEPT_THE_MAINNET_GATES is set,
/// because an external audit is still an open mainnet gate.
contract Deploy is Script {
    uint256 constant TESTNET = 46630;
    uint256 constant MAINNET = 4663;

    function run() external {
        if (block.chainid == MAINNET) {
            require(
                keccak256(bytes(vm.envOr("QUANLET_MAINNET_GO", string("")))) == keccak256("I_ACCEPT_THE_MAINNET_GATES"),
                "mainnet gates not cleared"
            );
        }

        bytes memory helperRuntime = vm.parseBytes(string.concat("0x", _trim(vm.readFile("helpers/f1600_170.hex"))));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        address helper = _deployRaw(helperRuntime);
        MLDSA44Verifier verifier = new MLDSA44Verifier(helper);
        KeyFactory keys = new KeyFactory(IMLDSAVerifier(address(verifier)), helper);
        VaultFactory factory = new VaultFactory(keys);
        vm.stopBroadcast();

        require(helper.codehash == keccak256(helperRuntime), "helper code mismatch");
        require(keys.verifierCodehash() == address(verifier).codehash, "verifier hash mismatch");

        string memory k = "manifest";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "f1600Helper", helper);
        vm.serializeAddress(k, "verifier", address(verifier));
        vm.serializeBytes32(k, "verifierCodehash", address(verifier).codehash);
        vm.serializeAddress(k, "keyFactory", address(keys));
        string memory json = vm.serializeAddress(k, "vaultFactory", address(factory));

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("manifest written to", path);
        console2.log("KeyFactory  ", address(keys));
        console2.log("VaultFactory", address(factory));
    }

    function _deployRaw(bytes memory runtime) internal returns (address a) {
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), "helper deploy failed");
    }

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        while (n > 0 && (b[n - 1] == 0x0a || b[n - 1] == 0x0d || b[n - 1] == 0x20)) n--;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = b[i];
        return string(out);
    }
}
