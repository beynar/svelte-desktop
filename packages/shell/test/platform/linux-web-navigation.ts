// Navigation policy on WebKitGTK: decide-policy really holds a navigation, so a refused one sends
// no request at all (a real server counts them).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const LOG = "/tmp/xdg-open.log";
const opened = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : []);

export default async (t: Harness) => {
  writeFileSync(LOG, "");
  const hits = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === "/redirect") return Response.redirect("/redirected", 302);
      const body = path === "/frame" ? `<!doctype html><title>frame</title><iframe src="/framed"></iframe>` : `<!doctype html><title>${path}</title>${path}`;
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  const ext = `http://127.0.0.1:${server.port}`;
  const count = (path: string) => hits.get(path) ?? 0;
  const seen = new Set<any>();
  async function asked(url: string, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = (t.events.get("webContentNavigation") ?? []).find((x) => x.url === url && !seen.has(x));
      if (e) {
        seen.add(e);
        return e;
      }
      await t.sleep(20);
    }
    return null;
  }
  const decide = (requestId: string, allow: boolean) => t.call("webview", "navigationDecision", { requestId, allow });
  const inView = async (code: string) => (await t.call("webview", "executeJavaScript", { viewId: "nav", code })).value;
  async function atPath(path: string, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await inView("location.pathname")) === path) return true;
      await t.sleep(50);
    }
    return false;
  }

  await t.call("view", "create", { id: "nav", url: `${ext}/start`, bounds: { x: 0, y: 0, width: 300, height: 200 } });
  t.check("before a policy, a view loads freely", await atPath("/start"));
  const on = await t.call("webview", "setNavigationPolicy", { enabled: true });
  t.check("setNavigationPolicy from server code", on.ok, on);

  await t.call("view", "navigate", { id: "nav", url: `${ext}/refused` });
  const refused = await asked(`${ext}/refused`);
  t.check("a view's navigation asks the Worker", refused?.viewId === "nav" && typeof refused.requestId === "string", refused);
  t.check("WebKitGTK doesn't say which frame: isMainFrame is null", refused?.isMainFrame === null, refused);
  await t.sleep(800);
  t.check("no request while the answer is awaited", count("/refused") === 0, [...hits]);
  t.check("navigationDecision: refuse", (await decide(refused.requestId, false)).ok);
  await t.sleep(500);
  t.check("a refused navigation sent no request at all", count("/refused") === 0, [...hits]);
  t.check("…and the page stayed", (await inView("location.pathname")) === "/start");
  const again = await decide(refused.requestId, true);
  t.check("answering twice → unavailable", again.error?.code === "unavailable", again);

  await t.call("view", "navigate", { id: "nav", url: `${ext}/allowed` });
  const allowed = await asked(`${ext}/allowed`);
  t.check("navigationDecision: allow", allowed && (await decide(allowed.requestId, true)).ok);
  t.check("an allowed navigation loads", (await atPath("/allowed")) && count("/allowed") === 1, [...hits]);

  // A redirect is a navigation of its own: the first request goes, the refused one doesn't.
  await t.call("view", "navigate", { id: "nav", url: `${ext}/redirect` });
  const first = await asked(`${ext}/redirect`);
  await decide(first.requestId, true);
  const second = await asked(`${ext}/redirected`);
  t.check("a redirect asks again", !!second, t.events.get("webContentNavigation")?.slice(-2));
  await decide(second.requestId, false);
  await t.sleep(500);
  t.check("a refused redirect sends no request", count("/redirect") === 1 && count("/redirected") === 0, [...hits]);

  // A frame: the page loads, the frame in it doesn't.
  await t.call("view", "navigate", { id: "nav", url: `${ext}/frame` });
  const page = await asked(`${ext}/frame`);
  await decide(page.requestId, true);
  const frame = await asked(`${ext}/framed`);
  t.check("a frame's navigation asks too", !!frame);
  await decide(frame.requestId, false);
  t.check("the page loaded, the refused frame didn't", (await atPath("/frame")) && count("/frame") === 1 && count("/framed") === 0, [...hits]);

  // Replacing the policy cancels what's pending.
  await t.call("view", "navigate", { id: "nav", url: `${ext}/pending` });
  const pending = await asked(`${ext}/pending`);
  await t.call("webview", "setNavigationPolicy", { enabled: true });
  await t.sleep(400);
  t.check("setting the policy again refuses what was pending", count("/pending") === 0 && (await decide(pending.requestId, true)).error?.code === "unavailable", [...hits]);

  // The window's page: the shell's checks first, the app's origin exempt.
  const origin: string = await t.page("return location.origin");
  await t.page("window.__marker = 5; return 1");
  await t.page(`setTimeout(() => { location.href = ${JSON.stringify(`${ext}/scripted`)} }, 10); return 1`);
  const scripted = await asked(`${ext}/scripted`);
  t.check("a window's scripted navigation asks, as window:0", scripted?.viewId === "window:0", scripted);
  await decide(scripted.requestId, false);
  await t.sleep(400);
  t.check("refused: no request, not handed to the browser, page untouched", count("/scripted") === 0 && !opened().some((u) => u.includes("/scripted")) && (await t.page("return window.__marker")) === 5, opened());
  await t.page(`setTimeout(() => { location.href = ${JSON.stringify(`${ext}/scripted-ok`)} }, 10); return 1`);
  const ok = await asked(`${ext}/scripted-ok`);
  await decide(ok.requestId, true);
  await t.sleep(800);
  t.check("allowed: the shell's check still applies (another origin goes to the browser)", count("/scripted-ok") === 1 && opened().includes(`${ext}/scripted-ok`) && (await t.page("return window.__marker")) === 5, opened());
  await t.page(`const a = document.createElement('a'); a.href = ${JSON.stringify(`${ext}/clicked`)}; document.body.append(a); a.click(); return 1`);
  await t.sleep(400);
  t.check("a link to another origin stays the shell's: browser, no question, no request", opened().includes(`${ext}/clicked`) && !(t.events.get("webContentNavigation") ?? []).some((e) => e.url === `${ext}/clicked`) && count("/clicked") === 0, opened());
  const before = (t.events.get("webContentNavigation") ?? []).length;
  await t.page(`setTimeout(() => { location.href = '/?exempt' }, 10); return 1`);
  await t.sleep(800);
  t.check("the app's own origin is exempt", (await t.page("return location.href")) === `${origin}/?exempt` && (t.events.get("webContentNavigation") ?? []).length === before, t.events.get("webContentNavigation")?.slice(before));

  // Unanswered: refused at the deadline, and the app went on meanwhile.
  await t.call("view", "navigate", { id: "nav", url: `${ext}/unanswered` });
  const unanswered = await asked(`${ext}/unanswered`);
  t.check("the app keeps working while a decision is held", (await t.call("app", "getName")).ok && (await inView("1 + 1")) === 2);
  await t.sleep(9000);
  t.check("still held before the deadline", count("/unanswered") === 0 && !!unanswered);
  await t.sleep(1800);
  const late = await decide(unanswered.requestId, true);
  t.check("no answer in ten seconds refuses it", late.error?.code === "unavailable" && count("/unanswered") === 0, late);

  const off = await t.call("webview", "setNavigationPolicy", { enabled: false });
  await t.call("view", "navigate", { id: "nav", url: `${ext}/free` });
  t.check("policy off: no question, it loads", off.ok && (await atPath("/free")) && !(t.events.get("webContentNavigation") ?? []).some((e) => e.url === `${ext}/free`));
  await t.call("view", "destroy", { id: "nav" });
  server.stop(true);
};
