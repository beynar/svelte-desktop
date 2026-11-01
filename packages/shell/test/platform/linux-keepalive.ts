// quitOnLastWindowClosed: false on Linux (run with HARNESS_WINDOW='{"quitOnLastWindowClosed":false}'):
// closing the last window hides it — the window, its page and the app live on — and showing it
// brings the same page back.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  t.check("visible at start", (await t.call("window", "isVisible", { windowId: 0 })).value === true);
  await t.call("webview", "executeJavaScript", { code: "window.__kept = 42" });
  t.check("close → ok", (await t.call("window", "close", { windowId: 0 })).ok);
  await t.sleep(300);
  t.check("the last window is hidden, not closed", (await t.call("window", "isVisible", { windowId: 0 })).value === false);
  t.check("still listed (not destroyed)", (await t.call("window", "list")).value?.length === 1);
  t.check("no closed event", !(t.events.get("closed") ?? []).length, t.events.get("closed"));
  t.check("the app still answers", (await t.call("app", "getName")).ok);
  t.check("show → ok", (await t.call("window", "show", { windowId: 0 })).ok);
  await t.sleep(300);
  t.check("visible again", (await t.call("window", "isVisible", { windowId: 0 })).value === true);
  t.check("the same page (state kept)", (await t.call("webview", "executeJavaScript", { code: "window.__kept" })).value === 42);
};
