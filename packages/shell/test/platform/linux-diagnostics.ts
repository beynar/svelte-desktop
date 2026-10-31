// diagnostics.info and capabilities.describe on Linux.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const info = await t.call("diagnostics", "info");
  const v = info.value ?? {};
  t.check("diagnostics.info pid = this process", info.ok && v.pid === process.pid, info);
  t.check("diagnostics.info uptimeSeconds > 0 and plausible", typeof v.uptimeSeconds === "number" && v.uptimeSeconds > 0 && v.uptimeSeconds < 3600, v.uptimeSeconds);
  t.check("diagnostics.info os/family/arch/renderer", v.os === "linux" && v.family === "unix" && ["aarch64", "x86_64"].includes(v.arch) && v.renderer === "webkitgtk" && /^2\.\d+\.\d+$/.test(v.rendererVersion), v);
  t.check("diagnostics.info osVersion / gtkVersion", typeof v.osVersion === "string" && v.osVersion.length > 0 && /^3\./.test(v.gtkVersion), v);
  const caps = await t.call("capabilities", "describe");
  const c = caps.value ?? {};
  t.check("capabilities.describe {platform, arch, services}", caps.ok && c.platform === "linux" && c.arch === v.arch && typeof c.services === "object", { platform: c.platform, arch: c.arch });
  const expected: Record<string, string[]> = {
    app: ["getInfo", "getPath", "quit", "relaunch", "exit", "requestSingleInstanceLock", "getBundleType"],
    window: ["getBounds", "setBounds", "setSize", "getSize", "setPosition", "getPosition", "center", "setTitle", "getTitle", "minimize", "maximize", "unmaximize", "isMaximized", "setFullscreen", "isFullscreen", "focus", "show", "hide", "close", "setAlwaysOnTop", "setResizable", "isResizable", "setOpacity", "list", "create", "get", "eval", "setCloseVeto"],
    screen: ["getAllDisplays", "getPrimaryDisplay", "getCursorScreenPoint", "scaleFactor"],
    clipboard: ["readText", "writeText", "readHtml", "writeHtml", "readImage", "writeImage", "readPaths", "writePaths"],
    shell: ["openExternal", "openPath", "showItemInFolder", "trashItem"],
    dialog: ["showMessageBox", "showOpenDialog", "showSaveDialog"],
    theme: ["get", "set"],
    notifications: ["show", "dismiss", "getPermissionStatus", "requestPermission"],
    tray: ["set", "remove", "isSet"],
    secureStorage: ["setPassword", "getPassword", "deletePassword"],
    power: ["blockSleep", "unblockSleep"],
    webview: ["executeJavaScript", "setZoom", "getZoom", "reload", "capturePage"],
    popover: ["create", "show", "hide", "setSize", "list", "destroy"],
    events: ["emit"],
    diagnostics: ["info"],
    capabilities: ["describe"],
  };
  const missing = Object.entries(expected).flatMap(([s, ops]) => ops.filter((op) => c.services?.[s]?.[op] !== "implemented").map((op) => `${s}.${op}`));
  t.check("every op of the Linux scope is listed as implemented (libs + daemons present here)", missing.length === 0, missing);
  t.check("internal test hooks are not advertised", !c.services?.dialog?._test && !c.services?.webview?._test);
  t.check("menu / shortcuts / capture / system are advertised (svc_extra.cc)", ["setAppMenu", "popup"].every((op) => c.services?.menu?.[op] === "implemented") &&
    c.services?.shortcuts?.register === "implemented" && c.services?.capture?.captureSource === "implemented" && c.services?.system?.info === "implemented");
  t.check("view is advertised (svc_view.cc)", c.services?.view?.create === "implemented" && Array.isArray((await t.call("view", "list")).value));
  const viaPage = (await t.pageCall("diagnostics", "info")) as any;
  t.check("page bridge: diagnostics.info", viaPage.ok && viaPage.value.pid === process.pid, viaPage);
};
