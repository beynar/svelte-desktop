// Packaging pipeline, run by the desktop adapter at the end of `vite build`:
//   staged server graph → bun build --compile → .app (Info.plist, icon, libshell,
//   native plugin, sidecars) → codesign (hardened runtime) → notarize + staple →
//   zip / DMG → release/ (tar.zst + signed update.json).
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { USAGE_KEYS, sidecarEntries, type ResolvedConfig } from "../config.ts";
import { appIcons } from "./icons.ts";
import { compileStaged, sizeFlags } from "./bun-compile.ts";
import { buildLanguagePlugins } from "./native-langs.ts";
import { typeNativePlugins } from "./native-types.ts";
import { buildAddons, buildNativePlugin } from "./native.ts";

const shellRoot = resolve(import.meta.dir, "../..");
const log = (s: string) => console.log(`  \x1b[36m▸\x1b[0m ${s}`);
const mb = (p: string) => `${(statSync(p).size / 1048576).toFixed(1)} MB`;
const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Arch = "arm64" | "x64";
export interface PackageResult {
  /** The .app (macOS), AppDir/install dir (Linux) or app folder (Windows). */
  app: string;
  /** Extra installers (AppImage, tar.gz, setup .exe, …). */
  artifacts?: string[];
  zip?: string;
  dmg?: string;
  release?: { dir: string; manifest: string; artifact: string; signed: boolean };
  signed: "ad-hoc" | "identity";
  notarized: boolean;
  arches: Arch[];
}

const hostArch: Arch = process.arch === "arm64" ? "arm64" : "x64";
const clangArch = (a: Arch) => (a === "arm64" ? "arm64" : "x86_64");

export type LibOS = "darwin" | "linux";
const hostLibOS: LibOS = process.platform === "linux" ? "linux" : "darwin";
const linuxArch = (a: Arch) => (a === "arm64" ? "arm64" : "x86_64");

export function libshellPath(arch: Arch, os: LibOS = hostLibOS): string {
  if (os === "linux") return join(shellRoot, "native", "build", `linux-${linuxArch(arch)}`, "libshell.so");
  return join(shellRoot, "native", "build", `darwin-${clangArch(arch)}`, "libshell.dylib");
}

export async function ensureLibshell(arch: Arch, os: LibOS = hostLibOS): Promise<string> {
  // Prebuilt override (CI, published packages with prebuilt binaries).
  const prebuilt = process.env[`SVELTE_DESKTOP_LIBSHELL_${arch.toUpperCase()}`] ?? (arch === hostArch && os === hostLibOS ? process.env.SVELTE_DESKTOP_LIBSHELL : undefined);
  if (prebuilt) return prebuilt;
  const lib = libshellPath(arch, os);
  if (os === "linux") {
    const dirs = ["linux", "portable"].map((d) => join(shellRoot, "native", d));
    const newest = Math.max(...dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(cc|hpp|h)$/.test(f)).map((f) => statSync(join(d, f)).mtimeMs)));
    if (existsSync(lib) && statSync(lib).mtimeMs >= newest) return lib;
    log(`native: building libshell.so (linux-${linuxArch(arch)})`);
    // On Linux natively; elsewhere in the Docker image (native/docker/build-lib.sh).
    if (process.platform === "linux" && arch === hostArch) await $`${join(shellRoot, "native", "build-linux.sh")}`.quiet();
    else await $`${join(shellRoot, "native", "docker", "build-lib.sh")} ${arch}`.quiet();
    if (!existsSync(lib)) throw new Error(`libshell.so for linux-${arch} was not built (${lib})`);
    return lib;
  }
  const newest = Math.max(...readdirSync(join(shellRoot, "native")).filter((f) => /\.(mm|h|cc)$/.test(f)).map((f) => statSync(join(shellRoot, "native", f)).mtimeMs));
  if (!existsSync(lib) || statSync(lib).mtimeMs < newest) {
    log(`native: building libshell (${arch})`);
    await $`${join(shellRoot, "native", "build-macos.sh")} ${clangArch(arch)}`.quiet();
  }
  return lib;
}

// ---------------------------------------------------------------------------
// Info.plist

export function plistValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (Array.isArray(v)) return `<array>${v.map(plistValue).join("")}</array>`;
  if (v && typeof v === "object")
    return `<dict>${Object.entries(v).map(([k, x]) => `<key>${xml(k)}</key>${plistValue(x)}`).join("")}</dict>`;
  return `<string>${xml(String(v))}</string>`;
}

/** The Icon Composer icon → Assets.car (actool, Xcode 26+). Without it macOS 26 shows the .icns
 *  shrunk inside a gray squircle; older macOS read the .icns either way. */
async function compileIconCatalog(iconComposer: string, resources: string, work: string): Promise<boolean> {
  const out = join(work, "icon-catalog");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = await $`xcrun actool ${iconComposer} --compile ${out} --platform macosx --minimum-deployment-target 11.0 --app-icon AppIcon --output-partial-info-plist ${join(out, "partial.plist")}`.nothrow().quiet();
  if (r.exitCode !== 0 || !existsSync(join(out, "Assets.car"))) {
    log("icon: no Assets.car (needs Xcode 26's actool) — macOS 26 shows the icon inside a gray frame");
    return false;
  }
  copyFileSync(join(out, "Assets.car"), join(resources, "Assets.car"));
  return true;
}

/** `icon`: "icns" → AppIcon.icns; "catalog" → also AppIcon in Assets.car (macOS 26's own icon format). */
export function infoPlist(c: ResolvedConfig, exe: string, icon: "none" | "icns" | "catalog"): string {
  const keys: Record<string, unknown> = {
    CFBundleName: c.appName,
    CFBundleDisplayName: c.appName,
    CFBundleIdentifier: c.identifier,
    CFBundleExecutable: exe,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: c.version,
    CFBundleVersion: c.version,
    CFBundleInfoDictionaryVersion: "6.0",
    LSMinimumSystemVersion: c.build?.minimumSystemVersion ?? "12.0",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    LSApplicationCategoryType: "public.app-category.productivity",
  };
  if (icon !== "none") keys.CFBundleIconFile = "AppIcon";
  if (icon === "catalog") keys.CFBundleIconName = "AppIcon";
  if (c.copyright) keys.NSHumanReadableCopyright = c.copyright;
  if (c.trayOnly) keys.LSUIElement = true;
  if (c.schemes?.length) keys.CFBundleURLTypes = [{ CFBundleURLName: c.identifier, CFBundleURLSchemes: c.schemes }];
  if (c.fileTypes?.length)
    keys.CFBundleDocumentTypes = c.fileTypes.map((t) => ({
      CFBundleTypeName: t.name,
      CFBundleTypeRole: t.role ?? "Editor",
      LSHandlerRank: t.rank ?? "Default",
      CFBundleTypeExtensions: t.extensions,
      ...(t.utis?.length ? { LSItemContentTypes: t.utis } : {}),
    }));
  for (const [k, v] of Object.entries(c.osPermissions)) if (USAGE_KEYS[k] || /UsageDescription$/.test(k)) keys[USAGE_KEYS[k] ?? k] = v;
  Object.assign(keys, c.plist);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plistValue(keys)}</plist>
`;
}

// ---------------------------------------------------------------------------
// Signing

/** What a compiled Bun executable needs under the hardened runtime (bun.com/docs/guides/runtime/codesign-macos-executable). */
const BUN_ENTITLEMENTS: Record<string, boolean> = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
  "com.apple.security.cs.disable-executable-page-protection": true,
  "com.apple.security.cs.allow-dyld-environment-variables": true,
  // Bun extracts embedded N-API addons / bun:ffi libraries to a temp dir before dlopen.
  "com.apple.security.cs.disable-library-validation": true,
};

export function entitlements(c: ResolvedConfig): Record<string, unknown> {
  const e: Record<string, unknown> = { ...BUN_ENTITLEMENTS };
  const usage = Object.keys(c.osPermissions);
  const has = (short: string) => usage.includes(short) || usage.includes(USAGE_KEYS[short]!);
  if (has("camera")) e["com.apple.security.device.camera"] = true;
  if (has("microphone")) e["com.apple.security.device.audio-input"] = true;
  if (has("location")) e["com.apple.security.personal-information.location"] = true;
  if (has("contacts")) e["com.apple.security.personal-information.addressbook"] = true;
  if (has("calendars")) e["com.apple.security.personal-information.calendars"] = true;
  if (has("photos")) e["com.apple.security.personal-information.photos-library"] = true;
  if (has("appleEvents")) e["com.apple.security.automation.apple-events"] = true;
  return { ...e, ...c.sign?.entitlements };
}

/** push.apns environment: explicit, else what the profile grants. */
function apsEnvironment(c: ResolvedConfig, granted: string): string {
  const apns = c.push?.apns;
  return (typeof apns === "object" && apns.environment) || granted;
}

function signIdentity(c: ResolvedConfig): string {
  return c.sign?.identity ?? process.env.CODESIGN_IDENTITY ?? "-";
}

async function codesign(path: string, identity: string, opts: { runtime: boolean; entitlements?: string }) {
  const args = ["--force", "--sign", identity];
  if (identity !== "-") args.push("--timestamp");
  if (opts.runtime) args.push("--options", "runtime");
  if (opts.entitlements) args.push("--entitlements", opts.entitlements);
  await $`codesign ${args} ${path}`.quiet();
}

async function signApp(app: string, exe: string, c: ResolvedConfig, work: string): Promise<"ad-hoc" | "identity"> {
  const identity = signIdentity(c);
  const runtime = c.sign?.hardenedRuntime ?? identity !== "-";
  const entFile = join(work, "entitlements.plist");
  const ent = entitlements(c);
  // Restricted entitlements (push) need a provisioning profile, or AMFI kills the app at launch.
  if (c.sign?.provisioningProfile) {
    const profile = resolve(c.root, c.sign.provisioningProfile);
    copyFileSync(profile, join(app, "Contents/embedded.provisionprofile"));
    const decoded = (await $`security cms -D -i ${profile}`.quiet()).stdout.toString();
    const plist = join(work, "profile.plist");
    await Bun.write(plist, decoded);
    const granted = JSON.parse((await $`plutil -extract Entitlements json -o - ${plist}`.quiet()).stdout.toString()) as Record<string, unknown>;
    for (const k of ["com.apple.application-identifier", "com.apple.developer.team-identifier"]) if (granted[k]) ent[k] = granted[k];
    if (c.push?.apns) {
      if (!granted["com.apple.developer.aps-environment"])
        console.log(`  \x1b[33m!\x1b[0m push.apns: the provisioning profile has no aps-environment — enable Push Notifications for ${c.identifier}`);
      else ent["com.apple.developer.aps-environment"] = apsEnvironment(c, String(granted["com.apple.developer.aps-environment"]));
    }
  } else if (c.push?.apns) {
    console.log("  \x1b[33m!\x1b[0m push.apns: needs sign.provisioningProfile (a Developer ID or Mac App Store profile with Push Notifications) — host.push.register() will be unavailable");
  }
  await Bun.write(
    entFile,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(ent)}</plist>\n`,
  );
  // Inside-out: nested code first, the bundle last.
  const fw = join(app, "Contents/Frameworks");
  const inside = (d: string) => (existsSync(join(fw, d)) ? readdirSync(join(fw, d)).map((f) => join(fw, d, f)) : []);
  const nested = [
    ...inside("addons"),
    ...inside("plugins"),
    ...readdirSync(fw).filter((f) => f !== "addons" && f !== "plugins").map((f) => join(fw, f)),
    ...readdirSync(join(app, "Contents/MacOS")).filter((f) => f !== exe).map((f) => join(app, "Contents/MacOS", f)),
  ];
  for (const f of nested) await codesign(f, identity, { runtime });
  await codesign(app, identity, { runtime, entitlements: entFile });
  await $`codesign --verify --deep --strict ${app}`.quiet();
  return identity === "-" ? "ad-hoc" : "identity";
}

async function notarize(path: string, profile: string) {
  log(`notarize ${basename(path)} (notarytool, profile ${profile})`);
  let submit = path;
  if (path.endsWith(".app")) {
    submit = `${path}.notarize.zip`;
    await $`ditto -c -k --keepParent ${path} ${submit}`.quiet();
  }
  const out = await $`xcrun notarytool submit ${submit} --keychain-profile ${profile} --wait --output-format json`.nothrow().text();
  if (submit !== path) rmSync(submit, { force: true });
  const res = JSON.parse(out || "{}");
  if (res.status !== "Accepted")
    throw new Error(`notarization ${res.status ?? "failed"} for ${basename(path)} (id ${res.id ?? "?"}): xcrun notarytool log ${res.id} --keychain-profile ${profile}`);
  await $`xcrun stapler staple ${path}`.quiet();
}

// ---------------------------------------------------------------------------
// Compile

async function compile(c: ResolvedConfig, stage: string, out: string, arch: Arch): Promise<void> {
  const bun = c.build?.bun ?? process.env.SVELTE_DESKTOP_BUN ?? process.execPath;
  // A desktop app must not pick up bunfig.toml / .env from whatever directory it
  // is launched in (behavior changes, environment injection).
  const flags = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", ...(await sizeFlags(c, bun, { aot: arch === hostArch, warn: (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`) }))]; // --aot can't cross-compile
  if (arch !== hostArch) flags.push(`--target=bun-darwin-${arch}`);
  const rev = (await $`${bun} --revision`.text()).trim();
  log(`bun build --compile ${flags.join(" ")} (${rev}, ${arch})`);
  await compileStaged(bun, stage, out, flags, (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`));
}

// ---------------------------------------------------------------------------

/** Package for `build.target` (default: the host OS). */
export async function packageApp(c: ResolvedConfig, stage: string): Promise<PackageResult> {
  const target = c.build?.target ?? (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos");
  if (target === "linux") return (await import("./package-linux.ts")).packageLinux(c, stage);
  if (target === "windows") return (await import("./package-windows.ts")).packageWindows(c, stage);
  return packageMac(c, stage);
}

async function packageMac(c: ResolvedConfig, stage: string): Promise<PackageResult> {
  const t0 = performance.now();
  const dist = resolve(c.root, c.build?.outDir ?? ".desktop/dist");
  const work = join(dirname(dist), "work");
  mkdirSync(dist, { recursive: true });
  mkdirSync(work, { recursive: true });
  const exe = c.appName.replace(/[^A-Za-z0-9_-]/g, "") || "App";
  const arches: Arch[] = c.build?.universal ? ["arm64", "x64"] : [hostArch];

  // 1. executables (+ lipo)
  const exeOut = join(work, exe);
  const slices: string[] = [];
  for (const arch of arches) {
    const out = arches.length > 1 ? `${exeOut}-${arch}` : exeOut;
    await compile(c, stage, out, arch);
    slices.push(out);
  }
  if (slices.length > 1) await $`lipo -create ${slices} -output ${exeOut}`.quiet();

  // 2. bundle
  const app = join(dist, `${c.appName}.app`);
  rmSync(app, { recursive: true, force: true });
  for (const d of ["MacOS", "Frameworks", "Resources"]) mkdirSync(join(app, "Contents", d), { recursive: true });
  await $`mv ${exeOut} ${join(app, "Contents/MacOS", exe)}`;
  const libs = await Promise.all(arches.map((a) => ensureLibshell(a, "darwin")));
  if (libs.length > 1) await $`lipo -create ${libs} -output ${join(app, "Contents/Frameworks/libshell.dylib")}`.quiet();
  else await $`cp ${libs[0]} ${join(app, "Contents/Frameworks/libshell.dylib")}`;

  if (c.native) {
    const plugin = await buildNativePlugin(c, { arches, outDir: join(work, "native") });
    if (plugin) await $`cp ${plugin} ${join(app, "Contents/Frameworks/libapp-native.dylib")}`;
    const langs = await buildLanguagePlugins(c, { os: "macos", arches, outDir: join(work, "plugins"), release: true });
    await typeNativePlugins(c.root, [...(plugin ? [plugin] : []), ...langs]);
    if (langs.length) {
      mkdirSync(join(app, "Contents/Frameworks/plugins"), { recursive: true });
      for (const l of langs) copyFileSync(l, join(app, "Contents/Frameworks/plugins", basename(l)));
    }
  }
  const addons = await buildAddons(c, { arches, outDir: join(work, "addons") });
  if (Object.keys(addons).length) {
    mkdirSync(join(app, "Contents/Frameworks/addons"), { recursive: true });
    for (const [name, file] of Object.entries(addons)) await $`cp ${file} ${join(app, "Contents/Frameworks/addons", `${name}.node`)}`;
  }
  for (const [name, from] of sidecarEntries(c, "macos")) {
    if (!existsSync(from)) throw new Error(`sidecar "${name}": ${from} not found`);
    await $`cp ${from} ${join(app, "Contents/MacOS", name)}`;
    await $`chmod +x ${join(app, "Contents/MacOS", name)}`;
  }

  let icon: "none" | "icns" | "catalog" = "none";
  if (c.icon) {
    const icons = await appIcons(c.root, c.icon);
    copyFileSync(icons.icns, join(app, "Contents/Resources/AppIcon.icns"));
    icon = (await compileIconCatalog(icons.iconComposer, join(app, "Contents/Resources"), work)) ? "catalog" : "icns";
  }
  await Bun.write(join(app, "Contents/Info.plist"), infoPlist(c, exe, icon));
  await Bun.write(join(app, "Contents/PkgInfo"), "APPL????");
  log(`${basename(app)}  executable ${mb(join(app, "Contents/MacOS", exe))} (${arches.join("+")})`);

  // 3. sign + notarize
  const signed = await signApp(app, exe, c, work);
  log(`codesign: ${signed === "ad-hoc" ? "ad-hoc (set sign.identity or $CODESIGN_IDENTITY to distribute)" : signIdentity(c)}`);
  const profile = c.sign?.notaryProfile ?? process.env.NOTARY_PROFILE;
  let notarized = false;
  if (profile && signed === "identity") {
    const { notaryPreflight, formatPreflight } = await import("./notary-preflight.ts");
    const issues = await notaryPreflight(app);
    if (issues.some((i) => i.level === "error")) throw new Error(`the bundle would be rejected by notarization:\n${formatPreflight(issues)}`);
    await notarize(app, profile);
    notarized = true;
  }

  // 4. archives
  const tag = `${exe}-${c.version}-darwin-${arches.length > 1 ? "universal" : arches[0]}`;
  const result: PackageResult = { app, signed, notarized, arches };
  if (c.build?.zip !== false) {
    result.zip = join(dist, `${tag}.zip`);
    rmSync(result.zip, { force: true });
    await $`ditto -c -k --keepParent ${app} ${result.zip}`;
    log(`zip  ${mb(result.zip)}`);
  }
  if (c.build?.dmg !== false) {
    result.dmg = join(dist, `${tag}.dmg`);
    const src = join(work, "dmg");
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src);
    await $`cp -R ${app} ${src}/`;
    await $`ln -s /Applications ${join(src, "Applications")}`; // drag-to-install
    rmSync(result.dmg, { force: true });
    await $`hdiutil create -quiet -volname ${c.appName} -srcfolder ${src} -fs APFS -format ULMO -ov ${result.dmg}`;
    rmSync(src, { recursive: true, force: true });
    if (signed === "identity") await codesign(result.dmg, signIdentity(c), { runtime: false });
    if (notarized && profile) await notarize(result.dmg, profile);
    log(`dmg  ${mb(result.dmg)}`);
  }

  // 5. release artifacts for the updater
  if (c.update) result.release = await writeRelease(c, app, arches, dist);

  const size = Number((await $`du -sk ${app}`.text()).split("\t")[0]) / 1024;
  console.log(`\n  \x1b[32m✓\x1b[0m ${app} (${size.toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

/** Updater release (archive + delta patch + signed manifest) for an app bundle/directory; `os` prefixes the artifact name and manifest keys. */
export async function writeRelease(c: ResolvedConfig, app: string, arches: Arch[], dist: string, os: "darwin" | "linux" | "windows" = "darwin") {
  const { createArchive } = await import("../updater/archive.ts");
  const { sha256File } = await import("../updater/download.ts");
  const { signManifest } = await import("../updater/manifest.ts");
  const { privateKeyFromText } = await import("../updater/crypto.ts");
  const dir = join(dist, "release", c.version);
  mkdirSync(dir, { recursive: true });
  const file = `${basename(app, ".app").replace(/[^A-Za-z0-9_-]/g, "")}-${c.version}-${os}-${arches.length > 1 ? "universal" : arches[0]}.tar.zst`;
  const artifactPath = join(dir, file);
  await createArchive([app], artifactPath, "tar.zst");
  const artifact = { url: file, sha256: await sha256File(artifactPath), size: statSync(artifactPath).size, format: "tar.zst" as const };
  const keys = arches.length > 1 ? [`${os}-arm64`, `${os}-x64`] : [`${os}-${arches[0]}`];
  const url = (f: string) => (c.update!.baseUrl ? `${c.update!.baseUrl.replace(/\/$/, "")}/${c.version}/${f}` : `${c.version}/${f}`);
  artifact.url = url(file);

  // Delta patch from the previous release in release/ (per-file rsync-style, see updater/delta.ts).
  const patches: Array<{ from: string; url: string; sha256: string; size: number }> = [];
  const releaseRoot = join(dist, "release");
  const previous = readdirSync(releaseRoot)
    .filter((v) => /^\d+\.\d+\.\d+/.test(v) && Bun.semver.order(v, c.version) < 0 && existsSync(join(releaseRoot, v)))
    .sort((a, b) => Bun.semver.order(b, a))[0];
  if (previous) {
    const prevArtifact = readdirSync(join(releaseRoot, previous)).find((f) => f.endsWith(file.slice(file.indexOf(`-${c.version}-`) + c.version.length + 2)));
    if (prevArtifact) {
      const { extractArchive } = await import("../updater/archive.ts");
      const { createTreePatch } = await import("../updater/delta.ts");
      const prevDir = join(dist, "..", "work", `prev-${previous}`);
      rmSync(prevDir, { recursive: true, force: true });
      await extractArchive(join(releaseRoot, previous, prevArtifact), "tar.zst", prevDir);
      const prevApp = join(prevDir, basename(app));
      if (existsSync(prevApp)) {
        const patchFile = file.replace(/\.tar\.zst$/, `.from-${previous}.sdpatch`);
        const bytes = createTreePatch(prevApp, app, { from: previous, to: c.version, root: basename(app) });
        await Bun.write(join(dir, patchFile), bytes);
        patches.push({ from: previous, url: url(patchFile), sha256: await sha256File(join(dir, patchFile)), size: bytes.length });
        log(`delta ${previous} → ${c.version}: ${(bytes.length / 1024).toFixed(0)} KB (full ${(artifact.size / 1048576).toFixed(1)} MB)`);
      }
      rmSync(prevDir, { recursive: true, force: true });
    }
  }
  const manifest = {
    name: c.identifier,
    version: c.version,
    channel: c.update!.channel ?? "stable",
    releasedAt: new Date().toISOString(),
    artifacts: Object.fromEntries(keys.map((k) => [k, artifact])),
    ...(patches.length ? { patches: Object.fromEntries(keys.map((k) => [k, patches])) } : {}),
  };
  const keyPath = c.update!.privateKey ?? process.env.SVELTE_DESKTOP_UPDATE_KEY;
  const manifestPath = join(dist, "release", "update.json");
  if (keyPath && existsSync(resolve(c.root, keyPath))) {
    const signedManifest = await signManifest(manifest as any, privateKeyFromText(await Bun.file(resolve(c.root, keyPath)).text()));
    await Bun.write(manifestPath, JSON.stringify(signedManifest, null, 2));
    log(`release  ${dir}/${file} + signed update.json`);
    return { dir, manifest: manifestPath, artifact: artifactPath, signed: true };
  }
  await Bun.write(manifestPath.replace(/\.json$/, ".unsigned.json"), JSON.stringify(manifest, null, 2));
  log(`release  ${dir}/${file} (update.unsigned.json — set update.privateKey or $SVELTE_DESKTOP_UPDATE_KEY to sign)`);
  return { dir, manifest: manifestPath.replace(/\.json$/, ".unsigned.json"), artifact: artifactPath, signed: false };
}
