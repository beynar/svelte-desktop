// power.blockSleep / unblockSleep over org.freedesktop.ScreenSaver (the test
// session's stand-in exposes ListInhibitors, read here with gdbus), battery from sysfs.
import { $ } from "bun";
import type { Harness } from "../harness-worker.ts";

const inhibitors = async () =>
  (await $`gdbus call --session --dest org.freedesktop.ScreenSaver --object-path /org/freedesktop/ScreenSaver --method org.freedesktop.ScreenSaver.ListInhibitors`.quiet().nothrow()).stdout.toString();

export default async (t: Harness) => {
  const bat = await t.call("power", "getBattery");
  t.check("power.getBattery shape (no battery in a container → percent null, external)", bat.ok && (bat.value.percent === null || typeof bat.value.percent === "number") && typeof bat.value.charging === "boolean" && typeof bat.value.external === "boolean", bat);
  const reason = `kitop harness ${process.pid}-${Date.now()}`;
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
  // Idle time: real input moves it, under Xvfb's XScreenSaver extension.
  const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]);
  xdotool("mousemove", "300", "300");
  await t.sleep(1500);
  const idle = await t.call("power", "getSystemIdleTime");
  t.check("power.getSystemIdleTime: seconds without input", idle.ok && idle.value >= 1.2 && idle.value < 30, idle);
  xdotool("mousemove", "320", "320");
  await t.sleep(100);
  const after = await t.call("power", "getSystemIdleTime");
  t.check("… and input resets it", after.ok && after.value < idle.value && after.value < 1, after);
  // This machine's own zones, whatever it has (linux-thermal runs them all): a state or `unavailable`.
  const thermal = await t.call("power", "getThermalState");
  t.check("power.getThermalState here: a state or unavailable, nothing else", thermal.ok ? ["nominal", "fair", "serious", "critical"].includes(thermal.value.state) : thermal.error?.code === "unavailable", thermal);
  const pageBlock = (await t.pageCall("power", "blockSleep", { type: "idle", reason })) as any;
  const pageUnblock = pageBlock.ok ? ((await t.pageCall("power", "unblockSleep", { id: pageBlock.value.id })) as any) : pageBlock;
  t.check("page bridge: blockSleep + unblockSleep", pageBlock.ok && pageUnblock.ok, { pageBlock, pageUnblock });
};
