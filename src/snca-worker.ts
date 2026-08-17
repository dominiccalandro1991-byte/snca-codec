/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse, SNCAResult } from './snca-types';
import { SNCACodec, assetUrl } from './snca-codec';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let codec: SNCACodec | null = null;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      codec = new SNCACodec();
      const jsPath = assetUrl('snca_codec.js');
      await codec.load(jsPath);
      const resp: WorkerResponse = { type: 'ready' };
      ctx.postMessage(resp);
      return;
    }

    if (!codec) throw new Error('Codec not initialised');

    if (msg.type === 'encode') {
      if (!msg.data || !msg.config) throw new Error('missing data/config');
      const result: SNCAResult = codec.encode(msg.data, msg.config.k, msg.config.m);
      const resp: WorkerResponse = { type: 'encoded', result };
      ctx.postMessage(resp);
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
      ctx.postMessage(resp);
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const resp: WorkerResponse = { type: 'error', error: message };
    ctx.postMessage(resp);
  }
};

ctx.addEventListener('error', (ev) => {
  const resp: WorkerResponse = { type: 'error', error: ev.message || 'worker script error' };
  ctx.postMessage(resp);
});
