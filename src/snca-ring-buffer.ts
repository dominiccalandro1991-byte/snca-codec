/**
 * Lock-free single-producer / single-consumer ring buffer
 * backed by SharedArrayBuffer + Atomics.
 * Zero-copy: producers and consumers operate directly on the shared view.
 */

export class SNCADataRingBuffer {
  private readonly sab: SharedArrayBuffer;
  private readonly meta: Int32Array;   // [writeIndex, readIndex, filled]
  private readonly data: Uint8Array;
  private readonly capacity: number;

  // meta layout
  private static readonly IDX_WRITE  = 0;
  private static readonly IDX_READ   = 1;
  private static readonly IDX_FILLED = 2;
  private static readonly META_SLOTS = 3;

  constructor(capacityBytes: number) {
    if (capacityBytes < 64 || (capacityBytes & (capacityBytes - 1)) !== 0) {
      throw new Error('capacity must be power-of-two and >= 64');
    }
    this.capacity = capacityBytes;
    // 12 bytes meta + capacity
    this.sab = new SharedArrayBuffer(SNCADataRingBuffer.META_SLOTS * 4 + capacityBytes);
    this.meta = new Int32Array(this.sab, 0, SNCADataRingBuffer.META_SLOTS);
    this.data = new Uint8Array(this.sab, SNCADataRingBuffer.META_SLOTS * 4, capacityBytes);
    Atomics.store(this.meta, SNCADataRingBuffer.IDX_WRITE, 0);
    Atomics.store(this.meta, SNCADataRingBuffer.IDX_READ, 0);
    Atomics.store(this.meta, SNCADataRingBuffer.IDX_FILLED, 0);
  }

  /** Transferable SAB for worker attachment */
  get sharedBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  /** Available bytes for reading */
  available(): number {
    return Atomics.load(this.meta, SNCADataRingBuffer.IDX_FILLED);
  }

  freeSpace(): number {
    return this.capacity - this.available();
  }

  /**
   * Write as many bytes as possible. Returns number written.
   * Single-producer safe.
   */
  write(src: Uint8Array): number {
    const space = this.freeSpace();
    const toWrite = Math.min(src.length, space);
    if (toWrite === 0) return 0;

    let writeIdx = Atomics.load(this.meta, SNCADataRingBuffer.IDX_WRITE);
    for (let i = 0; i < toWrite; ++i) {
      this.data[writeIdx] = src[i];
      writeIdx = (writeIdx + 1) & (this.capacity - 1);
    }
    Atomics.store(this.meta, SNCADataRingBuffer.IDX_WRITE, writeIdx);
    Atomics.add(this.meta, SNCADataRingBuffer.IDX_FILLED, toWrite);
    return toWrite;
  }

  /**
   * Read exactly `size` bytes into a new Uint8Array (or null if insufficient).
   * Single-consumer safe.
   */
  read(size: number): Uint8Array | null {
    if (this.available() < size) return null;
    const out = new Uint8Array(size);
    let readIdx = Atomics.load(this.meta, SNCADataRingBuffer.IDX_READ);
    for (let i = 0; i < size; ++i) {
      out[i] = this.data[readIdx];
      readIdx = (readIdx + 1) & (this.capacity - 1);
    }
    Atomics.store(this.meta, SNCADataRingBuffer.IDX_READ, readIdx);
    Atomics.sub(this.meta, SNCADataRingBuffer.IDX_FILLED, size);
    return out;
  }

  /** Zero-copy view of the next contiguous readable region (may wrap). */
  peekContiguous(): { view: Uint8Array; length: number } | null {
    const filled = this.available();
    if (filled === 0) return null;
    const readIdx = Atomics.load(this.meta, SNCADataRingBuffer.IDX_READ);
    const toEnd = this.capacity - readIdx;
    const len = Math.min(filled, toEnd);
    return { view: this.data.subarray(readIdx, readIdx + len), length: len };
  }
}
