// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MLDSA44Verifier} from "../src/verifier/MLDSA44Verifier.sol";
import {IMLDSAVerifier} from "../src/verifier/IMLDSAVerifier.sol";
import {KeyFactoryV2} from "../src/v2/KeyFactoryV2.sol";
import {VaultFactoryV2} from "../src/v2/VaultFactoryV2.sol";

/// Deploys protocol 2.0 next to the existing 1.x deployment: KeyFactoryV2, the vault code stores and
/// VaultFactoryV2 (ETH only). The F1600 helper and ML-DSA-44 verifier from deployments/<chainId>.json are
/// reused when their code hashes match what this build expects; otherwise fresh ones are deployed.
/// Nothing deployed here has an owner or an upgrade path, so the deployer key holds no power afterwards.
///
///   FOUNDRY_PROFILE=deploy forge script script/DeployV2.s.sol --rpc-url robinhood_testnet --broadcast
///
/// Reads DEPLOYER_PRIVATE_KEY from the environment. Writes deployments/<chainId>.v2.json.
/// Mainnet (4663) refuses to run unless QUANLET_MAINNET_GO=I_ACCEPT_THE_MAINNET_GATES is set.
contract DeployV2 is Script {
    uint256 constant MAINNET = 4663;
    uint256 constant STORE_CHUNK = 24_000; // each store's runtime is 0x00 ++ chunk, under the 24,576-byte limit

    function run() external {
        if (block.chainid == MAINNET) {
            require(
                keccak256(bytes(vm.envOr("QUANLET_MAINNET_GO", string("")))) == keccak256("I_ACCEPT_THE_MAINNET_GATES"),
                "mainnet gates not cleared"
            );
        }
        bytes memory helperRuntime = vm.parseBytes(string.concat("0x", _trim(vm.readFile("helpers/f1600_170.hex"))));
        (address helper, address verifier) = _existing(keccak256(helperRuntime));

        bytes memory code = vm.getCode("PersonalVaultV2.sol:PersonalVaultV2");
        uint256 n = (code.length + STORE_CHUNK - 1) / STORE_CHUNK;
        require(n <= 4, "vault code too large");
        address[] memory assets = new address[](1); // ETH only

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        if (helper == address(0)) helper = _deployRaw(helperRuntime);
        if (verifier == address(0)) verifier = address(new MLDSA44Verifier(helper));
        KeyFactoryV2 keys = new KeyFactoryV2(IMLDSAVerifier(verifier), helper);
        address[] memory stores = new address[](n);
        for (uint256 i; i < n; ++i) {
            uint256 to = (i + 1) * STORE_CHUNK < code.length ? (i + 1) * STORE_CHUNK : code.length;
            stores[i] = _deployRaw(abi.encodePacked(hex"00", _slice(code, i * STORE_CHUNK, to)));
        }
        VaultFactoryV2 factory = new VaultFactoryV2(keys, stores, keccak256(code), assets);
        vm.stopBroadcast();

        require(helper.codehash == keccak256(helperRuntime), "helper code mismatch");
        require(keys.verifierCodehash() == verifier.codehash, "verifier hash mismatch");
        require(factory.vaultCreationCodeHash() == keccak256(code), "creation code mismatch");

        string memory k = "manifestV2";
        vm.serializeUint(k, "protocolVersion", 2);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "f1600Helper", helper);
        vm.serializeAddress(k, "verifier", verifier);
        vm.serializeBytes32(k, "verifierCodehash", verifier.codehash);
        vm.serializeAddress(k, "keyFactoryV2", address(keys));
        vm.serializeBytes32(k, "keyFactoryV2Codehash", address(keys).codehash);
        vm.serializeAddress(k, "vaultCodeStores", stores);
        vm.serializeBytes32(k, "vaultCreationCodeHash", keccak256(code));
        vm.serializeAddress(k, "supportedAssets", assets);
        vm.serializeBytes32(k, "dependencyManifestHash", factory.dependencyManifestHash());
        string memory json = vm.serializeAddress(k, "vaultFactoryV2", address(factory));

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".v2.json");
        vm.writeJson(json, path);
        console2.log("manifest written to", path);
        console2.log("KeyFactoryV2  ", address(keys));
        console2.log("VaultFactoryV2", address(factory));
    }

    /// Helper and verifier from the 1.x manifest, if present on this chain with the expected code.
    function _existing(bytes32 helperHash) internal view returns (address helper, address verifier) {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) return (address(0), address(0));
        string memory j = vm.readFile(path);
        address h = vm.parseJsonAddress(j, ".f1600Helper");
        address v = vm.parseJsonAddress(j, ".verifier");
        if (h.codehash != helperHash) return (address(0), address(0));
        helper = h;
        // The verifier's runtime embeds the helper address as an immutable; a fresh local build pins it.
        if (v.code.length != 0 && v.codehash == vm.parseJsonBytes32(j, ".verifierCodehash")) verifier = v;
        console2.log("reusing helper  ", helper);
        if (verifier != address(0)) console2.log("reusing verifier", verifier);
    }

    function _deployRaw(bytes memory runtime) internal returns (address a) {
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), "raw deploy failed");
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        while (n > 0 && (b[n - 1] == 0x0a || b[n - 1] == 0x0d || b[n - 1] == 0x20)) n--;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }
}
