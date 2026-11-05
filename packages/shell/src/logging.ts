// Production logging. An app started from Finder/Dock/`open`, a desktop launcher
// (Linux) or Explorer (Windows) has no terminal: console output goes to
// <logs>/app.log (see os.ts appDirs; rotated at 5 MB, one previous file kept).
// KITOP_LOG=stdout keeps the terminal; =file forces the file. A crash is written
// to the file in every case: the terminal may be gone by the time anyone looks.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appDirs } from "./os.ts";
import { dirname, join } from "node:path";
import { format } from "node:util";

export function logFilePath(identifier: string): string {
  return join(appDirs(identifier).logs, "app.log");
}

export function shouldLogToFile(): boolean {
  const mode = process.env.KITOP_LOG;
  if (mode === "stdout") return false;
  if (mode === "file") return true;
  return !process.stdout.isTTY && !process.env.KITOP_TEST;
}

export function logCrash(file: string, thread: string, text: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} [${thread}] fatal ${text}\n`);
  } catch {}
  console.error(`[shell] ${text}`);
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
}
