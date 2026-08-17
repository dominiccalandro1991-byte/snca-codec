import type { SNCAResult } from './snca-types';

type SNCAModule = {
  _snca_init: () => number;
  _snca_generate_cauchy_matrix: (ptr: number, k: number, m: number) => number;
  _snca_encode_direct: (
    inPtr: number,
    outPtr: number,
    matPtr: number,
    len: number,
    k: number,
    m: number
  ) => number;
  _snca_decode_direct: (
    shardsPtr: number,
    presentPtr: number,
    matPtr: number,
    blockSize: number,
    k: number,
    m: number
  ) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
};

/** Resolve asset URL under Vite base (e.g. /snca-codec/). */
export function assetUrl(file: string): string {
  const base = (import.meta as any).env?.BASE_URL ?? '/';
  const normalized = String(base).endsWith('/') ? String(base) : `${base}/`;
  return `${normalized}${file.replace(/^\//, '')}`;
}


/* Pure-JS GF(2^8) fallback when WASM encode throws */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
const GF_INV = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  GF_LOG[0] = 0;
  GF_INV[0] = 0;
  for (let i = 1; i < 256; i++) GF_INV[i] = GF_EXP[255 - GF_LOG[i]];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function jsCauchyEncode(data: Uint8Array, k: number, m: number): SNCAResult {
  if (data.length % k !== 0) throw new Error('payload not divisible by k');
  const blockSize = data.length / k;
  const parity = new Uint8Array(m * blockSize);
  const matrix = new Uint8Array(m * k);
  for (let i = 0; i < m; i++) {
    const y = k + i;
    for (let j = 0; j < k; j++) {
      const denom = j ^ y;
      matrix[i * k + j] = GF_INV[denom];
    }
  }
  const t0 = performance.now();
  for (let shard = 0; shard < k; shard++) {
    const srcOff = shard * blockSize;
    for (let p = 0; p < m; p++) {
      const coeff = matrix[p * k + shard];
      if (coeff === 0) continue;
      const dstOff = p * blockSize;
      if (coeff === 1) {
        for (let b = 0; b < blockSize; b++) parity[dstOff + b] ^= data[srcOff + b];
      } else {
        for (let b = 0; b < blockSize; b++) parity[dstOff + b] ^= gfMul(coeff, data[srcOff + b]);
      }
    }
  }
  const t1 = performance.now();
  const latency = t1 - t0;
  return {
    data,
    parity,
    k,
    m,
    blockSize,
    encodeLatencyMs: latency,
    throughputMBps: latency > 0 ? data.length / (1024 * 1024) / (latency / 1000) : 0,
  };
}

export class SNCACodec {
  private module: SNCAModule | null = null;
  private ready = false;

  async load(jsUrl?: string): Promise<void> {
    const scriptUrl = jsUrl ?? assetUrl('snca_codec.js');
    const wasmUrl = assetUrl('snca_codec.wasm');

    let factory: (arg?: object) => Promise<SNCAModule>;
    try {
      const res = await fetch(scriptUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${scriptUrl}`);
      const code = await res.text();
      // Emscripten MODULARIZE emits createSNCAModule as a global, not an ESM export.
      const blob = new Blob(
        [`${code}\nexport default typeof createSNCAModule !== 'undefined' ? createSNCAModule : null;`],
        { type: 'text/javascript' }
      );
      const blobUrl = URL.createObjectURL(blob);
      try {
        const mod: any = await import(/* @vite-ignore */ blobUrl);
        factory = mod.default ?? mod.createSNCAModule;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch (err) {
      throw new Error(
        `WASM loader failed (${scriptUrl}): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (typeof factory !== 'function') {
      throw new Error('WASM module factory not found (createSNCAModule)');
    }

    try {
      this.module = (await factory({
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) return wasmUrl;
          return path;
        },
      })) as SNCAModule;
    } catch (err) {
      throw new Error(`WASM instantiate failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!this.module || typeof this.module._snca_init !== 'function') {
      throw new Error('WASM module missing _snca_init');
    }

    const rc = this.module._snca_init();
    if (rc !== 0) throw new Error(`snca_init failed: ${rc}`);
    this.ready = true;
  }

  private ensureReady(): SNCAModule {
    if (!this.ready || !this.module) throw new Error('SNCACodec not initialised');
    return this.module;
  }

  generateCauchyMatrix(k: number, m: number): Uint8Array {
    const mod = this.ensureReady();
    const bytes = k * m;
    const ptr = mod._malloc(bytes);
    try {
      const rc = mod._snca_generate_cauchy_matrix(ptr, k, m);
      if (rc !== 0) throw new Error(`generateCauchyMatrix failed: ${rc}`);
      return new Uint8Array(mod.HEAPU8.subarray(ptr, ptr + bytes));
    } finally {
      mod._free(ptr);
    }
  }

  encode(data: Uint8Array, k: number, m: number): SNCAResult {
    try {
      return this.encodeWasm(data, k, m);
    } catch (err) {
      console.warn('[SNCA] WASM encode failed, using JS fallback', err);
      return jsCauchyEncode(data, k, m);
    }
  }

  private encodeWasm(data: Uint8Array, k: number, m: number): SNCAResult {
    const mod = this.ensureReady();
    if (data.length % k !== 0) {
      throw new Error(`payload length ${data.length} not divisible by k=${k}`);
    }
    const blockSize = data.length / k;
    const parityLen = m * blockSize;

    const inPtr = mod._malloc(data.length);
    const outPtr = mod._malloc(parityLen);
    const matPtr = mod._malloc(k * m);

    try {
      mod.HEAPU8.set(data, inPtr);
      const matrix = this.generateCauchyMatrix(k, m);
      mod.HEAPU8.set(matrix, matPtr);

      const t0 = performance.now();
      const rc = mod._snca_encode_direct(inPtr, outPtr, matPtr, data.length, k, m);
      const t1 = performance.now();
      if (rc !== 0) throw new Error(`encode failed: ${rc}`);

      const parity = new Uint8Array(mod.HEAPU8.subarray(outPtr, outPtr + parityLen));
      const latency = t1 - t0;
      const throughput = latency > 0 ? data.length / (1024 * 1024) / (latency / 1000) : 0;

      return {
        data,
        parity: parity.slice(),
        k,
        m,
        blockSize,
        encodeLatencyMs: latency,
        throughputMBps: throughput,
      };
    } finally {
      mod._free(inPtr);
      mod._free(outPtr);
      mod._free(matPtr);
    }
  }

  decode(
    shards: Uint8Array,
    present: Uint8Array,
    k: number,
    m: number,
    blockSize: number
  ): Uint8Array {
    const mod = this.ensureReady();
    const n = k + m;
    if (shards.length !== n * blockSize) throw new Error('shards length mismatch');
    if (present.length !== n) throw new Error('present length mismatch');

    const shardsPtr = mod._malloc(shards.length);
    const presentPtr = mod._malloc(n);
    const matPtr = mod._malloc(k * m);

    try {
      mod.HEAPU8.set(shards, shardsPtr);
      mod.HEAPU8.set(present, presentPtr);
      const matrix = this.generateCauchyMatrix(k, m);
      mod.HEAPU8.set(matrix, matPtr);

      const rc = mod._snca_decode_direct(shardsPtr, presentPtr, matPtr, blockSize, k, m);
      if (rc !== 0) throw new Error(`decode failed: ${rc}`);

      return new Uint8Array(mod.HEAPU8.subarray(shardsPtr, shardsPtr + shards.length));
    } finally {
      mod._free(shardsPtr);
      mod._free(presentPtr);
      mod._free(matPtr);
    }
  }
}
