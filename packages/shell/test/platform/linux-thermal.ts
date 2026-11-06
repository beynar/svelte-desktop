// power.getThermalState and thermalStateChanged from thermal zones, here the suite's files in sysfs's layout
// (run-platform-linux.sh points KITOP_THERMAL_DIR at them): a container has what its host has.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const root = process.env.KITOP_THERMAL_DIR!;

const zone = (n: number, temp: number, trips: [string, number][], mode?: string) => {
  const dir = `${root}/thermal_zone${n}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/temp`, `${temp}\n`);
  if (mode) writeFileSync(`${dir}/mode`, `${mode}\n`);
  trips.forEach(([type, at], i) => {
    writeFileSync(`${dir}/trip_point_${i}_type`, `${type}\n`);
    writeFileSync(`${dir}/trip_point_${i}_temp`, `${at}\n`);
  });
};

export default async (t: Harness) => {
  const state = async () => t.call("power", "getThermalState");
  const trips: [string, number][] = [["active", 60000], ["passive", 85000], ["hot", 100000], ["critical", 105000]];
  rmSync(root, { recursive: true, force: true });
  t.check("no folder: not known, unavailable", (await state()).error?.code === "unavailable");
  mkdirSync(root, { recursive: true });
  zone(0, 45000, []);
  t.check("a zone without trip points says nothing: unavailable", (await state()).error?.code === "unavailable");
  zone(1, 45000, trips);
  t.check("below all its trips: nominal", (await state()).value?.state === "nominal");
  t.check("… thermalState too", (await t.call("power", "thermalState")).value?.state === "nominal");
  zone(1, 60000, trips);
  t.check("at an active trip (a fan): fair", (await state()).value?.state === "fair");
  zone(1, 90000, trips);
  t.check("past a passive trip (throttling): serious", (await state()).value?.state === "serious");
  zone(1, 100000, trips);
  t.check("at the hot trip: critical", (await state()).value?.state === "critical");
  zone(1, 45000, trips);
  zone(2, 90000, trips);
  t.check("the worst zone counts", (await state()).value?.state === "serious");
  zone(2, 90000, trips, "disabled");
  t.check("a disabled zone doesn't", (await state()).value?.state === "nominal");
  writeFileSync(`${root}/thermal_zone1/temp`, "");
  rmSync(`${root}/thermal_zone2`, { recursive: true });
  t.check("a sensor that can't be read isn't a temperature: unavailable", (await state()).error?.code === "unavailable");
  zone(1, 45000, trips);
  await t.sleep(5500); // the timer has seen nominal
  const changed = t.waitEvent("thermalStateChanged", 7000);
  const before = (t.events.get("thermalStateChanged") ?? []).length;
  zone(1, 90000, trips);
  t.check("thermalStateChanged when it changes", (await changed) !== null, before);
  t.check("… after which the state is the new one", (await state()).value?.state === "serious");
  await t.sleep(6000);
  t.check("… once", (t.events.get("thermalStateChanged") ?? []).length === before + 1, (t.events.get("thermalStateChanged") ?? []).length);
  rmSync(root, { recursive: true, force: true });
};
