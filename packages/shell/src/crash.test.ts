import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endCrashTracking, nextRestart, recordCrash, RESTART_LIMIT, startCrashTracking } from "./crash.ts";

test("the error that ended the server is in the next start's info, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-crash-"));
  expect(startCrashTracking(dir, "App").lastError).toBeNull();
  recordCrash(dir, "error: boom", 1234);
  // Unclean, with no marker: a server that died while loading never wrote one.
  expect(startCrashTracking(dir, "App")).toMatchObject({ uncleanExit: true, lastError: { message: "error: boom", time: 1234 } });
  expect(startCrashTracking(dir, "App").lastError).toBeNull();
});

test("a broken record doesn't get in the way of a start", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-crash-"));
  writeFileSync(join(dir, ".last-error"), "{not json");
  expect(startCrashTracking(dir, "App").lastError).toBeNull();
});

test("restarts: later each time, a limit, and a fresh count after giving up or after a while", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-crash-"));
  const t = 1_000_000_000;
  expect(nextRestart(dir, t)).toBe(0);
  expect(nextRestart(dir, t + 1000)).toBe(1000);
  expect(nextRestart(dir, t + 2000)).toBe(3000);
  expect(RESTART_LIMIT).toBe(3);
  expect(nextRestart(dir, t + 3000)).toBeNull();
  // Giving up: launching it again is the user asking to try again.
  expect(nextRestart(dir, t + 4000)).toBe(0);

  const other = mkdtempSync(join(tmpdir(), "sd-crash-"));
  expect(nextRestart(other, t)).toBe(0);
  expect(nextRestart(other, t + 6 * 60_000)).toBe(0); // the old one no longer counts
});

test("a crash loop stops, each restart being a new process that only has the disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-crash-"));
  let restarts = 0;
  while (nextRestart(dir) !== null) {
    restarts++;
    expect(restarts).toBeLessThanOrEqual(RESTART_LIMIT);
  }
  expect(restarts).toBe(RESTART_LIMIT);
});

test("graceful quit → clean; no quit → unclean exit on the next start", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-crash-"));
  expect(startCrashTracking(dir, "App")).toMatchObject({ uncleanExit: false, previousLaunch: null, reports: [] });
  endCrashTracking(dir);
  expect(startCrashTracking(dir, "App").uncleanExit).toBe(false);
  // no endCrashTracking: the "previous run" (a dead pid) never quit
  writeFileSync(join(dir, ".running"), "999999");
  const info = startCrashTracking(dir, "App");
  expect(info.uncleanExit).toBe(true);
  expect(info.previousLaunch).toBeGreaterThan(0);
});

test.if(process.platform === "darwin")("macOS .ips reports since the previous launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-crash-"));
  const home = mkdtempSync(join(tmpdir(), "sd-home-"));
  const reports = join(home, "Library", "Logs", "DiagnosticReports");
  mkdirSync(reports, { recursive: true });
  const old = join(reports, "App-2020-01-01-000000.ips");
  writeFileSync(old, "{}");
  utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
  writeFileSync(join(dir, ".last-launch"), String(Date.now() - 1000));
  writeFileSync(join(reports, "App-2026-10-31-120000.ips"), "{}");
  writeFileSync(join(reports, "Other-2026-10-31-120000.ips"), "{}");
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const info = startCrashTracking(dir, "App");
    expect(info.reports.map((r) => r.path.split("/").pop())).toEqual(["App-2026-10-31-120000.ips"]);
  } finally {
    process.env.HOME = prev;
  }
});
