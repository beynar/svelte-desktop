// Native plugins in Rust and Go, anywhere in native/ next to the Swift / Objective-C / C ones:
//   - a cargo crate (a folder with Cargo.toml, `crate-type = ["cdylib"]`) or a loose .rs file
//     (a whole crate in one file: the build writes its Cargo.toml, with the SDK, serde and ts-rs);
//   - a Go module (a folder with go.mod, a main package) or loose .go files (one package
//     together: the build writes its go.mod) — one Go plugin per app, as a process holds one Go
//     runtime.
// Each is built into a shared library the shell loads next to libapp-native, with the SDKs in
// native/sdk/{rust,go} (the plugin ABI of native/include/svelte_desktop.h). Their commands are
// reached with `native` (src/native.ts), typed by native-types.ts.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import type { Arch } from "./package.ts";

export type Language = "rust" | "go";
export type PluginOS = "macos" | "linux" | "windows";

/** A Rust or Go plugin: a crate / module folder, or loose files the build makes a project of. */
export interface LanguagePlugin {
  lang: Language;
  /** Names its library: libapp-<name>. */
  name: string;
  /** The folder with Cargo.toml / go.mod, when it's a project of its own. */
  dir?: string;
  /** Loose source files (no project of their own). */
  files?: string[];
}

const EXT: Record<PluginOS, string> = { macos: "dylib", linux: "so", windows: "dll" };
const RUST_TRIPLE: Record<PluginOS, Record<Arch, string>> = {
  macos: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
  windows: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
};
const GOOS: Record<PluginOS, string> = { macos: "darwin", linux: "linux", windows: "windows" };
const GOARCH: Record<Arch, string> = { arm64: "arm64", x64: "amd64" };
const SDK = resolve(import.meta.dir, "../../native/sdk");
/** Folders of native/ that aren't plugin sources. */
const SKIP = new Set(["addons", "sidecars", "target", "node_modules", "include", "python"]);
const PLATFORM_DIRS = ["macos", "linux", "windows"];

export const hostOS = (): PluginOS => (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos");

/** The plugin library's file name: libapp-rust.dylib, app-go.dll… */
export const pluginFile = (name: string, os: PluginOS) => `${os === "windows" ? "" : "lib"}app-${name}.${EXT[os]}`;

/** A folder of native/ that is a Rust crate or a Go module (Swift / C sources skip it). */
export const isLanguageProject = (dir: string) => existsSync(join(dir, "Cargo.toml")) || existsSync(join(dir, "go.mod"));

const slug = (s: string) => s.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "plugin";

/** The Rust and Go plugins in native/ (for `os`: the other platforms' folders are skipped). */
export function languagePlugins(c: Pick<ResolvedConfig, "native">, os: PluginOS = hostOS()): LanguagePlugin[] {
  if (!c.native || !existsSync(c.native)) return [];
  const root = c.native;
  const out: LanguagePlugin[] = [];
  const looseGo: string[] = [];
  const name = (lang: Language, path: string) => {
    const s = slug(relative(root, path).replace(/^(rust|go)$/, ""));
    return s === "plugin" || s === lang ? lang : `${lang}-${s}`;
  };
  const walk = (dir: string) => {
    if (dir !== root && existsSync(join(dir, "Cargo.toml"))) return void out.push({ lang: "rust", name: name("rust", dir), dir });
    if (dir !== root && existsSync(join(dir, "go.mod"))) return void out.push({ lang: "go", name: name("go", dir), dir });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || entry.name.startsWith(".") || (dir === root && PLATFORM_DIRS.includes(entry.name) && entry.name !== os)) continue;
        walk(p);
      } else if (entry.name.endsWith(".rs")) out.push({ lang: "rust", name: name("rust", p), files: [p] });
      else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) looseGo.push(p);
    }
  };
  // native/ itself may be the crate or the module.
  if (existsSync(join(root, "Cargo.toml"))) out.push({ lang: "rust", name: "rust", dir: root });
  else if (existsSync(join(root, "go.mod"))) out.push({ lang: "go", name: "go", dir: root });
  else walk(root);
  if (looseGo.length) out.push({ lang: "go", name: "go", files: looseGo.sort() });
  const go = out.filter((p) => p.lang === "go");
  if (go.length > 1)
    throw new Error(
      `native/: ${go.length} Go plugins (${go.map((p) => (p.dir ? relative(root, p.dir) || "." : "loose .go files")).join(", ")}) — a process holds one Go runtime: keep your Go code in one module, or loose files only`,
    );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Build every language plugin for `os` (the host's only: their toolchains don't cross-compile
 *  a C-ABI library out of the box). Returns the libraries, universal on macOS with two arches. */
export async function buildLanguagePlugins(
  c: ResolvedConfig,
  opts: { os: PluginOS; arches: Arch[]; outDir: string; release: boolean; warn?: (m: string) => void },
): Promise<string[]> {
  const plugins = languagePlugins(c, opts.os);
  if (!plugins.length) return [];
  if (opts.os !== hostOS()) {
    opts.warn?.(`native/: Rust and Go plugins (${plugins.map((p) => p.name).join(", ")}) are built on a ${opts.os} host (skipped)`);
    return [];
  }
  mkdirSync(opts.outDir, { recursive: true });
  const out: string[] = [];
  for (const plugin of plugins) {
    const slices: string[] = [];
    for (const arch of opts.arches)
      slices.push(plugin.lang === "rust" ? await buildRust(c, plugin, opts.os, arch, opts.release) : await buildGo(c, plugin, opts.os, arch, opts.outDir, opts.release));
    const lib = join(opts.outDir, pluginFile(plugin.name, opts.os));
    if (slices.length > 1) await $`lipo -create ${slices} -output ${lib}`.quiet();
    else if (slices[0] !== lib) copyFileSync(slices[0]!, lib);
    out.push(lib);
  }
  return out;
}

/** Where the build writes the projects of loose files (outside native/: the dev watcher restarts
 *  the window on changes there). */
const generated = (c: ResolvedConfig, plugin: LanguagePlugin) => join(c.root, ".desktop", "native-projects", plugin.name);
const label = (c: ResolvedConfig, plugin: LanguagePlugin) => relative(c.root, plugin.dir ?? plugin.files![0]!) || "native";

/** A loose .rs file's crate: the file is its lib.rs. */
function rustProject(c: ResolvedConfig, plugin: LanguagePlugin): string {
  if (plugin.dir) return join(plugin.dir, "Cargo.toml");
  const dir = generated(c, plugin);
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "Cargo.toml");
  const text = `# Written by svelte-desktop for ${relative(c.root, plugin.files![0]!)} — a crate of its own: put a Cargo.toml next to it for more dependencies.
[package]
name = "app-${plugin.name}"
version = "0.0.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]
path = ${JSON.stringify(plugin.files![0]!)}

[dependencies]
svelte-desktop = { path = ${JSON.stringify(join(SDK, "rust"))} }
serde = { version = "1", features = ["derive"] }
ts-rs = "12"

[workspace]
`;
  if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== text) writeFileSync(manifest, text);
  return manifest;
}

async function buildRust(c: ResolvedConfig, plugin: LanguagePlugin, os: PluginOS, arch: Arch, release: boolean): Promise<string> {
  const manifest = rustProject(c, plugin);
  const triple = RUST_TRIPLE[os][arch];
  const env = {
    ...process.env,
    // Outside native/: the dev watcher restarts the window on changes there.
    CARGO_TARGET_DIR: join(c.root, ".desktop", "cargo"),
    MACOSX_DEPLOYMENT_TARGET: c.build?.minimumSystemVersion ?? "12.0",
  };
  const r = await $`cargo build --manifest-path ${manifest} --target ${triple} --message-format=json-render-diagnostics ${release ? ["--release"] : []}`.env(env).nothrow().quiet();
  if (r.exitCode !== 0) {
    const err = r.stderr.toString();
    const hint = /target may not be installed|can't find crate for `(core|std)`/.test(err) ? `\n  → rustup target add ${triple}` : "";
    throw new Error(`${label(c, plugin)}: cargo build failed${hint}\n${err.trim().split("\n").slice(-30).join("\n")}`);
  }
  for (const line of r.stdout.toString().split("\n")) {
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line) as { reason?: string; target?: { kind?: string[] }; filenames?: string[]; manifest_path?: string };
    if (m.reason !== "compiler-artifact" || !m.target?.kind?.includes("cdylib") || resolve(m.manifest_path ?? "") !== resolve(manifest)) continue;
    const lib = m.filenames?.find((f) => f.endsWith(`.${EXT[os]}`));
    if (lib) return lib;
  }
  throw new Error(`${label(c, plugin)}: no library built — set \`[lib] crate-type = ["cdylib"]\` in its Cargo.toml`);
}

/** Loose .go files' module: links to them, a go.mod on the SDK, and main() unless one has it. */
function goProject(c: ResolvedConfig, plugin: LanguagePlugin): string {
  if (plugin.dir) return plugin.dir;
  const dir = generated(c, plugin);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "go.mod"),
    `// Written by svelte-desktop for the loose .go files of native/ — a module of their own: put a go.mod next to them for more dependencies.
module app-go

go 1.22

require svelte-desktop.dev/go/desktop v0.0.0

replace svelte-desktop.dev/go/desktop => ${join(SDK, "go")}
`,
  );
  let hasMain = false;
  for (const file of plugin.files!) {
    hasMain ||= /^func main\(\)/m.test(readFileSync(file, "utf8"));
    symlinkSync(file, join(dir, `${slug(relative(c.native!, file))}-${basename(file)}`));
  }
  if (!hasMain) writeFileSync(join(dir, "zz_main.go"), "package main\n\n// A c-shared library still needs a main package.\nfunc main() {}\n");
  return dir;
}

async function buildGo(c: ResolvedConfig, plugin: LanguagePlugin, os: PluginOS, arch: Arch, outDir: string, release: boolean): Promise<string> {
  const out = join(outDir, `${plugin.name}-${arch}.${EXT[os]}`);
  const min = os === "macos" ? `-mmacosx-version-min=${c.build?.minimumSystemVersion ?? "12.0"}` : "";
  const env = { ...process.env, CGO_ENABLED: "1", GOOS: GOOS[os], GOARCH: GOARCH[arch], CGO_CFLAGS: min, CGO_LDFLAGS: min };
  const r = await $`go build -buildmode=c-shared -trimpath ${release ? ["-ldflags=-s -w"] : []} -o ${out} .`.cwd(goProject(c, plugin)).env(env).nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`${label(c, plugin)}: go build failed\n${r.stderr.toString().trim().split("\n").slice(-30).join("\n")}`);
  return out;
}
