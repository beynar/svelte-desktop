// isolated.ts on a mock platform: what goes to the native side, in what order.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mockPlatform, PlatformTransport } from "../platform/bus";

const saved: Record<string, unknown> = {};
let t: PlatformTransport;
const stub = (name: string, value: unknown) => {
  saved[name] = (globalThis as any)[name];
  (globalThis as any)[name] = value;
};
const ops = () => t.requests.filter((r: any) => r.service === "view").map((r: any) => `${r.op} ${r.args.id}`);
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  t = mockPlatform();
  // As the native side answers: other modules bound to this bus ask these when it's ready.
  t.serve("notifications", "responses", { ok: true, value: [] });
  t.serve("notifications", "claim", { ok: true, value: [] });
  stub("document", { documentElement: { hasAttribute: () => true }, querySelector: () => null });
  stub("window", globalThis);
  stub("location", { origin: "http://x", pathname: "/" });
  stub("addEventListener", () => {});
  stub("removeEventListener", () => {});
  stub("ResizeObserver", class { observe() {} disconnect() {} });
  stub("requestAnimationFrame", () => 1);
  stub("cancelAnimationFrame", () => {});
  stub("innerHeight", 600);
  stub("innerWidth", 800);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v;
});

const load = () => import("./isolated.ts");
const element = () => ({ hidden: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, bottom: 100, right: 100 }), parentElement: null }) as unknown as HTMLElement;
const params = (id: string, box = { x: 0, y: 0, width: 100, height: 100 }) =>
  ({ tabs: { id: "app", update() {}, reveal() {}, followAddress() {}, activeId: id, pageKeyboard: false, panes: null }, tab: { id, path: "/slow" }, active: true, shown: false, box: () => box }) as any;

test("a tab closed and made again: the new view isn't destroyed by the old one's end", async () => {
  const { isolatedView } = await load();
  const first = isolatedView(element(), params("a"));
  await tick();
  first.destroy();
  const second = isolatedView(element(), params("a"));
  await tick();
  const o = ops();
  expect(o.filter((x) => x === "create app-a").length).toBe(2);
  expect(o.indexOf("destroy app-a")).toBeGreaterThan(o.indexOf("create app-a"));
  expect(o.lastIndexOf("destroy app-a")).toBeLessThan(o.lastIndexOf("create app-a"));
  second.destroy();
});

test("a view made ahead, its tab closed before it was drawn: the view with that id isn't hidden after", async () => {
  const { isolatedView, prepareView } = await load();
  prepareView("app-b", "/slow", { x: 0, y: 0, width: 100, height: 100 });
  await tick();
  const first = isolatedView(element(), params("b"));
  await tick();
  first.destroy();
  await tick();
  const second = isolatedView(element(), params("b"));
  await tick();
  t.requests.length = 0;
  // The first one's page comes now: its readiness used to hide the second one.
  t.emit("message", { channel: "tabs:view-ready", data: { id: "app-b" } });
  await tick();
  expect(ops()).not.toContain("hide app-b");
  second.destroy();
});

test("an empty box: a shown view steps aside, and comes back with its box", async () => {
  const { isolatedView } = await load();
  let box = { x: 0, y: 0, width: 100, height: 100 };
  const p = () => ({ ...params("c"), box: () => box, shown: true });
  const a = isolatedView(element(), p());
  await tick();
  t.emit("message", { channel: "tabs:view-ready", data: { id: "app-c" } });
  await tick();
  a.update({ ...p(), active: false }); // one step to place it
  a.update(p());
  await tick();
  expect(ops()).toContain("show app-c");
  for (const empty of [{ x: 0, y: 0, width: 0, height: 100 }, { x: 0, y: 0, width: -70, height: 100 }]) {
    t.requests.length = 0;
    box = empty;
    a.update({ ...p(), active: false, shown: true });
    await tick();
    expect(ops()).toContain("hide app-c");
    expect(ops().some((o) => o.startsWith("setBounds"))).toBe(false);
    t.requests.length = 0;
    box = { x: 0, y: 0, width: 100, height: 100 };
    a.update(p());
    await tick();
    expect(ops()).toContain("show app-c");
  }
  a.destroy();
});

test("in panes a tab is at one place: another site's page clears its path, the app's clears its url", async () => {
  const { isolatedView } = await load();
  const patches: unknown[] = [];
  const p = { ...params("d"), tabs: { ...params("d").tabs, update: (_: string, patch: unknown) => patches.push(patch) } };
  const a = isolatedView(element(), p);
  await tick();
  t.emit("viewNavigated", { id: "app-d", url: "https://site.example/page" });
  t.emit("viewNavigated", { id: "app-d", url: "http://x/reports" });
  t.emit("viewNavigated", { id: "app-d", url: "about:blank" });
  expect(patches).toEqual([{ url: "https://site.example/page", path: undefined }, { path: "/reports", url: undefined }]);
  a.destroy();
});

test("without panes: the fields it had stay, as before", async () => {
  const { isolatedView } = await load();
  const patches: unknown[] = [];
  const p = { ...params("e"), box: undefined, tabs: { ...params("e").tabs, update: (_: string, patch: unknown) => patches.push(patch) } };
  const a = isolatedView(element(), p);
  await tick();
  t.emit("viewNavigated", { id: "app-e", url: "https://site.example/page" });
  t.emit("viewNavigated", { id: "app-e", url: "http://x/reports" });
  expect(patches).toEqual([{ url: "https://site.example/page" }, { path: "/reports" }]);
  a.destroy();
});

test("a spare view its router won't take there: the page is loaded instead", async () => {
  const { isolatedView, prepareView, retargetView } = await load();
  t.serve("view", "executeJavaScript", { ok: true, value: false });
  stub("navigator", { platform: "Mac" });
  prepareView("app-f", "/", { x: 0, y: 0, width: 100, height: 100 });
  await tick();
  t.emit("message", { channel: "tabs:view-ready", data: { id: "app-f" } });
  await tick();
  retargetView("app-f", "/somewhere");
  const a = isolatedView(element(), params("f"));
  await tick(16);
  const nav = t.requests.find((r: any) => r.service === "view" && r.op === "navigate");
  expect(nav?.args).toMatchObject({ id: "app-f", route: "/somewhere" });
  const script = t.requests.find((r: any) => r.op === "executeJavaScript")?.args.code as string;
  expect(script).toContain("finally { delete g.__desktopRetarget; off?.(); }");
  a.destroy();
});

test("the script that takes a spare view to its route: what it answers, the mark gone every time", async () => {
  const { isolatedView, prepareView, retargetView } = await load();
  stub("navigator", { platform: "Mac" });
  t.serve("view", "executeJavaScript", { ok: true, value: true });
  prepareView("app-g", "/", { x: 0, y: 0, width: 100, height: 100 });
  await tick();
  t.emit("message", { channel: "tabs:view-ready", data: { id: "app-g" } });
  await tick();
  retargetView("app-g", "/there");
  const a = isolatedView(element(), params("g"));
  await tick(16);
  const code = t.requests.find((r: any) => r.op === "executeJavaScript")?.args.code as string;
  a.destroy();
  const g = globalThis as any;
  stub("location", { href: "http://x/" });
  stub("requestAnimationFrame", (f: () => void) => (f(), 1));
  // A page at `from`, a router that takes it to `to` (or doesn't).
  const run = async (from: string, to: string, go: () => Promise<void> = async () => {}) => {
    let page = from;
    g.__desktopPageUrl = () => page;
    g.__desktopGoto = async () => {
      await go();
      page = to;
    };
    const out = await (0, eval)(code);
    expect(g.__desktopRetarget).toBeUndefined();
    return out;
  };
  expect(await run("/", "/there")).toBe(true);
  expect(await run("/there", "/there")).toBe(true); // already there
  expect(await run("/", "/")).toBe(false); // canceled: it says nothing, the page didn't move
  expect(await run("/", "/there/")).toBe(true); // a canonical address of its own: there
  expect(await run("/", "/elsewhere")).toBe(true); // a redirect: where the app wants it
  expect(await run("/", "/", async () => { throw new Error("no such route"); })).toBe(false);
  // A redirect back where it started: a navigation ended, nothing to load.
  g.__desktopAfterNavigate = (fn: () => void) => {
    g.__ended = fn;
    return () => {};
  };
  expect(await run("/chat", "/chat", async () => g.__ended())).toBe(true);
  delete g.__desktopAfterNavigate;
  delete g.__ended;
  // Another navigation came meanwhile (a link in the sidebar): this one gives way, no load over it.
  expect(await run("/", "/", async () => { g.__desktopNavigations = (g.__desktopNavigations ?? 0) + 1; })).toBe(true);
  // Its router isn't there yet (the spare shown after its time limit, before it started).
  g.__desktopPageUrl = () => "/";
  delete g.__desktopGoto;
  expect(await (0, eval)(code)).toBe(false);
  expect(g.__desktopRetarget).toBeUndefined();
  delete g.__desktopPageUrl;
  delete g.__desktopNavigations;
});

test("a view at another page: where its page says, or loaded when it has no router yet", async () => {
  const { navigateView } = await load();
  t.serve("view", "executeJavaScript", { ok: true, value: "/edit" });
  expect(await navigateView("app-h", "/dest", false)).toBe("/edit"); // canceled by the page
  expect(t.requests.some((r: any) => r.op === "navigate")).toBe(false);
  t.serve("view", "executeJavaScript", { ok: true, value: false });
  expect(await navigateView("app-h", "/dest", false)).toBeUndefined(); // being loaded there
  expect(t.requests.find((r: any) => r.op === "navigate")?.args).toMatchObject({ id: "app-h", route: "/dest" });
  t.serve("view", "executeJavaScript", { ok: false, error: { code: "invalid_args", message: "no such view" } });
  expect(await navigateView("app-i", "/dest", false)).toBeNull();
  // The script itself.
  const code = t.requests.find((r: any) => r.op === "executeJavaScript")?.args.code as string;
  delete (globalThis as any).__desktopGoto;
  expect(await (0, eval)(code)).toBe(false);
});

test("a spare view still loading, its tab sent elsewhere: it goes there once, not back where it was asked first", async () => {
  const { isolatedView, navigateView, prepareView, retargetView } = await load();
  stub("navigator", { platform: "Mac" });
  t.serve("view", "executeJavaScript", { ok: true, value: true });
  prepareView("app-j", "/", { x: 0, y: 0, width: 100, height: 100 });
  await tick();
  retargetView("app-j", "/first");
  const a = isolatedView(element(), params("j"));
  await tick();
  expect(await navigateView("app-j", "/second", false)).toBe("/second");
  t.emit("message", { channel: "tabs:view-ready", data: { id: "app-j" } }); // ready now
  await tick(16);
  const scripts = t.requests.filter((r: any) => r.op === "executeJavaScript").map((r: any) => r.args.code as string);
  expect(scripts.some((c) => c.includes('"/second"'))).toBe(true);
  expect(scripts.some((c) => c.includes('"/first"'))).toBe(false);
  a.destroy();
});

test("a link out of the app in a pane's page: the browser's, last, an SVG one too; SvelteKit told it stays; a handled one stays the page's", async () => {
  const { connectPaneView } = await import("./panes-drag.ts");
  const listeners: Record<string, (e: any) => void> = {};
  stub("addEventListener", (type: string, fn: (e: any) => void, capture?: boolean) => {
    if (!capture) listeners[type] = fn;
  });
  stub("document", { baseURI: "http://x/", documentElement: { hasAttribute: () => true }, querySelector: () => null });
  stub("__desktopView", "app-x");
  stub("__desktopTabView", true);
  let staying = 0;
  stub("__desktopStaying", (was: boolean) => (expect(was).toBe(false), staying++));
  stub("history", { pushState() {}, replaceState() {} });
  class FakeElement {}
  stub("Element", FakeElement);
  t.serve("shell", "openExternal", { ok: true, value: null });
  t.serve("events", "emit", { ok: true, value: null });
  const stop = connectPaneView();
  let href: unknown = "https://svelte.dev/docs";
  const a = { href: "", hasAttribute: () => false, getAttribute: () => null };
  const target = Object.assign(new FakeElement(), { closest: () => Object.assign(a, { href }) });
  const click = (defaultPrevented = false) => {
    const e = { type: "click", button: 0, target, defaultPrevented, preventDefault() { this.defaultPrevented = true; } };
    listeners.click!(e);
    return e;
  };
  const opened = () => t.requests.filter((r: any) => r.service === "shell" && r.op === "openExternal").map((r: any) => r.args.url);
  expect(click().defaultPrevented).toBe(true);
  expect(opened()).toEqual(["https://svelte.dev/docs"]);
  expect(staying).toBe(1);
  // Handled by the page, or canceled by a beforeNavigate: not this one's business.
  click(true);
  expect(opened().length).toBe(1);
  // An SVG link's href.
  href = { baseVal: "https://svelte.dev/svg" };
  click();
  expect(opened()[1]).toBe("https://svelte.dev/svg");
  // The app's own, and what isn't a place to go.
  for (const own of ["http://x/page", "javascript:void(0)", "data:text/plain,x"]) {
    href = own;
    expect(click().defaultPrevented).toBe(false);
  }
  expect(opened().length).toBe(2);
  stop();
});

test("whenStopped: what's stopped has its say, once its handler is done", async () => {
  const { whenStopped } = await import("./panes-drag.ts");
  const seen: boolean[] = [];
  const e = { defaultPrevented: false, stopPropagation() {}, stopImmediatePropagation() {} } as unknown as Event;
  whenStopped(e, () => seen.push(e.defaultPrevented));
  e.stopPropagation();
  (e as any).defaultPrevented = true; // the same handler, after it stopped it
  await tick();
  expect(seen).toEqual([true]);
});

test("a view's router: not hydrated or no such page, it's loaded instead; another navigation getting there first ends the wait", async () => {
  const { navigateView } = await load();
  t.serve("view", "executeJavaScript", { ok: true, value: "/x" });
  stub("location", { origin: "http://x", pathname: "/", href: "http://x/" });
  await navigateView("app-n", "/dest", false, { pageUrl: "http://x/base" });
  const code = t.requests.find((r: any) => r.op === "executeJavaScript")?.args.code as string;
  stub("__desktopShownUrl", () => "/where");
  stub("__desktopAfterNavigate", undefined);
  stub("__desktopRouteOf", () => Promise.resolve(null));
  stub("__desktopGoto", () => Promise.resolve());
  expect(await (0, eval)(code)).toBe(false);
  // A lookup that takes for ever: a navigation of its own ends the wait too.
  stub("__desktopRouteOf", () => new Promise(() => {}));
  {
    let after: ((nav: unknown) => void) | undefined;
    stub("__desktopAfterNavigate", (fn: (nav: unknown) => void) => ((after = fn), () => {}));
    const waiting = (0, eval)(code);
    await tick();
    after!({ to: { url: { href: "http://x/own-link" } } });
    expect(await waiting).toBe("/where");
    stub("__desktopAfterNavigate", undefined);
  }
  stub("__desktopRouteOf", () => Promise.resolve("/dest"));
  // A navigation that fails (a beforeNavigate that throws) stays as it is: no load.
  stub("__desktopGoto", () => Promise.reject(new Error("a hook")));
  expect(await (0, eval)(code)).toBe("/where");
  stub("document", { documentElement: { hasAttribute: () => false } });
  stub("__desktopGoto", () => Promise.resolve());
  expect(await (0, eval)(code)).toBe(false);
  stub("document", { documentElement: { hasAttribute: () => true } });
  let after: ((nav: unknown) => void) | undefined;
  stub("__desktopAfterNavigate", (fn: (nav: unknown) => void) => ((after = fn), () => {}));
  stub("__desktopGoto", () => new Promise(() => {})); // never done
  const waiting = (0, eval)(code);
  let done = false;
  void waiting.then(() => (done = true));
  await tick();
  // The shallow entry's page on its way: not the end.
  after!({ to: { url: { href: "http://x/base" } } });
  await tick();
  expect(done).toBe(false);
  after!({ to: { url: { href: "http://x/own-link" } } });
  expect(await waiting).toBe("/where");
});

test("a state for a page not there yet: only the app's page takes it, at that path, hydrated", async () => {
  const { deliverState } = await load();
  t.serve("view", "executeJavaScript", { ok: true, value: true });
  expect(await deliverState("app-s", "/live/1", { stateJson: "[{}]" })).toBe(true);
  const code = t.requests.find((r: any) => r.op === "executeJavaScript")?.args.code as string;
  const taken: unknown[] = [];
  const run = (origin: string, href: string, hydrated: boolean) => {
    stub("location", { origin, href });
    stub("document", { documentElement: { hasAttribute: () => hydrated } });
    stub("__desktopGoto", (...args: unknown[]) => taken.push(args));
    return (0, eval)(code);
  };
  // Another site at the same path, with its own router: nothing, whatever it claims.
  stub("__desktopGoto", undefined);
  expect(await run("https://site.example", "https://site.example/live/1", true)).toBe(false);
  expect(await run("http://x", "http://x/other", true)).toBe(false);
  expect(await run("http://x", "http://x/live/1", false)).toBe(false);
  expect(taken).toEqual([]);
  expect(await run("http://x", "http://x/live/1", true)).toBe(true);
  expect(taken).toEqual([["/live/1", { stateJson: "[{}]", replace: true }]]);
});
