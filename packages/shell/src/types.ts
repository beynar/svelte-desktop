export interface WindowOptions {
  /** Shown at launch (default true). false: created hidden (menu-bar apps). */
  visible?: boolean;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  /** Enables the Web Inspector (right-click > Inspect Element). */
  debug?: boolean;
  /** Persist and restore the window frame under this name (NSUserDefaults on macOS). */
  autosaveName?: string;
  /** macOS title bar: 'default', 'transparent' (the page extends under it, title kept), 'hidden' (the page extends under the traffic lights) or
   *  'hiddenInset' (same, traffic lights inset). Drag the window by any element with
   *  `data-desktop-drag` or CSS `--app-region: drag`; the page gets `--desktop-titlebar-height`,
   *  `--desktop-controls-width` and `html[data-desktop-titlebar]`. */
  titleBarStyle?: "default" | "transparent" | "hidden" | "hiddenInset";
  /** Keep the window invisible until DOMContentLoaded to avoid a white flash. Default true. */
  hiddenUntilReady?: boolean;
  readyTimeoutMs?: number;
}

export interface ShellOptions {
  appName: string;
  /** false: no visible main window at start (menu-bar apps). */
  /** Reverse-DNS id, e.g. dev.svelte-desktop.notes — names the data directories. */
  identifier: string;
  window?: WindowOptions | false;
  /** Absolute path of libshell for this platform. */
  lib: string;
  /** App native plugin (libapp-native.dylib), loaded on the UI thread before the loop starts. */
  plugin?: string | null;
  /** desktop.config singleInstance (Linux/Windows). */
  singleInstance?: boolean;
  /** permissions.pages from desktop.config; undefined = allow all. */
  pagePermissions?: string[];
  /** Main window URL override (dev mode points it at the Vite server). */
  url?: string;
  /** Must be created at the call site so `bun build --compile` sees the Worker entry. */
  createWorker: () => Worker;
  version?: string;
  update?: UpdateConfig;
  /** Grace period for the Worker's beforeQuit hooks and in-flight requests. */
  shutdownTimeoutMs?: number;
}

export type MenuItemSpec =
  | { type: "separator" }
  | {
      label: string;
      id?: string;
      role?:
        | "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
        | "minimize" | "zoom" | "close" | "hide" | "hideOthers" | "unhide"
        | "about" | "toggleFullScreen" | "front" | "quit" | "reload";
      accelerator?: string;
      enabled?: boolean;
      submenu?: MenuItemSpec[];
    };

export type ShellEvent =
  | { type: "ready" | "focus" | "blur" | "closed" | "webcontent-terminated"; window: number }
  | { type: "external-navigation"; window: number; url: string }
  | { type: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGHUP" }
  | { type: "menu"; id: string }
  | { type: "quit-requested" | "wake" }
  | { type: "dialog"; requestId: number; canceled?: boolean; paths?: string[]; button?: number }
  | { type: "platformResult"; id: number; ok: boolean; value?: unknown; error?: { code: string; message: string } }
  | { type: "platform"; name: string; data: unknown };

export interface UpdateConfig {
  /** update.json URL on any static host; may contain {channel}. */
  manifestUrl: string;
  /** ed25519 public key(s), base64 (scripts/updater-cli.ts keygen). */
  publicKey: string | string[];
  channel?: string;
}

/** UI thread -> Worker. */
export type InitMessage = {
  type: "init";
  lib: string;
  windowId: number;
  secret: string;
  appName: string;
  identifier: string;
  version: string;
  update?: UpdateConfig;
  /** Dev mode: the page lives at this URL (Vite) instead of the Worker's server. */
  url?: string;
  /** Console of both threads goes here (apps launched from Finder). */
  logFile?: string;
};
