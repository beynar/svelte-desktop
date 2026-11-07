// notifications.*: UNUserNotificationCenter needs a bundle identifier. From
// `bun` there is none: its status says so, and nothing is posted or raised.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const status = await t.call("notifications", "getPermissionStatus");
  const unbundled = status.value?.status === "unavailable";
  if (!unbundled) {
    t.check("notifications.getPermissionStatus (bundled) → status", status.ok && ["granted", "denied", "notDetermined"].includes(status.value.status), status);
    t.skip("notifications.show/dismiss/requestPermission/notificationResponse", "bundled run: would prompt or post a real notification; needs a human");
    return;
  }
  const asked = await t.call("notifications", "requestPermission");
  t.check("notifications.requestPermission unbundled → unavailable (no prompt)", asked.value?.status === "unavailable", asked);
  for (const [op, args] of [
    ["show", { title: "hello", body: "world", tag: "t1", actions: [{ id: "ok", label: "OK" }] }],
    ["notify", { title: "alias" }],
  ] as const) {
    const r = await t.call("notifications", op, args);
    t.check(`notifications.${op} unbundled → skipped (no exception)`, r.value?.skipped === true && r.value.scheduled === false, r);
  }
  for (const op of ["dismiss", "close"]) t.check(`notifications.${op} unbundled → nothing to do`, (await t.call("notifications", op, { tag: "t1" })).ok);
  const noTitle = await t.call("notifications", "show", { body: "x" });
  t.check("notifications.show missing title → invalid_args", noTitle.error?.code === "invalid_args", noTitle);
  const noTag = await t.call("notifications", "dismiss", {});
  t.check("notifications.dismiss missing tag → invalid_args", noTag.error?.code === "invalid_args", noTag);

  const viaPage = (await t.pageCall("notifications", "getPermissionStatus")) as any;
  t.check("page bridge: notifications.getPermissionStatus → unavailable", viaPage.value?.status === "unavailable", viaPage);

  t.skip("notifications.show/dismiss delivery, actions, notificationResponse", "needs the packaged .app (bundle id) and a human to click");
  t.skip("notifications.requestPermission prompt", "needs the packaged .app; shows a system prompt");
};
