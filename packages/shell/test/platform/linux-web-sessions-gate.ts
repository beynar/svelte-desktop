// A named session and the app's real gate (src/gate.ts): the server answers 403 without its HttpOnly
// session cookie, so reaching the handler from a session's view proves the cookie was copied.
import { cstr } from "../../src/ffi.ts";
import { startGate } from "../../src/gate.ts";
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const reached: { gate: number; path: string; cookie: string | null; view: string | null }[] = [];
  const serve = (index: number) => startGate({
    secret: `secret-${index}`,
    handler: (req) => {
      reached.push({ gate: index, path: new URL(req.url).pathname, cookie: req.headers.get("cookie"), view: req.headers.get("x-desktop-view") });
      return new Response(`<!doctype html><title>app ${index}</title><p id=p>${index}</p>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    },
  });
  const s = (op: string, args: Record<string, unknown> = {}) => t.call("sessions", op, args);
  const js = async (viewId: string, code: string) => (await t.call("webview", "executeJavaScript", { viewId, code })).value;
  const until = async (ok: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await ok()) return true;
      await t.sleep(20);
    }
    return false;
  };
  const signIn = async (gate: ReturnType<typeof serve>, index: number) => {
    t.native.shell_set_app_origin(cstr(gate.origin));
    t.native.shell_window_navigate(t.windowId, cstr(gate.authUrl("/")));
    await until(() => reached.some((r) => r.gate === index && r.path === "/"));
  };

  const first = serve(1);
  t.native.shell_set_app_origin(cstr(first.origin));
  t.check("before the app signs in, a session can't start", (await s("create", { id: "early", persistent: false })).error?.message === "App authentication is not ready");
  await signIn(first, 1);
  t.check("the gate lets the main window in", reached.some((r) => r.path === "/" && r.cookie?.includes("__kitop=")), reached);
  t.check("from outside, no cookie, no entry", (await fetch(`${first.origin}/`)).status === 403);
  t.check("the shell's cookie is HttpOnly, and listed nowhere", !(await t.call("webview", "executeJavaScript", { windowId: 0, code: "document.cookie" })).value?.includes("__kitop") && !(await s("cookiesGet", { url: `${first.origin}/` })).value.some((c: any) => c.name === "__kitop"));
  await s("cookiesSet", { url: `${first.origin}/`, name: "main-only", value: "1" });

  t.check("sessions.create once it has", (await s("create", { id: "gated", persistent: false })).ok);
  await t.call("view", "create", { id: "app", session: "gated", url: `${first.origin}/in-session`, bounds: { x: 0, y: 0, width: 200, height: 100 } });
  t.check("a view in the session gets past the gate", await until(() => reached.some((r) => r.path === "/in-session")), reached);
  const inSession = reached.find((r) => r.path === "/in-session");
  t.check("…with the shell's cookie and not the default session's others", inSession?.cookie?.includes("__kitop=") && !inSession.cookie.includes("main-only"), inSession);
  t.check("…and it isn't exposed there either", !(await s("cookiesGet", { session: "gated", url: `${first.origin}/` })).value.some((c: any) => c.name === "__kitop"));
  t.check("…nor in events", !(t.events.get("sessionCookieChanged") ?? []).some((e) => e.cookie.name === "__kitop"));
  await s("cookiesSet", { session: "gated", url: `${first.origin}/`, name: "session-only", value: "1" });
  t.check("cookiesGet in that session: only its own", JSON.stringify((await s("cookiesGet", { session: "gated", url: `${first.origin}/` })).value.map((c: any) => c.name)) === JSON.stringify(["session-only"]));

  // A route dialog on a window in the session: its session, past the gate, as a view.
  const inWindow = (await t.call("window", "create", { label: "gated", session: "gated", url: `${first.origin}/gated-window`, width: 500, height: 400 })).value;
  await until(() => reached.some((r) => r.path === "/gated-window"));
  await t.sleep(300);
  const sheet = t.call("dialog", "sheet", { route: "/gated-sheet", windowId: inWindow.windowId });
  t.check("a route dialog in the session gets past the gate", await until(() => reached.some((r) => r.path === "/gated-sheet")), reached);
  const dialog = reached.find((r) => r.path === "/gated-sheet");
  t.check("…with the shell's cookie, the session's, as a view", dialog?.cookie?.includes("__kitop=") && dialog.cookie.includes("session-only") && dialog.view?.startsWith("sheet-"), dialog);
  await t.call("window", "close", { windowId: inWindow.windowId });
  t.check("…and its window closing cancels it", (await sheet).value?.result === null);

  // The server restarted: a new secret, a new cookie on the same host. Copied again before the next load.
  const second = serve(2);
  await signIn(second, 2);
  t.check("the new server doesn't take the old cookie", (await fetch(`${second.origin}/`, { headers: { cookie: inSession!.cookie! } })).status === 403);
  await t.call("view", "navigate", { id: "app", url: `${second.origin}/after-restart` });
  t.check("a session's next load gets past the new gate", await until(() => reached.some((r) => r.path === "/after-restart")) && await until(async () => (await js("app", "document.getElementById('p')?.textContent")) === "2"), reached);

  // The cookie isn't there for this origin: the load fails and says so, it doesn't go out without it.
  const other = `http://localhost:${second.server.port}`;
  t.native.shell_set_app_origin(cstr(other));
  const before = reached.length;
  const failed = t.waitEvent("webviewLifecycle", 3000);
  await t.call("view", "navigate", { id: "app", url: `${other}/no-cookie` });
  const event = await failed;
  t.check("no cookie to copy: webviewLifecycle failed, no request", event?.type === "failed" && event.viewId === "app" && event.message === "App authentication is not ready" && reached.length === before, event);

  await t.call("view", "destroy", { id: "app" });
  t.native.shell_set_app_origin(cstr(second.origin));
  t.check("remove, then a new one", (await s("remove", { session: "gated" })).ok && (await s("create", { id: "gated", persistent: false })).ok);
  await s("remove", { session: "gated" });
  first.server.stop(true);
  second.server.stop(true);
};
