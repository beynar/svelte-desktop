import { expect, test } from "bun:test";
import { resolveConfig } from "../config.ts";
import { iosInfoPlist } from "./package-ios.ts";

const base = { exe: "App", debug: false, device: false, icon: null };
const config = (extra = {}) => resolveConfig("/tmp", { appName: "Notes", identifier: "dev.x.notes", version: "1.2.3", ...extra });

test("Info.plist from config", () => {
  const p = iosInfoPlist(config({ schemes: ["notes"], usageDescriptions: { camera: "scan", location: "near you" }, permissions: { pages: ["app.*"] } }), {
    ...base,
    serverUrl: "https://notes.example.com",
  });
  expect(p).toContain("<key>CFBundleIdentifier</key><string>dev.x.notes</string>");
  expect(p).toContain("<key>CFBundleShortVersionString</key><string>1.2.3</string>");
  expect(p).toContain("<key>SDServerURL</key><string>https://notes.example.com</string>");
  expect(p).toContain("<key>CFBundleURLSchemes</key><array><string>notes</string></array>");
  expect(p).toContain("<key>NSCameraUsageDescription</key><string>scan</string>");
  expect(p).toContain("<key>NSLocationWhenInUseUsageDescription</key><string>near you</string>");
  expect(p).toContain("<key>SDPagePermissions</key><array><string>app.*</string></array>");
  expect(p).toContain("<string>iPhoneSimulator</string>");
  expect(p).not.toContain("NSAppTransportSecurity");
});

test("App Transport Security: http only for local dev servers", () => {
  expect(iosInfoPlist(config(), { ...base, serverUrl: "http://127.0.0.1:5173" })).toContain("<key>NSAllowsLocalNetworking</key><true/>");
  expect(() => iosInfoPlist(config(), { ...base, serverUrl: "http://notes.example.com" })).toThrow(/requires https/);
});

test("device builds", () => {
  expect(iosInfoPlist(config(), { ...base, device: true, serverUrl: "https://a.b" })).toContain("<string>iPhoneOS</string>");
});
