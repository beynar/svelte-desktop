// Linux packaging, called by packageApp (package.ts) when build.target is
// 'linux' or the host is Linux:
//   staged server graph → bun build --compile --target=bun-linux-<arch> →
//   <outDir>/<appName>/ { <exe>, lib/libshell.so, lib/libapp-native.so,
//   lib/addons/*.node, sidecars, <identifier>.png, <identifier>.desktop }
//   → .tar.gz → AppImage (when appimagetool is available) → release/ for the updater.
//
// Runtime layout contract (src/os.ts bundledLibDir): libraries live in
// <exeDir>/lib, so the directory is relocatable and an AppImage is just that
// directory plus AppRun. GTK 3 and WebKitGTK 4.1 come from the system (like the
// system WebKit on macOS); libnotify / appindicator / libsecret are optional
// (dlopen()ed by libshell.so).
//
// Native code on Linux: the plugin folder's C/C++ sources are built with the
// host compiler into libapp-native.so (they implement sd_plugin_init from
// native/include/svelte_desktop.h). Swift / Objective-C sources are macOS-only
// and skipped with a notice. native/addons/*.c|cc|cpp → <name>.node with cc/c++.
// Compiling native code needs a Linux host (or the Docker image); when cross-
// building from macOS those steps are skipped with a warning unless prebuilt.
import { $ } from "bun";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { sidecarEntries, type ResolvedConfig } from "../config.ts";
import { pluginSources as sharedPluginSources } from "./native.ts";
import { ensureLibshell, writeRelease, type Arch, type PackageResult } from "./package.ts";

const log = (s: string) => console.log(`  \x1b[36m▸\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const mb = (p: string) => `${(statSync(p).size / 1048576).toFixed(1)} MB`;
const hostArch: Arch = process.arch === "arm64" ? "arm64" : "x64";
const include = resolve(import.meta.dir, "../../native/include");
const napi = resolve(import.meta.dir, "../../native/vendor/node-api/include");
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** File-system friendly executable name: "Svelte Notes" → "svelte-notes". */
export function linuxExeName(appName: string): string {
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

function canCompileNative(arch: Arch): boolean {
  return process.platform === "linux" && arch === hostArch;
}

function newer(target: string, sources: string[]): boolean {
  if (!existsSync(target)) return false;
  const t = statSync(target).mtimeMs;
  return sources.every((s) => statSync(s).mtimeMs < t);
}

const pluginSources = (dir: string) => sharedPluginSources(dir, "linux");

/** native/*.c|cc|cpp → libapp-native.so (Swift/ObjC skipped: macOS-only). */
export async function buildLinuxPlugin(c: ResolvedConfig, arch: Arch, outDir: string): Promise<string | null> {
  if (!c.native) return null;
  const all = pluginSources(c.native);
  const apple = all.filter((f) => /\.(swift|m|mm)$/.test(f));
  const files = all.filter((f) => /\.(c|cc|cpp)$/.test(f));
  if (apple.length) warn(`native plugin: ${apple.map((f) => relative(c.root, f)).join(", ")} skipped (Swift/Objective-C are macOS-only; write C/C++ against native/include/svelte_desktop.h for Linux)`);
  if (!files.length) return null;
  if (!canCompileNative(arch)) {
    warn(`native plugin: C/C++ sources need a Linux ${arch} host to compile (skipped)`);
    return null;
  }
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "libapp-native.so");
  if (newer(out, [...files, ...readdirSync(include).map((f) => join(include, f))])) return out;
  log(`native plugin: ${files.map((f) => relative(c.root, f)).join(", ")}`);
  const objs: string[] = [];
  for (const src of files) {
    const obj = join(outDir, `${relative(c.native, src).replace(/[\/.]/g, "_")}.o`);
    const cpp = /\.(cc|cpp)$/.test(src);
    const r = await $`${cpp ? "c++" : "cc"} -c -fPIC -O2 -fvisibility=default -I${include} ${cpp ? "-std=c++17" : "-std=c17"} ${src} -o ${obj}`.nothrow().quiet();
    if (r.exitCode !== 0) throw new Error(`native plugin: ${relative(c.root, src)}\n${r.stderr.toString()}`);
    objs.push(obj);
  }
  const r = await $`c++ -shared -Wl,-soname,libapp-native.so ${objs} -o ${out}`.nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`native plugin link failed:\n${r.stderr.toString()}`);
  return out;
}

/** native/addons/<name>.(c|cc|cpp) → <name>.node (napi_* resolve against Bun at load time), plus prebuilt `addons`. */
export async function buildLinuxAddons(c: ResolvedConfig, arch: Arch, outDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dir = c.native ? join(c.native, "addons") : null;
  if (dir && existsSync(dir)) {
    const sources = readdirSync(dir).filter((f) => /\.(c|cc|cpp)$/.test(f));
    for (const f of readdirSync(dir).filter((f) => /\.(m|mm)$/.test(f))) warn(`addon ${f}: Objective-C is macOS-only (skipped)`);
    if (sources.length && !canCompileNative(arch)) warn(`addons: ${sources.join(", ")} need a Linux ${arch} host to compile (skipped)`);
    else if (sources.length) mkdirSync(outDir, { recursive: true });
    for (const entry of canCompileNative(arch) ? sources : []) {
      const name = entry.replace(/\.[^.]+$/, "");
      const src = join(dir, entry);
      const target = join(outDir, `${name}.node`);
      if (!newer(target, [src])) {
        log(`addon: ${relative(c.root, src)}`);
        const cpp = /\.(cc|cpp)$/.test(entry);
        const r = await $`${cpp ? "c++" : "cc"} -shared -fPIC -O2 -I${napi} ${cpp ? ["-std=c++17"] : []} ${src} -o ${target}`.nothrow().quiet();
        if (r.exitCode !== 0) throw new Error(`addon ${entry}:\n${r.stderr.toString()}`);
      }
      out[name] = target;
    }
  }
  for (const [name, path] of Object.entries(c.addons ?? {})) {
    const abs = resolve(c.root, path);
    if (!existsSync(abs)) throw new Error(`addon "${name}": ${abs} not found`);
    out[name] = abs;
  }
  return out;
}

async function compile(c: ResolvedConfig, stage: string, out: string, arch: Arch): Promise<void> {
  const bun = c.build?.bun ?? process.env.SVELTE_DESKTOP_BUN ?? process.execPath;
  const native = process.platform === "linux" && arch === hostArch;
  // A desktop app must not pick up bunfig.toml / .env from its launch directory.
  const flags = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", `--target=bun-linux-${arch}`];
  if (c.build?.aot && native) flags.push("--aot"); // --aot can't cross-compile
  if (c.build?.trim) flags.push("--trim", "--trim-locales=en");
  const rev = (await $`${bun} --revision`.text()).trim();
  log(`bun build --compile ${flags.join(" ")} (${rev})`);
  const r = await $`${bun} build --compile ${flags} ${join(stage, "desktop-main.js")} ${join(stage, "desktop-worker.js")} --outfile ${out}`
    .cwd(stage)
    .nothrow()
    .quiet();
  if (r.exitCode !== 0) throw new Error(`bun build --compile failed:\n${r.stderr.toString()}${r.stdout.toString().slice(-4000)}`);
}

const KNOWN_MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv",
  html: "text/html", htm: "text/html", xml: "application/xml", pdf: "application/pdf", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip", yaml: "application/x-yaml", yml: "application/x-yaml",
};

/** fileTypes → MIME types for the .desktop entry, plus the types the app must declare itself. */
export function linuxFileTypes(c: ResolvedConfig): { mimes: string[]; declared: Array<{ type: string; comment: string; glob: string }> } {
  const mimes: string[] = [];
  const declared: Array<{ type: string; comment: string; glob: string }> = [];
  const slug = c.identifier.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const t of c.fileTypes ?? []) {
    if (t.mimeTypes?.length) {
      mimes.push(...t.mimeTypes);
      continue;
    }
    for (const raw of t.extensions) {
      const ext = raw.replace(/^\./, "").toLowerCase();
      if (ext === "*") continue;
      const known = KNOWN_MIME[ext];
      const type = known ?? `application/x-${slug}-${ext}`;
      mimes.push(type);
      if (!known) declared.push({ type, comment: t.name, glob: `*.${ext}` });
    }
  }
  return { mimes: [...new Set(mimes)], declared };
}

export function sharedMimeInfo(declared: Array<{ type: string; comment: string; glob: string }>): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
${declared.map((d) => `  <mime-type type="${esc(d.type)}">\n    <comment>${esc(d.comment)}</comment>\n    <glob pattern="${esc(d.glob)}"/>\n  </mime-type>`).join("\n")}
</mime-info>
`;
}

export function desktopEntry(c: ResolvedConfig, exe: string, hasIcon: boolean): string {
  const mime = [...(c.schemes ?? []).map((s) => `x-scheme-handler/${s}`), ...linuxFileTypes(c).mimes].map((m) => `${m};`).join("");
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${c.appName}`,
    // Relative on purpose: the directory is relocatable (AppImage runs it from AppRun).
    `Exec=${exe}${c.schemes?.length || c.fileTypes?.length ? " %U" : ""}`,
    `Icon=${hasIcon ? c.identifier : "application-x-executable"}`,
    "Terminal=false",
    "Categories=Utility;",
    `StartupWMClass=${c.identifier}`,
    // The notifications backend names this entry (hint "desktop-entry", Unity badge URI);
    // GNOME lists the app in its notification settings with this key.
    "X-GNOME-UsesNotifications=true",
    `X-AppVersion=${c.version}`,
    ...(mime ? [`MimeType=${mime}`] : []),
    ...(c.copyright ? [`Comment=${c.copyright}`] : []),
  ];
  return lines.join("\n") + "\n";
}

export async function packageLinux(c: ResolvedConfig, stage: string): Promise<PackageResult> {
  const t0 = performance.now();
  const arch: Arch = c.build?.targetArch ?? (process.platform === "linux" ? hostArch : "x64");
  const dist = resolve(c.root, c.build?.outDir ?? ".desktop/dist");
  const work = resolve(dist, "..", "work", `linux-${arch}`);
  mkdirSync(dist, { recursive: true });
  mkdirSync(work, { recursive: true });
  const exe = linuxExeName(c.appName);

  // 1. executable
  const exeOut = join(work, exe);
  await compile(c, stage, exeOut, arch);

  // 2. app directory
  const app = join(dist, c.appName);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "lib"), { recursive: true });
  copyFileSync(exeOut, join(app, exe));
  chmodSync(join(app, exe), 0o755);
  copyFileSync(await ensureLibshell(arch, "linux"), join(app, "lib", "libshell.so"));
  const plugin = await buildLinuxPlugin(c, arch, join(work, "native"));
  if (plugin) copyFileSync(plugin, join(app, "lib", "libapp-native.so"));
  const addons = await buildLinuxAddons(c, arch, join(work, "addons"));
  if (Object.keys(addons).length) {
    mkdirSync(join(app, "lib", "addons"), { recursive: true });
    for (const [name, file] of Object.entries(addons)) copyFileSync(file, join(app, "lib", "addons", `${name}.node`));
  }
  for (const [name, from] of sidecarEntries(c, "linux")) {
    if (!existsSync(from)) throw new Error(`sidecar "${name}": ${from} not found`);
    copyFileSync(from, join(app, name));
    chmodSync(join(app, name), 0o755);
  }
  const hasIcon = !!c.icon && existsSync(c.icon) && c.icon.endsWith(".png");
  if (hasIcon) copyFileSync(c.icon!, join(app, `${c.identifier}.png`));
  else if (c.icon) warn(`icon: ${c.icon} is not a PNG (skipped)`);
  writeFileSync(join(app, `${c.identifier}.desktop`), desktopEntry(c, exe, hasIcon));
  // Desktop integration (appimaged, AppImageLauncher, distro packages) reads share/: the entry and,
  // for file types without a common MIME type, a shared-mime-info package.
  mkdirSync(join(app, "share", "applications"), { recursive: true });
  writeFileSync(join(app, "share", "applications", `${c.identifier}.desktop`), desktopEntry(c, exe, hasIcon));
  const { declared } = linuxFileTypes(c);
  if (declared.length) {
    mkdirSync(join(app, "share", "mime", "packages"), { recursive: true });
    writeFileSync(join(app, "share", "mime", "packages", `${c.identifier}.xml`), sharedMimeInfo(declared));
  }
  log(`${c.appName}/  executable ${mb(join(app, exe))} (linux-${arch})${plugin ? " + plugin" : ""}${Object.keys(addons).length ? ` + ${Object.keys(addons).length} addon(s)` : ""}`);

  // 3. archives
  const tag = `${exe}-${c.version}-linux-${arch}`;
  const result: PackageResult = { app, signed: "ad-hoc", notarized: false, arches: [arch], artifacts: [] };
  const tgz = join(dist, `${tag}.tar.gz`);
  rmSync(tgz, { force: true });
  await $`tar -czf ${tgz} -C ${dist} ${c.appName}`.quiet();
  result.artifacts!.push(tgz);
  log(`tar.gz  ${mb(tgz)}`);

  const appimagetool = Bun.which("appimagetool");
  if (appimagetool) {
    const appDir = join(work, "AppDir");
    rmSync(appDir, { recursive: true, force: true });
    await $`cp -a ${app} ${appDir}`.quiet();
    writeFileSync(join(appDir, "AppRun"), `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/${exe}" "$@"\n`);
    chmodSync(join(appDir, "AppRun"), 0o755);
    if (hasIcon) copyFileSync(join(app, `${c.identifier}.png`), join(appDir, ".DirIcon"));
    else writeFileSync(join(appDir, "application-x-executable.png"), Buffer.from(PNG_1x1, "base64")); // appimagetool insists on the Icon= file
    const image = join(dist, `${tag}.AppImage`);
    rmSync(image, { force: true });
    const runtime = process.env.APPIMAGE_RUNTIME && existsSync(process.env.APPIMAGE_RUNTIME) ? ["--runtime-file", process.env.APPIMAGE_RUNTIME] : [];
    const r = await $`${appimagetool} -n ${runtime} ${appDir} ${image}`
      .env({ ...process.env, ARCH: arch === "arm64" ? "aarch64" : "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" })
      .nothrow()
      .quiet();
    if (r.exitCode === 0 && existsSync(image)) {
      result.artifacts!.push(image);
      log(`AppImage  ${mb(image)} (uses the system GTK 3 / WebKitGTK 4.1)`);
    } else warn(`AppImage: appimagetool failed (${r.exitCode}): ${r.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
  } else {
    log("AppImage  skipped (appimagetool not in PATH)");
  }

  // 4. release artifacts for the updater (key linux-<arch>)
  if (c.update) result.release = await writeRelease(c, app, [arch], dist, "linux");

  const size = Number((await $`du -sk ${app}`.text()).split("\t")[0]) / 1024;
  console.log(`\n  \x1b[32m✓\x1b[0m ${app} (${size.toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}
