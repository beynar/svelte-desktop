import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const before = await t.call("theme", "get");
  t.check("get", before.ok && ["light", "dark", "vibrantLight", "vibrantDark"].includes(before.value.appearance), before.value);
  const target = before.value.dark ? "light" : "dark";
  const ev = t.waitEvent("appearanceChanged");
  const set = await t.call("theme", "set", { appearance: target });
  t.check(`set ${target}`, set.ok && set.value.dark === (target === "dark"), set.value);
  const e = await ev;
  t.check("appearanceChanged event", e && e.dark === (target === "dark"), e);
  t.check("shouldUseDarkColors follows", (await t.call("theme", "shouldUseDarkColors")).value === (target === "dark"));
  t.check("set bad → invalid_args", (await t.call("theme", "set", { appearance: "purple" })).error?.code === "invalid_args");
  t.check("set system", (await t.call("theme", "set", { appearance: "system" })).ok);
  t.check("restored", (await t.call("theme", "get")).value.dark === before.value.dark);
  const media = await t.page<boolean>(`return matchMedia('(prefers-color-scheme: dark)').matches`);
  t.check("page prefers-color-scheme matches native", media === before.value.dark, media);
  t.check("page bridge: theme.get", (await t.pageCall("theme", "get") as any).ok);
};
