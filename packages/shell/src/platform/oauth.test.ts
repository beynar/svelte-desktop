/** OAuth through the app's gate: the page starts a sign-in, the "browser" (here: fetch) goes to a fake
 *  provider that redirects back to the loopback URL without the session cookie, the page gets the code. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startGate } from "../gate.ts";
import { mockPlatform } from "./bus.ts";
import { authorize, exchange, OAuthError } from "./oauth.ts";

let gate: ReturnType<typeof startGate>;
let cookie = "";
let realFetch: typeof fetch;
/** A strict provider: redirect_uri must be exactly the registered one (any loopback port). */
const REGISTERED = "/__desktop/oauth/callback";
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      if (back.hostname !== "127.0.0.1" || back.pathname !== REGISTERED) return Response.json({ error: "redirect_uri_mismatch" }, { status: 400 });
      const client = url.searchParams.get("client_id");
      if (client === "deny") back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", `code-for-${url.searchParams.get("code_challenge")}`);
      back.searchParams.set("state", url.searchParams.get("state")!);
      if (client === "evil-iss") back.searchParams.set("iss", "https://evil.example");
      if (client === "good-iss") back.searchParams.set("iss", "https://good.example");
      return Response.redirect(back.href, 302);
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await req.text());
      const verifierHash = new Bun.CryptoHasher("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      return form.get("code") === `code-for-${verifierHash}` ? Response.json({ access_token: "tok", token_type: "bearer" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.pathname === "/html") return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/moved") return Response.redirect(`http://127.0.0.1:${provider.port}/token`, 307);
    return new Response("nope", { status: 404 });
  },
});
const P = () => `http://127.0.0.1:${provider.port}`;

beforeAll(async () => {
  gate = startGate({ handler: () => new Response("app"), secret: "s3cret", appName: "Test App" });
  const auth = await fetch(gate.authUrl("/"), { redirect: "manual" });
  cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  // The page: same origin as the gate, with its cookie.
  realFetch = globalThis.fetch;
  (globalThis as any).location = new URL(gate.origin);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    typeof input === "string" && input.startsWith("/")
      ? realFetch(gate.origin + input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } })
      : realFetch(input, init)) as typeof fetch;
});
afterAll(() => {
  gate.server.stop(true);
  provider.stop(true);
});

const opened = async (transport: ReturnType<typeof mockPlatform>) => {
  for (let i = 0; i < 200 && !transport.requests.some((r) => r.op === "openExternal"); i++) await Bun.sleep(5);
  const open = transport.requests.find((r) => r.op === "openExternal");
  return open ? new URL(String(open.args.url)) : null;
};
/** The system browser: opens what openExternal got, follows the provider's redirect (no cookie). */
async function browse(transport: ReturnType<typeof mockPlatform>) {
  const url = (await opened(transport))!;
  const hop = await realFetch(url, { redirect: "manual" });
  if (hop.status !== 302) return { status: hop.status, html: await hop.text(), opened: url };
  const page = await realFetch(hop.headers.get("location")!);
  return { status: page.status, html: await page.text(), opened: url };
}

test("loopback sign-in at a strict provider: one registered path, code back, PKCE accepted", async () => {
  const transport = mockPlatform();
  const pending = authorize({ url: `${P()}/authorize`, params: { client_id: "app", scope: "read", redirect_uri: "http://attacker/", response_type: "token" } });
  const { status, html, opened } = await browse(transport);
  expect(status).toBe(200);
  expect(html).toContain("re signed in");
  expect(opened.searchParams.get("redirect_uri")).toBe(`${gate.origin}${REGISTERED}`); // ours, not the param's
  expect(opened.searchParams.get("response_type")).toBe("code");
  expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
  const result = await pending;
  expect(result.code).toStartWith("code-for-");
  expect(transport.requests.some((r) => r.service === "app" && r.op === "show")).toBe(true);
  const tokens = await exchange({ url: `${P()}/token`, clientId: "app", code: result.code, codeVerifier: result.codeVerifier, redirectUri: result.redirectUri });
  expect(tokens.access_token).toBe("tok");
  // Single use.
  expect(await (await realFetch(`${result.redirectUri}?code=x&state=${result.state}`)).text()).toContain("expired");
});

test("a callback with a state nobody registered completes nothing; the real sign-in still works", async () => {
  const transport = mockPlatform();
  const pending = authorize({ url: `${P()}/authorize`, params: { client_id: "app" } });
  await opened(transport);
  const forged = await realFetch(`${gate.origin}${REGISTERED}?code=forged&state=${"A".repeat(43)}`);
  expect(await forged.text()).toContain("expired");
  await browse(transport);
  expect((await pending).code).toStartWith("code-for-");
});

test("refusal, issuer checks, timeout and cancel reject with OAuthError", async () => {
  let transport = mockPlatform();
  const denied = authorize({ url: `${P()}/authorize`, params: { client_id: "deny" } }).catch((e) => e);
  expect((await browse(transport)).html).toContain("t complete");
  expect((await denied).code).toBe("access_denied");

  transport = mockPlatform();
  const mixUp = authorize({ url: `${P()}/authorize`, params: { client_id: "evil-iss" }, issuer: "https://good.example" }).catch((e) => e);
  await browse(transport);
  expect((await mixUp).code).toBe("issuer_mismatch");

  transport = mockPlatform();
  const good = authorize({ url: `${P()}/authorize`, params: { client_id: "good-iss" }, issuer: "https://good.example" });
  await browse(transport);
  expect((await good).params.iss).toBe("https://good.example");

  transport = mockPlatform();
  const noIss = authorize({ url: `${P()}/authorize`, params: { client_id: "app" }, issuer: "https://good.example" }).catch((e) => e);
  await browse(transport);
  expect((await noIss).code).toBe("issuer_mismatch"); // requireIssuer defaults to true with an issuer

  mockPlatform();
  expect((await authorize({ url: `${P()}/authorize`, timeoutMs: 300 }).catch((e) => e)).code).toBe("timeout");

  transport = mockPlatform();
  const pre = new AbortController();
  pre.abort();
  expect((await authorize({ url: `${P()}/authorize`, signal: pre.signal }).catch((e) => e)).code).toBe("aborted");
  expect(transport.requests.some((r) => r.op === "openExternal")).toBe(false); // the browser never opened

  transport = mockPlatform();
  const later = new AbortController();
  const cancelled = authorize({ url: `${P()}/authorize`, signal: later.signal }).catch((e) => e);
  const url = (await opened(transport))!;
  later.abort();
  expect((await cancelled).code).toBe("aborted");
  await Bun.sleep(50);
  // The server forgot it: the browser coming back later completes nothing.
  const hop = await realFetch(url, { redirect: "manual" });
  expect(await (await realFetch(hop.headers.get("location")!)).text()).toContain("expired");
});

test("server: a callback before the wait is kept; an aborted wait leaves the sign-in open; limits", async () => {
  const state = () => crypto.randomUUID().replace(/-/g, "") + "abcdefgh";
  // Early callback, single read.
  let s = state();
  let start = await (await fetch("/__desktop/oauth/start", { method: "POST", body: JSON.stringify({ state: s }) })).json();
  expect(await (await realFetch(`${gate.origin}${REGISTERED}?code=early&state=${s}`)).text()).toContain("signed in");
  expect((await (await fetch(`/__desktop/oauth/wait/${start.id}`)).json()).params.code).toBe("early");
  expect((await fetch(`/__desktop/oauth/wait/${start.id}`)).status).toBe(404);
  // An aborted wait, then the callback, then another wait: it gets the code.
  s = state();
  start = await (await fetch("/__desktop/oauth/start", { method: "POST", body: JSON.stringify({ state: s }) })).json();
  const abort = new AbortController();
  const first = fetch(`/__desktop/oauth/wait/${start.id}`, { signal: abort.signal }).catch(() => "aborted");
  await Bun.sleep(30);
  abort.abort();
  expect(await first).toBe("aborted");
  await Bun.sleep(30);
  await realFetch(`${gate.origin}${REGISTERED}?code=late&state=${s}`);
  expect((await (await fetch(`/__desktop/oauth/wait/${start.id}`)).json()).params.code).toBe("late");
  // Bad bodies, and the cap on sign-ins under way.
  expect((await fetch("/__desktop/oauth/start", { method: "POST", body: "null" })).status).toBe(400);
  expect((await fetch("/__desktop/oauth/start", { method: "POST", body: JSON.stringify({ state: "short" }) })).status).toBe(400);
  const ids: string[] = [];
  let status = 200;
  for (let i = 0; i < 40 && status === 200; i++) {
    const r = await fetch("/__desktop/oauth/start", { method: "POST", body: JSON.stringify({ state: state() }) });
    status = r.status;
    if (r.ok) ids.push((await r.json()).id);
  }
  expect(status).toBe(429);
  for (const id of ids) await fetch("/__desktop/oauth/cancel", { method: "POST", body: JSON.stringify({ id }) });
  expect((await fetch("/__desktop/oauth/start", { method: "POST", body: JSON.stringify({ state: state() }) })).status).toBe(200);
});

test("exchange refuses non-token answers and redirects", async () => {
  const base = { clientId: "app", code: "c", redirectUri: "http://127.0.0.1/x" };
  expect((await exchange({ ...base, url: `${P()}/html` }).catch((e) => e)).code).toBe("invalid_response");
  expect((await exchange({ ...base, url: `${P()}/moved` }).catch((e) => e)).code).toBe("server_error");
  expect((await exchange({ ...base, url: `${P()}/token` }).catch((e) => e)).code).toBe("invalid_grant");
});

test("the gate keeps start / wait / cancel behind the session cookie", async () => {
  expect((await realFetch(`${gate.origin}/__desktop/oauth/start`, { method: "POST" })).status).toBe(403);
  expect((await realFetch(`${gate.origin}/__desktop/oauth/wait/${"a".repeat(48)}`)).status).toBe(403);
  expect((await realFetch(`${gate.origin}/__desktop/oauth/cancel`, { method: "POST" })).status).toBe(403);
});
