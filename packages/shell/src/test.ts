// End-to-end testing of a real svelte-desktop app (built .app or `vite dev`),
// in the real WKWebView window, from `bun test`:
//
//   import { launch } from '@svelte-desktop/shell/test';
//   import { test, expect, afterAll } from 'bun:test';
//   const app = await launch({ app: '.desktop/dist/Notes.app' });     // or launch({ dev: true })
//   afterAll(() => app.close());
//   test('adds a note', async () => {
//     await app.fill('input[name^=text]', 'hello');
//     await app.press('input[name^=text]', 'Enter');
//     await app.waitFor(() => document.body.innerText.includes('hello'));
//     expect(await app.text('ul')).toContain('hello');
//   });
//
// The app connects back to a WebSocket opened here (SVELTE_DESKTOP_TEST); the
// channel exists only when that variable is set. Selectors run in the page.
//
// Assert failures with `expect(await app.platform(…).catch((e) => e)).toMatchObject({ code })`,
// not `await expect(app.platform(…)).rejects…`: in bun test 1.4 the `.rejects` matcher
// broke the runner's WebSocket mid-frame ("new message inside a fragmented message",
// close 1006), and every later call then timed out.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LaunchOptions {
  /** Path to a built .app, a Linux app directory or AppImage (default: the first one in .desktop/dist under cwd). */
  app?: string;
  /** Run `vite dev` in this project instead of a built app (true = cwd). */
  dev?: boolean | { cwd?: string; port?: number };
  env?: Record<string, string>;
  /** Command-line arguments for a built app (URLs, documents to open). */
  args?: string[];
  /** Start the app yourself (e.g. Windows' toast activator launching it): called with the
   *  test channel URL to put in the app's SVELTE_DESKTOP_TEST; launch() then waits for it to connect. */
  connect?: (testUrl: string) => void | Promise<void>;
  /** ms to wait for the app to connect and its page to load. Default 30000. */
  timeout?: number;
}

export interface AppHandle {
  readonly origin: string;
  /** Any platform op: `await app.platform('window', 'getBounds')`. */
  platform<T = unknown>(service: string, op: string, args?: Record<string, unknown>): Promise<T>;
  /** Evaluate in the main window's page (script semantics, promises awaited, JSON result). */
  eval<T = unknown>(code: string | ((...args: any[]) => unknown), ...args: unknown[]): Promise<T>;
  /** Wait until a selector exists, or a page predicate returns truthy. */
  waitFor(target: string | ((...args: any[]) => unknown), options?: { timeout?: number }): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: "Enter" | "Escape" | "Tab" | string): Promise<void>;
  text(selector?: string): Promise<string>;
  /** Navigate the page (client-side when SvelteKit handles the link). */
  goto(path: string): Promise<void>;
  /** PNG of the page; written to `path` when given. */
  screenshot(path?: string): Promise<Uint8Array>;
  /** Resolve with the next platform event `name` matching `filter`. */
  nextEvent<T = any>(name: string, filter?: (data: T) => boolean, timeout?: number): Promise<T>;
  readonly stdout: string;
  close(): Promise<void>;
}

const fnSource = (code: string | ((...a: any[]) => unknown), args: unknown[]) =>
  typeof code === "string" ? code : `(${code.toString()})(...${JSON.stringify(args)})`;

export async function launch(options: LaunchOptions = {}): Promise<AppHandle> {
  const timeout = options.timeout ?? 30_000;
  let resolveHello!: (h: { origin: string }) => void;
  const hello = new Promise<{ origin: string }>((r) => (resolveHello = r));
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const waiters: Array<{ name: string; filter?: (d: any) => boolean; resolve: (d: any) => void }> = [];
  let socket: { send(data: string): unknown } | null = null;
  let nextId = 1;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("svelte-desktop test runner", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        route(ws, String(raw));
      },
      perMessageDeflate: false,
      close(_ws, code, reason) {
        if (process.env.SVELTE_DESKTOP_TEST_DEBUG) console.log(`[test-channel] closed ${code} ${reason}`);
      },
    },
  });
  // Frames from the app.
  function route(ws: { send(data: string): unknown }, raw: string) {
    try {
      routeFrame(ws, raw);
    } catch (err) {
      // A throwing handler would close the socket and silently stall every later call.
      console.error(`[test-channel] bad frame ${raw.slice(0, 200)}: ${err}`);
    }
  }
  function routeFrame(ws: { send(data: string): unknown }, raw: string) {
    if (process.env.SVELTE_DESKTOP_TEST_DEBUG) console.log("[test-channel]", raw.slice(0, 200));
    const m = JSON.parse(raw);
    if (m.t === "hello") {
      socket = ws;
      resolveHello(m);
    } else if (m.t === "result") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.ok ? p?.resolve(m.value) : p?.reject(Object.assign(new Error(m.error?.message), { code: m.error?.code }));
    } else if (m.t === "event") {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.name === m.name && (!w.filter || w.filter(m.data))) {
          waiters.splice(i, 1);
          w.resolve(m.data);
        }
      }
    }
  }

  const env = { ...process.env, ...options.env, SVELTE_DESKTOP_TEST: `ws://127.0.0.1:${server.port}` };
  if (options.connect) {
    const timer = setTimeout(() => resolveHello({ origin: "" }), timeout);
    await options.connect(env.SVELTE_DESKTOP_TEST);
    const h = await hello;
    clearTimeout(timer);
    if (!socket) {
      server.stop(true);
      throw new Error(`launch: the app did not connect within ${timeout} ms`);
    }
    return makeHandle({
      origin: h.origin, socket: socket!, pending, waiters, nextId: () => nextId++, timeout, stdout: () => "",
      async stop(platform) {
        await platform("app", "quit").catch(() => {});
        await Bun.sleep(1000);
        server.stop(true);
      },
    });
  }
  let cmd: string[];
  let cwd = process.cwd();
  if (options.dev) {
    const d = typeof options.dev === "object" ? options.dev : {};
    cwd = resolve(d.cwd ?? process.cwd());
    cmd = ["bunx", "--bun", "vite", "dev", "--port", String(d.port ?? 5000 + Math.floor(Math.random() * 3000)), "--strictPort"];
  } else {
    const app = resolve(options.app ?? findApp(cwd));
    if (existsSync(join(app, "Contents/Info.plist"))) {
      const plist = readFileSync(join(app, "Contents/Info.plist"), "utf8");
      const exe = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (!exe) throw new Error(`launch: no CFBundleExecutable in ${app}`);
      cmd = [join(app, "Contents/MacOS", exe)];
    } else if (existsSync(join(app, "shell.dll"))) {
      // Windows app folder (package-windows.ts): the .exe next to shell.dll.
      const exe = (require("node:fs").readdirSync(app) as string[]).find((f) => /\.exe$/i.test(f) && f !== "Uninstall.exe");
      if (!exe) throw new Error(`launch: no .exe in ${app}`);
      cmd = [join(app, exe)];
    } else {
      cmd = [linuxExecutable(app)];
    }
  }
  if (!options.dev && options.args?.length) cmd.push(...options.args);
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  let stdout = "";
  void (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) stdout += new TextDecoder().decode(chunk);
  })();
  void (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stdout += new TextDecoder().decode(chunk);
  })();

  const timer = setTimeout(() => resolveHello({ origin: "" }), timeout);
  const h = await hello;
  clearTimeout(timer);
  if (!socket) {
    proc.kill();
    server.stop(true);
    throw new Error(`launch: the app did not connect within ${timeout} ms\n${stdout.slice(-2000)}`);
  }
  return makeHandle({
    origin: h.origin,
    socket: socket!,
    pending,
    waiters,
    nextId: () => nextId++,
    timeout,
    stdout: () => stdout,
    async stop(platform) {
      await platform("app", "quit").catch(() => {});
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!exited) proc.kill("SIGKILL");
      server.stop(true);
    },
  });
}

type Pending = Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
type Waiters = Array<{ name: string; filter?: (d: any) => boolean; resolve: (d: any) => void }>;
type PlatformFn = <T = unknown>(service: string, op: string, args?: Record<string, unknown>) => Promise<T>;

async function makeHandle(o: {
  origin: string;
  socket: { send(data: string): unknown };
  pending: Pending;
  waiters: Waiters;
  nextId: () => number;
  timeout: number;
  stdout: () => string;
  stop: (platform: PlatformFn) => Promise<void>;
}): Promise<AppHandle> {
  const { pending, waiters, timeout } = o;
  const socket = o.socket;
  const h = { origin: o.origin };
  const platform = <T>(service: string, op: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((res, rej) => {
      const id = o.nextId();
      // No call may hang a test run: the app answers or the call fails.
      const timer = setTimeout(() => pending.delete(id) && rej(Object.assign(new Error(`${service}.${op}: no answer within 60 s`), { code: "timeout" })), 60_000);
      pending.set(id, { resolve: (v) => (clearTimeout(timer), res(v)), reject: (e) => (clearTimeout(timer), rej(e)) });
      socket.send(JSON.stringify({ id, service, op, args }));
    });
  const evalJs = <T>(code: string | ((...a: any[]) => unknown), ...args: unknown[]) =>
    platform<T>("webview", "executeJavaScript", { windowId: 0, code: fnSource(code, args) });

  const handle: AppHandle = {
    origin: h.origin,
    platform,
    eval: evalJs,
    async waitFor(target, o = {}) {
      const end = Date.now() + (o.timeout ?? 10_000);
      const probe = typeof target === "string" ? `!!document.querySelector(${JSON.stringify(target)})` : `!!(${fnSource(target, [])})`;
      while (Date.now() < end) {
        if (await evalJs<boolean>(probe).catch(() => false)) return;
        await Bun.sleep(50);
      }
      throw new Error(`waitFor timed out: ${typeof target === "string" ? target : "predicate"}`);
    },
    async click(selector) {
      await handle.waitFor(selector);
      await evalJs(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async fill(selector, value) {
      await handle.waitFor(selector);
      await evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
    },
    async press(selector, key) {
      await handle.waitFor(selector);
      await evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const k = ${JSON.stringify(key)};
          for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
          if (k === 'Enter' && el.form) el.form.requestSubmit(); })()`,
      );
    },
    text: (selector = "body") => evalJs<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`),
    async goto(path) {
      await evalJs(
        `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(path)}; document.body.appendChild(a); a.click(); a.remove(); })()`,
      );
      // (client-side navigation; a full load re-hydrates and sets the marker again)
      const want = path.split("?")[0];
      const end = Date.now() + 10_000;
      while ((await evalJs<string>("location.pathname")) !== want) {
        if (Date.now() > end) throw new Error(`goto(${path}) timed out`);
        await Bun.sleep(50);
      }
    },
    async screenshot(path) {
      const r = await platform<{ data: string }>("webview", "capturePage", { windowId: 0 });
      const bytes = Uint8Array.from(Buffer.from(r.data, "base64"));
      if (path) await Bun.write(path, bytes);
      return bytes;
    },
    nextEvent(name, filter, ms = 10_000) {
      return new Promise((res, rej) => {
        const w = { name, filter, resolve: res };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1), rej(new Error(`nextEvent(${name}) timed out`));
        }, ms);
      });
    },
    get stdout() {
      return o.stdout();
    },
    close: () => o.stop(platform),
  };
  // First page load: wait for SvelteKit hydration (marker set by the desktop Vite
  // plugin), falling back to an interactive document if the marker never shows.
  await handle.waitFor(() => document.readyState !== "loading" && !!document.body, { timeout });
  await handle.waitFor(() => document.documentElement.hasAttribute("data-desktop-hydrated"), { timeout: 10_000 }).catch(() => {});
  return handle;
}

/** Linux app directory (package-linux.ts): the `.desktop` entry's Exec, relative to it. An AppImage runs as is. */
function linuxExecutable(app: string): string {
  const fs = require("node:fs");
  if (fs.statSync(app).isFile()) return app;
  const entry = fs.readdirSync(app).find((f: string) => f.endsWith(".desktop"));
  const exec = entry && /^Exec=(\S+)/m.exec(fs.readFileSync(join(app, entry), "utf8"))?.[1];
  if (!exec) throw new Error(`launch: no .app bundle or .desktop entry with Exec= in ${app}`);
  return join(app, exec);
}

function findApp(cwd: string): string {
  const dist = join(cwd, ".desktop/dist");
  if (existsSync(dist)) {
    const fs = require("node:fs");
    const entries: string[] = fs.readdirSync(dist);
    const app = entries.find((f) => f.endsWith(".app")) ?? entries.find((f) => existsSync(join(dist, f, "lib", "libshell.so"))) ?? entries.find((f) => existsSync(join(dist, f, "shell.dll")));
    if (app) return join(dist, app);
  }
  throw new Error("launch: no built app found in .desktop/dist (run `bunx --bun vite build`, or pass { app } / { dev: true })");
}
