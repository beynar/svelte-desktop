// Native platform harness: real window + real run loop, ops driven from a Worker.
//   bun test/harness.ts test/platform/<suite>.ts [--keep-open]
// A suite exports `default async (t: Harness) => void` (see harness-worker.ts).
// Prints one JSON line per check and a summary; exit code 1 if any check failed.
import { resolve } from "node:path";
import { openNative, cstr } from "../src/ffi.ts";

const suite = process.argv[2];
if (!suite) throw new Error("usage: bun test/harness.ts <suite.ts> [--keep-open]");
const arch = process.arch === "arm64" ? "arm64" : "x86_64";
const os = process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : "darwin";
const libFile = os === "linux" ? "libshell.so" : os === "windows" ? "shell.dll" : "libshell.dylib";
const lib = process.env.SVELTE_DESKTOP_LIB ?? resolve(import.meta.dir, `../native/build/${os}-${arch}/${libFile}`);
const ui = openNative(lib);
const windowId = ui.shell_window_create(
  // HARNESS_WINDOW: extra window options for one suite (e.g. {"quitOnLastWindowClosed":false}).
  cstr(JSON.stringify({ title: "platform harness", width: 720, height: 480, appName: "Harness", identifier: "dev.svelte-desktop.harness", ...JSON.parse(process.env.HARNESS_WINDOW ?? "{}") })),
);
const worker = new Worker(new URL("./harness-worker.ts", import.meta.url).href);
let failed = 0;
worker.onmessage = (e) => {
  if (e.data?.type === "done") failed = e.data.failed;
};
worker.postMessage({ lib, windowId, suite: resolve(suite), keepOpen: process.argv.includes("--keep-open") });
ui.shell_run();
await Bun.sleep(50); // drain the Worker's queued messages
process.exit(failed ? 1 : 0);
