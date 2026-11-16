// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Fixed protocol constants from the Quanlet whitepaper v1.0 (sections 3, 7-9, Appendix C).
/// They are compile-time constants: no role can change them for a deployed vault.
library QuanletConstants {
    /// keccak256 of the UTF-8 bytes "QUANLET_ACTION_V1" (Appendix C domain tag).
    bytes32 internal constant DOMAIN_TAG = keccak256("QUANLET_ACTION_V1");
    bytes32 internal constant SETUP_TAG = keccak256("QUANLET_SETUP_V1");
    bytes32 internal constant POP_TAG = keccak256("QUANLET_KEY_POP_V1");
    uint32 internal constant PROTOCOL_VERSION = 1;

    /// Algorithm identifier used in canonical key ids: ML-DSA-44, pure, empty context.
    uint8 internal constant ALG_MLDSA44 = 1;

    uint64 internal constant WITHDRAWAL_DELAY = 86_400;
    uint64 internal constant WITHDRAWAL_WINDOW = 604_800;
    uint64 internal constant ACCEPTANCE_MAX = 1_800;
    uint64 internal constant SECURITY_DELAY = 7 days;
    uint64 internal constant SECURITY_WINDOW = 7 days;
    uint256 internal constant MAX_ACTIVE_QUEUE = 32;

    // Appendix C action identifiers.
    uint8 internal constant ACTION_SCHEDULE = 1;
    uint8 internal constant ACTION_CANCEL = 2;
    uint8 internal constant ACTION_INVALIDATE = 3;
    uint8 internal constant ACTION_RECOVERY = 4;
    uint8 internal constant ACTION_REPLACE_RECOVERY_SET = 5;
    uint8 internal constant ACTION_CANCEL_SECURITY = 6;

    uint8 internal constant KIND_PRIMARY = 1;
    uint8 internal constant KIND_RECOVERY_SET = 2;

    uint256 internal constant PK_LENGTH = 1312;
    uint256 internal constant SIG_LENGTH = 2420;
    uint256 internal constant BLOB_LENGTH = 20545;
}
