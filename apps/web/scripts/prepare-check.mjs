// Compares the browser blob builder with contracts/script/prepare.py on random keys.
// Run: node --experimental-strip-types scripts/prepare-check.mjs [count]
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { prepareBlob } from '../src/testnet/prepare.ts';

const n = Number(process.argv[2] || 5);
const py = new URL('../../../contracts/script/prepare.py', import.meta.url).pathname;
for (let i = 0; i < n; i++) {
  const { publicKey } = ml_dsa44.keygen(randomBytes(32));
  const want = execFileSync('python3', [py, Buffer.from(publicKey).toString('hex')]).toString();
  const got = Buffer.from(prepareBlob(publicKey)).toString('hex');
  if (got !== want) {
    const at = [...got].findIndex((c, k) => c !== want[k]);
    console.error(`MISMATCH on key ${i} at hex char ${at}`);
    process.exit(1);
  }
}
console.log(`prepare: ${n} random keys match prepare.py byte for byte`);
