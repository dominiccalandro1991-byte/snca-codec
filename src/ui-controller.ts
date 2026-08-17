import './styles.css';
import { SNCADataRingBuffer } from './snca-ring-buffer';
import type { SNCAResult, TelemetrySample, WorkerResponse } from './snca-types';

/* ------------------------------------------------------------------ */
/* Safe DOM helpers                                                    */
/* ------------------------------------------------------------------ */
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const dropZone = el<HTMLElement>('dropZone');
const fileInput = el<HTMLInputElement>('fileInput');
const fileSummary = el<HTMLElement>('fileSummary');
const kInput = el<HTMLInputElement>('kInput');
const mInput = el<HTMLInputElement>('mInput');
const encodeBtn = el<HTMLButtonElement>('encodeBtn');
const decodeBtn = el<HTMLButtonElement>('decodeBtn');
const shardGrid = el<HTMLElement>('shardGrid');
const telemetryEl = el<HTMLElement>('telemetry');
const statusEl = el<HTMLElement>('status');
const resultsPanel = el<HTMLElement>('resultsPanel');
const settingsBtn = el<HTMLButtonElement>('settingsBtn');
const settingsModal = el<HTMLElement>('settingsModal');
const settingsClose = el<HTMLButtonElement>('settingsClose');
const settingsBackdrop = el<HTMLElement>('settingsBackdrop');

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
let bootTimer: ReturnType<typeof setTimeout> | null = null;

const RENDER_URL =
  (import.meta as any).env?.VITE_RENDER_SERVICE_URL ??
  'https://nano-cloud-backend.onrender.com';

const WORKER_READY_TIMEOUT_MS = 20000;
const BACKEND_TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */
function setStatus(msg: string, kind?: 'ready' | 'error'): void {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.toggle('is-ready', kind === 'ready');
  statusEl.classList.toggle('is-error', kind === 'error');
  console.log('[SNCA]', msg);
}

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */
function clearBootTimer(): void {
  if (bootTimer !== null) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

function initWorker(): void {
  try {
    worker = new Worker(new URL('./snca-worker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    setStatus('Worker failed', 'error');
    console.error('[SNCA] Worker construct', err);
    return;
  }

  worker.onerror = (ev) => {
    clearBootTimer();
    setStatus('WASM Error', 'error');
    console.error('[SNCA] Worker error', ev.message);
  };

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    try {
      if (msg.type === 'ready') {
        clearBootTimer();
        setStatus('Ready', 'ready');
        if (encodeBtn) encodeBtn.disabled = false;
        return;
      }
      if (msg.type === 'encoded' && msg.result) {
        lastResult = msg.result;
        shardPresence = new Array(msg.result.k + msg.result.m).fill(true);
        if (resultsPanel) resultsPanel.hidden = false;
        renderShards(msg.result);
        if (decodeBtn) decodeBtn.disabled = false;
        setStatus('Protected', 'ready');
        logTelemetry({
          timestamp: Date.now(),
          latencyMs: msg.result.encodeLatencyMs,
          throughputMBps: msg.result.throughputMBps,
          operation: 'protect',
        });
        void persistSession(msg.result);
        return;
      }
      if (msg.type === 'decoded' && msg.data) {
        setStatus('Restored', 'ready');
        logTelemetry({
          timestamp: Date.now(),
          latencyMs: 0,
          throughputMBps: 0,
          operation: 'restore',
        });
        return;
      }
      if (msg.type === 'error') {
        clearBootTimer();
        setStatus('WASM Error', 'error');
        console.error('[SNCA] worker:', msg.error);
      }
    } catch (err) {
      setStatus('UI Error', 'error');
      console.error('[SNCA] onmessage handler', err);
    }
  };

  bootTimer = setTimeout(() => {
    setStatus('WASM timeout', 'error');
    console.error('[SNCA] Worker did not become ready within', WORKER_READY_TIMEOUT_MS, 'ms');
  }, WORKER_READY_TIMEOUT_MS);

  try {
    worker.postMessage({ type: 'init' });
  } catch (err) {
    clearBootTimer();
    setStatus('WASM Error', 'error');
    console.error('[SNCA] postMessage init', err);
  }
}

/* ------------------------------------------------------------------ */
/* File ingestion                                                      */
/* ------------------------------------------------------------------ */
function handleFiles(files: FileList | null): void {
  if (!files || !ring || files.length === 0) return;
  for (const file of Array.from(files)) {
    const reader = new FileReader();
    reader.onerror = () => setStatus('Read failed', 'error');
    reader.onload = () => {
      try {
        const buf = new Uint8Array(reader.result as ArrayBuffer);
        const written = ring!.write(buf);
        ingestedBytes += written;
        if (!ingestedNames.includes(file.name)) ingestedNames.push(file.name);
        updateFileSummary();
        setStatus('Ready', 'ready');
      } catch (err) {
        setStatus('Ingest failed', 'error');
        console.error(err);
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function updateFileSummary(): void {
  if (!fileSummary) return;
  if (ingestedBytes <= 0) {
    fileSummary.hidden = true;
    return;
  }
  const mb = ingestedBytes / (1024 * 1024);
  const label =
    ingestedNames.length === 1 ? ingestedNames[0] : `${ingestedNames.length} files`;
  const size =
    mb >= 0.01 ? `${mb.toFixed(2)} MB` : `${Math.max(1, Math.round(ingestedBytes / 1024))} KB`;
  fileSummary.textContent = `${label} · ${size}`;
  fileSummary.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Encode / Decode                                                     */
/* ------------------------------------------------------------------ */
function doEncode(): void {
  if (!worker || !ring) {
    setStatus('Not ready', 'error');
    return;
  }
  const k = parseInt(kInput?.value ?? '4', 10);
  const m = parseInt(mInput?.value ?? '2', 10);
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
  try {
    worker.postMessage({ type: 'encode', config: { k, m }, data }, [data.buffer]);
  } catch (err) {
    setStatus('Encode failed', 'error');
    console.error(err);
  }
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
  try {
    worker.postMessage(
      { type: 'decode', config: { k, m }, shards, present, blockSize },
      [shards.buffer]
    );
  } catch (err) {
    setStatus('Restore failed', 'error');
    console.error(err);
  }
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */
function renderShards(result: SNCAResult): void {
  if (!shardGrid) return;
  shardGrid.innerHTML = '';
  for (let i = 0; i < result.k; ++i) {
    const node = document.createElement('div');
    node.className = 'shard data' + (shardPresence[i] ? '' : ' corrupted');
    node.setAttribute('role', 'listitem');
    node.innerHTML = `<span>${i + 1}</span><span class="shard-label">Data</span>`;
    node.title = 'Data fragment — tap to toggle loss';
    node.onclick = () => toggleShard(i, node);
    shardGrid.appendChild(node);
  }
  for (let i = 0; i < result.m; ++i) {
    const idx = result.k + i;
    const node = document.createElement('div');
    node.className = 'shard parity' + (shardPresence[idx] ? '' : ' corrupted');
    node.setAttribute('role', 'listitem');
    node.innerHTML = `<span>${i + 1}</span><span class="shard-label">Recovery</span>`;
    node.title = 'Recovery fragment — tap to toggle loss';
    node.onclick = () => toggleShard(idx, node);
    shardGrid.appendChild(node);
  }
}

function toggleShard(index: number, node: HTMLElement): void {
  shardPresence[index] = !shardPresence[index];
  node.classList.toggle('corrupted', !shardPresence[index]);
}

function logTelemetry(sample: TelemetrySample): void {
  if (!telemetryEl) return;
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

function openSettings(): void {
  if (settingsModal) settingsModal.hidden = false;
}

function closeSettings(): void {
  if (settingsModal) settingsModal.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Backend coupling                                                    */
/* ------------------------------------------------------------------ */
async function persistSession(result: SNCAResult): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    await fetch(`${RENDER_URL}/api/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
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
  } catch (err) {
    console.warn('[SNCA] metrics (non-fatal)', err);
  } finally {
    clearTimeout(timer);
  }
}

async function pingBackend(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${RENDER_URL}/health`, { signal: ctrl.signal });
    if (!res.ok) console.warn('[SNCA] backend health', res.status);
  } catch (err) {
    console.warn('[SNCA] backend unreachable (non-fatal)', err);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */
function bootstrap(): void {
  try {
    setStatus('Starting…');

    try {
      ring = new SNCADataRingBuffer(1 << 20);
    } catch (err) {
      setStatus('Memory Error', 'error');
      console.error('[SNCA] ring buffer', err);
      return;
    }

    if (encodeBtn) encodeBtn.disabled = true;
    if (decodeBtn) decodeBtn.disabled = true;

    initWorker();
    void pingBackend();

    if (dropZone && fileInput) {
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
    }

    encodeBtn?.addEventListener('click', doEncode);
    decodeBtn?.addEventListener('click', doDecode);
    settingsBtn?.addEventListener('click', openSettings);
    settingsClose?.addEventListener('click', closeSettings);
    settingsBackdrop?.addEventListener('click', closeSettings);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && settingsModal && !settingsModal.hidden) closeSettings();
    });
  } catch (err) {
    setStatus('Boot failed', 'error');
    console.error('[SNCA] bootstrap', err);
  }
}

bootstrap();
