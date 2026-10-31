// Dev shell, Worker: no SvelteKit here (Vite serves the app). It points the
// window at the Vite URL and exposes the native layer to the Vite process over
// a token-protected loopback WebSocket:
//   vite → shell  {t:'call', req:{id,service,op,args}} | {t:'quit'}
//   shell → vite  {t:'result', id, ok, value|error} | {t:'platform', name, data} | {t:'shell', event}
import { JSCallback, FFIType, type Pointer } from "bun:ffi";
import type { ServerWebSocket } from "bun";
import { openNative, cstr, takeString, type Native } from "../ffi.ts";
import type { InitMessage, ShellEvent } from "../types.ts";

declare var self: Worker;

let native: Native;
let sink: JSCallback;
const clients = new Set<ServerWebSocket<unknown>>();
const backlog: string[] = []; // events before the Vite side connects (e.g. the first `ready`)

function send(msg: unknown) {
  const raw = JSON.stringify(msg);
  if (!clients.size) {
    backlog.push(raw);
    if (backlog.length > 200) backlog.shift();
  }
  for (const ws of clients) ws.send(raw);
}

function dispatch(event: ShellEvent) {
  if (event.type === "platformResult") return send({ ...event, t: "result" });
  if (event.type === "platform") return send({ t: "platform", name: event.name, data: event.data });
  send({ t: "shell", event });
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === "shutdown") {
    send({ t: "shell", event: { type: "quit" } });
    setTimeout(() => postMessage({ type: "shutdown-complete" }), 50);
    return;
  }
  if (msg?.type !== "init") return;
  const init = msg as InitMessage;
  native = openNative(init.lib);
  sink = new JSCallback((p: Pointer) => dispatch(JSON.parse(takeString(native, p))), {
    args: [FFIType.ptr],
    returns: FFIType.void,
    threadsafe: true,
  });
  native.shell_set_event_sink(sink.ptr!);

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).searchParams.get("t") !== token) return new Response("Forbidden", { status: 403 });
      return srv.upgrade(req) ? undefined : new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        for (const raw of backlog.splice(0)) ws.send(raw);
      },
      close(ws) {
        clients.delete(ws);
      },
      message(_ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "call") native.shell_platform_call(cstr(JSON.stringify(m.req)));
        else if (m.t === "quit") native.shell_quit();
      },
    },
  });

  const url = init.url!;
  native.shell_set_app_origin(cstr(new URL(url).origin));
  native.shell_window_navigate(init.windowId, cstr(url));
  // The Vite plugin reads this line to connect.
  console.log(`SVELTE_DESKTOP_DEV_READY ${JSON.stringify({ rpc: `ws://127.0.0.1:${server.port}/?t=${token}` })}`);
};
