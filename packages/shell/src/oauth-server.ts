// OAuth loopback redirects (RFC 8252 §7.3), served by the app's own server: the system browser comes
// back to http://127.0.0.1:<port>/__desktop/oauth/callback — one fixed path, the one registered at
// the provider (the port may vary) — and the callback is matched to its sign-in by `state`, which
// the page registered when it started.
//
//   POST /__desktop/oauth/start         { state, timeoutMs? }  (the app's page)       → { id, path }
//   GET  /__desktop/oauth/wait/<id>                           (the app's page)       → { params }
//   POST /__desktop/oauth/cancel        { id }                 (the app's page)       → { ok }
//   GET  /__desktop/oauth/callback?…&state=…                  (the system browser)   → "you can close this tab"
//
// start / wait / cancel sit behind the session cookie (gate.ts; in dev, the Vite server's own
// origin). A callback with a state no sign-in registered completes nothing; one with a registered
// state ends that sign-in, once. The page still checks state and `iss`, and holds the PKCE verifier
// (platform/oauth.ts).

export const OAUTH_PATH = "/__desktop/oauth";
export const OAUTH_CALLBACK = `${OAUTH_PATH}/callback`;
const DEFAULT_TIMEOUT = 5 * 60_000;
const MAX_TIMEOUT = 30 * 60_000;
const MAX_FLOWS = 32; // sign-ins under way at once
const KEEP_RESULT = 60_000; // a callback before the page waits (a provider that redirects at once)

interface Flow {
  id: string;
  state: string;
  params?: Record<string, string>;
  waiters: Set<(params: Record<string, string> | null) => void>;
  timer: ReturnType<typeof setTimeout>;
}
const byId = new Map<string, Flow>();
const byState = new Map<string, Flow>();

function drop(flow: Flow) {
  clearTimeout(flow.timer);
  byId.delete(flow.id);
  byState.delete(flow.state);
}

/** Gone (timeout, cancel): its waiters get nothing. */
function end(flow: Flow) {
  drop(flow);
  for (const w of [...flow.waiters]) w(null);
}

/** The callback came: to the waiting page, or kept a while for it. */
function deliver(flow: Flow, params: Record<string, string>) {
  byState.delete(flow.state); // single use: the same state can't end it again
  clearTimeout(flow.timer);
  if (!flow.waiters.size) {
    flow.params = params;
    flow.timer = setTimeout(() => drop(flow), KEEP_RESULT);
    return;
  }
  drop(flow);
  for (const w of [...flow.waiters]) w(params);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, text: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#18181b;background:#fafafa}main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#52525b;margin:0}@media(prefers-color-scheme:dark){body{color:#fafafa;background:#09090b}p{color:#a1a1aa}}</style>
<main><h1>${escape(title)}</h1><p>${escape(text)}</p></main><script>setTimeout(() => window.close(), 300)</script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** The system browser's callback: no session cookie (it isn't the app's page). */
export function oauthCallback(url: URL, appName = "the app"): Response | undefined {
  if (url.pathname !== OAUTH_CALLBACK) return undefined;
  const flow = byState.get(url.searchParams.get("state") ?? "");
  if (!flow) return page("This sign-in has expired", `Go back to ${appName} and sign in again.`);
  const params = Object.fromEntries(url.searchParams);
  deliver(flow, params);
  return params.error
    ? page("Sign-in didn't complete", `${params.error_description ?? params.error}. You can close this tab and go back to ${appName}.`)
    : page("You're signed in", `You can close this tab and go back to ${appName}.`);
}

/** The app's page: start a sign-in, wait for its callback, give it up. Call it behind the session
 *  cookie (or the dev server's origin check). */
export async function oauthRoutes(req: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith(`${OAUTH_PATH}/`) || url.pathname === OAUTH_CALLBACK) return undefined;
  const body = async () => {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  };
  if (url.pathname === `${OAUTH_PATH}/start` && req.method === "POST") {
    const b = await body();
    // The page's own random state (base64url, 128 bits at least).
    if (!b || typeof b.state !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(b.state)) return json({ error: "invalid_request" }, 400);
    if (byState.has(b.state)) return json({ error: "state_in_use" }, 409);
    if (byId.size >= MAX_FLOWS) return json({ error: "too_many_sign_ins" }, 429);
    const timeout = Math.min(Math.max(Number(b.timeoutMs) || DEFAULT_TIMEOUT, 1_000), MAX_TIMEOUT);
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
    const flow: Flow = { id, state: b.state, waiters: new Set(), timer: setTimeout(() => end(flow), timeout) };
    byId.set(id, flow);
    byState.set(b.state, flow);
    return json({ id, path: OAUTH_CALLBACK, timeoutMs: timeout });
  }
  const wait = /^\/__desktop\/oauth\/wait\/([0-9a-f]{48})$/.exec(url.pathname);
  if (wait && req.method === "GET") {
    const flow = byId.get(wait[1]!);
    if (!flow) return json({ error: "unknown_flow" }, 404);
    if (flow.params) {
      drop(flow);
      return json({ params: flow.params });
    }
    if (req.signal?.aborted) return json({ error: "aborted" }, 499);
    // A wait given up (the page reloading) leaves the list: the sign-in stays open for another.
    const params = await new Promise<Record<string, string> | null>((resolve) => {
      const done = (p: Record<string, string> | null) => {
        flow.waiters.delete(done);
        req.signal?.removeEventListener("abort", aborted);
        resolve(p);
      };
      const aborted = () => done(null);
      flow.waiters.add(done);
      req.signal?.addEventListener("abort", aborted, { once: true });
    });
    if (params) return json({ params });
    return req.signal?.aborted ? json({ error: "aborted" }, 499) : json({ error: "timeout" }, 408);
  }
  if (url.pathname === `${OAUTH_PATH}/cancel` && req.method === "POST") {
    // The page gave up (cancel, timeout): the sign-in goes, its state with it.
    const b = await body();
    const flow = typeof b?.id === "string" ? byId.get(b.id) : undefined;
    if (flow) end(flow);
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}
