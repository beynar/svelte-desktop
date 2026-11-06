// Sessions on WebKitGTK: each its own WebKitWebContext and data, proven by a server that sees which
// cookies each one sends, a local proxy that sees the requests, and a run after a relaunch.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const asked: { path: string; cookie: string | null; host: string | null }[] = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      asked.push({ path: url.pathname, cookie: req.headers.get("cookie"), host: req.headers.get("host") });
      if (url.pathname === "/set") return new Response("set", { headers: { "set-cookie": `who=${url.searchParams.get("who")}; Path=/; Max-Age=3600; HttpOnly` } });
      return new Response(`<!doctype html><title>site</title><p id=p>${url.pathname}</p>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    },
  });
  const site = `http://127.0.0.2:${server.port}`;
  const s = (op: string, args: Record<string, unknown> = {}) => t.call("sessions", op, args);
  const js = async (viewId: string, code: string) => (await t.call("webview", "executeJavaScript", { viewId, code })).value;
  const open = async (id: string, url: string, extra: Record<string, unknown> = {}) => {
    const reply = await t.call("view", "create", { id, url, bounds: { x: 0, y: 0, width: 300, height: 200 }, ...extra });
    for (let i = 0; i < 200 && (await js(id, `location.href === ${JSON.stringify(url)} && document.readyState`)) !== "complete"; i++) await t.sleep(20);
    return reply;
  };
  const cookieAt = async (id: string) => {
    await js(id, `fetch('/see?${Date.now()}').then(() => 1)`);
    return asked.findLast((a) => a.path === "/see")?.cookie ?? "";
  };

  // ---- creating needs the app's authentication ---------------------------------------
  t.check("create before the app is authenticated → unavailable", (await s("create", { id: "early", persistent: false })).error?.code === "unavailable");
  t.check("…and the id isn't taken", !(await s("list")).value.some((x: any) => x.id === "early"));
  await t.page(`document.cookie = '__kitop=gate-value; path=/'; return 1`);

  for (const args of [{ id: "", persistent: false }, { id: "default", persistent: false }, { id: "x".repeat(201), persistent: false }, { id: "x" }, { id: "x", persistent: "yes" }])
    t.check(`create ${JSON.stringify(args).slice(0, 40)} → invalid_args`, (await s("create", args)).error?.code === "invalid_args");
  const one = await s("create", { id: "one", persistent: false });
  t.check("create: private", one.value?.id === "one" && one.value.persistent === false, one);
  t.check("create: duplicate → invalid_args", (await s("create", { id: "one", persistent: false })).error?.code === "invalid_args");
  t.check("create: persistent", (await s("create", { id: "disk", persistent: true })).value?.persistent === true);
  await s("create", { id: "two", persistent: false });
  t.check("list: sorted, with default", JSON.stringify((await s("list")).value.map((x: any) => x.id)) === JSON.stringify(["default", "disk", "one", "two"]));
  t.check("the shell's cookie reached it, unlisted", !(await s("cookiesGet", { session: "one" })).value.some((c: any) => c.name === "__kitop"));

  // ---- isolation: a real cookie, what the server receives ---------------------------
  t.check("view.create: an unknown session → invalid_args", (await t.call("view", "create", { id: "bad", url: `${site}/`, session: "nope", bounds: { x: 0, y: 0, width: 10, height: 10 } })).error?.code === "invalid_args");
  t.check("popover.create: an unknown session → invalid_args", (await t.call("popover", "create", { id: "bad", url: `${site}/`, session: "nope" })).error?.code === "invalid_args");
  t.check("window.create: an unknown session → invalid_args", (await t.call("window", "create", { url: `${site}/`, session: "nope" })).error?.code === "invalid_args");
  await open("in-one", `${site}/one`, { session: "one" });
  await open("in-two", `${site}/two`, { session: "two" });
  await open("in-default", `${site}/default`);
  await js("in-one", `fetch('/set?who=one').then(() => 1)`);
  await js("in-two", `fetch('/set?who=two').then(() => 1)`);
  t.check("session one sends its own cookie", (await cookieAt("in-one")).includes("who=one"), asked.at(-1));
  t.check("session two sends its own", (await cookieAt("in-two")).includes("who=two"), asked.at(-1));
  t.check("the default session sends neither", !(await cookieAt("in-default")).includes("who="), asked.at(-1));
  t.check("cookiesGet session one", (await s("cookiesGet", { session: "one", url: `${site}/`, name: "who" })).value?.[0]?.value === "one");
  t.check("cookiesGet session two", (await s("cookiesGet", { session: "two", url: `${site}/`, name: "who" })).value?.[0]?.value === "two");
  t.check("cookiesGet default", (await s("cookiesGet", { url: `${site}/`, name: "who" })).value?.length === 0);
  await js("in-one", `localStorage.setItem('kept', 'one'); 1`);
  t.check("localStorage is its own too", (await js("in-two", `localStorage.getItem('kept')`)) === null && (await js("in-default", `localStorage.getItem('kept')`)) === null);
  const seenEvents = (t.events.get("sessionCookieChanged") ?? []).length;
  await s("cookiesSet", { session: "two", url: `${site}/`, name: "api", value: "for-two" });
  t.check("cookiesSet in a session: only there", (await cookieAt("in-two")).includes("api=for-two") && !(await cookieAt("in-one")).includes("api=") && !(await cookieAt("in-default")).includes("api="));
  await t.sleep(300);
  const changed = (t.events.get("sessionCookieChanged") ?? []).slice(seenEvents).filter((e) => e.cookie.name === "api");
  t.check("sessionCookieChanged says which session", changed.length === 1 && changed[0].session === "two", changed);
  await js("in-one", `document.cookie = 'mine=page; path=/'; 1`);
  await t.sleep(300);
  t.check("sessionCookieChanged from a session's page", (t.events.get("sessionCookieChanged") ?? []).some((e) => e.session === "one" && e.cookie.name === "mine"));

  // Windows and popovers take a session too, tabs their window's.
  const made = await t.call("window", "create", { url: `${site}/in-window`, session: "one", visible: false });
  t.check("window.create in a session", made.ok, made);
  const win = made.value?.windowId;
  // A window stays on the app's origin: this site is refused at its response, its request shows the cookie.
  const askedFor = async (path: string) => {
    for (let i = 0; i < 200 && !asked.some((a) => a.path === path); i++) await t.sleep(20);
    return asked.findLast((a) => a.path === path);
  };
  t.check("…sends that session's cookie", (await askedFor("/in-window"))?.cookie?.includes("who=one"), asked.at(-1));
  const rows = (await t.call("window", "list")).value;
  t.check("window.list says which session", rows.find((r: any) => r.windowId === win)?.session === "one" && rows.find((r: any) => r.windowId === 0)?.session === null, rows);
  t.check("remove while a window uses it → unavailable", (await s("remove", { session: "one" })).error?.code === "unavailable");
  await t.call("view", "create", { id: "tab", url: `${site}/in-tab`, tab: true, windowId: win, bounds: { x: 0, y: 0, width: 100, height: 100 } });
  for (let i = 0; i < 200 && (await js("tab", `location.pathname === "/in-tab" && document.readyState`)) !== "complete"; i++) await t.sleep(20);
  await js("tab", `fetch('/see-tab').then(() => 1)`);
  t.check("a tab has its window's profile", asked.findLast((a) => a.path === "/see-tab")?.cookie?.includes("who=one"), asked.at(-1));
  await t.call("window", "close", { windowId: win });
  await t.sleep(200);

  await t.call("popover", "create", { id: "pop", url: `${site}/in-popover`, session: "two" });
  t.check("popover.create in a session", (await askedFor("/in-popover"))?.cookie?.includes("who=two"), asked.at(-1));

  // A download in a session goes through that session's context, with its cookies.
  const dir = mkdtempSync(`${tmpdir()}/kitop-session-`);
  await t.call("webview", "setDownloadDirectory", { path: dir });
  await js("in-two", `(() => { const a = document.createElement('a'); a.href = '/file.txt'; a.download = 'file.txt'; document.body.append(a); a.click(); return 1 })()`);
  await t.sleep(500);
  t.check("a download in a session is seen, with its cookies", asked.findLast((a) => a.path === "/file.txt")?.cookie?.includes("who=two") && (t.events.get("downloadStarted") ?? []).length > 0, { asked: asked.at(-1), started: t.events.get("downloadStarted") });

  // ---- proxy --------------------------------------------------------------------------
  // A real HTTP proxy: it sees what WebKit sends it, answers for hosts that don't exist.
  const proxied: { line: string; auth: string | null }[] = [];
  let wantAuth = false;
  const proxy = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const text = data.toString();
        const line = text.split("\r\n")[0];
        const auth = text.match(/proxy-authorization: *(.*)/i)?.[1]?.trim() ?? null;
        proxied.push({ line, auth });
        if (wantAuth && !auth) {
          socket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="p"\r\nContent-Length: 0\r\n\r\n`);
          return;
        }
        if (line.startsWith("CONNECT")) { socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); socket.end(); return; }
        const body = `<!doctype html><title>via</title><p id=p>via proxy</p>`;
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        socket.end();
      },
    },
  });
  t.check("getProxy: none yet", (await s("getProxy", { session: "one" })).value === null);
  const bad: [Record<string, unknown>, string][] = [
    [{ type: "ftp", host: "h", port: 1 }, "invalid_args"], [{ type: "http", host: "", port: 1 }, "invalid_args"], [{ type: "http", host: "h", port: 70000 }, "invalid_args"], [{ type: "http", host: "h", port: 1.5 }, "invalid_args"],
    [{ type: "socks", host: "h", port: 1, tls: true }, "invalid_args"], [{ type: "http", host: "h", port: 1, password: "p" }, "invalid_args"], [{ type: "http", host: "h", port: 1, username: 3 }, "invalid_args"],
    [{ type: "http", host: "h", port: 1, pac: "x" }, "unsupported"],
  ];
  for (const [p, code] of bad) t.check(`setProxy ${JSON.stringify(p)} → ${code}`, (await s("setProxy", { session: "one", proxy: p })).error?.code === code);
  t.check("setProxy: not an object → invalid_args", (await s("setProxy", { session: "one" })).error?.code === "invalid_args");
  t.check("setProxy", (await s("setProxy", { session: "one", proxy: { type: "http", host: "127.0.0.1", port: proxy.port } })).ok);
  const shown = (await s("getProxy", { session: "one" })).value;
  t.check("getProxy: what was set", shown?.type === "http" && shown.host === "127.0.0.1" && shown.port === proxy.port && shown.tls === false && shown.authenticated === false, shown);
  await t.call("view", "navigate", { id: "in-one", url: "http://no-such-host.invalid/through" });
  const untilText = async (id: string, text: string) => {
    for (let i = 0; i < 200; i++) {
      if ((await js(id, `document.getElementById('p')?.textContent`)) === text) return true;
      await t.sleep(20);
    }
    return false;
  };
  t.check("a page of a host that doesn't exist comes from the proxy", await untilText("in-one", "via proxy"), { proxied, at: await js("in-one", "location.href") });
  t.check("…the proxy really saw the request", proxied.some((p) => p.line.startsWith("GET http://no-such-host.invalid/through")), proxied);
  // The other sessions don't go through it.
  const count = proxied.length;
  await js("in-two", `fetch('/not-proxied').then(() => 1)`);
  await js("in-default", `fetch('/not-proxied').then(() => 1)`);
  t.check("per session: the others go direct", proxied.length === count && asked.filter((a) => a.path === "/not-proxied").length === 2, proxied);
  t.check("getProxy of the others: none", (await s("getProxy", { session: "two" })).value === null && (await s("getProxy")).value === null);
  // The app's server stays reachable, whatever the proxy.
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><p id=p>direct</p>`, { headers: { "content-type": "text/html" } }) });
  const n = proxied.length;
  await t.call("view", "navigate", { id: "in-one", url: `http://127.0.0.1:${local.port}/` });
  t.check("127.0.0.1 doesn't go through a proxy", (await untilText("in-one", "direct")) && proxied.length === n, proxied);
  local.stop(true);
  // Credentials: the proxy asks, WebKit answers with the ones given, and getProxy doesn't return them.
  wantAuth = true;
  await s("setProxy", { session: "two", proxy: { type: "http", host: "127.0.0.1", port: proxy.port, username: "me", password: "s3:cret" } });
  const withAuth = (await s("getProxy", { session: "two" })).value;
  t.check("getProxy: authenticated, no credentials", withAuth?.authenticated === true && !JSON.stringify(withAuth).includes("cret") && !("username" in withAuth), withAuth);
  await t.call("view", "navigate", { id: "in-two", url: "http://no-such-host-2.invalid/auth" });
  const authed = await untilText("in-two", "via proxy");
  t.check("proxy credentials reach the proxy", authed && proxied.some((p) => p.auth === `Basic ${btoa("me:s3:cret")}`), proxied);
  wantAuth = false;
  // SOCKS5, a real one, with its handshake.
  const socks: string[] = [];
  const socksProxy = Bun.listen<{ step: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) { socket.data = { step: 0 }; },
      data(socket, data) {
        const bytes = new Uint8Array(data);
        if (socket.data.step === 0) { socket.data.step = 1; socket.write(new Uint8Array([5, 0])); return; }
        if (socket.data.step === 1) {
          socket.data.step = 2;
          const length = bytes[4]!;
          socks.push(new TextDecoder().decode(bytes.subarray(5, 5 + length)));
          socket.write(new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const body = `<!doctype html><p id=p>via socks</p>`;
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        socket.end();
      },
    },
  });
  await s("setProxy", { session: "two", proxy: { type: "socks", host: "127.0.0.1", port: socksProxy.port } });
  await t.call("view", "navigate", { id: "in-two", url: "http://through-socks.invalid/" });
  t.check("SOCKS5: the proxy saw the host", (await untilText("in-two", "via socks")) && socks.includes("through-socks.invalid"), socks);
  // null: back to the system's.
  t.check("setProxy null", (await s("setProxy", { session: "one", proxy: null })).ok && (await s("getProxy", { session: "one" })).value === null);
  await s("setProxy", { session: "two", proxy: null });
  const m = proxied.length;
  await t.call("view", "navigate", { id: "in-one", url: `${site}/after-proxy` });
  t.check("…the next request goes direct", (await untilText("in-one", "/after-proxy")) && proxied.length === m, proxied);
  // The default session too.
  await s("setProxy", { proxy: { type: "http", host: "127.0.0.1", port: proxy.port } });
  await t.call("view", "navigate", { id: "in-default", url: "http://default-proxied.invalid/" });
  t.check("setProxy on the default session", (await untilText("in-default", "via proxy")) && proxied.some((p) => p.line.includes("default-proxied.invalid")), proxied);
  await s("setProxy", { proxy: null });
  proxy.stop(true);
  socksProxy.stop(true);

  // ---- removal ------------------------------------------------------------------------
  t.check("remove while a view uses it → unavailable", (await s("remove", { session: "one" })).error?.code === "unavailable");
  await t.call("view", "destroy", { id: "in-one" });
  t.check("remove once it's closed", (await s("remove", { session: "one" })).ok);
  t.check("…it's gone", !(await s("list")).value.some((x: any) => x.id === "one") && (await s("cookiesGet", { session: "one" })).error?.code === "invalid_args");
  t.check("…a view can't take it", (await t.call("view", "create", { id: "late", url: `${site}/`, session: "one", bounds: { x: 0, y: 0, width: 10, height: 10 } })).error?.code === "invalid_args");
  await s("create", { id: "one", persistent: false });
  t.check("the same id again starts empty", (await s("cookiesGet", { session: "one", url: `${site}/` })).value?.length === 0);
  await t.call("view", "destroy", { id: "in-two" });
  await t.call("popover", "destroy", { id: "pop" });
  t.check("remove two once its popover is gone too", (await s("remove", { session: "two" })).ok);

  // A persistent session keeps its cookies, and removing it deletes them. (Across a relaunch: below.)
  await open("on-disk", `${site}/disk`, { session: "disk" });
  await js("on-disk", `fetch('/set?who=disk').then(() => 1)`);
  await js("on-disk", `localStorage.setItem('kept', 'disk'); 1`);
  const dataHome = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/dev.kitop.harness`;
  const folder = `${dataHome}/sessions/${createHash("sha256").update("dev.kitop.harness/disk").digest("hex")}`;
  await t.sleep(300);
  t.check("a persistent session has its folder", existsSync(`${folder}/cookies.sqlite`), existsSync(folder) ? readdirSync(folder) : folder);
  await t.call("view", "destroy", { id: "on-disk" });
  t.check("remove: persistent", (await s("remove", { session: "disk" })).ok);
  t.check("…its folder is gone", !existsSync(folder));
  t.check("…recreated, it starts empty", (await s("create", { id: "disk", persistent: true })).ok && (await s("cookiesGet", { session: "disk", url: `${site}/` })).value?.length === 0);
  await s("remove", { session: "disk" });

  await t.call("view", "destroy", { id: "in-default" });
  server.stop(true);

  // ---- across a relaunch: two more processes, sharing their data ----------------------
  const home = mkdtempSync(`${tmpdir()}/kitop-relaunch-`);
  const harness = new URL("../harness.ts", import.meta.url).pathname, helper = new URL("./_cookies-restart.ts", import.meta.url).pathname;
  const run = async (phase: string, extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, harness, helper], { env: { ...process.env, XDG_DATA_HOME: `${home}/data`, XDG_CACHE_HOME: `${home}/cache`, PHASE: phase, ...extra }, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    const failed = out.split("\n").filter((l) => l.includes('"pass":false'));
    return { summary: out.split("\n").find((l) => l.includes('"summary"')), failed };
  };
  const first = await run("1");
  t.check("first run: cookies set", first.summary?.includes('"failed":0') && !first.summary.includes('"passed":0'), first);
  const second = await run("2");
  t.check("second run: what expires later is still there, in the default and a persistent session", second.summary?.includes('"failed":0') && !second.summary.includes('"passed":0'), second);
  const dev = await run("dev", { KITOP_DEV: "1" });
  t.check("under Vite there is no gate: a session opens without its cookie", dev.summary?.includes('"failed":0') && !dev.summary.includes('"passed":0'), dev);
};
