const EVENTS_URL = "https://core-api.dominic-calandro1991.workers.dev/api/v1/events";
const SOURCE = "snca-codec";
const boot = Date.now();

let cpuUtilization = 0;
let lastFrame = performance.now();
let edgeLatency = 0;

function sampleCpu(ts: number): void {
  const dt = ts - lastFrame;
  lastFrame = ts;
  const load = Math.max(0, Math.min(1, (dt - 16.7) / 33.3));
  cpuUtilization = cpuUtilization * 0.85 + load * 0.15;
  requestAnimationFrame(sampleCpu);
}
requestAnimationFrame(sampleCpu);

export function emitVoltcore(
  type: string,
  severity: string,
  payload: Record<string, unknown> = {}
): void {
  try {
    const started = performance.now();
    fetch(EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: SOURCE, type, severity, payload }),
      keepalive: true,
    })
      .then(() => {
        edgeLatency = Math.round(performance.now() - started);
      })
      .catch(() => {});
  } catch {
    /* never throw from telemetry */
  }
}

function health(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const memory_mb = mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : 0;
  const uptime_seconds = Math.round((Date.now() - boot) / 1000);
  return {
    cpu_utilization: Number(cpuUtilization.toFixed(3)),
    memory_mb,
    uptime_seconds,
    edge_latency: extra.edge_latency ?? edgeLatency,
    product: "nano-cloud-codec",
    ...extra,
  };
}

export function installVoltcoreTelemetry(): void {
  emitVoltcore("app.event", "info", health({ status: "boot" }));
  window.setInterval(() => {
    emitVoltcore("health.heartbeat", "info", health());
  }, 30000);
  window.addEventListener("error", (e) => {
    emitVoltcore("runtime.error", "error", health({
      message: String(e.message || ""),
      filename: String(e.filename || ""),
      lineno: e.lineno || 0,
    }));
  });
  window.addEventListener("unhandledrejection", (e) => {
    emitVoltcore("runtime.error", "error", health({ reason: String(e.reason || "") }));
  });
}
