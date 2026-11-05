// Watches the app's server from a thread of its own. The UI thread can't: its JS event loop is
// frozen for as long as the app runs (main.ts), so a Worker's `error` and `close` never reach it.
//
// A server that dies takes the whole app with it: the app restarts as a new process, a few times,
// then tells the user and quits. A new process instead of a new Worker because everything the server
// holds goes with it: the gate's secret and session cookie, the event sink, the port, and what server
// code asked of the native side (a second start would add its tray icons and windows to the old ones,
// and macOS would wait at quit for a dead thread to answer). It also counts as a launch for an update
// waiting to be confirmed, so a version whose server dies before that rolls back.
import { JSCallback, FFIType, type Pointer } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { endCrashTracking, nextRestart, recordCrash } from "./crash.ts";
import { cstr, openNative, takeString, type Native } from "./ffi.ts";
import { logCrash, logFilePath } from "./logging.ts";
import { appDirs } from "./os.ts";
import type { InitMessage } from "./types.ts";

declare var self: Worker;

export type WorkerEnd = "quit" | "restart";

/** `error`: the Worker's `error` event, if any. Exit code 0 with no error: server code's own `process.exit(0)`. */
export const describeEnd = (code: number, error: string | undefined): { end: WorkerEnd; message: string } =>
  error || code !== 0
    ? { end: "restart", message: error ?? `the server exited with code ${code}` }
    : { end: "quit", message: "the server exited with code 0" };

/**
 * Writes the crash down, and says how long to wait before restarting; null not to. Also null when
 * it can't be written (a full disk): uncounted, a crash loop would never stop.
 */
export function recordAndDecide(dataDir: string, message: string, onError: (err: unknown) => void): number | null {
  try {
    mkdirSync(dataDir, { recursive: true }); // a first launch that died loading may not have made it yet
    recordCrash(dataDir, message);
    return nextRestart(dataDir);
  } catch (err) {
    onError(err);
    return null;
  }
}

export function startSupervisor(createWorker: () => Worker) {
  let init: InitMessage | undefined;
  let stopping = false;
  let error: string | undefined;
  let ended: { code: number } | undefined;

  const finish = () => {
    if (!init || !ended) return;
    if (stopping) return void postMessage({ type: "shutdown-complete" });
    void onServerEnd(init, ended.code, error);
  };

  // Starts loading while the window is made; it waits for `init` to serve.
  const worker = createWorker();
  worker.addEventListener("error", (e) => {
    error = e.message;
  });
  worker.addEventListener("message", (e: MessageEvent) => postMessage(e.data));
  worker.addEventListener("close", (e: Event) => {
    ended = { code: (e as CloseEvent).code };
    finish();
  });

  self.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === "shutdown") {
      stopping = true;
      if (ended) postMessage({ type: "shutdown-complete" });
      else worker.postMessage(msg);
    } else if (msg?.type === "init") {
      init = msg;
      if (ended) finish();
      else worker.postMessage(msg);
    }
  });
}

async function onServerEnd(init: InitMessage, code: number, error: string | undefined) {
  const dirs = appDirs(init.identifier);
  const native = openNative(init.lib);
  const platform = (op: string, args: Record<string, unknown>) =>
    native.shell_platform_call(cstr(JSON.stringify({ id: 0, service: "app", op, args })));
  const { end, message } = describeEnd(code, error);

  logCrash(logFilePath(init.identifier), "supervisor", message);
  if (end === "quit") {
    endCrashTracking(dirs.data);
    platform("exit", { code: 0 });
    return;
  }

  const delay = recordAndDecide(dirs.data, message, (err) => logCrash(logFilePath(init.identifier), "supervisor", `couldn't record the crash: ${err}`));
  if (delay !== null) {
    if (delay) await Bun.sleep(delay);
    platform("relaunch", { crashed: true });
    // Native code ends this process. It's still here if the relaunch itself failed.
    await Bun.sleep(5000);
  }
  tellUserAndQuit(native, init, platform);
}

let dialogSink: JSCallback; // here to stay: native code holds on to it

/** The message box answers through the event sink, which went with the server. */
function tellUserAndQuit(native: Native, init: InitMessage, platform: (op: string, args: Record<string, unknown>) => void) {
  const REQUEST = 1;
  dialogSink = new JSCallback(
    (p: Pointer) => {
      const event = JSON.parse(takeString(native, p));
      if (event.type === "dialog" && event.requestId === REQUEST) platform("exit", { code: 1 });
    },
    { args: [FFIType.ptr], returns: FFIType.void, threadsafe: true },
  );
  native.shell_set_event_sink(dialogSink.ptr!);
  native.shell_dialog(
    REQUEST,
    cstr(JSON.stringify({
      kind: "message",
      style: "critical",
      title: `${init.appName} stopped working`,
      message: `${init.appName} stopped working`,
      detail: `It crashed several times in a row, so it won't restart again. The details are in ${logFilePath(init.identifier)}.`,
      buttons: ["Quit"],
    })),
  );
}
