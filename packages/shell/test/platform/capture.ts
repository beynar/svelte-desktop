import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const s = await t.call("capture", "isSupported");
  t.check("isSupported", s.ok && s.value.supported === true, s.value);
  const src = await t.call("capture", "getSources", { types: ["display"] });
  if (src.error?.code === "denied") {
    t.check("getSources without Screen Recording permission → denied (typed, no hang)", true, src.error);
    t.check("captureSource without permission → denied", (await t.call("capture", "captureSource", { id: 1 })).error?.code === "denied");
    t.skip("listing + PNG capture", "this terminal lacks the Screen Recording permission");
    return;
  }
  t.check("getSources displays", src.ok && src.value.length > 0 && src.value[0].type === "display", src.value?.[0]);
  const shot = await t.call("capture", "captureSource", { id: src.value[0].id, type: "display" });
  t.check("captureSource PNG", shot.ok && shot.value.pngBase64.startsWith("iVBOR") && shot.value.width > 100, { w: shot.value?.width });
  const wins = await t.call("capture", "getSources", { types: ["window"] });
  t.check("getSources windows", wins.ok && Array.isArray(wins.value));
};
