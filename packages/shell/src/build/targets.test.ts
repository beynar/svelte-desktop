import { expect, test } from "bun:test";
import { viteRuns } from "./targets.ts";

test("no flag is the website, a flag is that target, and the rest goes to Vite", () => {
  expect(viteRuns("dev", [], "darwin")).toEqual([{ target: null, args: [], release: false }]);
  expect(viteRuns("dev", ["--mac", "--port", "4000"], "darwin")).toEqual([{ target: "macos", args: ["--port", "4000"], release: false }]);
  expect(viteRuns("build", ["--windows"], "darwin")).toEqual([{ target: "windows", args: [], release: false }]);
});

test("a build takes several targets, one after the other, once each", () => {
  expect(viteRuns("build", ["--mac", "--windows", "--linux", "--mac"], "darwin").map((r) => r.target)).toEqual(["macos", "windows", "linux"]);
});

test("--release is kitop's: it isn't for Vite, or for dev", () => {
  expect(viteRuns("build", ["--linux", "--release", "--mode", "x"], "linux")).toEqual([{ target: "linux", args: ["--mode", "x"], release: true }]);
  expect(() => viteRuns("dev", ["--release"], "darwin")).toThrow("goes with kitop build");
});

test("what this machine can't do says so", () => {
  expect(() => viteRuns("dev", ["--windows"], "darwin")).toThrow("needs Windows");
  expect(() => viteRuns("dev", ["--mac"], "linux")).toThrow("needs macOS");
  expect(() => viteRuns("dev", ["--mac", "--linux"], "darwin")).toThrow("one window");
  expect(() => viteRuns("build", ["--mac"], "win32")).toThrow("needs a Mac");
  expect(viteRuns("dev", ["--linux"], "linux")[0]!.target).toBe("linux");
  expect(viteRuns("dev", ["--windows"], "win32")[0]!.target).toBe("windows");
});
