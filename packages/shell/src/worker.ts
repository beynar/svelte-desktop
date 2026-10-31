// Worker half of the shell: owns Bun.serve (the SvelteKit app), the event sink
// and the desktop API. Talks to the UI thread only through thread-safe shell_*
// calls; receives native events through one threadsafe JSCallback (no polling).
import { JSCallback, FFIType, type Pointer } from "bun:ffi";
import type { Server } from "bun";
import { openNative, cstr, takeString, type Native } from "./ffi.ts";
import { installDesktopApi } from "./server.ts";
import { PROTOCOL_HEADER } from "./worker-env.ts";
import { createDesktopRuntime, type DesktopRuntime } from "./desktop-api.ts";
import { connectTestChannel } from "./test-channel.ts";
import { redirectConsole } from "./logging.ts";
import { initPlatform, deliverPlatformEvent } from "./platform/bus.ts";
import { createUpdater, type UpdateInfo } from "./updater/index.ts";
import type { InitMessage, ShellEvent } from "./types.ts";

declare var self: Worker;

type KitHandler = (req: Request, server: Server<any>) => Response | Promise<Response>;
export interface WorkerOptions {
  handler: KitHandler;
  /** adapter-bun's static `routes` (client assets, prerendered pages) — immutable build output. */
  routes?: Record<string, any>;
}

const SESSION_COOKIE = "__svelte_desktop";
const AUTH_PATH = "/__desktop/auth";
const UPDATE_PATH = "/__desktop/update/";

export function startWorker({ handler, routes = {} }: WorkerOptions) {
  self.addEventListener("message", async (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === "init") await init(msg as InitMessage, handler, routes);
    if (msg?.type === "shutdown") await shutdown();
  });
}

let native: Native;
let server: Server<any>;
let sink: JSCallback;
let runtime: DesktopRuntime;

const debug = !!Bun.env.SVELTE_DESKTOP_DEBUG;

function dispatch(event: ShellEvent) {
  if (debug) console.log(`[shell] event ${JSON.stringify(event)}`);
  // Platform API traffic: pages get platform events straight from native;
  // here they feed the Worker's bus (server code's `@svelte-desktop/shell/platform`).
  if (event.type === "platformResult") return deliverPlatformEvent("platformResult", event);
  if (event.type === "platform") return deliverPlatformEvent(event.name, event.data);
  runtime?.feed(event);
}

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

async function init(msg: InitMessage, handler: KitHandler, routes: Record<string, any>) {
  if (msg.logFile) redirectConsole(msg.logFile, "worker");
  native = openNative(msg.lib);
  sink = new JSCallback(
    (p: Pointer) => {
      try {
        dispatch(JSON.parse(takeString(native, p)));
      } catch (err) {
        console.error("[shell] bad native event", err);
      }
    },
    { args: [FFIType.ptr], returns: FFIType.void, threadsafe: true },
  );
  native.shell_set_event_sink(sink.ptr!);
  initPlatform({
    platformCall(request: string) {
      native.shell_platform_call(cstr(request));
      return '{"pending":true}';
    },
  });
  const updates = msg.update ? setupUpdater(msg) : null;

  let authSecret: string | null = msg.secret; // single use
  const session = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  let host = "";

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes,
    async fetch(req, srv) {
      // DNS-rebinding guard: only our exact loopback authority is served.
      if (req.headers.get("host") !== host) return new Response("Misdirected Request", { status: 421 });
      const url = new URL(req.url);

      if (url.pathname === AUTH_PATH) {
        const t = url.searchParams.get("t") ?? "";
        if (!authSecret || !timingSafeEqual(t, authSecret)) return new Response("Forbidden", { status: 403 });
        authSecret = null;
        const next = url.searchParams.get("next");
        return new Response(null, {
          status: 302,
          headers: {
            location: next?.startsWith("/") && !next.startsWith("//") ? next : "/",
            "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`,
          },
        });
      }

      const cookie = req.headers.get("cookie") ?? "";
      const got = /(?:^|;\s*)__svelte_desktop=([0-9a-f]+)/.exec(cookie)?.[1] ?? "";
      if (!timingSafeEqual(got, session)) return new Response("Forbidden", { status: 403 });

      if (url.pathname.startsWith(UPDATE_PATH) && req.method === "POST") {
        // Same-origin only: the session cookie is SameSite=Strict, Origin pins it further.
        if (req.headers.get("origin") !== `http://${host}`) return new Response("Forbidden", { status: 403 });
        return updateRoute(updates, url.pathname.slice(UPDATE_PATH.length));
      }

      req.headers.set(PROTOCOL_HEADER, "http");
      if (!debug) return handler(req, srv);
      const res = await handler(req, srv);
      console.log(`[shell] ${req.method} ${url.pathname}${url.search} → ${res.status}`);
      return res;
    },
  });

  host = `127.0.0.1:${server.port}`;
  const origin = `http://${host}`;
  native.shell_set_app_origin(cstr(origin));

  runtime = createDesktopRuntime({ appName: msg.appName, identifier: msg.identifier, origin, quit: () => void native.shell_quit() });
  installDesktopApi(runtime.api);
  connectTestChannel({ origin, appName: msg.appName });

  if (debug) console.log(`[shell] serving ${origin}`);
  native.shell_window_navigate(msg.windowId, cstr(`${origin}${AUTH_PATH}?t=${msg.secret}&next=/`));
}

// ---------------------------------------------------------------------------
// Updater: configured by the adapter's `update` option. Healthy start confirms
// a freshly applied update; an unconfirmed one rolls back on the next start.

type Updates = ReturnType<typeof setupUpdater>;
const UPDATER_KEY = Symbol.for("svelte-desktop.updater");

function setupUpdater(msg: InitMessage) {
  const cfg = msg.update!;
  const updater = createUpdater({
    manifestUrl: cfg.manifestUrl,
    publicKey: cfg.publicKey,
    channel: cfg.channel,
    currentVersion: msg.version,
    appName: msg.identifier,
    // process.exit() in a Worker only ends the Worker: quit through the UI thread.
    quit: () => native.shell_quit(),
  });
  let last: UpdateInfo | null = null;
  const wire = (i: UpdateInfo) => ({
    currentVersion: i.currentVersion,
    version: i.version,
    notes: i.notes ?? null,
    date: i.releasedAt ?? null,
    downloadUrl: i.artifact.url,
    format: i.artifact.format,
    mandatory: i.mandatory,
  });
  const api = {
    async check() {
      last = await updater.check();
      return last && wire(last);
    },
    async install() {
      const info = last ?? (await updater.check());
      if (!info) throw Object.assign(new Error("no update available"), { code: "invalid_args" });
      const staged = await updater.download(info);
      await updater.apply(staged, { relaunch: true });
    },
  };
  (globalThis as any)[UPDATER_KEY] = api;
  // Bundled builds only: a bare binary under `bun` has nothing to roll back/confirm.
  if (Bun.main.startsWith("/$bunfs/"))
    updater.rollbackIfNeeded().then(async (rolledBack) => { if (!rolledBack) await updater.confirm(); }).catch((err) => console.error("[shell] updater startup:", err));
  return api;
}

async function updateRoute(updates: Updates | null, op: string) {
  if (!updates) return Response.json({ code: "unavailable", message: "no `update` option in the desktop adapter config" }, { status: 501 });
  try {
    if (op === "check") return Response.json(await updates.check());
    if (op === "install") return Response.json(await updates.install());
    return Response.json({ code: "unknown", message: `unknown update op ${op}` }, { status: 404 });
  } catch (err: any) {
    return Response.json({ code: err?.code ?? "internal", message: String(err?.message ?? err) }, { status: 500 });
  }
}

async function shutdown() {
  await runtime?.runBeforeQuit();
  // The window is gone, so nobody can read a response: force-close sockets
  // (the page's event WebSocket would otherwise hold stop() until the timeout).
  await server?.stop(true);
  postMessage({ type: "shutdown-complete" });
}
