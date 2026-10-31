import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const all = await t.call("screen", "getAllDisplays");
  t.check("getAllDisplays non-empty", all.ok && all.value.length > 0, all.value);
  t.check("exactly one primary", all.value.filter((d: any) => d.isPrimary).length === 1);
  t.check("primary bounds at 0,0 (top-left convention)", all.value.find((d: any) => d.isPrimary).bounds.x === 0 && all.value.find((d: any) => d.isPrimary).bounds.y === 0);
  const p = await t.call("screen", "getPrimaryDisplay");
  t.check("getPrimaryDisplay", p.ok && p.value.isPrimary && typeof p.value.uuid === "string", p.value);
  t.check("workArea within bounds", p.value.workArea.height <= p.value.bounds.height);
  t.check("getDisplayNearestWindow", (await t.call("screen", "getDisplayNearestWindow")).ok);
  const cur = await t.call("screen", "getCursorScreenPoint");
  t.check("getCursorScreenPoint", cur.ok && Number.isFinite(cur.value.x) && Number.isFinite(cur.value.y), cur.value);
  const sf = await t.call("screen", "scaleFactor");
  t.check("scaleFactor ≥ 1", sf.ok && sf.value >= 1, sf.value);
  t.check("page bridge: screen.getAllDisplays", (await t.pageCall("screen", "getAllDisplays") as any).ok);
};
