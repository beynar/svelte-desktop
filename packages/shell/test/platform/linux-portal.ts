// shortcuts.* and capture.* on Wayland, in a real Wayland session on a headless compositor (weston), through
// xdg-desktop-portal's request and response protocol against test/docker/fake-portal.c. No real portal runs here:
// what its dialogs do and what GNOME or KDE answer hasn't been exercised.
import { rmSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const LOG = "/tmp/fake-portal-wayland.log";
const lines = async () => (await Bun.file(LOG).text().catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)) as { method: string; sender: string; params: string }[];
const control = (method: string, ...args: string[]) =>
  Bun.spawnSync(["gdbus", "call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop", "--method", `dev.kitop.FakePortal.${method}`, ...args]);

export default async (t: Harness) => {
  const info = (await t.call("system", "info")).value;
  t.check("this is a Wayland session", info?.session === "wayland" && process.env.GDK_BACKEND === "wayland", info);
  t.check("the page runs here", (await t.page("return 1 + 1")) === 2);
  const sc = (op: string, args: Record<string, unknown> = {}) => t.call("shortcuts", op, args);
  const cap = (op: string, args: Record<string, unknown> = {}) => t.call("capture", op, args);

  rmSync(LOG, { force: true });
  const portal = Bun.spawn(["/tmp/fake-portal"], { env: { ...process.env, FAKE_PORTAL_LOG: LOG }, stdout: "ignore", stderr: "ignore" });
  await t.sleep(500);

  // ---- screenshots -----------------------------------------------------------------------
  const supported = await cap("isSupported");
  t.check("capture.isSupported through the portal's version property", supported.value?.supported === true && supported.value.stills === true, supported);
  t.check("screenRecording: asked at each use, notDetermined", (await t.call("system", "checkPermission", { name: "screenRecording" })).value?.status === "notDetermined");
  const sources = (await cap("getSources")).value as any[];
  t.check("getSources: the whole desktop, one source, no windows", sources?.length === 1 && sources[0].type === "display" && sources[0].id === 1 && sources[0].resolution.width > 0, sources);
  t.check("getSources {types: window}: none", (await cap("getSources", { types: ["window"] })).value?.length === 0);
  const shot = await cap("captureSource", { id: 1, type: "display" });
  t.check("captureSource: the portal's picture as a PNG", shot.ok && shot.value.width === 64 && shot.value.height === 48 && shot.value.pngBase64.startsWith("iVBORw0KGgo"), { w: shot.value?.width, error: shot.error });
  const call = (await lines()).find((l) => l.method === "Screenshot");
  t.check("the call followed the protocol: a handle_token, not interactive", !!call?.params.includes("handle_token") && call.params.includes("'interactive': <false>"), call);
  t.check("the portal's file doesn't stay around", !Array.from(new Bun.Glob("fake-portal-shot-*").scanSync("/tmp")).length);
  control("SetResponse", "1");
  t.check("the user says no → denied", (await cap("captureSource", { id: 1 })).error?.code === "denied");
  control("SetResponse", "0");
  t.check("a window can't be shot → unsupported", (await cap("captureSource", { id: 12345, type: "window" })).error?.code === "unsupported");
  t.check("an unknown display → invalid_args", (await cap("captureSource", { id: 7 })).error?.code === "invalid_args");

  // ---- global shortcuts ------------------------------------------------------------------
  t.check("the app said who it is, before anything else", (await lines())[0]?.method === "Register" && (await lines())[0].params.includes("dev.kitop.harness"), (await lines())[0]);
  t.check("a bad accelerator → invalid_args, without the portal", (await sc("register", { accelerator: "Ctrl+Nope" })).error?.code === "invalid_args");
  const reg = await sc("register", { accelerator: "CmdOrCtrl+Shift+F9", id: "k" });
  t.check("register → {id}", reg.ok && reg.value.id === "k", reg);
  t.check("isRegistered", (await sc("isRegistered", { id: "k" })).value === true);
  let log = await lines();
  const bind = log.find((l) => l.method === "BindShortcuts");
  t.check("CreateSession, then BindShortcuts with the trigger in the XDG format", log.some((l) => l.method === "CreateSession") && !!bind?.params.includes("'k'") && bind.params.includes("CTRL+SHIFT+F9"), bind);
  const session = (params?: string) => params?.match(/objectpath '([^']+)'/)?.[1] ?? params?.match(/'(\/org\/freedesktop\/portal\/desktop\/session[^']+)'/)?.[1] ?? "";
  const first = session(bind?.params);
  let pressed = t.waitEvent("shortcutPressed", 3000), released = t.waitEvent("shortcutReleased", 3000);
  control("Press", first, "k");
  t.check("the portal's Activated → shortcutPressed {id, accelerator}", (await pressed)?.id === "k");
  control("Release", first, "k");
  const up = await released;
  t.check("Deactivated → shortcutReleased", up?.id === "k" && up.accelerator === "CmdOrCtrl+Shift+F9", up);
  t.check("a used id → invalid_args", (await sc("register", { accelerator: "Ctrl+F2", id: "k" })).error?.code === "invalid_args");
  t.check("a used key → invalid_args", (await sc("register", { accelerator: "CmdOrCtrl+Shift+F9", id: "same" })).error?.code === "invalid_args");

  const two = await sc("register", { accelerator: "Alt+Space", id: "two" });
  t.check("a second one", two.ok, two);
  log = await lines();
  const secondBind = log.filter((l) => l.method === "BindShortcuts").at(-1);
  t.check("a session binds once: a new one with both, the triggers right", secondBind?.params.includes("CTRL+SHIFT+F9") && secondBind.params.includes("ALT+space"), secondBind);
  await t.sleep(100);
  log = await lines();
  t.check("… and the old one is closed", log.some((l) => l.method === "Session.Close" && l.params.includes(first)), log.filter((l) => l.method === "Session.Close"));
  const second = session(secondBind?.params);
  pressed = t.waitEvent("shortcutPressed", 3000);
  control("Press", second, "two");
  t.check("the new session's key works", (await pressed)?.id === "two");
  t.check("… the closed session's doesn't", (control("Press", first, "k"), await Promise.race([t.waitEvent("shortcutPressed", 500), Bun.sleep(600).then(() => null)])) === null);

  control("SetResponse", "1");
  t.check("the user refuses a new one → denied", (await sc("register", { accelerator: "Ctrl+F3", id: "no" })).error?.code === "denied");
  t.check("… which isn't registered", (await sc("isRegistered", { id: "no" })).value === false);
  control("SetResponse", "0");
  pressed = t.waitEvent("shortcutPressed", 3000);
  control("Press", second, "k");
  t.check("… and those before it still work", (await pressed)?.id === "k");
  control("Drop", "left");
  t.check("the user leaves one out → denied", (await sc("register", { accelerator: "Ctrl+F4", id: "left" })).error?.code === "denied");
  control("Drop", "");

  t.check("unregister what isn't: false", (await sc("unregister", { id: "nope" })).value?.unregistered === false);
  t.check("unregister", (await sc("unregister", { id: "two" })).value?.unregistered === true && (await sc("isRegistered", { id: "two" })).value === false);
  const remaining = (await lines()).filter((l) => l.method === "BindShortcuts").at(-1);
  t.check("… a session with the rest", remaining?.params.includes("CTRL+SHIFT+F9") && !remaining.params.includes("ALT+space"), remaining);
  const last = session(remaining?.params);
  t.check("unregisterAll → {unregistered: 1}", (await sc("unregisterAll")).value?.unregistered === 1);
  await t.sleep(100);
  t.check("… and its session is closed", (await lines()).some((l) => l.method === "Session.Close" && l.params.includes(last)));
  t.check("the app's own page through its bridge", ((await t.pageCall("capture", "isSupported")) as any).value?.supported === true);
  portal.kill();
  await portal.exited;
  await t.sleep(300);

  // ---- no portal on the bus --------------------------------------------------------------
  t.check("no portal: capture isn't supported", (await cap("isSupported")).value?.supported === false);
  t.check("no portal: getSources → unavailable", (await cap("getSources")).error?.code === "unavailable");
  t.check("no portal: captureSource → unavailable", (await cap("captureSource", { id: 1 })).error?.code === "unavailable");
  t.check("no portal: a screen recording permission is denied", (await t.call("system", "checkPermission", { name: "screenRecording" })).value?.status === "denied");
  t.check("no portal: shortcuts.register → unavailable", (await sc("register", { accelerator: "Ctrl+F1", id: "x" })).error?.code === "unavailable");
  t.check("… and it isn't registered", (await sc("isRegistered", { id: "x" })).value === false);
};
