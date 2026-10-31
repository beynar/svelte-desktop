// diagnostics.info and capabilities.describe.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const info = await t.call("diagnostics", "info");
  const v = info.value ?? {};
  t.check("diagnostics.info pid = this process", info.ok && v.pid === process.pid, info);
  t.check("diagnostics.info uptimeSeconds > 0 and plausible", typeof v.uptimeSeconds === "number" && v.uptimeSeconds > 0 && v.uptimeSeconds < 3600, v.uptimeSeconds);
  t.check(
    "diagnostics.info os/family/arch/renderer",
    v.os === "macos" && v.family === "unix" && ["aarch64", "x86_64"].includes(v.arch) && v.renderer === "wkwebview" && /^\d+/.test(v.rendererVersion),
    v,
  );

  const caps = await t.call("capabilities", "describe");
  const c = caps.value ?? {};
  t.check("capabilities.describe {platform, arch, services}", caps.ok && c.platform === "macos" && c.arch === v.arch && typeof c.services === "object", { platform: c.platform, arch: c.arch });
  const expected: Record<string, string[]> = {
    system: ["info", "getKeyboardLayout", "getAccentColor", "getAccessibility", "checkPermission", "requestPermission", "openSettings"],
    power: ["getThermalState", "getSystemIdleTime", "getBattery", "blockSleep", "unblockSleep"],
    secureStorage: ["setPassword", "getPassword", "deletePassword", "authenticate"],
    notifications: ["show", "dismiss", "getPermissionStatus", "requestPermission"],
    deepLink: ["register"],
    tray: ["set", "remove", "isSet"],
    shortcuts: ["register", "unregister", "unregisterAll", "isRegistered"],
    diagnostics: ["info"],
    capabilities: ["describe"],
  };
  const missing = Object.entries(expected).flatMap(([s, ops]) => ops.filter((op) => !c.services?.[s]?.[op]).map((op) => `${s}.${op}`));
  t.check("capabilities lists every contract op of these services", missing.length === 0, missing);
  const bundled = !!c.services?.notifications && c.services.notifications.show === "implemented";
  t.check(
    "capabilities flags bundle-only ops when unbundled",
    bundled || (c.services?.notifications?.show === "unavailable" && c.services?.deepLink?.register === "unavailable" && c.services?.tray?.set === "implemented"),
    { notifications: c.services?.notifications, deepLink: c.services?.deepLink },
  );

  const viaPage = (await t.pageCall("diagnostics", "info")) as any;
  t.check("page bridge: diagnostics.info", viaPage.ok && viaPage.value.pid === process.pid, viaPage);
  const capsPage = (await t.pageCall("capabilities", "describe")) as any;
  t.check("page bridge: capabilities.describe", capsPage.ok && capsPage.value.platform === "macos", capsPage.ok);
};
