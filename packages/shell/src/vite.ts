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
import { existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig, type DesktopConfig, type ResolvedConfig } from "./config.ts";
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
export async function desktop(kitOptions: Record<string, unknown> = {}, options: DesktopPluginOptions = {}): Promise<Plugin[]> {
  if (typeof Bun === "undefined") throw new Error("svelte-desktop runs on Bun: use `bunx --bun vite …`");
  const config = await loadConfig(process.cwd(), options.config);
  const kitPath = Bun.resolveSync("@sveltejs/kit/vite", config.root);
  const { sveltekit } = await import(kitPath);
  const kit = (await sveltekit({ ...kitOptions, adapter: desktopAdapter(config) })) as Plugin[];
  return [...kit, hydrationMarker(), devPlugin(config, options)];
}

// SvelteKit has no public "hydrated" signal; tests (and apps) need one. Wrap the
// client runtime's start(): once it resolves, <html data-desktop-hydrated> is set
// and a `desktop:hydrated` event fires. No-op if Kit's code changes shape.
function hydrationMarker(): Plugin {
  return {
    name: "svelte-desktop:hydration-marker",
    transform(code, id) {
      if (!/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/]client\.js/.test(id)) return;
      // Kit 3: start() → async _start() (hydration + first navigation).
      if (!code.includes("async function _start(")) return;
      return (
        code.replace("async function _start(", "async function __desktop_start(") +
        `\nasync function _start(...args) {\n\tconst r = await __desktop_start(...args);\n\tdocument.documentElement.setAttribute('data-desktop-hydrated', '');\n\twindow.dispatchEvent(new Event('desktop:hydrated'));\n\treturn r;\n}\n`
      );
    },
  };
}

function devPlugin(config: ResolvedConfig, options: DesktopPluginOptions): Plugin {
  let server: ViteDevServer;
  const log = (m: string) => server?.config.logger.info(`\x1b[35m[desktop]\x1b[0m ${m}`, { timestamp: true });

  async function startShell(url: string) {
    const { ensureLibshell } = await import("./build/package.ts");
    const { buildNativePlugin } = await import("./build/native.ts");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const lib = await ensureLibshell(arch);
    let plugin: string | null = null;
    try {
      plugin = await buildNativePlugin(config, { arches: [arch], outDir: join(config.root, ".desktop/dev/native"), quiet: true });
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    try {
      const { buildAddons } = await import("./build/native.ts");
      const addons = await buildAddons(config, { arches: [arch], outDir: join(config.root, ".desktop/dev/addons"), quiet: true });
      process.env.SVELTE_DESKTOP_ADDONS = JSON.stringify(addons); // server code runs in this process in dev
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    for (const [name, src] of Object.entries(config.sidecars ?? {}))
      process.env[`SVELTE_DESKTOP_SIDECAR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = resolve(config.root, src);

    const dev = {
      appName: config.appName,
      identifier: config.identifier,
      version: config.version,
      window: config.window,
      pagePermissions: config.permissions?.pages,
      lib,
      plugin,
      url,
    };
    const child = Bun.spawn([process.execPath, join(shellRoot, "src/dev/main.ts")], {
      env: { ...process.env, SVELTE_DESKTOP_DEV: JSON.stringify(dev) },
      stdout: "pipe",
      stderr: "inherit",
      cwd: config.root,
    });
    devState.child = child;
    log(`window → ${url}${plugin ? ` (native plugin ${relative(config.root, plugin)})` : ""}`);

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
      if (options.noWindow || process.env.SVELTE_DESKTOP_NO_WINDOW) return;
      const watched = [config.configFile, config.native].filter(Boolean) as string[];
      for (const w of watched) s.watcher.add(w);
      s.watcher.on("change", (file) => {
        if (config.native && file.startsWith(config.native)) {
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
