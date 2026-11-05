import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCrashTracking } from "./crash.ts";
import { describeEnd, recordAndDecide } from "./supervisor.ts";

test("a first launch that died loading: its folder doesn't exist yet, and the crash is still recorded", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sd-sup-")), "not", "yet");
  let failed: unknown;
  expect(recordAndDecide(dir, "error: boom", (err) => (failed = err))).toBe(0);
  expect(failed).toBeUndefined();
  expect(startCrashTracking(dir, "App").lastError?.message).toBe("error: boom");
});

test("a crash that can't be written down doesn't restart: uncounted, the loop would never stop", () => {
  const blocked = join(mkdtempSync(join(tmpdir(), "sd-sup-")), "a-file");
  writeFileSync(blocked, "");
  let failed: unknown;
  expect(recordAndDecide(blocked, "error: boom", (err) => (failed = err))).toBeNull();
  expect(failed).toBeDefined();
});

test("an error or a non-zero exit restarts the app, with the reason", () => {
  expect(describeEnd(1, "error: boom")).toEqual({ end: "restart", message: "error: boom" });
  expect(describeEnd(3, undefined)).toEqual({ end: "restart", message: "the server exited with code 3" });
  // Bun reports a rejection nothing handled as an error with exit code 0: the error decides.
  expect(describeEnd(0, "error: rejected").end).toBe("restart");
});

test("process.exit(0) in server code quits the app, as it would quit any program", () => {
  expect(describeEnd(0, undefined).end).toBe("quit");
});
