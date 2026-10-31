// One implementation of the server-side `desktop` API, on top of the platform
// bus. Used by the production Worker (bus → bun:ffi) and by `vite dev` (bus →
// RPC to the dev shell), so server code behaves the same in both.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appDirs } from "./os.ts";
import { endCrashTracking, startCrashTracking, type CrashInfo } from "./crash.ts";
import { bindJobs, jobs, stopAllJobs } from "./jobs/host.ts";
import type { DesktopApi } from "./api.ts";
import { callPlatform, onPlatform } from "./platform/bus.ts";
import type { MenuItemSpec, ShellEvent } from "./types.ts";

export interface DesktopApiDeps {
  appName: string;
  identifier: string;
  origin: string;
  quit(): void;
  /** Track unclean exits / OS crash reports (the packaged app; not `vite dev`). */
  trackCrashes?: boolean;
}

type Listener = (e: any) => void;

export interface DesktopRuntime {
  api: DesktopApi;
  /** Feed a legacy shell event (focus/blur/menu/closed/ready/signal/…) to `desktop.on` listeners and pages. */
  feed(event: ShellEvent): void;
  runBeforeQuit(): Promise<void>;
}

/** Legacy `desktop.menu.set` spec ([{label, submenu:[…]}]) → platform setAppMenu menus. */
export function toPlatformMenus(spec: MenuItemSpec[]) {
  const item = (s: MenuItemSpec): Record<string, unknown> => {
    if ("type" in s && s.type === "separator") return { type: "separator" };
    const x = s as Exclude<MenuItemSpec, { type: "separator" }>;
    return {
      label: x.label,
      ...(x.id ? { id: x.id } : {}),
      ...(x.role ? { role: x.role === "toggleFullScreen" ? "toggleFullscreen" : x.role } : {}),
      ...(x.accelerator ? { accelerator: x.accelerator } : {}),
      ...(x.enabled === false ? { disabled: true } : {}),
      ...(x.submenu ? { submenu: x.submenu.map(item) } : {}),
    };
  };
  return spec.map((top) => {
    const t = top as Exclude<MenuItemSpec, { type: "separator" }>;
    return { name: t.label ?? "", items: (t.submenu ?? []).map(item) };
  });
}

export function createDesktopRuntime(deps: DesktopApiDeps): DesktopRuntime {
  const listeners = new Map<string, Set<Listener>>();
  const beforeQuit: Array<() => void | Promise<void>> = [];
  const paths = appDirs(deps.identifier);
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
  const crash: CrashInfo = deps.trackCrashes ? startCrashTracking(paths.data) : { uncleanExit: false, previousLaunch: null, reports: [] };

  const fire = (type: string, event: unknown) => {
    for (const fn of listeners.get(type) ?? []) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[shell] ${type} listener threw`, err);
      }
    }
  };
  // Background jobs → pages: snapshots on the `jobs` broadcast channel (the `jobs` store);
  // a page asks for the current list with `jobs:hello`.
  const publishJobs = (list: unknown, extra?: Record<string, unknown>) =>
    void callPlatform("events", "emit", { channel: "jobs", data: { jobs: list, ...extra } }).catch(() => {});
  bindJobs(publishJobs, deps.trackCrashes ? join(paths.data, "jobs.json") : undefined);
  onPlatform<{ channel?: string }>("message", (m) => {
    if (m?.channel === "jobs:hello") publishJobs(jobs.list());
    if (m?.channel === "jobs:cancel") jobs.cancel(String((m as { data?: { id?: string } }).data?.id ?? ""));
  });

  // Platform menu clicks surface as the legacy `menu` event too.
  onPlatform<{ id: string }>("menuAction", (d) => fire("menu", { type: "menu", id: d.id }));

  const broadcast = (data: unknown) => callPlatform("events", "emit", { channel: "desktop", data }).catch(() => {});
  const win = (op: string, args: Record<string, unknown> = {}) => void callPlatform("window", op, { windowId: 0, ...args }).catch(() => {});
  const filters = (ext?: string[]) => (ext?.length ? [{ name: "Files", extensions: ext }] : undefined);

  const api: DesktopApi = {
    appName: deps.appName,
    origin: deps.origin,
    paths,
    crashInfo: () => crash,
    window: {
      setTitle: (title) => win("setTitle", { title }),
      setSize: (width, height) => win("setSize", { width, height }),
      show: () => win("show"),
      hide: () => win("hide"),
      focus: () => win("focus"),
      close: () => win("close"),
      eval: (js) => win("eval", { js }),
    },
    dialog: {
      open: async (o = {}) => {
        const r = await callPlatform<{ canceled: boolean; paths: string[] }>("dialog", "showOpenDialog", {
          files: o.files ?? true,
          directories: o.directories ?? false,
          multiple: o.multiple ?? false,
          title: o.title,
          defaultPath: o.defaultPath,
          filters: filters(o.extensions),
        });
        return r.canceled ? null : r.paths;
      },
      save: async (o = {}) => {
        const r = await callPlatform<{ canceled: boolean; path: string | null }>("dialog", "showSaveDialog", {
          suggestedName: o.defaultName,
          defaultPath: o.defaultPath,
          filters: filters(o.extensions),
        });
        return r.canceled ? null : r.path;
      },
      message: async (o) =>
        (await callPlatform<{ response: number }>("dialog", "showMessageBox", {
          type: o.style ?? "info",
          message: o.message,
          detail: o.detail,
          buttons: o.buttons,
        })).response,
    },
    menu: { set: (spec) => void callPlatform("menu", "setAppMenu", { menus: toPlatformMenus(spec) }).catch((e) => console.error("[shell] menu.set:", e)) },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn as Listener);
      return () => set!.delete(fn as Listener);
    },
    publish: (type, data) => void broadcast({ type, data }),
    async openExternal(url) {
      const u = new URL(url);
      if (!["http:", "https:", "mailto:"].includes(u.protocol)) throw new Error(`refusing to open ${u.protocol} URL`);
      await callPlatform("shell", "openExternal", { url: u.href });
    },
    onBeforeQuit: (fn) => void beforeQuit.push(fn),
    quit: () => deps.quit(),
  };

  return {
    api,
    feed(event) {
      fire(event.type, event);
      // Pages see native events as `native:<type>` (see client.ts).
      if (event.type !== "dialog" && event.type !== "platform" && event.type !== "platformResult")
        void broadcast({ type: `native:${event.type}`, data: event });
    },
    async runBeforeQuit() {
      for (const fn of beforeQuit) {
        try {
          await fn();
        } catch (err) {
          console.error("[shell] beforeQuit hook threw", err);
        }
      }
      stopAllJobs();
      if (deps.trackCrashes) endCrashTracking(paths.data);
    },
  };
}
