// Vite side of dev mode: binds this process's platform bus and `desktop` API to
// the dev shell, so server code (load, remote functions, hooks) reaches native
// code during `vite dev` exactly as it does in the built app.
import { createDesktopRuntime, type DesktopRuntime } from "../desktop-api.ts";
import { initPlatform, deliverPlatformEvent } from "../platform/bus.ts";
import { installDesktopApi } from "../server.ts";

export interface DevBridge {
  close(): void;
  runtime: DesktopRuntime;
}

export function connectDevShell(rpcUrl: string, app: { appName: string; identifier: string; origin: string }): Promise<DevBridge> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(rpcUrl);
    const runtime = createDesktopRuntime({ ...app, quit: () => ws.send(JSON.stringify({ t: "quit" })) });
    ws.onopen = () => {
      initPlatform({
        platformCall(request: string) {
          ws.send(JSON.stringify({ t: "call", req: JSON.parse(request) }));
          return '{"pending":true}';
        },
      });
      installDesktopApi(runtime.api);
      void import("../test-channel.ts").then((m) => m.connectTestChannel({ origin: app.origin, appName: app.appName }));
      resolve({ runtime, close: () => ws.close() });
    };
    ws.onerror = () => reject(new Error(`svelte-desktop: cannot reach the dev shell at ${rpcUrl}`));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === "result") deliverPlatformEvent("platformResult", m);
      else if (m.t === "platform") deliverPlatformEvent(m.name, m.data);
      else if (m.t === "shell") runtime.feed(m.event);
    };
  });
}
