// Web permissions, authentication and certificates on WebKitGTK, with their real effects: mock
// capture devices give getUserMedia a real answer (test channel), a local server asks Basic auth
// and counts, a self-signed Bun HTTPS server has a real fingerprint.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

// Self-signed for localhost, 127.0.0.1 and 127.0.0.2, until 2126. Only for this test.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBgzCCASigAwIBAgIUeU2KW57TqpCaicxPrABMtMPikGAwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKa2l0b3AgdGVzdDAgFw0yNjExMDYwOTU4MDVaGA8yMTI2MTAx
MzA5NTgwNVowFTETMBEGA1UEAwwKa2l0b3AgdGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABImG9Q7aU1YtXcDMOnK/sgK2L3Rh1fbTgwfXHt9azFqF7HhSeuKA
nWhNOqcluIdwZ+f9IkXDtM9onK9QzQubc3CjVDBSMB0GA1UdDgQWBBS1jUK87QlZ
gURmUNyVXCUJjly0/DAPBgNVHRMBAf8EBTADAQH/MCAGA1UdEQQZMBeCCWxvY2Fs
aG9zdIcEfwAAAYcEfwAAAjAKBggqhkjOPQQDAgNJADBGAiEA/xkhR35q3YmcMsZv
iPB094DEEBr+0KdT9M7urZR+Ua0CIQDwFVS+ucv9yil28dnoBLoS0ApTcI60NDPQ
m7hq9lWWvQ==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjzWix2YiFqAK/VbD
AeHKqX1U2KsDrFeEKbXqRLmwtwGhRANCAASJhvUO2lNWLV3AzDpyv7ICti90YdX2
04MH1x7fWsxahex4UnrigJ1oTTqnJbiHcGfn/SJFw7TPaJyvUM0Lm3Nw
-----END PRIVATE KEY-----
`;
const FINGERPRINT = createHash("sha256").update(Buffer.from(CERT.replace(/-----[^-]+-----|\s/g, ""), "base64")).digest("hex");

const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]).stdout.toString().trim();
const html = (body: string, init: ResponseInit = {}) => new Response(`<!doctype html><title>t</title>${body}`, { ...init, headers: { "content-type": "text/html", ...(init.headers ?? {}) } });

export default async (t: Harness) => {
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`;
  const file = `${dataHome}/dev.kitop.harness/web-permissions.json`;
  rmSync(file, { force: true });
  const seen = new Set<any>();
  async function nextEvent(name: string, pred: (e: any) => boolean = () => true, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = (t.events.get(name) ?? []).find((x) => !seen.has(x) && pred(x));
      if (e) {
        seen.add(e);
        return e;
      }
      await t.sleep(20);
    }
    return null;
  }
  const respond = (requestId: string, answer: unknown) => t.call("webview", "respondPolicy", { requestId, answer });
  const configure = (kind: string, enabled: boolean, timeoutMs = 15000) => t.call("webview", "configurePolicy", { kind, enabled, timeoutMs });
  const policy = async (permission: string, target: object = { windowId: 0 }) => (await t.call("webview", "_permissionPolicyForTesting", { ...target, permission })).value;

  // ---- configure and saved decisions ----------------------------------------
  t.check("configurePolicy: unknown kind → invalid_args", (await t.call("webview", "configurePolicy", { kind: "nope" })).error?.code === "invalid_args");
  t.check("configurePolicy: timeoutMs out of range → invalid_args", (await configure("permission", true, 10)).error?.code === "invalid_args");
  t.check("respondPolicy: unknown request → unavailable", (await respond("nope", "allow")).error?.code === "unavailable");
  const list = async () => (await t.call("webview", "listPermissionDecisions")).value;
  t.check("no saved decisions to begin with", Array.isArray(await list()) && (await list()).length === 0);
  const bad = await t.call("webview", "setPermissionDecision", { origin: "file:///x", permission: "camera", decision: "allow" });
  t.check("setPermissionDecision: not http(s) → invalid_args", bad.error?.code === "invalid_args", bad);
  t.check("setPermissionDecision: unknown permission → invalid_args", (await t.call("webview", "setPermissionDecision", { origin: "https://a.example", permission: "usb", decision: "allow" })).error?.code === "invalid_args");
  t.check("setPermissionDecision: unknown decision → invalid_args", (await t.call("webview", "setPermissionDecision", { origin: "https://a.example", permission: "camera", decision: "maybe" })).error?.code === "invalid_args");
  t.check("setPermissionDecision", (await t.call("webview", "setPermissionDecision", { origin: "HTTPS://A.example:443/path", permission: "camera", decision: "allow" })).ok);
  const saved = await list();
  t.check("listPermissionDecisions: origin normalized (scheme, case, default port)", saved.length === 1 && saved[0].origin === "https://a.example" && saved[0].permission === "camera" && saved[0].decision === "allow", saved);
  t.check("the decision is really on disk", existsSync(file) && JSON.parse(readFileSync(file, "utf8"))["https://a.example\ncamera"]?.decision === "allow", file);
  t.check("revokePermissionDecision", (await t.call("webview", "revokePermissionDecision", { origin: "https://a.example", permission: "camera" })).ok && (await list()).length === 0);

  // ---- permissions, for real: getUserMedia on mock devices -------------------
  const hits = new Map<string, number>();
  let gotAuth: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path.startsWith("/secret")) {
        const auth = req.headers.get("authorization");
        if (auth) gotAuth.push(atob(auth.slice(6)));
        if (auth === `Basic ${btoa("ada:right")}`) return html("<p id=p>welcome</p>");
        return html("<p id=p>server said no</p>", { status: 401, headers: { "www-authenticate": 'Basic realm="harness realm"' } });
      }
      return html(`<p id=p>${path}</p>`);
    },
  });
  const ext = `http://127.0.0.1:${server.port}`;
  const capture = (constraints: string) => `navigator.mediaDevices.getUserMedia(${constraints}).then((s) => { const n = s.getTracks().map((x) => x.kind).sort(); s.getTracks().forEach((x) => x.stop()); return { ok: true, tracks: n }; }, (e) => ({ ok: false, name: e.name }))`;
  // WebKit remembers a grant for as long as a web view stays on the origin: each case gets its own view.
  let viewCount = 0;
  async function freshView() {
    const id = `perm-${++viewCount}`;
    await t.call("view", "create", { id, url: `${ext}/permissions`, bounds: { x: 0, y: 0, width: 200, height: 100 } });
    for (let i = 0; i < 40; i++) {
      if ((await t.call("webview", "executeJavaScript", { viewId: id, code: "location.pathname + document.readyState" })).value === "/permissionscomplete") break;
      await t.sleep(25);
    }
    return { id, run: async (code: string) => (await t.call("webview", "executeJavaScript", { viewId: id, code })).value, done: () => t.call("view", "destroy", { id }) };
  }
  const nextRequest = (id: string, ms?: number) => nextEvent("webPermissionRequest", (e) => e.viewId === id, ms);

  const origin: string = await t.page("return location.origin");
  t.check("_permissionPolicyForTesting: unknown permission → invalid_args", (await t.call("webview", "_permissionPolicyForTesting", { permission: "usb" })).error?.code === "invalid_args");
  t.check("no handler: the app's own page → allow", (await policy("camera")) === "allow");
  let result = await t.page<any>(`return await ${capture("{video:true}")}`);
  t.check("no handler: the app's page really gets the camera", result?.ok === true && result.tracks?.[0] === "video", result);

  let view = await freshView();
  t.check("no handler: another origin → deny", (await policy("camera", { viewId: view.id })) === "deny");
  result = await view.run(capture("{video:true}"));
  t.check("no handler: another origin is really refused", result?.ok === false && result.name === "NotAllowedError", result);
  await t.call("webview", "setPermissionDecision", { origin: ext, permission: "camera", decision: "allow" });
  t.check("a saved decision is per origin", (await policy("camera", { viewId: view.id })) === "allow" && (await policy("camera")) === "allow" && (await list()).some((r: any) => r.origin === ext));
  result = await view.run(capture("{video:true}"));
  t.check("saved allow: no handler, really granted", result?.ok === true, result);
  await view.done();
  await t.call("webview", "revokePermissionDecision", { origin: ext, permission: "camera" });

  t.check("setPermissionHandler (configurePolicy)", (await configure("permission", true)).ok);
  const windowMic = t.page<any>(`return await ${capture("{audio:true}")}`);
  let request = await nextEvent("webPermissionRequest", (e) => e.windowId === 0 && !e.viewId);
  t.check("webPermissionRequest from the window: origin, permission, target, no frame", request?.origin === origin && request.permission === "microphone" && request.frame === null && typeof request.requestId === "string", request);
  t.check("respondPolicy: deny", (await respond(request.requestId, "deny")).ok);
  result = await windowMic;
  t.check("denied: getUserMedia really rejects", result?.ok === false && result.name === "NotAllowedError", result);
  t.check("answering twice → unavailable", (await respond(request.requestId, "allow")).error?.code === "unavailable");

  view = await freshView();
  let asking = view.run(capture("{video:true}"));
  request = await nextRequest(view.id);
  t.check("a view's request names the view, its window and its origin", request?.viewId === view.id && request.windowId === 0 && request.origin === ext && request.permission === "camera", request);
  await respond(request.requestId, "allow");
  result = await asking;
  t.check("allowed: getUserMedia really resolves", result?.ok === true, result);
  await view.done();

  view = await freshView();
  asking = view.run(capture("{video:true,audio:true}"));
  const first = await nextRequest(view.id);
  await respond(first.requestId, "allow");
  const second = await nextRequest(view.id);
  t.check("camera and microphone: asked one after the other", first?.permission === "camera" && second?.permission === "microphone", { first, second });
  await respond(second.requestId, "allow");
  result = await asking;
  t.check("…and both tracks come", result?.ok === true && result.tracks.join() === "audio,video", result);
  await view.done();

  view = await freshView();
  asking = view.run(capture("{video:true}"));
  request = await nextRequest(view.id);
  await respond(request.requestId, "maybe");
  t.check("an answer that isn't a decision denies", (await asking)?.name === "NotAllowedError");
  await configure("permission", true, 100);
  result = await view.run(capture("{video:true}"));
  t.check("no answer before timeoutMs denies", result?.ok === false && result.name === "NotAllowedError" && !!(await nextRequest(view.id)), result);
  await configure("permission", true);
  // A handler answers for the page that asked.
  asking = view.run(capture("{video:true}"));
  request = await nextRequest(view.id);
  await t.call("view", "navigate", { id: view.id, url: `${ext}/permissions?next` });
  await t.sleep(500);
  t.check("the view moved on: the answer lands…", (await respond(request.requestId, "allow")).ok);
  asking = view.run(capture("{video:true}"));
  request = await nextRequest(view.id);
  t.check("…and granted nothing: the next page is asked", !!request, request);
  await respond(request.requestId, "deny");
  await asking;
  await view.done();

  // Frames: WebKit only asks for a frame the page delegated to, and the request can't name it.
  const other = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => html(`<script>navigator.mediaDevices.getUserMedia({video:true}).then((s) => { s.getTracks().forEach((x) => x.stop()); parent.postMessage('granted', '*'); }, (e) => parent.postMessage(e.name, '*'));</script>`) });
  const framed = (allow: string) => `new Promise((res) => { addEventListener('message', (e) => res(e.data), { once: true }); const f = document.createElement('iframe'); f.allow = ${JSON.stringify(allow)}; f.src = 'http://127.0.0.2:${other.port}/'; document.body.append(f); })`;
  view = await freshView();
  const asked = (t.events.get("webPermissionRequest") ?? []).length;
  result = await view.run(framed(""));
  t.check("a frame on another origin, not delegated: refused, no question", result === "NotAllowedError" && (t.events.get("webPermissionRequest") ?? []).length === asked, result);
  await view.done();
  view = await freshView();
  asking = view.run(framed("camera"));
  request = await nextRequest(view.id);
  t.check("delegated with allow=: asked, under the page's origin", request?.origin === ext && request.frame === null, request);
  await respond(request.requestId, "deny");
  t.check("…and refused with it", (await asking) === "NotAllowedError");
  await view.done();
  other.stop(true);

  // A saved decision comes before the handler.
  view = await freshView();
  const events = (t.events.get("webPermissionRequest") ?? []).length;
  await t.call("webview", "setPermissionDecision", { origin: ext, permission: "camera", decision: "deny" });
  t.check("saved deny: no question, really refused", (await view.run(capture("{video:true}")))?.name === "NotAllowedError" && (t.events.get("webPermissionRequest") ?? []).length === events);
  t.check("saved deny, per the policy", (await policy("camera", { viewId: view.id })) === "deny");
  // `prompt`: WebKitGTK has no prompt, the shell asks in a real dialog.
  await t.call("webview", "setPermissionDecision", { origin: ext, permission: "camera", decision: "prompt" });
  t.check("saved prompt, per the policy", (await policy("camera", { viewId: view.id })) === "prompt");
  asking = view.run(capture("{video:true}"));
  await t.sleep(800);
  xdotool("key", "--clearmodifiers", "Return"); // the default button: Deny
  t.check("prompt: the shell's dialog, its default refuses", (await asking)?.name === "NotAllowedError");
  asking = view.run(capture("{video:true}"));
  await t.sleep(800);
  xdotool("key", "--clearmodifiers", "Tab"); // Allow, after Deny
  xdotool("key", "--clearmodifiers", "Return");
  result = await asking;
  t.check("prompt: Allow in the dialog grants", result?.ok === true && (t.events.get("webPermissionRequest") ?? []).length === events, { result, active: xdotool("getactivewindow", "getwindowname") });
  await view.done();
  await t.call("webview", "revokePermissionDecision", { origin: ext, permission: "camera" });

  // Location: WebKit asks for it; what comes after the answer is GeoClue's (not in this image).
  const locate = `new Promise((res) => navigator.geolocation.getCurrentPosition(() => res({ ok: true }), (e) => res({ code: e.code }), { timeout: 1500 }))`;
  view = await freshView();
  asking = view.run(locate);
  request = await nextRequest(view.id);
  t.check("location is asked", request?.permission === "location", request);
  await respond(request.requestId, "deny");
  t.check("location denied: PERMISSION_DENIED", (await asking)?.code === 1);
  await view.done();
  view = await freshView();
  asking = view.run(locate);
  request = await nextRequest(view.id);
  await respond(request.requestId, "allow");
  result = await asking;
  t.check("location allowed: past the permission", result?.ok === true || (result?.code && result.code !== 1), result);
  await view.done();

  // Screen capture needs a user gesture: a real click.
  await t.page(`window.__display = null; document.body.innerHTML = '<button id=b style="position:fixed;left:0;top:0;width:100%;height:100%">x</button>';
    document.getElementById('b').addEventListener('click', () => navigator.mediaDevices.getDisplayMedia({video:true}).then((s) => { window.__display = { ok: true }; s.getTracks().forEach((x) => x.stop()); }, (e) => { window.__display = { ok: false, name: e.name }; })); return 1`);
  const win = xdotool("search", "--name", "platform harness").split("\n")[0];
  xdotool("mousemove", "--window", win, "200", "200", "click", "1");
  request = await nextEvent("webPermissionRequest", (e) => e.permission === "screenRecording", 3000);
  if (request) {
    await respond(request.requestId, "deny");
    await t.sleep(300);
    const display = await t.page<any>("return window.__display");
    t.check("getDisplayMedia asks screenRecording; denied, it rejects", display?.ok === false, display);
  } else t.skip("getDisplayMedia asks screenRecording", `no request: ${JSON.stringify(await t.page("return window.__display"))}`);
  await configure("permission", false);
  await t.page("setTimeout(() => { location.href = '/' }, 10); return 1");
  await t.sleep(500);

  // ---- a view on another origin ------------------------------------------------
  await t.call("view", "create", { id: "web", url: `${ext}/start`, bounds: { x: 0, y: 0, width: 300, height: 200 } });
  await t.sleep(500);
  const inView = async (code: string) => (await t.call("webview", "executeJavaScript", { viewId: "web", code })).value;
  const go = (path: string, base = ext) => t.call("view", "navigate", { id: "web", url: base + path });
  const text = () => inView("document.getElementById('p')?.textContent ?? null");
  async function textIs(want: string, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await text()) === want) return true;
      await t.sleep(50);
    }
    return false;
  }

  // ---- authentication -----------------------------------------------------------
  await go("/secret-none");
  t.check("no handler: no login box, the page gets the server's 401", await textIs("server said no"), await text());
  t.check("onAuthChallenge (configurePolicy)", (await configure("auth", true)).ok);
  await go("/secret");
  let challenge = await nextEvent("webAuthChallenge");
  const port = Number(new URL(ext).port);
  t.check("webAuthChallenge: origin, host, port, realm, method, target", challenge?.origin === ext && challenge.host === "127.0.0.1" && challenge.port === port && challenge.realm === "harness realm" && challenge.method === "basic" && challenge.proxy === false && challenge.previousFailures === 0 && Array.isArray(challenge.identities) && challenge.viewId === "web", challenge);
  gotAuth = [];
  await respond(challenge.requestId, { username: "ada", password: "wrong" });
  const retry = await nextEvent("webAuthChallenge");
  t.check("a wrong password reached the server, and asks again", gotAuth.includes("ada:wrong") && retry?.previousFailures > 0, { gotAuth, retry });
  await respond(retry.requestId, { username: "ada", password: "right" });
  t.check("the right one opens the page", (await textIs("welcome")) && gotAuth.includes("ada:right"), { gotAuth, text: await text() });
  // A new origin per case: libsoup keeps the credentials of an authenticated session.
  const authServer = () => Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => (req.headers.get("authorization") ? html("<p id=p>sent</p>") : html("<p id=p>server said no</p>", { status: 401, headers: { "www-authenticate": 'Basic realm="r"' } })),
  });
  const s2 = authServer();
  await go("/", `http://127.0.0.1:${s2.port}`);
  challenge = await nextEvent("webAuthChallenge");
  await respond(challenge.requestId, "default");
  t.check("default: no credential, the server's own answer", await textIs("server said no"), await text());
  const s3 = authServer();
  const beforeCancel = await text();
  await go("/", `http://127.0.0.1:${s3.port}`);
  challenge = await nextEvent("webAuthChallenge");
  await respond(challenge.requestId, "cancel");
  await t.sleep(500);
  t.check("cancel: nothing sent, the load stops", (await text()) === beforeCancel || (await text()) === null, await text());
  const s4 = authServer();
  await configure("auth", true, 100);
  await go("/", `http://127.0.0.1:${s4.port}`);
  await t.sleep(600);
  const late = await nextEvent("webAuthChallenge");
  t.check("no answer before timeoutMs cancels", !!late && (await respond(late.requestId, { username: "a", password: "b" })).error?.code === "unavailable", late);
  await configure("auth", true);
  s2.stop(true); s3.stop(true); s4.stop(true);

  // ---- certificates --------------------------------------------------------------
  const pin = { host: "127.0.0.1", fingerprint: FINGERPRINT };
  t.check("allowCertificate: a wildcard host → invalid_args", (await t.call("webview", "allowCertificate", { host: "*.example", fingerprint: FINGERPRINT })).error?.code === "invalid_args");
  t.check("allowCertificate: not a SHA-256 → invalid_args", (await t.call("webview", "allowCertificate", { host: "a.example", fingerprint: "abc" })).error?.code === "invalid_args");
  t.check("revokeCertificate: same validation", (await t.call("webview", "revokeCertificate", { host: "a/b", fingerprint: FINGERPRINT })).error?.code === "invalid_args");
  let httpsHits = 0;
  const https = Bun.serve({ hostname: "0.0.0.0", port: 0, tls: { cert: CERT, key: KEY }, fetch() { httpsHits++; return html("<p id=p>tls ok</p>"); } });
  const tls = (host: string) => `https://${host}:${https.port}`;
  await go("/", tls("127.0.0.1"));
  challenge = await nextEvent("webAuthChallenge", (e) => e.method === "serverTrust");
  t.check("a self-signed certificate: serverTrust, with its real fingerprint", challenge?.fingerprint === FINGERPRINT && challenge.host === "127.0.0.1" && challenge.port === https.port && challenge.origin === tls("127.0.0.1") && challenge.viewId === "web", { challenge, FINGERPRINT });
  t.check("nothing was served before an answer", httpsHits === 0);
  await respond(challenge.requestId, "cancel");
  await t.sleep(400);
  t.check("cancel: the load fails, no request", httpsHits === 0 && (await nextEvent("viewFailed")) !== null, t.events.get("viewFailed")?.slice(-1));
  await go("/", tls("127.0.0.1"));
  challenge = await nextEvent("webAuthChallenge", (e) => e.method === "serverTrust");
  await respond(challenge.requestId, "default");
  await t.sleep(400);
  t.check("default without a pin: still refused", httpsHits === 0);
  await go("/", tls("127.0.0.1"));
  challenge = await nextEvent("webAuthChallenge", (e) => e.method === "serverTrust");
  t.check("allowCertificate during the challenge", (await t.call("webview", "allowCertificate", pin)).ok);
  await respond(challenge.requestId, "default");
  t.check("…then default: the page loads over TLS", (await textIs("tls ok")) && httpsHits === 1, { httpsHits, text: await text() });
  await configure("auth", false);
  await go("/start");
  await textIs("/start");
  await t.call("webview", "allowCertificate", { host: "localhost", fingerprint: FINGERPRINT });
  await go("/pinned", tls("localhost"));
  t.check("no handler, a pin made before the load: it just loads", (await textIs("tls ok")) && httpsHits === 2, { httpsHits, text: await text(), failed: t.events.get("viewFailed")?.slice(-2) });
  await go("/start");
  await textIs("/start");
  const countBefore = httpsHits;
  await t.call("webview", "allowCertificate", { host: "127.0.0.2", fingerprint: FINGERPRINT });
  t.check("revokeCertificate", (await t.call("webview", "revokeCertificate", { host: "127.0.0.2", fingerprint: FINGERPRINT })).ok);
  await go("/", tls("127.0.0.2"));
  await t.sleep(800);
  t.check("a revoked pin allows nothing", httpsHits === countBefore, { httpsHits });
  // The limits docs/web-policy states: top-level loads only, and WebKit can't forget.
  await configure("auth", true);
  const events2 = (t.events.get("webAuthChallenge") ?? []).length;
  await t.call("webview", "allowCertificate", { host: "127.0.0.2", fingerprint: FINGERPRINT });
  await go("/start");
  await textIs("/start");
  const fetched = await inView(`fetch(${JSON.stringify(tls("127.0.0.2") + "/fetched")}, { mode: "no-cors" }).then(() => "ok", (e) => e.name)`);
  await t.sleep(300);
  t.check("a fetch to a host with a bad certificate just fails, pinned or not, without a challenge", fetched === "TypeError" && httpsHits === countBefore && (t.events.get("webAuthChallenge") ?? []).length === events2, { fetched, httpsHits, countBefore });
  await configure("auth", false);
  await t.call("webview", "revokeCertificate", { host: "127.0.0.2", fingerprint: FINGERPRINT });
  await t.call("webview", "revokeCertificate", pin);
  await go("/after-revoke", tls("127.0.0.1"));
  t.check("after a load, a revoked certificate keeps working: WebKitGTK has no way to forget it", (await textIs("tls ok")) && httpsHits === countBefore + 1, { httpsHits, countBefore });
  https.stop(true);

  // A server that asks for a client certificate: Linux has no store of identities to offer.
  const identities = await t.call("webview", "listClientIdentities");
  t.check("listClientIdentities stays unsupported", identities.error?.code === "unsupported", identities);
  await configure("auth", true);
  await t.call("webview", "allowCertificate", pin);
  const mutual = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: CERT, key: KEY, requestCert: true, rejectUnauthorized: false }, fetch: () => html("<p id=p>no client cert needed</p>") });
  await go("/", `https://127.0.0.1:${mutual.port}`);
  challenge = await nextEvent("webAuthChallenge", (e) => e.method === "clientCertificate", 3000);
  if (challenge) {
    t.check("a client certificate challenge offers no identity", challenge.identities.length === 0, challenge);
    await respond(challenge.requestId, "default");
    t.check("default: goes on without one", await textIs("no client cert needed"), await text());
  } else t.skip("client certificate challenge", `not raised by this TLS stack: ${JSON.stringify(t.events.get("webAuthChallenge")?.slice(-1))}`);
  await configure("auth", false);
  mutual.stop(true);
  await t.call("view", "destroy", { id: "web" });
  server.stop(true);
};
