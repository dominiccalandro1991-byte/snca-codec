# Nano Cloud Codec (SNCA)

Production GF(2⁸) Cauchy MDS erasure codec.

- App name: **Nano Cloud Codec (SNCA)**
- Bundle ID: `com.nanocloud.codec`
- Frontend: GitHub Pages
- Worker: `src/worker/codec.worker.js`
- JS engine: `src/js/cauchy_fallback.js`
- C++/WASM: `src/cpp/cauchy_mds.*` + `wasm/snca_erasure.cpp`
- Backend: `server/index.js` → `https://nano-cloud-backend.onrender.com`

## Protect / Restore

Protect emits `k` data + `m` Cauchy parity shards with a 96-byte SNCA header (magic, parameters, SHA-256, CRC-32).
Restore accepts any subset of size `≥ k` and verifies SHA-256 (0-byte loss).

## Verification commands

```bash
# a) WASM
source /path/to/emsdk/emsdk_env.sh
npm run wasm

# b) tests + web
npm install
npm test
npm run dev

# c) native
npm run build
npx cap add android   # first time
npx cap add ios       # first time
npx cap sync

# d) deploy
# Pages: push main
# Render: rootDir=server, start=`node index.js`
```

Pages: https://dominiccalandro1991-byte.github.io/snca-codec/

## License

MIT
