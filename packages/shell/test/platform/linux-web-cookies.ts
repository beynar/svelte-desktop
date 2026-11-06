// Cookies on WebKitGTK: a real server sets them and receives them, pages write them, and what the API
// says is checked against both. Other sites are on 127.0.0.2: 127.0.0.1 is the app's.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  let lastCookie: string | null = null;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      lastCookie = path === "/see" ? req.headers.get("cookie") : lastCookie;
      if (path === "/set") {
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", "server=side; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict");
        headers.append("set-cookie", "session-only=yes; Path=/deep");
        return new Response("set", { headers });
      }
      return new Response(`<!doctype html><title>site</title>${path}`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    },
  });
  const site = `http://127.0.0.2:${server.port}`;
  const cookies = (op: string, args: Record<string, unknown> = {}) => t.call("sessions", op, args);
  const js = async (code: string) => (await t.call("webview", "executeJavaScript", { viewId: "site", code })).value;
  const seen = async () => {
    await js(`fetch('/see').then(() => 1)`);
    return lastCookie ?? "";
  };
  await t.call("view", "create", { id: "site", url: `${site}/page`, bounds: { x: 0, y: 0, width: 300, height: 200 } });
  for (let i = 0; i < 150 && (await js(`location.href === "${site}/page" && document.readyState`)) !== "complete"; i++) await t.sleep(20);

  const caps = await cookies("capabilities");
  t.check("capabilities: what Linux has", caps.value?.private === true && caps.value.persistentNamed === true && caps.value.proxy === true && caps.value.proxyAuthentication === true && caps.value.pac === false && caps.value.customBypass === false, caps);
  t.check("list: the default session, persistent", JSON.stringify((await cookies("list")).value) === JSON.stringify([{ id: "default", persistent: true }]));

  // ---- a server sets them --------------------------------------------------------
  const changes: any[] = [];
  const watched = await cookies("watchCookies", { enabled: true });
  t.check("watchCookies answers", watched.ok, watched);
  const nextChange = async (name: string, removed = false, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const all = t.events.get("sessionCookieChanged") ?? [];
      const hit = all.slice(changes.length).find((e) => e.cookie.name === name && e.removed === removed);
      if (hit) return hit;
      await t.sleep(20);
    }
    return null;
  };
  await js(`fetch('/set').then(() => 1)`);
  const event = await nextChange("server");
  t.check("sessionCookieChanged: from a server's Set-Cookie", event?.session === "default" && event.removed === false && event.cookie.httpOnly === true && event.cookie.value === "side", event);
  const got = (await cookies("cookiesGet", { url: `${site}/`, name: "server" })).value;
  t.check("cookiesGet: an HttpOnly cookie is readable", got?.length === 1 && got[0].value === "side" && got[0].httpOnly === true && got[0].secure === false, got);
  t.check("…the page can't read it", !(await js(`document.cookie`)).includes("server"));
  t.check("…its fields", got?.[0].domain === "127.0.0.2" && got[0].path === "/" && got[0].sessionOnly === false && got[0].sameSite === "Strict" && Math.abs(got[0].expires - (Date.now() / 1000 + 3600)) < 60, got);
  const deep = (await cookies("cookiesGet", { url: `${site}/deep/x`, name: "session-only" })).value;
  t.check("a session cookie has no expires", deep?.length === 1 && deep[0].sessionOnly === true && deep[0].expires === undefined, deep);
  t.check("url filter: path boundary", (await cookies("cookiesGet", { url: `${site}/deeper`, name: "session-only" })).value?.length === 0);
  t.check("url filter: another host", (await cookies("cookiesGet", { url: `http://127.0.0.3:${server.port}/`, name: "server" })).value?.length === 0);
  const every = (await cookies("cookiesGet")).value.map((c: any) => c.name);
  t.check("no filter: every cookie", every.includes("server") && every.includes("session-only"), every);

  // ---- the API sets them, a server receives them ---------------------------------
  t.check("cookiesSet", (await cookies("cookiesSet", { url: `${site}/`, name: "api", value: "one", httpOnly: true, expires: Math.floor(Date.now() / 1000) + 600, sameSite: "Lax" })).ok);
  t.check("sessionCookieChanged: from cookiesSet", (await nextChange("api"))?.cookie.value === "one");
  t.check("…the server receives it", (await seen()).includes("api=one"), lastCookie);
  t.check("…the page doesn't see it: HttpOnly", !(await js(`document.cookie`)).includes("api"));
  const api = (await cookies("cookiesGet", { url: `${site}/`, name: "api" })).value?.[0];
  t.check("…reads back", api?.httpOnly === true && api.sameSite === "Lax" && api.sessionOnly === false, api);
  const before = (t.events.get("sessionCookieChanged") ?? []).length;
  await cookies("cookiesSet", { url: `${site}/`, name: "api", value: "two", httpOnly: true, expires: Math.floor(Date.now() / 1000) + 600 });
  changes.length = before;
  t.check("an update: removed false, the new value", (await nextChange("api"))?.cookie.value === "two");
  t.check("…the server receives it", (await seen()).includes("api=two"), lastCookie);
  await cookies("cookiesSet", { url: `${site}/`, name: "pathed", value: "x", path: "/only" });
  t.check("path: not sent elsewhere", !(await seen()).includes("pathed"), lastCookie);

  // ---- a page writes one ----------------------------------------------------------
  changes.length = (t.events.get("sessionCookieChanged") ?? []).length;
  await js(`document.cookie = 'page=wrote; path=/'; 1`);
  const fromPage = await nextChange("page");
  t.check("sessionCookieChanged: from document.cookie, nothing polled", fromPage?.cookie.value === "wrote" && fromPage.cookie.httpOnly === false, fromPage);
  t.check("cookiesGet: what the page wrote", (await cookies("cookiesGet", { url: `${site}/`, name: "page" })).value?.[0]?.value === "wrote");
  changes.length = (t.events.get("sessionCookieChanged") ?? []).length;
  await js(`document.cookie = 'page=; path=/; max-age=0'; 1`);
  t.check("the page deletes it: removed true, with the old cookie", (await nextChange("page", true))?.cookie.value === "wrote");

  // ---- removal ---------------------------------------------------------------------
  changes.length = (t.events.get("sessionCookieChanged") ?? []).length;
  const removed = await cookies("cookiesRemove", { url: `${site}/`, name: "api" });
  t.check("cookiesRemove: how many, HttpOnly too", removed.value?.removed === 1, removed);
  t.check("sessionCookieChanged: removed", (await nextChange("api", true))?.cookie.value === "two");
  t.check("…the server no longer receives it", !(await seen()).includes("api="), lastCookie);
  t.check("cookiesRemove: nothing there → 0", (await cookies("cookiesRemove", { url: `${site}/`, name: "api" })).value?.removed === 0);
  t.check("an expired cookiesSet deletes", (await cookies("cookiesSet", { url: `${site}/`, name: "server", value: "x", expires: 1000 })).ok && (await cookies("cookiesGet", { url: `${site}/`, name: "server" })).value?.length === 0);
  t.check("…and the server no longer receives it", !(await seen()).includes("server="), lastCookie);

  // ---- the shell's own cookie -------------------------------------------------------
  changes.length = (t.events.get("sessionCookieChanged") ?? []).length;
  await t.page(`document.cookie = '__kitop=gate; path=/'; return 1`);
  await t.page(`document.cookie = 'visible=yes; path=/'; return 1`);
  await nextChange("visible");
  const app = (await t.page("return location.origin")) as string;
  const names = (await cookies("cookiesGet", { url: `${app}/` })).value.map((c: any) => c.name);
  t.check("__kitop isn't listed", names.includes("visible") && !names.includes("__kitop"), names);
  t.check("…nor in events", !(t.events.get("sessionCookieChanged") ?? []).some((e) => e.cookie.name === "__kitop"));
  for (const [op, args] of [["cookiesGet", { url: `${app}/`, name: "__kitop" }], ["cookiesSet", { url: `${app}/`, name: "__kitop", value: "x" }], ["cookiesRemove", { url: `${app}/`, name: "__kitop" }]] as const)
    t.check(`${op}: __kitop → denied`, (await cookies(op, args)).error?.code === "denied");
  t.check("…it's still there, for the server", ((await t.page("return document.cookie")) as string).includes("__kitop=gate"));

  // ---- what's refused ---------------------------------------------------------------
  const refused: [string, Record<string, unknown>][] = [
    ["cookiesGet", { url: "ftp://a.example/" }], ["cookiesGet", { name: 3 }], ["cookiesGet", { session: "nope" }], ["cookiesGet", { url: "nonsense" }],
    ["cookiesSet", { url: `${site}/`, name: "a" }], ["cookiesSet", { name: "a", value: "b" }], ["cookiesSet", { url: `${site}/`, name: "a=b", value: "c" }], ["cookiesSet", { url: `${site}/`, name: "a", value: "b;c" }],
    ["cookiesSet", { url: `${site}/`, name: "a", value: "b", path: "x" }], ["cookiesSet", { url: `${site}/`, name: "a", value: "b", domain: "other.example" }], ["cookiesSet", { url: `${site}/`, name: "a", value: "b", secure: true }],
    ["cookiesSet", { url: `${site}/`, name: "a", value: "b", sameSite: "None" }], ["cookiesSet", { url: `${site}/`, name: "a", value: "b", sameSite: "Odd" }], ["cookiesSet", { url: `${site}/`, name: "a", value: "b", expires: "soon" }],
    ["cookiesRemove", { name: "a" }], ["cookiesRemove", { url: `${site}/` }], ["getProxy", { session: "nope" }], ["remove", { session: "nope" }],
  ];
  for (const [op, args] of refused) t.check(`${op} ${JSON.stringify(args)} → invalid_args`, (await cookies(op, args)).error?.code === "invalid_args");
  t.check("remove: the default session → denied", (await cookies("remove", { session: "default" })).error?.code === "denied");
  t.check("a secure cookie needs https, then it's only sent there", (await cookies("cookiesSet", { url: "https://secure.example/", name: "s", value: "1", secure: true, sameSite: "None" })).ok);
  t.check("…filtered out for http", (await cookies("cookiesGet", { url: "http://secure.example/", name: "s" })).value?.length === 0 && (await cookies("cookiesGet", { url: "https://secure.example/", name: "s" })).value?.[0]?.sameSite === "None");
  t.check("a domain cookie matches subdomains", (await cookies("cookiesSet", { url: "http://a.example.org/", domain: ".example.org", name: "d", value: "1" })).ok && (await cookies("cookiesGet", { url: "http://b.example.org/", name: "d" })).value?.[0]?.domain === ".example.org");

  await t.call("view", "destroy", { id: "site" });
  server.stop(true);
};
