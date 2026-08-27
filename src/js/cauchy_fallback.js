/**
 * SNCA Cauchy MDS engine — pure JavaScript GF(2^8)
 * Functional parity with src/cpp/cauchy_mds.cpp / wasm/snca_erasure.cpp
 * Irreducible polynomial: 0x11D
 */
export const SNCA_MAGIC = 0x534e4341;
export const SNCA_VERSION = 1;
export const SNCA_HEADER_SIZE = 96;
export const SNCA_MAX_SHARDS = 32;
export const SNCA_MAX_K = 16;
export const SNCA_MAX_M = 16;

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

export function gfMul(a, b) {
  a &= 255;
  b &= 255;
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function gfInv(a) {
  return GF_INV[a & 255];
}

export function generateCauchyMatrix(k, m) {
  assertKm(k, m);
  const matrix = new Uint8Array(m * k);
  for (let i = 0; i < m; i++) {
    const y = k + i;
    for (let j = 0; j < k; j++) {
      const denom = j ^ y;
      if (denom === 0) throw new Error('cauchy denominator zero');
      matrix[i * k + j] = GF_INV[denom];
    }
  }
  return matrix;
}

function assertKm(k, m) {
  if (!Number.isInteger(k) || !Number.isInteger(m)) {
    throw new Error('k and m must be integers');
  }
  if (k < 1 || m < 1 || k > SNCA_MAX_K || m > SNCA_MAX_M || k + m > SNCA_MAX_SHARDS) {
    throw new Error(`invalid redundancy k=${k} m=${m}`);
  }
}

export function padPayload(data, k) {
  const unit = k * 16;
  const need = data.length === 0 ? unit : Math.ceil(data.length / unit) * unit;
  if (need === data.length) return data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(need);
  out.set(data);
  return out;
}

export function encodeParity(data, k, m, matrix) {
  if (data.length % k !== 0) throw new Error('payload not divisible by k');
  const blockSize = data.length / k;
  const parity = new Uint8Array(m * blockSize);
  const mat = matrix || generateCauchyMatrix(k, m);
  for (let shard = 0; shard < k; shard++) {
    const srcOff = shard * blockSize;
    for (let p = 0; p < m; p++) {
      const coeff = mat[p * k + shard];
      if (coeff === 0) continue;
      const dstOff = p * blockSize;
      if (coeff === 1) {
        for (let b = 0; b < blockSize; b++) parity[dstOff + b] ^= data[srcOff + b];
      } else {
        for (let b = 0; b < blockSize; b++) {
          parity[dstOff + b] ^= gfMul(coeff, data[srcOff + b]);
        }
      }
    }
  }
  return { parity, blockSize, matrix: mat };
}

function gfInvert(mat, n) {
  const width = 2 * n;
  const aug = new Uint8Array(n * width);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      aug[i * width + j] = mat[i * n + j];
      aug[i * width + n + j] = i === j ? 1 : 0;
    }
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    while (piv < n && aug[piv * width + col] === 0) piv++;
    if (piv === n) return null;
    if (piv !== col) {
      for (let j = 0; j < width; j++) {
        const tmp = aug[col * width + j];
        aug[col * width + j] = aug[piv * width + j];
        aug[piv * width + j] = tmp;
      }
    }
    const invPiv = GF_INV[aug[col * width + col]];
    for (let j = 0; j < width; j++) {
      aug[col * width + j] = gfMul(aug[col * width + j], invPiv);
    }
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row * width + col];
      if (factor === 0) continue;
      for (let j = 0; j < width; j++) {
        aug[row * width + j] ^= gfMul(factor, aug[col * width + j]);
      }
    }
  }
  const inv = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) inv[i * n + j] = aug[i * width + n + j];
  }
  return inv;
}

export function decodeShards(shards, present, k, m, blockSize, matrix) {
  assertKm(k, m);
  const n = k + m;
  if (shards.length !== n * blockSize) throw new Error('shards length mismatch');
  if (present.length !== n) throw new Error('present length mismatch');
  const presentIdx = [];
  const missingIdx = [];
  for (let i = 0; i < n; i++) {
    if (present[i]) presentIdx.push(i);
    else missingIdx.push(i);
  }
  if (missingIdx.length > m || presentIdx.length < k) {
    throw new Error(`unrecoverable: have ${presentIdx.length} need ${k}`);
  }
  if (missingIdx.length === 0) return shards;
  const mat = matrix || generateCauchyMatrix(k, m);
  const basis = presentIdx.slice(0, k);
  const dec = new Uint8Array(k * k);
  for (let r = 0; r < k; r++) {
    const shard = basis[r];
    if (shard < k) {
      for (let c = 0; c < k; c++) dec[r * k + c] = c === shard ? 1 : 0;
    } else {
      const prow = shard - k;
      for (let c = 0; c < k; c++) dec[r * k + c] = mat[prow * k + c];
    }
  }
  const inv = gfInvert(dec, k);
  if (!inv) throw new Error('singular decode matrix');
  const recoveredData = new Uint8Array(k * blockSize);
  for (let d = 0; d < k; d++) {
    const dstOff = d * blockSize;
    for (let r = 0; r < k; r++) {
      const coeff = inv[d * k + r];
      if (coeff === 0) continue;
      const srcOff = basis[r] * blockSize;
      if (coeff === 1) {
        for (let b = 0; b < blockSize; b++) recoveredData[dstOff + b] ^= shards[srcOff + b];
      } else {
        for (let b = 0; b < blockSize; b++) {
          recoveredData[dstOff + b] ^= gfMul(coeff, shards[srcOff + b]);
        }
      }
    }
  }
  for (let i = 0; i < k; i++) {
    shards.set(recoveredData.subarray(i * blockSize, (i + 1) * blockSize), i * blockSize);
  }
  for (let p = 0; p < m; p++) {
    const dest = k + p;
    if (present[dest]) continue;
    const outOff = dest * blockSize;
    shards.fill(0, outOff, outOff + blockSize);
    for (let d = 0; d < k; d++) {
      const coeff = mat[p * k + d];
      if (coeff === 0) continue;
      const srcOff = d * blockSize;
      if (coeff === 1) {
        for (let b = 0; b < blockSize; b++) shards[outOff + b] ^= recoveredData[srcOff + b];
      } else {
        for (let b = 0; b < blockSize; b++) {
          shards[outOff + b] ^= gfMul(coeff, recoveredData[srcOff + b]);
        }
      }
    }
  }
  return shards;
}

function writeU32LE(view, offset, value) {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
  view[offset + 2] = (value >>> 16) & 0xff;
  view[offset + 3] = (value >>> 24) & 0xff;
}

function readU32LE(view, offset) {
  return (
    view[offset] |
    (view[offset + 1] << 8) |
    (view[offset + 2] << 16) |
    (view[offset + 3] << 24)
  ) >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function sha256(bytes) {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }
  const { createHash } = await import('node:crypto');
  return new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest());
}

function encodeFilename(name) {
  const raw = new TextEncoder().encode(String(name || 'payload.bin').slice(0, 32));
  const out = new Uint8Array(32);
  out.set(raw.subarray(0, 32));
  return out;
}

function decodeFilename(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end)) || 'payload.bin';
}

export function packShard(headerFields, payload) {
  const buf = new Uint8Array(SNCA_HEADER_SIZE + payload.length);
  buf[0] = 0x53; buf[1] = 0x4e; buf[2] = 0x43; buf[3] = 0x41;
  buf[4] = SNCA_VERSION;
  buf[5] = headerFields.k;
  buf[6] = headerFields.m;
  buf[7] = headerFields.index;
  writeU32LE(buf, 8, headerFields.originalLength);
  writeU32LE(buf, 12, headerFields.blockSize);
  writeU32LE(buf, 16, headerFields.paddedLength);
  buf.set(headerFields.digest, 20);
  writeU32LE(buf, 52, crc32(payload));
  buf.set(headerFields.filenameBytes.subarray(0, 32), 56);
  buf.set(payload, SNCA_HEADER_SIZE);
  return buf;
}

export function unpackShard(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  if (buf.length < SNCA_HEADER_SIZE) throw new Error('shard truncated');
  if (buf[0] !== 0x53 || buf[1] !== 0x4e || buf[2] !== 0x43 || buf[3] !== 0x41) {
    throw new Error('invalid SNCA magic');
  }
  if (buf[4] !== SNCA_VERSION) throw new Error(`unsupported version ${buf[4]}`);
  const k = buf[5];
  const m = buf[6];
  const index = buf[7];
  const originalLength = readU32LE(buf, 8);
  const blockSize = readU32LE(buf, 12);
  const paddedLength = readU32LE(buf, 16);
  const digest = buf.slice(20, 52);
  const expectedCrc = readU32LE(buf, 52);
  const filenameBytes = buf.slice(56, 88);
  const payload = buf.slice(SNCA_HEADER_SIZE);
  if (payload.length !== blockSize) {
    throw new Error(`shard payload size ${payload.length} != blockSize ${blockSize}`);
  }
  if (crc32(payload) !== expectedCrc) throw new Error(`shard ${index} crc mismatch`);
  return {
    k, m, index, originalLength, blockSize, paddedLength, digest,
    filename: decodeFilename(filenameBytes),
    filenameBytes,
    payload,
  };
}

export async function protect(payload, k, m, filename = 'payload.bin') {
  assertKm(k, m);
  const original = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const digest = await sha256(original);
  const padded = padPayload(original, k);
  const t0 = nowMs();
  const { parity, blockSize, matrix } = encodeParity(padded, k, m);
  const t1 = nowMs();
  const filenameBytes = encodeFilename(filename);
  const common = {
    k, m,
    originalLength: original.length,
    blockSize,
    paddedLength: padded.length,
    digest,
    filenameBytes,
  };
  const fragments = [];
  for (let i = 0; i < k; i++) {
    const body = padded.subarray(i * blockSize, (i + 1) * blockSize);
    fragments.push({ index: i, kind: 'data', bytes: packShard({ ...common, index: i }, body) });
  }
  for (let i = 0; i < m; i++) {
    const body = parity.subarray(i * blockSize, (i + 1) * blockSize);
    fragments.push({ index: k + i, kind: 'parity', bytes: packShard({ ...common, index: k + i }, body) });
  }
  const latencyMs = t1 - t0;
  return {
    fragments, k, m, blockSize,
    originalLength: original.length,
    paddedLength: padded.length,
    digest, filename, matrix,
    encodeLatencyMs: latencyMs,
    throughputMBps: latencyMs > 0 ? original.length / (1024 * 1024) / (latencyMs / 1000) : 0,
  };
}

export async function restore(fragmentBytesList) {
  if (!Array.isArray(fragmentBytesList) || fragmentBytesList.length === 0) {
    throw new Error('no fragments supplied');
  }
  const parsed = fragmentBytesList.map((b) => unpackShard(b));
  const { k, m, blockSize, originalLength, paddedLength, digest, filename } = parsed[0];
  for (const p of parsed) {
    if (p.k !== k || p.m !== m || p.blockSize !== blockSize) {
      throw new Error('fragment parameter mismatch');
    }
  }
  const n = k + m;
  const shards = new Uint8Array(n * blockSize);
  const present = new Uint8Array(n);
  const seen = new Set();
  for (const p of parsed) {
    if (seen.has(p.index)) continue;
    seen.add(p.index);
    if (p.index >= n) throw new Error(`shard index ${p.index} out of range`);
    shards.set(p.payload, p.index * blockSize);
    present[p.index] = 1;
  }
  const t0 = nowMs();
  decodeShards(shards, present, k, m, blockSize);
  const t1 = nowMs();
  const padded = shards.subarray(0, paddedLength);
  const recovered = padded.subarray(0, originalLength);
  const got = await sha256(recovered);
  let bytesLost = 0;
  for (let i = 0; i < digest.length; i++) {
    if (digest[i] !== got[i]) {
      bytesLost = originalLength;
      break;
    }
  }
  const checksumOk = bytesLost === 0;
  return {
    data: recovered.slice(),
    filename, k, m, blockSize, originalLength, digest,
    recoveredDigest: got,
    checksumOk,
    bytesLost,
    presentCount: present.reduce((a, b) => a + b, 0),
    decodeLatencyMs: t1 - t0,
  };
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export const CauchyFallback = {
  generateCauchyMatrix, encodeParity, decodeShards, protect, restore,
  packShard, unpackShard, padPayload, sha256, crc32, gfMul, gfInv,
  SNCA_HEADER_SIZE, SNCA_VERSION,
};
