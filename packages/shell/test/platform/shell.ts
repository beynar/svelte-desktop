import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const tmp = `/tmp/sd-trash-${process.pid}.txt`;
  await Bun.write(tmp, "trash me");
  t.check("trashItem", (await t.call("shell", "trashItem", { path: tmp })).ok && !(await Bun.file(tmp).exists()));
  t.check("trashItem missing → invalid_args", (await t.call("shell", "trashItem", { path: tmp })).error?.code === "invalid_args");
  t.check("openExternal file: rejected", (await t.call("shell", "openExternal", { url: "file:///etc/hosts" })).error?.code === "invalid_args");
  t.check("openExternal javascript: rejected", (await t.call("shell", "openExternal", { url: "javascript:alert(1)" })).error?.code === "invalid_args");
  t.check("openPath missing → invalid_args", (await t.call("shell", "openPath", { path: "/nope/nope" })).error?.code === "invalid_args");
  t.check("showItemInFolder missing → invalid_args", (await t.call("shell", "showItemInFolder", { path: "/nope/nope" })).error?.code === "invalid_args");
  t.check("page bridge: shell.openExternal validation", (await t.pageCall("shell", "openExternal", { url: "file:///x" }) as any).error?.code === "invalid_args");
  t.skip("openExternal(https) / openPath / showItemInFolder / beep", "open other apps or make sound");
};
