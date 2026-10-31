import { expect, test } from "bun:test";
import { resolveConfig } from "../config.ts";
import { nsisScript, toastActivatorClsid } from "./package-windows.ts";

test("NSIS: Start Menu shortcut named after the app (shell.dll stamps its AUMID), uninstall drops the toast identity", () => {
  const c = resolveConfig("/tmp", { appName: "Notes", identifier: "dev.x.notes" });
  const nsi = nsisScript(c, { exe: "Notes.exe", srcDir: "/app", outFile: "/dist/setup.exe", icon: null, arch: "x64" });
  expect(nsi).toContain('CreateShortCut "$SMPROGRAMS\\Notes.lnk" "$INSTDIR\\Notes.exe"');
  const uninstall = nsi.slice(nsi.indexOf('Section "Uninstall"'));
  expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\AppUserModelId\\dev.x.notes"');
  expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\CLSID\\{2FEC2A0B-0875-50E0-A3DC-33BF5FC4FB59}"');
});

test("toast activator CLSID: deterministic, matches notif::activator_clsid (native/portable/notifications.hpp)", () => {
  // Vectors printed by the C++ implementation (clang++ -I native/portable).
  expect(toastActivatorClsid("dev.x.notes")).toBe("{2FEC2A0B-0875-50E0-A3DC-33BF5FC4FB59}");
  expect(toastActivatorClsid("dev.svelte-desktop.app")).toBe("{1B907501-B9FF-56F2-957D-A2EF0C589523}");
  expect(toastActivatorClsid("é.unicode")).toBe("{ECAA53E6-6091-576B-B693-D87616A5BF58}");
  expect(toastActivatorClsid("dev.x.notes")).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
});
