#!/usr/bin/env bash
# Rehearses the whole mainnet launch on a local fork of Robinhood Chain mainnet. Nothing reaches the real chain:
# every transaction goes to a local anvil node, signed by a throwaway key made for this run and funded on the fork.
#
#   contracts/script/rehearse-mainnet.sh
#
# Steps: DeployV2 (with the mainnet gate phrase) -> SmokeV2 (FAST and protected transfers, two refusals) ->
# release2.mjs -> mainnet-config.mjs into a copy of the config -> mainnet-preflight.mjs. Everything lands in deployments/rehearsal/
# (git-ignored), so the real deployments/4663.v2.json is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."
here=$(pwd)
FORGE=${FORGE:-forge}
ANVIL=${ANVIL:-anvil}
CAST=${CAST:-cast}
PORT=${PORT:-8546}
MAINNET_RPC=${MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}
RPC="http://127.0.0.1:$PORT"
OUT=deployments/rehearsal/
CONFIG_COPY=../packages/config/src/rehearsal.local.ts
mkdir -p "$OUT"
rm -f "$OUT"/4663.v2*.json

"$ANVIL" --fork-url "$MAINNET_RPC" --port "$PORT" --chain-id 4663 --code-size-limit 98304 --gas-limit 1000000000 --silent &
anvil_pid=$!
trap 'kill $anvil_pid 2>/dev/null || true; rm -f "$here/$CONFIG_COPY"' EXIT
for _ in $(seq 1 60); do "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
[ "$("$CAST" chain-id --rpc-url "$RPC")" = 4663 ] || { echo "fork did not start"; exit 1; }
fork_block=$("$CAST" block-number --rpc-url "$RPC")
echo "Fork of Robinhood Chain mainnet at block $fork_block"

# A throwaway key for this run only, funded on the fork. It is never printed.
key=$("$CAST" wallet new --json | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d)[0].private_key))')
addr=$("$CAST" wallet address --private-key "$key")
"$CAST" rpc anvil_setBalance "$addr" 0x8AC7230489E80000 --rpc-url "$RPC" >/dev/null # 10 ETH on the fork
export DEPLOYER_PRIVATE_KEY=$key QUANLET_DEPLOY_OUT=$OUT QUANLET_MAINNET_GO=I_ACCEPT_THE_MAINNET_GATES FOUNDRY_PROFILE=deploy
before=$("$CAST" balance "$addr" --rpc-url "$RPC")

echo "1/5 Deploy (DeployV2)"
"$FORGE" script script/DeployV2.s.sol --rpc-url "$RPC" --broadcast --slow --skip-simulation 2>&1 | grep -E "KeyFactoryV2|VaultFactoryV2|manifest written|Error|error" || true
[ -f "$OUT/4663.v2.json" ] || { echo "deploy failed"; exit 1; }
after_deploy=$("$CAST" balance "$addr" --rpc-url "$RPC")

echo "2/5 Smoke test (SmokeV2)"
"$FORGE" script script/SmokeV2.s.sol --rpc-url "$RPC" --broadcast --slow --skip-simulation 2>&1 | grep -E "smoke vault|Error|error" || true
[ -f "$OUT/4663.v2.gate-b.json" ] || { echo "smoke test failed"; exit 1; }
after_smoke=$("$CAST" balance "$addr" --rpc-url "$RPC")
unset DEPLOYER_PRIVATE_KEY

echo "3/5 Release manifest"
(cd ../cli && node scripts/release2.mjs --chain 4663 --deployment "$here/$OUT/4663.v2.json" --rpc "$RPC" --out "$here/$OUT/4663.v2.release.json")

echo "4/5 Site config (into a temporary copy)"
cp ../packages/config/src/index.ts "$CONFIG_COPY"
(cd ../cli && QUANLET_RPC="$RPC" node scripts/mainnet-config.mjs --manifest "$here/$OUT/4663.v2.json" --config "$here/$CONFIG_COPY")

echo "5/5 Preflight"
(cd ../cli && node scripts/mainnet-preflight.mjs --manifest "$here/$OUT/4663.v2.json" --config "$here/$CONFIG_COPY" --rpc "$RPC")

node -e '
const [b, d, s] = process.argv.slice(1).map(BigInt);
const eth = (w) => (Number(w) / 1e18).toFixed(6);
console.log(`\nFork costs at fork gas prices (L1 data fees on the real chain come on top): deploy ${eth(b - d)} ETH, smoke test ${eth(d - s)} ETH including the 0.0002 ETH left in the smoke vault.`);
' "$before" "$after_deploy" "$after_smoke"
echo "Rehearsal passed. Results: contracts/$OUT"
