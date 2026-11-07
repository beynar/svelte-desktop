// THIRD_PARTY_NOTICES.txt, next to the app: the licenses of what it ships that isn't its own. The Bun
// runtime inside the executable, whose license names what it links (JavaScriptCore under the LGPL among
// them), kitop, the libraries the native shell is compiled from, and every npm package with code in the
// pages or the server, read from that package's own files at build time. The system's web view (WebKit,
// WebKitGTK, WebView2) isn't in the app: the OS provides it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";
/** The Bun whose LICENSE.md is in licenses/bun.md: the one CI builds with. */
const BUN_LICENSE_VERSION = "1.4.4";
const shellRoot = resolve(import.meta.dir, "../..");
const native = join(shellRoot, "native");

const MODULES = Symbol.for("kitop.shipped-modules");
/** Module paths the build put in the app: the Vite builds' chunks, the job bundles, the compiled executable. */
export function shippedModules(): Set<string> {
  return ((globalThis as Record<symbol, Set<string>>)[MODULES] ??= new Set());
}

/** Every input of a Bun metafile, as an absolute path (they're relative to where Bun ran). The
 *  command line writes JSON, `Bun.build` gives the object. */
export function metafileInputs(metafile: string | { inputs?: object }, cwd: string): string[] {
  const meta = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
  return Object.keys(meta.inputs ?? {}).map((p) => resolve(cwd, p));
}

/** The package folders module paths come from: the package after the last node_modules/. */
export function packageDirs(modules: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const id of modules) {
    const path = id.replace(/^\0/, "").split("?")[0]!.replaceAll("\\", "/");
    const at = path.lastIndexOf("/node_modules/") + "/node_modules/".length;
    if (at < "/node_modules/".length) continue;
    const parts = path.slice(at).split("/");
    dirs.add(path.slice(0, at) + (parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]));
  }
  return [...dirs];
}

interface Notice {
  name: string;
  license: string;
  text: string;
}

/** A package's name, version, declared license and license file. */
function packageNotice(dir: string): Notice | null {
  if (!existsSync(join(dir, "package.json"))) return null;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)([.-]|$)/i.test(f));
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l: { type: string }) => l.type).join(" OR ") ?? "not stated");
  return { name: `${pkg.name ?? basename(dir)} ${pkg.version ?? ""}`.trim(), license, text: file ? readFileSync(join(dir, file), "utf8") : `(${pkg.name} has no license file; its package.json says ${license})` };
}

const read = (file: string) => readFileSync(file, "utf8");

/** The notices for an app built for `target`, from what the build recorded. */
export function thirdPartyNotices(o: { appName: string; target: "macos" | "linux" | "windows"; bunVersion: string; modules: Iterable<string>; addons: boolean }): string {
  const own = [
    { name: `Bun ${o.bunVersion}, the runtime in the executable`, license: "MIT, and what it links", text: (o.bunVersion === BUN_LICENSE_VERSION ? "" : `(Bun ${BUN_LICENSE_VERSION}'s LICENSE.md)\n\n`) + read(join(import.meta.dir, "licenses", "bun.md")) },
    { name: `@kitop/shell ${JSON.parse(read(join(shellRoot, "package.json"))).version}, the framework`, license: "MIT", text: read(join(shellRoot, "LICENSE")) },
    { name: "JSON for Modern C++ (nlohmann/json), in the native shell", license: "MIT", text: read(join(native, "portable", "vendor", "LICENSE.nlohmann")) },
    ...(o.target === "macos" ? [{ name: "webview/webview, in the native shell", license: "MIT", text: read(join(native, "vendor", "webview", "LICENSE")) }] : []),
    ...(o.target === "windows" ? [{ name: "Microsoft WebView2 SDK headers, in the native shell", license: "BSD-3-Clause", text: read(join(import.meta.dir, "licenses", "webview2-sdk.txt")) }] : []),
    ...(o.addons ? [{ name: "Node-API headers, in the native addons", license: "MIT", text: read(join(native, "vendor", "node-api", "LICENSE")) }] : []),
  ];
  // kitop's own files are above; its dependencies are packages like the app's.
  const packages = packageDirs(o.modules)
    .filter((dir) => resolve(dir) !== shellRoot)
    .map(packageNotice)
    .filter((n): n is Notice => !!n);
  const unique = [...new Map(packages.map((n) => [n.name, n])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const rule = "=".repeat(78);
  const web = { macos: "WKWebView, part of macOS", linux: "WebKitGTK, installed with the system", windows: "the WebView2 runtime, part of Windows or installed with it" }[o.target];
  return [
    `${o.appName} includes the software below, under the licenses that follow. Its web view is ${web}: it isn't in the app.`,
    "",
    ...[...own, ...unique].flatMap((n) => [rule, `${n.name} (${n.license})`, rule, "", n.text.trim(), ""]),
  ].join("\n");
}

/** THIRD_PARTY_NOTICES.txt in `dir`, the folder that ships, for what this build recorded. */
export function writeNotices(c: ResolvedConfig, dir: string, target: "macos" | "linux" | "windows", addons: boolean): void {
  const bun = c.build?.bun ?? process.env.KITOP_BUN ?? process.execPath;
  const bunVersion = Bun.spawnSync([bun, "--version"]).stdout.toString().trim();
  writeFileSync(join(dir, NOTICES_FILE), thirdPartyNotices({ appName: c.appName, target, bunVersion, modules: shippedModules(), addons }));
}
