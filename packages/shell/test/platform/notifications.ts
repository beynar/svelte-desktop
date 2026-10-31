// notifications.*: UNUserNotificationCenter needs a bundle identifier. From
// `bun` there is none, so every op must fail `unavailable` instead of raising.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const status = await t.call("notifications", "getPermissionStatus");
  const unbundled = !status.ok && status.error?.code === "unavailable";
  if (!unbundled) {
    t.check("notifications.getPermissionStatus (bundled) → status", status.ok && ["granted", "denied", "notDetermined"].includes(status.value.status), status);
    t.skip("notifications.show/dismiss/requestPermission/notificationResponse", "bundled run: would prompt or post a real notification; needs a human");
    return;
  }
  t.check("getPermissionStatus unbundled → unavailable with a clear message", /bundle/i.test(status.error!.message), status);
  for (const [op, args] of [
    ["requestPermission", {}],
    ["show", { title: "hello", body: "world", tag: "t1", actions: [{ id: "ok", label: "OK" }] }],
    ["notify", { title: "alias" }],
    ["dismiss", { tag: "t1" }],
    ["close", { tag: "t1" }],
  ] as const) {
    const r = await t.call("notifications", op, args);
    t.check(`notifications.${op} unbundled → unavailable (no exception)`, r.error?.code === "unavailable", r);
  }
  const noTitle = await t.call("notifications", "show", { body: "x" });
  t.check("notifications.show missing title → invalid_args", noTitle.error?.code === "invalid_args", noTitle);
  const noTag = await t.call("notifications", "dismiss", {});
  t.check("notifications.dismiss missing tag → invalid_args", noTag.error?.code === "invalid_args", noTag);

  const viaPage = (await t.pageCall("notifications", "getPermissionStatus")) as any;
  t.check("page bridge: notifications.getPermissionStatus → unavailable", viaPage.error?.code === "unavailable", viaPage);

  t.skip("notifications.show/dismiss delivery, actions, notificationResponse", "needs the packaged .app (bundle id) and a human to click");
  t.skip("notifications.requestPermission prompt", "needs the packaged .app; shows a system prompt");
};
