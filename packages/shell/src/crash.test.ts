import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endCrashTracking, startCrashTracking } from "./crash.ts";

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
