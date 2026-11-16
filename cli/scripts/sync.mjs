// Copies the complete ABIs (and PersonalVault's creation code, needed to predict vault addresses offline)
// from the Foundry build, and the deployment manifests, into this package so it works on its own.
//   cd contracts && forge build && cd ../cli && node scripts/sync.mjs
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, '..', '..', 'contracts');
// PersonalVault and PersonalVaultV2 keep their creation code: the toolkit predicts vault addresses from it.
const want = { KeyFactory: false, VaultFactory: false, PersonalVault: true, MLDSA44Verifier: false, KeyFactoryV2: false, VaultFactoryV2: false, PersonalVaultV2: true };
for (const [name, withCode] of Object.entries(want)) {
  const art = JSON.parse(readFileSync(join(contracts, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  const out = { contractName: name, abi: art.abi };
  if (withCode) out.bytecode = art.bytecode.object;
  writeFileSync(join(here, '..', 'abi', `${name}.json`), JSON.stringify(out, null, 1) + '\n');
}
for (const f of readdirSync(join(contracts, 'deployments'))) {
  if (f.endsWith('.json')) copyFileSync(join(contracts, 'deployments', f), join(here, '..', 'deployments', f));
}
console.log('synced abi/ and deployments/');
