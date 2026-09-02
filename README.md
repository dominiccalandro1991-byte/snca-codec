# Nano Cloud Codec (SNCA)

Production GF(2⁸) Cauchy MDS erasure codec. One Protect / Restore path.

**Live site:** https://voltcore-org.github.io/snca-codec/

- App name: **Nano Cloud Codec (SNCA)**
- Bundle ID: `com.nanocloud.codec`
- Engine: `src/js/cauchy_fallback.js` (96-byte SNCA header, SHA-256, CRC-32)
- Worker: `src/worker/codec.worker.js`
- UI: `src/ui-controller.ts` — Protect, Restore, download `.snca` zip

Protect emits `k` data + `m` Cauchy parity shards. Restore accepts any subset of size `≥ k` and verifies SHA-256 (0-byte loss). Files never leave the browser.

```bash
npm install
npm test
npm run build
```

Push to `main` deploys GitHub Pages.
