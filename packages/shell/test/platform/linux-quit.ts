// The cancellable quit on Linux through the real src/platform/app-lifecycle.ts: a guard vetoes a quit from
// each source (the API, a signal, the last window closing, the menu), pages vote through their bridge, a page
// going away counts against, and helper processes go through a delayed quit to their real end.
import { cstr } from "../../src/ffi.ts";
import { deliverPlatformEvent, initPlatformForTests } from "../../src/platform/bus.ts";
import { appLifecycle, type QuitRequest } from "../../src/platform/app-lifecycle.ts";
import type { Harness } from "../harness-worker.ts";

const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]).stdout.toString().trim();

export default async (t: Harness) => {
  initPlatformForTests({
    platformCall(request) {
      const { id, service, op, args } = JSON.parse(request);
      void t.call(service, op, args).then((r) => deliverPlatformEvent("platformResult", { ...r, id }));
      return JSON.stringify({ pending: true });
    },
  });
  t.onEvent((name, data) => deliverPlatformEvent(name, data));
  await t.sleep(10);
  const app = (op: string, args: Record<string, unknown> = {}) => t.call("app", op, args);
  const alive = async () => (await t.call("window", "isVisible")).value === true && (await t.page("return 40 + 2")) === 42;

  t.check("subscribeQuit: a phase is required", (await app("subscribeQuit", { token: "x" })).error?.code === "invalid_args");
  t.check("subscribeQuit: an unknown phase", (await app("subscribeQuit", { token: "x", phase: "afterQuit" })).error?.code === "invalid_args");
  t.check("unsubscribeQuit: a token is required", (await app("unsubscribeQuit")).error?.code === "invalid_args");
  t.check("replyQuit: quit or cancel", (await app("replyQuit", { token: "x", decision: "maybe" })).error?.code === "invalid_args");
  t.check("replyQuit with nothing going on: nothing happens", (await app("replyQuit", { token: "x", decision: "cancel", requestId: 99, phase: "quitRequested" })).ok && (await alive()));

  // ---- a veto, from each source -------------------------------------------------------
  const seen: QuitRequest[] = [];
  let answer: "quit" | "cancel" = "cancel";
  let off = appLifecycle.onQuitRequested((request) => {
    seen.push(request);
    return answer;
  });
  await t.sleep(100);
  const vetoed = async (name: string, reason: string, ask: () => unknown) => {
    const before = seen.length;
    const cancelled = t.waitEvent("quitCancelled", 4000);
    await ask();
    const c = await cancelled;
    const last = seen[seen.length - 1];
    t.check(`${name}: the guard is asked, reason ${reason}`, seen.length === before + 1 && last?.reason === reason && last.deadline > Date.now(), last);
    t.check(`${name}: quitCancelled, same request`, c?.requestId === last?.requestId && c?.reason === reason, c);
    await t.sleep(200);
    t.check(`${name}: the window and its page are still there`, await alive());
  };
  await vetoed("app.quit", "api", () => app("quit"));
  t.check("no beforeQuit after a veto", !t.events.get("beforeQuit")?.length);
  await vetoed("SIGTERM", "signal", () => process.kill(process.pid, "SIGTERM"));
  await vetoed("closing the last window", "lastWindowClosed", () => t.native.shell_window_close(t.windowId));
  await t.call("menu", "setAppMenu", { menus: [{ name: "App", items: [{ role: "quit", accelerator: "CmdOrCtrl+Shift+Q" }] }] });
  await t.call("window", "focus");
  await t.sleep(300);
  await vetoed("the menu's Quit (a real key press)", "menu", () => xdotool("key", "--clearmodifiers", "ctrl+shift+q"));
  await t.call("menu", "setAppMenu", { menus: null });

  // ---- a guard that takes its time, several guards --------------------------------------
  off();
  const release: Array<(d: "quit" | "cancel") => void> = [];
  off = appLifecycle.onQuitRequested(() => new Promise((resolve) => release.push(resolve)));
  await t.sleep(100);
  const cancels = () => (t.events.get("quitCancelled") ?? []).length;
  const soFar = cancels();
  let cancelled = t.waitEvent("quitCancelled", 4000);
  await app("quit");
  await t.sleep(800);
  t.check("while a guard thinks, nothing goes on", release.length === 1 && !t.events.get("beforeQuit")?.length && cancels() === soFar && (await alive()));
  await app("quit");
  await t.sleep(100);
  t.check("a second quit meanwhile joins the first", release.length === 1);
  release[0]("cancel");
  t.check("… and its cancel, later, counts", (await cancelled)?.reason === "api");
  const second = appLifecycle.onQuitRequested(() => "quit");
  await t.sleep(100);
  cancelled = t.waitEvent("quitCancelled", 4000);
  await app("quit");
  await t.sleep(200);
  release[1]("cancel");
  t.check("any guard's cancel keeps the app, whatever the others say", !!(await cancelled) && (await alive()));
  second();
  off();

  // ---- pages ---------------------------------------------------------------------------
  const before = cancels();
  await t.page(`window.__quit = []; const sink = (name, data) => {
      if (name === 'platformResult') { pendingResult(data); return; }
      if (name === 'quitRequested') { window.__quit.push(data); if (window.__answer) pcall('app', 'replyQuit', { token: 'page', phase: name, requestId: data.requestId, decision: window.__answer }); }
    };
    const pending = new Map(); let next = 1000;
    const pendingResult = (d) => { pending.get(d.id)?.(d); pending.delete(d.id); };
    window.pcall = (service, op, args = {}) => new Promise((res) => { const n = next++; pending.set(n, res); window.__shell.post({ id: n, service, op, args }); });
    window.__shell.setSink(sink); return 1`);
  t.check("a page subscribes through its bridge", ((await t.page("return await pcall('app', 'subscribeQuit', { token: 'page', phase: 'quitRequested' })")) as any).ok === true);
  t.check("… and server code can't take its token", (await app("subscribeQuit", { token: "page", phase: "beforeQuit" })).error?.code === "denied");
  await t.page("window.__answer = 'cancel'; return 1");
  cancelled = t.waitEvent("quitCancelled", 4000);
  await app("quit");
  const pageVote = await cancelled;
  t.check("a page's cancel holds the app", !!pageVote && (await alive()));
  const quitEvents = await t.page<any[]>("return window.__quit");
  t.check("the page was told, with its token", quitEvents?.[0]?.tokens?.includes("page") && quitEvents[0].reason === "api", quitEvents);
  // Unanswered, then gone: a document that disappears can't agree to losing its work.
  await t.page("window.__answer = null; return 1");
  cancelled = t.waitEvent("quitCancelled", 4000);
  await app("quit");
  await t.sleep(300);
  t.check("server code can't answer for the page", (await app("replyQuit", { token: "page", phase: "quitRequested", requestId: pageVote!.requestId + 1, decision: "quit" })).error?.code === "denied");
  t.native.shell_window_eval(t.windowId, cstr("location.reload()"));
  t.check("a page going away while it has to answer: cancelled", !!(await cancelled));
  await t.sleep(600);
  t.check("… and its guard went with it", cancels() === before + 2 && (await alive()));

  // ---- all the way to the end of a process ---------------------------------------------
  const harness = new URL("../harness.ts", import.meta.url).pathname, helper = new URL("./_quit-phases.ts", import.meta.url).pathname;
  const run = async (mode: string, atMost: number, midway: number) => {
    const started = Date.now();
    const proc = Bun.spawn([process.execPath, harness, helper], { env: { ...process.env, QUIT_MODE: mode }, stdout: "pipe", stderr: "ignore" });
    await t.sleep(midway);
    const running = proc.exitCode === null;
    const stopped = await Promise.race([proc.exited, Bun.sleep(atMost).then(() => null)]);
    if (stopped === null) proc.kill();
    const out = await new Response(proc.stdout).text();
    const log = out.split("\n").filter((l) => l.startsWith("QUIT ")).map((l) => JSON.parse(l.slice(5)));
    return { running, stopped, ms: Date.now() - started, log };
  };
  const delayed = await run("delay", 12000, 1200);
  const order = delayed.log.map((l) => l.what);
  t.check("delayed quit: still running while the guard waits", delayed.running, delayed);
  t.check("delayed quit: guard, then beforeQuit, then willQuit, each to its end", ["quitRequested", "allowed", "beforeQuit", "beforeQuit done", "willQuit", "willQuit done"].every((w, i, all) => order.indexOf(w) >= 0 && (i === 0 || order.indexOf(w) > order.indexOf(all[i - 1]))), order);
  const at = (what: string) => delayed.log.find((l) => l.what === what);
  t.check("delayed quit: the guard really held it", at("allowed")?.at - at("quitRequested")?.at >= 1400 && at("beforeQuit")?.at >= at("allowed")?.at, delayed.log);
  t.check("delayed quit: same request and reason in every phase, with its tokens", ["quitRequested", "beforeQuit", "willQuit"].every((p) => at(p)?.extra?.requestId === at("quitRequested")?.extra?.requestId && at(p)?.extra?.reason === "api"), delayed.log);
  t.check("delayed quit: the page answered and the window was up until after beforeQuit", at("allowed")?.extra?.page === 2 && at("beforeQuit done")?.extra === true, delayed.log);
  t.check("delayed quit: then the process ended, exit 0", delayed.stopped === 0, delayed.stopped);
  const timedOut = await run("timeout", 16000, 3000);
  t.check("a guard that never answers: still running after 3 s", timedOut.running, timedOut);
  const when = timedOut.log.find((l) => l.what === "quitTimedOut");
  t.check("… quitTimedOut for its phase at the 10 s deadline", when?.extra?.phase === "quitRequested" && when.at >= 9500 && when.at < 13000, when);
  t.check("… then the app quits", timedOut.stopped === 0, timedOut.stopped);
};
