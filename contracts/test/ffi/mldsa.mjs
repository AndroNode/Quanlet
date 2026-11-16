// FFI helper for forge tests and deploy scripts: deterministic ML-DSA-44 keys from a 32-byte seed.
// Pure ML-DSA, empty context, deterministic signing (extraEntropy: false). Test use only.
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));

const [cmd, seedHex, msgHex] = process.argv.slice(2);
const keys = ml_dsa44.keygen(unhex(seedHex));
if (cmd === 'pk') process.stdout.write(hex(keys.publicKey));
else if (cmd === 'sign') process.stdout.write(hex(ml_dsa44.sign(unhex(msgHex), keys.secretKey, { extraEntropy: false })));
else {
  process.stderr.write('usage: mldsa.mjs pk|sign <seed32hex> [msgHex]\n');
  process.exit(1);
}
