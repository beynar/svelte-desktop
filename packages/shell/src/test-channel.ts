// Test channel: when SVELTE_DESKTOP_TEST is set (by `launch()` from
// '@svelte-desktop/shell/test'), the shell connects to the test runner's
// WebSocket and executes platform calls for it. Never active otherwise.
// On Android the direction is reversed: the server exposes a token-protected
// route and the runner connects through `adb forward` (no `adb reverse` or
// emulator-only addresses; src/android/server.ts, attachTestChannel).
//   runner → app  {id, service, op, args}
//   app → runner  {t:'result', id, ok, value|error} | {t:'event', name, data} | {t:'hello', origin}
import { callPlatform, onAnyPlatform } from "./platform/bus.ts";

/** Wire a connected socket as the test channel. Returns the handler for incoming frames. */
export function attachTestChannel(socket: { send(data: string): unknown }, info: { origin: string; appName: string }): (raw: string) => void {
  const send = (m: unknown) => socket.send(JSON.stringify(m));
  send({ t: "hello", ...info });
  onAnyPlatform((name, data) => {
    if (name !== "platformResult") send({ t: "event", name, data });
  });
  return async (raw) => {
    const m = JSON.parse(raw);
    try {
      const value = await callPlatform(m.service, m.op, m.args ?? {});
      send({ t: "result", id: m.id, ok: true, value });
    } catch (err: any) {
      send({ t: "result", id: m.id, ok: false, error: { code: err?.code ?? "internal", message: String(err?.message ?? err) } });
    }
  };
}

export function connectTestChannel(info: { origin: string; appName: string }) {
  const url = process.env.SVELTE_DESKTOP_TEST;
  if (!url) return;
  const ws = new WebSocket(url);
  let onFrame: ((raw: string) => void) | null = null;
  ws.onopen = () => (onFrame = attachTestChannel(ws, info));
  ws.onmessage = (e) => onFrame?.(String(e.data));
  ws.onerror = () => console.error(`[shell] test channel: cannot reach ${url}`);
}
