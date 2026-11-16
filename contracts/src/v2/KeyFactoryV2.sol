// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMLDSAVerifier} from "../verifier/IMLDSAVerifier.sol";
import {KeyPrep} from "../KeyPrep.sol";
import {QuanletV2 as C} from "./QuanletV2.sol";

/// @title KeyFactoryV2
/// @notice Protocol 2.0 key records (whitepaper v2.0 sections 05 and Appendix E).
///
/// registerKey takes only the canonical 1,312-byte raw public key. The factory prepares the verifier's key
/// blob from it on chain (KeyPrep: SHAKE256 for tr, the NTT of t1, ExpandA), deploys it as an immutable data
/// contract and records it, not yet ready. activateKey then checks a proof of possession over the
/// registration-only digest (chain, factory, algorithm, key id, acceptance interval) through that same blob
/// and marks the record ready. Readiness is monotonic and records are immutable. A registration can never
/// authorize spending or vault setup.
///
/// keyId = keccak256(abi.encode(algorithmId, rawPublicKey)), algorithmId = keccak256("QUANLET_ML_DSA_44_FIPS204").
/// No owner, no admin, no upgrade.
contract KeyFactoryV2 {
    struct KeyRecord {
        address blob; // key-data contract read by the verifier (zero if unregistered)
        bytes32 blobHash; // keccak256 of the blob code (the prepared code hash)
        uint8 prepVersion;
        bool ready;
    }

    /// KeyPrep v1 = the prepare.py layout, 20,545 bytes.
    uint8 public constant PREPARATION_VERSION = 1;
    bytes32 public constant F1600_CODEHASH = 0x4afb4435879cdf8e50474c7aab2bc3a679caed432550ad6dba64f509309a817b;

    IMLDSAVerifier public immutable verifier;
    bytes32 public immutable verifierCodehash;
    address public immutable f1600Helper;

    mapping(bytes32 keyId => KeyRecord) private _records;

    event KeyRegistered(bytes32 indexed keyId, address blob, bytes32 blobHash, uint8 prepVersion);
    event KeyActivated(bytes32 indexed keyId);

    error BadPublicKeyLength();
    error DegenerateKey();
    error AlreadyRegistered();
    error NotRegistered();
    error AlreadyActive();
    error BlobDeployFailed();
    error BadProofOfPossession();
    error BadInterval();
    error RequestNotAccepted();
    error VerifierChanged();
    error BadHelper();

    constructor(IMLDSAVerifier verifier_, address f1600Helper_) {
        if (f1600Helper_.codehash != F1600_CODEHASH) revert BadHelper();
        verifier = verifier_;
        verifierCodehash = address(verifier_).codehash;
        f1600Helper = f1600Helper_;
    }

    function keyIdOf(bytes calldata rawPk) public pure returns (bytes32) {
        return keccak256(abi.encode(C.ALGORITHM_ID, rawPk));
    }

    /// @notice Appendix E registration digest: the exact 32 bytes a key signs to activate its record.
    function registrationDigest(bytes32 keyId, uint64 validAfter, uint64 validUntil) public view returns (bytes32) {
        return keccak256(
            abi.encode(C.REGISTRATION_DOMAIN, block.chainid, address(this), C.ALGORITHM_ID, keyId, validAfter, validUntil)
        );
    }

    /// @notice The canonical blob for a raw key, computed exactly as registerKey computes it (read-only).
    function preparedBlobOf(bytes calldata rawPk) external view returns (bytes memory) {
        if (rawPk.length != C.PK_LENGTH) revert BadPublicKeyLength();
        _checkHelper();
        return KeyPrep.prepare(rawPk, f1600Helper);
    }

    /// @notice Prepare and publish a key's verifier blob. Anyone may pay; the record is not ready until activated.
    function registerKey(bytes calldata rawPk) external returns (bytes32 keyId) {
        if (rawPk.length != C.PK_LENGTH) revert BadPublicKeyLength();
        if (_isDegenerate(rawPk)) revert DegenerateKey();
        _checkHelper();
        keyId = keyIdOf(rawPk);
        if (_records[keyId].blob != address(0)) revert AlreadyRegistered();

        bytes memory blob = KeyPrep.prepare(rawPk, f1600Helper);
        bytes32 blobHash = keccak256(blob);
        bytes memory init = abi.encodePacked(hex"61", uint16(blob.length), hex"80600c6000396000f3", blob);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(init, 0x20), mload(init), keyId)
        }
        if (deployed == address(0) || deployed.codehash != blobHash) revert BlobDeployFailed();
        _records[keyId] = KeyRecord({blob: deployed, blobHash: blobHash, prepVersion: PREPARATION_VERSION, ready: false});
        emit KeyRegistered(keyId, deployed, blobHash, PREPARATION_VERSION);
    }

    /// @notice Activate a registered key with a proof of possession over registrationDigest.
    function activateKey(bytes32 keyId, uint64 validAfter, uint64 validUntil, bytes calldata sig) external {
        KeyRecord storage r = _records[keyId];
        if (r.blob == address(0)) revert NotRegistered();
        if (r.ready) revert AlreadyActive();
        if (validUntil <= validAfter || validUntil - validAfter > C.ACCEPTANCE_MAX) revert BadInterval();
        if (block.timestamp < validAfter || block.timestamp >= validUntil) revert RequestNotAccepted();
        if (address(verifier).codehash != verifierCodehash) revert VerifierChanged();
        if (r.blob.codehash != r.blobHash) revert BadProofOfPossession();
        if (sig.length != C.SIG_LENGTH) revert BadProofOfPossession();
        (bool ok, bytes memory ret) = address(verifier).staticcall(
            abi.encodeCall(IMLDSAVerifier.verify, (r.blob, abi.encodePacked(registrationDigest(keyId, validAfter, validUntil)), sig))
        );
        if (!ok || ret.length != 32 || !abi.decode(ret, (bool))) revert BadProofOfPossession();
        r.ready = true;
        emit KeyActivated(keyId);
    }

    function getRecord(bytes32 keyId) external view returns (KeyRecord memory) {
        return _records[keyId];
    }

    // ---------------------------------------------------------------- internals

    function _checkHelper() internal view {
        if (f1600Helper.codehash != F1600_CODEHASH) revert BadHelper();
    }

    /// Centred-lift floor (verifier docs/SAFETY.md 3.1 (2)(i)): refuse keys where fewer than half of the
    /// 1,024 t1 coefficients have |lift| > gamma2. Honest keys pass with ~97% large coefficients.
    function _isDegenerate(bytes calldata rawPk) internal pure returns (bool) {
        uint256 q = 8380417;
        uint256 gamma2 = 95232;
        uint256 big;
        for (uint256 i = 32; i < 1312; i += 5) {
            uint256 w = uint256(uint8(rawPk[i])) | (uint256(uint8(rawPk[i + 1])) << 8) | (uint256(uint8(rawPk[i + 2])) << 16)
                | (uint256(uint8(rawPk[i + 3])) << 24) | (uint256(uint8(rawPk[i + 4])) << 32);
            for (uint256 j; j < 4; ++j) {
                uint256 t = (((w >> (10 * j)) & 0x3ff) << 13) % q;
                uint256 lift = t > q / 2 ? q - t : t;
                if (lift > gamma2) ++big;
            }
        }
        return big < 512;
    }
}
