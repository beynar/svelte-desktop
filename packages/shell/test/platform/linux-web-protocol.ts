// Custom resource schemes on WebKitGTK, through the real src/platform/protocol.ts: real images, scripts,
// frames and pages load from `asset://`, in the default session and a named one, and bytes stream.
import { deliverPlatformEvent, initPlatformForTests } from "../../src/platform/bus.ts";
import { protocol } from "../../src/platform/protocol.ts";
import type { Harness } from "../harness-worker.ts";

// A 1×1 PNG.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export default async (t: Harness) => {
  initPlatformForTests({
    platformCall(request) {
      const { id, service, op, args } = JSON.parse(request);
      void t.call(service, op, args).then((r) => deliverPlatformEvent("platformResult", { ...r, id }));
      return JSON.stringify({ pending: true });
    },
  });
  t.onEvent((name, data) => deliverPlatformEvent(name, data));
  await t.sleep(10); // protocol.ts starts listening once the bus is bound

  const requests: { url: string; method: string; body?: string; contentType: string | null; aborted?: () => boolean }[] = [];
  const release: Record<string, () => void> = {};
  const held = (name: string) => new Promise<void>((resolve) => (release[name] = resolve));
  const big = Buffer.alloc(300000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  let streamed: Request | undefined;
  protocol.handle("asset", async (request) => {
    const url = new URL(request.url);
    const entry = { url: request.url, method: request.method, body: undefined as string | undefined, contentType: request.headers.get("content-type") };
    requests.push(entry);
    if (request.method === "POST") entry.body = await request.text();
    switch (url.pathname) {
      case "/pixel.png": return new Response(PIXEL, { headers: { "content-type": "image/png" } });
      case "/script.js": return new Response(`window.fromScheme = "ran"; document.documentElement.dataset.script = "ran";`, { headers: { "content-type": "text/javascript" } });
      case "/page.html": return new Response(`<!doctype html><title>scheme page</title><p id=p>from asset</p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      case "/frame.html": return new Response(`<!doctype html><script>parent.postMessage("frame says hi", "*")</script>`, { headers: { "content-type": "text/html" } });
      case "/big.bin": return new Response(big, { headers: { "content-type": "application/octet-stream" } });
      case "/missing": return new Response("not here", { status: 404, headers: { "content-type": "text/plain", "x-custom": "yes" } });
      case "/empty": return new Response(null, { status: 204 });
      case "/echo": return new Response(`${request.method}:${entry.body ?? ""}`, { headers: { "content-type": "text/plain" } });
      case "/throws": throw new Error("handler broke");
      case "/stream.html": {
        streamed = request;
        const encoder = new TextEncoder();
        let sent = false;
        return new Response(new ReadableStream({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode(`<!doctype html><title>stream</title><script>window.firstChunk = true</script><p id=first>one</p>`));
              return;
            }
            await held("stream");
            controller.enqueue(encoder.encode(`<p id=second>two</p>`));
            controller.close();
          },
        }), { headers: { "content-type": "text/html; charset=utf-8" } }); // without a charset, the parser waits for 1 KB to look for one
      }
      case "/endless": {
        streamed = request;
        return new Response(new ReadableStream({
          async pull(controller) {
            await Bun.sleep(50);
            controller.enqueue(new TextEncoder().encode(`<p>more</p>`));
          },
        }), { headers: { "content-type": "text/html" } });
      }
      case "/hold": return new Promise<Response>(() => {});
      default: return new Response("nothing", { status: 404 });
    }
  });
  t.check("isProtocolHandled", protocol.isProtocolHandled("asset"));

  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response(`<!doctype html><title>site</title><body>`, { headers: { "content-type": "text/html" } }) });
  const site = `http://127.0.0.2:${server.port}`;
  const js = async (id: string, code: string) => (await t.call("webview", "executeJavaScript", { viewId: id, code })).value;
  const reached = async (id: string, url: string) => {
    for (let i = 0; i < 200; i++) {
      if ((await js(id, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`)) === true) return true;
      await t.sleep(20);
    }
    return false;
  };
  const open = async (id: string, url: string, extra: Record<string, unknown> = {}) => {
    await t.call("view", "create", { id, url, bounds: { x: 0, y: 0, width: 300, height: 200 }, ...extra });
    return reached(id, url);
  };
  const untilTrue = async (ok: () => unknown | Promise<unknown>, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ok()) return true;
      await t.sleep(20);
    }
    return false;
  };
  const resources = (id: string) => ({
    image: () => js(id, `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve({ loaded: true, width: i.naturalWidth }); i.onerror = () => resolve({ loaded: false }); i.src = "asset://archive/pixel.png?" + Math.random(); })`),
    script: () => js(id, `new Promise((resolve) => { const s = document.createElement("script"); s.onload = () => resolve(window.fromScheme); s.onerror = () => resolve("error"); s.src = "asset://archive/script.js"; document.head.append(s); })`),
    frame: () => js(id, `new Promise((resolve) => { addEventListener("message", (e) => resolve(e.data), { once: true }); const f = document.createElement("iframe"); f.src = "asset://archive/frame.html"; document.body.append(f); setTimeout(() => resolve("timeout"), 3000); })`),
  });

  // ---- from an ordinary page ----------------------------------------------------------
  await open("site", `${site}/`);
  const { image, script, frame } = resources("site");
  const shown = await image();
  t.check("<img>: real pixels from the handler", shown?.loaded === true && shown.width === 1, shown);
  t.check("the handler got a Request", requests.at(-1)?.url.startsWith("asset://archive/pixel.png") && requests.at(-1)?.method === "GET", requests.at(-1));
  t.check("<script>: it runs", (await script()) === "ran");
  t.check("<iframe>: it loads, and runs", (await frame()) === "frame says hi");
  const crossFetch = await js("site", `fetch("asset://archive/echo").then((r) => r.text(), (e) => "refused: " + e.message)`);
  t.check("fetch() from an http page: refused, the handler isn't asked (cross-origin, not CORS-enabled)", String(crossFetch).startsWith("refused"), crossFetch);

  // ---- as the page itself ----------------------------------------------------------------
  t.check("view.create: a page from the scheme", await open("page", "asset://archive/page.html"));
  t.check("…its content", (await js("page", `document.getElementById("p").textContent + "|" + document.title`)) === "from asset|scheme page");
  const reachedWindow = await t.call("window", "create", { url: "asset://archive/page.html", visible: false });
  const inWindow = await untilTrue(async () => (await t.call("webview", "executeJavaScript", { windowId: reachedWindow.value?.windowId, code: `document.getElementById("p")?.textContent` })).value === "from asset");
  t.check("window.create: a page from the scheme stays in the window", inWindow, await t.call("webview", "getInfo", { windowId: reachedWindow.value?.windowId }));
  await t.call("window", "close", { windowId: reachedWindow.value?.windowId });

  // Same origin as itself: this is where fetch works, with methods, bodies, statuses and headers.
  const bytes = await js("page", `fetch("/big.bin").then(async (r) => { const b = new Uint8Array(await r.arrayBuffer()); let ok = b.length === 300000; for (let i = 0; ok && i < b.length; i++) ok = b[i] === ((i * 31) & 255); return { ok, length: b.length, type: r.headers.get("content-type") }; })`);
  t.check("300 KB, split in 64 KiB chunks: every byte, in order", bytes?.ok === true && bytes.type === "application/octet-stream", bytes);
  const missing = await js("page", `fetch("/missing").then(async (r) => ({ status: r.status, custom: r.headers.get("x-custom"), text: await r.text() }))`);
  t.check("status and headers reach the page", missing?.status === 404 && missing.custom === "yes" && missing.text === "not here", missing);
  const echoed = await js("page", `fetch("/echo", { method: "POST", headers: { "content-type": "text/x-test" }, body: "the body" }).then((r) => r.text())`);
  t.check("POST: method and body reach the handler", echoed === "POST:the body" && requests.at(-1)?.contentType === "text/x-test", { echoed, request: requests.at(-1) });
  const thrown = await js("page", `fetch("/throws").then(() => "answered", () => "failed")`);
  t.check("a handler that throws: the request fails", thrown === "failed", thrown);
  t.check("…protocolCancel says so", (t.events.get("protocolCancel") ?? []).length > 0);
  t.check("a response with no body", (await js("page", `fetch("/empty").then(async (r) => r.status + ":" + (await r.text()).length)`)) === "204:0");
  t.check("what isn't a declared scheme isn't taken: http and BAD were refused", !requests.some((r) => !r.url.startsWith("asset:")) && !(t.events.get("protocolRequest") ?? []).some((e) => !e.url.startsWith("asset:")));
  const noHandler = await js("page", `fetch("/unknown").then((r) => r.status)`);
  t.check("what the handler doesn't know: its own 404", noHandler === 404);

  // ---- streaming -----------------------------------------------------------------------
  await t.call("view", "navigate", { id: "page", url: "asset://archive/stream.html" });
  const gotFirst = await untilTrue(async () => (await js("page", `window.firstChunk === true && !!document.getElementById("first")`)) === true);
  t.check("streaming: the first chunk runs before the second exists", gotFirst && (await js("page", `document.getElementById("second")`)) === null && (await js("page", `document.readyState`)) === "loading", await js("page", `document.documentElement.outerHTML`));
  release.stream?.();
  t.check("…the rest comes when it's sent", await untilTrue(async () => (await js("page", `document.getElementById("second")?.textContent + document.readyState`)) === "twocomplete"));
  // Leaving in the middle: the handler hears it.
  await t.call("view", "navigate", { id: "page", url: "asset://archive/endless" });
  await untilTrue(() => streamed?.url.endsWith("/endless"));
  await t.sleep(300);
  const cancels = (t.events.get("protocolCancel") ?? []).length;
  await t.call("view", "navigate", { id: "page", url: "asset://archive/page.html" });
  t.check("leaving mid-stream: protocolCancel, the Request is aborted", await untilTrue(() => (t.events.get("protocolCancel") ?? []).length > cancels && streamed?.signal.aborted), { cancels, aborted: streamed?.signal.aborted });

  // ---- in a named session: schemes are per web context ----------------------------------
  await t.page(`document.cookie = '__kitop=gate; path=/'; return 1`);
  await t.call("sessions", "create", { id: "other", persistent: false });
  await open("other-site", `${site}/`, { session: "other" });
  t.check("a named session: <img> from the scheme", (await resources("other-site").image())?.loaded === true);
  t.check("a named session: a page from the scheme", (await open("other-page", "asset://archive/page.html", { session: "other" })) && (await js("other-page", `document.title`)) === "scheme page");
  await t.call("view", "destroy", { id: "other-site" });
  await t.call("view", "destroy", { id: "other-page" });
  t.check("…the session can go after", (await t.call("sessions", "remove", { session: "other" })).ok);

  // ---- the native ops themselves --------------------------------------------------------
  // A page's bus gets none of this.
  await t.page(`window.__seen = []; window.__shell.setSink((n, d) => { window.__seen.push(n); if (n === "platformResult") { pending.get(d.id)?.(d); pending.delete(d.id); } }); return 1`);
  for (const op of ["response", "data", "finish", "fail"]) {
    t.check(`protocol.${op}: unknown request → unavailable`, (await t.call("protocol", op, { requestId: "nope", status: 200, headers: {} })).error?.code === "unavailable");
    const fromPage = (await t.pageCall("protocol", op, { requestId: "nope" })) as any;
    t.check(`protocol.${op}: a page → denied`, fromPage.ok === false && fromPage.error?.code === "denied", fromPage);
  }
  const count = (t.events.get("protocolRequest") ?? []).length;
  const hold = js("site", `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded " + i.naturalWidth); i.onerror = () => resolve("error"); i.src = "asset://archive/hold"; })`);
  await untilTrue(() => (t.events.get("protocolRequest") ?? []).length > count);
  const raw = (t.events.get("protocolRequest") ?? []).at(-1);
  t.check("protocolRequest: its fields", typeof raw?.requestId === "string" && raw.url === "asset://archive/hold" && raw.method === "GET" && typeof raw.headers === "object", raw);
  const requestId = raw?.requestId;
  const p = (op: string, args: Record<string, unknown> = {}) => t.call("protocol", op, { requestId, ...args });
  t.check("data before the response → invalid_args", (await p("data", { data: PIXEL.toString("base64") })).error?.code === "invalid_args");
  t.check("finish before the response → invalid_args", (await p("finish")).error?.code === "invalid_args");
  t.check("response: bad status → invalid_args", (await p("response", { status: 99, headers: {} })).error?.code === "invalid_args");
  t.check("response: no headers → invalid_args", (await p("response", { status: 200 })).error?.code === "invalid_args");
  t.check("response: a header that isn't a string → invalid_args", (await p("response", { status: 200, headers: { a: 1 } })).error?.code === "invalid_args");
  t.check("response", (await p("response", { status: 200, headers: { "content-type": "image/png" } })).ok);
  t.check("response twice → invalid_args", (await p("response", { status: 200, headers: {} })).error?.code === "invalid_args");
  t.check("data: over 64 KiB → invalid_args", (await p("data", { data: Buffer.alloc(70000).toString("base64") })).error?.code === "invalid_args");
  t.check("data: not base64 → invalid_args", (await p("data", { data: "@@@" })).error?.code === "invalid_args");
  t.check("data", (await p("data", { data: PIXEL.toString("base64") })).ok);
  t.check("finish", (await p("finish")).ok);
  t.check("…the image is whole", (await hold) === "loaded 1");
  t.check("finish again → unavailable", (await p("finish")).error?.code === "unavailable");
  const failing = js("site", `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => resolve("error"); i.src = "asset://archive/hold?2"; })`);
  await untilTrue(() => (t.events.get("protocolRequest") ?? []).at(-1)?.url.endsWith("hold?2"));
  const second = (t.events.get("protocolRequest") ?? []).at(-1).requestId;
  t.check("fail", (await t.call("protocol", "fail", { requestId: second, message: "no" })).ok && (await failing) === "error");
  // Failing after the headers: the load fails all the same.
  const failLate = js("site", `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => resolve("error"); i.src = "asset://archive/hold?late"; })`);
  await untilTrue(() => (t.events.get("protocolRequest") ?? []).at(-1)?.url.endsWith("hold?late"));
  const lateId = (t.events.get("protocolRequest") ?? []).at(-1).requestId;
  await t.call("protocol", "response", { requestId: lateId, status: 200, headers: { "content-type": "image/png" } });
  t.check("fail after the response", (await t.call("protocol", "fail", { requestId: lateId, message: "no" })).ok && (await failLate) === "error");
  // The page goes away before the handler answers: WebKit doesn't say. Its answer is read and dropped: no hang.
  await open("gone", `${site}/`);
  await js("gone", `(() => { const i = new Image(); i.src = "asset://archive/hold?gone"; window.__i = i; return 1 })()`);
  await untilTrue(() => (t.events.get("protocolRequest") ?? []).at(-1)?.url.endsWith("hold?gone"));
  const goneId = (t.events.get("protocolRequest") ?? []).at(-1).requestId;
  await t.call("view", "navigate", { id: "gone", url: `${site}/elsewhere` });
  await reached("gone", `${site}/elsewhere`);
  t.check("left before an answer: the response is taken", (await t.call("protocol", "response", { requestId: goneId, status: 200, headers: {} })).ok);
  t.check("…its data too, nothing waits for ever", (await t.call("protocol", "data", { requestId: goneId, data: PIXEL.toString("base64") })).ok);
  t.check("…and it finishes", (await t.call("protocol", "finish", { requestId: goneId })).ok);
  await t.call("view", "destroy", { id: "gone" });
  const pageSaw = (await t.page(`return window.__seen`)) as string[];
  t.check("a page never hears of requests", !pageSaw.includes("protocolRequest") && !pageSaw.includes("protocolCancel"), pageSaw);

  // Not answered in 30 seconds: fails, and says so.
  const before = (t.events.get("protocolCancel") ?? []).length;
  await t.call("webview", "executeJavaScript", { viewId: "site", code: `window.lateImage = new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => resolve("error"); i.src = "asset://archive/hold?3"; }); 1` });
  await untilTrue(() => (t.events.get("protocolRequest") ?? []).at(-1)?.url.endsWith("hold?3"));
  const waiting = (t.events.get("protocolRequest") ?? []).at(-1).requestId;
  await t.sleep(5000);
  t.check("still waiting after 5 seconds", (t.events.get("protocolCancel") ?? []).length === before);
  await untilTrue(() => (t.events.get("protocolCancel") ?? []).some((e) => e.requestId === waiting), 28000);
  t.check("no answer in 30 seconds: protocolCancel", (t.events.get("protocolCancel") ?? []).some((e) => e.requestId === waiting));
  t.check("…the image fails", (await js("site", `window.lateImage`)) === "error");

  protocol.unhandle("asset");
  t.check("unhandle", !protocol.isProtocolHandled("asset"));
  await t.call("view", "destroy", { id: "page" });
  await t.call("view", "destroy", { id: "site" });
  server.stop(true);
};
