// Native plugins in Rust and Go: native/rust (a cargo crate, `crate-type = ["cdylib"]`) and
// native/go (a Go main package) are built into shared libraries the shell loads next to
// libapp-native, with the SDKs in native/sdk/{rust,go} (the plugin ABI of
// native/include/svelte_desktop.h). Their commands are reached with `native` (src/native.ts),
// typed by native-types.ts.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import type { Arch } from "./package.ts";

export type Language = "rust" | "go";
export type PluginOS = "macos" | "linux" | "windows";

const EXT: Record<PluginOS, string> = { macos: "dylib", linux: "so", windows: "dll" };
const RUST_TRIPLE: Record<PluginOS, Record<Arch, string>> = {
  macos: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
  windows: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
};
const GOOS: Record<PluginOS, string> = { macos: "darwin", linux: "linux", windows: "windows" };
const GOARCH: Record<Arch, string> = { arm64: "arm64", x64: "amd64" };

export const hostOS = (): PluginOS => (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos");

/** The plugin library's file name: libapp-rust.dylib, app-go.dll… */
export const pluginFile = (lang: Language, os: PluginOS) => `${os === "windows" ? "" : "lib"}app-${lang}.${EXT[os]}`;

/** The languages the app has a plugin in: native/rust/Cargo.toml, native/go/go.mod. */
export function languagePlugins(c: Pick<ResolvedConfig, "native">): Language[] {
  if (!c.native) return [];
  return (["rust", "go"] as const).filter((l) => existsSync(join(c.native!, l, l === "rust" ? "Cargo.toml" : "go.mod")));
}

/** Build every language plugin for `os` (the host's only: their toolchains don't cross-compile
 *  a C-ABI library out of the box). Returns the libraries, universal on macOS with two arches. */
export async function buildLanguagePlugins(
  c: ResolvedConfig,
  opts: { os: PluginOS; arches: Arch[]; outDir: string; release: boolean; warn?: (m: string) => void },
): Promise<string[]> {
  const langs = languagePlugins(c);
  if (!langs.length) return [];
  if (opts.os !== hostOS()) {
    opts.warn?.(`native/${langs.join(", native/")}: Rust and Go plugins are built on a ${opts.os} host (skipped)`);
    return [];
  }
  mkdirSync(opts.outDir, { recursive: true });
  const out: string[] = [];
  for (const lang of langs) {
    const slices: string[] = [];
    for (const arch of opts.arches) slices.push(lang === "rust" ? await buildRust(c, opts.os, arch, opts.release) : await buildGo(c, opts.os, arch, opts.outDir, opts.release));
    const lib = join(opts.outDir, pluginFile(lang, opts.os));
    if (slices.length > 1) await $`lipo -create ${slices} -output ${lib}`.quiet();
    else if (slices[0] !== lib) copyFileSync(slices[0]!, lib);
    out.push(lib);
  }
  return out;
}

async function buildRust(c: ResolvedConfig, os: PluginOS, arch: Arch, release: boolean): Promise<string> {
  const manifest = join(c.native!, "rust", "Cargo.toml");
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
    throw new Error(`native/rust: cargo build failed${hint}\n${err.trim().split("\n").slice(-30).join("\n")}`);
  }
  for (const line of r.stdout.toString().split("\n")) {
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line) as { reason?: string; target?: { kind?: string[] }; filenames?: string[]; manifest_path?: string };
    if (m.reason !== "compiler-artifact" || !m.target?.kind?.includes("cdylib") || resolve(m.manifest_path ?? "") !== resolve(manifest)) continue;
    const lib = m.filenames?.find((f) => f.endsWith(`.${EXT[os]}`));
    if (lib) return lib;
  }
  throw new Error('native/rust: no library built — set `[lib] crate-type = ["cdylib"]` in native/rust/Cargo.toml');
}

async function buildGo(c: ResolvedConfig, os: PluginOS, arch: Arch, outDir: string, release: boolean): Promise<string> {
  const out = join(outDir, `go-${arch}.${EXT[os]}`);
  const min = os === "macos" ? `-mmacosx-version-min=${c.build?.minimumSystemVersion ?? "12.0"}` : "";
  const env = { ...process.env, CGO_ENABLED: "1", GOOS: GOOS[os], GOARCH: GOARCH[arch], CGO_CFLAGS: min, CGO_LDFLAGS: min };
  const r = await $`go build -buildmode=c-shared -trimpath ${release ? ["-ldflags=-s -w"] : []} -o ${out} .`.cwd(join(c.native!, "go")).env(env).nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`native/go: go build failed\n${r.stderr.toString().trim().split("\n").slice(-30).join("\n")}`);
  return out;
}
