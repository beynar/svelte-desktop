// menu.*, shortcuts.*, capture.*, system.* on Linux (native/linux/svc_extra.cc),
// driven with real X11 key events (xdotool) under Xvfb + openbox.
import type { Harness } from "../harness-worker.ts";

const xdotool = (...args: string[]) => {
  const r = Bun.spawnSync(["xdotool", ...args]);
  return { ok: r.exitCode === 0, code: r.exitCode, err: r.stderr.toString().trim() };
};

export default async (t: Harness) => {
  // ── menu: app menu bar
  const menus = [
    { name: "&File", items: [{ label: "Hello", id: "hello", accelerator: "CmdOrCtrl+Shift+H" }, { type: "separator" }, { label: "Check", id: "check", checked: false }, { role: "quit" }] },
    { name: "Edit", items: [{ role: "copy" }, { role: "paste" }] },
  ];
  t.check("menu.setAppMenu", (await t.call("menu", "setAppMenu", { menus })).ok);
  const items = (await t.call("menu", "items")).value;
  t.check("menu.items: the tree", Array.isArray(items) && items.length === 2 && items[0].text === "&File" && items[0].submenu[0].id === "hello" && items[0].submenu[1].separator === true, items);
  const upd = await t.call("menu", "update", { id: "check", checked: true, label: "Checked" });
  const got1 = (await t.call("menu", "get", { id: "check" })).value;
  t.check("menu.update + get", upd.ok && got1?.id === "check" && got1.text === "Checked" && got1.enabled === true && got1.checked === true, got1);
  t.check("menu.update unknown id → invalid_args", (await t.call("menu", "update", { id: "nope" })).error?.code === "invalid_args");
  t.check("menu.insert / remove", (await t.call("menu", "insert", { name: "Extra", items: [{ label: "X", id: "x" }], index: 1 })).ok &&
    (await t.call("menu", "items")).value[1].text === "Extra" && (await t.call("menu", "remove", { name: "Extra" })).value.removed === true &&
    (await t.call("menu", "items")).value.length === 2);
  t.check("menu.setAppMenu bad role → invalid_args, menu kept", (await t.call("menu", "setAppMenu", { menus: [{ name: "Bad", items: [{ role: "nope" }] }] })).error?.code === "invalid_args" &&
    (await t.call("menu", "items")).value.length === 2);
  t.check("menu.setAppMenu bad accelerator → invalid_args", (await t.call("menu", "setAppMenu", { menus: [{ name: "Bad", items: [{ label: "y", accelerator: "Hyper+Q" }] }] })).error?.code === "invalid_args");
  // The accelerator fires the item in the focused window.
  await t.call("window", "focus");
  await Bun.sleep(300);
  const action = t.waitEvent("menuAction", 3000);
  const sent = xdotool("key", "--clearmodifiers", "ctrl+shift+h");
  const got = await action;
  t.check("menu accelerator (Ctrl+Shift+H, real key event) → menuAction {id: hello}", got?.id === "hello", { got, sent, active: xdotool("getactivewindow", "getwindowname") });
  t.check("menu.addRecentDocument", (await t.call("menu", "addRecentDocument", { path: "/etc/hostname" })).ok);
  t.check("menu.popup bad items → invalid_args", (await t.call("menu", "popup", { items: [{ role: "nope" }] })).error?.code === "invalid_args");
  t.check("menu.setAppMenu null → no menu bar", (await t.call("menu", "setAppMenu", { menus: null })).ok && (await t.call("menu", "items")).value.length === 0);

  // ── shortcuts: global hotkeys (XGrabKey), real key events
  const reg = await t.call("shortcuts", "register", { accelerator: "CmdOrCtrl+Shift+F9", id: "k" });
  t.check("shortcuts.register → {id}", reg.ok && reg.value.id === "k", reg);
  t.check("shortcuts.isRegistered", (await t.call("shortcuts", "isRegistered", { id: "k" })).value === true);
  t.check("shortcuts.register duplicate id → invalid_args", (await t.call("shortcuts", "register", { accelerator: "Ctrl+Alt+F10", id: "k" })).error?.code === "invalid_args");
  t.check("shortcuts.register bad accelerator → invalid_args", (await t.call("shortcuts", "register", { accelerator: "Ctrl+Nope" })).error?.code === "invalid_args");
  const pressed = t.waitEvent("shortcutPressed", 3000);
  const released = t.waitEvent("shortcutReleased", 3000);
  const sent2 = xdotool("key", "--clearmodifiers", "ctrl+shift+F9");
  const p = await pressed;
  t.check("global hotkey (xdotool Ctrl+Shift+F9) → shortcutPressed {id}", p?.id === "k", { p, sent2, display: process.env.DISPLAY });
  t.check("… and shortcutReleased", (await released)?.id === "k");
  t.check("shortcuts.unregister", (await t.call("shortcuts", "unregister", { id: "k" })).value.unregistered === true &&
    (await t.call("shortcuts", "isRegistered", { id: "k" })).value === false);
  await t.call("shortcuts", "register", { accelerator: "Super+Space", id: "a" });
  await t.call("shortcuts", "register", { accelerator: "CmdOrCtrl+Shift+F12", id: "b" });
  t.check("shortcuts.unregisterAll → {unregistered: 2}", (await t.call("shortcuts", "unregisterAll")).value.unregistered === 2);

  // ── capture (X11)
  t.check("capture.isSupported", (await t.call("capture", "isSupported")).value.supported === true);
  const sources = (await t.call("capture", "getSources")).value as any[];
  const display = sources.find((s) => s.type === "display");
  const win = sources.find((s) => s.type === "window");
  t.check("capture.getSources: a display (1920×1080 Xvfb) and windows", display?.resolution.width === 1920 && display.isMain === true && !!win, sources.slice(0, 3));
  const shot = await t.call("capture", "captureSource", { id: display.id, type: "display" });
  t.check("capture.captureSource display → PNG", shot.ok && shot.value.width === 1920 && shot.value.pngBase64.startsWith("iVBORw0KGgo"), { w: shot.value?.width, err: shot.error });
  const wshot = await t.call("capture", "captureSource", { id: win.id, type: "window" });
  t.check("capture.captureSource window → PNG", wshot.ok && wshot.value.width > 0 && wshot.value.pngBase64.startsWith("iVBORw0KGgo"), wshot.error);
  t.check("capture.captureSource without id → invalid_args", (await t.call("capture", "captureSource", {})).error?.code === "invalid_args");

  // ── system
  const info = (await t.call("system", "info")).value;
  t.check("system.info", info.os === "linux" && info.family === "unix" && info.session === "x11" && typeof info.arch === "string", info);
  t.check("system.getKeyboardLayout", typeof (await t.call("system", "getKeyboardLayout")).value.name === "string");
  const accent = await t.call("system", "getAccentColor");
  t.check("system.getAccentColor → rgba (Adwaita selection color)", accent.ok && accent.value.b > accent.value.r, accent);
  const a11y = (await t.call("system", "getAccessibility")).value;
  t.check("system.getAccessibility shape", typeof a11y.reduceMotion === "boolean" && typeof a11y.highContrast === "boolean", a11y);
  t.check("system.checkPermission screenRecording (X11) → granted", (await t.call("system", "checkPermission", { name: "screenRecording" })).value.status === "granted");
};
