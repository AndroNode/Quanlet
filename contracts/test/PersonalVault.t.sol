// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {KeyFactory} from "../src/KeyFactory.sol";
import {IMLDSAVerifier} from "../src/verifier/IMLDSAVerifier.sol";
import {PersonalVault} from "../src/PersonalVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {QuanletConstants as C} from "../src/QuanletConstants.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract Reenterer {
    PersonalVault public vault;
    bytes32 public id;

    function arm(PersonalVault v, bytes32 i) external {
        vault = v;
        id = i;
    }

    receive() external payable {
        vault.executeWithdrawal(id); // must fail; the whole execution reverts
    }
}

/// Recipient that deletes its own entry mid-execution, trying to skip the relay fee read afterwards.
contract FeeDodger {
    PersonalVault v;
    bytes32 id;

    function arm(PersonalVault v_, bytes32 id_) external {
        v = v_;
        id = id_;
    }

    receive() external payable {
        if (address(v) != address(0)) {
            (bool ok,) = address(v).call(abi.encodeCall(PersonalVault.pruneWithdrawal, (id)));
            ok;
        }
    }
}

/// USDT-style token: transfer returns nothing. `fail` makes it return false instead (or revert).
contract OddToken {
    mapping(address => uint256) public balanceOf;
    uint8 public mode; // 0 = no return value, 1 = returns false, 2 = reverts

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function transfer(address to, uint256 amt) external {
        if (mode == 2) revert("no");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        if (mode == 1) {
            assembly {
                mstore(0, 0)
                return(0, 32)
            }
        }
    }
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract KeyFactoryTest is Base {
    function test_RegisterKeyAndRecord() public {
        bytes32 rec = register(P1);
        KeyFactory.KeyRecord memory r = keys.getRecord(rec);
        assertTrue(r.ready);
        assertEq(r.prepVersion, 1);
        assertEq(r.blob.codehash, r.blobHash);
        assertEq(keys.recordOfKey(r.keyId), rec);
        // The deployed blob is byte-for-byte the off-chain prepare.py output.
        bytes memory pk = pkOf(P1);
        assertEq(keccak256(r.blob.code), keccak256(blobOf(pk)));
    }

    /// Differential test: on-chain preparation equals script/prepare.py on several real keys.
    function test_OnChainPreparationMatchesPrepareScript() public {
        bytes32[5] memory seeds = [P1, R1, R2, R3, N1];
        for (uint256 i; i < seeds.length; ++i) {
            bytes memory pk = pkOf(seeds[i]);
            assertEq(keys.preparedBlobOf(pk), blobOf(pk));
        }
    }

    function testFuzz_OnChainPreparationMatchesPrepareScript(bytes32 seed) public {
        bytes memory pk = pkOf(seed);
        assertEq(keccak256(keys.preparedBlobOf(pk)), keccak256(blobOf(pk)));
    }

    function test_GasOfRegistration() public {
        bytes memory pk = pkOf(N2);
        bytes32 keyId = keys.keyIdOf(pk);
        bytes memory pop = sign(N2, keys.popMessage(keyId, keccak256(blobOf(pk))));
        uint256 g = gasleft();
        bytes memory blob = keys.preparedBlobOf(pk);
        uint256 prep = g - gasleft();
        g = gasleft();
        keys.registerKey(pk, pop);
        uint256 total = g - gasleft();
        emit log_named_uint("preparation only (view)", prep);
        emit log_named_uint("registerKey total", total);
        assertEq(blob.length, 20545);
        assertLt(total, 16_000_000);
    }

    function test_RejectsWrongProofOfPossession() public {
        bytes memory pk = pkOf(R1);
        bytes memory blob = blobOf(pk);
        bytes memory pop = sign(R2, keys.popMessage(keys.keyIdOf(pk), keccak256(blob))); // wrong key
        vm.expectRevert(KeyFactory.BadProofOfPossession.selector);
        keys.registerKey(pk, pop);
    }

    function test_RejectsProofOverAnotherBlob() public {
        bytes memory pk = pkOf(R1);
        bytes memory blob = blobOf(pk);
        blob[100] = bytes1(uint8(blob[100]) ^ 1); // a tampered preparation
        bytes memory pop = sign(R1, keys.popMessage(keys.keyIdOf(pk), keccak256(blob)));
        vm.expectRevert(KeyFactory.BadProofOfPossession.selector);
        keys.registerKey(pk, pop);
    }

    function test_RejectsDuplicateRegistration() public {
        register(P1);
        bytes memory pk = pkOf(P1);
        bytes memory blob = blobOf(pk);
        bytes memory pop = sign(P1, keys.popMessage(keys.keyIdOf(pk), keccak256(blob)));
        vm.expectRevert(KeyFactory.AlreadyRegistered.selector);
        keys.registerKey(pk, pop);
    }

    function test_RejectsDegenerateKey() public {
        bytes memory pk = new bytes(1312); // t1 = 0 everywhere: the forgeable case
        vm.expectRevert(KeyFactory.DegenerateKey.selector);
        keys.registerKey(pk, new bytes(2420));
    }

    function test_RejectsBadLengths() public {
        vm.expectRevert(KeyFactory.BadPublicKeyLength.selector);
        keys.registerKey(new bytes(1311), new bytes(2420));
        vm.expectRevert(KeyFactory.BadPublicKeyLength.selector);
        keys.preparedBlobOf(new bytes(1313));
    }

    function test_RejectsWrongHelper() public {
        vm.expectRevert(KeyFactory.BadHelper.selector);
        new KeyFactory(IMLDSAVerifier(address(verifier)), address(this));
    }
}

contract PersonalVaultTest is Base {
    PersonalVault v;
    address constant ALICE = address(0xA11CE);
    address constant RELAY = address(0xFEE);

    function setUp() public override {
        super.setUp();
        v = createVault(P1, R1, R2, R3);
        vm.deal(address(v), 10 ether);
        register(N1);
    }

    function _schedule(uint256 amount, uint256 fee) internal returns (bytes32) {
        address feeTo = fee == 0 ? address(0) : RELAY;
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, amount, feeTo, fee);
        PersonalVault.Auth memory a = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph);
        return v.scheduleWithdrawal(address(0), ALICE, amount, feeTo, fee, a);
    }

    // ---------------------------------------------------------------- setup

    function test_SetupRejectsDuplicateKeys() public {
        bytes32 pr = register(P1);
        bytes32[3] memory rr = [register(R1), register(R1), register(R3)];
        uint64 a = uint64(vm.getBlockTimestamp());
        bytes memory sig = sign(P1, factory.setupDigest(pr, rr, bytes32("x"), a, a + 60));
        vm.expectRevert(PersonalVault.DuplicateKey.selector);
        factory.createVault(pr, rr, bytes32("x"), a, a + 60, sig);
    }

    function test_SetupNeedsPrimarySignature() public {
        bytes32 pr = register(P1);
        bytes32[3] memory rr = [register(R1), register(R2), register(R3)];
        uint64 a = uint64(vm.getBlockTimestamp());
        bytes memory sig = sign(R1, factory.setupDigest(pr, rr, bytes32("y"), a, a + 60));
        vm.expectRevert(VaultFactory.BadSetupSignature.selector);
        factory.createVault(pr, rr, bytes32("y"), a, a + 60, sig);
    }

    function test_DeterministicAddress() public view {
        bytes32[3] memory rr = [recordOf[R1], recordOf[R2], recordOf[R3]];
        assertEq(factory.predictAddress(recordOf[P1], rr, keccak256("test-vault")), address(v));
    }

    // ---------------------------------------------------------------- authorization

    function test_NoAuthorityFromSenderOrForeignKey() public {
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, 1 ether, address(0), 0);
        PersonalVault.Auth memory a = primaryAuth(v, R1, C.ACTION_SCHEDULE, ph); // not the primary
        vm.expectRevert(PersonalVault.BadSignature.selector);
        v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, a);
    }

    function test_SignatureBindsExactParams() public {
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, 1 ether, address(0), 0);
        PersonalVault.Auth memory a = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph);
        vm.expectRevert(PersonalVault.BadSignature.selector);
        v.scheduleWithdrawal(address(0), ALICE, 2 ether, address(0), 0, a); // amount changed by relayer
    }

    function test_ReplayRejected() public {
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, 1 ether, address(0), 0);
        PersonalVault.Auth memory a = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph);
        v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, a);
        vm.expectRevert(PersonalVault.BadSignature.selector); // nonce advanced
        v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, a);
    }

    function test_AcceptanceIntervalRules() public {
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, 1 ether, address(0), 0);
        PersonalVault.Auth memory a = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph);
        vm.warp(vm.getBlockTimestamp() + 1801);
        vm.expectRevert(PersonalVault.RequestNotAccepted.selector);
        v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, a);

        a.validUntil = a.validAfter + 1801;
        vm.expectRevert(PersonalVault.BadInterval.selector);
        v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, a);
    }

    function test_ParamRules() public {
        PersonalVault.Auth memory a;
        vm.expectRevert(PersonalVault.BadParams.selector);
        v.scheduleWithdrawal(address(0), ALICE, 0, address(0), 0, a);
        vm.expectRevert(PersonalVault.BadParams.selector);
        v.scheduleWithdrawal(address(0), address(0), 1, address(0), 0, a);
        vm.expectRevert(PersonalVault.BadParams.selector);
        v.scheduleWithdrawal(address(0), ALICE, 1, address(0), 5, a); // fee without recipient
        vm.expectRevert(PersonalVault.BadParams.selector);
        v.scheduleWithdrawal(address(0), ALICE, 1, RELAY, 0, a); // zero fee with recipient
    }

    // ---------------------------------------------------------------- timing and execution

    function test_DelayAndWindowBoundaries() public {
        uint256 t0 = vm.getBlockTimestamp();
        bytes32 id = _schedule(1 ether, 0.00002 ether);
        assertEq(address(v).balance, 10 ether, "scheduling moves nothing");

        vm.warp(t0 + 86_400 - 1);
        vm.expectRevert(PersonalVault.TooEarly.selector);
        v.executeWithdrawal(id);

        vm.warp(t0 + 86_400);
        uint256 snap = vm.snapshotState();
        vm.prank(address(0xBEEF)); // anyone may execute
        v.executeWithdrawal(id);
        assertEq(ALICE.balance, 1 ether);
        assertEq(RELAY.balance, 0.00002 ether);
        vm.expectRevert(PersonalVault.NotQueued.selector);
        v.executeWithdrawal(id);

        vm.revertToState(snap);
        vm.warp(t0 + 86_400 + 604_800);
        vm.expectRevert(PersonalVault.Expired.selector);
        v.executeWithdrawal(id);
        v.pruneWithdrawal(id);
        assertEq(v.activeCount(0), 0);
    }

    function test_InsufficientBalanceRevertsAtomically() public {
        bytes32 id = _schedule(11 ether, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(PersonalVault.TransferFailed.selector);
        v.executeWithdrawal(id);
        vm.deal(address(v), 12 ether); // can retry within the window
        v.executeWithdrawal(id);
        assertEq(ALICE.balance, 11 ether);
    }

    function test_ReentrancyCannotDoubleSpend() public {
        Reenterer r = new Reenterer();
        bytes32 ph = v.withdrawalParamsHash(address(0), address(r), 1 ether, address(0), 0);
        bytes32 id = v.scheduleWithdrawal(address(0), address(r), 1 ether, address(0), 0, primaryAuth(v, P1, C.ACTION_SCHEDULE, ph));
        r.arm(v, id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(PersonalVault.TransferFailed.selector);
        v.executeWithdrawal(id);
        assertEq(address(v).balance, 10 ether);
    }

    function test_RecipientCannotSkipRelayFee() public {
        FeeDodger r = new FeeDodger();
        address relay = address(0xFEE);
        bytes32 ph = v.withdrawalParamsHash(address(0), address(r), 1 ether, relay, 0.01 ether);
        bytes32 id = v.scheduleWithdrawal(address(0), address(r), 1 ether, relay, 0.01 ether, primaryAuth(v, P1, C.ACTION_SCHEDULE, ph));
        r.arm(v, id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        v.executeWithdrawal(id);
        assertEq(address(r).balance, 1 ether);
        assertEq(relay.balance, 0.01 ether, "relay fee skipped");
        assertEq(address(v).balance, 10 ether - 1.01 ether);
    }

    function test_Erc20ReturnVariants() public {
        OddToken t = new OddToken();
        t.mint(address(v), 300e6);
        bytes32[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            bytes32 ph = v.withdrawalParamsHash(address(t), ALICE, 100e6, address(0), 0);
            ids[i] = v.scheduleWithdrawal(address(t), ALICE, 100e6, address(0), 0, primaryAuth(v, P1, C.ACTION_SCHEDULE, ph));
        }
        vm.warp(vm.getBlockTimestamp() + 1 days);
        v.executeWithdrawal(ids[0]); // no return value: accepted
        assertEq(t.balanceOf(ALICE), 100e6);
        t.setMode(1); // returns false: refused, nothing moves
        vm.expectRevert(PersonalVault.TransferFailed.selector);
        v.executeWithdrawal(ids[1]);
        t.setMode(2); // reverts: refused
        vm.expectRevert(PersonalVault.TransferFailed.selector);
        v.executeWithdrawal(ids[2]);
        assertEq(t.balanceOf(address(v)), 200e6);
        // An asset whose code vanished after scheduling is refused, not silently "paid".
        t.setMode(0);
        vm.etch(address(t), "");
        vm.expectRevert(PersonalVault.TransferFailed.selector);
        v.executeWithdrawal(ids[1]);
    }

    function test_FeeFailureRevertsTransfer() public {
        Rejecter bad = new Rejecter();
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, 1 ether, address(bad), 1);
        bytes32 id = v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(bad), 1, primaryAuth(v, P1, C.ACTION_SCHEDULE, ph));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(PersonalVault.TransferFailed.selector);
        v.executeWithdrawal(id);
        assertEq(ALICE.balance, 0);
    }

    function test_Erc20Withdrawal() public {
        MockToken t = new MockToken();
        t.mint(address(v), 500e6);
        bytes32 ph = v.withdrawalParamsHash(address(t), ALICE, 100e6, address(0), 0);
        bytes32 id = v.scheduleWithdrawal(address(t), ALICE, 100e6, address(0), 0, primaryAuth(v, P1, C.ACTION_SCHEDULE, ph));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        v.executeWithdrawal(id);
        assertEq(t.balanceOf(ALICE), 100e6);
    }

    // ---------------------------------------------------------------- cancel, invalidate, queue cap

    function test_CancelAndInvalidate() public {
        bytes32 id1 = _schedule(1 ether, 0);
        bytes32 id2 = _schedule(2 ether, 0);
        v.cancelWithdrawal(id1, primaryAuth(v, P1, C.ACTION_CANCEL, keccak256(abi.encode(id1))));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(PersonalVault.NotQueued.selector);
        v.executeWithdrawal(id1);

        v.invalidatePendingRequests(primaryAuth(v, P1, C.ACTION_INVALIDATE, keccak256(abi.encode(uint64(0)))));
        assertEq(v.executionEpoch(), 1);
        vm.expectRevert(PersonalVault.StaleEpoch.selector);
        v.executeWithdrawal(id2);
        assertEq(address(v).balance, 10 ether);
    }

    function test_QueueCapIs32() public {
        for (uint256 i = 1; i <= 32; ++i) _schedule(i, 0);
        bytes32 ph = v.withdrawalParamsHash(address(0), ALICE, 999, address(0), 0);
        PersonalVault.Auth memory a = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph);
        vm.expectRevert(PersonalVault.QueueFull.selector);
        v.scheduleWithdrawal(address(0), ALICE, 999, address(0), 0, a);
    }

    // ---------------------------------------------------------------- recovery

    function test_RecoveryLifecycle() public {
        uint256 t0 = vm.getBlockTimestamp();
        bytes32 old = _schedule(1 ether, 0);
        bytes32 nr = recordOf[N1];
        bytes32 ph = v.recoveryParamsHash(kid(nr));

        // duplicate signer index rejected
        PersonalVault.QuorumAuth memory dup = quorumAuth(v, R1, 0, R1, 0, C.ACTION_RECOVERY, ph);
        vm.expectRevert(PersonalVault.DuplicateSigner.selector);
        v.startRecovery(nr, dup);

        v.startRecovery(nr, quorumAuth(v, R1, 0, R3, 2, C.ACTION_RECOVERY, ph));
        assertEq(uint8(v.status()), uint8(PersonalVault.Status.Pending));

        // frozen: no execution, no new scheduling, deposits still arrive
        vm.warp(t0 + 1 days);
        vm.expectRevert(PersonalVault.NotActive.selector);
        v.executeWithdrawal(old);
        (bool ok,) = address(v).call{value: 1 wei}("");
        assertTrue(ok);

        vm.warp(t0 + 7 days - 1);
        vm.expectRevert(PersonalVault.TooEarly.selector);
        v.finalizeSecurityChange();

        uint256 snap = vm.snapshotState();
        vm.warp(t0 + 7 days);
        v.finalizeSecurityChange();
        assertEq(v.primary().recordId, nr);
        assertEq(v.authorityEpoch(), 1);
        vm.expectRevert(PersonalVault.StaleEpoch.selector);
        v.executeWithdrawal(old);
        // old primary is powerless; new primary still waits 24 h
        bytes32 ph2 = v.withdrawalParamsHash(address(0), ALICE, 1 ether, address(0), 0);
        PersonalVault.Auth memory oldAuth = primaryAuth(v, P1, C.ACTION_SCHEDULE, ph2);
        vm.expectRevert(PersonalVault.BadSignature.selector);
        v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, oldAuth);
        bytes32 nid = v.scheduleWithdrawal(address(0), ALICE, 1 ether, address(0), 0, primaryAuth(v, N1, C.ACTION_SCHEDULE, ph2));
        vm.expectRevert(PersonalVault.TooEarly.selector);
        v.executeWithdrawal(nid);

        vm.revertToState(snap);
        vm.warp(t0 + 14 days);
        vm.expectRevert(PersonalVault.Expired.selector);
        v.finalizeSecurityChange();
        v.expireSecurityChange();
        assertEq(uint8(v.status()), uint8(PersonalVault.Status.Active));
        vm.expectRevert(PersonalVault.StaleEpoch.selector);
        v.executeWithdrawal(old);
    }

    function test_RecoveryRejectsExistingKeyAndSecondProposal() public {
        bytes32 r3 = recordOf[R3];
        bytes32 ph = v.recoveryParamsHash(kid(r3));
        PersonalVault.QuorumAuth memory q = quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, ph);
        vm.expectRevert(PersonalVault.DuplicateKey.selector);
        v.startRecovery(r3, q);

        bytes32 nr = recordOf[N1];
        bytes32 ph1 = v.recoveryParamsHash(kid(nr));
        v.startRecovery(nr, quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, ph1));
        PersonalVault.QuorumAuth memory again = quorumAuth(v, R2, 1, R3, 2, C.ACTION_RECOVERY, ph1);
        vm.expectRevert(PersonalVault.NotActive.selector);
        v.startRecovery(nr, again);
    }

    function test_QuorumCancelsAndPrimaryCannot() public {
        bytes32 nr = recordOf[N1];
        v.startRecovery(nr, quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, v.recoveryParamsHash(kid(nr))));
        bytes32 pid = v.proposal().id;
        v.cancelSecurityChange(quorumAuth(v, R2, 1, R3, 2, C.ACTION_CANCEL_SECURITY, keccak256(abi.encode(pid))));
        assertEq(uint8(v.status()), uint8(PersonalVault.Status.Active));
        assertEq(v.primary().recordId, recordOf[P1]);
    }

    function test_RecoverySetReplacement() public {
        bytes32[3] memory nrs = [recordOf[N1], register(N2), register(N3)];
        bytes32 ph = v.recoverySetParamsHash([kid(nrs[0]), kid(nrs[1]), kid(nrs[2])]);
        PersonalVault.QuorumAuth memory q = quorumAuth(v, R1, 0, R2, 1, C.ACTION_REPLACE_RECOVERY_SET, ph);
        PersonalVault.Auth memory p;
        p.validAfter = q.validAfter;
        p.validUntil = q.validUntil;
        p.sig = sign(P1, v.actionDigest(C.ACTION_REPLACE_RECOVERY_SET, v.controlNonce(), ph, q.validAfter, q.validUntil));
        v.startRecoverySetReplacement(nrs, p, q);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        v.finalizeSecurityChange();
        assertEq(v.recoveryKeys()[0].recordId, recordOf[N1]);

        // old guardians can no longer start recovery
        bytes32 ph2 = v.recoveryParamsHash(kid(recordOf[R1]));
        PersonalVault.QuorumAuth memory stale = quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, ph2);
        vm.expectRevert(PersonalVault.BadSignature.selector);
        v.startRecovery(recordOf[R1], stale);
    }
    /// C2: recovery commits key identifiers (Appendix C), so a quorum signature over the record id is refused.
    function test_RecoveryCommitsKeyIdNotRecordId() public {
        bytes32 nr = recordOf[N1];
        bytes32 wrong = keccak256(abi.encode(C.KIND_PRIMARY, nr));
        PersonalVault.QuorumAuth memory q = quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, wrong);
        vm.expectRevert(PersonalVault.BadSignature.selector);
        v.startRecovery(nr, q);
        assertEq(v.recoveryParamsHash(kid(nr)), keccak256(abi.encode(uint8(1), keys.getRecord(nr).keyId)));
    }

    /// C3: while a security change is pending the primary can neither invalidate nor cancel (section 9 freeze).
    function test_PrimaryFrozenWhilePending() public {
        bytes32 old = _schedule(1 ether, 0);
        bytes32 nr = recordOf[N1];
        PersonalVault.Auth memory inv = primaryAuth(v, P1, C.ACTION_INVALIDATE, keccak256(abi.encode(uint64(0))));
        PersonalVault.Auth memory can = primaryAuth(v, P1, C.ACTION_CANCEL, keccak256(abi.encode(old)));
        v.startRecovery(nr, quorumAuth(v, R1, 0, R2, 1, C.ACTION_RECOVERY, v.recoveryParamsHash(kid(nr))));
        uint256 nonceBefore = v.primaryNonce();
        vm.expectRevert(PersonalVault.NotActive.selector);
        v.invalidatePendingRequests(inv);
        vm.expectRevert(PersonalVault.NotActive.selector);
        v.cancelWithdrawal(old, can);
        assertEq(v.primaryNonce(), nonceBefore);
        // Guardian cancellation still works after the execution epoch moved at recovery start.
        bytes32 pid = v.proposal().id;
        v.cancelSecurityChange(quorumAuth(v, R2, 1, R3, 2, C.ACTION_CANCEL_SECURITY, keccak256(abi.encode(pid))));
        assertEq(uint8(v.status()), uint8(PersonalVault.Status.Active));
        vm.expectRevert(PersonalVault.StaleEpoch.selector);
        v.executeWithdrawal(old);
    }
}
