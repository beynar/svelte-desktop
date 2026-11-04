import { expect, test } from "bun:test";
import { infoPlist, localizedStrings } from "./package.ts";
import { resolveConfig } from "../config.ts";

test("locales: CFBundleLocalizations and an InfoPlist.strings per language, untranslated reasons kept", () => {
  const c = resolveConfig("/tmp/app", { appName: 'Notes "Pro"', identifier: "dev.x", permissions: { camera: "Scan documents" }, locales: { fr: { name: "Notes", permissions: { camera: "Scanner des documents" } }, de: {} } });
  const s = localizedStrings(c);
  expect(Object.keys(s)).toEqual(["en", "fr", "de"]);
  expect(s.fr).toContain('"CFBundleDisplayName" = "Notes";');
  expect(s.fr).toContain('"NSCameraUsageDescription" = "Scanner des documents";');
  expect(s.de).toContain('"CFBundleName" = "Notes \\"Pro\\"";');
  expect(s.de).toContain('"NSCameraUsageDescription" = "Scan documents";');
  expect(infoPlist(c, "Notes", "none")).toContain("<key>CFBundleLocalizations</key><array><string>en</string><string>fr</string><string>de</string></array>");
  expect(localizedStrings(resolveConfig("/tmp/app", { appName: "A", identifier: "dev.a" }))).toEqual({});
});
