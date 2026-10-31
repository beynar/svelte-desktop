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
  /** PNG (1024×1024 recommended), relative to the project. Default static/icon.png if present. */
  icon?: string;
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
  /** Info.plist usage strings, e.g. { camera: 'Scan documents' } or raw NS…UsageDescription keys. */
  usageDescriptions?: Record<string, string>;
  /** LSUIElement: no Dock icon, no app menu. */
  trayOnly?: boolean;
  /** Native plugin sources (Swift/ObjC/C). Default 'native' if the folder exists. */
  native?: string | false;
  /** Prebuilt Node-API addons (`.node`) to ship, reachable with `loadAddon(name)` from server code.
   *  Sources in native/addons/*.c are compiled automatically. */
  addons?: Record<string, string>;
  /** Executables shipped in Contents/MacOS and reachable with `sidecar(name)`. */
  sidecars?: Record<string, string>;
  /** Native ops pages may call (`service.op` or `service.*`). Server code is never restricted.
   *  Default: everything. */
  permissions?: { pages?: string[] };
  /** Extra Info.plist keys. */
  plist?: Record<string, unknown>;
  build?: BuildConfig;
  sign?: SignConfig;
}

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
  icon?: string;
  configFile: string | null;
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

export function resolveConfig(root: string, config: Partial<DesktopConfig>, configFile: string | null = null): ResolvedConfig {
  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
  const appName = config.appName ?? pkg.productName ?? pkg.name;
  if (!appName) throw new Error("svelte-desktop: `appName` is required (desktop.config.ts)");
  const identifier = config.identifier ?? `dev.svelte-desktop.${String(appName).toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(identifier))
    throw new Error(`svelte-desktop: identifier "${identifier}" must be reverse-DNS (e.g. com.example.app)`);
  const nativeDir = config.native === false ? null : resolve(root, config.native ?? "native");
  const iconGuess = config.icon ?? (existsSync(join(root, "static/icon.png")) ? "static/icon.png" : undefined);
  return {
    ...config,
    root,
    appName,
    identifier,
    version: config.version ?? pkg.version ?? "0.0.0",
    window: config.window === false ? false : (config.window ?? {}),
    native: nativeDir && existsSync(nativeDir) ? nativeDir : null,
    icon: iconGuess ? resolve(root, iconGuess) : undefined,
    configFile,
  };
}
