#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if ! command -v emcc >/dev/null 2>&1; then
    echo "ERROR: emcc not found. Activate emsdk first:"
    echo "  source /path/to/emsdk/emsdk_env.sh"
    exit 1
fi

mkdir -p build
cd build

emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make -j"$(nproc 2>/dev/null || echo 2)"

echo "Build complete: build/snca_codec.js + build/snca_codec.wasm"
ls -la snca_codec.*
