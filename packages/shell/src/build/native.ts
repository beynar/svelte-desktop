// Compiles an app's native plugin folder (Swift / Objective-C / C / C++) into
// libapp-native.dylib against native/include/svelte_desktop.h. Frameworks are
// autolinked from `import X` (Swift) and `@import X;` (Objective-C modules).
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import type { Arch } from "./package.ts";

const include = resolve(import.meta.dir, "../../native/include");

const PLATFORM_DIRS = ["macos", "linux", "windows", "android", "ios"] as const;
export type PluginPlatform = (typeof PLATFORM_DIRS)[number];

/** Plugin sources under native/ for one platform: everything except addons/ (Node-API
 *  addons) and sidecars/ (executables), built separately, and the other platforms'
 *  folders (native/<platform>/). */
export function pluginSources(dir: string, platform: PluginPlatform): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "addons" || entry.name === "sidecars") continue; // built separately
      if ((PLATFORM_DIRS as readonly string[]).includes(entry.name) && entry.name !== platform) continue;
      out.push(...pluginSources(p, platform));
    } else if (/\.(swift|m|mm|c|cc|cpp)$/.test(entry.name)) out.push(p);
  }
  return out;
}
const sources = (dir: string) => pluginSources(dir, "macos");

export async function buildNativePlugin(
  c: ResolvedConfig,
  opts: { arches: Arch[]; outDir: string; quiet?: boolean },
): Promise<string | null> {
  if (!c.native) return null;
  // Linux hosts (e.g. `vite dev` on Linux): C/C++ plugins via the host compiler.
  if (process.platform === "linux") return (await import("./package-linux.ts")).buildLinuxPlugin(c, opts.arches[0]!, opts.outDir);
  const files = sources(c.native);
  if (!files.length) return null;
  mkdirSync(opts.outDir, { recursive: true });
  // Cache per architecture set: a universal build must not reuse a single-arch dylib.
  const out = join(opts.outDir, `libapp-native-${opts.arches.join("+")}.dylib`);
  const newest = Math.max(...[...files, ...readdirSync(include).map((f) => join(include, f))].map((f) => statSync(f).mtimeMs));
  if (existsSync(out) && statSync(out).mtimeMs > newest) return out;

  const swift = files.filter((f) => f.endsWith(".swift"));
  const clangSrc = files.filter((f) => !f.endsWith(".swift"));
  const min = c.build?.minimumSystemVersion ?? "12.0";
  if (!opts.quiet) console.log(`  \x1b[36m▸\x1b[0m native plugin: ${files.map((f) => relative(c.root, f)).join(", ")}`);

  const slices: string[] = [];
  for (const arch of opts.arches) {
    const clangArch = arch === "arm64" ? "arm64" : "x86_64";
    const objDir = join(opts.outDir, `obj-${arch}`);
    mkdirSync(objDir, { recursive: true });
    const objs: string[] = [];
    // The ObjC layer provides sd_plugin_init only for Swift-less plugins.
    const helpers = swift.length ? [] : [join(include, "SvelteDesktop.m")];
    for (const src of [...clangSrc, ...helpers]) {
      const obj = join(objDir, `${relative(c.native, src).replace(/[\/.]/g, "_")}.o`);
      const lang = /\.(m|mm)$/.test(src) ? ["-fobjc-arc", "-fmodules"] : [];
      const std = /\.(mm|cc|cpp)$/.test(src) ? ["-std=c++17"] : /\.c$/.test(src) ? ["-std=c17"] : [];
      const r = await $`clang -c -arch ${clangArch} -mmacosx-version-min=${min} -O2 -fvisibility=default -I${include} ${lang} ${std} ${src} -o ${obj}`.nothrow().quiet();
      if (r.exitCode !== 0) throw new Error(`native plugin: ${relative(c.root, src)}\n${r.stderr.toString()}`);
      objs.push(obj);
    }
    const slice = join(objDir, "libapp-native.dylib");
    const r = swift.length
      ? await $`swiftc -emit-library -module-name AppNative -swift-version 5 -O -target ${clangArch}-apple-macos${min} -import-objc-header ${join(include, "svelte_desktop.h")} ${swift} ${join(include, "SvelteDesktop.swift")} ${objs} -framework Cocoa -Xlinker -install_name -Xlinker @rpath/libapp-native.dylib -o ${slice}`.nothrow().quiet()
      : await $`clang -dynamiclib -arch ${clangArch} -mmacosx-version-min=${min} ${objs} -framework Cocoa -install_name @rpath/libapp-native.dylib -o ${slice}`.nothrow().quiet();
    if (r.exitCode !== 0) throw new Error(`native plugin link failed (${arch}):\n${r.stderr.toString()}${r.stdout.toString()}`);
    slices.push(slice);
  }
  if (slices.length > 1) await $`lipo -create ${slices} -output ${out}`.quiet();
  else await $`cp ${slices[0]} ${out}`.quiet();
  return out;
}

/** Node-API addons: native/addons/<name>.(c|cc|cpp|m|mm) → <name>.node (Bun implements Node-API). */
export async function buildAddons(
  c: ResolvedConfig,
  opts: { arches: Arch[]; outDir: string; quiet?: boolean },
): Promise<Record<string, string>> {
  if (process.platform === "linux") return (await import("./package-linux.ts")).buildLinuxAddons(c, opts.arches[0]!, opts.outDir);
  const out: Record<string, string> = {};
  const napi = resolve(import.meta.dir, "../../native/vendor/node-api/include");
  const dir = c.native ? join(c.native, "addons") : null;
  if (dir && existsSync(dir)) {
    mkdirSync(opts.outDir, { recursive: true });
    for (const entry of readdirSync(dir).filter((f) => /\.(c|cc|cpp|m|mm)$/.test(f))) {
      const name = entry.replace(/\.[^.]+$/, "");
      const src = join(dir, entry);
      const target = join(opts.outDir, `${name}-${opts.arches.join("+")}.node`);
      if (!(existsSync(target) && statSync(target).mtimeMs > statSync(src).mtimeMs)) {
        if (!opts.quiet) console.log(`  \x1b[36m▸\x1b[0m addon: ${relative(c.root, src)}`);
        const archFlags = opts.arches.flatMap((a) => ["-arch", a === "arm64" ? "arm64" : "x86_64"]);
        const lang = /\.(m|mm)$/.test(entry) ? ["-fobjc-arc", "-fmodules"] : [];
        const std = /\.(cc|cpp|mm)$/.test(entry) ? ["-std=c++17", "-lc++"] : [];
        // -undefined dynamic_lookup: napi_* symbols come from the host runtime (Bun).
        const r = await $`clang -bundle -undefined dynamic_lookup ${archFlags} -mmacosx-version-min=${c.build?.minimumSystemVersion ?? "12.0"} -O2 -I${napi} ${lang} ${std} ${src} -o ${target}`.nothrow().quiet();
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
