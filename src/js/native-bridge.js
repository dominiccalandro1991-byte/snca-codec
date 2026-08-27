/**
 * Capacitor / WebView capability probe.
 * SharedArrayBuffer is typically unavailable inside native WebViews
 * unless COOP/COEP isolation is present. The codec worker always
 * falls back to structured-clone ArrayBuffer transfer.
 */
export function detectRuntime() {
  const isCapacitor =
    typeof window !== 'undefined' &&
    Boolean(window.Capacitor || window.webkit?.messageHandlers?.bridge);
  const crossOriginIsolated = Boolean(globalThis.crossOriginIsolated);
  const hasSab = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
  const protocol = typeof location !== 'undefined' ? location.protocol : 'unknown';
  return {
    platform: isCapacitor ? 'native-webview' : 'web',
    protocol,
    sharedArrayBuffer: hasSab,
    transport: hasSab ? 'SharedArrayBuffer+Atomics' : 'ArrayBuffer-copy',
    bundleId: 'com.nanocloud.codec',
    appName: 'Nano Cloud Codec (SNCA)',
  };
}

export async function pickNativeFiles() {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.Plugins || !cap.Plugins.FilePicker) return null;
    const result = await cap.Plugins.FilePicker.pickFiles({
      multiple: true,
      readData: true,
    });
    if (!result || !result.files) return null;
    return result.files.map((f) => {
      const bin = f.data
        ? Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
        : new Uint8Array();
      const name = f.name || 'payload.bin';
      return new File([bin], name, { type: f.mimeType || 'application/octet-stream' });
    });
  } catch {
    return null;
  }
}
