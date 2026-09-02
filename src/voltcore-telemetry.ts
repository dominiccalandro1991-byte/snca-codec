const EVENTS_URL = "https://core-api.dominic-calandro1991.workers.dev/api/v1/events";
const SOURCE = "snca-codec";
const boot = Date.now();

export function emitVoltcore(
  type: string,
  severity: string,
  payload: Record<string, unknown> = {}
): void {
  try {
    fetch(EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: SOURCE, type, severity, payload }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never throw from telemetry */
  }
}

function health(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const memory_mb = mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : 0;
  const uptime_seconds = Math.round((Date.now() - boot) / 1000);
  return {
    cpu_utilization: 0,
    memory_mb,
    uptime_seconds,
    edge_latency: extra.edge_latency ?? 0,
    product: "nano-cloud-codec",
    ...extra,
  };
}

export function installVoltcoreTelemetry(): void {
  const t0 = performance.now();
  emitVoltcore("app.event", "info", health({ status: "boot" }));
  window.setInterval(() => {
    const started = performance.now();
    emitVoltcore("health.heartbeat", "info", health({
      edge_latency: Math.round(performance.now() - started + (started - t0 > 0 ? 0 : 0)),
    }));
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
