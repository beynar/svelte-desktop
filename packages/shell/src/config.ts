// desktop.config.ts — the one place an app describes itself as a desktop app.
//
//   import { defineConfig } from '@svelte-desktop/shell/config';
//   export default defineConfig({ appName: 'Notes', identifier: 'dev.example.notes' });
//
// Everything but appName/identifier is optional. The Vite plugin loads it for
// `vite dev` (window, native plugin) and `vite build` (bundle, signing, release).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IconSpec } from "./build/icons.ts";
import type { UpdateConfig, WindowOptions } from "./types.ts";

export interface FileTypeConfig {
  name: string;
  extensions: string[];
  /** CFBundleTypeRole: Editor (default) | Viewer | Shell | None */
  role?: "Editor" | "Viewer" | "Shell" | "None";
  /** LSHandlerRank: Owner | Default (default) | Alternate */
  rank?: "Owner" | "Default" | "Alternate";
  /** Uniform type identifiers, if known (e.g. net.daringfireball.markdown). */
  utis?: string[];
  /** Linux MIME types (e.g. text/markdown). Default: the common type of each extension, else a type the
   *  build declares (application/x-<identifier>-<ext>, shipped as a shared-mime-info package). */
  mimeTypes?: string[];
}

export interface SignConfig {
  /** codesign identity ("Developer ID Application: Name (TEAMID)"), "-" for ad-hoc.
   *  Default: $CODESIGN_IDENTITY, else ad-hoc. */
  identity?: string;
  /** Extra entitlements merged into the defaults Bun needs (JIT). */
  entitlements?: Record<string, boolean | string | string[]>;
  /** Hardened runtime (required for notarization). Default: true unless ad-hoc. */
  hardenedRuntime?: boolean;
  /** notarytool keychain profile. Default: $NOTARY_PROFILE. Notarizes + staples when set. */
  notaryProfile?: string;
  /** macOS provisioning profile (.provisionprofile) embedded in the bundle — needed by restricted
   *  entitlements such as Push Notifications (`push.apns`). */
  provisioningProfile?: string;
  /** Windows Authenticode signing (osslsigncode). Also enabled by $WINDOWS_CERT_PFX (+ $WINDOWS_CERT_PASSWORD). */
  windows?: {
    /** PKCS#12 (.pfx/.p12) code-signing certificate, relative to the project. Default: $WINDOWS_CERT_PFX. */
    certificateFile?: string;
    /** Certificate password. Default: $WINDOWS_CERT_PASSWORD. */
    password?: string;
    /** RFC 3161 timestamp server. Default: http://timestamp.digicert.com */
    timestampUrl?: string;
  };
}

export interface BuildConfig {
  /** Target OS. Default: the host. Linux/Windows can be built from macOS (cross-compiled; --aot is host-only). */
  target?: "macos" | "linux" | "windows";
  /** Linux/Windows target architecture. Default: x64. */
  targetArch?: "x64" | "arm64";
  /** Bun `--aot` (canary today). */
  aot?: boolean;
  /** Bun `--trim` (canary today). */
  trim?: boolean;
  /** Bun binary used to compile. Default: $SVELTE_DESKTOP_BUN or the running Bun. */
  bun?: string;
  /** Also build the x64 slice and lipo a universal app. */
  universal?: boolean;
  dmg?: boolean;
  zip?: boolean;
  /** Output directory. Default .desktop/dist */
  outDir?: string;
  /** Minimum macOS. Default 12.0 */
  minimumSystemVersion?: string;
}

export interface DesktopConfig {
  appName: string;
  /** Reverse-DNS bundle id. */
  identifier: string;
  /** Default: package.json version. */
  version?: string;
  /** App icon: one square image (PNG, JPEG or WebP, 1024 px or more; SVG when building on macOS), relative to the project;
   *  every target's icons are generated from it at build (`svelte-desktop icon` previews them).
   *  A square artwork is put on macOS's squircle grid; one with transparent corners is taken as
   *  already shaped. `background` (hex): behind such an artwork in macOS 26's icon, which is
   *  opaque — default the artwork's corner color, else white.
   *  Default: icon.png, icon.svg, then static/icon.png, if present. */
  icon?: string | { source: string; background?: string };
  copyright?: string;
  /** Main window. `false` → no main window at start (menu-bar apps). */
  window?: WindowOptions | false;
  /** Signed self-update feed. */
  update?: UpdateConfig & {
    /** ed25519 private key file used by `vite build` to sign release/update.json. Default $SVELTE_DESKTOP_UPDATE_KEY. */
    privateKey?: string;
    /** Public base URL where release/ is uploaded (artifact URLs in update.json). */
    baseUrl?: string;
  };
  /** Deep-link URL schemes (CFBundleURLTypes). */
  schemes?: string[];
  /** Document types the app opens (CFBundleDocumentTypes) → `openFiles` events. */
  fileTypes?: FileTypeConfig[];
  /** @deprecated use `permissions` (same shape). */
  usageDescriptions?: Record<string, string>;
  /** One running instance (default true): launching the app again — opening a document or a link
   *  from the desktop — hands its arguments to the running one (`openUrls` / `openFiles`, `secondInstance`).
   *  Linux and Windows (macOS does this natively). */
  singleInstance?: boolean;
  /** LSUIElement: no Dock icon, no app menu. */
  trayOnly?: boolean;
  /** Default true. false: closing the last window hides it and the app keeps running — like most
   *  macOS apps, or a tray app on Windows/Linux — so background work, jobs and the self-hosted push
   *  connection (`push.server`) go on, and the page keeps its state. A Dock click, a notification click
   *  or launching the app again shows it. Quit with Cmd+Q / `host.app.quit()`. */
  quitOnLastWindowClosed?: boolean;
  /** Native plugin sources (Swift/ObjC/C). Default 'native' if the folder exists. */
  native?: string | false;
  /** Prebuilt Node-API addons (`.node`) to ship, reachable with `loadAddon(name)` from server code.
   *  Sources in native/addons/*.c are compiled automatically. */
  addons?: Record<string, string>;
  /** Executables shipped with the app and reachable with `sidecar(name)` from server code.
   *  A path for every platform, or one per platform: `{ ffmpeg: { macos: 'bin/ffmpeg', windows: 'bin/ffmpeg.exe' } }`. */
  sidecars?: Record<string, SidecarSource>;
  /** OS permissions the app uses, each with the reason shown to the user:
   *  `{ camera: 'Scan documents', screenRecording: 'Share your screen' }`. Generates the Info.plist
   *  usage strings and hardened-runtime entitlements (macOS);
   *  `host.permissions` checks, requests and guides them at run time. Some (camera, microphone,
   *  location, contacts…) must be declared here: the OS kills an app that asks without a reason. */
  permissions?: PermissionsConfig;
  /** Local notifications (`host.notifications`). */
  notifications?: NotificationsConfig;
  /** Remote push (`host.push`): your own push server, APNs on macOS, Web Push in browsers. */
  push?: PushConfig;
  /** The page → native bridge. */
  bridge?: {
    /** Native ops pages may call (`service.op` or `service.*`). Server code is never restricted.
     *  Default: everything. */
    allow?: string[];
  };
  /** Extra Info.plist keys. */
  plist?: Record<string, unknown>;
  build?: BuildConfig;
  sign?: SignConfig;
}

export interface NotificationsConfig {
  /** Show notifications (local and push) as banners while the app is frontmost. Default true. */
  foreground?: boolean;
}

export interface PushConfig {
  /** APNs (macOS): adds the `aps-environment` entitlement. Needs a provisioning profile that
   *  enables Push Notifications (`sign.provisioningProfile`).
   *  `true` = 'production' for signed release builds, 'development' otherwise. */
  apns?: boolean | { environment?: "development" | "production" };
  /** Your own push server (`@svelte-desktop/shell/push-server`, Web Push compatible) for macOS, Windows
   *  and Linux: the app holds one connection to it while it runs (window closed included) — no Apple or
   *  Google account. `host.push.register()` returns a Web Push target your server sends to with
   *  `createPush({ webpush })`. Takes precedence over APNs on macOS. */
  server?: string;
}

export type SidecarPlatform = "macos" | "linux" | "windows";
export type SidecarSource = string | Partial<Record<SidecarPlatform, string>>;

/** Sidecars declared for one platform: [name, absolute path]. */
export function sidecarEntries(c: { root: string; sidecars?: Record<string, SidecarSource> }, platform: SidecarPlatform): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, src] of Object.entries(c.sidecars ?? {})) {
    const path = typeof src === "string" ? src : src[platform];
    if (path) out.push([name, resolve(c.root, path)]);
  }
  return out;
}

/** OS permissions `host.permissions` knows. */
export type PermissionName =
  | "camera" | "microphone" | "location" | "contacts" | "calendars" | "reminders" | "photos" | "bluetooth"
  | "speech" | "appleEvents" | "notifications" | "screenRecording" | "accessibility" | "inputMonitoring"
  | "fullDiskAccess" | "desktopFolder" | "documentsFolder" | "downloadsFolder";

export type PermissionsConfig = Partial<Record<PermissionName, string>> & {
  /** @deprecated moved to `bridge.allow`. */
  pages?: string[];
  /** Raw NS…UsageDescription keys pass through to Info.plist. */
  [usageKey: string]: string | string[] | undefined;
};

export function defineConfig(config: DesktopConfig): DesktopConfig {
  return config;
}

const NAMES = ["desktop.config.ts", "desktop.config.js", "desktop.config.mjs"];

/** Usage-description shorthands → Info.plist keys. */
export const USAGE_KEYS: Record<string, string> = {
  camera: "NSCameraUsageDescription",
  microphone: "NSMicrophoneUsageDescription",
  location: "NSLocationUsageDescription",
  contacts: "NSContactsUsageDescription",
  calendars: "NSCalendarsUsageDescription",
  reminders: "NSRemindersUsageDescription",
  photos: "NSPhotoLibraryUsageDescription",
  bluetooth: "NSBluetoothAlwaysUsageDescription",
  appleEvents: "NSAppleEventsUsageDescription",
  speech: "NSSpeechRecognitionUsageDescription",
  desktopFolder: "NSDesktopFolderUsageDescription",
  documentsFolder: "NSDocumentsFolderUsageDescription",
  downloadsFolder: "NSDownloadsFolderUsageDescription",
};

export interface ResolvedConfig extends Omit<DesktopConfig, "window" | "native"> {
  root: string;
  version: string;
  window: WindowOptions | false;
  /** Absolute native sources dir, or null. */
  native: string | null;
  icon?: IconSpec;
  configFile: string | null;
  /** `permissions` (+ legacy `usageDescriptions`): OS permission → reason. */
  osPermissions: Record<string, string>;
  /** `bridge.allow` (or legacy `permissions.pages`); undefined = every op. */
  bridgeAllow?: string[];
}

export async function loadConfig(root = process.cwd(), inline?: Partial<DesktopConfig>): Promise<ResolvedConfig> {
  root = resolve(root);
  let fromFile: Partial<DesktopConfig> = {};
  let configFile: string | null = null;
  for (const name of NAMES) {
    const file = join(root, name);
    if (existsSync(file)) {
      configFile = file;
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      fromFile = mod.default ?? mod.config ?? {};
      break;
    }
  }
  return resolveConfig(root, { ...fromFile, ...inline }, configFile);
}

/** Where the app icon is looked for when `icon` isn't set, in order. */
export const ICON_CANDIDATES = ["icon.png", "icon.svg", "static/icon.png"];

/** The app icon: desktop.config `icon`, else the first ICON_CANDIDATES file that exists. */
export function findIcon(root: string, option: DesktopConfig["icon"]): IconSpec | undefined {
  const spec = typeof option === "string" ? { source: option } : option;
  const source = spec?.source ?? ICON_CANDIDATES.find((f) => existsSync(join(root, f)));
  return source ? { ...spec, source: resolve(root, source) } : undefined;
}

export function resolveConfig(root: string, config: Partial<DesktopConfig>, configFile: string | null = null): ResolvedConfig {
  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
  const appName = config.appName ?? pkg.productName ?? pkg.name;
  if (!appName) throw new Error("svelte-desktop: `appName` is required (desktop.config.ts)");
  const identifier = config.identifier ?? `dev.svelte-desktop.${String(appName).toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(identifier))
    throw new Error(`svelte-desktop: identifier "${identifier}" must be reverse-DNS (e.g. com.example.app)`);
  const nativeDir = config.native === false ? null : resolve(root, config.native ?? "native");
  // `SVELTE_DESKTOP_TARGET=windows vite build` builds another target without editing the config.
  const envTarget = process.env.SVELTE_DESKTOP_TARGET as BuildConfig["target"] | undefined;
  const envArch = process.env.SVELTE_DESKTOP_TARGET_ARCH as BuildConfig["targetArch"] | undefined;
  const build = envTarget || envArch ? { ...config.build, ...(envTarget && { target: envTarget }), ...(envArch && { targetArch: envArch }) } : config.build;
  const osPermissions: Record<string, string> = { ...config.usageDescriptions };
  for (const [k, v] of Object.entries(config.permissions ?? {})) if (k !== "pages" && typeof v === "string") osPermissions[k] = v;
  const bridgeAllow = config.bridge?.allow ?? config.permissions?.pages;
  return {
    ...config,
    osPermissions,
    bridgeAllow,
    build,
    root,
    appName,
    identifier,
    version: config.version ?? pkg.version ?? "0.0.0",
    window: config.window === false ? false : (config.window ?? {}),
    native: nativeDir && existsSync(nativeDir) ? nativeDir : null,
    icon: findIcon(root, config.icon),
    configFile,
  };
}
