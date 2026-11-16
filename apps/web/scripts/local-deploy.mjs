// Deploys the compiled Quanlet contracts (contracts/out) to a local test chain for end-to-end tests.
// Usage: node scripts/local-deploy.mjs http://127.0.0.1:8545  -> prints the deployment JSON
import { readFileSync } from 'node:fs';
import { encodeDeployData } from 'viem';

const RPC = process.argv[2] || 'http://127.0.0.1:8545';
const root = new URL('../../../contracts/', import.meta.url).pathname;
const art = (n) => JSON.parse(readFileSync(`${root}out/${n}.sol/${n}.json`, 'utf8'));
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const [from] = await rpc('eth_accounts');
async function deploy(data) {
  const hash = await rpc('eth_sendTransaction', [{ from, data, gas: '0x2faf080' }]);
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) {
      if (r.status !== '0x1') throw new Error('deploy reverted');
      return r.contractAddress;
    }
    await new Promise((s) => setTimeout(s, 200));
  }
}
const runtime = readFileSync(`${root}helpers/f1600_170.hex`, 'utf8').trim();
const len = (runtime.length / 2).toString(16).padStart(4, '0');
const helper = await deploy(`0x61${len}80600c6000396000f3${runtime}`);
const V = art('MLDSA44Verifier');
const verifier = await deploy(encodeDeployData({ abi: V.abi, bytecode: V.bytecode.object, args: [helper] }));
const K = art('KeyFactory');
const keyFactory = await deploy(encodeDeployData({ abi: K.abi, bytecode: K.bytecode.object, args: [verifier, helper] }));
const F = art('VaultFactory');
const vaultFactory = await deploy(encodeDeployData({ abi: F.abi, bytecode: F.bytecode.object, args: [keyFactory] }));
console.log(JSON.stringify({ keyFactory, vaultFactory, verifier }));
