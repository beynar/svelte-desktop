// The loopback gate in front of the SvelteKit handler: Host check (DNS rebinding), one-time secret →
// HttpOnly SameSite=Strict session cookie, then the app. Static build assets
// (adapter-bun `routes`) are served as-is. One way in without the cookie: the system browser coming
// back from an OAuth sign-in (oauth-server.ts), to a single-use URL.
import type { Server } from "bun";
import { PROTOCOL_HEADER } from "./worker-env.ts";
import { oauthCallback, oauthRoutes } from "./oauth-server.ts";
import { socketCallbacks, socketServer, upgradeSocket, type WebSocketHandlers } from "./websocket.ts";

type KitHandler = (req: Request, server: Server<any>) => Response | Promise<Response>;

export const SESSION_COOKIE = "__kitop";
export const AUTH_PATH = "/__desktop/auth";
/** Where native code sends a view whose web process died too often (native/portable/reload_budget.hpp). */
export const PAGE_CRASHED_PATH = "/__desktop/page-crashed";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pageCrashed(appName: string | undefined, to: string | null): Response {
  const back = to?.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/";
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(appName ?? "")}</title>
<body style="font:15px system-ui,sans-serif;display:grid;place-content:center;height:100vh;margin:0;text-align:center">
<h1 style="font-size:20px;font-weight:600;margin:0 0 8px">This page keeps crashing</h1>
<p style="margin:0 0 16px">It stopped several times in a row, so it wasn't reloaded again. What wasn't saved in it is lost.</p>
<p style="margin:0"><a href="${escapeHtml(back)}">Reload the page</a></p>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export interface GateOptions {
  handler: KitHandler;
  routes?: Record<string, any>;
  /** One-time secret the shell's first navigation trades for the session cookie. */
  secret: string;
  /** Extra gated routes (after the cookie check), e.g. the updater endpoints. */
  extra?: (req: Request, url: URL, origin: string) => Response | Promise<Response> | undefined;
  debug?: boolean;
  port?: number;
  /** Named in the page the browser shows after an OAuth sign-in. */
  appName?: string;
  /** src/websocket.ts: upgrades on its paths, after the session cookie. */
  websocket?: WebSocketHandlers<any>;
}

/**
 * SvelteKit marks cookies `Secure` in production unless the host is `localhost`;
 * the app is served from http://127.0.0.1, where WebKit drops Secure cookies — so
 * `cookies.set()` would silently do nothing. The origin is the local loopback (no
 * network to protect the cookie from), so drop `Secure` (and turn `SameSite=None`,
 * which requires it, into `Lax`).
 */
export function secureCookiesForLoopback(res: Response): Response {
  const cookies = res.headers.getSetCookie();
  if (!cookies.some((c) => /;\s*secure\s*(;|$)/i.test(c) || /;\s*samesite=none/i.test(c))) return res;
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  for (const c of cookies) headers.append("set-cookie", c.replace(/;\s*secure\s*(?=;|$)/gi, "").replace(/;\s*samesite=none/gi, "; SameSite=Lax"));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export function startGate(o: GateOptions): { server: Server<any>; origin: string; authUrl: (next?: string) => string } {
  let authSecret: string | null = o.secret; // single use
  const session = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  let host = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port ?? 0,
    // Bun's default (10 s) cuts slow loads, remote functions and long polls; a
    // loopback-only server has no idle clients to shed.
    idleTimeout: 0,
    routes: o.routes ?? {},
    ...(o.websocket ? { websocket: socketCallbacks() } : {}),
    async fetch(req, srv): Promise<Response | undefined> {
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

      const callback = oauthCallback(url, o.appName);
      if (callback) return callback;

      const cookie = req.headers.get("cookie") ?? "";
      const got = /(?:^|;\s*)__kitop=([0-9a-f]+)/.exec(cookie)?.[1] ?? "";
      if (!timingSafeEqual(got, session)) return new Response("Forbidden", { status: 403 });

      if (url.pathname === PAGE_CRASHED_PATH) return pageCrashed(o.appName, url.searchParams.get("to"));

      const oauth = await oauthRoutes(req, url);
      if (oauth) return oauth;

      if (o.websocket) {
        // The app's own pages only: their Origin is this server (a page of another site, with the
        // cookie somehow, still gets refused).
        const from = req.headers.get("origin");
        if (req.headers.get("upgrade") && from && from !== `http://${host}`) return new Response("Forbidden", { status: 403 });
        const upgraded = await upgradeSocket(() => o.websocket, req, srv);
        if (upgraded !== null) return upgraded; // undefined: it's a socket now
      }

      const extra = await o.extra?.(req, url, `http://${host}`);
      if (extra) return extra;

      req.headers.set(PROTOCOL_HEADER, "http");
      const res = secureCookiesForLoopback(await o.handler(req, srv));
      if (o.debug) console.log(`[shell] ${req.method} ${url.pathname}${url.search} → ${res.status}`);
      return res;
    },
  });
  host = `127.0.0.1:${server.port}`;
  if (o.websocket) {
    const registration = socketServer(server);
    const stop = server.stop.bind(server);
    server.stop = ((closeActive?: boolean) => (registration.release(), stop(closeActive))) as typeof server.stop;
  }
  const origin = `http://${host}`;
  return { server, origin, authUrl: (next = "/") => `${origin}${AUTH_PATH}?t=${o.secret}&next=${encodeURIComponent(next)}` };
}
