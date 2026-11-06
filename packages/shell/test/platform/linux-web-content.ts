// Content rules and registered scripts on WebKitGTK: a real server that doesn't receive what's blocked,
// and scripts judged by what they do in the page.
import { existsSync, readdirSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const asked = new Map<string, number>();
  let lastCookie: string | null = null;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      asked.set(path, (asked.get(path) ?? 0) + 1);
      if (path === "/cookie") {
        lastCookie = req.headers.get("cookie");
        return new Response("seen", { headers: { "cache-control": "no-store" } });
      }
      if (path === "/page") return new Response(`<!doctype html><title>site</title><div class=ad id=ad>ad</div><div id=keep>keep</div><iframe id=f src="/frame"></iframe>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
      if (path === "/frame") return new Response(`<!doctype html><title>frame</title>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
      return new Response(`<!doctype html><title>${path}</title>`, { headers: { "content-type": "text/html", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    },
  });
  const site = `http://127.0.0.2:${server.port}`, own = `http://127.0.0.1:${server.port}`;
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  const js = async (id: string, code: string) => (await wv("executeJavaScript", { viewId: id, code })).value;
  const open = async (id: string, url: string, extra: Record<string, unknown> = {}) => {
    await t.call("view", "create", { id, url, bounds: { x: 0, y: 0, width: 300, height: 200 }, ...extra });
    for (let i = 0; i < 200 && (await js(id, `location.href === ${JSON.stringify(url)} && document.readyState`)) !== "complete"; i++) await t.sleep(20);
  };
  let loads = 0;
  const go = async (id: string, to: string) => {
    const url = `${to}?${++loads}`; // a new document for sure
    await t.call("view", "navigate", { id, url });
    for (let i = 0; i < 200 && (await js(id, `location.href === ${JSON.stringify(url)} && document.readyState`)) !== "complete"; i++) await t.sleep(20);
  };
  const tryFetch = (id: string, path: string) => js(id, `fetch(${JSON.stringify(path)}).then((r) => "ok " + r.status, () => "blocked")`);
  const block = (filter: string) => ({ trigger: { "url-filter": filter }, action: { type: "block" } });

  await t.page(`document.cookie = '__kitop=gate; path=/'; return 1`);
  await t.call("sessions", "create", { id: "isolated", persistent: false });
  await open("site", `${site}/page`);
  await open("session-site", `${site}/page`, { session: "isolated" });

  // ---- validation ------------------------------------------------------------------------
  const invalid: [string, Record<string, unknown>][] = [
    ["no id", { rules: [block("x")] }], ["a long id", { id: "x".repeat(257), rules: [block("x")] }], ["no rules", { id: "a" }], ["empty rules", { id: "a", rules: [] }],
    ["a rule that isn't one", { id: "a", rules: [3] }], ["no action type", { id: "a", rules: [{ trigger: { "url-filter": "x" }, action: {} }] }], ["an unknown action", { id: "a", rules: [{ trigger: { "url-filter": "x" }, action: { type: "redirect" } }] }],
    ["what WebKit can't compile", { id: "a", rules: [{ trigger: { "url-filter": "(a|b)" }, action: { type: "block" } }] }],
    ["css with if-domain", { id: "a", rules: [{ trigger: { "url-filter": ".*", "if-domain": ["a.example"] }, action: { type: "css-display-none", selector: "p" } }] }],
    ["css with an uppercase domain", { id: "a", rules: [{ trigger: { "url-filter": ".*", "unless-domain": ["A.example"] }, action: { type: "css-display-none", selector: "p" } }] }],
  ];
  for (const [name, args] of invalid) t.check(`setContentRules: ${name} → invalid_args`, (await wv("setContentRules", args)).error?.code === "invalid_args", name);
  t.check("removeContentRules: no id → invalid_args", (await wv("removeContentRules")).error?.code === "invalid_args");
  t.check("listContentRules: empty", JSON.stringify((await wv("listContentRules")).value) === "[]");

  // ---- block: the server never sees it ---------------------------------------------------
  t.check("before: it goes through", (await tryFetch("site", "/blocked-a")) === "ok 200" && asked.get("/blocked-a") === 1);
  const rules = [block("/blocked-"), block("/also-")];
  t.check("setContentRules", (await wv("setContentRules", { id: "first", rules })).ok);
  t.check("an open page: blocked", (await tryFetch("site", "/blocked-b")) === "blocked");
  t.check("…the server didn't receive it", !asked.has("/blocked-b"), [...asked]);
  t.check("what isn't named goes through", (await tryFetch("site", "/fine")) === "ok 200" && asked.get("/fine") === 1);
  t.check("a named session too, already open", (await tryFetch("session-site", "/blocked-c")) === "blocked" && !asked.has("/blocked-c"));
  await open("later", `${site}/page`);
  t.check("a view made after", (await tryFetch("later", "/blocked-d")) === "blocked" && !asked.has("/blocked-d"));
  await t.call("view", "destroy", { id: "later" });
  await open("later-session", `${site}/page`, { session: "isolated" });
  t.check("a view made after, in a session", (await tryFetch("later-session", "/also-e")) === "blocked" && !asked.has("/also-e"));
  await t.call("view", "destroy", { id: "later-session" });
  const blockedDocument = await js("site", `new Promise((resolve) => { const f = document.createElement("iframe"); f.onload = () => resolve("loaded"); f.src = "/blocked-frame"; document.body.append(f); setTimeout(() => resolve("waited"), 500); })`);
  t.check("a frame's document: no request", !asked.has("/blocked-frame"), { blockedDocument });
  const listed0 = (await wv("listContentRules")).value;
  t.check("listContentRules: as given", listed0.length === 1 && listed0[0].id === "first" && listed0[0].rules.length === 2 && listed0[0].rules[1].trigger["url-filter"] === "/also-" && listed0[0].rules[1].action.type === "block", listed0);

  // Where compiled lists go: only while they compile.
  const store = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/dev.kitop.harness/content-rules`;
  await t.sleep(200);
  t.check("the store directory: under the app's data, and it keeps nothing", existsSync(store) && readdirSync(store).length === 0, existsSync(store) ? readdirSync(store) : store);

  // Replacing, removing.
  t.check("the same id replaces", (await wv("setContentRules", { id: "first", rules: [block("/other-")] })).ok);
  t.check("…the old rule is gone", (await tryFetch("site", "/blocked-f")) === "ok 200" && asked.get("/blocked-f") === 1);
  t.check("…the new one holds", (await tryFetch("site", "/other-g")) === "blocked" && !asked.has("/other-g"));
  await wv("setContentRules", { id: "second", rules: [block("/second-")] });
  t.check("two lists at once", (await tryFetch("site", "/other-h")) === "blocked" && (await tryFetch("site", "/second-i")) === "blocked");
  t.check("listContentRules: by id", JSON.stringify((await wv("listContentRules")).value.map((x: any) => x.id)) === JSON.stringify(["first", "second"]));
  t.check("removeContentRules", (await wv("removeContentRules", { id: "first" })).ok && (await wv("removeContentRules", { id: "nope" })).ok);
  t.check("…it goes through again", (await tryFetch("site", "/other-j")) === "ok 200" && asked.get("/other-j") === 1);
  t.check("…the other holds", (await tryFetch("site", "/second-k")) === "blocked");
  t.check("…in a session too", (await tryFetch("session-site", "/other-k")) === "ok 200" && (await tryFetch("session-site", "/second-k2")) === "blocked");
  await wv("removeContentRules", { id: "second" });

  // The app is exempt, whatever a rule says.
  await wv("setContentRules", { id: "everything", rules: [block(".*")] });
  t.check("block everything: another site is blocked", (await tryFetch("site", "/any")) === "blocked" && !asked.has("/any"));
  const app = (await t.page("return location.origin")) as string;
  t.check("…the app's origin isn't", (await t.page(`return fetch('/').then((r) => r.status)`)) === 200, app);
  t.check("…its page keeps answering", (await t.page(`return 1 + 1`)) === 2);
  await wv("removeContentRules", { id: "everything" });

  // Other actions.
  await wv("setContentRules", { id: "css", rules: [{ trigger: { "url-filter": ".*" }, action: { type: "css-display-none", selector: ".ad" } }] });
  await go("site", `${site}/page`);
  t.check("css-display-none: hidden, for real", (await js("site", `getComputedStyle(document.getElementById("ad")).display`)) === "none");
  t.check("…the rest isn't", (await js("site", `getComputedStyle(document.getElementById("keep")).display`)) !== "none");
  await t.page(`location.reload(); return 1`);
  await t.sleep(500);
  t.check("…the app's own page isn't touched", (await t.page(`const d = document.createElement('div'); d.className = 'ad'; document.body.append(d); return getComputedStyle(d).display`)) !== "none");
  await wv("removeContentRules", { id: "css" });
  await wv("setContentRules", { id: "exempt", rules: [{ trigger: { "url-filter": ".*", "unless-domain": ["127.0.0.2"] }, action: { type: "css-display-none", selector: ".ad" } }] });
  await go("site", `${site}/page`);
  t.check("css with unless-domain: that site is left alone", (await js("site", `getComputedStyle(document.getElementById("ad")).display`)) !== "none");
  await wv("removeContentRules", { id: "exempt" });
  await js("site", `document.cookie = 'kept=1; path=/'; 1`);
  await tryFetch("site", "/cookie");
  t.check("(the cookie goes out)", lastCookie?.includes("kept=1"), lastCookie);
  await wv("setContentRules", { id: "cookies", rules: [{ trigger: { "url-filter": "/cookie" }, action: { type: "block-cookies" } }] });
  await tryFetch("site", "/cookie");
  t.check("block-cookies: the server receives none", !lastCookie, lastCookie);
  await wv("removeContentRules", { id: "cookies" });
  await wv("setContentRules", { id: "exception", rules: [block("/x-"), { trigger: { "url-filter": "/x-allowed" }, action: { type: "ignore-previous-rules" } }] });
  t.check("ignore-previous-rules", (await tryFetch("site", "/x-allowed")) === "ok 200" && (await tryFetch("site", "/x-no")) === "blocked");
  await wv("removeContentRules", { id: "exception" });

  // ---- scripts: their effect in the page --------------------------------------------------
  const invalidScripts: Record<string, unknown>[] = [
    { source: "1", world: "page", timing: "start" }, { id: "s", world: "page", timing: "start" }, { id: "s", source: "1", timing: "start" }, { id: "s", source: "1", world: "page", timing: "later" },
    { id: "s", source: "1", world: "page", timing: "end", target: 3 }, { id: "s", source: "1", world: "page", timing: "end", target: { viewId: 3 } }, { id: "s", source: "1", world: "page", timing: "end", target: { nope: "x" } },
  ];
  for (const s of invalidScripts) t.check(`registerScript ${JSON.stringify(s)} → invalid_args`, (await wv("registerScript", s)).error?.code === "invalid_args");
  t.check("unregisterScript: no id → invalid_args", (await wv("unregisterScript")).error?.code === "invalid_args");
  const startScript = { id: "start", source: `window.__start = document.readyState + ":" + !!document.body;`, world: "page", timing: "start" };
  t.check("registerScript: start", (await wv("registerScript", startScript)).ok);
  await wv("registerScript", { id: "end", source: `window.__end = !!document.getElementById("keep"); window.__endCount = (window.__endCount || 0) + 1;`, world: "page", timing: "end" });
  t.check("the document already loaded doesn't get it", (await js("site", `window.__start`)) === null);
  await go("site", `${site}/page`);
  t.check("timing start: before the document exists", (await js("site", `window.__start`)) === "loading:false", await js("site", `window.__start`));
  t.check("timing end: the document is there", (await js("site", `window.__end`)) === true);
  t.check("every future page, in a session too", await (async () => { await go("session-site", `${site}/page`); return (await js("session-site", `window.__end`)) === true; })());
  t.check("the main frame only, by default", (await js("site", `document.getElementById("f").contentWindow.__end`)) === null);
  await wv("registerScript", { id: "frames", source: `window.__everywhere = true;`, world: "page", timing: "end", mainFrameOnly: false });
  await go("site", `${site}/page`);
  t.check("mainFrameOnly false: frames too", (await js("site", `document.getElementById("f").contentWindow.__everywhere`)) === true);
  // A named world: the DOM's shared, globals aren't.
  await wv("registerScript", { id: "isolated", source: `window.__isolatedGlobal = 1; document.documentElement.dataset.isolated = typeof window.__start;`, world: "mine", timing: "end" });
  await go("site", `${site}/page`);
  t.check("a named world reaches the DOM", (await js("site", `document.documentElement.dataset.isolated`)) === "undefined", await js("site", `document.documentElement.dataset.isolated`));
  t.check("…the page can't see its globals", (await js("site", `typeof window.__isolatedGlobal`)) === "undefined");
  // Targets.
  await open("other", `${site}/`);
  await wv("registerScript", { id: "aimed", source: `window.__aimed = true;`, world: "page", timing: "start", target: { viewId: "other" } });
  await go("site", `${site}/page`);
  await go("other", `${site}/next`);
  t.check("target viewId: that view", (await js("other", `window.__aimed`)) === true);
  t.check("…no other", (await js("site", `window.__aimed`)) === null);
  await t.page(`location.reload(); return 1`);
  await t.sleep(500);
  t.check("…nor the window's page", (await t.page(`return window.__aimed === undefined`)) === true);
  await wv("registerScript", { id: "aimed-window", source: `window.__forWindow = true;`, world: "page", timing: "start", target: { windowId: 0 } });
  await t.page(`location.reload(); return 1`);
  await t.sleep(500);
  t.check("target windowId: its page", (await t.page(`return window.__forWindow === true`)) === true);
  await go("site", `${site}/page`);
  t.check("…and its views", (await js("site", `window.__forWindow`)) === true);
  t.check("…in any session", (await (async () => { await go("session-site", `${site}/page`); return js("session-site", `window.__forWindow`); })()) === true);
  await wv("unregisterScript", { id: "aimed-window" });
  // A popover: known by its id from the start.
  await wv("registerScript", { id: "aimed-popover", source: `window.__forPopover = true;`, world: "page", timing: "start", target: { popoverId: "pop" } });
  await t.call("popover", "create", { id: "pop", route: "/" });
  for (let i = 0; i < 100 && (await wv("executeJavaScript", { popoverId: "pop", code: `location.pathname === "/" && document.readyState` })).value !== "complete"; i++) await t.sleep(20);
  t.check("target popoverId: a popover made after", (await wv("executeJavaScript", { popoverId: "pop", code: `window.__forPopover` })).value === true);
  await go("site", `${site}/page`);
  t.check("…no one else", (await js("site", `window.__forPopover`)) === null);
  await t.call("popover", "destroy", { id: "pop" });
  await wv("unregisterScript", { id: "aimed-popover" });
  const listed = (await wv("listScripts")).value;
  t.check("listScripts: in order, the default filled in", JSON.stringify(listed.map((s: any) => s.id)) === JSON.stringify(["start", "end", "frames", "isolated", "aimed"]) && listed[0].mainFrameOnly === true && listed[2].mainFrameOnly === false && listed[4].target.viewId === "other", listed);
  // The same id replaces, in its place.
  await wv("registerScript", { ...startScript, source: `window.__start = "replaced";` });
  await go("site", `${site}/page`);
  t.check("the same id replaces", (await js("site", `window.__start`)) === "replaced");
  t.check("…in its place", (await wv("listScripts")).value[0].id === "start");
  t.check("unregisterScript", (await wv("unregisterScript", { id: "start" })).ok && (await wv("unregisterScript", { id: "nope" })).ok);
  await go("site", `${site}/page`);
  t.check("…the next document doesn't get it", (await js("site", `window.__start`)) === null);
  t.check("…the others stay", (await js("site", `window.__end`)) === true);
  for (const id of ["end", "frames", "isolated", "aimed"]) await wv("unregisterScript", { id });
  t.check("listScripts: empty", (await wv("listScripts")).value.length === 0);
  await go("site", `${site}/page`);
  t.check("nothing left in a page", (await js("site", `window.__end`)) === null);
  t.check("the bridge survives all of it", ((await t.pageCall("sessions", "capabilities")) as any).ok === true);
  t.check("…own origin stays: a view on the app's host", (await (async () => { await open("own", `${own}/page`); return js("own", `location.origin`); })()) === own);

  for (const id of ["own", "other", "site", "session-site"]) await t.call("view", "destroy", { id });
  await t.call("sessions", "remove", { session: "isolated" });
  server.stop(true);
};
