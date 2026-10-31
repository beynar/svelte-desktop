import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const loaded = t.waitEvent("viewLoaded", 6000);
  const c = await t.call("view", "create", { id: "side", route: "/?in=view", bounds: { x: 10, y: 20, width: 200, height: 150 }, autoresize: "height" });
  t.check("create", c.ok && c.value.id === "side" && c.value.windowId === 0, c);
  t.check("viewLoaded", (await loaded)?.id === "side");
  const gb = (await t.call("view", "getBounds", { id: "side" })).value;
  t.check("getBounds (top-left CSS px)", gb.x === 10 && gb.y === 20 && gb.width === 200 && gb.height === 150, gb);
  t.check("setBounds", (await t.call("view", "setBounds", { id: "side", x: 30, y: 40, width: 220, height: 160 })).ok && (await t.call("view", "getBounds", { id: "side" })).value.x === 30);
  const js = await t.call("view", "executeJavaScript", { id: "side", code: "location.search + ':' + (typeof window.__shell)" });
  t.check("executeJavaScript in the view (bridge injected)", js.value === "?in=view:object", js);
  const viaBridge = await t.call("view", "executeJavaScript", { id: "side", code: "pcall('app','getName')" });
  t.check("app-origin view page can call the platform API", (viaBridge.value as any)?.ok === true, viaBridge);
  const nav = t.waitEvent("viewLoaded", 6000);
  t.check("navigate to data: URL (any origin loads)", (await t.call("view", "navigate", { id: "side", url: "data:text/html,<title>ext</title><p>external</p>" })).ok);
  await nav;
  const ext = await t.call("view", "executeJavaScript", { id: "side", code: "new Promise(r => { if (!window.__shell) return r('no-bridge'); const s = window.__shell; s.setSink((n, d) => n === 'platformResult' && r(d.ok ? 'allowed' : d.error.code)); s.post({ id: 1, service: 'app', op: 'getName', args: {} }); setTimeout(() => r('no-reply'), 1500); })" });
  t.check("non-app-origin content cannot call native", ext.value === "no-bridge" || ext.value === "denied" || ext.value === "no-reply", ext);
  t.check("getInfo title", (await t.call("view", "getInfo", { id: "side" })).value.title === "ext");
  t.check("hide/show", (await t.call("view", "hide", { id: "side" })).ok && (await t.call("view", "getInfo", { id: "side" })).value.hidden === true && (await t.call("view", "show", { id: "side" })).ok);
  t.check("list", (await t.call("view", "list")).value.length === 1);
  t.check("bad bounds → invalid_args", (await t.call("view", "create", { url: "about:blank" })).error?.code === "invalid_args");
  t.check("destroy", (await t.call("view", "destroy", { id: "side" })).ok && (await t.call("view", "list")).value.length === 0);
  t.check("unknown id → invalid_args", (await t.call("view", "show", { id: "side" })).error?.code === "invalid_args");
  t.check("page bridge: view.list", ((await t.pageCall("view", "list")) as any).ok);
};
