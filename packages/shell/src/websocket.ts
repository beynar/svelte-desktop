// WebSockets on the app's own server: src/websocket.ts (or .js) default-exports the handlers, and
// the server upgrades the paths it names — behind the session cookie in the built app, so only the
// app's pages connect. Bun's ServerWebSocket: send, subscribe / publish to topics, close.
//
//   // src/websocket.ts
//   import { defineWebSocket } from '@kitop/shell/websocket';
//   export default defineWebSocket({
//     path: '/ws',
//     open(ws) { ws.subscribe('chat'); },
//     message(ws, message) { ws.publish('chat', message); },
//   });
//
// From other server code (a remote function, a job's callback): sockets.publish('chat', data).
import type { Server, ServerWebSocket } from "bun";

/** What a socket carries: its path and query, and what `upgrade` returned. */
export type SocketData<T = undefined> = { path: string; query: Record<string, string>; data: T };
export type DesktopSocket<T = undefined> = ServerWebSocket<SocketData<T>>;

interface Callbacks<T> {
  /** Paths that upgrade: exact (`/ws`), or a prefix ending in `*` (`/rooms/*`). Default `/ws`. */
  path?: string | string[];
  open?(ws: DesktopSocket<T>): void | Promise<void>;
  message?(ws: DesktopSocket<T>, message: string | Buffer): void | Promise<void>;
  close?(ws: DesktopSocket<T>, code: number, reason: string): void | Promise<void>;
  /** The socket can take more after backpressure. */
  drain?(ws: DesktopSocket<T>): void;
}
type Upgrade<T> = (request: Request) => T | false | Promise<T | false>;

/** The handlers. With data on the sockets (`T`), `upgrade` is required: it makes that data. */
export type WebSocketHandlers<T = undefined> = Callbacks<T> &
  (undefined extends T
    ? { /** Before the upgrade, with the request: `false` refuses it (403). */ upgrade?: Upgrade<T> }
    : { /** Before the upgrade, with the request: what the socket carries as `ws.data.data`, or `false` to refuse it (403). */ upgrade: Upgrade<T> });

/** Types the handlers; returns them as is. */
export function defineWebSocket<T = undefined>(handlers: WebSocketHandlers<T>): WebSocketHandlers<T> {
  return handlers;
}

type AnyHandlers = Callbacks<any> & { upgrade?: Upgrade<any> };

const SERVER = Symbol.for("kitop.sockets.server");
const g = globalThis as { [SERVER]?: Server<any> };

/** Server code anywhere (one server per app: shared through globalThis, whichever bundle calls it). */
export const sockets = {
  /** Send to every socket subscribed to `topic` (objects as JSON). Returns false with no socket server. */
  publish(topic: string, data: string | ArrayBufferView | ArrayBuffer | object): boolean {
    const server = g[SERVER];
    if (!server) return false;
    const payload = typeof data === "string" || ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data : JSON.stringify(data);
    server.publish(topic, payload as string);
    return true;
  },
  /** Sockets subscribed to `topic`. */
  subscribers(topic: string): number {
    return g[SERVER]?.subscriberCount(topic) ?? 0;
  },
};

// ── for the servers (gate.ts, the dev plugin) ───────────────────────────────

/** The server sockets.publish goes through; `release` it when it stops (only if it's still this one). */
export function socketServer(server: Server<any>) {
  g[SERVER] = server;
  return { release: () => void (g[SERVER] === server && delete g[SERVER]) };
}

/** Does `pathname` upgrade? */
export function socketPath(handlers: AnyHandlers, pathname: string): boolean {
  const paths = handlers.path === undefined ? ["/ws"] : Array.isArray(handlers.path) ? handlers.path : [handlers.path];
  return paths.some((p) => (p.endsWith("*") ? pathname.startsWith(p.slice(0, -1)) : pathname === p));
}

// Each socket keeps the handlers that upgraded it (dev reloads apply to the next socket, not mid-way).
const OWN = Symbol("kitop.socket.handlers");
type Carried = SocketData<unknown> & { [OWN]?: AnyHandlers };

/** Upgrade `req` on `server` if it asks for it on one of the paths: undefined when upgraded, a
 *  Response when refused, null when it's not a socket request. */
export async function upgradeSocket(handlers: () => AnyHandlers | undefined, req: Request, server: Server<any>): Promise<Response | undefined | null> {
  const h = handlers();
  if (!h || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const url = new URL(req.url);
  if (!socketPath(h, url.pathname)) return null;
  const data = h.upgrade ? await h.upgrade(req) : undefined;
  if (data === false) return new Response("Forbidden", { status: 403 });
  const carried: Carried = { path: url.pathname, query: Object.fromEntries(url.searchParams), data, [OWN]: h };
  const ok = (server as Server<Carried>).upgrade(req, { data: carried });
  return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
}

/** Bun's `websocket` option: each socket's own handlers. A failing `open` closes the socket (1011):
 *  it isn't set up. */
export function socketCallbacks() {
  const own = (ws: ServerWebSocket<Carried>) => ws.data[OWN];
  const run = (ws: ServerWebSocket<Carried>, fn: () => unknown, fatal = false) => {
    const fail = (e: unknown) => {
      console.error("[websocket]", e);
      if (fatal) ws.close(1011, "server error");
    };
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(fail);
    } catch (e) {
      fail(e);
    }
  };
  return {
    open: (ws: ServerWebSocket<Carried>) => run(ws, () => own(ws)?.open?.(ws as never), true),
    message: (ws: ServerWebSocket<Carried>, message: string | Buffer) => run(ws, () => own(ws)?.message?.(ws as never, message)),
    close: (ws: ServerWebSocket<Carried>, code: number, reason: string) => run(ws, () => own(ws)?.close?.(ws as never, code, reason)),
    drain: (ws: ServerWebSocket<Carried>) => run(ws, () => own(ws)?.drain?.(ws as never)),
  };
}
