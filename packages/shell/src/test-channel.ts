// Test channel: when SVELTE_DESKTOP_TEST is set (by `launch()` from
// '@svelte-desktop/shell/test'), the shell connects to the test runner's
// WebSocket and executes platform calls for it. Never active otherwise.
//   runner → app  {id, service, op, args}
//   app → runner  {t:'result', id, ok, value|error} | {t:'event', name, data} | {t:'hello', origin}
import { callPlatform, onAnyPlatform } from "./platform/bus.ts";

export function connectTestChannel(info: { origin: string; appName: string }) {
  const url = process.env.SVELTE_DESKTOP_TEST;
  if (!url) return;
  const ws = new WebSocket(url);
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "hello", ...info }));
    onAnyPlatform((name, data) => {
      if (name !== "platformResult") ws.send(JSON.stringify({ t: "event", name, data }));
    });
  };
  ws.onmessage = async (e) => {
    const m = JSON.parse(String(e.data));
    try {
      const value = await callPlatform(m.service, m.op, m.args ?? {});
      ws.send(JSON.stringify({ t: "result", id: m.id, ok: true, value }));
    } catch (err: any) {
      ws.send(JSON.stringify({ t: "result", id: m.id, ok: false, error: { code: err?.code ?? "internal", message: String(err?.message ?? err) } }));
    }
  };
  ws.onerror = () => console.error(`[shell] test channel: cannot reach ${url}`);
}
