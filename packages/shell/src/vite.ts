// The one line an app needs:
//
//   // vite.config.ts
//   import { desktop } from '@kitop/shell/vite';
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
  config: { logger: { info(m: string, o?: object): void; error(m: string): void }; server: { allowedHosts?: true | string[] } };
  resolvedUrls: { local: string[] } | null;
  httpServer: { listening: boolean; once(ev: string, fn: () => void): void; on(ev: string, fn: (...args: any[]) => void): void } | null;
  watcher: { add(path: string): void; on(ev: string, fn: (file: string) => void): void };
  middlewares: { use(fn: (req: unknown, res: unknown, next: (err?: unknown) => void) => void): void };
  ssrLoadModule(id: string): Promise<Record<string, any>>;
  restart(): Promise<void>;
  close(): Promise<void>;
}
interface Plugin {
  name: string;
  apply?: "serve" | "build";
  configureServer?(server: ViteDevServer): void | Promise<void>;
  transform?(code: string, id: string): string | undefined | null;
  [key: string]: unknown;
}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ICON_CANDIDATES, findIcon, loadConfig, sidecarEntries, usageDescriptions, type DesktopConfig, type ResolvedConfig } from "./config.ts";
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
const STATE_KEY = Symbol.for("kitop.dev");
const devState = ((globalThis as any)[STATE_KEY] ??= { child: null, bridge: null, restarting: false }) as DevState;

export interface DesktopPluginOptions {
  /** Override/extend desktop.config.ts inline. */
  config?: Partial<DesktopConfig>;
  /** Stop `vite dev` when the app window is closed (like `tauri dev`). Default true. */
  exitOnClose?: boolean;
  /** Don't open the native window in dev (browser-only dev). Default: $KITOP_NO_WINDOW. */
  noWindow?: boolean;
}

/** SvelteKit + kitop. `kitOptions` are SvelteKit's plugin options (adapter excluded). */
/** Types for the `host` global: a one-line src/host.d.ts, written once (keep it in git). */
function writeHostTypes(root: string) {
  const file = join(root, "src", "host.d.ts");
  if (existsSync(file) || !existsSync(join(root, "src"))) return;
  writeFileSync(file, "// The `host` global (kitop): typed for page and server code.\nimport '@kitop/shell/globals';\n");
}

export async function desktop(kitOptions: Record<string, unknown> = {}, options: DesktopPluginOptions = {}): Promise<Plugin[]> {
  if (typeof Bun === "undefined") throw new Error("kitop runs on Bun: use `bunx --bun vite …`");
  const config = await loadConfig(process.cwd(), options.config);
  // In dev, the app's server runs in this process: the system's certificates and proxy for it too.
  if (process.env.NODE_ENV !== "production") (await import("./system-network.ts")).applySystemNetwork(config.network);
  writeHostTypes(config.root);
  const kitPath = Bun.resolveSync("@sveltejs/kit/vite", config.root);
  const { sveltekit } = await import(kitPath);
  const kit = (await sveltekit({ ...kitOptions, adapter: desktopAdapter(config) })) as Plugin[];
  return [...kit, hydrationMarker(config.osPermissions, { foreground: config.notifications?.foreground ?? true }, { server: config.push?.server ?? null }), pushServiceWorker(), oauthDev(config.appName), websocketDev(config), serverEntry(config, "websocket"), serverEntry(config, "mcp"), mcpDev(config), devPlugin(config, options)];
}

// SvelteKit has no public "hydrated" signal; tests (and apps) need one. Wrap the
// client runtime's start(): once it resolves, <html data-desktop-hydrated> is set
// and a `desktop:hydrated` event fires. No-op if Kit's code changes shape.
function hydrationMarker(permissionsConfig: Record<string, string>, notificationsConfig: { foreground: boolean }, pushConfig: { server: string | null }): Plugin {
  const hostClient = JSON.stringify(join(shellRoot, "src", "host", "client.ts"));
  const hostServer = JSON.stringify(join(shellRoot, "src", "host", "server.ts"));
  return {
    name: "kitop:hydration-marker",
    // desktop.config `permissions` (name → reason) for host.permissions, in page and server code.
    config: () => ({
      // The client below is imported by absolute path: serve it even when the shell sits
      // outside the app's allow list (a linked checkout, a monorepo sibling).
      server: { fs: { allow: [shellRoot] } },
      define: {
        __KITOP_PERMISSIONS__: JSON.stringify(permissionsConfig),
        __KITOP_NOTIFICATIONS__: JSON.stringify(notificationsConfig),
        __KITOP_PUSH__: JSON.stringify(pushConfig),
      },
    }),
    transform(code, id) {
      // The `host` global in server code: installed with SvelteKit's server runtime.
      if (/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]server[\\/]index\.js/.test(id))
        return (
          `import { withRequest as __desktopWithRequest } from ${hostServer};\n${code.replace("export async function configure(", "async function __desktop_configure(")}` +
          // Each request knows whether a view made it (X-Desktop-View): see host/server.ts.
          // Kit 3 serves through configure() (dev, adapters, Server): wrap the instance's respond.
          (code.includes("export async function configure(")
            ? `\nexport async function configure(opts) {\n\tconst instance = await __desktop_configure(opts);\n\treturn { ...instance, respond: (request, options) => __desktopWithRequest(request, () => instance.respond(request, options)) };\n}\n`
            : "")
        );
      if (!/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/]client\.js/.test(id)) return;
      // Kit 3: start() → async _start() (hydration + first navigation).
      if (!code.includes("async function _start(")) return;
      return (
        // …and in the page, before the app's components load.
        `import ${hostClient};\n` +
        code
          .replace("async function _start(", "async function __desktop_start(")
          // The window's address moves through entries of its own (a pane's, a kept tab's), so Kit can be at an
          // index it has dropped from its table. Writing the scroll there threw, in the middle of a navigation:
          // that one never ended, and neither did any after it.
          .replace("history_info[index].scroll = scroll_state();", "(history_info[index] ??= {}).scroll = scroll_state();")
          // What goto() was asked: its entry doesn't say (refreshAll), nor does a navigation canceled before one.
          .replace("export async function goto(url, opts = {}) {", "export async function goto(url, opts = {}) {\n\tglobalThis.__desktopGotoAsked = opts;")
          // Going to the page it has, the address elsewhere (a kept-alive tab's, a pane's): it keeps
          // \`page\`, which has the address in it, and would go there instead.
          .replace(
            "if (navigation_result.props.page.url.pathname !== url.pathname) {",
            "if (url.href === current.url?.href) navigation_result.props.page.url = new URL(url);\n\tif (navigation_result.props.page.url.pathname !== url.pathname) {",
          ) +
        // Before SvelteKit's own, in the order they're registered: its router starts later. A traversal for
        // nobody to see (\`split\`), and a link's click once the page had its say, before SvelteKit has it.
        `\nif (typeof document !== 'undefined') {\n\taddEventListener('popstate', (e) => { if (globalThis.__desktopOnPopstate?.()) e.stopImmediatePropagation(); }, true);\n\tdocument.documentElement.addEventListener('click', (e) => globalThis.__desktopOnLink?.(e));\n}\n` +
        // \`stateJson\`: a state serialized in another page's Kit (a pane's, from the window's).
        // \`pageUrl\`: a shallow entry's page, there first (as Kit does when it comes back to one).
        `\nglobalThis.__desktopGoto = async (url, { stateJson, pageUrl, traversal, ...opts } = {}) => {\n\tif (opts.shallow && pageUrl && current.url?.href !== pageUrl) {\n\t\tawait goto(pageUrl, { replace: true });\n\t\tif (current.url?.href !== pageUrl) return; // canceled: the entry is that page's\n\t}\n\tawait goto(url, stateJson === undefined ? opts : { ...opts, state: parse(stateJson) });\n\tif (traversal) globalThis.__desktopRestoreScroll?.();\n};\n` +
        // Before a navigation, with `cancel` (a pane's page leaving for a keepAlive route's tab).
        `globalThis.__desktopBeforeNavigate = (fn) => (before_navigate_callbacks.add(fn), () => before_navigate_callbacks.delete(fn));\n` +
        // A link out of the app, opened elsewhere (a pane's page): this page isn't about to unload after all.
        `globalThis.__desktopNavigating = () => is_navigating;\n` +
        `globalThis.__desktopStaying = (was) => { is_navigating = was; };\n` +
        `globalThis.__desktopAfterNavigate = (fn) => (after_navigate_callbacks.add(fn), () => after_navigate_callbacks.delete(fn));\n` +
        // The route an address is, as Kit resolves it (matchers, static routes first); null if none.
        `globalThis.__desktopRouteOf = async (href) => (await get_navigation_intent(new URL(href, location.href), false))?.route?.id ?? null;\n` +
        // The state of the current entry (goto's \`state\`).
        `globalThis.__desktopSerialized = (state) => stringify(state);\n` +
        `globalThis.__desktopEntryState = () => { const state = get_history_metadata()?.state; return state === undefined ? undefined : parse(state); };\n` +
        // The same for another page's goto(): serialized as Kit keeps it, and whether it's shallow (its page stays).
        `globalThis.__desktopEntryOptions = () => { const m = get_history_metadata(); return m ? { stateJson: m.state, ...(m.pageUrl && { shallow: true, pageUrl: m.pageUrl }) } : (history.state?.desktopEntry ?? {}); };\n` +
        // A kept-alive tab's address, without navigating (no load, no page code: its view runs the
        // page): an entry Kit didn't make — it ignores it, back and forward included — and page.url.
        `globalThis.__desktopAddress = (url, index, replace, entry) => {\n\tHistory.prototype[replace ? 'replaceState' : 'pushState'].call(history, { desktopAddress: true, desktopIndex: index, desktopEntry: entry }, '', url);\n\tupdate_page({ url: new URL(location.href) });\n};\n` +
        // The address changed behind its back (an entry taken back, a pane's page having canceled it).
        `globalThis.__desktopAddressFollows = () => {\n\tconst m = get_history_metadata();\n\tif (m) {\n\t\tcurrent_history_index = m.historyIndex;\n\t\tcurrent_navigation_index = m.navigationIndex;\n\t\trestore_snapshot(current_navigation_index);\n\t}\n\tconst url = new URL(location.href);\n\tupdate_page({ url, state: m?.state === undefined ? {} : parse(m.state), shallow: null });\n\tconst token = navigation_token;\n\tconst entry = history.state;\n\tif (m?.pageUrl) void get_navigation_intent(url, false).then((intent) => token === navigation_token && entry === history.state && update_page({ shallow: { params: intent?.params ?? null, route: intent ? { id: intent.route.id } : null, url } }));\n};\n` +
        // The page Kit has (the address may be a kept-alive tab's): back to it is the address alone.
        `globalThis.__desktopPageUrl = () => current.url && current.url.pathname + current.url.search + current.url.hash;\n` +
        // Where the page says it is: an entry of its own made by pushState() from $app/navigation (a
        // modal's address) has the page's URL in it. An address going elsewhere doesn't count until Kit gets there.
        `globalThis.__desktopShownUrl = () => get_history_metadata()?.pageUrl && get_history_metadata().pageUrl === current.url?.href ? location.pathname + location.search + location.hash : globalThis.__desktopPageUrl();\n` +
        // Back / forward Kit leaves alone (to or from such an entry): page.url follows the address.
        // Before Kit's own listener, which moves its index for the entries it handles.
        `addEventListener('popstate', (event) => {\n\tconst index = get_history_metadata(event.state)?.historyIndex;\n\tif ((!index || index === current_history_index) && page.url.href !== location.href) update_page({ url: new URL(location.href) });\n});\n` +
        `async function _start(...args) {\n\tconst r = await __desktop_start(...args);\n\tdocument.documentElement.setAttribute('data-desktop-hydrated', '');\n\twindow.dispatchEvent(new Event('desktop:hydrated'));\n\treturn r;\n}\n`
      );
    },
  };
}

// OAuth loopback redirects in dev (oauth-server.ts): the same routes on the Vite server, which serves
// the page there (the built app's own server has them behind its session cookie).
function oauthDev(appName: string): Plugin {
  type NodeReq = AsyncIterable<Buffer> & { url?: string; method?: string; headers: Record<string, string | string[] | undefined>; on(e: "close", f: () => void): void };
  type Next = (err?: unknown) => void;
  type NodeRes = { statusCode: number; writableEnded: boolean; setHeader(k: string, v: string): void; end(b?: string | Uint8Array): void; on(e: "close", f: () => void): void };
  return {
    name: "kitop:oauth",
    configureServer(server) {
      server.middlewares.use((rq, rs, next) => {
        const req = rq as unknown as NodeReq, res = rs as unknown as NodeRes;
        if (!req.url?.startsWith("/__desktop/oauth/")) return next();
        let gone = false;
        const abort = new AbortController();
        // The client gone before the answer (the request's own 'close' also fires once its body is read).
        res.on("close", () => void (res.writableEnded || ((gone = true), abort.abort())));
        (async () => {
          const { OAUTH_CALLBACK, oauthCallback, oauthRoutes } = await import("./oauth-server.ts");
          const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);
          const send = async (response: Response) => {
            if (gone) return;
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            res.end(new Uint8Array(await response.arrayBuffer()));
          };
          if (url.pathname === OAUTH_CALLBACK) return send(oauthCallback(url, appName)!);
          // start / cancel: the dev server's own pages only (no session cookie in dev) — a same-origin
          // POST carries its Origin. wait (GET: no Origin from the page itself) reads a random id only
          // the starting page knows; a foreign Origin is still refused.
          const origin = req.headers.origin ? String(req.headers.origin) : "";
          let own = false;
          try {
            own = new URL(origin).host === req.headers.host;
          } catch {}
          if (origin ? !own : req.method !== "GET") return send(new Response("Forbidden", { status: 403 }));
          let body: Uint8Array | undefined;
          if (req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c);
            body = Buffer.concat(chunks);
          }
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          const response = await oauthRoutes(new Request(url, { method: req.method, headers, body: body as BodyInit | undefined, signal: abort.signal }), url);
          return response ? send(response) : next();
        })().catch((err) => (gone ? undefined : next(err))); // a client gone mid-way isn't an error
      });
    },
  };
}

// WebSockets in dev (src/websocket.ts): the handlers are loaded through Vite's ssr runner (the same
// module instances as the SvelteKit server code, so state is shared), served by a Bun server on another port, and the
// Vite server hands it the upgrades on their paths (its own HMR socket aside).
function websocketDev(config: ResolvedConfig): Plugin {
  type UpgradeReq = { url?: string; method?: string; rawHeaders: string[]; headers: Record<string, string | string[] | undefined> };
  type Duplex = { write(b: string | Uint8Array): void; pipe<T>(d: T): T; destroy(): void; on(e: string, f: (...a: any[]) => void): void };
  return {
    name: "kitop:websocket",
    apply: "serve",
    async configureServer(vite) {
      const file = ["ts", "js"].map((ext) => join(config.root, "src", `websocket.${ext}`)).find((f) => existsSync(f));
      if (!file) return;
      const { socketCallbacks, socketPath, socketServer, upgradeSocket } = await import("./websocket.ts");
      const net = await import("node:net");
      let handlers: import("./websocket.ts").WebSocketHandlers<any> | undefined;
      // Through Vite each time: an edit to the file (or what it imports) applies to the next socket.
      const load = async () => {
        try {
          // SvelteKit's own runner (the ssr environment): the same module instances as the routes.
          const runner = (vite as unknown as { environments?: { ssr?: { runner?: { import(id: string): Promise<{ default: typeof handlers }> } } } }).environments?.ssr?.runner;
          handlers = (runner ? await runner.import(file) : await vite.ssrLoadModule(file)).default;
        } catch (err) {
          vite.config.logger.error(`\x1b[35m[desktop]\x1b[0m src/websocket: ${(err as Error).message}`);
        }
        return handlers;
      };
      // Only through the Vite server (which checks Host and Origin first): a token it adds.
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
      const sockets = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        websocket: socketCallbacks(),
        async fetch(req, srv) {
          if (req.headers.get("x-desktop-socket") !== token) return new Response("Forbidden", { status: 403 });
          const r = await upgradeSocket(() => handlers, req, srv);
          return r === null ? new Response("Not a WebSocket request", { status: 400 }) : r;
        },
      });
      const registration = socketServer(sockets);
      const stop = () => (registration.release(), sockets.stop(true));
      const refuse = (socket: Duplex, status: string) => (socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`), socket.destroy());
      // The page's own origin, on a host Vite serves (as Vite checks its own HMR socket).
      const allowedHost = (host: string) => {
        const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        const allowed = vite.config.server.allowedHosts;
        return ["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || allowed === true || (Array.isArray(allowed) && allowed.some((a) => (a.startsWith(".") ? name.endsWith(a) || name === a.slice(1) : name === a)));
      };
      vite.httpServer?.on("upgrade", async (req: UpgradeReq, socket: Duplex, head: Uint8Array) => {
        const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
        if (protocols.includes("vite-hmr") || protocols.includes("vite-ping")) return; // Vite's own socket
        const h = await load(); // the file as it is now: an edited path applies at once
        if (!h || !socketPath(h, new URL(req.url ?? "/", "http://x").pathname)) return;
        const host = String(req.headers.host ?? ""), origin = String(req.headers.origin ?? "");
        let sameOrigin = false;
        try {
          sameOrigin = !!origin && new URL(origin).host === host;
        } catch {}
        if (!allowedHost(host) || !sameOrigin) return refuse(socket, "403 Forbidden");
        const upstream = net.connect(sockets.port!, "127.0.0.1", () => {
          let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2)
            if (req.rawHeaders[i]!.toLowerCase() !== "x-desktop-socket") raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
          upstream.write(`${raw}x-desktop-socket: ${token}\r\n\r\n`);
          if (head?.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket as never);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      });
      // Gone with the Vite server, with or without an HTTP server of its own (middleware mode).
      vite.httpServer?.on("close", stop);
      const close = vite.close.bind(vite);
      vite.close = async () => (stop(), close());
    },
  };
}

/** What the dev shell prints once it's up (dev/main.ts), then its JSON. */
const DEV_READY = "KITOP_DEV_READY ";

// The app's MCP server in dev (src/mcp.ts): through Vite's ssr runner too, the file as it is now on
// each request, its list published again when it's edited.
function mcpDev(config: ResolvedConfig): Plugin {
  return {
    name: "kitop:mcp",
    apply: "serve",
    async configureServer(vite) {
      const file = ["ts", "js"].map((ext) => join(config.root, "src", `mcp.${ext}`)).find((f) => existsSync(f));
      if (!file) return;
      const { startMcpEndpoint } = await import("./mcp/app.ts");
      // The SDK as src/mcp.ts imports it, from the app (app.ts says why).
      const { createMcpHandler } = (await import(Bun.resolveSync("@modelcontextprotocol/server", config.root))) as typeof import("@modelcontextprotocol/server");
      type Factory = import("@modelcontextprotocol/server").McpServerFactory;
      const load = async (): Promise<Factory> => {
        const runner = (vite as unknown as { environments?: { ssr?: { runner?: { import(id: string): Promise<{ default: Factory }> } } } }).environments?.ssr?.runner;
        return (runner ? await runner.import(file) : await vite.ssrLoadModule(file)).default as Factory;
      };
      const served = startMcpEndpoint({ identifier: config.identifier, appName: config.appName, version: config.version ?? "0.0.0" }, createMcpHandler, load);
      const publish = () => void served.publish();
      if (vite.httpServer) vite.httpServer.once("listening", publish);
      else publish();
      // After Vite has dropped the file from its modules (its own watcher came first).
      vite.watcher.on("change", (changed) => void (changed === file && setTimeout(publish, 50)));
      const close = vite.close.bind(vite);
      vite.close = async () => (served.stop(), close());
    },
  };
}

// src/websocket.ts and src/mcp.ts in the build: one more entry of SvelteKit's server build, so each
// shares the server's modules (one instance of what both import) and resolves $app / $env / $lib like
// a route does. The adapter imports the built `desktop-websocket.js`, `desktop-mcp.js` (adapter.js).
function serverEntry(config: ResolvedConfig, name: "websocket" | "mcp"): Plugin {
  const file = ["ts", "js"].map((ext) => join(config.root, "src", `${name}.${ext}`)).find((f) => existsSync(f));
  return {
    name: `kitop:${name}-entry`,
    apply: "build",
    configEnvironment(environment: string, env: { build?: { rollupOptions?: { input?: unknown } } }) {
      if (!file || environment !== "ssr") return;
      const input = env.build?.rollupOptions?.input;
      if (input && typeof input === "object" && !Array.isArray(input)) (input as Record<string, string>)[`desktop-${name}`] = file;
    },
    options(this: { environment?: { name: string } }, opts: { input?: unknown }) {
      // Without configEnvironment's input (SvelteKit setting it later): the server build's own input.
      if (!file || this.environment?.name !== "ssr") return;
      if (opts.input && typeof opts.input === "object" && !Array.isArray(opts.input)) (opts.input as Record<string, string>)[`desktop-${name}`] ??= file;
    },
  } as Plugin;
}

// The Web Push service worker (src/push/service-worker.js) for the app opened in a browser:
// /__desktop/push-sw.js in dev and in the client build.
function pushServiceWorker(): Plugin {
  const file = join(shellRoot, "src", "push", "service-worker.js");
  return {
    name: "kitop:push-sw",
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
    process.env.KITOP_JOBS_DIR = join(config.root, "src", "jobs");
    process.env.KITOP_JOBS_RUNNER = join(shellRoot, "src", "jobs", "dev-runner.ts");
    process.env.KITOP_SERVICES_DIR = join(config.root, "src", "services");
    process.env.KITOP_SERVICES_RUNNER = join(shellRoot, "src", "services", "dev-runner.ts");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    try {
      const { buildAddons } = await import("./build/native.ts");
      const addons = await buildAddons(config, { arches: [arch], outDir: join(config.root, ".desktop/dev/addons"), quiet: true });
      process.env.KITOP_ADDONS = JSON.stringify(addons);
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    const os = process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos";
    for (const [name, path] of sidecarEntries(config, os))
      process.env[`KITOP_SIDECAR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = path;
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
    // Python commands (native/python): a uv environment, the bridge and its manifest.
    try {
      const { preparePythonDev } = await import("./build/python.ts");
      const py = await preparePythonDev(config, { arch, outDir });
      if (py) {
        plugins.push(py.lib);
        pythonCommands = py.commands;
      }
    } catch (err) {
      server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
    }
    // Every plugin's commands, typed for `native` in src/native.d.ts.
    if (plugins.length) {
      const { typeNativePlugins } = await import("./build/native-types.ts");
      const count = await typeNativePlugins(config.root, plugins);
      log(`native: ${count} command${count === 1 ? "" : "s"} → src/native.d.ts`);
    }

    // host.ai's native side (macOS): loaded with the plugins, not typed into native.d.ts.
    if (process.platform === "darwin") {
      const { ensureAiPlugin } = await import("./build/ai.ts");
      const aiLib = await ensureAiPlugin(arch, (m) => server.config.logger.info(`\x1b[35m[desktop]\x1b[0m ${m}`));
      if (aiLib) plugins.push(aiLib);
    }

    const appIcon = await devIcon();

    const dev = {
      appIcon,
      appName: config.appName,
      identifier: config.identifier,
      version: config.version,
      window: config.window,
      pagePermissions: config.bridgeAllow,
      usageDescriptions: usageDescriptions(config.osPermissions),
      protocols: config.protocols,
      lib,
      plugins,
      url,
    };
    const child = Bun.spawn([process.execPath, join(shellRoot, "src/dev/main.ts")], {
      env: {
        MIMALLOC_PURGE_DELAY: "0", // as in the built app's Info.plist
        ...process.env,
        KITOP_DEV: JSON.stringify(dev),
        // The app's languages (no bundle to declare them in dev): the shell's menus follow.
        ...(config.locales && Object.keys(config.locales).length ? { KITOP_LOCALIZATIONS: [config.language ?? "en", ...Object.keys(config.locales)].join(",") } : {}),
      },
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
          if (line.startsWith(DEV_READY)) {
            const { rpc } = JSON.parse(line.slice(DEV_READY.length));
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

  // A .py file or pyproject.toml changed: the same commands only restart the Python process (the
  // page keeps its state); added or removed ones need the window again (they're registered once).
  const pythonDir = config.native ? join(config.native, "python") : null;
  let pythonCommands: string | null = null;
  let pythonTimer: ReturnType<typeof setTimeout> | undefined;
  const isPythonSource = (file: string) =>
    !!pythonDir && file.startsWith(pythonDir) && /\.py$|[\\/]pyproject\.toml$|[\\/]\.python-version$/.test(file) && !/[\\/](__pycache__|\.venv)[\\/]/.test(file);
  function pythonChanged() {
    clearTimeout(pythonTimer);
    pythonTimer = setTimeout(async () => {
      const url = server.resolvedUrls?.local[0];
      if (!url) return;
      try {
        const { preparePythonDev } = await import("./build/python.ts");
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        const py = await preparePythonDev(config, { arch, outDir: join(config.root, ".desktop/dev/native") });
        if (!devState.bridge || !py || py.commands !== pythonCommands) {
          log(`python commands changed — restarting the window`);
          return void restartShell(url);
        }
        const { typeNativePlugins } = await import("./build/native-types.ts");
        await typeNativePlugins(config.root, [py.lib]).catch(() => {});
        const { callPlatform } = await import("./platform/bus.ts");
        await callPlatform("__python", "restart", {});
        log(`python reloaded`);
      } catch (err) {
        server.config.logger.error(`\x1b[35m[desktop]\x1b[0m ${(err as Error).message}`);
      }
    }, 150);
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
    name: "kitop:dev",
    apply: "serve",
    configureServer(s) {
      server = s;
      const natives = prepareServerNatives();
      s.middlewares.use((_req: unknown, _res: unknown, next: () => void) => void natives.then(() => next()));
      if (options.noWindow || process.env.KITOP_NO_WINDOW) return;
      const watched = [config.configFile, config.native, ...iconFiles].filter(Boolean) as string[];
      for (const w of watched) s.watcher.add(w);
      s.watcher.on("add", (file) => (isPythonSource(file) ? pythonChanged() : void iconChanged(file)));
      s.watcher.on("unlink", (file) => (isPythonSource(file) ? pythonChanged() : void iconChanged(file)));
      s.watcher.on("change", (file) => {
        if (iconFiles.includes(file)) void iconChanged(file);
        else if (isPythonSource(file)) pythonChanged();
        else if (pythonDir && file.startsWith(pythonDir)) return; // the environment, caches, uv.lock
        // Written by the builds themselves (cargo's lockfile, a target/ from a manual build): not edits.
        else if (config.native && file.startsWith(config.native) && !/[\\/](target[\\/]|Cargo\.lock$|go\.sum$)/.test(file)) {
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
