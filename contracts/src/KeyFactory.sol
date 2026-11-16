// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMLDSAVerifier} from "./verifier/IMLDSAVerifier.sol";
import {QuanletConstants as C} from "./QuanletConstants.sol";
import {KeyPrep} from "./KeyPrep.sol";

/// @title KeyFactory
/// @notice Registers ML-DSA-44 public keys as immutable key records that vaults can use.
///
/// The registrant supplies only the canonical raw public key and a proof-of-possession signature.
/// The factory itself prepares the verifier's key blob from the raw key (KeyPrep: SHAKE256 for tr,
/// the NTT of t1, ExpandA from rho), deploys it as a data contract, checks the proof of possession
/// through that blob and marks the record ready. No prepared data is ever accepted from outside, so
/// a record's blob is always the canonical preparation of its key (whitepaper section 4).
///
/// The whole preparation fits in one transaction on Robinhood Chain, so there are no intermediate
/// stages to protect. A key has exactly one record: recordId = keccak256(keyId, blobHash) where
/// blobHash is fixed by the key. Degenerate keys are refused by the centred-lift floor from the
/// verifier's safety notes.
///
/// No owner, no admin, no upgrade. Records can never be replaced or deleted.
contract KeyFactory {
    struct KeyRecord {
        bytes32 keyId; // canonical id of the raw 1,312-byte public key (the raw key commitment)
        address blob; // key-data contract read by the verifier
        bytes32 blobHash; // keccak256 of the blob code
        uint8 prepVersion; // preparation version that produced the blob
        bool ready;
    }

    /// Version of the on-chain preparation (KeyPrep v1 = prepare.py layout, 20,545 bytes).
    uint8 public constant PREPARATION_VERSION = 1;

    /// keccak256 of the Keccak-f[1600] helper runtime, the same constant the verifier binds.
    bytes32 public constant F1600_CODEHASH = 0x4afb4435879cdf8e50474c7aab2bc3a679caed432550ad6dba64f509309a817b;

    IMLDSAVerifier public immutable verifier;
    bytes32 public immutable verifierCodehash;
    address public immutable f1600Helper;

    mapping(bytes32 recordId => KeyRecord) private _records;
    mapping(bytes32 keyId => bytes32 recordId) private _recordOfKey;

    event KeyRegistered(bytes32 indexed recordId, bytes32 indexed keyId, address blob, bytes32 blobHash, uint8 prepVersion);

    error BadPublicKeyLength();
    error DegenerateKey();
    error AlreadyRegistered();
    error BlobDeployFailed();
    error BadProofOfPossession();
    error VerifierChanged();
    error BadHelper();

    constructor(IMLDSAVerifier verifier_, address f1600Helper_) {
        if (f1600Helper_.codehash != F1600_CODEHASH) revert BadHelper();
        verifier = verifier_;
        verifierCodehash = address(verifier_).codehash;
        f1600Helper = f1600Helper_;
    }

    function keyIdOf(bytes calldata rawPk) public pure returns (bytes32) {
        return keccak256(abi.encode(C.ALG_MLDSA44, rawPk));
    }

    function recordIdOf(bytes32 keyId, bytes32 blobHash) public pure returns (bytes32) {
        return keccak256(abi.encode(keyId, blobHash));
    }

    /// @notice The message a key must sign to prove possession during registration.
    function popMessage(bytes32 keyId, bytes32 blobHash) public view returns (bytes32) {
        return keccak256(abi.encode(C.POP_TAG, block.chainid, address(this), keyId, blobHash));
    }

    /// @notice The canonical blob for a raw key, computed exactly as registerKey computes it.
    /// Read-only; lets clients and audits compare the on-chain preparation with prepare.py.
    function preparedBlobOf(bytes calldata rawPk) external view returns (bytes memory) {
        if (rawPk.length != C.PK_LENGTH) revert BadPublicKeyLength();
        _checkHelper();
        return KeyPrep.prepare(rawPk, f1600Helper);
    }

    /// @notice Register a key. Anyone may pay for registration; only the key holder can produce the proof.
    /// @param rawPk standard FIPS 204 ML-DSA-44 public key, 1,312 bytes
    /// @param popSig ML-DSA-44 signature over popMessage(keyId, blobHash) as 32 raw bytes, where blobHash
    ///        is keccak256 of the canonical blob (preparedBlobOf(rawPk), or prepare.py off-chain)
    function registerKey(bytes calldata rawPk, bytes calldata popSig) external returns (bytes32 recordId) {
        if (rawPk.length != C.PK_LENGTH) revert BadPublicKeyLength();
        if (_isDegenerate(rawPk)) revert DegenerateKey();
        if (address(verifier).codehash != verifierCodehash) revert VerifierChanged();
        _checkHelper();

        bytes32 keyId = keyIdOf(rawPk);
        if (_recordOfKey[keyId] != bytes32(0)) revert AlreadyRegistered();

        bytes memory blob = KeyPrep.prepare(rawPk, f1600Helper);
        bytes32 blobHash = keccak256(blob);
        recordId = recordIdOf(keyId, blobHash);

        bytes memory init = abi.encodePacked(_initPrefix(blob.length), blob);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(init, 0x20), mload(init), keyId)
        }
        if (deployed == address(0) || deployed.codehash != blobHash) revert BlobDeployFailed();

        if (!_verify(deployed, popMessage(keyId, blobHash), popSig)) revert BadProofOfPossession();

        _records[recordId] =
            KeyRecord({keyId: keyId, blob: deployed, blobHash: blobHash, prepVersion: PREPARATION_VERSION, ready: true});
        _recordOfKey[keyId] = recordId;
        emit KeyRegistered(recordId, keyId, deployed, blobHash, PREPARATION_VERSION);
    }

    function getRecord(bytes32 recordId) external view returns (KeyRecord memory) {
        return _records[recordId];
    }

    /// @notice The record id of a registered key, or zero.
    function recordOfKey(bytes32 keyId) external view returns (bytes32) {
        return _recordOfKey[keyId];
    }

    // ---------------------------------------------------------------- internals

    function _checkHelper() internal view {
        if (f1600Helper.codehash != F1600_CODEHASH) revert BadHelper();
    }

    function _verify(address blob, bytes32 message, bytes calldata sig) internal view returns (bool) {
        if (sig.length != C.SIG_LENGTH) return false;
        (bool ok, bytes memory ret) =
            address(verifier).staticcall(abi.encodeCall(IMLDSAVerifier.verify, (blob, abi.encodePacked(message), sig)));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    /// Init code that returns the `len` bytes appended after it as runtime code:
    /// PUSH2 len, DUP1, PUSH1 0x0c, PUSH1 0, CODECOPY, PUSH1 0, RETURN
    function _initPrefix(uint256 len) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"61", uint16(len), hex"80600c6000396000f3");
    }

    /// Centred-lift floor (verifier docs/SAFETY.md 3.1 (2)(i)): refuse keys where fewer than half of the
    /// 1,024 t1 coefficients have |lift| > gamma2. Honest keys pass with ~97% large coefficients.
    function _isDegenerate(bytes calldata rawPk) internal pure returns (bool) {
        uint256 q = 8380417;
        uint256 gamma2 = 95232;
        uint256 big;
        // t1 is packed 10 bits per coefficient after the 32-byte rho: 4 coefficients per 5 bytes.
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
