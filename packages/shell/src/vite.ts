// The one line an app needs:
//
//   // vite.config.ts
//   import { desktop } from '@svelte-desktop/shell/vite';
//   export default defineConfig({ plugins: [desktop({ experimental: { remoteFunctions: true } })] });
//
// `desktop(kitOptions)` is SvelteKit's own plugin, wired with the desktop adapter,
// plus dev mode. App settings live in desktop.config.ts (see config.ts).
//   vite dev    → the real native window on the Vite server: HMR, Web Inspector,
//                 native API from pages and server code, native plugin rebuilt on change
//   vite build  → signed .app + zip + DMG (+ release/ for the updater) in .desktop/dist
// Runs on Bun: `bunx --bun vite dev` / `bunx --bun vite build`.
// Minimal structural types: this package doesn't depend on a particular Vite install.
interface ViteDevServer {
  config: { logger: { info(m: string, o?: object): void; error(m: string): void } };
  resolvedUrls: { local: string[] } | null;
  httpServer: { listening: boolean; once(ev: string, fn: () => void): void } | null;
  watcher: { add(path: string): void; on(ev: string, fn: (file: string) => void): void };
  middlewares: { use(fn: (req: unknown, res: unknown, next: () => void) => void): void };
  restart(): Promise<void>;
  close(): Promise<void>;
}
interface Plugin {
  name: string;
  apply?: "serve" | "build";
  configureServer?(server: ViteDevServer): void;
  transform?(code: string, id: string): string | undefined | null;
  [key: string]: unknown;
}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ICON_CANDIDATES, findIcon, loadConfig, sidecarEntries, type DesktopConfig, type ResolvedConfig } from "./config.ts";
import desktopAdapter from "./adapter.js";

export type { DesktopConfig } from "./config.ts";
export { defineConfig } from "./config.ts";

const shellRoot = resolve(import.meta.dir, "..");

interface DevState {
  child: ReturnType<typeof Bun.spawn> | null;
  bridge: { close(): void } | null;
  restarting: boolean;
}
// Survives Vite's in-process restarts (config edits re-instantiate plugins).
const STATE_KEY = Symbol.for("svelte-desktop.dev");
const devState = ((globalThis as any)[STATE_KEY] ??= { child: null, bridge: null, restarting: false }) as DevState;

export interface DesktopPluginOptions {
  /** Override/extend desktop.config.ts inline. */
  config?: Partial<DesktopConfig>;
  /** Stop `vite dev` when the app window is closed (like `tauri dev`). Default true. */
  exitOnClose?: boolean;
  /** Don't open the native window in dev (browser-only dev). Default: $SVELTE_DESKTOP_NO_WINDOW. */
  noWindow?: boolean;
}

/** SvelteKit + svelte-desktop. `kitOptions` are SvelteKit's plugin options (adapter excluded). */
/** Types for the `host` global: a one-line src/host.d.ts, written once (keep it in git). */
function writeHostTypes(root: string) {
  const file = join(root, "src", "host.d.ts");
  if (existsSync(file) || !existsSync(join(root, "src"))) return;
  writeFileSync(file, "// The `host` global (svelte-desktop): typed for page and server code.\nimport '@svelte-desktop/shell/globals';\n");
}

export async function desktop(kitOptions: Record<string, unknown> = {}, options: DesktopPluginOptions = {}): Promise<Plugin[]> {
  if (typeof Bun === "undefined") throw new Error("svelte-desktop runs on Bun: use `bunx --bun vite …`");
  const config = await loadConfig(process.cwd(), options.config);
  writeHostTypes(config.root);
  const kitPath = Bun.resolveSync("@sveltejs/kit/vite", config.root);
  const { sveltekit } = await import(kitPath);
  const kit = (await sveltekit({ ...kitOptions, adapter: desktopAdapter(config) })) as Plugin[];
  return [...kit, hydrationMarker(config.osPermissions, { foreground: config.notifications?.foreground ?? true }, { server: config.push?.server ?? null }), pushServiceWorker(), devPlugin(config, options)];
}

// SvelteKit has no public "hydrated" signal; tests (and apps) need one. Wrap the
// client runtime's start(): once it resolves, <html data-desktop-hydrated> is set
// and a `desktop:hydrated` event fires. No-op if Kit's code changes shape.
function hydrationMarker(permissionsConfig: Record<string, string>, notificationsConfig: { foreground: boolean }, pushConfig: { server: string | null }): Plugin {
  const hostClient = JSON.stringify(join(shellRoot, "src", "host", "client.ts"));
  const hostServer = JSON.stringify(join(shellRoot, "src", "host", "server.ts"));
  return {
    name: "svelte-desktop:hydration-marker",
    // desktop.config `permissions` (name → reason) for host.permissions, in page and server code.
    config: () => ({
      // The client below is imported by absolute path: serve it even when the shell sits
      // outside the app's allow list (a linked checkout, a monorepo sibling).
      server: { fs: { allow: [shellRoot] } },
      define: {
        __SVELTE_DESKTOP_PERMISSIONS__: JSON.stringify(permissionsConfig),
        __SVELTE_DESKTOP_NOTIFICATIONS__: JSON.stringify(notificationsConfig),
        __SVELTE_DESKTOP_PUSH__: JSON.stringify(pushConfig),
      },
    }),
    transform(code, id) {
      // The `host` global in server code: installed with SvelteKit's server runtime.
      if (/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]server[\\/]index\.js/.test(id)) return `import ${hostServer};\n${code}`;
      if (!/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/]client\.js/.test(id)) return;
      // Kit 3: start() → async _start() (hydration + first navigation).
      if (!code.includes("async function _start(")) return;
      return (
        // …and in the page, before the app's components load.
        `import ${hostClient};\n` +
        code.replace("async function _start(", "async function __desktop_start(") +
        `\nglobalThis.__desktopGoto = (url) => goto(url);\nasync function _start(...args) {\n\tconst r = await __desktop_start(...args);\n\tdocument.documentElement.setAttribute('data-desktop-hydrated', '');\n\twindow.dispatchEvent(new Event('desktop:hydrated'));\n\treturn r;\n}\n`
      );
    },
  };
}

// The Web Push service worker (src/push/service-worker.js) for the app opened in a browser:
// /__desktop/push-sw.js in dev and in the client build.
function pushServiceWorker(): Plugin {
  const file = join(shellRoot, "src", "push", "service-worker.js");
  return {
    name: "svelte-desktop:push-sw",
    configureServer(server) {
      server.middlewares.use((rq, rs, next) => {
        const req = rq as { url?: string }, res = rs as { setHeader(k: string, v: string): void; end(b: Buffer): void };
        if (req.url?.split("?")[0] !== "/__desktop/push-sw.js") return next();
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.end(readFileSync(file));
      });
    },
    generateBundle(this: { environment?: { name: string }; emitFile(f: { type: "asset"; fileName: string; source: string }): void }, output: { dir?: string }) {
      const env = this.environment?.name;
      if (env ? env !== "client" : !/output[\\/]client/.test(output.dir ?? "")) return;
      this.emitFile({ type: "asset", fileName: "__desktop/push-sw.js", source: readFileSync(file, "utf8") });
    },
  };
}

function devPlugin(config: ResolvedConfig, options: DesktopPluginOptions): Plugin {
  let server: ViteDevServer;
  const log = (m: string) => server?.config.logger.info(`\x1b[35m[desktop]\x1b[0m ${m}`, { timestamp: true });

  // Server code (load, remote functions) runs in this process in dev and may use
  // addons and sidecars with or without the native window (browser / mobile dev).
  async function prepareServerNatives() {
    // Background jobs run from their sources in dev.
    process.env.SVELTE_DESKTOP_JOBS_DIR = join(config.root, "src", "jobs");
    process.env.SVELTE_DESKTOP_JOBS_RUNNER = join(shellRoot, "src", "jobs", "dev-runner.ts");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    try {
      const { buildAddons } = await import("./build/native.ts");
      const addons = await buildAddons(config, { arches: [arch], outDir: join(config.root, ".desktop/dev/addons"), quiet: true });
      process.env.SVELTE_DESKTOP_ADDONS = JSON.stringify(addons);
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    const os = process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos";
    for (const [name, path] of sidecarEntries(config, os))
      process.env[`SVELTE_DESKTOP_SIDECAR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = path;
  }

  // The app icon, in the Dock the built app will have (dev runs as `bun`): generated like the
  // build does, and pushed to the running window when the image changes, appears or goes.
  const explicitIcon = config.icon && !ICON_CANDIDATES.some((f) => resolve(config.root, f) === config.icon!.source) ? config.icon : undefined;
  const iconFiles = explicitIcon ? [explicitIcon.source] : ICON_CANDIDATES.map((f) => resolve(config.root, f));
  let icon = config.icon;
  async function devIcon(): Promise<string | undefined> {
    if (!icon) return undefined;
    try {
      return (await (await import("./build/icons.ts")).appIcons(config.root, icon)).macosPng;
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
      return undefined;
    }
  }
  async function iconChanged(file: string) {
    if (!iconFiles.includes(file)) return;
    const found = explicitIcon ?? findIcon(config.root, undefined);
    icon = found && { ...found, background: config.icon?.background };
    const png = await devIcon();
    if (!devState.bridge) return;
    const { app } = await import("./platform/index.ts");
    await app.setDockIcon(png ?? null).catch(() => {}); // macOS only
    log(icon ? `icon → ${relative(config.root, icon.source)}` : "icon removed");
  }

  async function startShell(url: string) {
    const { ensureLibshell } = await import("./build/package.ts");
    const { buildNativePlugin } = await import("./build/native.ts");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const lib = await ensureLibshell(arch);
    const plugins: string[] = [];
    const outDir = join(config.root, ".desktop/dev/native");
    try {
      const plugin = await buildNativePlugin(config, { arches: [arch], outDir, quiet: true });
      if (plugin) plugins.push(plugin);
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    // Rust / Go plugins (native/rust, native/go).
    try {
      const { buildLanguagePlugins, hostOS } = await import("./build/native-langs.ts");
      plugins.push(...(await buildLanguagePlugins(config, { os: hostOS(), arches: [arch], outDir, release: false })));
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    // Every plugin's commands, typed for `native` in src/native.d.ts.
    if (plugins.length) {
      const { typeNativePlugins } = await import("./build/native-types.ts");
      const count = await typeNativePlugins(config.root, plugins);
      log(`native: ${count} command${count === 1 ? "" : "s"} → src/native.d.ts`);
    }

    const appIcon = await devIcon();

    const dev = {
      appIcon,
      appName: config.appName,
      identifier: config.identifier,
      version: config.version,
      window: config.window,
      pagePermissions: config.bridgeAllow,
      lib,
      plugins,
      url,
    };
    const child = Bun.spawn([process.execPath, join(shellRoot, "src/dev/main.ts")], {
      env: { ...process.env, SVELTE_DESKTOP_DEV: JSON.stringify(dev) },
      stdout: "pipe",
      stderr: "inherit",
      cwd: config.root,
    });
    devState.child = child;
    log(`window → ${url}${plugins.length ? ` (native ${plugins.map((p) => relative(config.root, p)).join(", ")})` : ""}`);

    // Read the RPC address, forward everything else.
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith("SVELTE_DESKTOP_DEV_READY ")) {
            const { rpc } = JSON.parse(line.slice(25));
            const { connectDevShell } = await import("./dev/bridge.ts");
            devState.bridge?.close();
            devState.bridge = await connectDevShell(rpc, { appName: config.appName, identifier: config.identifier, origin: new URL(url).origin });
          } else if (line.trim()) {
            console.log(line);
          }
        }
      }
    })().catch((err) => server.config.logger.error(`[desktop] ${err}`));

    child.exited.then((code) => {
      if (devState.child !== child) return;
      devState.child = null;
      devState.bridge?.close();
      devState.bridge = null;
      if (devState.restarting) return;
      log(`window closed (exit ${code})`);
      if (options.exitOnClose !== false) {
        server.close().finally(() => process.exit(0));
      }
    });
  }

  async function restartShell(url: string) {
    devState.restarting = true;
    const old = devState.child;
    if (old) {
      old.kill("SIGTERM");
      await old.exited;
    }
    devState.restarting = false;
    await startShell(url);
  }

  return {
    name: "svelte-desktop:dev",
    apply: "serve",
    configureServer(s) {
      server = s;
      const natives = prepareServerNatives();
      s.middlewares.use((_req: unknown, _res: unknown, next: () => void) => void natives.then(() => next()));
      if (options.noWindow || process.env.SVELTE_DESKTOP_NO_WINDOW) return;
      const watched = [config.configFile, config.native, ...iconFiles].filter(Boolean) as string[];
      for (const w of watched) s.watcher.add(w);
      s.watcher.on("add", (file) => void iconChanged(file));
      s.watcher.on("unlink", (file) => void iconChanged(file));
      s.watcher.on("change", (file) => {
        if (iconFiles.includes(file)) void iconChanged(file);
        // Written by the builds themselves (cargo's lockfile, a target/ from a manual build): not edits.
        else if (config.native && file.startsWith(config.native) && !/[\\/](target[\\/]|Cargo\.lock$)/.test(file)) {
          const url = s.resolvedUrls?.local[0];
          if (url) {
            log(`native plugin changed — rebuilding, restarting the window`);
            void restartShell(url);
          }
        } else if (file === config.configFile) {
          log("desktop.config changed — restarting");
          devState.restarting = true;
          devState.child?.kill("SIGTERM");
          void s.restart();
        }
      });
      const launch = () => {
        const url = s.resolvedUrls?.local[0];
        if (!url) return;
        devState.restarting = false;
        if (devState.child) return; // kept across Vite restarts
        void startShell(url);
      };
      if (s.httpServer?.listening) launch();
      else s.httpServer?.once("listening", () => setTimeout(launch, 0));
      s.httpServer?.once("close", () => {
        if (devState.restarting) return;
        devState.child?.kill("SIGTERM");
        devState.child = null;
      });
    },
  };
}

export default desktop;
