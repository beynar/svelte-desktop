// Helper for linux-web-print.ts (not a suite of its own): ends with a print dialog open.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  t.check("the dialog is on its way", (await t.call("webview", "print")).value?.started === true);
  await t.sleep(800);
};
