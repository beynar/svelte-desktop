// Crash reporting, without a crash reporter process: on start, tell the app
// whether the previous run ended uncleanly (a marker written at launch and
// removed on a graceful quit) and which OS crash reports appeared since then
// (macOS ~/Library/Logs/DiagnosticReports/<exe>-*.ips, Windows
// %LOCALAPPDATA%\CrashDumps\<exe>.*.dmp). Upload them wherever you like.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface CrashReport {
  /** Absolute path of the OS report (.ips on macOS, .dmp on Windows). */
  path: string;
  /** When it was written (ms since epoch). */
  time: number;
}

export interface CrashInfo {
  /** The previous run neither quit gracefully nor is still running. */
  uncleanExit: boolean;
  /** When the previous run started (ms), or null on first launch. */
  previousLaunch: number | null;
  /** OS crash reports for this app written since the previous launch. */
  reports: CrashReport[];
}

function reportDir(): { dir: string; match: (file: string, exe: string) => boolean } | null {
  if (process.platform === "darwin")
    return { dir: join(process.env.HOME || homedir(), "Library", "Logs", "DiagnosticReports"), match: (f, exe) => f.startsWith(`${exe}-`) && /\.(ips|crash)$/.test(f) };
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return { dir: join(local, "CrashDumps"), match: (f, exe) => f.toLowerCase().startsWith(`${exe.toLowerCase()}.`) && f.endsWith(".dmp") };
  }
  return null; // Linux: systemd-coredump / apport are system-wide and need privileges
}

/** Read the previous run's state and mark this one as running. Call once at startup. */
export function startCrashTracking(dataDir: string, exe = basename(process.execPath).replace(/\.exe$/i, "")): CrashInfo {
  const marker = join(dataDir, ".running");
  const launches = join(dataDir, ".last-launch");
  let uncleanExit = false;
  if (existsSync(marker)) {
    const pid = Number(readFileSync(marker, "utf8").trim());
    let alive = false;
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        alive = true; // another instance is running: not a crash
      }
    } catch {}
    uncleanExit = !alive;
  }
  const previousLaunch = existsSync(launches) ? Number(readFileSync(launches, "utf8").trim()) || null : null;
  const reports: CrashReport[] = [];
  const where = reportDir();
  if (where && previousLaunch && existsSync(where.dir)) {
    for (const f of readdirSync(where.dir)) {
      if (!where.match(f, exe)) continue;
      const path = join(where.dir, f);
      const time = statSync(path).mtimeMs;
      if (time >= previousLaunch) reports.push({ path, time });
    }
    reports.sort((a, b) => a.time - b.time);
  }
  writeFileSync(marker, String(process.pid));
  writeFileSync(launches, String(Date.now()));
  return { uncleanExit, previousLaunch, reports };
}

/** Graceful quit: the next start won't report an unclean exit. */
export function endCrashTracking(dataDir: string) {
  rmSync(join(dataDir, ".running"), { force: true });
}
