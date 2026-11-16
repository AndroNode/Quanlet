// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MLDSA44Verifier} from "../src/verifier/MLDSA44Verifier.sol";
import {IMLDSAVerifier} from "../src/verifier/IMLDSAVerifier.sol";
import {KeyFactory} from "../src/KeyFactory.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {PersonalVault} from "../src/PersonalVault.sol";

/// Shared fixture: real verifier, real ML-DSA-44 keys (deterministic seeds) signed through node via FFI.
abstract contract Base is Test {
    MLDSA44Verifier internal verifier;
    KeyFactory internal keys;
    VaultFactory internal factory;

    // Deterministic test seeds. Never use these anywhere else.
    bytes32 internal constant P1 = bytes32(uint256(0x1001));
    bytes32 internal constant R1 = bytes32(uint256(0x2001));
    bytes32 internal constant R2 = bytes32(uint256(0x2002));
    bytes32 internal constant R3 = bytes32(uint256(0x2003));
    bytes32 internal constant N1 = bytes32(uint256(0x3001));
    bytes32 internal constant N2 = bytes32(uint256(0x3002));
    bytes32 internal constant N3 = bytes32(uint256(0x3003));

    mapping(bytes32 seed => bytes32 recordId) internal recordOf;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        bytes memory helperRuntime = vm.parseBytes(string.concat("0x", _trim(vm.readFile("helpers/f1600_170.hex"))));
        address helper = _deployRaw(helperRuntime);
        verifier = new MLDSA44Verifier(helper);
        keys = new KeyFactory(IMLDSAVerifier(address(verifier)), helper);
        factory = new VaultFactory(keys);
    }

    // ---------------------------------------------------------------- ffi helpers

    function pkOf(bytes32 seed) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/mldsa.mjs";
        cmd[2] = "pk";
        cmd[3] = vm.toString(seed);
        return vm.ffi(cmd);
    }

    function blobOf(bytes memory pk) internal returns (bytes memory) {
        string[] memory cmd = new string[](3);
        cmd[0] = "sh";
        cmd[1] = "test/ffi/blob.sh";
        cmd[2] = vm.toString(pk);
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

    function register(bytes32 seed) internal returns (bytes32 recordId) {
        if (recordOf[seed] != bytes32(0)) return recordOf[seed];
        bytes memory pk = pkOf(seed);
        bytes memory blob = blobOf(pk);
        bytes32 keyId = keys.keyIdOf(pk);
        bytes memory pop = sign(seed, keys.popMessage(keyId, keccak256(blob)));
        recordId = keys.registerKey(pk, pop);
        recordOf[seed] = recordId;
    }

    function kid(bytes32 recordId) internal view returns (bytes32) {
        return keys.getRecord(recordId).keyId;
    }

    function createVault(bytes32 p, bytes32 r1, bytes32 r2, bytes32 r3) internal returns (PersonalVault) {
        bytes32 pr = register(p);
        bytes32[3] memory rr = [register(r1), register(r2), register(r3)];
        bytes32 salt = keccak256("test-vault");
        uint64 a = uint64(vm.getBlockTimestamp());
        uint64 u = a + 600;
        bytes memory sig = sign(p, factory.setupDigest(pr, rr, salt, a, u));
        return PersonalVault(payable(factory.createVault(pr, rr, salt, a, u, sig)));
    }

    // ---------------------------------------------------------------- vault auth helpers

    function primaryAuth(PersonalVault v, bytes32 seed, uint8 action, bytes32 paramsHash)
        internal
        returns (PersonalVault.Auth memory a)
    {
        a.validAfter = uint64(vm.getBlockTimestamp());
        a.validUntil = a.validAfter + 1800;
        a.sig = sign(seed, v.actionDigest(action, v.primaryNonce(), paramsHash, a.validAfter, a.validUntil));
    }

    function quorumAuth(PersonalVault v, bytes32 s0, uint8 i0, bytes32 s1, uint8 i1, uint8 action, bytes32 paramsHash)
        internal
        returns (PersonalVault.QuorumAuth memory a)
    {
        a.validAfter = uint64(vm.getBlockTimestamp());
        a.validUntil = a.validAfter + 1800;
        bytes32 d = v.actionDigest(action, v.controlNonce(), paramsHash, a.validAfter, a.validUntil);
        a.signers = [i0, i1];
        a.sigs = [sign(s0, d), sign(s1, d)];
    }

    // ---------------------------------------------------------------- utils

    function _deployRaw(bytes memory runtime) internal returns (address a) {
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), "deploy failed");
    }

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        while (n > 0 && (b[n - 1] == 0x0a || b[n - 1] == 0x0d || b[n - 1] == 0x20)) n--;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = b[i];
        return string(out);
    }
}
