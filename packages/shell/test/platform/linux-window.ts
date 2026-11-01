// window.* on Linux (variant of window.ts without the AppKit-only ops: traffic
// lights, titlebar styles, per-window NSAppearance, content protection, document
// edited, simple fullscreen). Runs under openbox (EWMH), so maximize / minimize /
// fullscreen and frame extents are real window-manager state.
import type { Harness } from "../harness-worker.ts";

const near = (a: number, b: number) => Math.abs(a - b) <= 2;

export default async (t: Harness) => {
  const list = await t.call("window", "list");
  t.check("list has primary as windowId 0", list.ok && list.value[0]?.windowId === 0 && list.value[0].label === "main", list.value);
  t.check("get by label", (await t.call("window", "get", { label: "main" })).value?.windowId === 0);
  t.check("get unknown → null", (await t.call("window", "get", { label: "zzz" })).value === null);
  const me = (await t.call("window", "getInfo")).value;
  t.check("getInfo → the calling window", me?.windowId === 0 && me.label === "main" && me.bounds?.width > 0, me);

  t.check("setTitle/getTitle", (await t.call("window", "setTitle", { title: "Hi ✓" })).ok && (await t.call("window", "getTitle")).value === "Hi ✓");
  t.check("setBounds", (await t.call("window", "setBounds", { x: 120, y: 140, width: 700, height: 450 })).ok);
  await t.sleep(50);
  const b = (await t.call("window", "getBounds")).value;
  t.check("getBounds roundtrip (frame, top-left)", near(b.bounds.x, 120) && near(b.bounds.y, 140) && near(b.bounds.width, 700) && near(b.bounds.height, 450) && b.state === "normal", b);
  t.check("boundsChanged event fired", (t.events.get("boundsChanged") ?? []).length > 0, (t.events.get("boundsChanged") ?? []).at(-1));
  t.check("setSize (content)", (await t.call("window", "setSize", { width: 640, height: 400 })).ok);
  const s = (await t.call("window", "getSize")).value;
  t.check("getSize roundtrip", near(s.width, 640) && near(s.height, 400), s);
  const outer = (await t.call("window", "outerSize")).value;
  t.check("outerSize > innerSize (WM title bar)", outer.height > s.height && outer.width >= s.width, { outer, s });
  t.check("setPosition", (await t.call("window", "setPosition", { x: 200, y: 160 })).ok);
  const p = (await t.call("window", "getPosition")).value;
  t.check("getPosition roundtrip", near(p.x, 200) && near(p.y, 160), p);
  const inner = (await t.call("window", "innerPosition")).value;
  t.check("innerPosition below outer (titlebar)", inner.y > p.y, { inner, p });
  t.check("center", (await t.call("window", "center")).ok);
  const c = (await t.call("window", "getBounds")).value.bounds;
  const wa = (await t.call("screen", "getPrimaryDisplay")).value.workArea;
  t.check("center → centered in the work area", near(c.x, wa.x + (wa.width - c.width) / 2) && Math.abs(c.y - (wa.y + (wa.height - c.height) / 2)) <= 3, { c, wa });
  t.check("positionTo cursorTopLeft", (await t.call("window", "positionTo", { preset: "cursorTopLeft" })).ok);
  t.check("positionTo trayCenter → unavailable (SNI exposes no position)", (await t.call("window", "positionTo", { preset: "trayCenter" })).error?.code === "unavailable");
  t.check("positionTo bad → invalid_args", (await t.call("window", "positionTo", { preset: "x" })).error?.code === "invalid_args");
  await t.call("window", "setBounds", { x: 100, y: 100, width: 700, height: 450 });
  t.check("setMinSize", (await t.call("window", "setMinSize", { width: 500, height: 350 })).ok);
  await t.call("window", "setSize", { width: 300, height: 200 });
  const clamped = (await t.call("window", "getSize")).value;
  t.check("min size enforced by the WM", clamped.width >= 498 && clamped.height >= 348, clamped);
  t.check("setMinSize clear", (await t.call("window", "setMinSize", { width: 0, height: 0 })).ok);
  t.check("setMaxSize", (await t.call("window", "setMaxSize", { width: 800, height: 600 })).ok);
  await t.call("window", "setSize", { width: 1200, height: 900 });
  const capped = (await t.call("window", "getSize")).value;
  t.check("max size enforced by the WM", capped.width <= 802 && capped.height <= 602, capped);
  t.check("setMaxSize clear", (await t.call("window", "setMaxSize", { width: 0, height: 0 })).ok);
  await t.call("window", "setSize", { width: 640, height: 400 });
  t.check("getScaleFactor", (await t.call("window", "getScaleFactor")).value >= 1);
  t.check("controlsArea null (server-side decorations)", (await t.call("window", "controlsArea")).value === null);

  t.check("maximize", (await t.call("window", "maximize")).value?.maximized === true);
  t.check("isMaximized", (await t.call("window", "isMaximized")).value === true);
  const mx = (await t.call("window", "getBounds")).value;
  t.check("getBounds state maximized, frame fills the work area", mx.state === "maximized" && near(mx.bounds.width, wa.width), { mx, wa });
  t.check("unmaximize", (await t.call("window", "unmaximize")).value?.maximized === false);
  t.check("toggleMaximize ×2", (await t.call("window", "toggleMaximize")).value.maximized === true && (await t.call("window", "toggleMaximize")).value.maximized === false);

  t.check("setFullscreen true", (await t.call("window", "setFullscreen", { fullscreen: true })).value?.fullscreen === true);
  const fs = (await t.call("window", "getBounds")).value;
  t.check("isFullscreen + state fullscreen + covers the screen", (await t.call("window", "isFullscreen")).value === true && fs.state === "fullscreen" && fs.bounds.width === 1920 && fs.bounds.height === 1080, fs);
  t.check("setFullscreen false", (await t.call("window", "setFullscreen", { fullscreen: false })).value?.fullscreen === false && (await t.call("window", "isFullscreen")).value === false);

  t.check("minimize", (await t.call("window", "minimize")).ok);
  t.check("isMinimized", (await t.call("window", "isMinimized")).value?.minimized === true);
  t.check("unminimize", (await t.call("window", "unminimize")).ok);
  t.check("isMinimized false", (await t.call("window", "isMinimized")).value?.minimized === false);

  t.check("setOpacity/getOpacity", (await t.call("window", "setOpacity", { opacity: 0.5 })).ok && near((await t.call("window", "getOpacity")).value.opacity * 100, 50));
  await t.call("window", "setOpacity", { opacity: 1 });
  for (const [set, get, key] of [["setResizable", "isResizable", "resizable"], ["setClosable", "isClosable", "closable"], ["setIgnoresMouseEvents", "ignoresMouseEvents", "ignored"]] as const) {
    const on = key !== "ignored";
    await t.call("window", set, { enabled: !on });
    const flipped = (await t.call("window", get)).value[key] === !on;
    await t.call("window", set, { enabled: on });
    t.check(`${set}/${get} roundtrip`, flipped && (await t.call("window", get)).value[key] === on);
  }
  for (const op of ["setAlwaysOnTop", "setAlwaysOnBottom", "setDecorations", "setSkipTaskbar", "setVisibleOnAllWorkspaces", "setFocusable", "requestAttention", "flashFrame"]) {
    const off = ["setDecorations", "setFocusable"].includes(op);
    t.check(`${op} on/off`, (await t.call("window", op, { enabled: off ? false : true })).ok && (await t.call("window", op, { enabled: off ? true : false })).ok);
  }
  // Hidden title bar: an undecorated window (the page draws its controls and drags it).
  t.check("setTitleBarStyle hidden → frameless", (await t.call("window", "setTitleBarStyle", { style: "hidden" })).ok && (await t.call("window", "getTitleBarStyle")).value?.frameless === true);
  t.check("setTitleBarStyle default → decorated", (await t.call("window", "setTitleBarStyle", { style: "default" })).ok && (await t.call("window", "getTitleBarStyle")).value?.frameless === false);
  t.check("setTitleBarStyle bogus → invalid_args", (await t.call("window", "setTitleBarStyle", { style: "bogus" })).error?.code === "invalid_args");
  for (const op of ["setTheme", "setContentProtected", "setDocumentEdited", "setSimpleFullscreen", "setRepresentedFilename", "setMinimizable", "setMaximizable", "setHasShadow", "invalidateShadow", "showCharacterPalette"])
    t.check(`${op} → unsupported`, (await t.call("window", op, { enabled: true })).error?.code === "unsupported");
  t.check("isOccluded is boolean", typeof (await t.call("window", "isOccluded")).value === "boolean");
  t.check("isHovered shape", typeof (await t.call("window", "isHovered")).value.hovered === "boolean");
  t.check("setCursorPosition + getCursorPoint", (await t.call("window", "setCursorPosition", { x: 300, y: 300 })).ok && Number.isFinite((await t.call("window", "getCursorPoint")).value.x));
  const cur = (await t.call("screen", "getCursorScreenPoint")).value;
  t.check("cursor warped (screen.getCursorScreenPoint)", cur.x === 300 && cur.y === 300, cur);
  t.check("focus", (await t.call("window", "focus")).ok);
  await t.sleep(200);
  t.check("isFocused after focus", (await t.call("window", "isFocused")).value === true);
  t.check("hide → isVisible false", (await t.call("window", "hide")).ok && (await t.call("window", "isVisible")).value === false);
  t.check("show → isVisible true", (await t.call("window", "show")).ok && (await t.call("window", "isVisible")).value === true);
  t.check("unknown windowId → invalid_args", (await t.call("window", "getTitle", { windowId: 999 })).error?.code === "invalid_args");

  // multi-window + events + veto
  const created = t.waitEvent("created");
  const w2 = await t.call("window", "create", { label: "second", title: "Second", width: 400, height: 300, path: "/", hiddenUntilReady: false });
  t.check("create", w2.ok && w2.value.windowId > 0 && w2.value.label === "second", w2);
  t.check("created event", (await created)?.label === "second");
  t.check("duplicate label → invalid_args", (await t.call("window", "create", { label: "second" })).error?.code === "invalid_args");
  t.check("list has 2", (await t.call("window", "list")).value.length === 2);
  t.check("ops by windowId", (await t.call("window", "setTitle", { title: "Renamed", windowId: w2.value.windowId })).ok && (await t.call("window", "getTitle", { windowId: w2.value.windowId })).value === "Renamed");
  await t.call("window", "focus", { windowId: w2.value.windowId });
  await t.sleep(300);
  const focusEv = t.waitEvent("focusChanged");
  await t.call("window", "focus", { windowId: 0 });
  const fe = await focusEv;
  t.check("focusChanged event (focus moves between windows)", fe && typeof fe.focused === "boolean" && "windowId" in fe, fe);
  await t.sleep(200);
  t.check("isFocused follows", (await t.call("window", "isFocused", { windowId: 0 })).value === true && (await t.call("window", "isFocused", { windowId: w2.value.windowId })).value === false);
  t.check("arm veto", (await t.call("window", "setCloseVeto", { enabled: true, windowId: w2.value.windowId })).value?.armed === true);
  const will = t.waitEvent("willClose");
  t.native.shell_window_close(w2.value.windowId); // OS-style close (delete-event)
  t.check("veto → willClose, window stays", (await will)?.windowId === w2.value.windowId && (await t.call("window", "list")).value.length === 2);
  const closed = t.waitEvent("closed");
  t.check("close op bypasses veto", (await t.call("window", "close", { windowId: w2.value.windowId })).ok);
  t.check("closed event", (await closed)?.windowId === w2.value.windowId);
  await t.sleep(100);
  t.check("list back to 1", (await t.call("window", "list")).value.length === 1);
  t.check("page bridge: window.getTitle resolves caller window", (await t.pageCall("window", "getTitle") as any).value === "Hi ✓");

  // hidden until ready: a page whose DOMContentLoaded is 1.5 s late stays unmapped until then.
  const slow = `<!doctype html><title>slow</title><script>const t0 = Date.now(); while (Date.now() - t0 < 1500);</script><p>late`;
  const w3 = await t.call("window", "create", { label: "slow", html: slow, width: 300, height: 200 });
  await t.sleep(400);
  const early = (await t.call("window", "isVisible", { windowId: w3.value.windowId })).value;
  await t.sleep(2000);
  const late = (await t.call("window", "isVisible", { windowId: w3.value.windowId })).value;
  t.check("hiddenUntilReady: invisible before DOMContentLoaded, shown after", early === false && late === true, { early, late });
  await t.call("window", "close", { windowId: w3.value.windowId });
  const w4 = await t.call("window", "create", { label: "timeout", html: slow.replace("1500", "6000"), width: 300, height: 200, readyTimeoutMs: 700 });
  await t.sleep(1200);
  t.check("readyTimeoutMs reveals a window whose page never gets ready in time", (await t.call("window", "isVisible", { windowId: w4.value.windowId })).value === true);
  await t.call("window", "close", { windowId: w4.value.windowId });
  const w5 = await t.call("window", "create", { label: "invisible", path: "/", visible: false });
  await t.sleep(800);
  t.check("visible:false stays hidden after ready", (await t.call("window", "isVisible", { windowId: w5.value.windowId })).value === false);
  await t.call("window", "close", { windowId: w5.value.windowId });
};
