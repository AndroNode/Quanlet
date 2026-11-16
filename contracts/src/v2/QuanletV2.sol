// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Protocol 2.0 constants and shared types (whitepaper v2.0, Appendices A, B, C and E).
/// Compile-time constants: no role can change them for a deployed vault.
library QuanletV2 {
    // ---------------------------------------------------------------- domains (Appendix A, E; section 05)
    bytes32 internal constant ACTION_DOMAIN = keccak256("QUANLET_ACTION_V2");
    bytes32 internal constant CONSENT_DOMAIN = keccak256("QUANLET_ROLE_CONSENT_V2");
    bytes32 internal constant SETUP_DOMAIN = keccak256("QUANLET_SETUP_V2");
    bytes32 internal constant REGISTRATION_DOMAIN = keccak256("QUANLET_KEY_REGISTRATION_V2");
    bytes32 internal constant ALGORITHM_ID = keccak256("QUANLET_ML_DSA_44_FIPS204");
    uint32 internal constant PROTOCOL_VERSION = 2;

    // ---------------------------------------------------------------- actions (Appendix A)
    uint8 internal constant A_TRANSFER = 1;
    uint8 internal constant A_CANCEL_WITHDRAWAL = 2;
    uint8 internal constant A_INVALIDATE = 3;
    uint8 internal constant A_SUSPEND_FAST = 4;
    uint8 internal constant A_UPDATE_POLICY = 5;
    uint8 internal constant A_REPLACE_SPENDING = 6;
    uint8 internal constant A_CANCEL_ADMIN = 7;
    uint8 internal constant A_START_RECOVERY = 8;
    uint8 internal constant A_REPLACE_GUARDIANS = 9;
    uint8 internal constant A_CANCEL_RECOVERY = 10;

    // ---------------------------------------------------------------- nonce lanes (section 09)
    uint8 internal constant LANE_SPEND = 1;
    uint8 internal constant LANE_ADMIN = 2;
    uint8 internal constant LANE_P_SAFETY = 3;
    uint8 internal constant LANE_A_SAFETY = 4;
    uint8 internal constant LANE_RECOVERY = 5;

    // ---------------------------------------------------------------- roles (Appendix A)
    uint8 internal constant ROLE_P = 1;
    uint8 internal constant ROLE_A = 2;
    uint8 internal constant ROLE_G1 = 3;

    // ---------------------------------------------------------------- routes (Appendix B)
    uint8 internal constant ROUTE_FAST = 1;
    uint8 internal constant ROUTE_PROTECTED = 2;

    // ---------------------------------------------------------------- parameters (Appendix B)
    uint64 internal constant ACCEPTANCE_MAX = 1_800;
    uint64 internal constant WITHDRAWAL_WINDOW = 604_800;
    uint64 internal constant SECURITY_DELAY = 604_800; // recovery and guardian replacement
    uint64 internal constant SECURITY_WINDOW = 604_800;
    uint64 internal constant ADMIN_WINDOW = 604_800;
    uint64 internal constant FAST_HORIZON = 2_592_000;
    uint256 internal constant MAX_LIVE_QUEUE = 32;
    uint256 internal constant MAX_ASSETS = 16;
    uint256 internal constant MAX_RECIPIENTS = 16;
    uint256 internal constant MAX_FEE_RECIPIENTS = 8;

    uint256 internal constant PK_LENGTH = 1312;
    uint256 internal constant SIG_LENGTH = 2420;

    function isAllowedDelay(uint32 d) internal pure returns (bool) {
        return d == 0 || d == 3_600 || d == 86_400 || d == 259_200;
    }
}

/// Appendix B policy encoding: one ABI tuple, fields in this order.
struct AssetRule {
    address asset;
    uint256 ceiling;
    uint256 perActionCap;
    uint64 budgetValidAfter;
    uint64 budgetValidUntil;
    address[] recipients;
}

struct Policy {
    uint32 protectedDelay;
    bool fastEnabled;
    bool resumeFast;
    uint256 maxFastFeeWei;
    address[] fastFeeRecipients;
    AssetRule[] assetRules;
}
