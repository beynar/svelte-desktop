import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundledLibDir, libshellName, pluginName } from "./os.ts";

// libshell lives in Contents/Frameworks, signed like the rest of the bundle (a
// dylib extracted from the executable to a temp dir would carry no signature)
// and per-architecture in universal builds.
export function resolveLib(): string {
  if (process.env.SVELTE_DESKTOP_LIB) return process.env.SVELTE_DESKTOP_LIB;
  const bundled = join(bundledLibDir(), libshellName());
  if (!existsSync(bundled)) throw new Error(`${libshellName()} not found in ${bundledLibDir()} (run the packaged app, or set SVELTE_DESKTOP_LIB)`);
  return bundled;
}

/** The app's native plugins: libapp-native, then the Rust and Go ones in plugins/ next to it. */
export function resolvePlugins(): string[] {
  const dir = bundledLibDir();
  const main = join(dir, pluginName());
  const extra = join(dir, "plugins");
  return [...(existsSync(main) ? [main] : []), ...(existsSync(extra) ? readdirSync(extra).sort().map((f) => join(extra, f)) : [])];
}

/** Path of a sidecar executable declared in desktop.config `sidecars`. */
export function sidecarPath(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid sidecar name ${name}`);
  const dev = process.env[`SVELTE_DESKTOP_SIDECAR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (dev) return dev;
  const file = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  const bundled = join(dirname(process.execPath), file);
  if (!existsSync(bundled)) throw new Error(`sidecar "${name}" is not bundled (desktop.config sidecars)`);
  return bundled;
}

/** Path of a Node-API addon: dev build dir, else Contents/Frameworks/addons. */
export function addonPath(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid addon name ${name}`);
  const dev = process.env.SVELTE_DESKTOP_ADDONS ? JSON.parse(process.env.SVELTE_DESKTOP_ADDONS)[name] : undefined;
  if (dev) return dev;
  const bundled = join(bundledLibDir(), "addons", `${name}.node`);
  if (!existsSync(bundled)) throw new Error(`addon "${name}" is not bundled (native/addons/${name}.c or desktop.config addons)`);
  return bundled;
}
