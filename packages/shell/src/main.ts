// UI-thread half of the shell. Runs on Bun's main thread, which becomes the
// native UI thread: once shell_run() is entered, this thread's JS event loop is
// frozen until the run loop stops. Everything the app does happens in the Worker.
import { openNative, cstr } from "./ffi.ts";
import { logFilePath, redirectConsole, shouldLogToFile } from "./logging.ts";
import type { InitMessage, ShellOptions } from "./types.ts";

export async function runShell(opts: ShellOptions): Promise<never> {
  const logFile = shouldLogToFile() ? logFilePath(opts.identifier) : undefined;
  if (logFile) redirectConsole(logFile, "main");
  const ui = openNative(opts.lib);
  // `window: false` (menu-bar apps): the run loop still needs a window; keep it hidden.
  const win = opts.window === false ? { visible: false, hiddenUntilReady: false } : opts.window;
  const windowId = ui.shell_window_create(
    // `version`: app.getVersion on Linux/Windows (macOS reads Info.plist).
    // `args`/`cwd`: URLs and documents the app was opened with (Linux/Windows; macOS gets Apple events).
    cstr(JSON.stringify({ title: opts.appName, appName: opts.appName, identifier: opts.identifier, version: opts.version, args: process.argv.slice(2), cwd: process.cwd(), singleInstance: opts.singleInstance ?? false, quitOnLastWindowClosed: opts.quitOnLastWindowClosed ?? true, ...win })),
  );
  if (windowId <= 0) throw new Error(`shell_window_create failed (${windowId})`);
  if (opts.pagePermissions) ui.shell_set_page_permissions(cstr(JSON.stringify(opts.pagePermissions)));
  if (opts.plugin) {
    const rc = ui.shell_load_plugin(cstr(opts.plugin));
    if (rc !== 0) console.error(`[shell] native plugin failed to load (${rc}): ${opts.plugin}`);
  }

  // One-time secret the Worker trades for an HttpOnly session cookie, so other
  // local processes and web pages can't drive the app's localhost server.
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const worker = opts.createWorker();
  const shutdownDone = new Promise<void>((resolve) => {
    worker.addEventListener("message", (e: MessageEvent) => {
      if (e.data?.type === "shutdown-complete") resolve();
    });
  });
  worker.addEventListener("error", (e) => console.error("[shell] worker error:", e.message));
  worker.postMessage({ type: "init", lib: opts.lib, windowId, secret, appName: opts.appName, identifier: opts.identifier, version: opts.version ?? "0.0.0", update: opts.update, url: opts.url, logFile } satisfies InitMessage);

  const rc = ui.shell_run(); // blocks: [NSApp run]

  // The run loop stopped (last window closed, Cmd+Q, signal, desktop.quit()).
  // Our event loop is alive again: give the Worker a bounded graceful shutdown.
  worker.postMessage({ type: "shutdown" });
  const timeout = opts.shutdownTimeoutMs ?? 3000;
  await Promise.race([shutdownDone, Bun.sleep(timeout)]);
  process.exit(rc < 0 ? 1 : 0);
}
