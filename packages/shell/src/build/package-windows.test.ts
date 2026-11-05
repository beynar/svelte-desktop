import { expect, test } from "bun:test";
import { resolveConfig } from "../config.ts";
import { nsisScript, toastActivatorClsid } from "./package-windows.ts";

test("NSIS: Start Menu shortcut named after the app (shell.dll stamps its AUMID), uninstall drops the toast identity", () => {
  const c = resolveConfig("/tmp", { appName: "Notes", identifier: "dev.x.notes" });
  const nsi = nsisScript(c, { exe: "Notes.exe", srcDir: "/app", outFile: "/dist/setup.exe", icon: null, arch: "x64" });
  expect(nsi).toContain('CreateShortCut "$SMPROGRAMS\\Notes.lnk" "$INSTDIR\\Notes.exe"');
  const uninstall = nsi.slice(nsi.indexOf('Section "Uninstall"'));
  expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\AppUserModelId\\dev.x.notes"');
  expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\CLSID\\{B60436AD-F930-522F-B96A-F59E6D003A64}"');
});

test("toast activator CLSID: deterministic, matches notif::activator_clsid (native/portable/notifications.hpp)", () => {
  // Vectors printed by the C++ implementation (clang++ -I native/portable).
  expect(toastActivatorClsid("dev.x.notes")).toBe("{B60436AD-F930-522F-B96A-F59E6D003A64}");
  expect(toastActivatorClsid("dev.kitop.app")).toBe("{D6750297-FF40-520A-A9C5-9146BB5B7BAB}");
  expect(toastActivatorClsid("é.unicode")).toBe("{D99B2D6B-891F-5846-A226-92BA0079939F}");
  expect(toastActivatorClsid("dev.x.notes")).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
});
