import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logCrash, shouldLogToFile } from "./logging.ts";

const saved = { log: process.env.KITOP_LOG, test: process.env.KITOP_TEST, tty: process.stdout.isTTY, ppid: process.ppid };
afterEach(() => {
  process.env.KITOP_LOG = saved.log;
  if (saved.log === undefined) delete process.env.KITOP_LOG;
  process.env.KITOP_TEST = saved.test;
  if (saved.test === undefined) delete process.env.KITOP_TEST;
  process.stdout.isTTY = saved.tty;
});

test("no terminal means the log file, whatever started the app", () => {
  delete process.env.KITOP_LOG;
  delete process.env.KITOP_TEST;
  // A desktop launcher on Linux: the parent is the session manager, not pid 1.
  process.stdout.isTTY = false as any;
  expect(process.ppid).not.toBe(1);
  expect(shouldLogToFile()).toBe(true);
  process.stdout.isTTY = true as any;
  expect(shouldLogToFile()).toBe(false);
});

test("KITOP_LOG forces either, and launch() reads the app's stdout", () => {
  process.stdout.isTTY = false as any;
  process.env.KITOP_LOG = "stdout";
  expect(shouldLogToFile()).toBe(false);
  process.stdout.isTTY = true as any;
  process.env.KITOP_LOG = "file";
  expect(shouldLogToFile()).toBe(true);
  delete process.env.KITOP_LOG;
  process.stdout.isTTY = false as any;
  process.env.KITOP_TEST = "ws://127.0.0.1:1";
  expect(shouldLogToFile()).toBe(false);
});

test("a crash reaches the file even when the console stays on the terminal, in a folder not made yet", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sd-log-")), "not", "yet", "app.log");
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  logCrash(file, "supervisor", "boom");
  quiet.mockRestore();
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toMatch(/\[supervisor\] fatal boom\n$/);
});
