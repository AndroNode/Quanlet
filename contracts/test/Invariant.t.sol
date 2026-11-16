// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Base} from "./Base.t.sol";
import {KeyFactory} from "../src/KeyFactory.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {PersonalVault} from "../src/PersonalVault.sol";
import {MLDSA44Verifier} from "../src/verifier/MLDSA44Verifier.sol";
import {QuanletConstants as C} from "../src/QuanletConstants.sol";

/// Drives one vault through arbitrary sequences of deposits, scheduling, cancellation, invalidation,
/// execution, time jumps, recovery, recovery-set replacement, cancellation and expiry, plus forged,
/// replayed and duplicate-signer attempts. Every call predicts whether the vault must accept it from the
/// whitepaper rules alone; any disagreement, in either direction, is recorded as a violation.
/// Signatures are real ML-DSA-44 signatures made through FFI, so runs are kept short.
/// A withdrawal recipient that re-enters the vault while being paid: it tries to prune its own entry
/// (to dodge the fee read afterwards), execute another entry and prune that one.
contract HostileRecipient {
    PersonalVault public v;
    bytes32 internal mine;
    bytes32 internal other;

    function set(PersonalVault v_, bytes32 mine_, bytes32 other_) external {
        (v, mine, other) = (v_, mine_, other_);
    }

    receive() external payable {
        if (address(v) == address(0)) return;
        (bool a,) = address(v).call(abi.encodeCall(PersonalVault.pruneWithdrawal, (mine)));
        (bool b,) = address(v).call(abi.encodeCall(PersonalVault.executeWithdrawal, (other)));
        (bool c,) = address(v).call(abi.encodeCall(PersonalVault.pruneWithdrawal, (other)));
        (a, b, c);
    }
}

contract VaultHandler is Base {
    PersonalVault public v;
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant RELAYER = address(0xFEE);
    HostileRecipient public hostile = new HostileRecipient();

    bytes32[7] internal pool;
    bytes32 public primarySeed;
    bytes32[3] public recoverySeeds;

    bytes32[] internal ids;
    uint256 public ghostDeposits;
    uint256 public ghostPaidOut;
    uint64 public lastExecEpoch;
    uint64 public lastAuthEpoch;
    uint256 public lastPrimaryNonce;
    uint256 public lastControlNonce;
    address public verifierAtStart;
    bytes32 public verifierHashAtStart;

    // A signed request that was accepted, kept to try replaying it.
    uint256 internal lastAmt;
    bool internal lastFee;
    PersonalVault.Auth internal lastAuth;
    bool internal haveLast;

    bool public violated;
    string public why;
    mapping(bytes32 => uint256) public calls;

    constructor(KeyFactory keys_, VaultFactory factory_, MLDSA44Verifier verifier_) {
        keys = keys_;
        factory = factory_;
        verifier = verifier_;
        pool = [P1, R1, R2, R3, N1, N2, N3];
        for (uint256 i; i < pool.length; ++i) register(pool[i]);
        v = createVault(P1, R1, R2, R3);
        primarySeed = P1;
        recoverySeeds = [R1, R2, R3];
        verifierAtStart = address(v.verifier());
        verifierHashAtStart = v.verifierCodehash();
    }

    // ---------------------------------------------------------------- bookkeeping

    modifier step(bytes32 name) {
        calls[name]++;
        _;
        _checkCounters();
    }

    function _fail(string memory m) internal {
        if (!violated) {
            violated = true;
            why = m;
        }
    }

    function _checkCounters() internal {
        if (v.executionEpoch() < lastExecEpoch) _fail("execution epoch went back");
        if (v.authorityEpoch() < lastAuthEpoch) _fail("authority epoch went back");
        if (v.primaryNonce() < lastPrimaryNonce) _fail("primary nonce went back");
        if (v.controlNonce() < lastControlNonce) _fail("control nonce went back");
        lastExecEpoch = v.executionEpoch();
        lastAuthEpoch = v.authorityEpoch();
        lastPrimaryNonce = v.primaryNonce();
        lastControlNonce = v.controlNonce();
    }

    function _active() internal view returns (bool) {
        return v.status() == PersonalVault.Status.Active;
    }

    function _inSet(bytes32 seed) internal view returns (bool) {
        if (seed == primarySeed) return true;
        for (uint256 i; i < 3; ++i) {
            if (seed == recoverySeeds[i]) return true;
        }
        return false;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function idAt(uint256 i) external view returns (bytes32) {
        return ids[i];
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint96 amt) external step("deposit") {
        uint256 a = bound(amt, 1, 5 ether);
        vm.deal(address(this), a);
        (bool ok,) = address(v).call{value: a}("");
        if (!ok) _fail("deposit refused");
        ghostDeposits += a;
    }

    function schedule(uint96 amt, bool withFee, bool toHostile) external step("schedule") {
        uint256 a = bound(amt, 1, 3 ether);
        (address fr, uint256 fee) = withFee ? (RELAYER, 0.01 ether) : (address(0), 0);
        address to = toHostile ? address(hostile) : RECIPIENT;
        bytes32 ph = v.withdrawalParamsHash(address(0), to, a, fr, fee);
        PersonalVault.Auth memory au = primaryAuth(v, primarySeed, C.ACTION_SCHEDULE, ph);
        bool expect = _active() && v.activeCount(v.executionEpoch()) < C.MAX_ACTIVE_QUEUE;
        try v.scheduleWithdrawal(address(0), to, a, fr, fee, au) returns (bytes32 id) {
            if (toHostile) {
                calls["hostileScheduled"]++;
                (lastAmt, lastFee, haveLast) = (0, false, false); // replay() re-sends to RECIPIENT only
                ids.push(id);
                return;
            }
            if (!expect) _fail("schedule accepted while it must be refused");
            ids.push(id);
            (lastAmt, lastFee, haveLast) = (a, withFee, true);
            lastAuth = au;
        } catch {
            if (expect) _fail("valid schedule refused");
        }
    }

    /// A request signed by any key other than the current primary must never be accepted.
    function scheduleForged(uint96 amt, uint8 who) external step("forged") {
        bytes32 seed = pool[bound(who, 0, pool.length - 1)];
        if (seed == primarySeed) seed = bytes32(uint256(0xBAD));
        uint256 a = bound(amt, 1, 3 ether);
        bytes32 ph = v.withdrawalParamsHash(address(0), RECIPIENT, a, address(0), 0);
        PersonalVault.Auth memory au = primaryAuth(v, seed, C.ACTION_SCHEDULE, ph);
        try v.scheduleWithdrawal(address(0), RECIPIENT, a, address(0), 0, au) {
            _fail("withdrawal accepted with a non-primary signature");
        } catch {}
    }

    /// Re-submitting an accepted request must fail: its nonce is spent.
    function replay() external step("replay") {
        if (!haveLast) return;
        (address fr, uint256 fee) = lastFee ? (RELAYER, 0.01 ether) : (address(0), 0);
        try v.scheduleWithdrawal(address(0), RECIPIENT, lastAmt, fr, fee, lastAuth) {
            _fail("replayed request accepted");
        } catch {}
    }

    function cancel(uint256 i) external step("cancel") {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(i, 0, ids.length - 1)];
        PersonalVault.Withdrawal memory w = v.getWithdrawal(id);
        PersonalVault.Auth memory au = primaryAuth(v, primarySeed, C.ACTION_CANCEL, keccak256(abi.encode(id)));
        bool expect = _active() && w.status == PersonalVault.WStatus.Queued && w.epoch == v.executionEpoch();
        try v.cancelWithdrawal(id, au) {
            if (!expect) _fail("cancel accepted while it must be refused");
        } catch {
            if (expect) _fail("valid cancel refused");
        }
    }

    function invalidate() external step("invalidate") {
        uint64 e = v.executionEpoch();
        PersonalVault.Auth memory au = primaryAuth(v, primarySeed, C.ACTION_INVALIDATE, keccak256(abi.encode(e)));
        bool expect = _active();
        try v.invalidatePendingRequests(au) {
            if (!expect) _fail("invalidation accepted while pending");
            if (v.executionEpoch() != e + 1) _fail("invalidation did not move the epoch");
        } catch {
            if (expect) _fail("valid invalidation refused");
        }
    }

    function execute(uint256 i, address caller) external step("execute") {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(i, 0, ids.length - 1)];
        PersonalVault.Withdrawal memory w = v.getWithdrawal(id);
        uint256 due = w.amount + w.feeWei;
        bool expect = _active() && w.status == PersonalVault.WStatus.Queued && w.epoch == v.executionEpoch()
            && block.timestamp >= w.executableAt && block.timestamp < w.expiresAt && address(v).balance >= due;
        uint256 before = address(v).balance;
        uint256 recBefore = w.recipient.balance;
        uint256 feeBefore = RELAYER.balance;
        if (w.recipient == address(hostile)) hostile.set(v, id, ids[uint256(keccak256(abi.encode(i))) % ids.length]);
        if (caller == address(0) || caller.code.length != 0) caller = address(0xCA11);
        vm.prank(caller);
        try v.executeWithdrawal(id) {
            if (!expect) _fail("execution accepted while it must be refused");
            if (before - address(v).balance != due) _fail("outflow differs from the signed amount plus fee");
            if (w.recipient.balance - recBefore != w.amount) _fail("recipient got a different amount");
            if (RELAYER.balance - feeBefore != w.feeWei) _fail("relayer got a different fee");
            ghostPaidOut += due;
            calls["executed"]++;
        } catch {
            if (expect) _fail("valid execution refused");
            if (address(v).balance != before) _fail("failed execution moved funds");
        }
    }

    function prune(uint256 i) external step("prune") {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(i, 0, ids.length - 1)];
        try v.pruneWithdrawal(id) {} catch {}
    }

    function warp(uint32 dt) external step("warp") {
        vm.warp(block.timestamp + bound(dt, 1, 9 days));
    }

    /// Jump to a boundary of an entry or of the pending change, where off-by-one mistakes live.
    function warpToBoundary(uint256 i, uint8 mode) external step("warpToBoundary") {
        uint64 t;
        uint8 m = uint8(bound(mode, 0, 5));
        if (m < 4 && ids.length != 0) {
            PersonalVault.Withdrawal memory w = v.getWithdrawal(ids[bound(i, 0, ids.length - 1)]);
            if (w.status == PersonalVault.WStatus.None) return;
            t = m == 0 ? w.executableAt - 1 : m == 1 ? w.executableAt : m == 2 ? w.expiresAt - 1 : w.expiresAt;
        } else {
            PersonalVault.Proposal memory p = v.proposal();
            if (p.executableAt == 0) return;
            t = m == 4 ? (i % 2 == 0 ? p.executableAt - 1 : p.executableAt) : (i % 2 == 0 ? p.expiresAt - 1 : p.expiresAt);
        }
        if (t > block.timestamp) vm.warp(t);
    }

    function startRecovery(uint8 a, uint8 b, uint8 n) external step("recovery") {
        uint8 ia = uint8(bound(a, 0, 2));
        uint8 ib = uint8(bound(b, 0, 2));
        bytes32 ns = pool[bound(n, 0, pool.length - 1)];
        bytes32 nr = recordOf[ns];
        bytes32 ph = v.recoveryParamsHash(kid(nr));
        PersonalVault.QuorumAuth memory q =
            quorumAuth(v, recoverySeeds[ia], ia, recoverySeeds[ib], ib, C.ACTION_RECOVERY, ph);
        bool expect = _active() && ia != ib && !_inSet(ns);
        try v.startRecovery(nr, q) {
            if (!expect) _fail("recovery start accepted while it must be refused");
        } catch {
            if (expect) _fail("valid recovery start refused");
        }
    }

    function cancelSecurity(uint8 a, uint8 b) external step("cancelSecurity") {
        uint8 ia = uint8(bound(a, 0, 2));
        uint8 ib = uint8(bound(b, 0, 2));
        bytes32 pid = v.proposal().id;
        PersonalVault.QuorumAuth memory q =
            quorumAuth(v, recoverySeeds[ia], ia, recoverySeeds[ib], ib, C.ACTION_CANCEL_SECURITY, keccak256(abi.encode(pid)));
        bool expect = !_active() && ia != ib;
        try v.cancelSecurityChange(q) {
            if (!expect) _fail("security cancel accepted while it must be refused");
        } catch {
            if (expect) _fail("valid security cancel refused");
        }
    }

    function replaceSet(uint8 a, uint8 b, uint8 x, uint8 y, uint8 z) external step("replaceSet") {
        uint8 ia = uint8(bound(a, 0, 2));
        uint8 ib = uint8(bound(b, 0, 2));
        bytes32[3] memory ns =
            [pool[bound(x, 0, pool.length - 1)], pool[bound(y, 0, pool.length - 1)], pool[bound(z, 0, pool.length - 1)]];
        bytes32[3] memory nrs = [recordOf[ns[0]], recordOf[ns[1]], recordOf[ns[2]]];
        bytes32 ph = v.recoverySetParamsHash([kid(nrs[0]), kid(nrs[1]), kid(nrs[2])]);
        PersonalVault.QuorumAuth memory q =
            quorumAuth(v, recoverySeeds[ia], ia, recoverySeeds[ib], ib, C.ACTION_REPLACE_RECOVERY_SET, ph);
        PersonalVault.Auth memory p;
        p.validAfter = q.validAfter;
        p.validUntil = q.validUntil;
        p.sig = sign(primarySeed, v.actionDigest(C.ACTION_REPLACE_RECOVERY_SET, v.controlNonce(), ph, q.validAfter, q.validUntil));
        bool distinct = ns[0] != ns[1] && ns[1] != ns[2] && ns[0] != ns[2];
        bool noPrimary = ns[0] != primarySeed && ns[1] != primarySeed && ns[2] != primarySeed;
        bool expect = _active() && ia != ib && distinct && noPrimary;
        try v.startRecoverySetReplacement(nrs, p, q) {
            if (!expect) _fail("set replacement accepted while it must be refused");
        } catch {
            if (expect) _fail("valid set replacement refused");
        }
    }

    function finalize() external step("finalize") {
        PersonalVault.Proposal memory p = v.proposal();
        bool expect = !_active() && block.timestamp >= p.executableAt && block.timestamp < p.expiresAt;
        bytes32 ns;
        bytes32[3] memory nset;
        if (expect && p.kind == C.KIND_PRIMARY) {
            ns = _seedOf(p.newRecords[0]);
            expect = !_inSet(ns); // re-checked at finalization
        } else if (expect) {
            for (uint256 i; i < 3; ++i) {
                nset[i] = _seedOf(p.newRecords[i]);
                if (nset[i] == primarySeed) expect = false;
            }
        }
        uint64 auth0 = v.authorityEpoch();
        try v.finalizeSecurityChange() {
            if (!expect) _fail("finalize accepted while it must be refused");
            if (v.authorityEpoch() != auth0 + 1) _fail("finalize did not move the authority epoch");
            calls["finalized"]++;
            if (p.kind == C.KIND_PRIMARY) {
                if (v.primary().recordId != p.newRecords[0]) _fail("finalize installed another primary");
                primarySeed = ns;
            } else {
                recoverySeeds = nset;
            }
        } catch {
            if (expect) _fail("valid finalize refused");
        }
    }

    function expire() external step("expire") {
        bool expect = !_active() && block.timestamp >= v.proposal().expiresAt;
        try v.expireSecurityChange() {
            if (!expect) _fail("expire accepted while it must be refused");
            calls["expired"]++;
        } catch {
            if (expect) _fail("valid expire refused");
        }
    }

    function _seedOf(bytes32 rec) internal view returns (bytes32) {
        for (uint256 i; i < pool.length; ++i) {
            if (recordOf[pool[i]] == rec) return pool[i];
        }
        return bytes32(0);
    }
}

contract VaultInvariants is StdInvariant, Base {
    VaultHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new VaultHandler(keys, factory, verifier);
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](15);
        s[14] = VaultHandler.warpToBoundary.selector;
        s[0] = VaultHandler.deposit.selector;
        s[1] = VaultHandler.schedule.selector;
        s[2] = VaultHandler.scheduleForged.selector;
        s[3] = VaultHandler.replay.selector;
        s[4] = VaultHandler.cancel.selector;
        s[5] = VaultHandler.invalidate.selector;
        s[6] = VaultHandler.execute.selector;
        s[7] = VaultHandler.prune.selector;
        s[8] = VaultHandler.warp.selector;
        s[9] = VaultHandler.startRecovery.selector;
        s[10] = VaultHandler.cancelSecurity.selector;
        s[11] = VaultHandler.replaceSet.selector;
        s[12] = VaultHandler.finalize.selector;
        s[13] = VaultHandler.expire.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }

    /// Appendix B, checked after every call of every run:
    ///  - every call matched the rules (no forged, replayed or out-of-epoch request; nothing while pending;
    ///    exact amounts and fees; distinct signers; exact installs; counters never go back);
    ///  - the vault's ETH is exactly deposits minus executed signed withdrawals (1-3, 9);
    ///  - nothing rebinds the verifier or its code (5);
    ///  - while a change is pending no entry of the current epoch is queued, and the queue cap holds (3).
    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 40
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_AppendixB() public view {
        assertFalse(h.violated(), h.why());

        PersonalVault v = h.v();
        assertEq(address(v).balance, h.ghostDeposits() - h.ghostPaidOut());

        assertEq(address(v.verifier()), h.verifierAtStart());
        assertEq(v.verifierCodehash(), h.verifierHashAtStart());
        assertEq(address(v.verifier()).codehash, h.verifierHashAtStart());

        uint64 e = v.executionEpoch();
        assertLe(v.activeCount(e), C.MAX_ACTIVE_QUEUE);
        if (v.status() == PersonalVault.Status.Pending) {
            uint256 n = h.idCount();
            for (uint256 i; i < n; ++i) {
                PersonalVault.Withdrawal memory w = v.getWithdrawal(h.idAt(i));
                if (w.status == PersonalVault.WStatus.Queued) assertLt(w.epoch, e);
            }
        }
    }
}

/// A fixed walk through the handler that must reach every success path at least once, so the
/// random campaign above is known to be able to reach them too.
contract VaultHandlerReach is Base {
    function test_HandlerReachesSuccessPaths() public {
        VaultHandler h = new VaultHandler(keys, factory, verifier);
        h.deposit(3 ether);
        h.schedule(1 ether, true, false);
        h.warpToBoundary(0, 0); // one second early
        h.execute(0, address(0xCA11)); // refused
        h.warpToBoundary(0, 1); // exactly mature
        h.execute(0, address(0xCA11)); // accepted
        h.replay();
        h.scheduleForged(1 ether, 1);
        h.schedule(1 ether, false, false);
        h.invalidate();
        h.execute(1, address(0xCA11)); // old epoch: refused
        h.startRecovery(0, 1, 4); // N1 as new primary
        h.invalidate(); // refused while pending
        h.warpToBoundary(1, 4); // executableAt - 1... (i odd: exactly executableAt)
        h.finalize();
        h.schedule(0.5 ether, false, false);
        h.replaceSet(0, 2, 5, 6, 1); // N2, N3, R1
        h.cancelSecurity(1, 2);
        h.startRecovery(1, 2, 0); // P1 back as primary
        h.warpToBoundary(1, 5); // exactly expiresAt
        h.expire();
        h.schedule(1 ether, true, true); // to a recipient that re-enters while paid
        h.warpToBoundary(3, 1);
        h.execute(3, address(0xCA11)); // amount and fee both paid exactly
        assertFalse(h.violated(), h.why());
        assertEq(h.calls("expired"), 1);
        assertEq(h.calls("hostileScheduled"), 1);
        assertEq(h.calls("executed"), 2);
        assertEq(h.calls("finalized"), 1);
        assertEq(address(h.v()).balance, h.ghostDeposits() - h.ghostPaidOut());
    }
}
