// Where the main window opens: where its tabs were — the `start` path <WindowTabs> saves with them
// (userData/tabs-app.json) — so a launch lands on the restored tab instead of jumping to it.
import { join } from "node:path";
import { appDirs } from "./os.ts";

export async function startPath(identifier: string): Promise<string> {
  try {
    const saved = (await Bun.file(join(appDirs(identifier).data, "tabs-app.json")).json()) as { start?: unknown };
    return typeof saved.start === "string" && saved.start.startsWith("/") && !saved.start.startsWith("//") ? saved.start : "/";
  } catch {
    return "/";
  }
}
