import './styles.css';
import { SNCADataRingBuffer } from './snca-ring-buffer';
import type { SNCAResult, TelemetrySample, WorkerResponse } from './snca-types';

/* ------------------------------------------------------------------ */
/* DOM bindings                                                        */
/* ------------------------------------------------------------------ */
const dropZone = document.getElementById('dropZone') as HTMLElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const fileSummary = document.getElementById('fileSummary') as HTMLElement;
const kInput = document.getElementById('kInput') as HTMLInputElement;
const mInput = document.getElementById('mInput') as HTMLInputElement;
const encodeBtn = document.getElementById('encodeBtn') as HTMLButtonElement;
const decodeBtn = document.getElementById('decodeBtn') as HTMLButtonElement;
const shardGrid = document.getElementById('shardGrid') as HTMLElement;
const telemetryEl = document.getElementById('telemetry') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const resultsPanel = document.getElementById('resultsPanel') as HTMLElement;
const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
const settingsModal = document.getElementById('settingsModal') as HTMLElement;
const settingsClose = document.getElementById('settingsClose') as HTMLButtonElement;
const settingsBackdrop = document.getElementById('settingsBackdrop') as HTMLElement;

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */
let worker: Worker | null = null;
let ring: SNCADataRingBuffer | null = null;
let lastResult: SNCAResult | null = null;
let shardPresence: boolean[] = [];
const telemetryLog: TelemetrySample[] = [];
let ingestedBytes = 0;
let ingestedNames: string[] = [];

const RENDER_URL =
  (import.meta as any).env?.VITE_RENDER_SERVICE_URL ??
  'https://nano-cloud-backend.onrender.com';

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */
function initWorker(): void {
  worker = new Worker(new URL('./snca-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      setStatus('Ready', 'ready');
      encodeBtn.disabled = false;
    } else if (msg.type === 'encoded' && msg.result) {
      lastResult = msg.result;
      shardPresence = new Array(msg.result.k + msg.result.m).fill(true);
      resultsPanel.hidden = false;
      renderShards(msg.result);
      decodeBtn.disabled = false;
      setStatus('Protected', 'ready');
      logTelemetry({
        timestamp: Date.now(),
        latencyMs: msg.result.encodeLatencyMs,
        throughputMBps: msg.result.throughputMBps,
        operation: 'protect',
      });
      void persistSession(msg.result);
    } else if (msg.type === 'decoded' && msg.data) {
      setStatus('Restored', 'ready');
      logTelemetry({
        timestamp: Date.now(),
        latencyMs: 0,
        throughputMBps: 0,
        operation: 'restore',
      });
    } else if (msg.type === 'error') {
      setStatus('Error', 'error');
      console.error('[SNCA]', msg.error);
    }
  };
  worker.postMessage({ type: 'init' });
}

/* ------------------------------------------------------------------ */
/* File ingestion                                                      */
/* ------------------------------------------------------------------ */
function handleFiles(files: FileList | null): void {
  if (!files || !ring || files.length === 0) return;
  for (const file of Array.from(files)) {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      const written = ring!.write(buf);
      ingestedBytes += written;
      if (!ingestedNames.includes(file.name)) ingestedNames.push(file.name);
      updateFileSummary();
      setStatus('Ready', 'ready');
    };
    reader.readAsArrayBuffer(file);
  }
}

function updateFileSummary(): void {
  if (ingestedBytes <= 0) {
    fileSummary.hidden = true;
    return;
  }
  const mb = ingestedBytes / (1024 * 1024);
  const label =
    ingestedNames.length === 1
      ? ingestedNames[0]
      : `${ingestedNames.length} files`;
  const size =
    mb >= 0.01 ? `${mb.toFixed(2)} MB` : `${Math.max(1, Math.round(ingestedBytes / 1024))} KB`;
  fileSummary.textContent = `${label} · ${size}`;
  fileSummary.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Encoding / Decoding                                                 */
/* ------------------------------------------------------------------ */
function doEncode(): void {
  if (!worker || !ring) return;
  const k = parseInt(kInput.value, 10);
  const m = parseInt(mInput.value, 10);
  if (k < 1 || m < 1 || k + m > 32) {
    setStatus('Check settings', 'error');
    openSettings();
    return;
  }
  const avail = ring.available();
  const aligned = Math.floor(avail / k) * k;
  if (aligned === 0) {
    setStatus('Add files first', 'error');
    return;
  }
  const data = ring.read(aligned);
  if (!data) return;
  setStatus('Protecting…');
  encodeBtn.disabled = true;
  worker.postMessage({ type: 'encode', config: { k, m }, data }, [data.buffer]);
  encodeBtn.disabled = false;
}

function doDecode(): void {
  if (!worker || !lastResult) {
    setStatus('Protect first', 'error');
    return;
  }
  const { k, m, blockSize, data, parity } = lastResult;
  const n = k + m;
  const shards = new Uint8Array(n * blockSize);
  shards.set(data, 0);
  shards.set(parity, k * blockSize);
  const present = new Uint8Array(n);
  for (let i = 0; i < n; ++i) present[i] = shardPresence[i] ? 1 : 0;
  setStatus('Restoring…');
  worker.postMessage(
    { type: 'decode', config: { k, m }, shards, present, blockSize },
    [shards.buffer]
  );
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */
function renderShards(result: SNCAResult): void {
  shardGrid.innerHTML = '';
  for (let i = 0; i < result.k; ++i) {
    const el = document.createElement('div');
    el.className = 'shard data' + (shardPresence[i] ? '' : ' corrupted');
    el.setAttribute('role', 'listitem');
    el.innerHTML = `<span>${i + 1}</span><span class="shard-label">Data</span>`;
    el.title = 'Data fragment — tap to toggle loss';
    el.onclick = () => toggleShard(i, el);
    shardGrid.appendChild(el);
  }
  for (let i = 0; i < result.m; ++i) {
    const idx = result.k + i;
    const el = document.createElement('div');
    el.className = 'shard parity' + (shardPresence[idx] ? '' : ' corrupted');
    el.setAttribute('role', 'listitem');
    el.innerHTML = `<span>${i + 1}</span><span class="shard-label">Recovery</span>`;
    el.title = 'Recovery fragment — tap to toggle loss';
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
  telemetryEl.innerHTML = telemetryLog
    .slice(-8)
    .reverse()
    .map((s) => {
      const time = new Date(s.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const meta =
        s.operation === 'protect' && s.latencyMs > 0
          ? `${s.latencyMs.toFixed(1)} ms · ${s.throughputMBps.toFixed(1)} MB/s`
          : time;
      return `<div class="row"><span class="op">${s.operation}</span><span class="meta">${meta}</span></div>`;
    })
    .join('');
}

function setStatus(msg: string, kind?: 'ready' | 'error'): void {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.toggle('is-ready', kind === 'ready');
  statusEl.classList.toggle('is-error', kind === 'error');
}

/* ------------------------------------------------------------------ */
/* Settings modal                                                      */
/* ------------------------------------------------------------------ */
function openSettings(): void {
  settingsModal.hidden = false;
}

function closeSettings(): void {
  settingsModal.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */
async function persistSession(result: SNCAResult): Promise<void> {
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
    /* non-fatal */
  }
}

export async function callLlm(
  messages: Array<{ role: string; content: string }>,
  opts: { model?: string; temperature?: number; max_tokens?: number } = {}
): Promise<unknown> {
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
  ring = new SNCADataRingBuffer(1 << 20);
  initWorker();
  encodeBtn.disabled = true;
  decodeBtn.disabled = true;

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    handleFiles(e.dataTransfer?.files ?? null);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  encodeBtn.addEventListener('click', doEncode);
  decodeBtn.addEventListener('click', doDecode);

  settingsBtn.addEventListener('click', openSettings);
  settingsClose.addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
  });

  setStatus('Starting…');
}

bootstrap();
