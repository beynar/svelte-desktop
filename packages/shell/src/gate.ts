// The loopback gate in front of the SvelteKit handler: Host check (DNS rebinding), one-time secret →
// HttpOnly SameSite=Strict session cookie, then the app. Static build assets
// (adapter-bun `routes`) are served as-is.
import type { Server } from "bun";
import { PROTOCOL_HEADER } from "./worker-env.ts";

type KitHandler = (req: Request, server: Server<any>) => Response | Promise<Response>;

export const SESSION_COOKIE = "__svelte_desktop";
export const AUTH_PATH = "/__desktop/auth";

export interface GateOptions {
  handler: KitHandler;
  routes?: Record<string, any>;
  /** One-time secret the shell's first navigation trades for the session cookie. */
  secret: string;
  /** Extra gated routes (after the cookie check), e.g. the updater endpoints. */
  extra?: (req: Request, url: URL, origin: string) => Response | Promise<Response> | undefined;
  debug?: boolean;
  port?: number;
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
    async fetch(req, srv): Promise<Response> {
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

      const extra = await o.extra?.(req, url, `http://${host}`);
      if (extra) return extra;

      req.headers.set(PROTOCOL_HEADER, "http");
      const res = secureCookiesForLoopback(await o.handler(req, srv));
      if (o.debug) console.log(`[shell] ${req.method} ${url.pathname}${url.search} → ${res.status}`);
      return res;
    },
  });
  host = `127.0.0.1:${server.port}`;
  const origin = `http://${host}`;
  return { server, origin, authUrl: (next = "/") => `${origin}${AUTH_PATH}?t=${o.secret}&next=${encodeURIComponent(next)}` };
}
