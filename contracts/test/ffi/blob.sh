#!/bin/sh
# Prints 0x-prefixed prepared key blob for an ML-DSA-44 public key (hex arg). Wraps script/prepare.py (Fireblocks Labs, MIT).
set -e
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
printf '0x'
python3 "$DIR/script/prepare.py" "$1" | tr -d '\n'
