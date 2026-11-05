// Crash reporting, without a crash reporter process: on start, tell the app
// whether the previous run ended uncleanly (a marker written at launch and
// removed on a graceful quit) and which OS crash reports appeared since then
// (macOS ~/Library/Logs/DiagnosticReports/<exe>-*.ips, Windows
// %LOCALAPPDATA%\CrashDumps\<exe>.*.dmp). Upload them wherever you like.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const MAX_ERROR = 16 * 1024;
// A server that keeps dying stops being restarted: more than RESTART_LIMIT restarts in the window.
export const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 5 * 60_000;
const RESTART_DELAYS_MS = [0, 1000, 3000];

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
  /** What ended the previous run's server, when it was a JavaScript error or an exit nobody asked for. */
  lastError: { message: string; time: number } | null;
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

/** OS reports for this executable; collection does not change launch tracking. */
export function findCrashReports(exe: string, since = 0): CrashReport[] {
  const where = reportDir();
  if (!where || !existsSync(where.dir)) return [];
  const reports: CrashReport[] = [];
  for (const file of readdirSync(where.dir)) {
    if (!where.match(file, exe)) continue;
    const path = join(where.dir, file);
    try {
      const stat = statSync(path);
      if (stat.isFile() && stat.mtimeMs >= since) reports.push({ path, time: stat.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return reports.sort((a, b) => a.time - b.time);
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
  const reports = previousLaunch ? findCrashReports(exe, previousLaunch) : [];
  const lastError = readLastError(dataDir);
  // A server dying while it loads leaves no marker: it hadn't got as far as writing one.
  if (lastError) uncleanExit = true;
  writeFileSync(marker, String(process.pid));
  writeFileSync(launches, String(Date.now()));
  return { uncleanExit, previousLaunch, reports, lastError };
}

function readLastError(dataDir: string): CrashInfo["lastError"] {
  const file = join(dataDir, ".last-error");
  try {
    const { message, time } = JSON.parse(readFileSync(file, "utf8"));
    return typeof message === "string" && typeof time === "number" ? { message, time } : null;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

/** The server died: what the next start's `crashInfo()` reports. */
export function recordCrash(dataDir: string, message: string, time = Date.now()) {
  writeFileSync(join(dataDir, ".last-error"), JSON.stringify({ message: message.slice(0, MAX_ERROR), time }));
}

/** Graceful quit: the next start won't report an unclean exit. */
export function endCrashTracking(dataDir: string) {
  rmSync(join(dataDir, ".running"), { force: true });
}

/**
 * The server died: how long to wait before restarting the app, or null to stop trying. On disk,
 * since each restart is a new process. Giving up starts over: the next launch is the user asking.
 */
export function nextRestart(dataDir: string, now = Date.now()): number | null {
  const file = join(dataDir, ".crash-restarts");
  let times: number[] = [];
  try {
    times = (JSON.parse(readFileSync(file, "utf8")) as number[]).filter((t) => now - t < RESTART_WINDOW_MS);
  } catch {}
  if (times.length >= RESTART_LIMIT) {
    rmSync(file, { force: true });
    return null;
  }
  writeFileSync(file, JSON.stringify([...times, now]));
  return RESTART_DELAYS_MS[times.length]!;
}
