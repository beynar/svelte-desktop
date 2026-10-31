// examples/notes built for Linux (package-linux.ts) and driven in its real
// WebKitGTK window through the test channel (src/test.ts launch()).
// Run by notes.sh inside the Docker image, from examples/notes:
//   bun test --timeout 60000 <this file>
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launch, type AppHandle } from "../../src/test.ts";

const results = process.env.RESULTS ?? "/results";
let app: AppHandle;
beforeAll(async () => {
  app = await launch({ timeout: 60_000 });
  await app.waitFor("#counter", { timeout: 20_000 });
}, 90_000);
afterAll(() => app?.close());

test("the page loads in the WebKitGTK window, from the app's loopback origin", async () => {
  expect(app.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(await app.text("h1")).toBe("Notes");
  expect(await app.eval<string>("location.origin")).toBe(app.origin);
  expect(await app.eval<boolean>("document.documentElement.hasAttribute('data-desktop-hydrated')")).toBe(true);
});

test("SSR: the server renders the counter and the runtime into the HTML", async () => {
  const html = await app.eval<string>("fetch(location.href, { credentials: 'same-origin' }).then((r) => r.text())");
  expect(html).toMatch(/id="counter"[^>]*>\d+</);
  expect(html).toMatch(/Server runtime: <code>bun 1\.\d+\.\d+<\/code>/);
});

test("remote command() increments the bun:sqlite counter", async () => {
  const before = Number(await app.text("#counter"));
  await app.click("button:not([type=button])");
  await app.waitFor(new Function(`return Number(document.querySelector('#counter').textContent) > ${before}`) as () => boolean, { timeout: 5000 });
  expect(Number(await app.text("#counter"))).toBe(before + 1);
});

test("remote form() adds a note", async () => {
  const note = `linux note ${Date.now()}`;
  await app.fill("input[name^=text]", note);
  await app.press("input[name^=text]", "Enter");
  await app.waitFor(new Function(`return document.body.innerText.includes(${JSON.stringify(note)})`) as () => boolean);
  expect(await app.text("ul")).toContain(note);
});

test("platform API from the packaged app: identity, window, diagnostics, theme, clipboard", async () => {
  const info = await app.platform<any>("app", "getInfo");
  expect(info).toMatchObject({ name: "Svelte Notes", identifier: "dev.svelte-desktop.notes", version: "0.1.0", platform: "linux", packaged: true });
  expect((await app.platform<any>("app", "getBundleType")).type).toBe("app");
  expect(await app.platform<string>("app", "getPath", { name: "userData" })).toMatch(/\/dev\.svelte-desktop\.notes$/);
  const diag = await app.platform<any>("diagnostics", "info");
  expect(diag).toMatchObject({ os: "linux", renderer: "webkitgtk" });
  await app.platform("window", "setTitle", { title: "Under test" });
  expect(await app.platform<string>("window", "getTitle")).toBe("Under test");
  const b = await app.platform<{ bounds: { width: number; height: number } }>("window", "getBounds");
  expect(b.bounds.width).toBeGreaterThan(900); // desktop.config window 960×680 (+ frame)
  expect(["light", "dark"]).toContain((await app.platform<any>("theme", "get")).appearance);
  await app.platform("clipboard", "writeText", { text: "from the notes app" });
  expect(await app.platform<string>("clipboard", "readText")).toBe("from the notes app");
  expect(await app.eval<boolean>("typeof window.__shell?.post === 'function' && Object.isFrozen(window.__shell)")).toBe(true);
});

test("C Node-API addon (native/addons/fastmath.c, compiled with gcc) runs in server code: the fib() remote query", async () => {
  // The query the /platform page uses, called through SvelteKit's remote endpoint
  // (id = hash(file)/name, payload = base64url(devalue)).
  const { hash } = await import(join(process.cwd(), "node_modules/@sveltejs/kit/src/utils/hash.js"));
  const id = `${hash("src/lib/desktop.remote.ts")}/fib`;
  const res = await app.eval<{ status: number; body: string }>(
    `fetch('/_app/remote/${id}?payload=' + btoa(JSON.stringify([30])).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_'))
       .then(async (r) => ({ status: r.status, body: await r.text() }))`,
  );
  expect(res.status).toBe(200);
  expect(res.body).toContain("832040");
});

test("the Swift plugin is macOS-only: no greeter on Linux (typed `unknown`, the app keeps running)", async () => {
  const err: any = await app.platform("greeter", "hello", { name: "linux" }).catch((e) => e);
  expect(err.code).toBe("unknown");
  // examples/notes degrades: /platform renders and says the plugin isn't available here.
  expect(await app.eval<number>("fetch('/platform').then((r) => r.status)")).toBe(200);
  expect(await app.eval<string>("fetch('/platform').then((r) => r.text())")).toContain("not available on this OS");
  expect(await app.text("h1")).toBe("Notes");
});

test("menu-bar popover: pre-warmed route in its own WebKitWebView, ready, bridge inside", async () => {
  let quick: any;
  for (let i = 0; i < 100 && !quick?.ready; i++) {
    quick = (await app.platform<any[]>("popover", "list")).find((p) => p.id === "status-item");
    await Bun.sleep(50);
  }
  expect(quick?.ready).toBe(true);
  const inside = await app.platform<any>("webview", "executeJavaScript", {
    popoverId: "status-item",
    code: "({ text: document.body.innerText, id: window.__shellPopover.id, attr: document.documentElement.hasAttribute('data-shell-popover') })",
  });
  expect(inside).toMatchObject({ id: "status-item", attr: true });
  expect(inside.text).toContain("Quick note");
  expect(await app.platform<boolean>("tray", "isSet")).toBe(true);
  const shown = app.nextEvent("popoverShown", (e: { id: string }) => e.id === "status-item");
  await app.platform("tray", "performClick"); // the item's activation toggles its bound popover
  expect((await shown).id).toBe("status-item");
  await app.platform("popover", "hide", { id: "status-item" });
});

test("desktop events reach the page (onDesktopEvent)", async () => {
  await app.platform("events", "emit", { channel: "desktop", data: { type: "test-ping", data: 1 } });
  await app.waitFor(() => [...document.querySelectorAll(".log li")].some((li) => li.textContent!.includes("test-ping")));
});

test("screenshot (webview.capturePage)", async () => {
  const png = await app.screenshot(existsSync(results) ? join(results, "notes-linux.png") : undefined);
  expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  const width = new DataView(png.buffer, png.byteOffset).getUint32(16);
  expect(width).toBeGreaterThan(900);
});

test("the AppImage boots the same app (FUSE-less: APPIMAGE_EXTRACT_AND_RUN)", async () => {
  const dist = join(process.cwd(), ".desktop/dist");
  const image = readdirSync(dist).find((f) => f.endsWith(".AppImage"));
  expect(image).toBeDefined();
  await app.close();
  const other = await launch({ app: join(dist, image!), env: { APPIMAGE_EXTRACT_AND_RUN: "1" }, timeout: 60_000 });
  try {
    await other.waitFor("#counter", { timeout: 20_000 });
    expect(await other.text("h1")).toBe("Notes");
    expect((await other.platform<any>("app", "getInfo")).packaged).toBe(true);
    expect(await other.eval<string>("location.origin")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await other.close();
  }
  app = undefined as any;
}, 90_000);
