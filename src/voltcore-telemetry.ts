const EVENTS_URL = "https://core-api.dominic-calandro1991.workers.dev/api/v1/events";
const SOURCE = "snca-codec";

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

export function installVoltcoreTelemetry(): void {
  emitVoltcore("app.event", "info", { status: "boot", product: "nano-cloud-codec" });
  window.addEventListener("error", (e) => {
    emitVoltcore("runtime.error", "error", {
      message: String(e.message || ""),
      filename: String(e.filename || ""),
      lineno: e.lineno || 0,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    emitVoltcore("runtime.error", "error", { reason: String(e.reason || "") });
  });
}
