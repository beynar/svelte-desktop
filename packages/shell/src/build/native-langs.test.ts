import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languagePlugins, pluginFile } from "./native-langs.ts";
import { writeNativeTypes } from "./native-types.ts";

const tmp = mkdtempSync(join(tmpdir(), "sd-langs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("Rust and Go plugins anywhere in native/: crates, modules, loose files; library names per OS", () => {
  const native = join(tmp, "native");
  mkdirSync(join(native, "rust"), { recursive: true });
  mkdirSync(join(native, "go"), { recursive: true });
  expect(languagePlugins({ native })).toEqual([]);
  writeFileSync(join(native, "rust", "Cargo.toml"), "");
  writeFileSync(join(native, "go", "go.mod"), "");
  // The historical layout keeps its names (libapp-rust, libapp-go).
  expect(languagePlugins({ native }).map((p) => [p.lang, p.name])).toEqual([["go", "go"], ["rust", "rust"]]);
  // A crate anywhere, a loose .rs file (a crate of its own), the other platforms' folders skipped.
  mkdirSync(join(native, "text", "src"), { recursive: true });
  writeFileSync(join(native, "text", "Cargo.toml"), "");
  writeFileSync(join(native, "text", "src", "lib.rs"), "");
  writeFileSync(join(native, "stats.rs"), "");
  mkdirSync(join(native, "windows"), { recursive: true });
  writeFileSync(join(native, "windows", "only.rs"), "");
  expect(languagePlugins({ native }, "macos").map((p) => p.name)).toEqual(["go", "rust", "rust-stats", "rust-text"]);
  expect(languagePlugins({ native }, "windows").map((p) => p.name)).toContain("rust-windows-only");
  // Loose .go files next to a Go module: two Go runtimes in one process, refused.
  writeFileSync(join(native, "clock.go"), "package main");
  expect(() => languagePlugins({ native })).toThrow(/one Go runtime/);
  rmSync(join(native, "go"), { recursive: true });
  expect(languagePlugins({ native }).find((p) => p.lang === "go")).toEqual({ lang: "go", name: "go", files: [join(native, "clock.go")] });
  expect(languagePlugins({ native: null })).toEqual([]);
  expect([pluginFile("rust", "macos"), pluginFile("go", "linux"), pluginFile("rust-stats", "windows")]).toEqual(["libapp-rust.dylib", "libapp-go.so", "app-rust-stats.dll"]);
});

test("NativeModules: one entry per service, commands from every language, untyped ones unknown; rewritten only on change", async () => {
  const file = writeNativeTypes(tmp, [
    { language: "rust", commands: [{ service: "hello", op: "rust", args: "{ name: string }", result: "{ message: string }" }] },
    { language: "go", commands: [
      { service: "hello", op: "go", args: "{ name: string }", result: "{ message: string }" },
      { service: "clock", op: "now", args: null, result: "number" },
    ] },
    { language: "c", commands: [{ service: "legacy", op: "ping", args: null, result: "unknown", typed: false }] },
  ]);
  const text = readFileSync(file, "utf8");
  expect(file).toBe(join(tmp, "src", "native.d.ts"));
  expect(text).toContain("declare module '@kitop/shell/native'");
  expect(text).toContain('"hello": {\n\t\t\trust(args: { name: string }): Promise<{ message: string }>;\n\t\t\tgo(args: { name: string }): Promise<{ message: string }>;\n\t\t};');
  expect(text).toContain("now(): Promise<number>;"); // no arguments
  expect(text).toContain("ping(args?: Record<string, unknown>): Promise<unknown>;"); // untyped (C, ObjC)
  const before = statSync(file).mtimeMs;
  await Bun.sleep(5);
  writeNativeTypes(tmp, [
    { language: "rust", commands: [{ service: "hello", op: "rust", args: "{ name: string }", result: "{ message: string }" }] },
    { language: "go", commands: [
      { service: "hello", op: "go", args: "{ name: string }", result: "{ message: string }" },
      { service: "clock", op: "now", args: null, result: "number" },
    ] },
    { language: "c", commands: [{ service: "legacy", op: "ping", args: null, result: "unknown", typed: false }] },
  ]);
  expect(statSync(file).mtimeMs).toBe(before);
});
