// notifications.* through libnotify → org.freedesktop.Notifications (dunst in
// the test session). dunstctl reads dunst's own state to confirm delivery and
// drives it like a user (default action, close). Contract: native/NOTIFICATIONS.md.
import { $ } from "bun";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Harness } from "../harness-worker.ts";

const displayed = async () => Number((await $`dunstctl count displayed`.quiet().nothrow()).stdout.toString().trim() || "0");
const ID = "dev.svelte-desktop.harness";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export default async (t: Harness) => {
  await $`dunstctl close-all`.quiet().nothrow();
  const st = await t.call("notifications", "getPermissionStatus");
  t.check("getPermissionStatus → granted (a notification server is running)", st.ok && st.value.status === "granted", st);
  t.check("requestPermission → granted", (await t.call("notifications", "requestPermission")).value?.status === "granted");
  // Page sink that records responses (the harness page only handles platformResult).
  await t.page(`window.__nr=[];window.__ns=[];window.__shell.setSink((n,d)=>{if(n==='platformResult'){pending.get(d.id)?.(d);pending.delete(d.id);}
    else if(n==='notificationResponse')__nr.push(d);else if(n==='notificationShown')__ns.push(d);});return true`);

  const before = await displayed();
  const payload = JSON.stringify({ url: "/chat/1" });
  const show = await t.call("notifications", "show", {
    id: "t1", title: "Harness title", subtitle: "sub <&>", body: "harness body ✓", payload, image: PNG, urgency: "critical",
    actions: [{ id: "ok", title: "OK" }, { id: "reply", title: "Reply", input: { placeholder: "Message" } }],
  });
  t.check("show → {id, scheduled:false}", show.ok && show.value.id === "t1" && show.value.scheduled === false, show);
  await t.sleep(400);
  t.check("dunst displays it", (await displayed()) === before + 1, await displayed());
  const cache = `${homedir()}/.cache/${ID}/notification-images`;
  t.check("data: URL image → cache file", existsSync(cache) && readdirSync(cache).some((f) => f.endsWith(".png")));
  const again = await t.call("notifications", "show", { id: "t1", title: "Harness title 2", body: "replaced", payload, renotify: false });
  await t.sleep(300);
  t.check("same id replaces in place (no duplicate)", again.ok && (await displayed()) === before + 1, await displayed());
  const dl = await t.call("notifications", "delivered");
  const d1 = dl.value?.find((n: any) => n.id === "t1");
  t.check("delivered → [{id,title,body,payload,date}]", d1?.title === "Harness title 2" && d1.body === "replaced" && d1.payload === payload && d1.date > 0, dl);

  const resp = t.waitEvent("notificationResponse", 3000);
  await $`dunstctl action 0`.quiet().nothrow(); // the default action of the top notification
  const r = await resp;
  t.check("click → notificationResponse {seq,id,tag,kind:click,actionId:null,payload}", r?.id === "t1" && r.tag === "t1" && r.kind === "click" &&
    r.actionId === null && r.payload === payload && typeof r.seq === "number" && !("target" in r), r);
  await t.sleep(300);
  const pr = await t.page<any[]>(`return window.__nr`);
  t.check("the page that showed it gets target:true", pr?.length === 1 && pr[0].target === true && pr[0].seq === r?.seq, pr);
  await $`dunstctl close`.quiet().nothrow(); // dunstctl action leaves it up; a real click closes it (reason 2)
  await t.sleep(400);
  t.check("no dismiss for the close that follows a click", !(t.events.get("notificationResponse") ?? []).some((e: any) => e.kind === "dismiss"));
  t.check("delivered drops it once closed", !(await t.call("notifications", "delivered")).value?.some((n: any) => n.id === "t1"));
  const rs = await t.call("notifications", "responses");
  t.check("responses → the ring", rs.ok && rs.value.length >= 1 && rs.value.at(-1).seq === r?.seq, rs);
  const cl = await t.call("notifications", "claim");
  t.check("claim → [] (a page was loaded: nothing waits)", cl.ok && Array.isArray(cl.value) && cl.value.length === 0, cl);

  await t.call("notifications", "show", { id: "t3", title: "to dismiss" });
  await t.sleep(300);
  const dis = t.waitEvent("notificationResponse", 3000);
  await $`dunstctl close`.quiet().nothrow(); // closed by the user → reason 2
  const dr = await dis;
  t.check("user close → kind:dismiss", dr?.id === "t3" && dr.kind === "dismiss" && dr.actionId === null, dr);

  const s2 = await t.call("notifications", "notify", { title: "alias", id: "t2" });
  t.check("notify alias", s2.ok && s2.value.id === "t2", s2);
  await t.sleep(300);
  const shownBefore = await displayed();
  const d = await t.call("notifications", "dismiss", { id: "t2" });
  await t.sleep(400);
  t.check("dismiss closes it (dunst's displayed count drops)", d.ok && (await displayed()) === shownBefore - 1, { shownBefore, after: await displayed() });
  t.check("dismiss {tag} (legacy)", (await t.call("notifications", "dismiss", { tag: "nope" })).ok);

  // Scheduling: timer while running + persisted queue.
  const at = Date.now() + 1500;
  const sc = await t.call("notifications", "show", { id: "s1", title: "scheduled", body: "later", at, payload });
  t.check("show {at} → scheduled:true", sc.ok && sc.value.scheduled === true, sc);
  const pend = await t.call("notifications", "pending");
  t.check("pending → [{id,title,body,at,payload}]", pend.value?.some((p: any) => p.id === "s1" && p.at === at && p.title === "scheduled" && p.payload === payload), pend);
  const file = `${homedir()}/.local/share/${ID}/scheduled-notifications.json`;
  t.check("persisted to <data dir>/scheduled-notifications.json", existsSync(file) && JSON.parse(readFileSync(file, "utf8")).some((e: any) => e.id === "s1"));
  const shown = await t.waitEvent("notificationShown", 4000);
  t.check("fires → notificationShown {id,payload,push:false}", shown?.id === "s1" && shown.payload === payload && shown.push === false, shown);
  t.check("delivered once fired, no longer pending", (await t.call("notifications", "delivered")).value?.some((n: any) => n.id === "s1") &&
    !(await t.call("notifications", "pending")).value?.some((p: any) => p.id === "s1"));
  const rp = await t.call("notifications", "show", { id: "r1", title: "every minute", at: Date.now() + 800, repeat: "minute" });
  const shown2 = await t.waitEvent("notificationShown", 3000);
  const next = (await t.call("notifications", "pending")).value?.find((p: any) => p.id === "r1");
  t.check("repeat: fires, then the next occurrence is pending", rp.ok && shown2?.id === "r1" && next?.repeat === "minute" && next.at > Date.now() + 50_000, next);
  await t.call("notifications", "show", { id: "s9", title: "far", at: Date.now() + 3600_000 });
  await t.call("notifications", "dismiss", { id: "r1" });
  t.check("dismiss cancels a pending one", !(await t.call("notifications", "pending")).value?.some((p: any) => p.id === "r1"));
  await t.call("notifications", "dismissAll");
  await t.sleep(300);
  t.check("dismissAll: nothing pending, nothing delivered, queue file emptied",
    (await t.call("notifications", "pending")).value?.length === 0 && (await t.call("notifications", "delivered")).value?.length === 0 &&
    JSON.parse(readFileSync(file, "utf8")).length === 0);

  // Badge: Unity LauncherEntry signal on the session bus.
  const mon = Bun.spawn(["dbus-monitor", "--session", "interface='com.canonical.Unity.LauncherEntry'"], { stdout: "pipe", stderr: "ignore" });
  await t.sleep(300);
  const b = await t.call("notifications", "setBadge", { count: 7 });
  await t.call("notifications", "setBadge", { count: null });
  await t.sleep(300);
  mon.kill();
  const out = await new Response(mon.stdout).text();
  t.check("setBadge → LauncherEntry.Update(application://<id>.desktop, {count, count-visible})",
    b.ok && out.includes(`application://${ID}.desktop`) && /int64 7/.test(out) && out.includes("count-visible"), out.slice(0, 600));
  t.check("setBadge bad count → invalid_args", (await t.call("notifications", "setBadge", { count: -1 })).error?.code === "invalid_args");
  t.check("setForeground → ok", (await t.call("notifications", "setForeground", { show: true })).ok);

  const extra = await t.call("notifications", "show", { id: "x1", title: "extras", ongoing: true, autoCancel: false, closeButtonText: "Later",
    lines: ["a", "b"], body: "a\nb", summary: "2", color: "#ff3e00", visibility: "private" });
  await t.sleep(300);
  t.check("ongoing / autoCancel / closeButtonText / lines accepted, dunst shows it (hints: linux-notifications-fake)",
    extra.ok && (await t.call("notifications", "delivered")).value?.some((n: any) => n.id === "x1"), extra);
  await t.call("notifications", "dismiss", { id: "x1" });
  t.check("auto id when none given", /^n\d+-\d+$/.test((await t.call("notifications", "show", { title: "untagged" })).value?.id ?? ""));
  t.check("show missing title → invalid_args", (await t.call("notifications", "show", { body: "x" })).error?.code === "invalid_args");
  t.check("repeat without at → invalid_args", (await t.call("notifications", "show", { title: "x", repeat: "day" })).error?.code === "invalid_args");
  t.check("dismiss missing id → invalid_args", (await t.call("notifications", "dismiss", {})).error?.code === "invalid_args");
  t.check("push.register → unsupported", (await t.call("push", "register")).error?.code === "unsupported");
  const viaPage = (await t.pageCall("notifications", "show", { title: "from page", id: "p1" })) as any;
  t.check("page bridge: notifications.show", viaPage.ok && viaPage.value.id === "p1", viaPage);
  await $`dunstctl close-all`.quiet().nothrow();
};
