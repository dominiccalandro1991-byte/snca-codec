/**
 * Ring buffer — prefers SharedArrayBuffer + Atomics; falls back to
 * a plain ArrayBuffer when cross-origin isolation is unavailable
 * (e.g. GitHub Pages without COOP/COEP headers).
 */

export class SNCADataRingBuffer {
  private readonly meta: Int32Array;
  private readonly data: Uint8Array;
  private readonly capacity: number;
  private readonly shared: boolean;

  private static readonly IDX_WRITE = 0;
  private static readonly IDX_READ = 1;
  private static readonly IDX_FILLED = 2;
  private static readonly META_SLOTS = 3;

  constructor(capacityBytes: number) {
    if (capacityBytes < 64 || (capacityBytes & (capacityBytes - 1)) !== 0) {
      throw new Error('capacity must be power-of-two and >= 64');
    }
    this.capacity = capacityBytes;

    const metaBytes = SNCADataRingBuffer.META_SLOTS * 4;
    const total = metaBytes + capacityBytes;

    let buffer: ArrayBuffer | SharedArrayBuffer;
    let shared = false;
    try {
      if (typeof SharedArrayBuffer !== 'undefined') {
        buffer = new SharedArrayBuffer(total);
        shared = true;
      } else {
        buffer = new ArrayBuffer(total);
      }
    } catch {
      buffer = new ArrayBuffer(total);
      shared = false;
    }

    this.shared = shared;
    this.meta = new Int32Array(buffer, 0, SNCADataRingBuffer.META_SLOTS);
    this.data = new Uint8Array(buffer, metaBytes, capacityBytes);

    this.store(SNCADataRingBuffer.IDX_WRITE, 0);
    this.store(SNCADataRingBuffer.IDX_READ, 0);
    this.store(SNCADataRingBuffer.IDX_FILLED, 0);
  }

  get isShared(): boolean {
    return this.shared;
  }

  private load(index: number): number {
    if (this.shared) {
      return Atomics.load(this.meta, index);
    }
    return this.meta[index];
  }

  private store(index: number, value: number): void {
    if (this.shared) {
      Atomics.store(this.meta, index, value);
    } else {
      this.meta[index] = value;
    }
  }

  private add(index: number, delta: number): void {
    if (this.shared) {
      Atomics.add(this.meta, index, delta);
    } else {
      this.meta[index] += delta;
    }
  }

  private sub(index: number, delta: number): void {
    if (this.shared) {
      Atomics.sub(this.meta, index, delta);
    } else {
      this.meta[index] -= delta;
    }
  }

  available(): number {
    return this.load(SNCADataRingBuffer.IDX_FILLED);
  }

  freeSpace(): number {
    return this.capacity - this.available();
  }

  write(src: Uint8Array): number {
    const space = this.freeSpace();
    const toWrite = Math.min(src.length, space);
    if (toWrite === 0) return 0;

    let writeIdx = this.load(SNCADataRingBuffer.IDX_WRITE);
    for (let i = 0; i < toWrite; ++i) {
      this.data[writeIdx] = src[i];
      writeIdx = (writeIdx + 1) & (this.capacity - 1);
    }
    this.store(SNCADataRingBuffer.IDX_WRITE, writeIdx);
    this.add(SNCADataRingBuffer.IDX_FILLED, toWrite);
    return toWrite;
  }

  read(size: number): Uint8Array | null {
    if (this.available() < size) return null;
    const out = new Uint8Array(size);
    let readIdx = this.load(SNCADataRingBuffer.IDX_READ);
    for (let i = 0; i < size; ++i) {
      out[i] = this.data[readIdx];
      readIdx = (readIdx + 1) & (this.capacity - 1);
    }
    this.store(SNCADataRingBuffer.IDX_READ, readIdx);
    this.sub(SNCADataRingBuffer.IDX_FILLED, size);
    return out;
  }
}
