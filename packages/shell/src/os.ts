// Per-OS conventions used by the runtime and the packager.
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OS = "darwin" | "linux" | "win32";
export const currentOS = (): OS => (process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin");

/** Per-user directories for an app identifier (created by the runtime). */
export function appDirs(identifier: string, os: OS = currentOS()) {
  const home = homedir();
  if (os === "win32") {
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return { home, data: join(roaming, identifier), cache: join(local, identifier, "Cache"), logs: join(local, identifier, "Logs") };
  }
  if (os === "linux") {
    const data = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
    const cache = process.env.XDG_CACHE_HOME ?? join(home, ".cache");
    const state = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
    return { home, data: join(data, identifier), cache: join(cache, identifier), logs: join(state, identifier, "logs") };
  }
  return {
    home,
    data: join(home, "Library", "Application Support", identifier),
    cache: join(home, "Library", "Caches", identifier),
    logs: join(home, "Library", "Logs", identifier),
  };
}

/** File name of the native shell library. */
export function libshellName(os: OS = currentOS()): string {
  return os === "win32" ? "shell.dll" : os === "linux" ? "libshell.so" : "libshell.dylib";
}
/** File name of an app native plugin. */
export function pluginName(os: OS = currentOS()): string {
  return os === "win32" ? "app-native.dll" : os === "linux" ? "libapp-native.so" : "libapp-native.dylib";
}

/** Where bundled native libraries live relative to the running executable:
 *  macOS App.app/Contents/Frameworks, Linux <app>/lib, Windows next to the .exe. */
export function bundledLibDir(os: OS = currentOS()): string {
  const exeDir = dirname(process.execPath);
  if (os === "win32") return exeDir;
  if (os === "linux") return join(exeDir, "lib");
  return join(exeDir, "..", "Frameworks");
}
