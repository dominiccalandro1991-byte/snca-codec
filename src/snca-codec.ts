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
