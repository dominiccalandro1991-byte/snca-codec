/**
 * Isolated codec worker.
 * Heavy GF(2^8) work never runs on the UI thread.
 * Transport: SharedArrayBuffer + Atomics when isolated; otherwise
 * structured-clone ArrayBuffer copies.
 */
import {
  protect,
  restore,
  unpackShard,
} from '../js/cauchy_fallback.js';

const ctx = self;
const RING_CAPACITY = 1 << 20;

/** @type {SharedArrayBuffer | ArrayBuffer | null} */
let ringBuffer = null;
/** @type {Int32Array | null} */
let ringMeta = null;
/** @type {Uint8Array | null} */
let ringData = null;
let ringShared = false;

const IDX_WRITE = 0;
const IDX_READ = 1;
const IDX_FILLED = 2;
const IDX_STATE = 3;

function post(msg, transfer) {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function initRing() {
  const metaBytes = 16;
  const total = metaBytes + RING_CAPACITY;
  try {
    if (typeof SharedArrayBuffer !== 'undefined') {
      ringBuffer = new SharedArrayBuffer(total);
      ringShared = true;
    } else {
      ringBuffer = new ArrayBuffer(total);
      ringShared = false;
    }
  } catch {
    ringBuffer = new ArrayBuffer(total);
    ringShared = false;
  }
  ringMeta = new Int32Array(ringBuffer, 0, 4);
  ringData = new Uint8Array(ringBuffer, metaBytes, RING_CAPACITY);
  if (ringShared) {
    Atomics.store(ringMeta, IDX_WRITE, 0);
    Atomics.store(ringMeta, IDX_READ, 0);
    Atomics.store(ringMeta, IDX_FILLED, 0);
    Atomics.store(ringMeta, IDX_STATE, 1);
  } else {
    ringMeta[IDX_WRITE] = 0;
    ringMeta[IDX_READ] = 0;
    ringMeta[IDX_FILLED] = 0;
    ringMeta[IDX_STATE] = 1;
  }
}

function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error('expected binary payload');
}

ctx.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'init': {
        initRing();
        post({
          type: 'ready',
          engine: 'js-cauchy-mds',
          shared: ringShared,
          ringCapacity: RING_CAPACITY,
        });
        return;
      }
      case 'protect': {
        const k = Number(msg.k);
        const m = Number(msg.m);
        const filename = msg.filename || 'payload.bin';
        const data = toUint8(msg.data);
        const result = await protect(data, k, m, filename);
        const fragments = result.fragments.map((f) => ({
          index: f.index,
          kind: f.kind,
          bytes: f.bytes,
        }));
        post({
          type: 'protected',
          fragments,
          k: result.k,
          m: result.m,
          blockSize: result.blockSize,
          originalLength: result.originalLength,
          filename: result.filename,
          digestHex: [...result.digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
          encodeLatencyMs: result.encodeLatencyMs,
          throughputMBps: result.throughputMBps,
        });
        return;
      }
      case 'restore': {
        const list = (msg.fragments || []).map((f) => toUint8(f.bytes || f));
        const result = await restore(list);
        post({
          type: 'restored',
          data: result.data,
          filename: result.filename,
          checksumOk: result.checksumOk,
          bytesLost: result.bytesLost,
          originalLength: result.originalLength,
          presentCount: result.presentCount,
          decodeLatencyMs: result.decodeLatencyMs,
          digestHex: [...result.digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
        });
        return;
      }
      case 'inspect': {
        const parsed = unpackShard(toUint8(msg.bytes));
        post({
          type: 'inspected',
          index: parsed.index,
          k: parsed.k,
          m: parsed.m,
          blockSize: parsed.blockSize,
          originalLength: parsed.originalLength,
          filename: parsed.filename,
        });
        return;
      }
      default:
        throw new Error(`unknown worker command ${msg.type}`);
    }
  } catch (err) {
    post({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

ctx.addEventListener('error', (ev) => {
  post({ type: 'error', error: ev.message || 'worker script error' });
});
