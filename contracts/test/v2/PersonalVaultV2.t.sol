// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseV2} from "./BaseV2.t.sol";
import {KeyFactoryV2} from "../../src/v2/KeyFactoryV2.sol";
import {VaultFactoryV2} from "../../src/v2/VaultFactoryV2.sol";
import {PersonalVaultV2} from "../../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy, AssetRule} from "../../src/v2/QuanletV2.sol";

contract Reenter {
    PersonalVaultV2 internal v;
    bytes32 internal id;
    bool internal tried;
    bool public blocked;

    function arm(PersonalVaultV2 v_, bytes32 id_) external {
        v = v_;
        id = id_;
    }

    receive() external payable {
        if (!tried && address(v) != address(0)) {
            tried = true;
            try v.executeWithdrawal(id) {} catch {
                blocked = true;
            }
        }
    }
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract KeyFactoryV2Test is BaseV2 {
    function test_RegisterThenActivate() public {
        bytes memory pk = pkOf(N1);
        bytes32 id = keys.registerKey(pk);
        assertEq(id, keccak256(abi.encode(keccak256("QUANLET_ML_DSA_44_FIPS204"), pk)));
        KeyFactoryV2.KeyRecord memory r = keys.getRecord(id);
        assertFalse(r.ready);
        assertEq(r.blob.codehash, r.blobHash);
        uint64 a = uint64(block.timestamp);
        keys.activateKey(id, a, a + 1800, sign(N1, keys.registrationDigest(id, a, a + 1800)));
        assertTrue(keys.getRecord(id).ready);
    }

    function test_ActivationNeedsTheKeyAndAFreshWindow() public {
        bytes32 id = keys.registerKey(pkOf(N1));
        uint64 a = uint64(block.timestamp);
        bytes memory wrong = sign(N2, keys.registrationDigest(id, a, a + 600));
        vm.expectRevert(KeyFactoryV2.BadProofOfPossession.selector);
        keys.activateKey(id, a, a + 600, wrong);
        bytes memory longSig = sign(N1, keys.registrationDigest(id, a, a + 1801));
        vm.expectRevert(KeyFactoryV2.BadInterval.selector);
        keys.activateKey(id, a, a + 1801, longSig);
        bytes memory late = sign(N1, keys.registrationDigest(id, a, a + 600));
        vm.warp(a + 600); // validUntil is exclusive
        vm.expectRevert(KeyFactoryV2.RequestNotAccepted.selector);
        keys.activateKey(id, a, a + 600, late);
    }

    function test_DuplicateRegistrationRejected() public {
        reg(N1);
        bytes memory pk = pkOf(N1);
        vm.expectRevert(KeyFactoryV2.AlreadyRegistered.selector);
        keys.registerKey(pk);
    }

    function test_BlobMatchesOffchainPreparation() public {
        bytes memory pk = pkOf(N1);
        bytes32 id = keys.registerKey(pk);
        string[] memory cmd = new string[](3);
        cmd[0] = "sh";
        cmd[1] = "test/ffi/blob.sh";
        cmd[2] = vm.toString(pk);
        assertEq(keys.getRecord(id).blobHash, keccak256(vm.ffi(cmd)));
    }
}

contract SetupV2Test is BaseV2 {
    function test_FiveConsentSetupDeploysConfiguredVault() public {
        PersonalVaultV2 v = createVault(guarded());
        PersonalVaultV2.KeyRef[5] memory r = v.roles();
        assertEq(r[0].keyId, reg(P));
        assertEq(r[4].keyId, reg(G3));
        assertEq(v.authorityEpoch(), 1);
        assertEq(v.policyEpoch(), 1);
        assertEq(v.executionEpoch(), 1);
        assertEq(v.protectedDelay(), 0);
        assertFalse(v.fastEnabled());
        assertFalse(v.fastSuspended());
        assertEq(v.policyHash(), keccak256(abi.encode(guarded())));
        assertEq(keccak256(abi.encode(v.getPolicy())), v.policyHash());
        for (uint8 l = 1; l <= 5; ++l) assertEq(v.nonceOf(l), 0);
    }

    function test_SetupNeedsAllFiveSignatures() public {
        bytes32[5] memory ids = roleIds();
        Policy memory p = guarded();
        bytes32 salt = keccak256("s");
        uint64 a = uint64(block.timestamp);
        bytes32 d = factory.setupDigest(ids, p, salt, a, a + 600);
        bytes[5] memory sigs = [sign(P, d), sign(A, d), sign(G1, d), sign(G2, d), sign(N1, d)];
        vm.expectRevert(VaultFactoryV2.BadSetupSignature.selector);
        factory.createVaultV2(ids, p, salt, a, a + 600, sigs);
    }

    function test_SetupRejectsDuplicateRoles() public {
        bytes32[5] memory ids = roleIds();
        ids[4] = ids[2];
        uint64 a = uint64(block.timestamp);
        bytes[5] memory sigs;
        vm.expectRevert(VaultFactoryV2.DuplicateKey.selector);
        factory.createVaultV2(ids, guarded(), keccak256("s"), a, a + 600, sigs);
    }

    function test_CopiedSetupCannotRedeploy() public {
        bytes32[5] memory ids = roleIds();
        Policy memory p = guarded();
        bytes32 salt = keccak256("s");
        uint64 a = uint64(block.timestamp);
        bytes32 d = factory.setupDigest(ids, p, salt, a, a + 600);
        bytes[5] memory sigs = [sign(P, d), sign(A, d), sign(G1, d), sign(G2, d), sign(G3, d)];
        address v = factory.createVaultV2(ids, p, salt, a, a + 600, sigs);
        assertEq(v, factory.predictAddress(ids, p, salt));
        vm.expectRevert(VaultFactoryV2.AlreadyDeployed.selector);
        factory.createVaultV2(ids, p, salt, a, a + 600, sigs);
        // The same signatures cannot configure anything else: another salt or policy changes the digest.
        vm.expectRevert(VaultFactoryV2.BadSetupSignature.selector);
        factory.createVaultV2(ids, p, keccak256("other"), a, a + 600, sigs);
    }

    function test_SetupRejectsUnactivatedKeys() public {
        bytes32[5] memory ids = roleIds();
        ids[1] = keys.registerKey(pkOf(N1)); // registered, never activated
        uint64 a = uint64(block.timestamp);
        bytes32 d = factory.setupDigest(ids, guarded(), keccak256("s"), a, a + 600);
        bytes[5] memory sigs = [sign(P, d), sign(N1, d), sign(G1, d), sign(G2, d), sign(G3, d)];
        vm.expectRevert(VaultFactoryV2.KeyNotReady.selector);
        factory.createVaultV2(ids, guarded(), keccak256("s"), a, a + 600, sigs);
    }

    function test_SetupRejectsInvalidPolicy() public {
        Policy memory p = guardedWithDelay(7_200); // not an allowed delay
        bytes32[5] memory ids = roleIds();
        uint64 a = uint64(block.timestamp);
        bytes32 d = factory.setupDigest(ids, p, keccak256("s"), a, a + 600);
        bytes[5] memory sigs = [sign(P, d), sign(A, d), sign(G1, d), sign(G2, d), sign(G3, d)];
        vm.expectRevert(); // constructor reverts BadPolicy -> create2 returns 0
        factory.createVaultV2(ids, p, keccak256("s"), a, a + 600, sigs);
    }
}

contract TransfersV2Test is BaseV2 {
    PersonalVaultV2 internal v;

    function setUp() public override {
        super.setUp();
        v = createVault(guarded());
        vm.deal(address(v), 10 ether);
    }

    function test_GuardedProtectedExecutesImmediately() public {
        protectedTx(v, ETH, alice, 0.5 ether, relay, 0.001 ether);
        assertEq(alice.balance, 0.5 ether);
        assertEq(relay.balance, 0.001 ether);
        assertEq(v.nonceOf(C.LANE_SPEND), 1);
    }

    function test_MissingApproverAlwaysRejected() public {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, alice, 1 ether, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.submitTransfer(t, w, ps, "");
        // P twice is not P + A.
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.submitTransfer(t, w, ps, ps);
    }

    function test_FastDisabledByDefault() public {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_FAST, ETH, alice, 1, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        bytes memory ps = sign(P, digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w));
        vm.expectRevert(PersonalVaultV2.FastUnavailable.selector);
        v.submitTransfer(t, w, ps, "");
    }

    function test_SignatureBindsRouteRecipientAmountAndFee() public {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, alice, 1 ether, relay, 0.001 ether);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        bytes memory as_ = sign(A, d);
        PersonalVaultV2.Transfer memory t2 = xfer(C.ROUTE_PROTECTED, ETH, bob, 1 ether, relay, 0.001 ether);
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.submitTransfer(t2, w, ps, as_);
        t2 = xfer(C.ROUTE_PROTECTED, ETH, alice, 1 ether, relay, 0.002 ether);
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.submitTransfer(t2, w, ps, as_);
        // A relay cannot downgrade the route to FAST with P's signature alone.
        t2 = xfer(C.ROUTE_FAST, ETH, alice, 1 ether, relay, 0.001 ether);
        vm.expectRevert();
        v.submitTransfer(t2, w, ps, "");
        v.submitTransfer(t, w, ps, as_);
        vm.expectRevert(PersonalVaultV2.BadSignature.selector); // replay: nonce consumed
        v.submitTransfer(t, w, ps, as_);
    }

    function test_FeeShapeRules() public {
        PersonalVaultV2.Window memory w = win();
        bytes memory none;
        vm.expectRevert(PersonalVaultV2.BadParams.selector);
        v.submitTransfer(xfer(C.ROUTE_PROTECTED, ETH, alice, 1, relay, 0), w, none, none);
        vm.expectRevert(PersonalVaultV2.BadParams.selector);
        v.submitTransfer(xfer(C.ROUTE_PROTECTED, ETH, alice, 1, address(v), 1), w, none, none);
        vm.expectRevert(PersonalVaultV2.BadParams.selector);
        v.submitTransfer(xfer(C.ROUTE_PROTECTED, ETH, address(v), 1, address(0), 0), w, none, none);
        vm.expectRevert(PersonalVaultV2.BadParams.selector); // unsupported asset (ETH-only profile)
        v.submitTransfer(xfer(C.ROUTE_PROTECTED, address(0xdead), alice, 1, address(0), 0), w, none, none);
    }

    function test_SignatureWindowBoundaries() public {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, alice, 1, address(0), 0);
        PersonalVaultV2.Window memory w = PersonalVaultV2.Window(uint64(block.timestamp) + 10, uint64(block.timestamp) + 70);
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        bytes memory as_ = sign(A, d);
        vm.expectRevert(PersonalVaultV2.RequestNotAccepted.selector);
        v.submitTransfer(t, w, ps, as_);
        vm.warp(w.validUntil);
        vm.expectRevert(PersonalVaultV2.RequestNotAccepted.selector);
        v.submitTransfer(t, w, ps, as_);
        vm.warp(w.validUntil - 1);
        v.submitTransfer(t, w, ps, as_);
    }

    function test_FailedTransferRevertsEverything() public {
        Rejecter r = new Rejecter();
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, alice, 1 ether, address(r), 0.01 ether);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        bytes memory as_ = sign(A, d);
        vm.expectRevert(PersonalVaultV2.TransferFailed.selector);
        v.submitTransfer(t, w, ps, as_);
        assertEq(alice.balance, 0);
        assertEq(v.nonceOf(C.LANE_SPEND), 0);
    }
}

contract FastV2Test is BaseV2 {
    PersonalVaultV2 internal v;

    function setUp() public override {
        super.setUp();
        v = createVault(flexible(0.10 ether, 0.05 ether, 7 days, 0, 0.002 ether));
        vm.deal(address(v), 10 ether);
    }

    /// The whitepaper's worked example (section 08).
    function test_WorkedExample() public {
        fast(v, alice, 0.04 ether, relay, 0.001 ether);
        fast(v, alice, 0.04 ether, relay, 0.001 ether);
        (uint256 rem,,,) = v.getRemaining(ETH);
        assertEq(rem, 0.018 ether);
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.02 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.AllowanceExceeded.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
        vm.warp(block.timestamp + 3 days); // waiting does not help
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.02 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.AllowanceExceeded.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
        // A protected transfer does not refill FAST, and neither does a deposit.
        protectedTx(v, ETH, bob, 0.5 ether, address(0), 0);
        vm.deal(address(v), 100 ether);
        (rem,,,) = v.getRemaining(ETH);
        assertEq(rem, 0.018 ether);
        assertEq(v.spent(ETH), 0.082 ether);
    }

    function test_SplittingCannotExceedCeiling() public {
        uint256 paid;
        for (uint256 i; i < 12; ++i) {
            try this.fastExt(0.01 ether) {
                paid += 0.01 ether;
            } catch {}
        }
        assertEq(paid, 0.10 ether);
        assertEq(alice.balance, 0.10 ether);
    }

    function fastExt(uint256 amount) external {
        fast(v, alice, amount, address(0), 0);
    }

    function test_PerActionCapAndRecipients() public {
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.05 ether, relay, 0.001 ether);
            vm.expectRevert(PersonalVaultV2.AllowanceExceeded.selector);
            v.submitTransfer(ft, fw, fs, "");
        } // debit 0.051 > cap 0.05
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, address(0xC0FFEE), 0.01 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.RecipientNotAllowed.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, bob, 0.001 ether);
            vm.expectRevert(PersonalVaultV2.RecipientNotAllowed.selector);
            v.submitTransfer(ft, fw, fs, "");
        } // fee recipient not on the fee list
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, relay, 0.003 ether);
            vm.expectRevert(PersonalVaultV2.AllowanceExceeded.selector);
            v.submitTransfer(ft, fw, fs, "");
        } // above maxFastFeeWei
    }

    function test_FastWithApproverSignatureRejected() public {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_FAST, ETH, alice, 0.01 ether, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        vm.expectRevert(PersonalVaultV2.UnexpectedSignature.selector);
        v.submitTransfer(t, w, ps, sign(A, d));
    }

    function test_GrantExpires() public {
        vm.warp(block.timestamp + 7 days);
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.FastUnavailable.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
    }

    function test_SuspendIsStickyUntilJointResume() public {
        PersonalVaultV2.Window memory w = win();
        uint64 e = v.executionEpoch();
        bytes memory s = sign(A, digestOf(v, C.A_SUSPEND_FAST, C.LANE_A_SAFETY, keccak256(abi.encode(e, true)), w));
        v.suspendFast(C.ROLE_A, w, s);
        assertTrue(v.fastSuspended());
        assertEq(v.executionEpoch(), e + 1);
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.FastUnavailable.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
        // A policy without resumeFast keeps it suspended.
        Policy memory p = flexible(0.10 ether, 0.05 ether, 7 days, 0, 0.002 ether);
        p.resumeFast = false;
        setPolicy(v, p);
        assertTrue(v.fastSuspended());
        p.resumeFast = true;
        setPolicy(v, p);
        assertFalse(v.fastSuspended());
        fast(v, alice, 0.01 ether, address(0), 0);
    }

    function test_PolicyEditNeverResetsLifetimeDebit() public {
        fast(v, alice, 0.05 ether, address(0), 0);
        // A new grant of B units is signed as ceiling = spent + B.
        setPolicy(v, flexible(0.05 ether + 0.03 ether, 0.05 ether, 7 days, 0, 0.002 ether));
        assertEq(v.spent(ETH), 0.05 ether);
        (uint256 rem,,,) = v.getRemaining(ETH);
        assertEq(rem, 0.03 ether);
        // A ceiling below lifetime debit is invalid.
        Policy memory bad = flexible(0.04 ether, 0.01 ether, 7 days, 0, 0);
        PersonalVaultV2.Window memory w = win();
        (bytes memory ps, bytes memory as_,) = pairSigs(v, P, A, C.A_UPDATE_POLICY, keccak256(abi.encode(keccak256(abi.encode(bad)))), w);
        vm.expectRevert(PersonalVaultV2.BadPolicy.selector);
        v.updatePolicy(bad, w, ps, as_);
    }

    function test_PolicyBoundsEnforced() public {
        Policy memory p = flexible(1 ether, 0.1 ether, 31 days, 0, 0);
        PersonalVaultV2.Window memory w = win();
        (bytes memory ps, bytes memory as_,) = pairSigs(v, P, A, C.A_UPDATE_POLICY, keccak256(abi.encode(keccak256(abi.encode(p)))), w);
        vm.expectRevert(PersonalVaultV2.BadPolicy.selector); // grant horizon above 30 days
        v.updatePolicy(p, w, ps, as_);
        p = flexible(1 ether, 0, 7 days, 0, 0); // zero per-action cap
        (ps, as_,) = pairSigs(v, P, A, C.A_UPDATE_POLICY, keccak256(abi.encode(keccak256(abi.encode(p)))), w);
        vm.expectRevert(PersonalVaultV2.BadPolicy.selector);
        v.updatePolicy(p, w, ps, as_);
    }

    function test_PolicyChangeInvalidatesUnsubmittedApprovals() public {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_FAST, ETH, alice, 0.01 ether, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        bytes memory ps = sign(P, digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w));
        setPolicy(v, flexible(0.10 ether, 0.05 ether, 7 days, 0, 0.002 ether));
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.submitTransfer(t, w, ps, "");
    }
}

contract QueueV2Test is BaseV2 {
    PersonalVaultV2 internal v;

    function setUp() public override {
        super.setUp();
        v = createVault(guardedWithDelay(86_400));
        vm.deal(address(v), 10 ether);
    }

    function test_DelayedProtectedQueuesThenExecutes() public {
        bytes32 id = protectedTx(v, ETH, alice, 1 ether, relay, 0.001 ether);
        assertEq(alice.balance, 0);
        PersonalVaultV2.Withdrawal memory q = v.getWithdrawal(id);
        assertEq(q.executableAt, block.timestamp + 86_400);
        assertEq(q.expiresAt, q.executableAt + 604_800);
        vm.warp(q.executableAt - 1);
        vm.expectRevert(PersonalVaultV2.TooEarly.selector);
        v.executeWithdrawal(id);
        vm.warp(q.executableAt);
        vm.prank(address(0x1234)); // anyone
        v.executeWithdrawal(id);
        assertEq(alice.balance, 1 ether);
        assertEq(relay.balance, 0.001 ether);
        vm.expectRevert(PersonalVaultV2.NotQueued.selector);
        v.executeWithdrawal(id);
    }

    function test_ExpiredEntryCannotExecuteAndCanBePruned() public {
        bytes32 id = protectedTx(v, ETH, alice, 1 ether, address(0), 0);
        PersonalVaultV2.Withdrawal memory q = v.getWithdrawal(id);
        vm.expectRevert(PersonalVaultV2.NotExpired.selector);
        v.pruneWithdrawal(id);
        vm.warp(q.expiresAt);
        vm.expectRevert(PersonalVaultV2.Expired.selector);
        v.executeWithdrawal(id);
        v.pruneWithdrawal(id);
        assertEq(v.liveCount(v.executionEpoch()), 0);
    }

    function test_EitherSpendingKeyCancels() public {
        bytes32 id1 = protectedTx(v, ETH, alice, 1 ether, address(0), 0);
        bytes32 id2 = protectedTx(v, ETH, bob, 1 ether, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        v.cancelWithdrawal(id1, C.ROLE_P, w, sign(P, digestOf(v, C.A_CANCEL_WITHDRAWAL, C.LANE_P_SAFETY, keccak256(abi.encode(id1)), w)));
        v.cancelWithdrawal(id2, C.ROLE_A, w, sign(A, digestOf(v, C.A_CANCEL_WITHDRAWAL, C.LANE_A_SAFETY, keccak256(abi.encode(id2)), w)));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(PersonalVaultV2.NotQueued.selector);
        v.executeWithdrawal(id1);
        vm.expectRevert(PersonalVaultV2.NotQueued.selector);
        v.executeWithdrawal(id2);
        // A guardian is not a spending-key safety signer.
        bytes32 id3 = protectedTx(v, ETH, bob, 1, address(0), 0);
        PersonalVaultV2.Window memory w3 = win();
        vm.expectRevert(PersonalVaultV2.BadRole.selector);
        v.cancelWithdrawal(id3, 3, w3, "");
    }

    function test_InvalidationKillsQueueAndNeverRevives() public {
        bytes32 id = protectedTx(v, ETH, alice, 1 ether, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        uint64 e = v.executionEpoch();
        v.invalidateSpending(C.ROLE_P, w, sign(P, digestOf(v, C.A_INVALIDATE, C.LANE_P_SAFETY, keccak256(abi.encode(e)), w)));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(PersonalVaultV2.StaleEpoch.selector);
        v.executeWithdrawal(id);
        assertEq(v.liveCount(v.executionEpoch()), 0);
        v.pruneWithdrawal(id);
    }

    function test_QueueCapIs32PerEpoch() public {
        for (uint256 i; i < 32; ++i) {
            protectedTx(v, ETH, alice, 1, address(0), 0);
        }
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, alice, 1, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        bytes memory as_ = sign(A, d);
        vm.expectRevert(PersonalVaultV2.QueueFull.selector);
        v.submitTransfer(t, w, ps, as_);
    }

    function test_FailedExecutionKeepsEntryForRetry() public {
        Rejecter r = new Rejecter();
        bytes32 id = protectedTx(v, ETH, address(r), 1 ether, address(0), 0);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(PersonalVaultV2.TransferFailed.selector);
        v.executeWithdrawal(id);
        assertEq(uint8(v.getWithdrawal(id).status), uint8(PersonalVaultV2.WStatus.Queued));
    }

    function test_ReentrantRecipientCannotDoubleExecute() public {
        Reenter r = new Reenter();
        bytes32 id = protectedTx(v, ETH, address(r), 1 ether, address(0), 0);
        r.arm(v, id);
        vm.warp(block.timestamp + 1 days);
        v.executeWithdrawal(id);
        assertTrue(r.blocked());
        assertEq(address(r).balance, 1 ether);
    }

    /// Lowering an elected 24-hour delay to zero still waits 24 hours, and freezes outflows meanwhile.
    function test_LoweringDelayWaitsTheCurrentDelay() public {
        bytes32 q = protectedTx(v, ETH, alice, 1 ether, address(0), 0);
        Policy memory p = guarded();
        bytes32 pid = setPolicy(v, p);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.PendingPolicy));
        assertEq(v.protectedDelay(), 86_400);
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(PersonalVaultV2.TooEarly.selector);
        v.finalizeSecurityChange(abi.encode(p));
        // Outflows frozen, and the queued entry is invalid even after resumption.
        vm.expectRevert(PersonalVaultV2.NotActive.selector);
        v.executeWithdrawal(q);
        vm.warp(block.timestamp + 1);
        Policy memory other = guardedWithDelay(3_600);
        vm.expectRevert(PersonalVaultV2.BadPolicy.selector); // the finalizer cannot substitute data
        v.finalizeSecurityChange(abi.encode(other));
        v.finalizeSecurityChange(abi.encode(p));
        assertEq(v.protectedDelay(), 0);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.Active));
        vm.expectRevert(PersonalVaultV2.StaleEpoch.selector);
        v.executeWithdrawal(q);
        assertEq(v.getProposal().id, bytes32(0));
        assertTrue(pid != bytes32(0));
    }

    function test_AdminProposalCancelAndExpire() public {
        bytes32 pid = setPolicy(v, guarded());
        PersonalVaultV2.Window memory w = win();
        (bytes memory ps, bytes memory as_,) = pairSigs(v, P, A, C.A_CANCEL_ADMIN, keccak256(abi.encode(pid)), w);
        uint64 e = v.executionEpoch();
        v.cancelAdminChange(pid, w, ps, as_);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.Active));
        assertEq(v.executionEpoch(), e + 1);
        assertEq(v.protectedDelay(), 86_400);

        pid = setPolicy(v, guarded());
        vm.warp(block.timestamp + 1 days + 7 days - 1);
        vm.expectRevert(PersonalVaultV2.NotExpired.selector);
        v.expireSecurityChange();
        vm.warp(block.timestamp + 1);
        vm.expectRevert(PersonalVaultV2.Expired.selector);
        v.finalizeSecurityChange(abi.encode(guarded()));
        v.expireSecurityChange();
        assertEq(v.protectedDelay(), 86_400);
    }
}

contract KeysAndRecoveryV2Test is BaseV2 {
    PersonalVaultV2 internal v;

    function setUp() public override {
        super.setUp();
        v = createVault(flexible(0.10 ether, 0.05 ether, 20 days, 0, 0.002 ether));
        vm.deal(address(v), 10 ether);
    }

    function test_RotateApproverWithConsent() public {
        bytes32 na = reg(N1);
        bytes32 curP = reg(P);
        PersonalVaultV2.Window memory w = win();
        (bytes memory ps, bytes memory as_, bytes32 d) = pairSigs(v, P, A, C.A_REPLACE_SPENDING, keccak256(abi.encode(curP, na)), w);
        // Without the new key's consent: rejected.
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.replaceSpendingKeys(curP, na, w, ps, as_, "", "");
        bytes memory consent = sign(N1, v.consentDigest(d, C.ROLE_A, na));
        uint64 ae = v.authorityEpoch();
        v.replaceSpendingKeys(curP, na, w, ps, as_, "", consent);
        assertEq(v.roles()[1].keyId, na);
        assertEq(v.authorityEpoch(), ae + 1);
        // The new pair signs protected transfers; the old approver no longer does.
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, bob, 1 ether, address(0), 0);
        PersonalVaultV2.Window memory w2 = win();
        bytes32 td = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w2);
        bytes memory pp = sign(P, td);
        bytes memory oldA = sign(A, td);
        vm.expectRevert(PersonalVaultV2.BadSignature.selector);
        v.submitTransfer(t, w2, pp, oldA);
        v.submitTransfer(t, w2, pp, sign(N1, td));
        assertEq(bob.balance, 1 ether);
    }

    function test_SwappingPAndAIsNotARotation() public {
        bytes32 curP = reg(P);
        bytes32 curA = reg(A);
        PersonalVaultV2.Window memory w = win();
        vm.expectRevert(PersonalVaultV2.DuplicateKey.selector);
        v.replaceSpendingKeys(curA, curP, w, "", "", "", "");
        bytes32 g1 = reg(G1);
        vm.expectRevert(PersonalVaultV2.DuplicateKey.selector);
        v.replaceSpendingKeys(curP, g1, w, "", "", "", "");
    }

    function test_RecoveryFreezesAtOnceAndInstallsAfterSevenDays() public {
        fast(v, alice, 0.03 ether, address(0), 0);
        bytes32 id = startRecovery(v, N1, N2);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.PendingRecovery));
        assertTrue(v.fastSuspended());
        // Frozen: no outflow of any kind, and P/A cannot cancel or displace it.
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.NotActive.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
        PersonalVaultV2.Window memory w = win();
        (bytes memory ps, bytes memory as_,) = pairSigs(v, P, A, C.A_CANCEL_ADMIN, keccak256(abi.encode(id)), w);
        vm.expectRevert(PersonalVaultV2.WrongState.selector);
        v.cancelAdminChange(id, w, ps, as_);

        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(PersonalVaultV2.TooEarly.selector);
        v.finalizeSecurityChange("");
        vm.warp(block.timestamp + 1);
        uint64 ae = v.authorityEpoch();
        uint64 pe = v.policyEpoch();
        v.finalizeSecurityChange("");
        PersonalVaultV2.KeyRef[5] memory r = v.roles();
        assertEq(r[0].keyId, reg(N1));
        assertEq(r[1].keyId, reg(N2));
        assertEq(v.authorityEpoch(), ae + 1);
        assertEq(v.policyEpoch(), pe + 1);
        assertFalse(v.fastEnabled());
        assertTrue(v.fastSuspended());
        assertEq(v.spent(ETH), 0.03 ether); // lifetime debit preserved
        assertEq(v.protectedDelay(), 0); // delay preserved
        (uint256 rem,,,) = v.getRemaining(ETH);
        assertEq(rem, 0);
        // The new pair can move funds immediately (delay zero).
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, ETH, bob, 1 ether, address(0), 0);
        PersonalVaultV2.Window memory w2 = win();
        bytes32 td = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w2);
        v.submitTransfer(t, w2, sign(N1, td), sign(N2, td));
        assertEq(bob.balance, 1 ether);
    }

    function test_PrimaryEpochChurnCannotInvalidateRecoveryApproval() public {
        bytes32 np = reg(N1);
        bytes32 na = reg(N2);
        PersonalVaultV2.Window memory w = win();
        (PersonalVaultV2.GuardianSigs memory g, bytes32 d) = guardianSigs(v, 0, 1, C.A_START_RECOVERY, keccak256(abi.encode(np, na)), w);
        bytes memory c1 = sign(N1, v.consentDigest(d, C.ROLE_P, np));
        bytes memory c2 = sign(N2, v.consentDigest(d, C.ROLE_A, na));
        // A stolen primary churns the execution epoch and suspends FAST...
        PersonalVaultV2.Window memory w2 = win();
        uint64 e = v.executionEpoch();
        v.invalidateSpending(C.ROLE_P, w2, sign(P, digestOf(v, C.A_INVALIDATE, C.LANE_P_SAFETY, keccak256(abi.encode(e)), w2)));
        // ...and a policy change advances the policy epoch: the recovery bytes stay valid.
        setPolicy(v, guarded());
        v.startRecovery(np, na, w, g, c1, c2);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.PendingRecovery));
    }

    function test_RecoveryPreemptsPendingPolicyButNotAnotherRecovery() public {
        // Elect a delay so that a policy change is pending.
        setPolicy(v, guardedWithDelay(86_400));
        setPolicy(v, guarded());
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.PendingPolicy));
        startRecovery(v, N1, N2);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.PendingRecovery));
        bytes32 np = reg(N3);
        bytes32 na = reg(N2);
        PersonalVaultV2.Window memory w = win();
        PersonalVaultV2.GuardianSigs memory g;
        vm.expectRevert(PersonalVaultV2.WrongState.selector);
        v.startRecovery(np, na, w, g, "", "");
    }

    function test_GuardiansCancelRecoveryAndFastStaysSuspended() public {
        bytes32 id = startRecovery(v, N1, N2);
        PersonalVaultV2.Window memory w = win();
        (PersonalVaultV2.GuardianSigs memory g,) = guardianSigs(v, 1, 2, C.A_CANCEL_RECOVERY, keccak256(abi.encode(id)), w);
        v.cancelRecoveryChange(id, w, g);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.Active));
        assertEq(v.roles()[0].keyId, reg(P));
        assertTrue(v.fastSuspended());
        {
            (PersonalVaultV2.Transfer memory ft, PersonalVaultV2.Window memory fw, bytes memory fs) = fastArgs(v, alice, 0.01 ether, address(0), 0);
            vm.expectRevert(PersonalVaultV2.FastUnavailable.selector);
            v.submitTransfer(ft, fw, fs, "");
        }
    }

    function test_RecoveryExpiresAfterFourteenDays() public {
        startRecovery(v, N1, N2);
        vm.warp(block.timestamp + 14 days);
        vm.expectRevert(PersonalVaultV2.Expired.selector);
        v.finalizeSecurityChange("");
        v.expireSecurityChange();
        assertEq(v.roles()[0].keyId, reg(P));
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.Active));
    }

    function test_RecoveryNeedsTwoDistinctGuardians() public {
        bytes32 np = reg(N1);
        bytes32 na = reg(N2);
        PersonalVaultV2.Window memory w = win();
        (PersonalVaultV2.GuardianSigs memory g,) = guardianSigs(v, 0, 0, C.A_START_RECOVERY, keccak256(abi.encode(np, na)), w);
        vm.expectRevert(PersonalVaultV2.DuplicateSigner.selector);
        v.startRecovery(np, na, w, g, "", "");
        // Recovery cannot reinstall a current spending key.
        bytes32 curA = reg(A);
        vm.expectRevert(PersonalVaultV2.DuplicateKey.selector);
        v.startRecovery(np, curA, w, g, "", "");
    }

    function test_GuardianReplacement() public {
        bytes32[3] memory ng = [reg(N1), reg(N2), reg(G3)]; // G3 retained
        PersonalVaultV2.Window memory w = win();
        (PersonalVaultV2.GuardianSigs memory g, bytes32 d) = guardianSigs(v, 0, 1, C.A_REPLACE_GUARDIANS, keccak256(abi.encode(ng)), w);
        bytes[3] memory consents =
            [sign(N1, v.consentDigest(d, 3, ng[0])), sign(N2, v.consentDigest(d, 4, ng[1])), sign(G3, v.consentDigest(d, 5, ng[2]))];
        v.replaceGuardians(ng, w, sign(P, d), sign(A, d), g, consents);
        assertEq(uint8(v.state()), uint8(PersonalVaultV2.State.PendingGuardians));
        // P and A cannot cancel it; only the current guardian quorum can.
        PersonalVaultV2.Window memory w2 = win();
        (bytes memory ps, bytes memory as_,) = pairSigs(v, P, A, C.A_CANCEL_ADMIN, keccak256(abi.encode(d)), w2);
        vm.expectRevert(PersonalVaultV2.WrongState.selector);
        v.cancelAdminChange(d, w2, ps, as_);
        vm.warp(block.timestamp + 7 days);
        v.finalizeSecurityChange("");
        PersonalVaultV2.KeyRef[5] memory r = v.roles();
        assertEq(r[2].keyId, ng[0]);
        assertEq(r[3].keyId, ng[1]);
        assertEq(r[4].keyId, ng[2]);
        // FAST grants survive a guardian change.
        fast(v, alice, 0.01 ether, address(0), 0);
    }
}

/// ERC-20 support with exact debit/credit checks (a profile beyond the ETH-only testnet release).
contract MockToken {
    mapping(address => uint256) public balanceOf;
    uint256 public tax; // basis points taken on transfer

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function setTax(uint256 t) external {
        tax = t;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a - (a * tax) / 10_000;
        return true;
    }
}

contract TokenV2Test is BaseV2 {
    function test_TokenTransferAndTransferTaxRejected() public {
        MockToken tok = new MockToken();
        address[] memory assets = new address[](2);
        assets[0] = ETH;
        assets[1] = address(tok);
        VaultFactoryV2 f = deployFactory(assets);
        PersonalVaultV2 v = createVaultWith(f, roleIds(), [P, A, G1, G2, G3], guarded(), keccak256("t"));
        tok.mint(address(v), 100_000);
        vm.deal(address(v), 1 ether);
        protectedTx(v, address(tok), alice, 40, relay, 0.001 ether);
        assertEq(tok.balanceOf(alice), 40);
        assertEq(relay.balance, 0.001 ether);
        tok.setTax(100);
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, address(tok), alice, 5_000, address(0), 0);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        bytes memory ps = sign(P, d);
        bytes memory as_ = sign(A, d);
        vm.expectRevert(PersonalVaultV2.TransferFailed.selector);
        v.submitTransfer(t, w, ps, as_);
    }
}
