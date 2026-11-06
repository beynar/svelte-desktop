import type { VibrancyMaterial, VibrancyState, WindowAnimation } from "./platform/index.ts";

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
   *  'hiddenInset' (same, traffic lights inset). Drag the window by its title bar strip (unless the element there is a
   *  control or has `--app-region: no-drag`) or by any element with `data-desktop-drag` or CSS `--app-region: drag`; the page gets `--desktop-titlebar-height`,
   *  `--desktop-controls-width` and `html[data-desktop-titlebar]`. Scrolling over the title bar strip
   *  doesn't scroll the page (title-bar gesture tools such as Swish keep working). */
  titleBarStyle?: "default" | "transparent" | "hidden" | "hiddenInset";
  /** Vibrancy behind the page (macOS): 'sidebar', 'titlebar', 'window', 'underWindow', 'menu', 'popover',
   *  'hud'… It shows where the page paints no background; change it later with windows.setVibrancy. */
  vibrancy?: VibrancyMaterial;
  vibrancyState?: VibrancyState;
  /** The traffic lights at your own place (macOS, titleBarStyle hidden / hiddenInset): the close button's
   *  top-left, in points from the window's top-left — for a taller custom title bar. */
  trafficLightPosition?: { x: number; y: number };
  /** Width / height kept while resizing (16/9, 1 for a square). */
  aspectRatio?: number;
  /** false: the page runs at full speed when hidden or covered (timers, audio, sockets). Default true. */
  backgroundThrottling?: boolean;
  /** Come in animated when it shows (macOS): `true` or a WindowAnimation (duration, easing, offset, scale, opacity). */
  animate?: boolean | WindowAnimation;
  /** Keep the window invisible until DOMContentLoaded to avoid a white flash. Default true. */
  hiddenUntilReady?: boolean;
  readyTimeoutMs?: number;
}

export interface ShellOptions {
  appName: string;
  /** false: no visible main window at start (menu-bar apps). */
  /** Reverse-DNS id, e.g. dev.kitop.notes — names the data directories. */
  identifier: string;
  window?: WindowOptions | false;
  /** Absolute path of libshell for this platform. */
  lib: string;
  /** App native plugins (libapp-native, the Rust and Go ones), loaded on the UI thread before the loop starts. */
  plugins?: string[];
  /** desktop.config singleInstance (Linux/Windows). */
  singleInstance?: boolean;
  /** desktop.config quitOnLastWindowClosed (default true). */
  quitOnLastWindowClosed?: boolean;
  /** `bridge.allow` from desktop.config, an empty list when it isn't set. Undefined only outside a configured app (the native test suites). */
  pagePermissions?: string[];
  /** Not in a build signed to be distributed: see build/test-channel-policy.ts. */
  testChannel?: boolean;
  /** Dev mode: the config's usage descriptions (no Info.plist then; a bundle has its own). */
  usageDescriptions?: Record<string, string>;
  /** Custom resource schemes registered before any web view is created (macOS and Linux). */
  protocols?: string[];
  /** Main window URL override (dev mode points it at the Vite server). */
  url?: string;
  /** Dock icon PNG (dev mode: the app's icon instead of bun's; a bundle has its own). */
  appIcon?: string;
  /** The thread this one talks to: supervisor.ts in a built app, the dev Worker in `vite dev`. */
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
  | { type: "ready" | "focus" | "blur" | "closed"; window: number }
  /** The window's web process died. `gaveUp`: it died too often to reload it again. */
  | { type: "webcontent-terminated"; window: number; gaveUp?: boolean }
  /** Windows: the page has stopped responding (it may recover; the user chooses). */
  | { type: "webcontent-unresponsive"; window: number }
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
