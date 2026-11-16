// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MLDSA44Verifier} from "../../src/verifier/MLDSA44Verifier.sol";
import {IMLDSAVerifier} from "../../src/verifier/IMLDSAVerifier.sol";
import {KeyFactoryV2} from "../../src/v2/KeyFactoryV2.sol";
import {VaultFactoryV2} from "../../src/v2/VaultFactoryV2.sol";
import {PersonalVaultV2} from "../../src/v2/PersonalVaultV2.sol";
import {QuanletV2 as C, Policy, AssetRule} from "../../src/v2/QuanletV2.sol";

/// Shared protocol 2.0 fixture: real verifier, real ML-DSA-44 keys from fixed seeds, signed through node (FFI).
abstract contract BaseV2 is Test {
    MLDSA44Verifier internal verifier;
    KeyFactoryV2 internal keys;
    VaultFactoryV2 internal factory;
    address internal helper;

    // Fixed test seeds. Never use these anywhere else.
    bytes32 internal constant P = bytes32(uint256(0x5001));
    bytes32 internal constant A = bytes32(uint256(0x5002));
    bytes32 internal constant G1 = bytes32(uint256(0x5003));
    bytes32 internal constant G2 = bytes32(uint256(0x5004));
    bytes32 internal constant G3 = bytes32(uint256(0x5005));
    bytes32 internal constant N1 = bytes32(uint256(0x6001));
    bytes32 internal constant N2 = bytes32(uint256(0x6002));
    bytes32 internal constant N3 = bytes32(uint256(0x6003));

    address internal constant ETH = address(0);
    address payable internal alice = payable(address(0xA11CE));
    address payable internal bob = payable(address(0xB0B));
    address payable internal relay = payable(address(0x7E1A));

    mapping(bytes32 seed => bytes32 keyId) internal idOf;
    mapping(bytes32 keyId => bytes32 seed) internal seedOf;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        helper = _deployRaw(vm.parseBytes(string.concat("0x", _trim(vm.readFile("helpers/f1600_170.hex")))));
        verifier = new MLDSA44Verifier(helper);
        keys = new KeyFactoryV2(IMLDSAVerifier(address(verifier)), helper);
        factory = deployFactory(_one(ETH));
    }

    function deployFactory(address[] memory assets) internal returns (VaultFactoryV2) {
        bytes memory code = vm.getCode("PersonalVaultV2.sol:PersonalVaultV2");
        uint256 half = code.length / 2;
        address[] memory stores = new address[](2);
        stores[0] = _deployRaw(abi.encodePacked(hex"00", _slice(code, 0, half)));
        stores[1] = _deployRaw(abi.encodePacked(hex"00", _slice(code, half, code.length)));
        return new VaultFactoryV2(keys, stores, keccak256(code), assets);
    }

    // ---------------------------------------------------------------- keys

    function pkOf(bytes32 seed) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "pk";
        cmd[3] = vm.toString(seed);
        return vm.ffi(cmd);
    }

    function sign(bytes32 seed, bytes32 digest) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(seed);
        cmd[4] = vm.toString(abi.encodePacked(digest));
        return vm.ffi(cmd);
    }

    /// Register and activate a key (cached per seed).
    function reg(bytes32 seed) internal returns (bytes32 keyId) {
        if (idOf[seed] != bytes32(0)) return idOf[seed];
        keyId = keys.registerKey(pkOf(seed));
        uint64 a = uint64(block.timestamp);
        keys.activateKey(keyId, a, a + 600, sign(seed, keys.registrationDigest(keyId, a, a + 600)));
        idOf[seed] = keyId;
        seedOf[keyId] = seed;
    }

    // ---------------------------------------------------------------- policies

    function guarded() internal pure returns (Policy memory p) {
        p.fastFeeRecipients = new address[](0);
        p.assetRules = new AssetRule[](0);
    }

    function guardedWithDelay(uint32 d) internal pure returns (Policy memory p) {
        p = guarded();
        p.protectedDelay = d;
    }

    /// FAST on for ETH: `ceiling` absolute, `cap` per action, recipients alice and bob, fee recipient relay.
    function flexible(uint256 ceiling, uint256 cap, uint64 duration, uint32 delay, uint256 maxFee) internal view returns (Policy memory p) {
        p.protectedDelay = delay;
        p.fastEnabled = true;
        p.resumeFast = true;
        p.maxFastFeeWei = maxFee;
        p.fastFeeRecipients = _one(relay);
        p.assetRules = new AssetRule[](1);
        address[] memory rec = new address[](2);
        (rec[0], rec[1]) = address(alice) < address(bob) ? (address(alice), address(bob)) : (address(bob), address(alice));
        p.assetRules[0] = AssetRule(ETH, ceiling, cap, uint64(block.timestamp), uint64(block.timestamp) + duration, rec);
    }

    // ---------------------------------------------------------------- vaults

    function roleIds() internal returns (bytes32[5] memory r) {
        r = [reg(P), reg(A), reg(G1), reg(G2), reg(G3)];
    }

    function createVault(Policy memory p) internal returns (PersonalVaultV2 v) {
        return createVaultWith(factory, roleIds(), [P, A, G1, G2, G3], p, keccak256("salt"));
    }

    function createVaultWith(VaultFactoryV2 f, bytes32[5] memory ids, bytes32[5] memory seeds, Policy memory p, bytes32 salt)
        internal
        returns (PersonalVaultV2 v)
    {
        uint64 a = uint64(block.timestamp);
        bytes32 d = f.setupDigest(ids, p, salt, a, a + 600);
        bytes[5] memory sigs;
        for (uint256 i; i < 5; ++i) {
            sigs[i] = sign(seeds[i], d);
        }
        v = PersonalVaultV2(payable(f.createVaultV2(ids, p, salt, a, a + 600, sigs)));
    }

    // ---------------------------------------------------------------- signing helpers

    function win() internal view returns (PersonalVaultV2.Window memory w) {
        w.validAfter = uint64(block.timestamp);
        w.validUntil = w.validAfter + 600;
    }

    function digestOf(PersonalVaultV2 v, uint8 action, uint8 lane, bytes32 paramsHash, PersonalVaultV2.Window memory w)
        internal
        view
        returns (bytes32)
    {
        return v.actionDigest(action, lane, v.nonceOf(lane), paramsHash, w.validAfter, w.validUntil);
    }

    function xfer(uint8 route, address asset, address to, uint256 amount, address feeTo, uint256 fee)
        internal
        pure
        returns (PersonalVaultV2.Transfer memory t)
    {
        t = PersonalVaultV2.Transfer(route, asset, to, amount, feeTo, fee);
    }

    function transferHash(PersonalVaultV2.Transfer memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t.route, t.asset, t.recipient, t.amount, t.feeRecipient, t.feeWei));
    }

    /// Submit a FAST transfer signed by P.
    function fast(PersonalVaultV2 v, address to, uint256 amount, address feeTo, uint256 fee) internal returns (bytes32) {
        (PersonalVaultV2.Transfer memory t, PersonalVaultV2.Window memory w, bytes memory ps) = fastArgs(v, to, amount, feeTo, fee);
        return v.submitTransfer(t, w, ps, "");
    }

    /// Prepare a FAST transfer (for tests that expect a revert: sign first, then expect, then submit).
    function fastArgs(PersonalVaultV2 v, address to, uint256 amount, address feeTo, uint256 fee)
        internal
        returns (PersonalVaultV2.Transfer memory t, PersonalVaultV2.Window memory w, bytes memory ps)
    {
        t = xfer(C.ROUTE_FAST, ETH, to, amount, feeTo, fee);
        w = win();
        ps = sign(P, digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w));
    }

    /// Submit a PROTECTED transfer signed by P and A.
    function protectedTx(PersonalVaultV2 v, address asset, address to, uint256 amount, address feeTo, uint256 fee) internal returns (bytes32) {
        PersonalVaultV2.Transfer memory t = xfer(C.ROUTE_PROTECTED, asset, to, amount, feeTo, fee);
        PersonalVaultV2.Window memory w = win();
        bytes32 d = digestOf(v, C.A_TRANSFER, C.LANE_SPEND, transferHash(t), w);
        return v.submitTransfer(t, w, sign(P, d), sign(A, d));
    }

    function pairSigs(PersonalVaultV2 v, bytes32 pSeed, bytes32 aSeed, uint8 action, bytes32 paramsHash, PersonalVaultV2.Window memory w)
        internal
        returns (bytes memory, bytes memory, bytes32)
    {
        bytes32 d = digestOf(v, action, C.LANE_ADMIN, paramsHash, w);
        return (sign(pSeed, d), sign(aSeed, d), d);
    }

    function setPolicy(PersonalVaultV2 v, Policy memory p) internal returns (bytes32 id) {
        PersonalVaultV2.Window memory w = win();
        (bytes memory ps, bytes memory as_, bytes32 d) =
            pairSigs(v, P, A, C.A_UPDATE_POLICY, keccak256(abi.encode(keccak256(abi.encode(p)))), w);
        v.updatePolicy(p, w, ps, as_);
        return d;
    }

    function guardianSigs(PersonalVaultV2 v, uint8 i0, uint8 i1, uint8 action, bytes32 paramsHash, PersonalVaultV2.Window memory w)
        internal
        returns (PersonalVaultV2.GuardianSigs memory g, bytes32 d)
    {
        bytes32[3] memory gs = [G1, G2, G3];
        d = digestOf(v, action, C.LANE_RECOVERY, paramsHash, w);
        g.idx = [i0, i1];
        g.sigs = [sign(gs[i0], d), sign(gs[i1], d)];
    }

    function startRecovery(PersonalVaultV2 v, bytes32 pSeed, bytes32 aSeed) internal returns (bytes32 id) {
        bytes32 np = reg(pSeed);
        bytes32 na = reg(aSeed);
        PersonalVaultV2.Window memory w = win();
        (PersonalVaultV2.GuardianSigs memory g, bytes32 d) = guardianSigs(v, 0, 2, C.A_START_RECOVERY, keccak256(abi.encode(np, na)), w);
        v.startRecovery(np, na, w, g, sign(pSeed, v.consentDigest(d, C.ROLE_P, np)), sign(aSeed, v.consentDigest(d, C.ROLE_A, na)));
        return d;
    }

    // ---------------------------------------------------------------- utils

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _deployRaw(bytes memory runtime) internal returns (address a) {
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), "deploy failed");
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        while (n > 0 && (b[n - 1] == 0x0a || b[n - 1] == 0x0d || b[n - 1] == 0x20)) n--;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }
}
