# Nano Cloud Codec

Production-grade **GF(2⁸) Cauchy MDS Erasure Coding Engine**.

- C++17 / Emscripten WASM with `-O3 -msimd128`
- Zero-copy SharedArrayBuffer transport
- Lock-free single-producer / single-consumer ring buffer
- Web Worker offload
- Vite + TypeScript frontend with mandatory COOP / COEP isolation headers
- Optional Supabase session ledger + Render metrics endpoint

## Architecture

```
┌─────────────┐     SharedArrayBuffer      ┌──────────────────┐
│  UI Thread  │◄──────────────────────────►│  snca-worker.ts  │
│ ui-controller│                             │  + SNCACodec     │
└─────────────┘                             └────────┬─────────┘
                                                     │ WASM
                                                     ▼
                                            ┌──────────────────┐
                                            │ snca_erasure.cpp │
                                            │  SIMD GF(2⁸)     │
                                            │  Cauchy encode/  │
                                            │  decode          │
                                            └──────────────────┘
```

## Quick Start

```bash
# 1. Install Node deps
npm install

# 2. Build WASM (requires activated emsdk)
cd wasm && bash build.sh && cd ..
# Copy artefacts into public/
cp wasm/build/snca_codec.js wasm/build/snca_codec.wasm public/

# 3. Dev server (COOP/COEP already configured)
npm run dev
```

## Production Build & GitHub Pages

The included GitHub Actions workflow:

1. Installs emsdk
2. Compiles the SIMD kernel
3. Runs `vite build`
4. Deploys `dist/` to GitHub Pages

## Configuration

Environment variables (Vite):

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Anon / publishable key |
| `VITE_RENDER_SERVICE_URL` | Render backend base URL |

## License

MIT
