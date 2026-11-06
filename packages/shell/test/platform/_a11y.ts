// Helper for linux-extra.ts (not a suite of its own): what this process's GTK settings make of accessibility.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const a11y = (await t.call("system", "getAccessibility")).value;
  const media = await t.page("return matchMedia('(prefers-reduced-motion: reduce)').matches");
  console.log(`A11Y ${JSON.stringify({ ...a11y, media })}`);
};
