// notifications.* through libnotify → org.freedesktop.Notifications (dunst in
// the test session). dunstctl reads dunst's own state to confirm delivery.
import { $ } from "bun";
import type { Harness } from "../harness-worker.ts";

const displayed = async () => Number((await $`dunstctl count displayed`.quiet().nothrow()).stdout.toString().trim() || "0");

export default async (t: Harness) => {
  const st = await t.call("notifications", "getPermissionStatus");
  t.check("getPermissionStatus → granted (a notification server is running)", st.ok && st.value.status === "granted", st);
  t.check("requestPermission → granted", (await t.call("notifications", "requestPermission")).value?.status === "granted");
  const before = await displayed();
  const show = await t.call("notifications", "show", { title: "Harness title", body: "harness body ✓", tag: "t1", actions: [{ id: "ok", label: "OK" }] });
  t.check("show → {tag}", show.ok && show.value.tag === "t1", show);
  await t.sleep(400);
  t.check("dunst displays it", (await displayed()) === before + 1, await displayed());
  const resp = t.waitEvent("notificationResponse", 3000);
  await $`dunstctl action 0`.quiet().nothrow(); // invoke the default action of the top notification
  const r = await resp;
  t.check("activation → notificationResponse {tag, actionId:null}", r?.tag === "t1" && r.actionId === null, r);
  const s2 = await t.call("notifications", "notify", { title: "alias", tag: "t2" });
  t.check("notify alias", s2.ok && s2.value.tag === "t2", s2);
  await t.sleep(300);
  const shownBefore = await displayed();
  const d = await t.call("notifications", "dismiss", { tag: "t2" });
  await t.sleep(400);
  t.check("dismiss closes it (dunst's displayed count drops)", d.ok && (await displayed()) === shownBefore - 1, { shownBefore, after: await displayed() });
  t.check("auto tag when none given", /^n\d+$/.test((await t.call("notifications", "show", { title: "untagged" })).value?.tag ?? ""));
  t.check("show missing title → invalid_args", (await t.call("notifications", "show", { body: "x" })).error?.code === "invalid_args");
  t.check("dismiss missing tag → invalid_args", (await t.call("notifications", "dismiss", {})).error?.code === "invalid_args");
  const viaPage = (await t.pageCall("notifications", "show", { title: "from page", tag: "p1" })) as any;
  t.check("page bridge: notifications.show", viaPage.ok && viaPage.value.tag === "p1", viaPage);
  await $`dunstctl close-all`.quiet().nothrow();
  t.skip("action buttons (actionId) by click", "dunst renders actions in a context menu; needs a human");
};
