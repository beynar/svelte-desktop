// Import this from SvelteKit server code: `import { desktop } from '@svelte-desktop/shell/server'`.
// It holds no FFI itself — the Worker runtime installs the implementation on
// globalThis before the app's server code runs — so it bundles into the server
// build like any small module and simply throws when not running in the shell.
import type { DesktopApi } from "./api.ts";
import { basename } from "node:path";
import { collectSupport, type CollectOptions } from "./diagnostics/collect.ts";
import { callPlatform } from "./platform/bus.ts";
import { services } from "./services/host.ts";
import { addonPath } from "./resolve-lib.ts";
export type * from "./api.ts";
export type { CrashInfo, CrashReport } from "./crash.ts";
/** Background jobs: `src/jobs/<name>.ts` run in their own processes (see jobs/host.ts). */
export { jobs } from "./jobs/host.ts";
export type { JobContext, JobFunction, JobInfo, JobState, StartOptions } from "./jobs/host.ts";
export type { MenuItemSpec, ShellEvent } from "./types.ts";

const KEY = Symbol.for("svelte-desktop.api");

export function isDesktop(): boolean {
  return KEY in globalThis;
}

export const desktop: DesktopApi = new Proxy({} as DesktopApi, {
  get(_, prop) {
    const api = (globalThis as any)[KEY] as DesktopApi | undefined;
    if (!api) throw new Error(`desktop.${String(prop)}: not running inside the svelte-desktop shell`);
    return (api as any)[prop];
  },
});

const READY = Symbol.for("svelte-desktop.ready");
const queue = ((globalThis as any)[READY] ??= []) as Array<(api: DesktopApi) => void>;

/**
 * Runs `fn` once the shell is up (window created, server listening). App server
 * modules evaluate before that, so put menus and listeners here, e.g. in
 * hooks.server.ts. Never runs outside the shell.
 */
export function onDesktopReady(fn: (api: DesktopApi) => void): void {
  if (isDesktop()) fn((globalThis as any)[KEY]);
  else queue.push(fn);
}

/** @internal used by the Worker runtime. */
export function installDesktopApi(api: DesktopApi) {
  (globalThis as any)[KEY] = api;
  for (const fn of queue.splice(0)) {
    try {
      fn(api);
    } catch (err) {
      console.error("[shell] onDesktopReady callback threw", err);
    }
  }
}

/**
 * Spawn a bundled sidecar (desktop.config `sidecars: { ffmpeg: 'bin/ffmpeg' }`).
 * Same options as Bun.spawn; resolves the executable inside the .app (or the
 * dev path the Vite plugin exposes).
 */
export async function sidecar(name: string, args: string[] = [], options: Parameters<typeof Bun.spawn>[1] = {}) {
  const { sidecarPath } = await import("./resolve-lib.ts");
  return Bun.spawn([sidecarPath(name), ...args], options);
}

/**
 * Load a Node-API addon shipped with the app: native/addons/<name>.c (compiled
 * for you) or desktop.config `addons: { name: 'path/to/x.node' }`. Server code only.
 *
 *   const math = loadAddon<{ fib(n: number): number }>('fastmath');
 */
export function loadAddon<T = any>(name: string): T {
  const module = { exports: {} as T };
  process.dlopen(module, addonPath(name));
  return module.exports;
}

/** The user's login-shell environment and the commands on its PATH (an app opened from the
 *  Finder doesn't get the PATH their terminal builds). */
export { shellEnv, which } from "./shell-env.ts";
/** The app's command in the user's terminal (desktop.config `command`). */
export { command } from "./command.ts";
export type { CommandStatus } from "./command.ts";
/** The app's MCP server (src/mcp.ts) in an agent's client: status, install, uninstall. */
export { mcp } from "./mcp/clients.ts";
export type { McpClient, McpClientStatus, McpInstallResult, McpStatus } from "./mcp/clients.ts";
export type { ShellEnvOptions } from "./shell-env.ts";

/** Persistent duplex children; server code owns their lifetime and page-facing commands. */
export { services };
export type * from "./services/types.ts";
export type { CollectOptions } from "./diagnostics/collect.ts";

/** Opt-in local support archive. The application owns consent, upload and deletion. */
export const diagnostics = {
  collect(options: CollectOptions = {}) {
    return collectSupport({
      appName: desktop.appName,
      logsDir: desktop.paths.logs,
      cacheDir: desktop.paths.cache,
      executable: basename(process.execPath).replace(/\.exe$/i, ''),
      crashInfo: () => desktop.crashInfo(),
      appInfo: () => callPlatform('app', 'getInfo'),
    }, options);
  },
};

