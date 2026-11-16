// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMLDSAVerifier} from "../verifier/IMLDSAVerifier.sol";
import {KeyFactoryV2} from "./KeyFactoryV2.sol";
import {QuanletV2 as C, Policy} from "./QuanletV2.sol";

/// @title VaultFactoryV2
/// @notice Deploys a fully configured PersonalVaultV2 at a deterministic CREATE2 address after all five role
///         keys (P, A, G1, G2, G3) sign the identical setup digest (whitepaper v2.0 section 06, Appendix E).
///         No uninitialized vault is ever exposed; a copied setup transaction can only deploy that same vault.
///
/// The vault's creation code is larger than one contract may hold, so it is kept in immutable data contracts
/// (`codeStores`, each runtime = 0x00 ++ chunk, read in order). Their code hashes and the hash of the whole
/// creation code are pinned at construction, together with the verifier, key factory, helper and
/// supported-asset set, in `dependencyManifestHash`. No admin; the factory cannot change a vault after deployment.
contract VaultFactoryV2 {
    KeyFactoryV2 public immutable keyFactory;
    bytes32 public immutable vaultCreationCodeHash;
    address[] private _stores;
    bytes32[] private _storeHashes;
    bytes32 public immutable dependencyManifestHash;
    address[] private _supported;

    event VaultCreated(address indexed vault, bytes32[5] roleIds, bytes32 policyHash, bytes32 salt);

    error BadInterval();
    error RequestNotAccepted();
    error BadSetupSignature();
    error AlreadyDeployed();
    error KeyNotReady();
    error DuplicateKey();
    error BadCodeStore();
    error BadAssets();

    constructor(KeyFactoryV2 keyFactory_, address[] memory codeStores, bytes32 expectedCreationCodeHash, address[] memory supportedAssets) {
        if (supportedAssets.length == 0 || supportedAssets.length > C.MAX_ASSETS) revert BadAssets();
        for (uint256 i; i < supportedAssets.length; ++i) {
            if (i > 0 && supportedAssets[i] <= supportedAssets[i - 1]) revert BadAssets();
            _supported.push(supportedAssets[i]);
        }
        keyFactory = keyFactory_;
        if (codeStores.length == 0 || codeStores.length > 4) revert BadCodeStore();
        for (uint256 i; i < codeStores.length; ++i) {
            _stores.push(codeStores[i]);
            _storeHashes.push(codeStores[i].codehash);
        }
        if (keccak256(_creationCode()) != expectedCreationCodeHash) revert BadCodeStore();
        vaultCreationCodeHash = expectedCreationCodeHash;
        IMLDSAVerifier v = keyFactory_.verifier();
        address helper = keyFactory_.f1600Helper();
        dependencyManifestHash = keccak256(
            abi.encode(
                C.PROTOCOL_VERSION,
                address(v),
                address(v).codehash,
                address(keyFactory_),
                address(keyFactory_).codehash,
                helper,
                helper.codehash,
                expectedCreationCodeHash,
                supportedAssets
            )
        );
    }

    function supportedAssets() external view returns (address[] memory) {
        return _supported;
    }

    function codeStores() external view returns (address[] memory) {
        return _stores;
    }

    /// @notice Appendix E: H(E(bytes32[5] roleIds, bytes32 dependencyManifestHash, bytes32 policyHash)).
    function configHash(bytes32[5] calldata roleIds, bytes32 policyHash) public view returns (bytes32) {
        return keccak256(abi.encode(roleIds, dependencyManifestHash, policyHash));
    }

    function predictAddress(bytes32[5] calldata roleIds, Policy calldata policy, bytes32 salt) public view returns (address) {
        bytes32 initHash = keccak256(_initCode(roleIds, policy));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    /// @notice Appendix E setup digest: the exact 32 bytes each of the five keys signs.
    function setupDigest(bytes32[5] calldata roleIds, Policy calldata policy, bytes32 salt, uint64 validAfter, uint64 validUntil)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                C.SETUP_DOMAIN,
                C.PROTOCOL_VERSION,
                block.chainid,
                address(this),
                salt,
                configHash(roleIds, keccak256(abi.encode(policy))),
                predictAddress(roleIds, policy, salt),
                validAfter,
                validUntil
            )
        );
    }

    /// @param sigs setup signatures in role order P, A, G1, G2, G3
    function createVaultV2(
        bytes32[5] calldata roleIds,
        Policy calldata policy,
        bytes32 salt,
        uint64 validAfter,
        uint64 validUntil,
        bytes[5] calldata sigs
    ) external returns (address vault) {
        if (validUntil <= validAfter || validUntil - validAfter > C.ACCEPTANCE_MAX) revert BadInterval();
        if (block.timestamp < validAfter || block.timestamp >= validUntil) revert RequestNotAccepted();
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < i; ++j) {
                if (roleIds[i] == roleIds[j]) revert DuplicateKey();
            }
        }
        bytes32 digest = setupDigest(roleIds, policy, salt, validAfter, validUntil);
        for (uint256 i; i < 5; ++i) {
            KeyFactoryV2.KeyRecord memory r = keyFactory.getRecord(roleIds[i]);
            if (!r.ready) revert KeyNotReady();
            if (!_verify(r, digest, sigs[i])) revert BadSetupSignature();
        }
        address expected = predictAddress(roleIds, policy, salt);
        if (expected.code.length != 0) revert AlreadyDeployed();
        bytes memory init = _initCode(roleIds, policy);
        assembly ("memory-safe") {
            vault := create2(0, add(init, 0x20), mload(init), salt)
        }
        if (vault != expected) revert AlreadyDeployed();
        emit VaultCreated(vault, roleIds, keccak256(abi.encode(policy)), salt);
    }

    // ---------------------------------------------------------------- internals

    function _initCode(bytes32[5] calldata roleIds, Policy calldata policy) internal view returns (bytes memory) {
        return abi.encodePacked(_creationCode(), abi.encode(keyFactory, roleIds, policy, _supported));
    }

    /// The pinned creation code, reassembled from the stores (each checked against its pinned code hash).
    function _creationCode() internal view returns (bytes memory code) {
        uint256 total;
        uint256 k = _stores.length;
        for (uint256 i; i < k; ++i) {
            address s = _stores[i];
            if (s.codehash != _storeHashes[i] || s.code.length < 2) revert BadCodeStore();
            total += s.code.length - 1;
        }
        code = new bytes(total);
        uint256 at;
        for (uint256 i; i < k; ++i) {
            address s = _stores[i];
            uint256 n = s.code.length - 1;
            assembly ("memory-safe") {
                extcodecopy(s, add(add(code, 0x20), at), 1, n)
            }
            at += n;
        }
    }

    function _verify(KeyFactoryV2.KeyRecord memory r, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (sig.length != C.SIG_LENGTH) return false;
        if (r.blob.codehash != r.blobHash) return false;
        IMLDSAVerifier v = keyFactory.verifier();
        if (address(v).codehash != keyFactory.verifierCodehash()) return false;
        (bool ok, bytes memory ret) = address(v).staticcall(abi.encodeCall(IMLDSAVerifier.verify, (r.blob, abi.encodePacked(digest), sig)));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }
}
