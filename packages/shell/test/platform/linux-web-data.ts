// clearData on WebKitGTK: real values, read back after a reload, and a real server for what it can
// see (the Cookie header, whether the HTTP cache still answers instead of it).
// Other sites are on 127.0.0.2: 127.0.0.1 and localhost count as the app's, as on macOS.
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
      if (path === "/set-cookie") return new Response("set", { headers: { "set-cookie": "server=side; Path=/; Max-Age=3600" } });
      if (path === "/see-cookie") {
        lastCookie = req.headers.get("cookie");
        return new Response(lastCookie ?? "", { headers: { "cache-control": "no-store" } });
      }
      if (path.startsWith("/cached")) return new Response("cacheable", { headers: { "cache-control": "max-age=3600", "content-type": "text/plain" } });
      if (path === "/sw.js") return new Response("self.addEventListener('fetch', () => {});", { headers: { "content-type": "text/javascript" } });
      return new Response(`<!doctype html><title>site</title>${path}`, { headers: { "content-type": "text/html" } });
    },
  });
  const site = `http://127.0.0.2:${server.port}`, own = `http://127.0.0.1:${server.port}`;
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  const inView = async (viewId: string, code: string) => {
    const r = await wv("executeJavaScript", { viewId, code });
    if (!r.ok) t.check(`script in ${viewId}`, false, r);
    return r.value;
  };
  const js = (code: string) => inView("site", code);
  const loaded = async (id: string, url: string) => {
    for (let i = 0; i < 150; i++) {
      if ((await wv("executeJavaScript", { viewId: id, code: `location.href === ${JSON.stringify(url)} && document.readyState === "complete"` })).value === true) return;
      await t.sleep(20);
    }
  };
  const reload = async (id = "site", origin = site) => {
    const url = `${origin}/page?${Date.now()}`;
    await t.call("view", "navigate", { id, url });
    await loaded(id, url);
  };
  const open = async (id: string, origin: string) => {
    await t.call("view", "create", { id, url: `${origin}/page`, bounds: { x: 0, y: 0, width: 300, height: 200 } });
    await loaded(id, `${origin}/page`);
  };
  await open("site", site);
  const fill = async () => {
    const stored = await js(`(async () => {
      localStorage.setItem('kept', 'local');
      sessionStorage.setItem('kept', 'session');
      await fetch('/set-cookie');
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('kitop', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('s');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('s', 'readwrite');
          tx.objectStore('s').put('value', 'k');
          tx.oncomplete = () => { open.result.close(); resolve(1); };
        };
      });
      await caches.open('kitop').then((c) => c.put('/in-cache', new Response('x')));
      await navigator.serviceWorker.register('/sw.js').then((r) => new Promise((resolve) => {
        const w = r.installing || r.waiting || r.active;
        if (w.state === 'activated') return resolve(1);
        w.addEventListener('statechange', () => w.state === 'activated' && resolve(1));
      }));
      return 1;
    })()`);
    t.check("the site stores its data", stored === 1, stored);
  };
  const state = async () => {
    const page = await js(`(async () => ({
      local: localStorage.getItem('kept'),
      session: sessionStorage.getItem('kept'),
      idb: await new Promise((resolve) => {
        const open = indexedDB.open('kitop', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('s');
        open.onsuccess = () => {
          const get = open.result.transaction('s').objectStore('s').get('k');
          get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
        };
      }),
      cache: await caches.has('kitop'),
      sw: (await navigator.serviceWorker.getRegistrations()).length,
    }))()`);
    await js(`fetch('/see-cookie').then(() => 1)`);
    return { ...page, cookie: lastCookie };
  };
  // The HTTP cache: a response that keeps. WebKit writes it a moment after the load.
  const cachedOnce = async (path: string) => {
    await js(`fetch('${path}').then(() => 1)`);
    await js(`fetch('${path}').then(() => 1)`);
    await t.sleep(1000);
    return asked.get(path) === 1;
  };
  const askedAgain = async (path: string) => {
    await js(`fetch('${path}').then(() => 1)`);
    return asked.get(path) === 2;
  };

  t.check("clearData: unknown type → invalid_args", (await wv("clearData", { types: ["nonsense"] })).error?.code === "invalid_args");

  await fill();
  await t.page(`localStorage.setItem('app', 'mine'); document.cookie = 'app=session; path=/; max-age=3600'; return 1`);
  await reload();
  const filled = await state();
  t.check("all of it is really there", filled.local === "local" && filled.session === "session" && filled.idb === "value" && filled.cache === true && filled.sw === 1 && filled.cookie?.includes("server=side"), filled);

  // One kind at a time: that kind goes, the others stay.
  const clear = (types: string[], app = false) => wv("clearData", { types, app });
  let reply = await clear(["localStorage"]);
  t.check("localStorage: answers the sites it cleared, not the app", reply.value?.cleared?.includes("127.0.0.2") && !reply.value.cleared.includes("127.0.0.1"), reply);
  await reload();
  let now = await state();
  t.check("localStorage: the value is gone", now.local === null, now);
  t.check("…and nothing else", now.idb === "value" && now.cookie?.includes("server=side") && now.cache === true && now.sw === 1, now);
  t.check("…and the app's stays", (await t.page("return localStorage.getItem('app')")) === "mine");

  await clear(["cookies"]);
  await reload();
  now = await state();
  t.check("cookies: the server no longer gets it", !now.cookie?.includes("server=side") && now.idb === "value", now);
  t.check("…the app's stays", ((await t.page("return document.cookie")) as string).includes("app=session"));

  await clear(["indexedDB"]);
  await reload();
  now = await state();
  t.check("indexedDB: the value is gone", now.idb === null && now.cache === true, now);

  await clear(["serviceWorkers"]);
  await reload();
  now = await state();
  t.check("serviceWorkers: no registration left", now.sw === 0 && now.cache === true, now);

  t.check("the HTTP cache answers instead of the server", await cachedOnce("/cached-one"), [...asked]);
  await clear(["cache"]);
  await reload();
  now = await state();
  t.check("cache: Cache Storage is empty", now.cache === false, now);
  t.check("cache: the server is asked again", await askedAgain("/cached-one"), [...asked]);

  await js(`sessionStorage.setItem('kept', 'session'); 1`);
  reply = await clear(["sessionStorage"]);
  await t.call("view", "destroy", { id: "site" });
  await open("site", site);
  t.check("sessionStorage: a new view finds nothing, and the op answers", reply.ok && (await js(`sessionStorage.getItem('kept')`)) === null, reply);

  // Everything, at once: the default.
  t.check("…the HTTP cache answers again", await cachedOnce("/cached-two"), [...asked]); // before a service worker comes between
  await fill();
  await reload();
  reply = await wv("clearData");
  t.check("no types: all of it", reply.value?.cleared?.includes("127.0.0.2"), reply);
  await reload();
  now = await state();
  t.check("…every kind is gone", now.local === null && now.idb === null && now.cache === false && now.sw === 0 && !now.cookie?.includes("server=side") && (await askedAgain("/cached-two")), now);
  t.check("the app's are untouched without app", (await t.page("return localStorage.getItem('app')")) === "mine" && ((await t.page("return document.cookie")) as string).includes("app=session"));

  // `app`: its storage too, its cookies never.
  // A view on the app's host, another port: what's stored there is the app's too.
  await open("own", own);
  await inView("own", `(async () => { localStorage.setItem('own', 'x'); await caches.open('kitop'); return 1 })()`);
  const ownState = () => inView("own", `(async () => ({ local: localStorage.getItem('own'), cache: await caches.has('kitop') }))()`);
  await clear(["localStorage", "cache"]);
  await reload("own", own);
  const ownKept = await ownState();
  t.check("without app: the app's host keeps what it has", ownKept.local === "x" && ownKept.cache === true, ownKept);
  await clear(["cache"], true);
  await reload("own", own);
  const ownCache = await ownState();
  t.check("app, one kind: only that kind goes", ownCache.local === "x" && ownCache.cache === false, ownCache);
  await t.call("view", "destroy", { id: "own" });
  reply = await wv("clearData", { types: ["all"], app: true });
  t.check("app: true answers the app as well", reply.value?.cleared?.includes("127.0.0.1"), reply);
  await t.page("return location.reload()");
  await t.sleep(600);
  t.check("app: true: its localStorage is gone", (await t.page("return localStorage.getItem('app')")) === null);
  t.check("…its cookie isn't: that's the session with its server", ((await t.page("return document.cookie")) as string).includes("app=session"));

  await t.call("view", "destroy", { id: "site" });
  server.stop(true);
};
