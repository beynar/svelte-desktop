// `host` — the app's native layer, global in page and server code (no import).
// Pulled into an app's types by src/host.d.ts (written by the Vite plugin).
import type { Host } from "./build.ts";
import type { jobs as jobManager } from "../jobs/host.ts";
import type { CrashInfo } from "../crash.ts";
import type { DesktopApi } from "../api.ts";
import type { JobFunction, JobInfo } from "../jobs/types.ts";

type Jobs = Host["jobs"] & Pick<typeof jobManager, "start" | "wait">;

interface ServerHost {
  /** Server code: per-user directories (data, cache, logs, home). */
  readonly paths: DesktopApi["paths"];
  /** Server code: how the previous run ended. */
  crashInfo(): CrashInfo;
  /** Server code: spawn a bundled sidecar. */
  sidecar: typeof import("../server.ts").sidecar;
  /** Server code: load a Node-API addon (native/addons/<name>.c). */
  loadAddon: typeof import("../server.ts").loadAddon;
  /** Server code: before the app quits. */
  onBeforeQuit(fn: () => void | Promise<void>): void;
  /** Server code: once the native layer is ready. */
  ready: typeof import("../server.ts").onDesktopReady;
}

declare global {
  /**
   * The app's native layer (desktop and mobile), the same in page and server code:
   * `host.theme.dark`, `host.clipboard.writeText()`, `host.notifications.show()`,
   * `host.jobs.start()` (server) / `host.jobs.list()`, `host.broadcast()`…
   * Members are reactive in components. `host.available` is false outside the app.
   */
  var host: Omit<Host, "jobs"> & ServerHost & { jobs: Jobs };

  /** A background job (`src/jobs/<name>.ts`): `export default (async (args, ctx) => …) satisfies HostJob<Args, Result>`. */
  type HostJob<A = any, R = unknown> = JobFunction<A, R>;
  /** A job's state as seen by `host.jobs`. */
  type HostJobInfo = JobInfo;
}

export {};
