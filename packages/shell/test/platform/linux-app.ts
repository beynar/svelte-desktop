// app.* on Linux (variant of app.ts: Dock / activation-policy checks are macOS-only).
import { homedir } from "node:os";
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const info = await t.call("app", "getInfo");
  t.check("getInfo shape (linux, unpackaged)", info.ok && info.value.platform === "linux" && ["arm64", "x64"].includes(info.value.arch) && info.value.identifier === "dev.svelte-desktop.harness" && info.value.packaged === false && info.value.appPath === null, info.value);
  t.check("getName = appName", (await t.call("app", "getName")).value === "Harness");
  t.check("getVersion", typeof (await t.call("app", "getVersion")).value === "string");
  for (const name of ["home", "appPath", "exe", "temp", "appData", "userData", "logs", "caches", "documents", "downloads", "desktop", "music", "pictures", "videos"]) {
    const r = await t.call("app", "getPath", { name });
    t.check(`getPath ${name}`, r.ok && typeof r.value === "string" && r.value.startsWith("/"), r.value);
  }
  const home = homedir();
  const xdg = async (name: string) => (await t.call("app", "getPath", { name })).value;
  t.check("XDG layout: userData = $XDG_DATA_HOME/<id>", (await xdg("userData")) === `${process.env.XDG_DATA_HOME ?? home + "/.local/share"}/dev.svelte-desktop.harness`);
  t.check("XDG layout: caches = $XDG_CACHE_HOME/<id>", (await xdg("caches")) === `${process.env.XDG_CACHE_HOME ?? home + "/.cache"}/dev.svelte-desktop.harness`);
  t.check("XDG layout: logs = $XDG_STATE_HOME/<id>/logs (same as src/os.ts)", (await xdg("logs")) === `${process.env.XDG_STATE_HOME ?? home + "/.local/state"}/dev.svelte-desktop.harness/logs`);
  t.check("exe is this process (/proc/self/exe)", (await xdg("exe")) === process.execPath, { exe: await xdg("exe"), execPath: process.execPath });
  t.check("getPath unknown → invalid_args", (await t.call("app", "getPath", { name: "nope" })).error?.code === "invalid_args");
  t.check("whenReady", (await t.call("app", "whenReady")).value === true);
  t.check("getBundleType binary (unpackaged)", (await t.call("app", "getBundleType")).value?.type === "binary");
  t.check("defaultWindowIcon null unpackaged", (await t.call("app", "defaultWindowIcon")).value === null);
  for (const op of ["setDockBadge", "bounceDock", "setDockProgress", "setActivationPolicy", "hideOthers", "showAll", "addRecentDocument"]) {
    const r = await t.call("app", op, {});
    t.check(`${op} → unsupported (macOS-only)`, r.error?.code === "unsupported", r.error);
  }
  const lock = await t.call("app", "requestSingleInstanceLock");
  t.check("requestSingleInstanceLock acquired", lock.value?.acquired === true, lock);
  t.check("requestSingleInstanceLock idempotent", (await t.call("app", "requestSingleInstanceLock")).value?.acquired === true);
  // A second process asking for the same lock: refused, and we get `secondInstance` with its argv/cwd.
  const second = t.waitEvent("secondInstance", 8000);
  // (a second harness process: its event sink lives in a Worker, like the real runtime's)
  const harness = new URL("../harness.ts", import.meta.url).pathname, helper = new URL("./_second-instance.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, harness, helper], { stdout: "pipe", stderr: "pipe", cwd: "/tmp" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  t.check("second process: acquired:false", out.includes('LOCK {"acquired":false}'), out.trim() || (await new Response(proc.stderr).text()).slice(-400));
  const ev = await second;
  t.check("secondInstance {argv, cwd} delivered to the holder", Array.isArray(ev?.argv) && ev.argv.some((a: string) => a.endsWith("_second-instance.ts")) && ev.cwd === "/tmp", ev);
  const login = await t.call("app", "setLoginItem", { enabled: false });
  t.check("setLoginItem unpackaged → unavailable", login.error?.code === "unavailable", login);
  t.check("setName", (await t.call("app", "setName", { name: "Harness Renamed" })).ok && (await t.call("app", "getName")).value === "Harness Renamed");
  t.check("setIdentity", (await t.call("app", "setIdentity", { identifier: "dev.svelte-desktop.harness2" })).ok && (await t.call("app", "getInfo")).value.identifier === "dev.svelte-desktop.harness2");
  await t.call("app", "setIdentity", { identifier: "dev.svelte-desktop.harness" });
  t.check("hide + show", (await t.call("app", "hide")).ok && !(await t.call("window", "isVisible")).value && (await t.call("app", "show")).ok);
  await t.sleep(300);
  t.check("visible again after app.show", (await t.call("window", "isVisible")).value === true);
  const page = await t.pageCall("app", "getInfo");
  t.check("page bridge: app.getInfo", (page as any).ok && (page as any).value.platform === "linux");
  t.check("aboutPanel (GtkAboutDialog)", (await t.call("app", "aboutPanel", { name: "Harness", version: "9.9", copyright: "(c) test" })).ok);
  t.skip("relaunch / quit / exit", "end the process (quit is exercised by every suite's teardown and the signal test)");
};
