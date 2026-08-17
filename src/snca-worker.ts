/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse, SNCAResult } from './snca-types';
import { SNCACodec } from './snca-codec';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let codec: SNCACodec | null = null;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      codec = new SNCACodec();
      await codec.load('/snca_codec.js');
      const resp: WorkerResponse = { type: 'ready' };
      ctx.postMessage(resp);
      return;
    }

    if (!codec) throw new Error('Codec not initialised');

    if (msg.type === 'encode') {
      if (!msg.data || !msg.config) throw new Error('missing data/config');
      const result: SNCAResult = codec.encode(msg.data, msg.config.k, msg.config.m);
      const resp: WorkerResponse = { type: 'encoded', result };
      // Transfer parity buffer ownership
      ctx.postMessage(resp, [result.parity.buffer]);
      return;
    }

    if (msg.type === 'decode') {
      if (!msg.shards || !msg.present || !msg.config || msg.blockSize === undefined) {
        throw new Error('missing decode parameters');
      }
      const recovered = codec.decode(
        msg.shards,
        msg.present,
        msg.config.k,
        msg.config.m,
        msg.blockSize
      );
      const resp: WorkerResponse = { type: 'decoded', data: recovered };
      ctx.postMessage(resp, [recovered.buffer]);
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const resp: WorkerResponse = { type: 'error', error: message };
    ctx.postMessage(resp);
  }
};
