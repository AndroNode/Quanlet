// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMLDSAVerifier} from "../verifier/IMLDSAVerifier.sol";
import {KeyFactoryV2} from "./KeyFactoryV2.sol";
import {QuanletV2 as C, Policy, AssetRule} from "./QuanletV2.sol";

/// @title PersonalVaultV2 (Quanlet protocol 2.0)
/// @notice A non-upgradeable personal vault with five ML-DSA-44 roles: primary P, independent approver A and
///         guardians G1-G3 (whitepaper v2.0).
///
///  - PROTECTED transfers need P and A over the identical request. With protected delay 0 they execute in the
///    submitting transaction; with 1, 24 or 72 hours they are queued and anyone may execute them when mature.
///  - FAST transfers need only P, and only within a jointly granted, finite, expiring, recipient-restricted
///    allowance per asset. Lifetime debit never resets; there is no automatic refill.
///  - Policy, allowance renewal, delay changes, FAST resumption and spending-key rotation need P and A. With a
///    nonzero delay they wait that exact delay, freezing outflows meanwhile.
///  - P or A alone can cancel a queued withdrawal, invalidate spending approvals or suspend FAST: restrict, never expand.
///  - Two of three guardians can replace the spending pair after seven days; acceptance freezes outflows at once.
///    Guardian replacement needs P, A and two guardians and also waits seven days.
///
/// No owner, admin, proxy, pause or arbitrary call. Signatures are over the 32-byte Appendix A digest passed as the
/// message to pure ML-DSA-44 with an empty context.
contract PersonalVaultV2 {
    // ------------------------------------------------------------------ types

    enum State {
        Active,
        PendingPolicy,
        PendingSpendingKeys,
        PendingRecovery,
        PendingGuardians
    }

    enum WStatus {
        None,
        Queued,
        Executed,
        Cancelled
    }

    struct KeyRef {
        bytes32 keyId;
        address blob;
        bytes32 blobHash;
    }

    struct Transfer {
        uint8 route; // 1 FAST, 2 PROTECTED
        address asset; // address(0) = native ETH
        address recipient;
        uint256 amount;
        address feeRecipient;
        uint256 feeWei;
    }

    struct Window {
        uint64 validAfter;
        uint64 validUntil;
    }

    /// Two distinct current guardians (indexes 0..2 for G1..G3) and their signatures.
    struct GuardianSigs {
        uint8[2] idx;
        bytes[2] sigs;
    }

    struct Withdrawal {
        address asset;
        address recipient;
        uint256 amount;
        address feeRecipient;
        uint256 feeWei;
        uint64 authorityEpoch;
        uint64 policyEpoch;
        uint64 executionEpoch;
        uint64 executableAt;
        uint64 expiresAt;
        WStatus status;
    }

    struct Proposal {
        bytes32 id; // the accepted action digest
        State kind;
        uint64 executableAt;
        uint64 expiresAt;
        bytes32 payloadHash; // POLICY: policyHash
        bytes32[3] keys; // SPENDING_KEYS / RECOVERY: [P', A', 0]; GUARDIANS: [G1', G2', G3']
    }

    struct Rule {
        bool set;
        uint256 ceiling;
        uint256 perActionCap;
        uint64 validAfter;
        uint64 validUntil;
        address[] recipients;
    }

    // ------------------------------------------------------------------ immutable wiring

    IMLDSAVerifier public immutable verifier;
    bytes32 public immutable verifierCodehash;
    KeyFactoryV2 public immutable keyFactory;
    address public immutable factory;

    // ------------------------------------------------------------------ state

    KeyRef[5] private _roles; // P, A, G1, G2, G3
    address[] private _supported; // fixed at construction
    mapping(address asset => bool) public isSupported;

    State public state;
    uint64 public authorityEpoch = 1;
    uint64 public policyEpoch = 1;
    uint64 public executionEpoch = 1;
    uint256[6] private _nonces; // lanes 1..5

    uint32 public protectedDelay;
    bool public fastEnabled;
    bool public fastSuspended;
    uint256 public maxFastFeeWei;
    bool private _resumeFast; // as signed in the installed policy, so getPolicy() hashes to policyHash
    bytes32 public policyHash;
    mapping(uint64 policyEpoch => address[]) private _feeRecipients;
    mapping(uint64 policyEpoch => address[]) private _ruleAssets;
    mapping(uint64 policyEpoch => mapping(address asset => Rule)) private _rules;
    mapping(address asset => uint256) public spent; // lifetime FAST debit; never resets

    mapping(bytes32 id => Withdrawal) private _withdrawals;
    mapping(uint64 executionEpoch => uint256) public liveCount;
    Proposal private _proposal;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed from, uint256 amount);
    event TransferExecuted(bytes32 indexed id, uint8 route, address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei);
    event WithdrawalScheduled(bytes32 indexed id, uint64 indexed executionEpoch, address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei, uint64 executableAt, uint64 expiresAt);
    event WithdrawalExecuted(bytes32 indexed id, address indexed executor);
    event WithdrawalCancelled(bytes32 indexed id, uint8 role);
    event WithdrawalPruned(bytes32 indexed id);
    event FastDebited(address indexed asset, uint256 debit, uint256 spentTotal, uint256 ceiling);
    event FastSuspended(uint8 role);
    event EpochsAdvanced(uint64 authorityEpoch, uint64 policyEpoch, uint64 executionEpoch);
    event PolicyApplied(bytes32 indexed policyHash, uint64 policyEpoch);
    event RolesChanged(bytes32[5] keyIds);
    event SecurityProposalStarted(bytes32 indexed id, State kind, bytes32 payloadHash, bytes32[3] keys, uint64 executableAt, uint64 expiresAt);
    event SecurityProposalCancelled(bytes32 indexed id);
    event SecurityProposalSuperseded(bytes32 indexed id);
    event SecurityProposalFinalized(bytes32 indexed id, State kind);
    event SecurityProposalExpired(bytes32 indexed id);

    // ------------------------------------------------------------------ errors

    error NotActive();
    error WrongState();
    error BadParams();
    error BadPolicy();
    error BadInterval();
    error RequestNotAccepted();
    error BadSignature();
    error UnexpectedSignature();
    error DuplicateSigner();
    error BadRole();
    error DuplicateKey();
    error KeyNotReady();
    error FastUnavailable();
    error AllowanceExceeded();
    error RecipientNotAllowed();
    error QueueFull();
    error NotQueued();
    error StaleEpoch();
    error TooEarly();
    error Expired();
    error NotExpired();
    error UnknownWithdrawal();
    error WrongProposal();
    error TransferFailed();
    error Reentrancy();
    error VerifierChanged();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyActive() {
        if (state != State.Active) revert NotActive();
        _;
    }

    // ------------------------------------------------------------------ construction

    /// @dev Called only by VaultFactoryV2 after it has verified all five setup signatures.
    constructor(KeyFactoryV2 keyFactory_, bytes32[5] memory roleIds, Policy memory policy, address[] memory supportedAssets) {
        keyFactory = keyFactory_;
        verifier = keyFactory_.verifier();
        verifierCodehash = keyFactory_.verifierCodehash();
        factory = msg.sender;
        if (supportedAssets.length == 0 || supportedAssets.length > C.MAX_ASSETS) revert BadParams();
        for (uint256 i; i < supportedAssets.length; ++i) {
            if (i > 0 && supportedAssets[i] <= supportedAssets[i - 1]) revert BadParams();
            _supported.push(supportedAssets[i]);
            isSupported[supportedAssets[i]] = true;
        }
        for (uint256 i; i < 5; ++i) {
            _roles[i] = _load(roleIds[i]);
            for (uint256 j; j < i; ++j) {
                if (roleIds[i] == roleIds[j]) revert DuplicateKey();
            }
        }
        _validatePolicy(policy, uint64(block.timestamp), uint64(block.timestamp));
        _installPolicy(policy);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ digests (Appendix A)

    /// @notice The exact 32 bytes that signers approve. Epochs are the current ones; recovery lane 5 binds the
    ///         authority epoch only (policy and execution epochs canonically zero).
    function actionDigest(uint8 action, uint8 lane, uint256 nonce, bytes32 paramsHash, uint64 validAfter, uint64 validUntil)
        public
        view
        returns (bytes32)
    {
        bool rec = lane == C.LANE_RECOVERY;
        return keccak256(
            abi.encode(
                C.ACTION_DOMAIN,
                C.PROTOCOL_VERSION,
                block.chainid,
                address(this),
                action,
                lane,
                authorityEpoch,
                rec ? uint64(0) : policyEpoch,
                rec ? uint64(0) : executionEpoch,
                nonce,
                paramsHash,
                validAfter,
                validUntil
            )
        );
    }

    /// @notice Appendix A role consent: a newly designated key consents to the exact action.
    function consentDigest(bytes32 digest, uint8 roleId, bytes32 newKeyId) public pure returns (bytes32) {
        return keccak256(abi.encode(C.CONSENT_DOMAIN, digest, roleId, newKeyId));
    }

    function transferParamsHash(Transfer calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei));
    }

    function policyHashOf(Policy calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function nonceOf(uint8 lane) external view returns (uint256) {
        if (lane == 0 || lane > 5) revert BadParams();
        return _nonces[lane];
    }

    // ------------------------------------------------------------------ transfers (sections 07-10)

    /// @notice FAST (P only, within allowance) or PROTECTED (P and A). Executes now, or queues a PROTECTED
    ///         request when a protected delay is elected. Anyone may submit; the signatures carry the authority.
    function submitTransfer(Transfer calldata t, Window calldata w, bytes calldata pSig, bytes calldata aSig)
        external
        nonReentrant
        onlyActive
        returns (bytes32 id)
    {
        if (t.route != C.ROUTE_FAST && t.route != C.ROUTE_PROTECTED) revert BadParams();
        if (t.amount == 0 || t.recipient == address(0) || t.recipient == address(this)) revert BadParams();
        if (t.feeWei == 0 ? t.feeRecipient != address(0) : (t.feeRecipient == address(0) || t.feeRecipient == address(this))) {
            revert BadParams();
        }
        if (!isSupported[t.asset]) revert BadParams();

        _checkWindow(w);
        id = actionDigest(C.A_TRANSFER, C.LANE_SPEND, _nonces[C.LANE_SPEND], transferParamsHash(t), w.validAfter, w.validUntil);
        if (!_verify(_roles[0], id, pSig)) revert BadSignature();
        if (t.route == C.ROUTE_PROTECTED) {
            if (!_verify(_roles[1], id, aSig)) revert BadSignature();
        } else if (aSig.length != 0) {
            revert UnexpectedSignature();
        }
        _nonces[C.LANE_SPEND]++;

        if (t.route == C.ROUTE_FAST) {
            _debitFast(t);
            _pay(t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei);
            emit TransferExecuted(id, t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei);
        } else if (protectedDelay == 0) {
            _pay(t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei);
            emit TransferExecuted(id, t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei);
        } else {
            uint64 e = executionEpoch;
            if (liveCount[e] >= C.MAX_LIVE_QUEUE) revert QueueFull();
            liveCount[e]++;
            uint64 executableAt = uint64(block.timestamp) + protectedDelay;
            uint64 expiresAt = executableAt + C.WITHDRAWAL_WINDOW;
            _withdrawals[id] = Withdrawal({
                asset: t.asset,
                recipient: t.recipient,
                amount: t.amount,
                feeRecipient: t.feeRecipient,
                feeWei: t.feeWei,
                authorityEpoch: authorityEpoch,
                policyEpoch: policyEpoch,
                executionEpoch: e,
                executableAt: executableAt,
                expiresAt: expiresAt,
                status: WStatus.Queued
            });
            emit WithdrawalScheduled(id, e, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei, executableAt, expiresAt);
        }
    }

    /// @notice Anyone may execute a mature queued withdrawal. Asset and fee move together or not at all; a
    ///         failed transfer reverts and leaves the entry for retry inside its window.
    function executeWithdrawal(bytes32 id) external nonReentrant onlyActive {
        Withdrawal storage q = _withdrawals[id];
        if (q.status != WStatus.Queued) revert NotQueued();
        if (!_current(q)) revert StaleEpoch();
        if (block.timestamp < q.executableAt) revert TooEarly();
        if (block.timestamp >= q.expiresAt) revert Expired();
        q.status = WStatus.Executed;
        liveCount[q.executionEpoch]--;
        Withdrawal memory m = q;
        _pay(m.asset, m.recipient, m.amount, m.feeRecipient, m.feeWei);
        emit WithdrawalExecuted(id, msg.sender);
    }

    /// @notice Anyone may delete entries that can never execute again.
    function pruneWithdrawal(bytes32 id) external nonReentrant {
        Withdrawal storage q = _withdrawals[id];
        if (q.status == WStatus.None) revert UnknownWithdrawal();
        bool live = q.status == WStatus.Queued && _current(q) && block.timestamp < q.expiresAt;
        if (live) revert NotExpired();
        if (q.status == WStatus.Queued && q.executionEpoch == executionEpoch) liveCount[q.executionEpoch]--;
        delete _withdrawals[id];
        emit WithdrawalPruned(id);
    }

    // ------------------------------------------------------------------ safety actions (P or A alone)

    /// @param role 1 = P (lane 3), 2 = A (lane 4)
    function cancelWithdrawal(bytes32 id, uint8 role, Window calldata w, bytes calldata sig) external nonReentrant onlyActive {
        Withdrawal storage q = _withdrawals[id];
        if (q.status != WStatus.Queued) revert NotQueued();
        if (!_current(q)) revert StaleEpoch();
        _checkSafety(C.A_CANCEL_WITHDRAWAL, role, keccak256(abi.encode(id)), w, sig);
        q.status = WStatus.Cancelled;
        liveCount[q.executionEpoch]--;
        emit WithdrawalCancelled(id, role);
    }

    function invalidateSpending(uint8 role, Window calldata w, bytes calldata sig) external nonReentrant onlyActive {
        _checkSafety(C.A_INVALIDATE, role, keccak256(abi.encode(executionEpoch)), w, sig);
        _advance(false, false);
    }

    function suspendFast(uint8 role, Window calldata w, bytes calldata sig) external nonReentrant onlyActive {
        _checkSafety(C.A_SUSPEND_FAST, role, keccak256(abi.encode(executionEpoch, true)), w, sig);
        fastSuspended = true;
        emit FastSuspended(role);
        _advance(false, false);
    }

    // ------------------------------------------------------------------ administration (P and A)

    /// @notice Replace the whole policy. Applies now with protected delay 0; otherwise waits exactly the current
    ///         delay, freezing outflows meanwhile.
    function updatePolicy(Policy calldata p, Window calldata w, bytes calldata pSig, bytes calldata aSig)
        external
        nonReentrant
        onlyActive
    {
        bytes32 ph = keccak256(abi.encode(p));
        uint64 activation = uint64(block.timestamp) + protectedDelay;
        _validatePolicy(p, uint64(block.timestamp), activation);
        bytes32 id = _checkPair(C.A_UPDATE_POLICY, keccak256(abi.encode(ph)), w, pSig, aSig);
        if (protectedDelay == 0) {
            _advance(false, true);
            _installPolicy(p);
        } else {
            _open(id, State.PendingPolicy, ph, [bytes32(0), bytes32(0), bytes32(0)], protectedDelay, C.ADMIN_WINDOW);
        }
    }

    /// @notice Rotate P and/or A. Each newly introduced key consents to the exact action; a retained role is
    ///         approved by its current signature. Swapping P and A is not a rotation.
    function replaceSpendingKeys(
        bytes32 newP,
        bytes32 newA,
        Window calldata w,
        bytes calldata pSig,
        bytes calldata aSig,
        bytes calldata newPConsent,
        bytes calldata newAConsent
    ) external nonReentrant onlyActive {
        bytes32 curP = _roles[0].keyId;
        bytes32 curA = _roles[1].keyId;
        if (newP == curP && newA == curA) revert BadParams();
        _checkSpendingPair(newP, newA, false);
        bytes32 id = _checkPair(C.A_REPLACE_SPENDING, keccak256(abi.encode(newP, newA)), w, pSig, aSig);
        if (newP != curP) _checkConsent(id, C.ROLE_P, newP, newPConsent);
        else if (newPConsent.length != 0) revert UnexpectedSignature();
        if (newA != curA) _checkConsent(id, C.ROLE_A, newA, newAConsent);
        else if (newAConsent.length != 0) revert UnexpectedSignature();
        if (protectedDelay == 0) {
            _setSpending(newP, newA);
            _advance(true, false);
        } else {
            _open(id, State.PendingSpendingKeys, bytes32(0), [newP, newA, bytes32(0)], protectedDelay, C.ADMIN_WINDOW);
        }
    }

    /// @notice P and A cancel a pending policy or spending-key proposal.
    function cancelAdminChange(bytes32 proposalId, Window calldata w, bytes calldata pSig, bytes calldata aSig) external nonReentrant {
        if (state != State.PendingPolicy && state != State.PendingSpendingKeys) revert WrongState();
        if (proposalId != _proposal.id) revert WrongProposal();
        _checkPair(C.A_CANCEL_ADMIN, keccak256(abi.encode(proposalId)), w, pSig, aSig);
        _close();
        emit SecurityProposalCancelled(proposalId);
    }

    // ------------------------------------------------------------------ recovery (guardians)

    /// @notice Two current guardians propose a new spending pair. Freezes outflows and suspends FAST at once;
    ///         supersedes any pending policy, spending-key or guardian proposal (never another recovery).
    function startRecovery(
        bytes32 newP,
        bytes32 newA,
        Window calldata w,
        GuardianSigs calldata g,
        bytes calldata newPConsent,
        bytes calldata newAConsent
    ) external nonReentrant {
        if (state == State.PendingRecovery) revert WrongState();
        _checkSpendingPair(newP, newA, true);
        bytes32 id = _checkGuardians(C.A_START_RECOVERY, keccak256(abi.encode(newP, newA)), w, g);
        _checkConsent(id, C.ROLE_P, newP, newPConsent);
        _checkConsent(id, C.ROLE_A, newA, newAConsent);
        if (state != State.Active) {
            emit SecurityProposalSuperseded(_proposal.id);
            delete _proposal;
            state = State.Active;
        }
        fastSuspended = true;
        emit FastSuspended(0);
        _open(id, State.PendingRecovery, bytes32(0), [newP, newA, bytes32(0)], C.SECURITY_DELAY, C.SECURITY_WINDOW);
    }

    /// @notice P, A and two current guardians replace the guardian set; all three designated guardians consent.
    function replaceGuardians(
        bytes32[3] calldata newG,
        Window calldata w,
        bytes calldata pSig,
        bytes calldata aSig,
        GuardianSigs calldata g,
        bytes[3] calldata consents
    ) external nonReentrant onlyActive {
        bytes32 curP = _roles[0].keyId;
        bytes32 curA = _roles[1].keyId;
        for (uint256 i; i < 3; ++i) {
            if (newG[i] == bytes32(0) || newG[i] == curP || newG[i] == curA) revert DuplicateKey();
            for (uint256 j; j < i; ++j) {
                if (newG[i] == newG[j]) revert DuplicateKey();
            }
            _requireReady(newG[i]);
        }
        bytes32 id = _checkGuardians(C.A_REPLACE_GUARDIANS, keccak256(abi.encode(newG)), w, g);
        if (!_verify(_roles[0], id, pSig) || !_verify(_roles[1], id, aSig)) revert BadSignature();
        for (uint256 i; i < 3; ++i) {
            _checkConsent(id, uint8(C.ROLE_G1 + i), newG[i], consents[i]);
        }
        _open(id, State.PendingGuardians, bytes32(0), newG, C.SECURITY_DELAY, C.SECURITY_WINDOW);
    }

    /// @notice Two current guardians cancel a pending recovery or guardian replacement.
    function cancelRecoveryChange(bytes32 proposalId, Window calldata w, GuardianSigs calldata g) external nonReentrant {
        if (state != State.PendingRecovery && state != State.PendingGuardians) revert WrongState();
        if (proposalId != _proposal.id) revert WrongProposal();
        _checkGuardians(C.A_CANCEL_RECOVERY, keccak256(abi.encode(proposalId)), w, g);
        _close();
        emit SecurityProposalCancelled(proposalId);
    }

    // ------------------------------------------------------------------ permissionless transitions

    /// @notice Anyone may finalize a mature proposal; it installs exactly what was approved. A policy proposal
    ///         needs its policy passed back as `policyPayload` = abi.encode(policy) (checked against its hash).
    function finalizeSecurityChange(bytes calldata policyPayload) external nonReentrant {
        State k = state;
        if (k == State.Active) revert WrongState();
        Proposal memory pr = _proposal;
        if (block.timestamp < pr.executableAt) revert TooEarly();
        if (block.timestamp >= pr.expiresAt) revert Expired();

        if (k == State.PendingPolicy) {
            Policy memory p = abi.decode(policyPayload, (Policy));
            if (keccak256(abi.encode(p)) != pr.payloadHash) revert BadPolicy();
            _recheckPolicy(p);
            delete _proposal;
            state = State.Active;
            _advance(false, true);
            _installPolicy(p);
        } else {
            if (policyPayload.length != 0) revert BadParams();
            delete _proposal;
            state = State.Active;
            if (k == State.PendingSpendingKeys) {
                _checkSpendingPair(pr.keys[0], pr.keys[1], false);
                _setSpending(pr.keys[0], pr.keys[1]);
                _advance(true, false);
            } else if (k == State.PendingRecovery) {
                _checkSpendingPair(pr.keys[0], pr.keys[1], true);
                _setSpending(pr.keys[0], pr.keys[1]);
                // FAST off and suspended, grants removed; the protected delay is preserved.
                _advance(true, true);
                _installRecoveryPolicy();
            } else {
                bytes32 curP = _roles[0].keyId;
                bytes32 curA = _roles[1].keyId;
                for (uint256 i; i < 3; ++i) {
                    if (pr.keys[i] == curP || pr.keys[i] == curA) revert DuplicateKey();
                    _roles[2 + i] = _load(pr.keys[i]);
                }
                _advance(true, false);
                emit RolesChanged(_ids());
            }
        }
        emit SecurityProposalFinalized(pr.id, k);
    }

    /// @notice Anyone may expire a proposal at or after its expiry; the old configuration resumes.
    function expireSecurityChange() external nonReentrant {
        if (state == State.Active) revert WrongState();
        if (block.timestamp < _proposal.expiresAt) revert NotExpired();
        bytes32 pid = _proposal.id;
        _close();
        emit SecurityProposalExpired(pid);
    }

    // ------------------------------------------------------------------ views

    function roles() external view returns (KeyRef[5] memory) {
        return _roles;
    }

    function supportedAssets() external view returns (address[] memory) {
        return _supported;
    }

    function getPolicy() external view returns (Policy memory p) {
        uint64 pe = policyEpoch;
        p.protectedDelay = protectedDelay;
        p.fastEnabled = fastEnabled;
        p.resumeFast = _resumeFast;
        p.maxFastFeeWei = maxFastFeeWei;
        p.fastFeeRecipients = _feeRecipients[pe];
        address[] memory assets = _ruleAssets[pe];
        p.assetRules = new AssetRule[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            Rule storage r = _rules[pe][assets[i]];
            p.assetRules[i] = AssetRule(assets[i], r.ceiling, r.perActionCap, r.validAfter, r.validUntil, r.recipients);
        }
    }

    /// @notice Remaining FAST authority for an asset now: zero unless FAST is enabled, not suspended, the vault
    ///         is active and the grant is inside its validity interval.
    function getRemaining(address asset) external view returns (uint256 remaining, uint256 ceiling, uint256 perActionCap, uint64 validUntil) {
        Rule storage r = _rules[policyEpoch][asset];
        ceiling = r.ceiling;
        perActionCap = r.perActionCap;
        validUntil = r.validUntil;
        bool usable = r.set && fastEnabled && !fastSuspended && state == State.Active && block.timestamp >= r.validAfter
            && block.timestamp < r.validUntil;
        remaining = usable && r.ceiling > spent[asset] ? r.ceiling - spent[asset] : 0;
    }

    function getProposal() external view returns (Proposal memory) {
        return _proposal;
    }

    function getWithdrawal(bytes32 id) external view returns (Withdrawal memory) {
        return _withdrawals[id];
    }

    // ------------------------------------------------------------------ internals: authorization

    function _checkWindow(Window calldata w) internal view {
        if (w.validUntil <= w.validAfter || w.validUntil - w.validAfter > C.ACCEPTANCE_MAX) revert BadInterval();
        if (block.timestamp < w.validAfter || block.timestamp >= w.validUntil) revert RequestNotAccepted();
    }

    /// P and A over the identical administration-lane digest; consumes the lane nonce.
    function _checkPair(uint8 action, bytes32 paramsHash, Window calldata w, bytes calldata pSig, bytes calldata aSig)
        internal
        returns (bytes32 id)
    {
        _checkWindow(w);
        id = actionDigest(action, C.LANE_ADMIN, _nonces[C.LANE_ADMIN], paramsHash, w.validAfter, w.validUntil);
        if (!_verify(_roles[0], id, pSig) || !_verify(_roles[1], id, aSig)) revert BadSignature();
        _nonces[C.LANE_ADMIN]++;
    }

    /// One spending key on its own safety lane; consumes that lane's nonce.
    function _checkSafety(uint8 action, uint8 role, bytes32 paramsHash, Window calldata w, bytes calldata sig) internal {
        if (role != C.ROLE_P && role != C.ROLE_A) revert BadRole();
        uint8 lane = role == C.ROLE_P ? C.LANE_P_SAFETY : C.LANE_A_SAFETY;
        _checkWindow(w);
        bytes32 id = actionDigest(action, lane, _nonces[lane], paramsHash, w.validAfter, w.validUntil);
        if (!_verify(_roles[role - 1], id, sig)) revert BadSignature();
        _nonces[lane]++;
    }

    /// Two distinct current guardians over the recovery-lane digest; consumes the recovery nonce.
    function _checkGuardians(uint8 action, bytes32 paramsHash, Window calldata w, GuardianSigs calldata g)
        internal
        returns (bytes32 id)
    {
        _checkWindow(w);
        if (g.idx[0] > 2 || g.idx[1] > 2) revert BadRole();
        if (g.idx[0] == g.idx[1]) revert DuplicateSigner();
        id = actionDigest(action, C.LANE_RECOVERY, _nonces[C.LANE_RECOVERY], paramsHash, w.validAfter, w.validUntil);
        for (uint256 i; i < 2; ++i) {
            if (!_verify(_roles[2 + g.idx[i]], id, g.sigs[i])) revert BadSignature();
        }
        _nonces[C.LANE_RECOVERY]++;
    }

    function _checkConsent(bytes32 id, uint8 roleId, bytes32 keyId, bytes calldata sig) internal view {
        if (!_verify(_load(keyId), consentDigest(id, roleId, keyId), sig)) revert BadSignature();
    }

    /// A new spending pair: both ready, distinct from each other and from the guardians; for a rotation, no
    /// swap of P and A; for recovery, both different from all five current roles.
    function _checkSpendingPair(bytes32 newP, bytes32 newA, bool recovery) internal view {
        if (newP == bytes32(0) || newA == bytes32(0) || newP == newA) revert DuplicateKey();
        bytes32 curP = _roles[0].keyId;
        bytes32 curA = _roles[1].keyId;
        if (recovery) {
            if (newP == curP || newP == curA || newA == curP || newA == curA) revert DuplicateKey();
        } else if (newP == curA || newA == curP) {
            revert DuplicateKey();
        }
        for (uint256 i = 2; i < 5; ++i) {
            if (newP == _roles[i].keyId || newA == _roles[i].keyId) revert DuplicateKey();
        }
        _requireReady(newP);
        _requireReady(newA);
    }

    function _requireReady(bytes32 keyId) internal view {
        if (!keyFactory.getRecord(keyId).ready) revert KeyNotReady();
    }

    function _load(bytes32 keyId) internal view returns (KeyRef memory) {
        KeyFactoryV2.KeyRecord memory r = keyFactory.getRecord(keyId);
        if (!r.ready) revert KeyNotReady();
        return KeyRef({keyId: keyId, blob: r.blob, blobHash: r.blobHash});
    }

    function _verify(KeyRef memory key, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (sig.length != C.SIG_LENGTH) return false;
        if (address(verifier).codehash != verifierCodehash) revert VerifierChanged();
        if (key.blob.codehash != key.blobHash) return false;
        (bool ok, bytes memory ret) =
            address(verifier).staticcall(abi.encodeCall(IMLDSAVerifier.verify, (key.blob, abi.encodePacked(digest), sig)));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    // ------------------------------------------------------------------ internals: state

    function _ids() internal view returns (bytes32[5] memory ids) {
        for (uint256 i; i < 5; ++i) {
            ids[i] = _roles[i].keyId;
        }
    }

    function _setSpending(bytes32 newP, bytes32 newA) internal {
        if (newP != _roles[0].keyId) _roles[0] = _load(newP);
        if (newA != _roles[1].keyId) _roles[1] = _load(newA);
        emit RolesChanged(_ids());
    }

    /// Advance the execution epoch, and the authority and/or policy epochs when asked.
    function _advance(bool authority, bool policy) internal {
        if (authority) authorityEpoch++;
        if (policy) policyEpoch++;
        executionEpoch++;
        emit EpochsAdvanced(authorityEpoch, policyEpoch, executionEpoch);
    }

    function _open(bytes32 id, State kind, bytes32 payloadHash, bytes32[3] memory keys, uint64 delay, uint64 window) internal {
        uint64 executableAt = uint64(block.timestamp) + delay;
        uint64 expiresAt = executableAt + window;
        _proposal = Proposal({id: id, kind: kind, executableAt: executableAt, expiresAt: expiresAt, payloadHash: payloadHash, keys: keys});
        state = kind;
        _advance(false, false); // freezes outflows and invalidates every spending approval and queue entry
        emit SecurityProposalStarted(id, kind, payloadHash, keys, executableAt, expiresAt);
    }

    function _close() internal {
        delete _proposal;
        state = State.Active;
        _advance(false, false);
    }

    function _current(Withdrawal storage q) internal view returns (bool) {
        return q.executionEpoch == executionEpoch && q.policyEpoch == policyEpoch && q.authorityEpoch == authorityEpoch;
    }

    // ------------------------------------------------------------------ internals: policy

    /// Appendix B validation at acceptance: `acceptedAt` is now, `activation` is when it would take effect.
    function _validatePolicy(Policy memory p, uint64 acceptedAt, uint64 activation) internal view {
        if (!C.isAllowedDelay(p.protectedDelay)) revert BadPolicy();
        _checkSet(p.fastFeeRecipients, C.MAX_FEE_RECIPIENTS, false);
        if (p.assetRules.length > C.MAX_ASSETS) revert BadPolicy();
        for (uint256 i; i < p.assetRules.length; ++i) {
            AssetRule memory r = p.assetRules[i];
            if (i > 0 && r.asset <= p.assetRules[i - 1].asset) revert BadPolicy();
            if (!isSupported[r.asset]) revert BadPolicy();
            _checkSet(r.recipients, C.MAX_RECIPIENTS, true);
            if (r.perActionCap == 0 || r.ceiling < spent[r.asset]) revert BadPolicy();
            if (r.budgetValidUntil <= r.budgetValidAfter || r.budgetValidUntil - r.budgetValidAfter > C.FAST_HORIZON) {
                revert BadPolicy();
            }
            if (r.budgetValidUntil > acceptedAt + C.FAST_HORIZON || r.budgetValidUntil <= activation) revert BadPolicy();
        }
    }

    /// At activation of a delayed policy: grants must still be unexpired and no ceiling below lifetime debit.
    function _recheckPolicy(Policy memory p) internal view {
        for (uint256 i; i < p.assetRules.length; ++i) {
            AssetRule memory r = p.assetRules[i];
            if (r.budgetValidUntil <= block.timestamp || r.ceiling < spent[r.asset]) revert BadPolicy();
        }
    }

    /// Sorted, unique, nonzero, never the vault; `nonEmpty` for grant recipient sets.
    function _checkSet(address[] memory s, uint256 max, bool nonEmpty) internal view {
        if (s.length > max || (nonEmpty && s.length == 0)) revert BadPolicy();
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == address(0) || s[i] == address(this)) revert BadPolicy();
            if (i > 0 && s[i] <= s[i - 1]) revert BadPolicy();
        }
    }

    /// Install under the current policyEpoch (callers advance it first, except at construction).
    function _installPolicy(Policy memory p) internal {
        uint64 pe = policyEpoch;
        protectedDelay = p.protectedDelay;
        fastEnabled = p.fastEnabled;
        if (p.resumeFast && p.fastEnabled) fastSuspended = false;
        _resumeFast = p.resumeFast;
        maxFastFeeWei = p.maxFastFeeWei;
        _feeRecipients[pe] = p.fastFeeRecipients;
        for (uint256 i; i < p.assetRules.length; ++i) {
            AssetRule memory r = p.assetRules[i];
            _ruleAssets[pe].push(r.asset);
            Rule storage s = _rules[pe][r.asset];
            s.set = true;
            s.ceiling = r.ceiling;
            s.perActionCap = r.perActionCap;
            s.validAfter = r.budgetValidAfter;
            s.validUntil = r.budgetValidUntil;
            s.recipients = r.recipients;
        }
        policyHash = keccak256(abi.encode(p));
        emit PolicyApplied(policyHash, pe);
    }

    /// After recovery: same delay, FAST disabled and suspended, no grants, no fee recipients.
    function _installRecoveryPolicy() internal {
        Policy memory p;
        p.protectedDelay = protectedDelay;
        p.fastFeeRecipients = new address[](0);
        p.assetRules = new AssetRule[](0);
        fastSuspended = true;
        _installPolicy(p);
    }

    /// FAST checks and debits (section 08). All checks and counter updates happen before any transfer.
    function _debitFast(Transfer calldata t) internal {
        if (!fastEnabled || fastSuspended) revert FastUnavailable();
        uint64 pe = policyEpoch;
        Rule storage r = _rules[pe][t.asset];
        _requireLive(r);
        if (!_contains(r.recipients, t.recipient)) revert RecipientNotAllowed();
        if (t.feeWei != 0) {
            if (t.feeWei > maxFastFeeWei) revert AllowanceExceeded();
            if (!_contains(_feeRecipients[pe], t.feeRecipient)) revert RecipientNotAllowed();
        }
        if (t.asset == address(0)) {
            _debit(address(0), r, t.amount + t.feeWei);
        } else {
            _debit(t.asset, r, t.amount);
            if (t.feeWei != 0) {
                Rule storage er = _rules[pe][address(0)];
                _requireLive(er);
                _debit(address(0), er, t.feeWei);
            }
        }
    }

    function _requireLive(Rule storage r) internal view {
        if (!r.set || block.timestamp < r.validAfter || block.timestamp >= r.validUntil) revert FastUnavailable();
    }

    function _debit(address asset, Rule storage r, uint256 amount) internal {
        uint256 total = spent[asset] + amount;
        if (amount > r.perActionCap || total > r.ceiling) revert AllowanceExceeded();
        spent[asset] = total;
        emit FastDebited(asset, amount, total, r.ceiling);
    }

    function _contains(address[] storage s, address a) internal view returns (bool) {
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == a) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ internals: transfers

    function _pay(address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei) internal {
        if (asset == address(0)) {
            _sendEth(recipient, amount);
        } else {
            _sendToken(asset, recipient, amount);
        }
        if (feeWei != 0) _sendEth(feeRecipient, feeWei);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Direct transfer only, safe return handling, and exact debit/credit (no transfer-tax or rebasing tokens).
    function _sendToken(address token, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TransferFailed();
        uint256 v0 = _balanceOf(token, address(this));
        uint256 r0 = _balanceOf(token, to);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
        if (v0 - _balanceOf(token, address(this)) != amount || _balanceOf(token, to) - r0 != amount) revert TransferFailed();
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        if (!ok || ret.length != 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
