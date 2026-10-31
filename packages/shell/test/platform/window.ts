import type { Harness } from "../harness-worker.ts";

const near = (a: number, b: number) => Math.abs(a - b) <= 2;

export default async (t: Harness) => {
  const list = await t.call("window", "list");
  t.check("list has primary as windowId 0", list.ok && list.value[0]?.windowId === 0 && list.value[0].label === "main", list.value);
  t.check("get by label", (await t.call("window", "get", { label: "main" })).value?.windowId === 0);
  t.check("get unknown → null", (await t.call("window", "get", { label: "zzz" })).value === null);

  t.check("setTitle/getTitle", (await t.call("window", "setTitle", { title: "Hi ✓" })).ok && (await t.call("window", "getTitle")).value === "Hi ✓");
  t.check("setBounds", (await t.call("window", "setBounds", { x: 120, y: 140, width: 700, height: 450 })).ok);
  await t.sleep(50);
  const b = (await t.call("window", "getBounds")).value;
  t.check("getBounds roundtrip (top-left)", near(b.bounds.x, 120) && near(b.bounds.y, 140) && near(b.bounds.width, 700) && near(b.bounds.height, 450) && b.state === "normal", b);
  t.check("boundsChanged event fired", (t.events.get("boundsChanged") ?? []).length > 0);
  t.check("setSize (content)", (await t.call("window", "setSize", { width: 640, height: 400 })).ok);
  const s = (await t.call("window", "getSize")).value;
  t.check("getSize roundtrip", near(s.width, 640) && near(s.height, 400), s);
  const outer = (await t.call("window", "outerSize")).value;
  t.check("outerSize ≥ innerSize", outer.height >= s.height, { outer, s });
  t.check("setPosition", (await t.call("window", "setPosition", { x: 200, y: 160 })).ok);
  const p = (await t.call("window", "getPosition")).value;
  t.check("getPosition roundtrip", near(p.x, 200) && near(p.y, 160), p);
  t.check("innerPosition below outer (titlebar)", (await t.call("window", "innerPosition")).value.y > p.y);
  t.check("center", (await t.call("window", "center")).ok);
  t.check("positionTo cursorTopLeft", (await t.call("window", "positionTo", { preset: "cursorTopLeft" })).ok);
  t.check("positionTo trayCenter w/o tray → unavailable", (await t.call("window", "positionTo", { preset: "trayCenter" })).error?.code === "unavailable");
  t.check("positionTo bad → invalid_args", (await t.call("window", "positionTo", { preset: "x" })).error?.code === "invalid_args");
  t.check("setMinSize", (await t.call("window", "setMinSize", { width: 300, height: 200 })).ok);
  t.check("setMaxSize", (await t.call("window", "setMaxSize", { width: 1600, height: 1200 })).ok);
  t.check("setMaxSize clear", (await t.call("window", "setMaxSize", { width: 0, height: 0 })).ok);
  t.check("getScaleFactor", (await t.call("window", "getScaleFactor")).value >= 1);
  const ctl = (await t.call("window", "controlsArea")).value;
  t.check("controlsArea traffic lights on the left", ctl && ctl.side === "left" && ctl.buttons.close?.visible && ctl.x < 40, ctl);

  t.check("maximize", (await t.call("window", "maximize")).value?.maximized === true);
  t.check("isMaximized", (await t.call("window", "isMaximized")).value === true);
  t.check("getBounds state maximized", (await t.call("window", "getBounds")).value.state === "maximized");
  t.check("unmaximize", (await t.call("window", "unmaximize")).value?.maximized === false);
  t.check("toggleMaximize ×2", (await t.call("window", "toggleMaximize")).value.maximized === true && (await t.call("window", "toggleMaximize")).value.maximized === false);

  t.check("minimize", (await t.call("window", "minimize")).ok);
  await t.sleep(700);
  t.check("isMinimized", (await t.call("window", "isMinimized")).value?.minimized === true);
  t.check("unminimize", (await t.call("window", "unminimize")).ok);
  await t.sleep(700);
  t.check("isMinimized false", (await t.call("window", "isMinimized")).value?.minimized === false);

  t.check("setOpacity/getOpacity", (await t.call("window", "setOpacity", { opacity: 0.5 })).ok && near((await t.call("window", "getOpacity")).value.opacity * 100, 50));
  await t.call("window", "setOpacity", { opacity: 1 });
  for (const [set, get, key] of [["setResizable", "isResizable", "resizable"], ["setClosable", "isClosable", "closable"], ["setMinimizable", "isMinimizable", "minimizable"], ["setMaximizable", "isMaximizable", "maximizable"], ["setIgnoresMouseEvents", "ignoresMouseEvents", "ignored"]] as const) {
    const on = !(key === "ignored" || key === "contentProtected");
    await t.call("window", set, { enabled: !on });
    const flipped = (await t.call("window", get)).value[key] === !on;
    await t.call("window", set, { enabled: on });
    t.check(`${set}/${get} roundtrip`, flipped && (await t.call("window", get)).value[key] === on);
  }
  t.check("setContentProtected on", (await t.call("window", "setContentProtected", { enabled: true })).ok && (await t.call("window", "isContentProtected")).value.contentProtected === true);
  const unprotect = await t.call("window", "setContentProtected", { enabled: false });
  t.check("setContentProtected off → ok or honest unsupported (macOS 26 keeps it)", unprotect.ok || unprotect.error?.code === "unsupported", unprotect);
  t.check("setDocumentEdited/isDocumentEdited", (await t.call("window", "setDocumentEdited", { edited: true })).ok && (await t.call("window", "isDocumentEdited")).value.edited === true);
  await t.call("window", "setDocumentEdited", { edited: false });
  for (const style of ["transparent", "hidden", "hiddenInset", "default"]) t.check(`setTitleBarStyle ${style}`, (await t.call("window", "setTitleBarStyle", { style })).ok);
  for (const theme of ["dark", "light", "system"]) t.check(`setTheme ${theme}`, (await t.call("window", "setTheme", { theme })).ok);
  for (const op of ["setAlwaysOnTop", "setHasShadow", "setMovable", "setMovableByWindowBackground", "setVisibleOnAllWorkspaces"]) {
    t.check(`${op} on/off`, (await t.call("window", op, { enabled: op !== "setHasShadow" && op !== "setMovable" })).ok && (await t.call("window", op, { enabled: op === "setHasShadow" || op === "setMovable" })).ok);
  }
  t.check("invalidateShadow", (await t.call("window", "invalidateShadow")).ok);
  t.check("setRepresentedFilename", (await t.call("window", "setRepresentedFilename", { path: "/etc/hosts" })).ok && (await t.call("window", "setRepresentedFilename", { path: null })).ok);
  t.check("setSimpleFullscreen on/off", (await t.call("window", "setSimpleFullscreen", { enabled: true })).ok && (await t.call("window", "isSimpleFullscreen")).value.simpleFullscreen === true && (await t.call("window", "setSimpleFullscreen", { enabled: false })).ok);
  t.check("isOccluded is boolean", typeof (await t.call("window", "isOccluded")).value === "boolean");
  t.check("isHovered shape", typeof (await t.call("window", "isHovered")).value.hovered === "boolean");
  t.check("getCursorPoint", Number.isFinite((await t.call("window", "getCursorPoint")).value.x));
  t.check("setFocusable → unsupported", (await t.call("window", "setFocusable", { enabled: false })).error?.code === "unsupported");
  t.check("focus", (await t.call("window", "focus")).ok);
  t.check("hide/show", (await t.call("window", "hide")).ok && (await t.call("window", "show")).ok);
  t.check("unknown windowId → invalid_args", (await t.call("window", "getTitle", { windowId: 999 })).error?.code === "invalid_args");

  // multi-window + events + veto
  const created = t.waitEvent("created");
  const w2 = await t.call("window", "create", { label: "second", title: "Second", width: 400, height: 300, path: "/" });
  t.check("create", w2.ok && w2.value.windowId > 0 && w2.value.label === "second", w2);
  t.check("created event", (await created)?.label === "second");
  t.check("duplicate label → invalid_args", (await t.call("window", "create", { label: "second" })).error?.code === "invalid_args");
  t.check("list has 2", (await t.call("window", "list")).value.length === 2);
  t.check("ops by windowId", (await t.call("window", "setTitle", { title: "Renamed", windowId: w2.value.windowId })).ok && (await t.call("window", "getTitle", { windowId: w2.value.windowId })).value === "Renamed");
  t.check("arm veto", (await t.call("window", "setCloseVeto", { enabled: true, windowId: w2.value.windowId })).value?.armed === true);
  const will = t.waitEvent("willClose");
  t.native.shell_window_close(w2.value.windowId); // OS-style close (performClose)
  t.check("veto → willClose, window stays", (await will)?.windowId === w2.value.windowId && (await t.call("window", "list")).value.length === 2);
  const closed = t.waitEvent("closed");
  t.check("close op bypasses veto", (await t.call("window", "close", { windowId: w2.value.windowId })).ok);
  t.check("closed event", (await closed)?.windowId === w2.value.windowId);
  await t.sleep(100);
  t.check("list back to 1", (await t.call("window", "list")).value.length === 1);
  t.check("page bridge: window.getTitle resolves caller window", (await t.pageCall("window", "getTitle") as any).value === "Hi ✓");
  t.skip("setFullscreen / showCharacterPalette / setCursorPosition / setCursorHidden / requestAttention", "Space transition or moves the user's cursor");
};
