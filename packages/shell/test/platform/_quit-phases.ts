// Helper for linux-quit.ts (not a suite of its own): a real quit from guards through the process's end.
// QUIT_MODE=delay: the guard takes its time, then allows it. timeout: the guard never answers. It says
// what happens on stdout, the process ends by itself.
import { deliverPlatformEvent, initPlatformForTests } from "../../src/platform/bus.ts";
import { appLifecycle } from "../../src/platform/app-lifecycle.ts";
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  initPlatformForTests({
    platformCall(request) {
      const { id, service, op, args } = JSON.parse(request);
      void t.call(service, op, args).then((r) => deliverPlatformEvent("platformResult", { ...r, id }));
      return JSON.stringify({ pending: true });
    },
  });
  t.onEvent((name, data) => deliverPlatformEvent(name, data));
  const start = Date.now();
  const say = (what: string, extra: unknown = null) => console.log(`QUIT ${JSON.stringify({ what, at: Date.now() - start, extra })}`);
  t.onEvent((name, data) => {
    deliverPlatformEvent(name, data);
    if (name === "quitTimedOut") say("quitTimedOut", data);
  });
  const mode = process.env.QUIT_MODE;
  appLifecycle.onQuitRequested(async (request) => {
    say("quitRequested", request);
    if (mode === "timeout") await new Promise(() => {});
    await t.sleep(1500);
    say("allowed", { page: await t.page("return 1 + 1") });
    return "quit";
  });
  appLifecycle.onBeforeQuit(async (request) => {
    say("beforeQuit", request);
    await t.sleep(300);
    say("beforeQuit done", (await t.call("window", "isVisible")).value);
  });
  appLifecycle.onWillQuit(async (request) => {
    say("willQuit", request);
    await t.sleep(300);
    say("willQuit done", null);
  });
  await t.sleep(100);
  await t.call("app", "quit");
  say("asked");
  await new Promise(() => {}); // the process ends under this
};
