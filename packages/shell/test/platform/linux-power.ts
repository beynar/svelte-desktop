// power.blockSleep / unblockSleep over org.freedesktop.ScreenSaver (the test
// session's stand-in exposes ListInhibitors, read here with gdbus), battery from sysfs.
import { $ } from "bun";
import type { Harness } from "../harness-worker.ts";

const inhibitors = async () =>
  (await $`gdbus call --session --dest org.freedesktop.ScreenSaver --object-path /org/freedesktop/ScreenSaver --method org.freedesktop.ScreenSaver.ListInhibitors`.quiet().nothrow()).stdout.toString();

export default async (t: Harness) => {
  const bat = await t.call("power", "getBattery");
  t.check("power.getBattery shape (no battery in a container → percent null, external)", bat.ok && (bat.value.percent === null || typeof bat.value.percent === "number") && typeof bat.value.charging === "boolean" && typeof bat.value.external === "boolean", bat);
  const reason = `svelte-desktop harness ${process.pid}-${Date.now()}`;
  const ids: number[] = [];
  for (const type of ["display", "idle", "system"]) {
    const r = await t.call("power", "blockSleep", { type, reason: `${reason} ${type}` });
    t.check(`power.blockSleep ${type} → {id}`, r.ok && Number.isInteger(r.value.id) && r.value.id > 0, r);
    if (r.ok) ids.push(r.value.id);
  }
  const listed = await inhibitors();
  t.check("ScreenSaver lists the three inhibitors (app name + reason)", ["display", "idle", "system"].every((k) => listed.includes(`'Harness', '${reason} ${k}'`)), listed);
  for (const id of ids) t.check(`power.unblockSleep ${id} → null`, (await t.call("power", "unblockSleep", { id })).value === null);
  t.check("ScreenSaver no longer lists them", !(await inhibitors()).includes(reason), await inhibitors());
  t.check("power.unblockSleep released id → invalid_args", (await t.call("power", "unblockSleep", { id: ids[0] ?? 1 })).error?.code === "invalid_args");
  t.check("power.blockSleep unknown type → invalid_args", (await t.call("power", "blockSleep", { type: "nap" })).error?.code === "invalid_args");
  t.check("power.blockSleep missing type → invalid_args", (await t.call("power", "blockSleep")).error?.code === "invalid_args");
  t.check("power.unblockSleep bad id → invalid_args", (await t.call("power", "unblockSleep", { id: -3 })).error?.code === "invalid_args");
  for (const op of ["getThermalState", "getSystemIdleTime"]) t.check(`power.${op} → unsupported on Linux`, (await t.call("power", op)).error?.code === "unsupported");
  const pageBlock = (await t.pageCall("power", "blockSleep", { type: "idle", reason })) as any;
  const pageUnblock = pageBlock.ok ? ((await t.pageCall("power", "unblockSleep", { id: pageBlock.value.id })) as any) : pageBlock;
  t.check("page bridge: blockSleep + unblockSleep", pageBlock.ok && pageUnblock.ok, { pageBlock, pageUnblock });
};
