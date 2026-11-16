// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {KeyFactoryV2} from "../src/v2/KeyFactoryV2.sol";
import {VaultFactoryV2} from "../src/v2/VaultFactoryV2.sol";

/// Deploys one more VaultFactoryV2 next to an existing protocol 2.0 deployment, with a different supported-asset
/// set. It reuses that deployment's KeyFactoryV2 (so registered keys work in both) and its vault code stores
/// (so vaults are byte-identical); only the asset list differs. No owner, no upgrade path.
///
///   QUANLET_V2_ASSETS=0x...,0x... QUANLET_V2_LABEL=tokens \
///   FOUNDRY_PROFILE=deploy forge script script/DeployFactoryV2Assets.s.sol --rpc-url robinhood_testnet --broadcast
///
/// Reads DEPLOYER_PRIVATE_KEY and deployments/<chainId>.v2.json; writes
/// deployments/<chainId>.v2.<label>.json. ETH (address 0) is always included. Testnet only.
contract DeployFactoryV2Assets is Script {
    function run() external {
        require(block.chainid != 4663, "testnet only");
        string memory j = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".v2.json"));
        KeyFactoryV2 keys = KeyFactoryV2(vm.parseJsonAddress(j, ".keyFactoryV2"));
        address[] memory stores = vm.parseJsonAddressArray(j, ".vaultCodeStores");
        bytes32 codeHash = vm.parseJsonBytes32(j, ".vaultCreationCodeHash");
        address[] memory extra = vm.envAddress("QUANLET_V2_ASSETS", ",");
        string memory label = vm.envString("QUANLET_V2_LABEL");

        address[] memory assets = new address[](extra.length + 1); // ETH first, then ascending
        for (uint256 i; i < extra.length; ++i) {
            assets[i + 1] = extra[i];
            require(extra[i].code.length != 0, "asset has no code");
        }
        for (uint256 i = 1; i < assets.length; ++i) {
            for (uint256 k = i; k > 1 && assets[k] < assets[k - 1]; --k) {
                (assets[k], assets[k - 1]) = (assets[k - 1], assets[k]);
            }
        }

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        VaultFactoryV2 factory = new VaultFactoryV2(keys, stores, codeHash, assets);
        vm.stopBroadcast();
        require(factory.vaultCreationCodeHash() == codeHash, "creation code mismatch");

        string memory k = "factoryV2";
        vm.serializeUint(k, "protocolVersion", 2);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "keyFactoryV2", address(keys));
        vm.serializeAddress(k, "vaultCodeStores", stores);
        vm.serializeBytes32(k, "vaultCreationCodeHash", codeHash);
        vm.serializeAddress(k, "supportedAssets", assets);
        vm.serializeBytes32(k, "dependencyManifestHash", factory.dependencyManifestHash());
        string memory json = vm.serializeAddress(k, "vaultFactoryV2", address(factory));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".v2.", label, ".json");
        vm.writeJson(json, path);
        console2.log("VaultFactoryV2", address(factory));
        console2.log("manifest written to", path);
    }
}
