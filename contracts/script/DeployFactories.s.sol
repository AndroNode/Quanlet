// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IMLDSAVerifier} from "../src/verifier/IMLDSAVerifier.sol";
import {KeyFactory} from "../src/KeyFactory.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys a new KeyFactory (on-chain key preparation) and VaultFactory next to the F1600 helper and
/// ML-DSA-44 verifier already listed in deployments/<chainId>.json. The helper and verifier are reused
/// as they are: both are immutable and bound by code hash, so redeploying them would change nothing.
///
///   FOUNDRY_PROFILE=deploy forge script script/DeployFactories.s.sol --rpc-url robinhood_testnet --broadcast
///
/// REUSE_KEY_FACTORY=true keeps the listed KeyFactory (and every key record on it) and deploys only a new
/// VaultFactory, for a PersonalVault change that leaves key preparation alone. The replaced VaultFactory is
/// then appended to compatibleVaultFactories: its vaults keep working and their key files stay valid.
///
/// Reads DEPLOYER_PRIVATE_KEY from the environment. Rewrites deployments/<chainId>.json and keeps the
/// replaced factory addresses as previousKeyFactory and previousVaultFactory. Refuses mainnet (4663) until an external audit clears it.
contract DeployFactories is Script {
    function run() external {
        require(block.chainid != 4663, "mainnet gates not cleared");
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory old = vm.readFile(path);
        address helper = vm.parseJsonAddress(old, ".f1600Helper");
        address verifier = vm.parseJsonAddress(old, ".verifier");
        bytes32 verifierCodehash = vm.parseJsonBytes32(old, ".verifierCodehash");
        address oldKeys = vm.parseJsonAddress(old, ".keyFactory");
        address oldVaults = vm.parseJsonAddress(old, ".vaultFactory");

        require(helper.codehash == 0x4afb4435879cdf8e50474c7aab2bc3a679caed432550ad6dba64f509309a817b, "helper code mismatch");
        require(verifier.codehash == verifierCodehash, "verifier code mismatch");

        bool reuseKeys = vm.envOr("REUSE_KEY_FACTORY", false);
        address prevKeys = oldKeys;
        address[] memory compatible = new address[](0);
        if (reuseKeys) {
            // The previous KeyFactory recorded in the old manifest stays the previous one.
            prevKeys = vm.keyExistsJson(old, ".previousKeyFactory") ? vm.parseJsonAddress(old, ".previousKeyFactory") : address(0);
            address[] memory before = vm.keyExistsJson(old, ".compatibleVaultFactories")
                ? vm.parseJsonAddressArray(old, ".compatibleVaultFactories")
                : new address[](0);
            compatible = new address[](before.length + 1);
            for (uint256 i; i < before.length; ++i) compatible[i] = before[i];
            compatible[before.length] = oldVaults;
            require(KeyFactory(oldKeys).f1600Helper() == helper, "listed KeyFactory uses another helper");
            require(KeyFactory(oldKeys).verifierCodehash() == verifierCodehash, "listed KeyFactory uses another verifier");
        }

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        KeyFactory keys = reuseKeys ? KeyFactory(oldKeys) : new KeyFactory(IMLDSAVerifier(verifier), helper);
        VaultFactory factory = new VaultFactory(keys);
        vm.stopBroadcast();

        require(keys.verifierCodehash() == verifierCodehash, "verifier hash mismatch");
        require(keys.f1600Helper() == helper, "helper mismatch");

        string memory k = "manifest";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "f1600Helper", helper);
        vm.serializeAddress(k, "verifier", verifier);
        vm.serializeBytes32(k, "verifierCodehash", verifierCodehash);
        vm.serializeUint(k, "keyPreparation", keys.PREPARATION_VERSION());
        vm.serializeAddress(k, "previousKeyFactory", prevKeys);
        vm.serializeAddress(k, "compatibleVaultFactories", compatible);
        vm.serializeAddress(k, "previousVaultFactory", oldVaults);
        vm.serializeAddress(k, "keyFactory", address(keys));
        string memory json = vm.serializeAddress(k, "vaultFactory", address(factory));
        vm.writeJson(json, path);
        console2.log("manifest written to", path);
        console2.log("KeyFactory  ", address(keys));
        console2.log("VaultFactory", address(factory));
    }
}
