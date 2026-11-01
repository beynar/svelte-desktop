// iOS packaging ("thin client"), called by packageApp (package.ts) when
// build.target is 'ios'. iOS can't run Bun, so the SvelteKit server is deployed
// like any web app (any adapter) and `ios.serverUrl` points the app at it; the
// app is native/ios/SvelteDesktopHost.swift: a WKWebView with the same page
// bridge and services as the desktop shells (see MOBILE.md).
//
//   swiftc (iphonesimulator, or iphoneos with sign.ios) → <App>.app
//   Info.plist from config (identifier, version, schemes, usage strings,
//   bridge.allow, server URL, ATS for http dev servers) + actool icon
//   → codesign (ad hoc for the simulator; identity + provisioning profile for devices)
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { USAGE_KEYS, type ResolvedConfig } from "../config.ts";
import { appIcons } from "./icons.ts";
import { plistValue, type PackageResult } from "./package.ts";

const log = (s: string) => console.log(`  \x1b[36m▸\x1b[0m ${s}`);
const host = resolve(import.meta.dir, "../../native/ios/SvelteDesktopHost.swift");

// iOS spells a few usage keys differently from macOS.
const IOS_USAGE: Record<string, string> = { location: "NSLocationWhenInUseUsageDescription", calendars: "NSCalendarsFullAccessUsageDescription" };

export function iosInfoPlist(c: ResolvedConfig, opts: { exe: string; serverUrl: string; debug: boolean; device: boolean; icon: Record<string, unknown> | null }): string {
  const ios = c.ios ?? {};
  const url = new URL(opts.serverUrl);
  const offline = url.protocol === "app:";
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".local");
  const keys: Record<string, unknown> = {
    CFBundleName: c.appName,
    CFBundleDisplayName: c.appName,
    CFBundleIdentifier: c.identifier,
    CFBundleExecutable: opts.exe,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: c.version,
    CFBundleVersion: c.version,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleSupportedPlatforms: [opts.device ? "iPhoneOS" : "iPhoneSimulator"],
    MinimumOSVersion: ios.deploymentTarget ?? "17.0",
    LSRequiresIPhoneOS: true,
    UIDeviceFamily: [1, 2],
    UIRequiredDeviceCapabilities: ["arm64"],
    UILaunchScreen: {},
    UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false },
    UISupportedInterfaceOrientations: ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"],
    "UISupportedInterfaceOrientations~ipad": ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"],
    SDServerURL: opts.serverUrl,
    SDAppName: c.appName,
    SDIdentifier: c.identifier,
    SDDebug: opts.debug,
    ...(offline && { SDOffline: true }),
  };
  // App Transport Security: https everywhere; plain http only for a local dev server.
  if (url.protocol === "http:") {
    if (!local) throw new Error(`ios.serverUrl ${opts.serverUrl}: iOS requires https (http is allowed for localhost dev servers only)`);
    keys.NSAppTransportSecurity = { NSAllowsLocalNetworking: true };
  }
  if (c.bridgeAllow) keys.SDPagePermissions = c.bridgeAllow;
  if (c.schemes?.length) keys.CFBundleURLTypes = [{ CFBundleURLName: c.identifier, CFBundleURLSchemes: c.schemes }];
  for (const [k, v] of Object.entries(c.osPermissions)) if (IOS_USAGE[k] || USAGE_KEYS[k] || /UsageDescription$/.test(k)) keys[IOS_USAGE[k] ?? USAGE_KEYS[k] ?? k] = v;
  // Remote pushes: content-available ones wake the app in the background.
  if (c.push?.apns) keys.UIBackgroundModes = ["remote-notification"];
  if (opts.icon) Object.assign(keys, opts.icon);
  Object.assign(keys, ios.plist);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plistValue(keys)}</plist>
`;
}

/** The app's Swift plugin for iOS: native/*.swift + native/ios/*.swift, minus macOS-only files (AppKit/Cocoa). */
export async function iosPluginSources(c: ResolvedConfig): Promise<string[]> {
  if (!c.native) return [];
  const { pluginSources } = await import("./native.ts");
  const all = pluginSources(c.native, "ios");
  const out: string[] = [];
  const skipped: string[] = [];
  for (const f of all) {
    if (!f.endsWith(".swift")) {
      skipped.push(f);
      continue;
    }
    if (/^\s*import\s+(AppKit|Cocoa)\b/m.test(readFileSync(f, "utf8"))) skipped.push(f);
    else out.push(f);
  }
  if (skipped.length) console.log(`  \x1b[33m!\x1b[0m native plugin: ${skipped.map((f) => f.replace(`${c.root}/`, "")).join(", ")} skipped on iOS (macOS-only or not Swift; put iOS code in native/ios/)`);
  return out;
}

async function run(what: string, p: Promise<{ exitCode: number; stderr: Buffer; stdout: Buffer }>) {
  const r = await p;
  if (r.exitCode !== 0) throw new Error(`${what} failed:\n${r.stderr.toString()}${r.stdout.toString().slice(-3000)}`);
  return r;
}

/** App icon: the opaque 1024 px PNG → Assets.car via actool. Returns the Info.plist keys actool emits. */
async function compileIcon(png: string, app: string, work: string, platform: string, target: string): Promise<Record<string, unknown> | null> {
  const set = join(work, "Assets.xcassets", "AppIcon.appiconset");
  mkdirSync(set, { recursive: true });
  writeFileSync(join(work, "Assets.xcassets", "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }));
  copyFileSync(png, join(set, "icon.png"));
  writeFileSync(
    join(set, "Contents.json"),
    JSON.stringify({ images: [{ filename: "icon.png", idiom: "universal", platform: "ios", size: "1024x1024" }], info: { author: "xcode", version: 1 } }),
  );
  const partial = join(work, "icon-info.plist");
  const r = await $`xcrun actool --compile ${app} --platform ${platform} --minimum-deployment-target ${target} --app-icon AppIcon --output-partial-info-plist ${partial} --output-format human-readable-text ${join(work, "Assets.xcassets")}`
    .nothrow()
    .quiet();
  if (r.exitCode !== 0 || !existsSync(partial)) {
    console.log(`  \x1b[33m!\x1b[0m app icon skipped (actool: ${r.stderr.toString().trim().split("\n")[0] ?? "failed"})`);
    return null;
  }
  return JSON.parse((await $`plutil -convert json -o - ${partial}`.quiet()).stdout.toString());
}

export async function packageIos(c: ResolvedConfig, stage: string): Promise<PackageResult> {
  const t0 = performance.now();
  if (process.platform !== "darwin") throw new Error("build.target 'ios' needs macOS with Xcode");
  const offline = !!c.ios?.offline;
  const serverUrl = offline ? "app://localhost/" : (process.env.SVELTE_DESKTOP_IOS_SERVER_URL ?? c.ios?.serverUrl);
  if (!serverUrl)
    throw new Error("build.target 'ios': set ios.serverUrl in desktop.config.ts — where the SvelteKit server is deployed (iOS can't run Bun), e.g. https://notes.example.com or http://127.0.0.1:5173 for `vite dev` in the simulator");
  const sign = c.sign?.ios;
  const signed = !!sign?.provisioningProfile;
  // ios.device without a profile: an unsigned device build, to sign later (codesign + embedded.mobileprovision).
  const device = signed || !!c.ios?.device || !!process.env.SVELTE_DESKTOP_IOS_DEVICE;
  const debug = !device || !!c.ios?.debug;
  const sdk = device ? "iphoneos" : "iphonesimulator";
  const target = c.ios?.deploymentTarget ?? "17.0";
  const dist = resolve(c.root, c.build?.outDir ?? ".desktop/dist");
  const work = join(resolve(dist, ".."), "work", "ios");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const exe = c.appName.replace(/[^A-Za-z0-9_-]/g, "") || "App";
  const outDir = join(dist, device ? "ios" : "ios-simulator");
  const app = join(outDir, `${exe}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });

  log(`swiftc ${sdk} (iOS ${target}+)`);
  const triple = `arm64-apple-ios${target}${device ? "" : "-simulator"}`;
  // Simulator apps are ad-hoc signed, so their entitlements (Keychain access group
  // included) live in a __TEXT,__entitlements section, as Xcode does it.
  const simEntitlements = join(work, "simulator.entitlements");
  writeFileSync(simEntitlements, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${plistValue({ "application-identifier": c.identifier, "keychain-access-groups": [c.identifier], ...(c.push?.apns && { "aps-environment": "development" }) })}</plist>\n`);
  const link = device ? [] : ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__entitlements", "-Xlinker", simEntitlements];
  const plugin = await iosPluginSources(c);
  if (plugin.length) log(`native plugin: ${plugin.map((f) => f.replace(`${c.root}/`, "")).join(", ")}`);
  await run(
    "swiftc",
    $`xcrun -sdk ${sdk} swiftc -parse-as-library -target ${triple} -O ${debug ? ["-D", "DEBUG"] : []} ${plugin.length ? ["-D", "SD_PLUGIN"] : []} ${link} ${host} ${plugin} -o ${join(app, exe)}`
      .nothrow()
      .quiet(),
  );

  const icon = c.icon ? await compileIcon((await appIcons(c.root, c.icon)).ios, app, work, sdk, target) : null;
  writeFileSync(join(app, "Info.plist"), iosInfoPlist(c, { exe, serverUrl, debug, device, icon }));
  writeFileSync(join(app, "PkgInfo"), "APPL????");
  if (offline) {
    const www = join(stage, "ios-www");
    if (!existsSync(join(www, "200.html"))) throw new Error("ios.offline: no offline bundle in the stage (build through the Vite plugin)");
    await $`cp -R ${www} ${join(app, "www")}`.quiet();
  }

  if (device && !signed) {
    console.log(`  \x1b[33m!\x1b[0m unsigned device build: sign it with a provisioning profile (sign.ios.provisioningProfile) to install it`);
  } else if (device) {
    const profile = resolve(c.root, sign!.provisioningProfile!);
    copyFileSync(profile, join(app, "embedded.mobileprovision"));
    // Entitlements come from the profile (application-identifier, team, get-task-allow…).
    const decoded = (await run("security cms", $`security cms -D -i ${profile}`.nothrow().quiet())).stdout.toString();
    writeFileSync(join(work, "profile.plist"), decoded);
    const ent = (await $`/usr/libexec/PlistBuddy -x -c ${"Print :Entitlements"} ${join(work, "profile.plist")}`.quiet()).stdout.toString();
    writeFileSync(join(work, "entitlements.plist"), ent);
    if (c.push?.apns && !ent.includes("aps-environment"))
      console.log(`  \x1b[33m!\x1b[0m push.apns: the provisioning profile has no aps-environment — enable Push Notifications for ${c.identifier} and download it again`);
    const identity = sign!.identity ?? process.env.IOS_SIGN_IDENTITY ?? "Apple Development";
    await run("codesign", $`codesign --force --timestamp=none --sign ${identity} --entitlements ${join(work, "entitlements.plist")} ${app}`.nothrow().quiet());
  } else {
    // Entitlements stay in the section only: the simulator rejects restricted ones in an ad-hoc signature.
    await run("codesign", $`codesign --force --sign - --timestamp=none ${app}`.nothrow().quiet());
  }
  const size = (await $`du -sk ${app}`.text()).split("\t")[0];
  log(`${app.replace(`${c.root}/`, "")} (${(Number(size) / 1024).toFixed(1)} MB, ${signed ? "device" : device ? "device, unsigned" : "simulator"}, server ${serverUrl}, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  return { app, artifacts: [app], signed: signed ? "identity" : "ad-hoc", notarized: false, arches: ["arm64"] };
}
