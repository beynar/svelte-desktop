// power.*: thermal state, idle time, battery, sleep assertions, power events.
import { $ } from "bun";
import type { Harness } from "../harness-worker.ts";
import { postLocal, postWorkspace } from "../objc.ts";

const assertions = async () => (await $`pmset -g assertions`.quiet().nothrow()).stdout.toString();

export default async (t: Harness) => {
  for (const op of ["getThermalState", "thermalState"]) {
    const r = await t.call("power", op);
    t.check(`power.${op} → {state}`, r.ok && ["nominal", "fair", "serious", "critical"].includes(r.value.state), r);
  }

  const idle = await t.call("power", "getSystemIdleTime");
  t.check("power.getSystemIdleTime → seconds ≥ 0", idle.ok && typeof idle.value === "number" && idle.value >= 0, idle);

  const bat = await t.call("power", "getBattery");
  const b = bat.value ?? {};
  t.check(
    "power.getBattery shape",
    bat.ok && (b.percent === null || (typeof b.percent === "number" && b.percent >= 0 && b.percent <= 100)) && typeof b.charging === "boolean" && typeof b.external === "boolean",
    bat,
  );

  // Sleep blocks: create, verify with pmset, release, verify gone.
  const reason = `svelte-desktop harness ${process.pid}-${Date.now()}`;
  const ids: number[] = [];
  for (const type of ["display", "idle", "system"]) {
    const r = await t.call("power", "blockSleep", { type, reason: `${reason} ${type}` });
    t.check(`power.blockSleep ${type} → {id}`, r.ok && Number.isInteger(r.value.id) && r.value.id > 0, r);
    if (r.ok) ids.push(r.value.id);
  }
  const listed = await assertions();
  t.check("pmset lists the three assertions", ["display", "idle", "system"].every((k) => listed.includes(`${reason} ${k}`)), listed.split("\n").filter((l) => l.includes("harness")));
  for (const id of ids) {
    const r = await t.call("power", "unblockSleep", { id });
    t.check(`power.unblockSleep ${id} → null`, r.ok && r.value === null, r);
  }
  const after = await assertions();
  t.check("pmset no longer lists them", !after.includes(reason), after.split("\n").filter((l) => l.includes("harness")));
  const twice = await t.call("power", "unblockSleep", { id: ids[0] ?? 1 });
  t.check("power.unblockSleep released id → invalid_args", twice.error?.code === "invalid_args", twice);
  const badType = await t.call("power", "blockSleep", { type: "nap" });
  t.check("power.blockSleep unknown type → invalid_args", badType.error?.code === "invalid_args", badType);
  const noType = await t.call("power", "blockSleep");
  t.check("power.blockSleep missing type → invalid_args", noType.error?.code === "invalid_args", noType);
  const badId = await t.call("power", "unblockSleep", { id: -3 });
  t.check("power.unblockSleep bad id → invalid_args", badId.error?.code === "invalid_args", badId);

  // Events: post the real notifications in-process so the observers fire.
  const cases: Array<[string, () => void]> = [
    ["systemSleep", () => postWorkspace("NSWorkspaceWillSleepNotification")],
    ["systemWake", () => postWorkspace("NSWorkspaceDidWakeNotification")],
    ["displaySleep", () => postWorkspace("NSWorkspaceScreensDidSleepNotification")],
    ["displayWake", () => postWorkspace("NSWorkspaceScreensDidWakeNotification")],
    ["thermalStateChanged", () => postLocal("NSProcessInfoThermalStateDidChangeNotification")],
  ];
  for (const [name, post] of cases) {
    const ev = t.waitEvent(name, 2000);
    post();
    const got = await ev;
    t.check(`${name} emitted with {}`, got !== null && Object.keys(got).length === 0, got);
  }
  t.skip("screenLocked/screenUnlocked, screensaverStarted/Stopped", "system-wide distributed notifications; spoofing them would reach every app. Needs a human locking the screen");

  const viaPage = (await t.pageCall("power", "getThermalState")) as any;
  t.check("page bridge: power.getThermalState", viaPage.ok && typeof viaPage.value.state === "string", viaPage);
  const pageBlock = (await t.pageCall("power", "blockSleep", { type: "idle", reason })) as any;
  const pageUnblock = pageBlock.ok ? ((await t.pageCall("power", "unblockSleep", { id: pageBlock.value.id })) as any) : pageBlock;
  t.check("page bridge: blockSleep + unblockSleep", pageBlock.ok && pageUnblock.ok, { pageBlock, pageUnblock });
};
