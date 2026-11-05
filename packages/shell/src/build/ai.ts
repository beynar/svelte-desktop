// libshell-ai: host.ai's native side on macOS (native/sdk/ai/AppleIntelligence.swift, built with
// the Swift plugin SDK), loaded with the app's plugins. FoundationModels is weak-linked: the
// library loads on any macOS the shell supports, and host.ai says `unsupported` before macOS 26.
// Built next to libshell (native/build/darwin-<arch>/), again when its sources change.
import { $ } from "bun";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Arch } from "./package.ts";

const NATIVE = resolve(import.meta.dir, "../../native");
const SOURCES = [join(NATIVE, "sdk/ai/AppleIntelligence.swift"), join(NATIVE, "include/Kitop.swift"), join(NATIVE, "include/kitop.h")];
export const AI_LIB = "libshell-ai.dylib";

/** The library for `arch`, or null when it can't be built here (no Swift toolchain). */
export async function ensureAiPlugin(arch: Arch, warn?: (m: string) => void): Promise<string | null> {
  const prebuilt = process.env[`KITOP_LIBSHELL_AI_${arch.toUpperCase()}`] ?? process.env.KITOP_LIBSHELL_AI;
  if (prebuilt) return prebuilt;
  if (process.platform !== "darwin") return null;
  const out = join(NATIVE, "build", `darwin-${arch === "arm64" ? "arm64" : "x86_64"}`, AI_LIB);
  const newest = Math.max(...SOURCES.map((f) => statSync(f).mtimeMs));
  if (existsSync(out) && statSync(out).mtimeMs >= newest) return out;
  if (!Bun.which("swiftc")) {
    warn?.("host.ai: swiftc not found (Xcode command-line tools) — the on-device model is unavailable in this build");
    return null;
  }
  mkdirSync(dirname(out), { recursive: true });
  const target = `${arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`;
  const r = await $`swiftc -emit-library -module-name ShellAI -swift-version 5 -O -target ${target} -import-objc-header ${SOURCES[2]} ${SOURCES[0]} ${SOURCES[1]} -framework Cocoa -Xlinker -weak_framework -Xlinker FoundationModels -Xlinker -install_name -Xlinker @rpath/${AI_LIB} -o ${out}`
    .nothrow()
    .quiet();
  if (r.exitCode !== 0) {
    warn?.(`host.ai: building ${AI_LIB} failed — the on-device model is unavailable in this build\n${r.stderr.toString().trim().split("\n").slice(-10).join("\n")}`);
    return null;
  }
  return out;
}
