// Dev shell, UI thread: spawned by the Vite plugin during `vite dev`. Same
// window/native layer as the built app; the page is the Vite dev server.
import { runShell } from "../main.ts";
import type { ShellOptions } from "../types.ts";

const cfg = JSON.parse(process.env.SVELTE_DESKTOP_DEV ?? "{}") as Omit<ShellOptions, "createWorker"> & { url: string };
await runShell({
  ...cfg,
  window: cfg.window === false ? false : { debug: true, readyTimeoutMs: 8000, ...cfg.window },
  createWorker: () => new Worker(new URL("./worker.ts", import.meta.url).href),
});
