// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BaseV2} from "./BaseV2.t.sol";
import {PersonalVaultV2} from "../../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy, AssetRule} from "../../src/v2/QuanletV2.sol";

/// Random interleavings of FAST and PROTECTED transfers, queue execution, policy grants, suspension,
/// invalidation, recovery, cancellation, expiry and time (whitepaper v2.0 section 17, Appendix D), with real
/// ML-DSA-44 signatures. Every call is attempted; the ghosts record only what actually happened.
contract VaultV2Handler is Test {
    PersonalVaultV2 public v;
    bytes32 internal pSeed;
    bytes32 internal aSeed;
    bytes32[3] internal gSeeds;
    bytes32[2] internal nextPair; // pre-registered keys for one recovery
    address payable internal constant ALICE = payable(address(0xA11CE));
    address payable internal constant RELAY = payable(address(0x7E1A));

    uint256 public deposits;
    uint256 public outflow; // asset + fees paid out
    uint256 public fastDebit; // ETH debited through FAST (amount + fee)
    uint256 public ceiling; // latest jointly granted ETH ceiling
    bool public frozenOutflow; // any outflow observed while a security proposal was pending
    bool public regression; // an epoch or nonce went backwards
    bool public recovered;
    bytes32[] internal queued;
    uint64[3] internal lastEpochs;
    uint256[6] internal lastNonces;

    constructor(PersonalVaultV2 v_, bytes32 p, bytes32 a, bytes32[3] memory g, bytes32[2] memory np, uint256 ceiling_) {
        v = v_;
        pSeed = p;
        aSeed = a;
        gSeeds = g;
        nextPair = np;
        ceiling = ceiling_;
        deposits = address(v_).balance;
        _snap();
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint96 amount) external {
        amount = uint96(bound(amount, 1, 1 ether));
        vm.deal(address(this), amount);
        (bool ok,) = address(v).call{value: amount}("");
        require(ok);
        deposits += amount;
        _after();
    }

    function fastSend(uint96 amount, bool withFee) external {
        amount = uint96(bound(amount, 1, 0.06 ether));
        uint256 fee = withFee ? 0.001 ether : 0;
        PersonalVaultV2.Transfer memory t = PersonalVaultV2.Transfer(C.ROUTE_FAST, address(0), ALICE, amount, withFee ? RELAY : address(0), fee);
        PersonalVaultV2.Window memory w = _win();
        bytes memory ps = _sign(pSeed, _digest(C.A_TRANSFER, C.LANE_SPEND, _th(t), w));
        bool pending = v.state() != PersonalVaultV2.State.Active;
        try v.submitTransfer(t, w, ps, "") {
            outflow += amount + fee;
            fastDebit += amount + fee;
            if (pending) frozenOutflow = true;
        } catch {}
        _after();
    }

    function protectedSend(uint96 amount) external {
        amount = uint96(bound(amount, 1, 0.5 ether));
        PersonalVaultV2.Transfer memory t = PersonalVaultV2.Transfer(C.ROUTE_PROTECTED, address(0), ALICE, amount, address(0), 0);
        PersonalVaultV2.Window memory w = _win();
        bytes32 d = _digest(C.A_TRANSFER, C.LANE_SPEND, _th(t), w);
        bytes memory ps = _sign(pSeed, d);
        bytes memory as_ = _sign(aSeed, d);
        bool pending = v.state() != PersonalVaultV2.State.Active;
        uint256 b0 = address(v).balance;
        try v.submitTransfer(t, w, ps, as_) returns (bytes32 id) {
            if (address(v).balance < b0) {
                outflow += amount;
                if (pending) frozenOutflow = true;
            } else {
                queued.push(id);
            }
        } catch {}
        _after();
    }

    /// A primary-only attempt at the protected route (no approver): must always fail.
    function primaryOnlyProtected(uint96 amount) external {
        amount = uint96(bound(amount, 1, 0.5 ether));
        PersonalVaultV2.Transfer memory t = PersonalVaultV2.Transfer(C.ROUTE_PROTECTED, address(0), ALICE, amount, address(0), 0);
        PersonalVaultV2.Window memory w = _win();
        bytes memory ps = _sign(pSeed, _digest(C.A_TRANSFER, C.LANE_SPEND, _th(t), w));
        try v.submitTransfer(t, w, ps, "") {
            frozenOutflow = true; // reuse the violation flag: an unauthorized outflow happened
        } catch {}
        _after();
    }

    function executeQueued(uint256 i) external {
        if (queued.length == 0) return;
        bytes32 id = queued[bound(i, 0, queued.length - 1)];
        PersonalVaultV2.Withdrawal memory q = v.getWithdrawal(id);
        bool pending = v.state() != PersonalVaultV2.State.Active;
        try v.executeWithdrawal(id) {
            outflow += q.amount + q.feeWei;
            if (pending) frozenOutflow = true;
        } catch {}
        _after();
    }

    function grant(uint96 budget, bool delay) external {
        budget = uint96(bound(budget, 0, 0.2 ether));
        if (recovered) return; // the new pair's seeds are not tracked here
        Policy memory p;
        p.protectedDelay = delay ? 3_600 : 0;
        p.fastEnabled = true;
        p.resumeFast = true;
        p.maxFastFeeWei = 0.002 ether;
        p.fastFeeRecipients = new address[](1);
        p.fastFeeRecipients[0] = RELAY;
        p.assetRules = new AssetRule[](1);
        address[] memory rec = new address[](1);
        rec[0] = ALICE;
        uint256 c = v.spent(address(0)) + budget;
        p.assetRules[0] = AssetRule(address(0), c, 0.05 ether, uint64(block.timestamp), uint64(block.timestamp) + 10 days, rec);
        PersonalVaultV2.Window memory w = _win();
        bytes32 d = _digest(C.A_UPDATE_POLICY, C.LANE_ADMIN, keccak256(abi.encode(keccak256(abi.encode(p)))), w);
        bytes memory ps = _sign(pSeed, d);
        bytes memory as_ = _sign(aSeed, d);
        try v.updatePolicy(p, w, ps, as_) {
            if (v.state() == PersonalVaultV2.State.Active) ceiling = c;
            else pendingPolicy = abi.encode(p);
        } catch {}
        _after();
    }

    bytes internal pendingPolicy;

    function finalize() external {
        PersonalVaultV2.State s = v.state();
        if (s == PersonalVaultV2.State.Active) return;
        bytes memory payload = s == PersonalVaultV2.State.PendingPolicy ? pendingPolicy : bytes("");
        try v.finalizeSecurityChange(payload) {
            if (s == PersonalVaultV2.State.PendingPolicy) {
                Policy memory p = abi.decode(pendingPolicy, (Policy));
                ceiling = p.assetRules[0].ceiling;
            }
            if (s == PersonalVaultV2.State.PendingRecovery) recovered = true;
        } catch {}
        _after();
    }

    function expire() external {
        try v.expireSecurityChange() {} catch {}
        _after();
    }

    function safety(bool suspend, bool byP) external {
        if (recovered) return;
        PersonalVaultV2.Window memory w = _win();
        uint8 role = byP ? C.ROLE_P : C.ROLE_A;
        uint8 lane = byP ? C.LANE_P_SAFETY : C.LANE_A_SAFETY;
        uint64 e = v.executionEpoch();
        bytes32 ph = suspend ? keccak256(abi.encode(e, true)) : keccak256(abi.encode(e));
        bytes memory s = _sign(byP ? pSeed : aSeed, _digest(suspend ? C.A_SUSPEND_FAST : C.A_INVALIDATE, lane, ph, w));
        if (suspend) {
            try v.suspendFast(role, w, s) {} catch {}
        } else {
            try v.invalidateSpending(role, w, s) {} catch {}
        }
        _after();
    }

    function recover() external {
        if (recovered || v.state() == PersonalVaultV2.State.PendingRecovery) return;
        bytes32 np = keyIdOfSeed[nextPair[0]];
        bytes32 na = keyIdOfSeed[nextPair[1]];
        PersonalVaultV2.Window memory w = _win();
        bytes32 d = _digest(C.A_START_RECOVERY, C.LANE_RECOVERY, keccak256(abi.encode(np, na)), w);
        PersonalVaultV2.GuardianSigs memory g;
        g.idx = [0, 2];
        g.sigs = [_sign(gSeeds[0], d), _sign(gSeeds[2], d)];
        bytes memory c1 = _sign(nextPair[0], v.consentDigest(d, C.ROLE_P, np));
        bytes memory c2 = _sign(nextPair[1], v.consentDigest(d, C.ROLE_A, na));
        try v.startRecovery(np, na, w, g, c1, c2) {} catch {}
        _after();
    }

    function cancelRecovery() external {
        if (v.state() != PersonalVaultV2.State.PendingRecovery) return;
        bytes32 pid = v.getProposal().id;
        PersonalVaultV2.Window memory w = _win();
        bytes32 d = _digest(C.A_CANCEL_RECOVERY, C.LANE_RECOVERY, keccak256(abi.encode(pid)), w);
        PersonalVaultV2.GuardianSigs memory g;
        g.idx = [1, 2];
        g.sigs = [_sign(gSeeds[1], d), _sign(gSeeds[2], d)];
        try v.cancelRecoveryChange(pid, w, g) {} catch {}
        _after();
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 9 days));
        _after();
    }

    mapping(bytes32 seed => bytes32) public keyIdOfSeed;

    function setKeyId(bytes32 seed, bytes32 id) external {
        keyIdOfSeed[seed] = id;
    }

    // ---------------------------------------------------------------- helpers

    function _after() internal {
        uint64[3] memory e = [v.authorityEpoch(), v.policyEpoch(), v.executionEpoch()];
        for (uint256 i; i < 3; ++i) {
            if (e[i] < lastEpochs[i]) regression = true;
        }
        for (uint8 l = 1; l <= 5; ++l) {
            if (v.nonceOf(l) < lastNonces[l]) regression = true;
        }
        _snap();
    }

    function _snap() internal {
        lastEpochs = [v.authorityEpoch(), v.policyEpoch(), v.executionEpoch()];
        for (uint8 l = 1; l <= 5; ++l) {
            lastNonces[l] = v.nonceOf(l);
        }
    }

    function _win() internal view returns (PersonalVaultV2.Window memory w) {
        w.validAfter = uint64(block.timestamp);
        w.validUntil = w.validAfter + 600;
    }

    function _digest(uint8 action, uint8 lane, bytes32 ph, PersonalVaultV2.Window memory w) internal view returns (bytes32) {
        return v.actionDigest(action, lane, v.nonceOf(lane), ph, w.validAfter, w.validUntil);
    }

    function _th(PersonalVaultV2.Transfer memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei));
    }

    function _sign(bytes32 seed, bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(seed);
        cmd[4] = vm.toString(abi.encodePacked(digest));
        return vm.ffi(cmd);
    }

    receive() external payable {}
}

contract InvariantV2Test is BaseV2 {
    VaultV2Handler internal h;
    PersonalVaultV2 internal v;

    function setUp() public override {
        super.setUp();
        v = createVault(flexible(0.10 ether, 0.05 ether, 10 days, 0, 0.002 ether));
        vm.deal(address(v), 5 ether);
        bytes32 np = reg(N1);
        bytes32 na = reg(N2);
        h = new VaultV2Handler(v, P, A, [G1, G2, G3], [N1, N2], 0.10 ether);
        h.setKeyId(N1, np);
        h.setKeyId(N2, na);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](12);
        sel[0] = h.deposit.selector;
        sel[1] = h.fastSend.selector;
        sel[2] = h.protectedSend.selector;
        sel[3] = h.primaryOnlyProtected.selector;
        sel[4] = h.executeQueued.selector;
        sel[5] = h.grant.selector;
        sel[6] = h.finalize.selector;
        sel[7] = h.expire.selector;
        sel[8] = h.safety.selector;
        sel[9] = h.recover.selector;
        sel[10] = h.cancelRecovery.selector;
        sel[11] = h.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// forge-config: default.invariant.runs = 6
    /// forge-config: default.invariant.depth = 30
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_AccountingAndAuthority() public view {
        // Balance is exactly deposits minus everything paid out.
        assertEq(address(v).balance, h.deposits() - h.outflow(), "balance");
        // FAST debit equals the lifetime counter and never exceeds the latest jointly granted ceiling.
        assertEq(v.spent(address(0)), h.fastDebit(), "fast debit");
        assertLe(v.spent(address(0)), h.ceiling(), "ceiling");
        // No outflow while a security proposal was pending; no primary-only protected outflow.
        assertFalse(h.frozenOutflow(), "frozen or unauthorized outflow");
        // Epochs and nonces never go backwards.
        assertFalse(h.regression(), "regression");
    }
}
