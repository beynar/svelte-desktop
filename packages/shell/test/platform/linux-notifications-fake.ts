// notifications.* against a scriptable org.freedesktop.Notifications
// (test/docker/fake-notifications.c, replacing dunst for this suite): asserts what
// libshell sends (hints, actions, timeouts, replaces_id) and plays the user —
// ActionInvoked (click / action buttons / close button) and NotificationClosed —
// so every response kind is checked end to end. Contract: native/NOTIFICATIONS.md.
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const ID = "dev.svelte-desktop.harness";
const LOG = `/tmp/fake-notify-${process.pid}.log`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DEST = ["--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications"];

type Sent = { op: string; id: number; replaces?: number; timeout?: number; summary?: string; body?: string; actions?: string[]; hints?: Record<string, any> };
const sent = (): Sent[] => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const last = (summary: string) => sent().filter((n) => n.op === "notify" && n.summary === summary).at(-1);
const invoke = (id: number, action: string) => $`gdbus call ${DEST} --method dev.svelte_desktop.FakeNotifications.Invoke ${id} ${action}`.quiet().nothrow();
const close = (id: number, reason: number) => $`gdbus call ${DEST} --method dev.svelte_desktop.FakeNotifications.Close ${id} ${reason}`.quiet().nothrow();

export default async (t: Harness) => {
  await $`pkill -x dunst`.quiet().nothrow();
  const server = Bun.spawn(["/tmp/fake-notifications"], { env: { ...process.env, FAKE_NOTIFY_LOG: LOG }, stdout: "ignore", stderr: "inherit" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = (await $`gdbus call ${DEST} --method org.freedesktop.Notifications.GetServerInformation`.quiet().nothrow()).stdout.toString().includes("fake-notifications");
    if (!up) await t.sleep(100);
  }
  t.check("fake notification server owns org.freedesktop.Notifications", up);
  await t.page(`window.__nr=[];window.__shell.setSink((n,d)=>{if(n==='platformResult'){pending.get(d.id)?.(d);pending.delete(d.id);}
    else if(n==='notificationResponse')__nr.push(d);});return true`);
  const next = () => t.waitEvent("notificationResponse", 3000);
  const payload = JSON.stringify({ url: "/inbox" });

  // What goes over the wire.
  const s1 = await t.call("notifications", "show", {
    id: "f1", title: "Fake one", subtitle: "sub <&>", body: "body", image: PNG, urgency: "critical", silent: true, payload,
    actions: [{ id: "done", title: "Done", foreground: false }, { id: "reply", title: "Reply", input: { placeholder: "…" } }], closeButtonText: "Later",
  });
  await t.sleep(300);
  const n1 = last("Fake one")!;
  t.check("show → Notify sent", s1.ok && !!n1, { s1, n1 });
  t.check("hints: desktop-entry = identifier, image-path file:// (data: URL decoded), urgency 2, suppress-sound (silent)",
    n1?.hints?.["desktop-entry"] === ID && /^file:\/\/\/.+\.png$/.test(n1.hints["image-path"] ?? "") && n1.hints.urgency === 2 && n1.hints["suppress-sound"] === true, n1?.hints);
  t.check("actions: default + buttons (input → plain action) + closeButtonText", JSON.stringify(n1?.actions) ===
    JSON.stringify(["default", "Open", "a:done", "Done", "a:reply", "Reply", "sd:close", "Later"]), n1?.actions);
  t.check("subtitle in bold, markup escaped", n1?.body === "<b>sub &lt;&amp;&gt;</b>\nbody", n1?.body);
  t.check("default expiry, not resident", n1?.timeout === -1 && !("resident" in (n1?.hints ?? {})), n1);

  // An action button.
  let r = next();
  await invoke(n1.id, "a:done");
  let e = await r;
  t.check("ActionInvoked(a:done) → kind:action, actionId:done, payload", e?.id === "f1" && e.kind === "action" && e.actionId === "done" && e.payload === payload, e);
  await t.sleep(200);
  const pr = await t.page<any[]>(`return window.__nr`);
  t.check("page gets it with target:true", pr?.at(-1)?.seq === e?.seq && pr.at(-1).target === true, pr);
  r = next();
  await invoke(n1.id, "a:reply");
  e = await r;
  t.check("input action → kind:action (no inline reply over libnotify)", e?.kind === "action" && e.actionId === "reply" && !("input" in e), e);

  // Replace in place; renotify:false.
  await t.call("notifications", "show", { id: "f1", title: "Fake one bis", renotify: false, payload });
  await t.sleep(300);
  const n1b = last("Fake one bis");
  t.check("same id → Notify with replaces_id, renotify:false → suppress-sound", n1b?.replaces === n1.id && n1b.hints?.["suppress-sound"] === true, n1b);

  // The body click, then the server's close: no dismiss.
  r = next();
  await invoke(n1.id, "default");
  e = await r;
  t.check("ActionInvoked(default) → kind:click, actionId:null", e?.id === "f1" && e.kind === "click" && e.actionId === null, e);
  r = next();
  await close(n1.id, 2);
  t.check("close after a click → no dismiss", (await r) === null);
  t.check("delivered drops it", !(await t.call("notifications", "delivered")).value?.some((n: any) => n.id === "f1"));

  // Dismissed by the user / expired.
  await t.call("notifications", "show", { id: "f2", title: "Fake two" });
  await t.call("notifications", "show", { id: "f3", title: "Fake three" });
  await t.sleep(300);
  r = next();
  await close(last("Fake two")!.id, 2);
  e = await r;
  t.check("NotificationClosed(reason 2) → kind:dismiss", e?.id === "f2" && e.kind === "dismiss" && e.actionId === null, e);
  r = next();
  await close(last("Fake three")!.id, 1);
  t.check("NotificationClosed(reason 1, expired) → no response", (await r) === null);

  // closeButtonText: an action that closes it.
  await t.call("notifications", "show", { id: "f4", title: "Fake four", closeButtonText: "Later" });
  await t.sleep(300);
  const n4 = last("Fake four")!;
  r = next();
  await invoke(n4.id, "sd:close");
  e = await r;
  await t.sleep(300);
  t.check("close button → kind:dismiss + CloseNotification", e?.id === "f4" && e.kind === "dismiss" && sent().some((x) => x.op === "close" && x.id === n4.id), e);

  // ongoing / autoCancel:false → resident (stays after an action; a later close is the user's).
  await t.call("notifications", "show", { id: "f5", title: "Fake five", ongoing: true });
  await t.call("notifications", "show", { id: "f6", title: "Fake six", autoCancel: false });
  await t.sleep(300);
  const n5 = last("Fake five")!, n6 = last("Fake six")!;
  t.check("ongoing → resident hint, never expires", n5?.hints?.resident === true && n5.timeout === 0, n5);
  t.check("autoCancel:false → resident hint", n6?.hints?.resident === true && n6.timeout === -1, n6);
  r = next();
  await invoke(n5.id, "default");
  t.check("resident: click", (await r)?.kind === "click");
  t.check("resident: still delivered after the click", (await t.call("notifications", "delivered")).value?.some((n: any) => n.id === "f5"));
  r = next();
  await close(n5.id, 2);
  t.check("resident: a later user close → dismiss", (await r)?.kind === "dismiss");

  // Sounds, requireInteraction, low urgency.
  await t.call("notifications", "show", { id: "f7", title: "Fake seven", sound: "bell", urgency: "low", requireInteraction: true });
  await t.call("notifications", "show", { id: "f8", title: "Fake eight", sound: "default" });
  await t.sleep(300);
  const n7 = last("Fake seven"), n8 = last("Fake eight");
  t.check("sound name → sound-name, urgency low → 0, requireInteraction → timeout 0",
    n7?.hints?.["sound-name"] === "bell" && n7.hints.urgency === 0 && n7.timeout === 0, n7);
  t.check("sound default → message-new-instant, urgency normal → 1", n8?.hints?.["sound-name"] === "message-new-instant" && n8.hints.urgency === 1, n8);
  t.check("summary / color / visibility / lines accepted (ignored)",
    (await t.call("notifications", "show", { id: "f9", title: "x", summary: "s", color: "#f00", visibility: "secret", lines: ["a", "b"], body: "a\nb" })).ok);

  // dismiss → CloseNotification.
  await t.call("notifications", "dismiss", { id: "f6" });
  await t.sleep(300);
  t.check("dismiss → CloseNotification(id)", sent().some((x) => x.op === "close" && x.id === n6.id));
  await t.call("notifications", "dismissAll");
  const rs = (await t.call("notifications", "responses")).value ?? [];
  t.check("responses ring holds every kind", ["click", "action", "dismiss"].every((k) => rs.some((x: any) => x.kind === k)), rs.map((x: any) => x.kind));

  server.kill();
  await $`sh -c 'dunst >/tmp/dunst.log 2>&1 &'`.quiet().nothrow(); // back to the shared session's server
};
