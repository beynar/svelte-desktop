import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const info = await t.call("app", "getInfo");
  t.check("getInfo shape", info.ok && info.value.platform === "darwin" && typeof info.value.identifier === "string" && info.value.packaged === false, info.value);
  t.check("getName", (await t.call("app", "getName")).ok);
  t.check("getVersion", typeof (await t.call("app", "getVersion")).value === "string");
  for (const name of ["home", "appPath", "exe", "temp", "appData", "userData", "logs", "caches", "documents", "downloads", "desktop", "music", "pictures", "videos"]) {
    const r = await t.call("app", "getPath", { name });
    t.check(`getPath ${name}`, r.ok && typeof r.value === "string" && r.value.startsWith("/"), r.value);
  }
  t.check("getPath unknown → invalid_args", (await t.call("app", "getPath", { name: "nope" })).error?.code === "invalid_args");
  t.check("whenReady", (await t.call("app", "whenReady")).value === true);
  t.check("getBundleType binary (unbundled)", (await t.call("app", "getBundleType")).value?.type === "binary");
  t.check("defaultWindowIcon null unbundled", (await t.call("app", "defaultWindowIcon")).ok);
  t.check("setDockBadge", (await t.call("app", "setDockBadge", { text: "3" })).value === true);
  t.check("setDockBadge clear", (await t.call("app", "setDockBadge", { text: null })).ok);
  t.check("setDockProgress normal", (await t.call("app", "setDockProgress", { status: "normal", completed: 3, total: 10 })).ok);
  t.check("setDockProgress indeterminate", (await t.call("app", "setDockProgress", { status: "indeterminate" })).ok);
  t.check("setDockProgress none", (await t.call("app", "setDockProgress", { status: "none" })).ok);
  t.check("setActivationPolicy regular", (await t.call("app", "setActivationPolicy", { policy: "regular" })).ok);
  t.check("setActivationPolicy bad → invalid_args", (await t.call("app", "setActivationPolicy", { policy: "x" })).error?.code === "invalid_args");
  const lock = await t.call("app", "requestSingleInstanceLock");
  t.check("requestSingleInstanceLock acquired", lock.value?.acquired === true, lock);
  t.check("requestSingleInstanceLock idempotent", (await t.call("app", "requestSingleInstanceLock")).value?.acquired === true);
  const login = await t.call("app", "setLoginItem", { enabled: false });
  t.check("setLoginItem unbundled → unavailable", login.error?.code === "unavailable", login);
  t.check("setName", (await t.call("app", "setName", { name: "Harness Renamed" })).ok && (await t.call("app", "getName")).value === "Harness Renamed");
  t.check("bounceDock", (await t.call("app", "bounceDock", { type: "informational" })).value === true);
  const page = await t.pageCall("app", "getInfo");
  t.check("page bridge: app.getInfo", (page as any).ok && (page as any).value.platform === "darwin");
  t.skip("aboutPanel / addRecentDocument / relaunch / quit / exit / hide", "visible side effects or end the process");
};
