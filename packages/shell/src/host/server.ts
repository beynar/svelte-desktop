// Installed in server code by the Vite plugin (injected into SvelteKit's server
// runtime): the page members (backed by the same platform bus) plus the
// server-only ones.
import { buildHost } from "./build.ts";
import { desktop, isDesktop, loadAddon, onDesktopReady, sidecar, services, diagnostics, shellEnv, which, command } from "../server.ts";
import { jobs as jobManager } from "../jobs/host.ts";
import { AsyncLocalStorage } from "node:async_hooks";

const serverOnly = {
  /** Background jobs: the page view (list, get, on, onEvent, cancel) plus start and wait. */
  jobs: jobManager,
  services,
  diagnostics,
  /** Per-user directories (data, cache, logs, home), created at startup. */
  get paths() {
    return desktop.paths;
  },
  /** How the previous run ended (unclean exit, OS crash reports since). */
  crashInfo: () => desktop.crashInfo(),
  sidecar,
  loadAddon,
  /** The user's login-shell environment: pass it to Bun.spawn to run their tools. */
  shellEnv,
  /** A command on the user's shell PATH (claude, codex, git…), as an absolute path, or null. */
  which,
  /** The app's command in the user's terminal (desktop.config `command`): status, install, uninstall. */
  command,
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
// Pages read and write the app's files (host.store, host.windowState) through this process.
onDesktopReady(() => void import("../platform/app-files.ts").then(({ serveAppFiles }) => serveAppFiles()));

const pushServer = typeof __SVELTE_DESKTOP_PUSH__ !== "undefined" ? __SVELTE_DESKTOP_PUSH__?.server : null;
if (pushServer)
  onDesktopReady(() => {
    void import("../push/desktop.ts").then(({ startDesktopPush }) => startDesktopPush(pushServer, desktop.paths.data));
  });

// A request from a view (a kept-alive tab: X-Desktop-View, set by the native view) renders as one:
// <WindowTabs> server-renders the page alone there, as the view shows it — not the window's chrome
// for hydration to remove. `withRequest` wraps SvelteKit's respond (see the Vite plugin).
const views = new AsyncLocalStorage<string | undefined>();
export const withRequest = <T>(request: Request, respond: () => T): T => views.run(request.headers.get("x-desktop-view") ?? undefined, respond);
(globalThis as { __desktopViewRequest?: () => string | undefined }).__desktopViewRequest = () => views.getStore();
