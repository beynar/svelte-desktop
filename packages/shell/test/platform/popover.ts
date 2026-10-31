import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const ready = t.waitEvent("popoverReady", 6000);
  const created = await t.call("popover", "create", { id: "pop", route: "/?in=popover", width: 300, height: 200 });
  t.check("create (popover style)", created.ok && created.value.style === "popover" && created.value.shown === false, created);
  t.check("popoverReady (pre-warmed page loaded before any show)", (await ready)?.id === "pop");
  t.check("list", (await t.call("popover", "list")).value.some((p: any) => p.id === "pop"));
  t.check("create without origin-relative route works with explicit url too", (await t.call("popover", "create", { id: "tmp", url: "about:blank" })).ok && (await t.call("popover", "destroy", { id: "tmp" })).ok);

  // Inside the popover page: injected id, bridge works, `id` defaults to the caller popover, page↔page messages.
  const msg = t.waitEvent("message");
  await t.call("popover", "eval", {
    id: "pop",
    js: `pcall('popover','get',{}).then(r => pcall('events','emit',{channel:'probe', data:{me: window.__shellPopover && window.__shellPopover.id, attr: document.documentElement.hasAttribute('data-shell-popover'), got: r}}))`,
  });
  const m = await msg;
  t.check("popover page knows its id (window.__shellPopover)", m?.data?.me === "pop", m);
  t.check("data-shell-popover attribute set", m?.data?.attr === true);
  t.check("bridge from popover page; id defaults to caller popover", m?.data?.got?.ok && m.data.got.value.id === "pop");
  t.check("events.emit from popover reaches other pages/Worker with `from`", m?.channel === "probe" && m?.from === "pop");

  const shown = t.waitEvent("popoverShown");
  const s = await t.call("popover", "show", { id: "pop", anchor: { x: 40, y: 40, width: 80, height: 24 } });
  t.check("show anchored to a page rect of the main window", s.ok, s);
  t.check("popoverShown event", (await shown)?.id === "pop");
  t.check("isShown", (await t.call("popover", "isShown", { id: "pop" })).value === true);
  t.check("setSize", (await t.call("popover", "setSize", { id: "pop", width: 360, height: 260 })).ok && (await t.call("popover", "get", { id: "pop" })).value.width === 360);
  const hidden = t.waitEvent("popoverHidden");
  t.check("hide", (await t.call("popover", "hide", { id: "pop" })).ok);
  t.check("popoverHidden event", (await hidden)?.id === "pop");
  await t.sleep(400);
  t.check("toggle → shown", (await t.call("popover", "toggle", { id: "pop", anchor: "cursor" })).value?.shown === true);
  await t.sleep(300);
  t.check("toggle → hidden", (await t.call("popover", "toggle", { id: "pop" })).value?.shown === false);
  t.check("bad anchor → invalid_args", (await t.call("popover", "show", { id: "pop", anchor: "moon" })).error?.code === "invalid_args");
  t.check("setPosition on popover style → unsupported", (await t.call("popover", "setPosition", { id: "pop", x: 1, y: 1 })).error?.code === "unsupported");

  // Tray binding: clicks toggle natively.
  await t.sleep(400);
  t.check("tray.set with popover binding", (await t.call("tray", "set", { title: "Pop", popover: "pop" })).ok);
  await t.sleep(300);
  const trayShown = t.waitEvent("popoverShown");
  await t.call("tray", "performClick");
  t.check("tray click opens bound popover", (await trayShown)?.id === "pop");
  await t.sleep(500);
  const trayHidden = t.waitEvent("popoverHidden");
  await t.call("tray", "performClick");
  t.check("second tray click closes it", (await trayHidden)?.id === "pop");
  await t.call("tray", "remove");

  // Panel style: Spotlight-like, positioned, light dismiss on losing key.
  const pready = t.waitEvent("popoverReady", 6000);
  t.check("create panel", (await t.call("popover", "create", { id: "panel", route: "/?in=panel", style: "panel", width: 480, height: 120, position: "center" })).value?.style === "panel");
  await pready;
  t.check("show panel (center)", (await t.call("popover", "show", { id: "panel" })).ok && (await t.call("popover", "isShown", { id: "panel" })).value === true);
  t.check("setPosition {x,y}", (await t.call("popover", "setPosition", { id: "panel", x: 200, y: 160 })).ok);
  t.check("setSize panel", (await t.call("popover", "setSize", { id: "panel", width: 500, height: 180 })).ok);
  t.check("panel position tray w/o tray falls back to center", (await t.call("popover", "setPosition", { id: "panel", position: "tray" })).ok);
  t.check("bad position → invalid_args", (await t.call("popover", "setPosition", { id: "panel", position: "moon" })).error?.code === "invalid_args");
  const dismissed = t.waitEvent("popoverHidden", 1500);
  await t.call("window", "focus"); // main window takes key → transient panel dismisses itself
  const gone = (await dismissed)?.id === "panel";
  // Cooperative activation (macOS 14+): an app started from a terminal without
  // user input can't activate, so no window ever becomes key and focus-based
  // dismissal can't happen. Assert only when activation is possible here.
  if ((await t.call("popover", "get", { id: "panel" })).value.appActive || gone)
    t.check("panel light-dismiss when another window takes focus", gone);
  else t.skip("panel light-dismiss on focus change", "app can't activate without user input (macOS cooperative activation)");
  await t.call("popover", "hide", { id: "panel" });

  // preload:false — nothing loads until the first show, which waits for the page.
  t.check("lazy create", (await t.call("popover", "create", { id: "lazy", route: "/?lazy", preload: false })).value?.ready === false);
  await t.sleep(400);
  t.check("lazy: not loaded before show", (await t.call("popover", "get", { id: "lazy" })).value.ready === false);
  const lazyShown = t.waitEvent("popoverShown", 4000);
  t.check("lazy show", (await t.call("popover", "show", { id: "lazy", anchor: { x: 10, y: 10, width: 20, height: 20 } })).ok);
  t.check("lazy: shown after its page is ready", (await lazyShown)?.id === "lazy" && (await t.call("popover", "get", { id: "lazy" })).value.ready === true);
  await t.call("popover", "destroy", { id: "lazy" });
  t.check("destroy", (await t.call("popover", "destroy", { id: "panel" })).ok && (await t.call("popover", "destroy", { id: "pop" })).ok);
  t.check("list empty", (await t.call("popover", "list")).value.length === 0);
  t.check("unknown id → invalid_args", (await t.call("popover", "show", { id: "pop" })).error?.code === "invalid_args");
  const pl = await t.pageCall("popover", "list");
  t.check("page bridge: popover.list", (pl as any).ok, pl);
  t.skip("Escape / click-outside dismissal of the arrow popover", "needs real input events");
};
