// UI thread = Bun's main thread. It creates the window, hands the webview pointer
// to the server Worker, then blocks inside webview_run (the Cocoa run loop) until
// someone calls webview_terminate.
import { JSCallback, FFIType } from "bun:ffi";
import { open, cstr } from "./ffi.ts";

const t0 = Date.now();
process.env.SPIKE_T0 = String(t0);
// Embedded into the executable with --compile; bun:ffi dlopens it from $bunfs.
import embeddedLib from "./native/libshell.dylib" with { type: "file" };
const lib = process.env.SHELL_LIB ?? embeddedLib;
const ui = open(lib);
const log = (m: string) => console.log(`[main +${Date.now() - t0}ms] ${m}`);

let mainTimerFired = 0;
setInterval(() => mainTimerFired++, 10); // T4: does the main-thread JS loop tick while Cocoa runs?

// Memory-experiment knobs (see MEMORY.md).
const DEBUG = process.env.SPIKE_DEBUG === "0" ? 0 : 1;
const NO_WORKER = process.env.SPIKE_NO_WORKER === "1";
const SMOL_WORKER = process.env.SPIKE_SMOL_WORKER === "1";
const w = ui.webview_create(DEBUG, null)!;
ui.webview_set_title(w, cstr("svelte-desktop spike"));
ui.webview_set_size(w, 900, 600, 0);
ui.webview_set_html(w, cstr("<p style='font:14px system-ui'>starting…</p>"));

// T3: binding. Invoked on the UI thread, re-entrantly from inside webview_run.
const ping = new JSCallback(
  (id: number, req: number, _arg: number) => {
    const { CString } = require("bun:ffi");
    const idStr = new CString(id as any).toString();
    const reqStr = new CString(req as any).toString();
    ui.webview_return(w, cstr(idStr), 0, cstr(JSON.stringify({ echo: JSON.parse(reqStr), thread: "main", mainTimerFired })));
  },
  { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
);
ui.webview_bind(w, cstr("__shell_ping"), ping.ptr!, null);

const worker = NO_WORKER ? null : new Worker("./server-worker.ts", { smol: SMOL_WORKER });
if (NO_WORKER) ui.webview_set_html(w, cstr("<h1 style='font:16px system-ui'>window only, no worker</h1>"));
let results: unknown;
if (worker) worker.onmessage = (e) => {
  if (e.data.log) console.log(e.data.log);
  if (e.data.results) results = e.data.results;
};
worker?.postMessage({ lib, w: Number(w) });

log("entering webview_run");
const rc = ui.webview_run(w);
log(`webview_run returned rc=${rc}; main timer ticks during run=${mainTimerFired}`);
ui.webview_destroy(w);
// Worker -> main postMessages queued while Cocoa owned the thread; let them drain.
await Bun.sleep(100);
console.log("RSS MB", (process.memoryUsage().rss / 1048576).toFixed(1));
console.log("RESULT", JSON.stringify(results));
process.exit(0);
