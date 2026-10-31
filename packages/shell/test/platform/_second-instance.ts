// Helper for linux-app.ts (not a suite of its own): a second process asking for
// the harness app's single-instance lock.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  console.log("LOCK " + JSON.stringify((await t.call("app", "requestSingleInstanceLock")).value));
};
