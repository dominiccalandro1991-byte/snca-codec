/** Global interface & telemetry schemas for Nano Cloud Codec */

export interface SNCAConfig {
  k: number;
  m: number;
}

export interface SNCAResult {
  data: Uint8Array;
  parity: Uint8Array;
  k: number;
  m: number;
  blockSize: number;
  encodeLatencyMs: number;
  throughputMBps: number;
}

export interface ShardState {
  index: number;
  kind: 'data' | 'parity';
  present: boolean;
  corrupted: boolean;
  bytes: Uint8Array | null;
}

export interface TelemetrySample {
  timestamp: number;
  latencyMs: number;
  throughputMBps: number;
  operation: 'encode' | 'decode';
}

export interface WorkerRequest {
  type: 'init' | 'encode' | 'decode';
  config?: SNCAConfig;
  data?: Uint8Array;
  shards?: Uint8Array;
  present?: Uint8Array;
  blockSize?: number;
}

export interface WorkerResponse {
  type: 'ready' | 'encoded' | 'decoded' | 'error';
  result?: SNCAResult;
  data?: Uint8Array;
  error?: string;
}
