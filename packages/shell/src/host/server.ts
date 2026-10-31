// Installed in server code by the Vite plugin (injected into SvelteKit's server
// runtime): the page members (backed by the same platform bus) plus the
// server-only ones.
import { buildHost } from "./build.ts";
import { desktop, isDesktop, loadAddon, onDesktopReady, sidecar } from "../server.ts";
import { jobs as jobManager } from "../jobs/host.ts";

const serverOnly = {
  /** Background jobs: the page view (list, get, on, onEvent, cancel) plus start and wait. */
  jobs: jobManager,
  /** Per-user directories (data, cache, logs, home), created at startup. */
  get paths() {
    return desktop.paths;
  },
  /** How the previous run ended (unclean exit, OS crash reports since). */
  crashInfo: () => desktop.crashInfo(),
  sidecar,
  loadAddon,
  onBeforeQuit: (fn: () => void | Promise<void>) => desktop.onBeforeQuit(fn),
  /** Runs `fn` once the app's native layer is ready (immediately if it is). */
  ready: onDesktopReady,
  get available(): boolean {
    return isDesktop();
  },
};

(globalThis as any).host ??= buildHost(serverOnly);

// Self-hosted push (desktop.config `push.server`) on macOS / Windows / Linux: the connection
// lives in this process, so it holds while the app runs, window closed included.
declare const __SVELTE_DESKTOP_PUSH__: { server?: string | null } | undefined;
const pushServer = typeof __SVELTE_DESKTOP_PUSH__ !== "undefined" ? __SVELTE_DESKTOP_PUSH__?.server : null;
if (pushServer && !process.env.SVELTE_DESKTOP_ANDROID_HOST)
  onDesktopReady(() => {
    void import("../push/desktop.ts").then(({ startDesktopPush }) => startDesktopPush(pushServer, desktop.paths.data));
  });
