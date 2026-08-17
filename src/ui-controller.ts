import { SNCACodec } from './snca-codec';
import { SNCADataRingBuffer } from './snca-ring-buffer';
import type { SNCAResult, TelemetrySample, WorkerResponse } from './snca-types';

/* ------------------------------------------------------------------ */
/* DOM bindings                                                        */
/* ------------------------------------------------------------------ */
const dropZone   = document.getElementById('dropZone') as HTMLElement;
const fileInput  = document.getElementById('fileInput') as HTMLInputElement;
const kInput     = document.getElementById('kInput') as HTMLInputElement;
const mInput     = document.getElementById('mInput') as HTMLInputElement;
const encodeBtn  = document.getElementById('encodeBtn') as HTMLButtonElement;
const decodeBtn  = document.getElementById('decodeBtn') as HTMLButtonElement;
const shardGrid  = document.getElementById('shardGrid') as HTMLElement;
const telemetryEl= document.getElementById('telemetry') as HTMLElement;
const statusEl   = document.getElementById('status') as HTMLElement;

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */
let worker: Worker | null = null;
let ring: SNCADataRingBuffer | null = null;
let lastResult: SNCAResult | null = null;
let shardPresence: boolean[] = [];
const telemetryLog: TelemetrySample[] = [];

const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL
  ?? 'https://hlwqtlrkwhuogcwnhjrs.supabase.co';
const SUPABASE_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY
  ?? 'sb_publishable_r7yKRKkp-98kOmtH2MxA3Q_CfeozGBf';
const RENDER_URL = (import.meta as any).env?.VITE_RENDER_SERVICE_URL
  ?? 'https://nano-cloud-backend.onrender.com';

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */
function initWorker(): void {
  worker = new Worker(new URL('./snca-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      setStatus('Worker ready — SharedArrayBuffer + WASM online');
      encodeBtn.disabled = false;
    } else if (msg.type === 'encoded' && msg.result) {
      lastResult = msg.result;
      shardPresence = new Array(msg.result.k + msg.result.m).fill(true);
      renderShards(msg.result);
      logTelemetry({
        timestamp: Date.now(),
        latencyMs: msg.result.encodeLatencyMs,
        throughputMBps: msg.result.throughputMBps,
        operation: 'encode',
      });
      void persistSession(msg.result);
    } else if (msg.type === 'decoded' && msg.data) {
      setStatus(`Decode complete — ${msg.data.length} bytes recovered`);
      logTelemetry({
        timestamp: Date.now(),
        latencyMs: 0,
        throughputMBps: 0,
        operation: 'decode',
      });
    } else if (msg.type === 'error') {
      setStatus(`Error: ${msg.error}`);
    }
  };
  worker.postMessage({ type: 'init' });
}

/* ------------------------------------------------------------------ */
/* File ingestion                                                      */
/* ------------------------------------------------------------------ */
function handleFiles(files: FileList | null): void {
  if (!files || !ring) return;
  for (const file of Array.from(files)) {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      const written = ring!.write(buf);
      setStatus(`Ingested ${written} / ${buf.length} bytes from ${file.name}`);
    };
    reader.readAsArrayBuffer(file);
  }
}

/* ------------------------------------------------------------------ */
/* Encoding / Decoding                                                 */
/* ------------------------------------------------------------------ */
function doEncode(): void {
  if (!worker || !ring) return;
  const k = parseInt(kInput.value, 10);
  const m = parseInt(mInput.value, 10);
  if (k < 1 || m < 1 || k + m > 32) {
    setStatus('Invalid k/m (1 ≤ k,m and k+m ≤ 32)');
    return;
  }
  // Align payload to multiple of k
  let avail = ring.available();
  const aligned = Math.floor(avail / k) * k;
  if (aligned === 0) {
    setStatus('Insufficient data in ring buffer');
    return;
  }
  const data = ring.read(aligned);
  if (!data) return;
  worker.postMessage({ type: 'encode', config: { k, m }, data }, [data.buffer]);
}

function doDecode(): void {
  if (!worker || !lastResult) {
    setStatus('Encode first');
    return;
  }
  const { k, m, blockSize, data, parity } = lastResult;
  const n = k + m;
  const shards = new Uint8Array(n * blockSize);
  shards.set(data, 0);
  shards.set(parity, k * blockSize);

  const present = new Uint8Array(n);
  for (let i = 0; i < n; ++i) present[i] = shardPresence[i] ? 1 : 0;

  worker.postMessage({
    type: 'decode',
    config: { k, m },
    shards,
    present,
    blockSize,
  }, [shards.buffer]);
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */
function renderShards(result: SNCAResult): void {
  shardGrid.innerHTML = '';
  for (let i = 0; i < result.k; ++i) {
    const el = document.createElement('div');
    el.className = 'shard data' + (shardPresence[i] ? '' : ' corrupted');
    el.textContent = `D${i}`;
    el.title = `Data shard ${i}`;
    el.onclick = () => toggleShard(i, el);
    shardGrid.appendChild(el);
  }
  for (let i = 0; i < result.m; ++i) {
    const idx = result.k + i;
    const el = document.createElement('div');
    el.className = 'shard parity' + (shardPresence[idx] ? '' : ' corrupted');
    el.textContent = `P${i}`;
    el.title = `Parity shard ${i} — click to toggle loss`;
    el.onclick = () => toggleShard(idx, el);
    shardGrid.appendChild(el);
  }
}

function toggleShard(index: number, el: HTMLElement): void {
  shardPresence[index] = !shardPresence[index];
  el.classList.toggle('corrupted', !shardPresence[index]);
}

function logTelemetry(sample: TelemetrySample): void {
  telemetryLog.push(sample);
  if (telemetryLog.length > 50) telemetryLog.shift();
  const lines = telemetryLog
    .slice(-8)
    .map(s =>
      `[${new Date(s.timestamp).toLocaleTimeString()}] ${s.operation} ` +
      `${s.latencyMs.toFixed(2)} ms  ${s.throughputMBps.toFixed(1)} MB/s`
    );
  telemetryEl.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
}

function setStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
  console.log('[SNCA]', msg);
}

/* ------------------------------------------------------------------ */
/* Optional persistence via Supabase / Render                          */
/* ------------------------------------------------------------------ */
async function persistSession(result: SNCAResult): Promise<void> {
  // All privileged writes go through the Render proxy (service role).
  // Direct Supabase REST with anon key is intentionally removed.
  try {
    await fetch(`${RENDER_URL}/api/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        k: result.k,
        m: result.m,
        bytes: result.data.length,
        latencyMs: result.encodeLatencyMs,
        throughputMBps: result.throughputMBps,
        source: 'codec-ui',
        ts: Date.now(),
      }),
    });
  } catch {
    /* backend may be cold — non-fatal */
  }
}

/**
 * OpenRouter LLM proxy — browser never holds OPENROUTER_API_KEY.
 * POST https://<render>/api/llm  { model?, messages, temperature?, max_tokens? }
 */
export async function callLlm(messages: Array<{ role: string; content: string }>, opts: {
  model?: string;
  temperature?: number;
  max_tokens?: number;
} = {}): Promise<unknown> {
  const res = await fetch(`${RENDER_URL}/api/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? 'openai/gpt-4o-mini',
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 1024,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `llm_http_${res.status}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */
function bootstrap(): void {
  ring = new SNCADataRingBuffer(1 << 20); // 1 MiB ring
  initWorker();
  encodeBtn.disabled = true;
  decodeBtn.disabled = false;

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    handleFiles(e.dataTransfer?.files ?? null);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  encodeBtn.addEventListener('click', doEncode);
  decodeBtn.addEventListener('click', doDecode);

  setStatus('Initialising WASM + Worker…');
}

bootstrap();
