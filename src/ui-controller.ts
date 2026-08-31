import './styles.css';
import './pages.css';
import { zipStore } from './js/zip.js';

const MAX_PAYLOAD = 8 * 1024 * 1024;

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
const sampleBtn = el<HTMLButtonElement>('sampleBtn');
const downloadZipBtn = el<HTMLButtonElement>('downloadZipBtn');
const downloadFileBtn = el<HTMLButtonElement>('downloadFileBtn');
const shardGrid = el<HTMLElement>('shardGrid');
const telemetryEl = el<HTMLElement>('telemetry');
const statusEl = el<HTMLElement>('status');
const resultsPanel = el<HTMLElement>('resultsPanel');
const settingsBtn = el<HTMLButtonElement>('settingsBtn');
const settingsModal = el<HTMLElement>('settingsModal');
const settingsClose = el<HTMLButtonElement>('settingsClose');
const settingsBackdrop = el<HTMLElement>('settingsBackdrop');

type Fragment = { index: number; kind: 'data' | 'parity'; bytes: Uint8Array };

let worker: Worker | null = null;
let pendingFile: { name: string; bytes: Uint8Array } | null = null;
let fragments: Fragment[] = [];
let present: boolean[] = [];
let lastK = 4;
let lastM = 2;
let lastFilename = 'payload.bin';
let recovered: { name: string; bytes: Uint8Array } | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(msg: string, kind?: 'ready' | 'error'): void {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.toggle('is-ready', kind === 'ready');
  statusEl.classList.toggle('is-error', kind === 'error');
}

function logActivity(op: string, meta: string): void {
  if (!telemetryEl) return;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="op">${op}</span><span class="meta">${meta}</span>`;
  telemetryEl.prepend(row);
  while (telemetryEl.children.length > 8) telemetryEl.lastElementChild?.remove();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function copyAb(src: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(src.byteLength);
  new Uint8Array(out).set(src);
  return out;
}

function downloadBytes(data: Uint8Array, name: string, type = 'application/octet-stream'): void {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isSnca(bytes: Uint8Array): boolean {
  return bytes.length >= 96 && bytes[0] === 0x53 && bytes[1] === 0x4e && bytes[2] === 0x43 && bytes[3] === 0x41;
}

function samplePayload(): Uint8Array {
  const line = 'Nano Cloud Codec — SNCA Cauchy MDS sample. Zero-byte-loss vector.\n';
  const parts: string[] = [];
  for (let i = 0; i < 32; i++) parts.push(`${String(i).padStart(3, '0')} ${line}`);
  return new TextEncoder().encode(parts.join(''));
}

function km(): { k: number; m: number } | null {
  const k = parseInt(kInput?.value ?? '4', 10);
  const m = parseInt(mInput?.value ?? '2', 10);
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 1 || k > 16 || m > 16 || k + m > 32) {
    return null;
  }
  return { k, m };
}

function clearBootTimer(): void {
  if (bootTimer !== null) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

function initWorker(): void {
  try {
    worker = new Worker(new URL('./worker/codec.worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    setStatus('Worker failed', 'error');
    console.error(err);
    return;
  }

  worker.onerror = (ev) => {
    clearBootTimer();
    setStatus('Engine error', 'error');
    console.error(ev.message);
  };

  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data || {};
    try {
      if (msg.type === 'ready') {
        clearBootTimer();
        setStatus('Ready', 'ready');
        if (encodeBtn) encodeBtn.disabled = false;
        if (sampleBtn) sampleBtn.disabled = false;
        return;
      }
      if (msg.type === 'protected') {
        fragments = (msg.fragments || []).map((f: Fragment) => ({
          index: f.index,
          kind: f.kind,
          bytes: f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes),
        }));
        lastK = msg.k;
        lastM = msg.m;
        lastFilename = msg.filename || lastFilename;
        present = fragments.map(() => true);
        recovered = null;
        if (downloadFileBtn) {
          downloadFileBtn.disabled = true;
          downloadFileBtn.hidden = true;
        }
        if (resultsPanel) resultsPanel.hidden = false;
        renderShards();
        if (decodeBtn) decodeBtn.disabled = false;
        if (downloadZipBtn) downloadZipBtn.disabled = false;
        if (downloadFileBtn) downloadFileBtn.disabled = true;
        if (encodeBtn) encodeBtn.disabled = false;
        if (sampleBtn) sampleBtn.disabled = false;
        setStatus('Protected', 'ready');
        logActivity(
          'protect',
          `${msg.encodeLatencyMs?.toFixed?.(1) ?? '?'} ms · ${fragments.length} shards`,
        );
        return;
      }
      if (msg.type === 'restored') {
        const data = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
        recovered = { name: msg.filename || lastFilename, bytes: data };
        if (downloadFileBtn) {
          downloadFileBtn.disabled = false;
          downloadFileBtn.hidden = false;
        }
        if (encodeBtn) encodeBtn.disabled = false;
        if (sampleBtn) sampleBtn.disabled = false;
        if (msg.checksumOk) {
          setStatus('Restored · SHA-256 match', 'ready');
        } else {
          setStatus('Checksum mismatch', 'error');
        }
        logActivity(
          'restore',
          msg.checksumOk ? `0-byte loss · ${msg.decodeLatencyMs?.toFixed?.(1) ?? '?'} ms` : 'checksum failed',
        );
        return;
      }
      if (msg.type === 'error') {
        clearBootTimer();
        setStatus(String(msg.error || 'Engine error'), 'error');
        if (encodeBtn) encodeBtn.disabled = false;
        if (sampleBtn) sampleBtn.disabled = false;
      }
    } catch (err) {
      setStatus('UI error', 'error');
      console.error(err);
    }
  };

  bootTimer = setTimeout(() => {
    setStatus('Engine timeout', 'error');
  }, 20000);

  worker.postMessage({ type: 'init' });
}

function renderShards(): void {
  if (!shardGrid) return;
  shardGrid.innerHTML = '';
  for (const f of fragments) {
    const on = present[f.index] !== false;
    const node = document.createElement('div');
    node.className = `shard ${f.kind === 'data' ? 'data' : 'parity'}${on ? '' : ' corrupted'}`;
    node.setAttribute('role', 'listitem');
    node.innerHTML = `<span>${f.index}</span><span class="shard-label">${f.kind === 'data' ? 'Data' : 'Recovery'}</span>`;
    node.title = on ? 'Tap to simulate loss' : 'Tap to bring fragment back';
    node.onclick = () => {
      present[f.index] = !present[f.index];
      recovered = null;
      if (downloadFileBtn) downloadFileBtn.disabled = true;
      renderShards();
    };
    shardGrid.appendChild(node);
  }
}

async function ingestFiles(list: FileList | File[] | null): Promise<void> {
  if (!list || list.length === 0) return;
  const files = Array.from(list);
  const buffers = await Promise.all(
    files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );
  const shards = buffers.filter((b) => isSnca(b.bytes));
  if (shards.length > 0 && shards.length === buffers.length) {
    if (!worker) {
      setStatus('Not ready', 'error');
      return;
    }
    setStatus('Restoring…');
    worker.postMessage({
      type: 'restore',
      fragments: shards.map((s) => copyAb(s.bytes)),
    });
    if (resultsPanel) resultsPanel.hidden = false;
    return;
  }
  const first = buffers[0];
  if (first.bytes.length > MAX_PAYLOAD) {
    setStatus(`File exceeds ${formatBytes(MAX_PAYLOAD)}`, 'error');
    return;
  }
  pendingFile = first;
  fragments = [];
  recovered = null;
  if (fileSummary) {
    fileSummary.hidden = false;
    fileSummary.textContent = `${first.name} · ${formatBytes(first.bytes.length)}`;
  }
  setStatus('Ready', 'ready');
}

function doProtect(bytes: Uint8Array, filename: string): void {
  const cfg = km();
  if (!cfg) {
    setStatus('Check settings', 'error');
    if (settingsModal) settingsModal.hidden = false;
    return;
  }
  if (!worker) {
    setStatus('Not ready', 'error');
    return;
  }
  if (bytes.length > MAX_PAYLOAD) {
    setStatus(`File exceeds ${formatBytes(MAX_PAYLOAD)}`, 'error');
    return;
  }
  lastFilename = filename;
  setStatus('Protecting…');
  if (encodeBtn) encodeBtn.disabled = true;
  if (sampleBtn) sampleBtn.disabled = true;
  worker.postMessage({
    type: 'protect',
    k: cfg.k,
    m: cfg.m,
    filename,
    data: copyAb(bytes),
  });
}

function doEncode(): void {
  if (!pendingFile) {
    setStatus('Add files first', 'error');
    dropZone?.classList.add('drag');
    setTimeout(() => dropZone?.classList.remove('drag'), 600);
    return;
  }
  doProtect(pendingFile.bytes, pendingFile.name);
}

function doSample(): void {
  const bytes = samplePayload();
  pendingFile = { name: 'snca-sample.txt', bytes };
  if (fileSummary) {
    fileSummary.hidden = false;
    fileSummary.textContent = `snca-sample.txt · ${formatBytes(bytes.length)}`;
  }
  doProtect(bytes, 'snca-sample.txt');
}

function doDecode(): void {
  if (!worker || fragments.length === 0) {
    setStatus('Protect first', 'error');
    return;
  }
  const kept = fragments.filter((f) => present[f.index]);
  if (kept.length < lastK) {
    setStatus(`Need ${lastK} fragments, have ${kept.length}`, 'error');
    return;
  }
  setStatus('Restoring…');
  worker.postMessage({
    type: 'restore',
    fragments: kept.map((f) => copyAb(f.bytes)),
  });
}

function bootstrap(): void {
  setStatus('Starting…');
  if (encodeBtn) encodeBtn.disabled = true;
  if (decodeBtn) decodeBtn.disabled = true;
  if (sampleBtn) sampleBtn.disabled = true;
  if (downloadZipBtn) downloadZipBtn.disabled = true;
  if (downloadFileBtn) downloadFileBtn.disabled = true;

  initWorker();

  if (dropZone && fileInput) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag');
      void ingestFiles(e.dataTransfer?.files ?? null);
    });
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', () => {
      void ingestFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  encodeBtn?.addEventListener('click', doEncode);
  decodeBtn?.addEventListener('click', doDecode);
  sampleBtn?.addEventListener('click', doSample);
  downloadZipBtn?.addEventListener('click', () => {
    if (fragments.length === 0) return;
    const files = fragments.map((f) => {
      const stem = lastFilename.replace(/\.[^.]+$/, '') || 'payload';
      const kind = f.kind === 'data' ? 'd' : 'p';
      return {
        name: `${stem}.s${String(f.index).padStart(2, '0')}${kind}.snca`,
        data: f.bytes,
      };
    });
    downloadBytes(zipStore(files), `${lastFilename}.snca.zip`, 'application/zip');
  });
  downloadFileBtn?.addEventListener('click', () => {
    if (!recovered) return;
    downloadBytes(recovered.bytes, recovered.name);
  });
  settingsBtn?.addEventListener('click', () => {
    if (settingsModal) settingsModal.hidden = false;
  });
  settingsClose?.addEventListener('click', () => {
    if (settingsModal) settingsModal.hidden = true;
  });
  settingsBackdrop?.addEventListener('click', () => {
    if (settingsModal) settingsModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal && !settingsModal.hidden) settingsModal.hidden = true;
  });
}

bootstrap();
