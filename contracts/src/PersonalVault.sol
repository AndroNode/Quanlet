// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMLDSAVerifier} from "./verifier/IMLDSAVerifier.sol";
import {KeyFactory} from "./KeyFactory.sol";
import {QuanletConstants as C} from "./QuanletConstants.sol";

/// @title PersonalVault (Quanlet v1)
/// @notice Holds ETH and ERC-20 tokens. Every outflow is an exact withdrawal signed by the primary
///         ML-DSA-44 key, delayed 24 hours and executable for 7 days. Two of three recovery keys can
///         replace the primary after 7 days. No owner, admin, upgrade path or pause.
/// @dev    Whitepaper v1.0 sections 3, 7-9 and Appendices A-C. Signatures are over the 32-byte
///         application digest (Appendix C) passed as the message to pure ML-DSA with an empty context.
contract PersonalVault {
    // ------------------------------------------------------------------ types

    enum Status {
        Active,
        Pending
    }

    enum WStatus {
        None,
        Queued,
        Executed,
        Cancelled
    }

    struct KeyRef {
        bytes32 recordId;
        bytes32 keyId;
        address blob;
        bytes32 blobHash;
    }

    struct Withdrawal {
        address asset; // address(0) = native ETH
        address recipient;
        uint256 amount;
        address feeRecipient;
        uint256 feeWei;
        uint64 epoch;
        uint64 executableAt;
        uint64 expiresAt;
        WStatus status;
    }

    struct Proposal {
        bytes32 id; // digest of the accepted start request
        uint8 kind; // KIND_PRIMARY or KIND_RECOVERY_SET
        uint64 executableAt;
        uint64 expiresAt;
        bytes32[3] newRecords; // [newPrimary, 0, 0] or the three new recovery records
    }

    /// Authorization for a signed request: the signed acceptance interval plus signatures.
    struct Auth {
        uint64 validAfter;
        uint64 validUntil;
        bytes sig;
    }

    struct QuorumAuth {
        uint64 validAfter;
        uint64 validUntil;
        uint8[2] signers; // indexes into the current recovery set
        bytes[2] sigs;
    }

    // ------------------------------------------------------------------ immutable wiring

    IMLDSAVerifier public immutable verifier;
    bytes32 public immutable verifierCodehash;
    KeyFactory public immutable keyFactory;

    // ------------------------------------------------------------------ state

    KeyRef private _primary;
    KeyRef[3] private _recovery;
    Status public status;
    uint64 public executionEpoch;
    uint64 public authorityEpoch;
    uint256 public primaryNonce;
    uint256 public controlNonce;

    mapping(bytes32 id => Withdrawal) private _withdrawals;
    mapping(uint64 epoch => uint256) public activeCount;
    Proposal private _proposal;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed from, uint256 amount);
    event WithdrawalScheduled(
        bytes32 indexed id,
        uint64 indexed epoch,
        address asset,
        address recipient,
        uint256 amount,
        address feeRecipient,
        uint256 feeWei,
        uint64 executableAt,
        uint64 expiresAt
    );
    event WithdrawalCancelled(bytes32 indexed id);
    event WithdrawalExecuted(bytes32 indexed id, address indexed executor);
    event WithdrawalPruned(bytes32 indexed id);
    event PendingRequestsInvalidated(uint64 newExecutionEpoch);
    event SecurityChangeStarted(bytes32 indexed id, uint8 kind, bytes32[3] newRecords, uint64 executableAt, uint64 expiresAt);
    event SecurityChangeCancelled(bytes32 indexed id);
    event SecurityChangeFinalized(bytes32 indexed id, uint8 kind, bytes32[3] newRecords);
    event SecurityChangeExpired(bytes32 indexed id);

    // ------------------------------------------------------------------ errors

    error NotActive();
    error NotPending();
    error BadParams();
    error BadInterval();
    error RequestNotAccepted();
    error BadSignature();
    error DuplicateSigner();
    error BadSignerIndex();
    error QueueFull();
    error UnknownWithdrawal();
    error NotQueued();
    error StaleEpoch();
    error TooEarly();
    error Expired();
    error NotExpired();
    error TransferFailed();
    error KeyNotReady();
    error DuplicateKey();
    error Reentrancy();
    error VerifierChanged();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param primaryRecord KeyFactory record id of the primary key
    /// @param recoveryRecords record ids of the three recovery keys
    constructor(KeyFactory keyFactory_, bytes32 primaryRecord, bytes32[3] memory recoveryRecords) {
        keyFactory = keyFactory_;
        verifier = keyFactory_.verifier();
        verifierCodehash = keyFactory_.verifierCodehash();
        _primary = _load(primaryRecord);
        for (uint256 i; i < 3; ++i) {
            _recovery[i] = _load(recoveryRecords[i]);
        }
        bytes32[4] memory ids = [_primary.keyId, _recovery[0].keyId, _recovery[1].keyId, _recovery[2].keyId];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j = i + 1; j < 4; ++j) {
                if (ids[i] == ids[j]) revert DuplicateKey();
            }
        }
    }

    receive() external payable {
        // Deposits are always accepted, including while a security change is pending.
        // Interfaces must warn users not to fund a vault under an unexpected recovery attempt.
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ digests

    /// @notice Appendix C application digest. Clients sign exactly these 32 bytes.
    function actionDigest(uint8 action, uint256 nonce, bytes32 paramsHash, uint64 validAfter, uint64 validUntil)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                C.DOMAIN_TAG,
                C.PROTOCOL_VERSION,
                block.chainid,
                address(this),
                action,
                executionEpoch,
                authorityEpoch,
                nonce,
                paramsHash,
                validAfter,
                validUntil
            )
        );
    }

    function withdrawalParamsHash(address asset, address recipient, uint256 amount, address feeRecipient, uint256 feeWei)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(asset, recipient, amount, feeRecipient, feeWei));
    }

    /// @notice Appendix C: primary recovery commits the proposal kind and the new primary key identifier.
    function recoveryParamsHash(bytes32 newPrimaryKeyId) public pure returns (bytes32) {
        return keccak256(abi.encode(C.KIND_PRIMARY, newPrimaryKeyId));
    }

    /// @notice Appendix C: recovery-set replacement commits the kind and the three new key identifiers, in order.
    function recoverySetParamsHash(bytes32[3] memory newKeyIds) public pure returns (bytes32) {
        return keccak256(abi.encode(C.KIND_RECOVERY_SET, newKeyIds));
    }

    // ------------------------------------------------------------------ withdrawals

    function scheduleWithdrawal(
        address asset,
        address recipient,
        uint256 amount,
        address feeRecipient,
        uint256 feeWei,
        Auth calldata auth
    ) external returns (bytes32 id) {
        if (status != Status.Active) revert NotActive();
        if (amount == 0 || recipient == address(0)) revert BadParams();
        if ((feeWei == 0) != (feeRecipient == address(0))) revert BadParams();
        if (asset != address(0) && asset.code.length == 0) revert BadParams();

        bytes32 paramsHash = withdrawalParamsHash(asset, recipient, amount, feeRecipient, feeWei);
        id = _checkPrimary(C.ACTION_SCHEDULE, paramsHash, auth);
        primaryNonce++; // consumed before any other state change

        uint64 epoch = executionEpoch;
        if (activeCount[epoch] >= C.MAX_ACTIVE_QUEUE) revert QueueFull();
        activeCount[epoch]++;

        uint64 executableAt = uint64(block.timestamp) + C.WITHDRAWAL_DELAY;
        uint64 expiresAt = executableAt + C.WITHDRAWAL_WINDOW;
        _withdrawals[id] = Withdrawal({
            asset: asset,
            recipient: recipient,
            amount: amount,
            feeRecipient: feeRecipient,
            feeWei: feeWei,
            epoch: epoch,
            executableAt: executableAt,
            expiresAt: expiresAt,
            status: WStatus.Queued
        });
        emit WithdrawalScheduled(id, epoch, asset, recipient, amount, feeRecipient, feeWei, executableAt, expiresAt);
    }

    function cancelWithdrawal(bytes32 id, Auth calldata auth) external {
        if (status != Status.Active) revert NotActive();
        Withdrawal storage w = _withdrawals[id];
        if (w.status != WStatus.Queued) revert NotQueued();
        if (w.epoch != executionEpoch) revert StaleEpoch();
        _checkPrimary(C.ACTION_CANCEL, keccak256(abi.encode(id)), auth);
        primaryNonce++;
        w.status = WStatus.Cancelled;
        activeCount[w.epoch]--;
        emit WithdrawalCancelled(id);
    }

    /// @dev Frozen while a security change is pending (section 9): the start already moved the execution
    ///      epoch, so there is nothing left to invalidate, and the primary nonce stays fixed until it closes.
    function invalidatePendingRequests(Auth calldata auth) external {
        if (status != Status.Active) revert NotActive();
        _checkPrimary(C.ACTION_INVALIDATE, keccak256(abi.encode(executionEpoch)), auth);
        primaryNonce++;
        executionEpoch++;
        emit PendingRequestsInvalidated(executionEpoch);
    }

    /// @notice Anyone may execute a mature entry. The whole call reverts if any transfer fails.
    function executeWithdrawal(bytes32 id) external nonReentrant {
        if (status != Status.Active) revert NotActive();
        Withdrawal storage w = _withdrawals[id];
        if (w.status != WStatus.Queued) revert NotQueued();
        if (w.epoch != executionEpoch) revert StaleEpoch();
        if (block.timestamp < w.executableAt) revert TooEarly();
        if (block.timestamp >= w.expiresAt) revert Expired();

        w.status = WStatus.Executed;
        activeCount[w.epoch]--;

        // Transfers use a memory copy: a recipient that re-enters cannot change what is paid next.
        Withdrawal memory m = w;
        if (m.asset == address(0)) {
            _sendEth(m.recipient, m.amount);
        } else {
            _sendToken(m.asset, m.recipient, m.amount);
        }
        if (m.feeWei != 0) _sendEth(m.feeRecipient, m.feeWei);
        emit WithdrawalExecuted(id, msg.sender);
    }

    /// @notice Anyone may remove entries that can never execute again.
    function pruneWithdrawal(bytes32 id) external nonReentrant {
        Withdrawal storage w = _withdrawals[id];
        if (w.status == WStatus.None) revert UnknownWithdrawal();
        bool live = w.status == WStatus.Queued && w.epoch == executionEpoch && block.timestamp < w.expiresAt;
        if (live) revert NotExpired();
        if (w.status == WStatus.Queued && w.epoch == executionEpoch) activeCount[w.epoch]--;
        delete _withdrawals[id];
        emit WithdrawalPruned(id);
    }

    // ------------------------------------------------------------------ security changes

    function startRecovery(bytes32 newPrimaryRecord, QuorumAuth calldata auth) external {
        if (status != Status.Active) revert NotActive();
        KeyRef memory np = _load(newPrimaryRecord);
        _requireFresh(np.keyId, true);

        bytes32 paramsHash = recoveryParamsHash(np.keyId);
        bytes32 id = _checkQuorum(C.ACTION_RECOVERY, paramsHash, auth);
        bytes32[3] memory recs = [newPrimaryRecord, bytes32(0), bytes32(0)];
        _openProposal(id, C.KIND_PRIMARY, recs);
    }

    function startRecoverySetReplacement(bytes32[3] calldata newRecords, Auth calldata primaryAuth, QuorumAuth calldata auth)
        external
    {
        if (status != Status.Active) revert NotActive();
        bytes32[3] memory keyIds;
        for (uint256 i; i < 3; ++i) {
            keyIds[i] = _load(newRecords[i]).keyId;
            if (keyIds[i] == _primary.keyId) revert DuplicateKey();
            for (uint256 j; j < i; ++j) {
                if (keyIds[i] == keyIds[j]) revert DuplicateKey();
            }
        }
        bytes32 paramsHash = recoverySetParamsHash(keyIds);
        // Primary and two recovery keys sign the identical digest (same control nonce).
        if (primaryAuth.validAfter != auth.validAfter || primaryAuth.validUntil != auth.validUntil) revert BadInterval();
        bytes32 id = _checkQuorum(C.ACTION_REPLACE_RECOVERY_SET, paramsHash, auth);
        if (!_verify(_primary, id, primaryAuth.sig)) revert BadSignature();
        _openProposal(id, C.KIND_RECOVERY_SET, newRecords);
    }

    function cancelSecurityChange(QuorumAuth calldata auth) external {
        if (status != Status.Pending) revert NotPending();
        bytes32 pid = _proposal.id;
        _checkQuorum(C.ACTION_CANCEL_SECURITY, keccak256(abi.encode(pid)), auth);
        controlNonce++;
        executionEpoch++;
        _closeProposal();
        emit SecurityChangeCancelled(pid);
    }

    /// @notice Anyone may finalize an eligible proposal. It installs exactly what was committed.
    function finalizeSecurityChange() external {
        if (status != Status.Pending) revert NotPending();
        Proposal memory p = _proposal;
        if (block.timestamp < p.executableAt) revert TooEarly();
        if (block.timestamp >= p.expiresAt) revert Expired();

        if (p.kind == C.KIND_PRIMARY) {
            KeyRef memory np = _load(p.newRecords[0]);
            _requireFresh(np.keyId, true); // re-checked at finalization
            _primary = np;
        } else {
            for (uint256 i; i < 3; ++i) {
                KeyRef memory r = _load(p.newRecords[i]);
                if (r.keyId == _primary.keyId) revert DuplicateKey();
                _recovery[i] = r;
            }
        }
        authorityEpoch++;
        executionEpoch++;
        _closeProposal();
        emit SecurityChangeFinalized(p.id, p.kind, p.newRecords);
    }

    function expireSecurityChange() external {
        if (status != Status.Pending) revert NotPending();
        if (block.timestamp < _proposal.expiresAt) revert NotExpired();
        bytes32 pid = _proposal.id;
        controlNonce++;
        executionEpoch++;
        _closeProposal();
        emit SecurityChangeExpired(pid);
    }

    // ------------------------------------------------------------------ views

    function primary() external view returns (KeyRef memory) {
        return _primary;
    }

    function recoveryKeys() external view returns (KeyRef[3] memory) {
        return _recovery;
    }

    function getWithdrawal(bytes32 id) external view returns (Withdrawal memory) {
        return _withdrawals[id];
    }

    function proposal() external view returns (Proposal memory) {
        return _proposal;
    }

    // ------------------------------------------------------------------ internals

    function _load(bytes32 recordId) internal view returns (KeyRef memory ref) {
        KeyFactory.KeyRecord memory r = keyFactory.getRecord(recordId);
        if (!r.ready) revert KeyNotReady();
        ref = KeyRef({recordId: recordId, keyId: r.keyId, blob: r.blob, blobHash: r.blobHash});
    }

    /// New keys must differ from the current primary (if checkPrimary) and all current recovery keys.
    function _requireFresh(bytes32 keyId, bool checkPrimary) internal view {
        if (checkPrimary && keyId == _primary.keyId) revert DuplicateKey();
        for (uint256 i; i < 3; ++i) {
            if (keyId == _recovery[i].keyId) revert DuplicateKey();
        }
    }

    function _checkInterval(uint64 validAfter, uint64 validUntil) internal view {
        if (validUntil <= validAfter || validUntil - validAfter > C.ACCEPTANCE_MAX) revert BadInterval();
        if (block.timestamp < validAfter || block.timestamp > validUntil) revert RequestNotAccepted();
    }

    function _checkPrimary(uint8 action, bytes32 paramsHash, Auth calldata auth) internal view returns (bytes32 digest) {
        _checkInterval(auth.validAfter, auth.validUntil);
        digest = actionDigest(action, primaryNonce, paramsHash, auth.validAfter, auth.validUntil);
        if (!_verify(_primary, digest, auth.sig)) revert BadSignature();
    }

    function _checkQuorum(uint8 action, bytes32 paramsHash, QuorumAuth calldata auth) internal view returns (bytes32 digest) {
        _checkInterval(auth.validAfter, auth.validUntil);
        if (auth.signers[0] > 2 || auth.signers[1] > 2) revert BadSignerIndex();
        if (auth.signers[0] == auth.signers[1]) revert DuplicateSigner();
        digest = actionDigest(action, controlNonce, paramsHash, auth.validAfter, auth.validUntil);
        for (uint256 i; i < 2; ++i) {
            if (!_verify(_recovery[auth.signers[i]], digest, auth.sigs[i])) revert BadSignature();
        }
    }

    function _openProposal(bytes32 id, uint8 kind, bytes32[3] memory recs) internal {
        controlNonce++;
        executionEpoch++; // freezes and invalidates every old request
        status = Status.Pending;
        uint64 executableAt = uint64(block.timestamp) + C.SECURITY_DELAY;
        uint64 expiresAt = uint64(block.timestamp) + C.SECURITY_DELAY + C.SECURITY_WINDOW;
        _proposal = Proposal({id: id, kind: kind, executableAt: executableAt, expiresAt: expiresAt, newRecords: recs});
        emit SecurityChangeStarted(id, kind, recs, executableAt, expiresAt);
    }

    function _closeProposal() internal {
        delete _proposal;
        status = Status.Active;
    }

    function _verify(KeyRef memory key, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (sig.length != C.SIG_LENGTH) return false;
        if (address(verifier).codehash != verifierCodehash) revert VerifierChanged();
        if (key.blob.codehash != key.blobHash) return false;
        (bool ok, bytes memory ret) =
            address(verifier).staticcall(abi.encodeCall(IMLDSAVerifier.verify, (key.blob, abi.encodePacked(digest), sig)));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _sendToken(address token, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TransferFailed(); // a call to an empty account would "succeed"
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }
}
