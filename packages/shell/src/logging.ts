// Production logging. An app started from Finder/Dock/`open` (parent = launchd),
// a desktop launcher (Linux) or Explorer (Windows) has no terminal: console
// output and uncaught errors from both threads go to <logs>/app.log (see
// os.ts appDirs; rotated at 5 MB, one previous file kept).
// SVELTE_DESKTOP_LOG=stdout keeps the terminal; =file forces the file.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appDirs } from "./os.ts";
import { join } from "node:path";
import { format } from "node:util";

export function logFilePath(identifier: string): string {
  return join(appDirs(identifier).logs, "app.log");
}

export function shouldLogToFile(): boolean {
  const mode = process.env.SVELTE_DESKTOP_LOG;
  if (mode === "stdout") return false;
  if (mode === "file") return true;
  if (process.platform === "win32") return !process.stdout.isTTY && !process.env.SVELTE_DESKTOP_TEST;
  return process.ppid === 1;
}

export function redirectConsole(file: string, thread: "main" | "worker") {
  mkdirSync(join(file, ".."), { recursive: true });
  try {
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {}
  const write = (level: string, args: unknown[]) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} [${thread}] ${level} ${format(...args)}\n`);
    } catch {}
  };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    (console as any)[level] = (...args: unknown[]) => write(level, args);
  }
  process.on("uncaughtException", (err) => write("fatal", [err?.stack ?? err]));
  process.on("unhandledRejection", (err: any) => write("unhandled", [err?.stack ?? err]));
}
