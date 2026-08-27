import { strict as assert } from 'node:assert';
import {
  generateCauchyMatrix,
  encodeParity,
  decodeShards,
  protect,
  restore,
  unpackShard,
  gfMul,
  padPayload,
  SNCA_HEADER_SIZE,
} from '../src/js/cauchy_fallback.js';

function pass(msg) {
  console.log('PASS', msg);
}

async function testGfIdentity() {
  let mismatches = 0;
  for (let a = 0; a < 256; a++) {
    const one = gfMul(a, 1);
    if (one !== a) mismatches++;
    if (gfMul(a, 0) !== 0) mismatches++;
  }
  assert.equal(mismatches, 0);
  pass('gf mul identity');
}

async function testRoundtrip(k, m, length) {
  const payload = new Uint8Array(length);
  for (let i = 0; i < length; i++) payload[i] = (i * 37 + k * 13 + m) & 0xff;
  const result = await protect(payload, k, m, `t-${k}-${m}-${length}.bin`);
  assert.equal(result.fragments.length, k + m);
  for (const f of result.fragments) {
    const parsed = unpackShard(f.bytes);
    assert.equal(parsed.k, k);
    assert.equal(parsed.m, m);
    assert.equal(parsed.payload.length, result.blockSize);
    assert.equal(f.bytes.length, SNCA_HEADER_SIZE + result.blockSize);
  }
  const surviving = result.fragments.slice(0, k).map((f) => f.bytes);
  const restored = await restore(surviving);
  assert.equal(restored.checksumOk, true);
  assert.equal(restored.bytesLost, 0);
  assert.equal(restored.data.length, payload.length);
  assert.deepEqual(restored.data, payload);
  pass(`roundtrip k=${k} m=${m} n=${length} drop-m`);
}

async function testDropDataShards(k, m) {
  const payload = new TextEncoder().encode('SNCA-zero-byte-loss-vector-' + 'x'.repeat(200));
  const result = await protect(payload, k, m, 'loss.bin');
  const keep = [];
  for (const f of result.fragments) {
    if (f.kind === 'parity') keep.push(f.bytes);
  }
  for (let i = 0; i < result.fragments.length && keep.length < k; i++) {
    if (result.fragments[i].kind === 'data') keep.push(result.fragments[i].bytes);
  }
  assert.ok(keep.length >= k);
  const restored = await restore(keep);
  assert.equal(restored.checksumOk, true);
  assert.equal(restored.bytesLost, 0);
  assert.deepEqual(restored.data, payload);
  pass(`restore with parity-heavy subset k=${k} m=${m}`);
}

async function testUnrecoverable() {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const result = await protect(payload, 3, 1, 'u.bin');
  const onlyTwo = result.fragments.slice(0, 2).map((f) => f.bytes);
  let threw = false;
  try {
    await restore(onlyTwo);
  } catch (err) {
    threw = /unrecoverable/.test(String(err.message));
  }
  assert.equal(threw, true);
  pass('unrecoverable when < k shards');
}

async function testCorruptDetection() {
  const payload = new Uint8Array(128);
  payload[0] = 42;
  const result = await protect(payload, 4, 2, 'c.bin');
  const clone = new Uint8Array(result.fragments[0].bytes);
  clone[SNCA_HEADER_SIZE + 3] ^= 0xff;
  let threw = false;
  try {
    unpackShard(clone);
  } catch (err) {
    threw = /crc/.test(String(err.message));
  }
  assert.equal(threw, true);
  pass('crc detects shard corruption');
}

async function testDirectMatrixPath() {
  const k = 4;
  const m = 2;
  const data = padPayload(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]), k);
  const matrix = generateCauchyMatrix(k, m);
  const { parity, blockSize } = encodeParity(data, k, m, matrix);
  const n = k + m;
  const shards = new Uint8Array(n * blockSize);
  shards.set(data, 0);
  shards.set(parity, k * blockSize);
  const present = new Uint8Array(n);
  present.fill(1);
  present[0] = 0;
  present[1] = 0;
  decodeShards(shards, present, k, m, blockSize, matrix);
  assert.deepEqual(shards.subarray(0, data.length), data);
  pass('direct decodeShards recovers dropped data blocks');
}

await testGfIdentity();
await testDirectMatrixPath();
await testRoundtrip(2, 1, 17);
await testRoundtrip(4, 2, 1000);
await testRoundtrip(8, 4, 4096);
await testDropDataShards(4, 2);
await testUnrecoverable();
await testCorruptDetection();

if (process.exitCode) {
  console.error('TEST SUITE FAILED');
  process.exit(1);
}
console.log('TEST SUITE PASSED');
