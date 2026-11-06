// dialog.sheet on Linux: a route of the app in a transient modal window, with real pages from this suite's own
// server, read back from the X server (xprop, xdotool) and answered with real clicks and keys under openbox.
import { cstr } from "../../src/ffi.ts";
import type { Harness } from "../harness-worker.ts";

const run = (...args: string[]) => Bun.spawnSync(args).stdout.toString().trim();
const xdotool = (...args: string[]) => run("xdotool", ...args);
const prop = (id: string, name: string) => run("xprop", "-id", id, name);
// xwininfo, not xdotool: xdotool counts the title bar twice under a reparenting window manager.
const geometry = (id: string) => {
  const info = run("xwininfo", "-id", id), n = (label: string) => Number(info.match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1]);
  return { X: n("Absolute upper-left X"), Y: n("Absolute upper-left Y"), WIDTH: n("Width"), HEIGHT: n("Height") };
};
const near = (a: number, b: number, by = 3) => Math.abs(a - b) <= by;

export default async (t: Harness) => {
  const requests: { path: string; view: string | null }[] = [];
  const reports: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/report") {
        reports.push(await req.json());
        return new Response("ok");
      }
      requests.push({ path: url.pathname + url.search, view: req.headers.get("x-desktop-view") });
      if (url.pathname === "/slow") await Bun.sleep(3000);
      const title = url.searchParams.get("t") ?? "the sheet";
      return new Response(
        `<!doctype html><title>${title}</title><style>html,body{margin:0;height:100%}button{width:100%;height:100%}</style><button id=b autofocus>Choose</button>
<script>
  const pending = new Map(); let next = 1;
  window.__shell.setSink((name, data) => { if (name === 'platformResult') { pending.get(data.id)?.(data); pending.delete(data.id); } });
  const pcall = (service, op, args = {}) => new Promise((res) => { const n = next++; pending.set(n, res); window.__shell.post({ id: n, service, op, args }); });
  const report = (value) => fetch('/report', { method: 'POST', body: JSON.stringify(value) });
  report({ loaded: location.pathname, view: window.__desktopView });
  document.getElementById('b').addEventListener('click', () => pcall('dialog', 'close', { result: { picked: 42 } }));
  addEventListener('keydown', (e) => report({ key: e.key }));
  addEventListener('load', () => setTimeout(() => report({ focused: document.activeElement?.id }), 100));
</script>`,
        { headers: { "content-type": "text/html", "cache-control": "no-store" } },
      );
    },
  });
  const appOrigin = (await t.page<string>("return location.origin"));
  t.native.shell_set_app_origin(cstr(`http://127.0.0.1:${server.port}`));
  const sheet = (route: string, options: Record<string, unknown> = {}) => t.call("dialog", "sheet", { route, ...options });
  const until = async (ok: () => unknown, ms = 4000) => {
    for (let i = 0; i < ms / 50; i++) {
      if (await ok()) return true;
      await t.sleep(50);
    }
    return false;
  };
  const find = (name: string) => xdotool("search", "--onlyvisible", "--name", `^${name}$`).split("\n").filter(Boolean).pop() ?? "";
  // t.call gives up after 8 s: the sheets here are answered before.
  await t.page("window.__downs = 0; addEventListener('mousedown', () => window.__downs++); return 1");
  const parent = find("platform harness");
  t.check("the parent window is found", !!parent);
  const main = geometry(parent);

  t.check("dialog.close outside a sheet → invalid_args", (await t.call("dialog", "close", { result: 1 })).error?.code === "invalid_args");
  t.check("dialog.sheet without a route → invalid_args", (await t.call("dialog", "sheet", {})).error?.code === "invalid_args");

  // ---- the default style: its page, modal on the parent, a real click closes it ------------
  let open = sheet("/pick?t=the sheet");
  t.check("it appears once loaded", await until(() => find("the sheet")));
  const id = find("the sheet");
  const g = geometry(id);
  t.check("its page alone: X-Desktop-View on the request", requests.find((r) => r.path.startsWith("/pick"))?.view?.startsWith("sheet-"), requests);
  t.check("… and window.__desktopView in the page", await until(() => reports.some((r) => r.loaded === "/pick" && r.view?.startsWith("sheet-"))), reports);
  t.check("transient for the window that opened it", prop(id, "WM_TRANSIENT_FOR").includes(`0x${Number(parent).toString(16)}`), { transient: prop(id, "WM_TRANSIENT_FOR"), parent });
  t.check("a modal dialog to the window manager", prop(id, "_NET_WM_STATE").includes("_NET_WM_STATE_MODAL") && prop(id, "_NET_WM_WINDOW_TYPE").includes("_NET_WM_WINDOW_TYPE_DIALOG"), { state: prop(id, "_NET_WM_STATE"), type: prop(id, "_NET_WM_WINDOW_TYPE") });
  t.check("the default size", g.WIDTH === 440 && g.HEIGHT === 280, g);
  t.check("centered on the parent", near(g.X + g.WIDTH / 2, main.X + main.WIDTH / 2, 40) && near(g.Y + g.HEIGHT / 2, main.Y + main.HEIGHT / 2, 40), { g, main });
  t.check("the page's autofocus took", await until(() => reports.some((r) => r.focused === "b")), reports);
  // Where the parent shows around it: nothing gets through to its page.
  xdotool("mousemove", String(main.X + 5), String(main.Y + 5), "click", "1");
  await t.sleep(300);
  t.check("the parent can't be clicked", (await t.page("return window.__downs")) === 0, await t.page("return window.__downs"));
  xdotool("mousemove", String(g.X + 100), String(g.Y + 100), "click", "1");
  const closed = await open;
  t.check("a real click in its page: dialog.close, the opener has the result", closed.ok && closed.value?.result?.picked === 42, closed);
  t.check("… and it's gone", await until(() => !find("the sheet")));
  await t.sleep(300);
  xdotool("mousemove", String(main.X + 30), String(main.Y + 30), "click", "1");
  t.check("the parent takes clicks again", await until(async () => (await t.page("return window.__downs")) === 1));

  // ---- Escape, before the page has it ----------------------------------------------------
  reports.length = 0;
  open = sheet("/esc?t=escape me");
  await until(() => find("escape me"));
  await until(() => reports.some((r) => r.focused === "b"));
  xdotool("key", "--clearmodifiers", "Escape");
  const canceled = await open;
  t.check("Escape cancels: result null", canceled.ok && canceled.value?.result === null, canceled);
  t.check("… and the page didn't get the key", !reports.some((r) => r.key === "Escape"), reports);

  // ---- attached: under the content's top, or `top` px down ---------------------------------
  open = sheet("/top?t=attached", { style: "attached", width: 300, height: 200, top: 40 });
  await until(() => find("attached"));
  await t.sleep(300);
  const a = geometry(find("attached")), content = (await t.call("window", "getBounds")).value;
  t.check("attached: its size", a.WIDTH === 300 && a.HEIGHT === 200, a);
  t.check("attached: `top` px down the content, centered", near(a.Y, main.Y + 40, 4) && near(a.X + 150, main.X + main.WIDTH / 2), { a, main, content });
  t.check("attached: no frame of its own", prop(find("attached"), "_NET_FRAME_EXTENTS").match(/= 0, 0, 0, 0/) || prop(find("attached"), "_NET_FRAME_EXTENTS").includes("not found"), prop(find("attached"), "_NET_FRAME_EXTENTS"));
  xdotool("key", "--clearmodifiers", "Escape");
  await open;

  // ---- window: a title bar, and its close button cancels -----------------------------------
  open = sheet("/win?t=from the page", { style: "window", title: "Pick one", width: 360, height: 220 });
  t.check("window: the title given, not the page's", await until(() => find("Pick one")) && !find("from the page"));
  const framed = prop(find("Pick one"), "_NET_FRAME_EXTENTS");
  t.check("window: a real frame", /= \d+, \d+, [1-9]/.test(framed), framed);
  xdotool("key", "--clearmodifiers", "alt+F4"); // openbox closes the active window
  const closedByWm = await open;
  t.check("window: closing it cancels", closedByWm.ok && closedByWm.value?.result === null, closedByWm);
  open = sheet("/win2?t=the page's title", { style: "window", width: 360, height: 220 });
  t.check("window: no title given, the page's", await until(() => find("the page's title")));
  xdotool("key", "--clearmodifiers", "Escape");
  await open;

  // ---- a page that takes long shows anyway, and other windows of the app stay usable --------
  let openedAt = Date.now();
  open = sheet("/slow?t=slow");
  t.check("a slow page: shown after 1.5 s, not at its end", await until(async () => xdotool("search", "--onlyvisible", "--class", ".").length > 0 && (Date.now() - openedAt) > 1400, 2500));
  await until(() => requests.some((r) => r.path.startsWith("/slow")));
  await t.sleep(2200);
  xdotool("key", "--clearmodifiers", "Escape");
  await open;

  const other = (await t.call("window", "create", { label: "other", url: `${appOrigin}/?other`, width: 300, height: 200, x: 20, y: 20, title: "other window" })).value;
  await until(() => find("other window"));
  await t.sleep(400);
  await t.call("webview", "executeJavaScript", { windowId: other.windowId, code: "window.__downs = 0; addEventListener('mousedown', () => window.__downs++); 1" });
  open = sheet("/blocker?t=blocks one", { windowId: 0 });
  await until(() => find("blocks one"));
  await t.sleep(300);
  const o = geometry(find("other window"));
  xdotool("mousemove", String(o.X + 50), String(o.Y + 50), "click", "1");
  await t.sleep(300);
  t.check("only its parent is blocked: another window of the app takes a click", (await t.call("webview", "executeJavaScript", { windowId: other.windowId, code: "window.__downs" })).value === 1);
  xdotool("windowactivate", "--sync", find("blocks one"));
  xdotool("key", "--clearmodifiers", "Escape");
  await open;

  // ---- the parent goes first -------------------------------------------------------------
  open = sheet("/orphan?t=orphan", { windowId: other.windowId });
  await until(() => find("orphan"));
  t.check("on another window: transient for it", prop(find("orphan"), "WM_TRANSIENT_FOR").includes(`0x${Number(find("other window")).toString(16)}`));
  await t.call("window", "close", { windowId: other.windowId, force: true });
  const orphaned = await open;
  t.check("its parent closes: it goes too, the opener gets null", orphaned.ok && orphaned.value?.result === null, orphaned);
  t.check("… and the window is gone", await until(() => !find("orphan")));

  // ---- no visible window to sit on: on its own, not modal to anything ----------------------
  await t.call("window", "hide");
  await t.sleep(200);
  open = sheet("/alone?t=on its own");
  t.check("the opener's window hidden: it opens anyway", await until(() => find("on its own")));
  t.check("… transient for nothing", !prop(find("on its own"), "WM_TRANSIENT_FOR").includes("0x") && !prop(find("on its own"), "_NET_WM_STATE").includes("MODAL"), prop(find("on its own"), "WM_TRANSIENT_FOR"));
  xdotool("windowactivate", "--sync", find("on its own"));
  xdotool("key", "--clearmodifiers", "Escape");
  await open;
  await t.call("window", "show");
  await t.sleep(200);

  t.native.shell_set_app_origin(cstr(appOrigin));
  server.stop(true);
  t.check("the app goes on", (await t.page("return 2 + 2")) === 4);
};
