// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMLDSAVerifier} from "./verifier/IMLDSAVerifier.sol";
import {KeyFactory} from "./KeyFactory.sol";
import {PersonalVault} from "./PersonalVault.sol";
import {QuanletConstants as C} from "./QuanletConstants.sol";

/// @title VaultFactory
/// @notice Deploys fully configured PersonalVaults at deterministic CREATE2 addresses after the
///         primary key signs the exact configuration and expected address. No admin; it cannot
///         change a vault after deployment.
contract VaultFactory {
    KeyFactory public immutable keyFactory;

    event VaultCreated(address indexed vault, bytes32 indexed primaryRecord, bytes32[3] recoveryRecords, bytes32 salt);

    error BadInterval();
    error RequestNotAccepted();
    error BadSetupSignature();
    error AlreadyDeployed();
    error KeyNotReady();

    constructor(KeyFactory keyFactory_) {
        keyFactory = keyFactory_;
    }

    function configHash(bytes32 primaryRecord, bytes32[3] calldata recoveryRecords) public pure returns (bytes32) {
        return keccak256(abi.encode(primaryRecord, recoveryRecords));
    }

    function predictAddress(bytes32 primaryRecord, bytes32[3] calldata recoveryRecords, bytes32 salt) public view returns (address) {
        bytes32 initHash = keccak256(_initCode(primaryRecord, recoveryRecords));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    /// @notice The exact 32 bytes the primary key signs to authorize setup (whitepaper section 6 step 5).
    function setupDigest(bytes32 primaryRecord, bytes32[3] calldata recoveryRecords, bytes32 salt, uint64 validAfter, uint64 validUntil)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                C.SETUP_TAG,
                block.chainid,
                address(this),
                salt,
                configHash(primaryRecord, recoveryRecords),
                predictAddress(primaryRecord, recoveryRecords, salt),
                validAfter,
                validUntil
            )
        );
    }

    function createVault(
        bytes32 primaryRecord,
        bytes32[3] calldata recoveryRecords,
        bytes32 salt,
        uint64 validAfter,
        uint64 validUntil,
        bytes calldata setupSig
    ) external returns (address vault) {
        if (validUntil <= validAfter || validUntil - validAfter > C.ACCEPTANCE_MAX) revert BadInterval();
        if (block.timestamp < validAfter || block.timestamp > validUntil) revert RequestNotAccepted();

        KeyFactory.KeyRecord memory p = keyFactory.getRecord(primaryRecord);
        if (!p.ready) revert KeyNotReady();
        bytes32 digest = setupDigest(primaryRecord, recoveryRecords, salt, validAfter, validUntil);
        if (!_verify(p.blob, digest, setupSig)) revert BadSetupSignature();

        address expected = predictAddress(primaryRecord, recoveryRecords, salt);
        if (expected.code.length != 0) revert AlreadyDeployed();
        vault = address(new PersonalVault{salt: salt}(keyFactory, primaryRecord, recoveryRecords));
        emit VaultCreated(vault, primaryRecord, recoveryRecords, salt);
    }

    function _initCode(bytes32 primaryRecord, bytes32[3] calldata recoveryRecords) internal view returns (bytes memory) {
        return abi.encodePacked(type(PersonalVault).creationCode, abi.encode(keyFactory, primaryRecord, recoveryRecords));
    }

    function _verify(address blob, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (sig.length != C.SIG_LENGTH) return false;
        IMLDSAVerifier v = keyFactory.verifier();
        if (address(v).codehash != keyFactory.verifierCodehash()) return false;
        (bool ok, bytes memory ret) = address(v).staticcall(abi.encodeCall(IMLDSAVerifier.verify, (blob, abi.encodePacked(digest), sig)));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }
}
