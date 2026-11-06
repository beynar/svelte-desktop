// The app on the desktop: metrics from /proc, the recent list in its real file, the launcher entry as a real
// signal on the session bus, the windows' state read back from the X server under openbox, real bookmarks over
// real renames, GNOME's previewer played by test/docker/fake-portal.c.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const run = (...args: string[]) => Bun.spawnSync(args).stdout.toString().trim();
const xdotool = (...args: string[]) => run("xdotool", ...args);
const prop = (id: string, name: string) => run("xprop", "-id", id, name);

export default async (t: Harness) => {
  const app = (op: string, args: Record<string, unknown> = {}) => t.call("app", op, args);
  const until = async (ok: () => unknown, ms = 4000) => {
    for (let i = 0; i < ms / 50; i++) {
      if (await ok()) return true;
      await t.sleep(50);
    }
    return false;
  };

  // ---- metrics --------------------------------------------------------------------------
  const child = Bun.spawn(["sleep", "60"]);
  const spinner = Bun.spawn(["sh", "-c", "while :; do :; done"]);
  await t.page("window.__big = new Array(3000000).fill(1.5); return window.__big.length");
  const m1 = await app("metrics");
  const main = m1.value?.processes.find((p: any) => p.pid === process.pid);
  t.check("metrics: this process is `main`", main?.type === "main" && main.name === "bun", main);
  const vm = Number(readFileSync("/proc/self/status", "utf8").match(/VmRSS:\s+(\d+)/)?.[1]) * 1024;
  t.check("metrics: its resident size is /proc's", Math.abs(main.memory.resident - vm) < 64 * 1024 * 1024 && main.memory.footprint > 0 && main.memory.footprint <= main.memory.resident + 64 * 1024 * 1024, { main: main.memory, vm });
  t.check("metrics: CPU time, percent null the first time", main.cpu.time > 0 && main.cpu.percent === null, main.cpu);
  const web = m1.value.processes.filter((p: any) => p.type === "webview");
  t.check("metrics: the web process, by name, its memory real", web.length >= 1 && web[0].name.startsWith("WebKitWebProcess") && web[0].memory.footprint > 20 * 1024 * 1024, web);
  const webPids = new Set(run("pgrep", "-P", String(process.pid), "WebKitWebProces").split("\n").filter(Boolean).map(Number));
  t.check("metrics: those are its children per the OS", web.every((p: any) => webPids.has(p.pid)), { web: web.map((p: any) => p.pid), webPids: [...webPids] });
  t.check("metrics: what it started", m1.value.processes.find((p: any) => p.pid === child.pid)?.type === "child", m1.value.processes.map((p: any) => [p.pid, p.type, p.name]));
  t.check("metrics: total footprint is their sum", m1.value.memory.footprint === m1.value.processes.reduce((n: number, p: any) => n + p.memory.footprint, 0), m1.value.memory);
  await t.sleep(600);
  const m2 = await app("metrics");
  const busy = m2.value.processes.find((p: any) => p.pid === spinner.pid);
  t.check("metrics: a second call has percentages, a spinning process near a core", busy?.cpu.percent > 40 && busy.cpu.percent < 150, busy?.cpu);
  child.kill();
  spinner.kill();
  await child.exited;
  await spinner.exited;
  await t.sleep(50);
  t.check("metrics: a process gone is gone", !(await app("metrics")).value.processes.some((p: any) => p.pid === child.pid));

  // ---- recent documents, in the file every GTK app reads --------------------------------
  const xbel = `${process.env.XDG_DATA_HOME ?? process.env.HOME + "/.local/share"}/recently-used.xbel`;
  const read = () => {
    try {
      return readFileSync(xbel, "utf8");
    } catch {
      return "";
    }
  };
  writeFileSync(`/tmp/kitop-recent-a.txt`, "a");
  rmSync(xbel, { force: true });
  await t.sleep(300);
  t.check("addRecentDocument needs a path", (await app("addRecentDocument")).error?.code === "invalid_args");
  t.check("… an absolute one", (await app("addRecentDocument", { path: "relative.txt" })).error?.code === "invalid_args");
  t.check("addRecentDocument → null", (await app("addRecentDocument", { path: "/tmp/kitop-recent-a.txt" })).value === null);
  t.check("… in the user's recently-used.xbel, under this app", await until(() => read().includes("file:///tmp/kitop-recent-a.txt") && read().includes('name="Harness"')), read().slice(0, 600));
  // Another app's entry, as another app would write it: not this app's to clear.
  const today = new Date().toISOString().replace(/\.\d+Z/, "Z"); // GTK drops what's older than 30 days
  const foreign = `<bookmark href="file:///tmp/other-app.txt" added="${today}" modified="${today}" visited="${today}"><info><metadata owner="http://freedesktop.org"><mime:mime-type type="text/plain"/><bookmark:applications><bookmark:application name="Other" exec="other %u" modified="${today}" count="1"/></bookmark:applications></metadata></info></bookmark>`;
  writeFileSync(xbel, read().replace("</xbel>", `${foreign}\n</xbel>`));
  await t.sleep(1200); // GTK sees the file change
  t.check("clearRecentDocuments → null", (await app("clearRecentDocuments")).value === null);
  t.check("… this app's are gone", await until(() => !read().includes("kitop-recent-a.txt")), read().slice(0, 600));
  t.check("… another app's stays", read().includes("other-app.txt"), read().slice(0, 1500).replaceAll("\n", " "));

  // ---- badge and progress: the real signal ----------------------------------------------
  const monitor = Bun.spawn(["dbus-monitor", "--session", "interface='com.canonical.Unity.LauncherEntry'"], { stdout: "pipe", stderr: "ignore" });
  let bus = "";
  void (async () => {
    const reader = monitor.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      bus += new TextDecoder().decode(value);
    }
  })();
  await t.sleep(400);
  const signal = async (test: (text: string) => boolean) => {
    const seen = await until(() => test(bus), 2000);
    const text = bus;
    bus = "";
    return seen ? text : `(not seen) ${text}`;
  };
  const props = (name: string, type: string, value: string) => (s: string) => new RegExp(`string "${name}"\\s+variant\\s+${type} ${value}`).test(s);
  t.check("setDockBadge '7' → true", (await app("setDockBadge", { text: "7" })).value === true);
  let seen = await signal(props("count", "int64", "7"));
  t.check("… LauncherEntry.Update for this app: count 7, visible", seen.includes("application://dev.kitop.harness.desktop") && props("count-visible", "boolean", "true")(seen), seen);
  t.check("getDockBadge → '7'", (await app("getDockBadge")).value === "7");
  t.check("… the same badge as notifications.getBadge", (await t.call("notifications", "getBadge")).value === 7);
  t.check("a badge that isn't a number can't be shown: false", (await app("setDockBadge", { text: "New" })).value === false);
  seen = await signal(props("count-visible", "boolean", "false"));
  t.check("… and the number goes", props("count-visible", "boolean", "false")(seen) && (await app("getDockBadge")).value === null, seen);
  await app("setDockBadge", { text: "3" });
  await signal(props("count", "int64", "3"));
  t.check("setDockBadge null → true", (await app("setDockBadge", { text: null })).value === true);
  seen = await signal(props("count-visible", "boolean", "false"));
  t.check("… hidden, getDockBadge null", props("count-visible", "boolean", "false")(seen) && (await app("getDockBadge")).value === null, seen);
  t.check("getDockProgress at first → none", (await app("getDockProgress")).value?.status === "none");
  t.check("setDockProgress → null", (await app("setDockProgress", { status: "normal", completed: 1, total: 4 })).value === null);
  seen = await signal(props("progress", "double", "0.25"));
  t.check("… progress 0.25, visible", props("progress-visible", "boolean", "true")(seen), seen);
  const progress = (await app("getDockProgress")).value;
  t.check("getDockProgress → what was set", progress?.status === "normal" && progress.completed === 1 && progress.total === 4, progress);
  await app("setDockProgress", { status: "indeterminate" });
  t.check("indeterminate: full, as macOS draws it", props("progress", "double", "1")(await signal(props("progress", "double", "1"))) && (await app("getDockProgress")).value?.status === "indeterminate");
  await app("setDockProgress", { status: "error", completed: 3, total: 4 });
  t.check("error: its fraction", (await signal(props("progress", "double", "0.75"))).includes("0.75") && (await app("getDockProgress")).value?.status === "error");
  await app("setDockProgress", { status: "none" });
  seen = await signal(props("progress-visible", "boolean", "false"));
  t.check("none: hidden", props("progress-visible", "boolean", "false")(seen) && (await app("getDockProgress")).value?.status === "none", seen);
  monitor.kill();

  // ---- the windows, read back from the X server --------------------------------------------
  const win = xdotool("search", "--onlyvisible", "--name", "^platform harness$").split("\n").pop()!;
  const state = () => prop(win, "_NET_WM_STATE");
  await t.call("window", "focus");
  await t.sleep(300);
  // bounceDock
  t.check("bounceDock with the app in front: nothing to ask", (await app("bounceDock", { type: "informational" })).value === true && !state().includes("DEMANDS_ATTENTION"), state());
  const other = Bun.spawn(["/tmp/fake-drag", "file:///tmp/x"], { stdout: "ignore", stderr: "ignore" });
  let otherWin = "";
  await until(() => (otherWin = xdotool("search", "--onlyvisible", "--name", "^fake-drag$").split("\n").pop()!));
  xdotool("windowactivate", "--sync", otherWin);
  await t.sleep(300);
  t.check("another program in front", (await t.call("window", "isFocused")).value !== true);
  t.check("bounceDock critical → true", (await app("bounceDock", { type: "critical" })).value === true);
  t.check("… the X urgency hint on its window", await until(() => prop(win, "WM_HINTS").toLowerCase().includes("urgent") || state().includes("_NET_WM_STATE_DEMANDS_ATTENTION")), { hints: prop(win, "WM_HINTS"), state: state() });
  t.check("… _NET_WM_STATE_DEMANDS_ATTENTION from the window manager", state().includes("_NET_WM_STATE_DEMANDS_ATTENTION"), state());
  await t.call("window", "focus");
  t.check("coming to the window answers it", await until(() => !state().includes("DEMANDS_ATTENTION") && !prop(win, "WM_HINTS").toLowerCase().includes("urgent")), { hints: prop(win, "WM_HINTS"), state: state() });
  other.kill();
  // Icons. The picture's pixels are in _NET_WM_ICON: width, height, then ARGB.
  const RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const icon = "/tmp/kitop-icon-red.png";
  writeFileSync(icon, Buffer.from(RED, "base64"));
  const wmIcon = () => run("xprop", "-id", win, "-notype", "32c", "_NET_WM_ICON");
  const generic = wmIcon(); // GTK's own, without one from the app
  t.check("getDockIcon at first → null", (await app("getDockIcon")).value === null);
  t.check("setDockIcon → null", (await app("setDockIcon", { icon: { path: icon } })).value === null);
  t.check("… in _NET_WM_ICON: its size and its pixel", await until(() => /= 1, 1, /.test(wmIcon())), wmIcon());
  t.check("getDockIcon → what was set", (await app("getDockIcon")).value?.path === icon);
  t.check("setIcon does the same, with a theme icon's name", (await app("setIcon", { icon: "folder" })).ok && (await until(() => /= (16|22|24|32|48|64|96|128), /.test(wmIcon()))), wmIcon().slice(0, 100));
  t.check("a file that isn't there → invalid_args", (await app("setDockIcon", { icon: { path: "/nope.png" } })).error?.code === "invalid_args");
  t.check("an icon no theme has → invalid_args", (await app("setDockIcon", { icon: "no-such-icon-anywhere" })).error?.code === "invalid_args");
  t.check("… what was set stays", (await app("getDockIcon")).value === "folder");
  t.check("null: back to what it was", (await app("setDockIcon", { icon: null })).value === null && (await until(() => wmIcon() === generic)) && (await app("getDockIcon")).value === null, wmIcon().slice(0, 100));
  // Activation policy.
  t.check("getActivationPolicy at first → regular", (await app("getActivationPolicy")).value === "regular");
  t.check("an unknown policy → invalid_args", (await app("setActivationPolicy", { policy: "sideways" })).error?.code === "invalid_args");
  t.check("prohibited can't be done: false, nothing changes", (await app("setActivationPolicy", { policy: "prohibited" })).value === false && (await app("getActivationPolicy")).value === "regular");
  t.check("accessory → true", (await app("setActivationPolicy", { policy: "accessory" })).value === true && (await app("getActivationPolicy")).value === "accessory");
  t.check("… skip-taskbar and skip-pager in _NET_WM_STATE", await until(() => state().includes("_NET_WM_STATE_SKIP_TASKBAR") && state().includes("_NET_WM_STATE_SKIP_PAGER")), state());
  const later = (await t.call("window", "create", { label: "later", width: 200, height: 150, title: "later window" })).value;
  let laterWin = "";
  await until(() => (laterWin = xdotool("search", "--onlyvisible", "--name", "^later window$").split("\n").pop()!));
  t.check("… a window opened later too", await until(() => prop(laterWin, "_NET_WM_STATE").includes("_NET_WM_STATE_SKIP_TASKBAR")), prop(laterWin, "_NET_WM_STATE"));
  await t.call("window", "close", { windowId: later.windowId, force: true });
  await app("setActivationPolicy", { policy: "regular" });
  t.check("regular: back in the taskbar", await until(() => !state().includes("SKIP_TASKBAR") && !state().includes("SKIP_PAGER")), state());
  // showAll: the app's windows that app.hide took away.
  await app("hide");
  await t.sleep(200);
  t.check("app.hide takes the window off the screen", (await t.call("window", "isVisible")).value === false && !xdotool("search", "--onlyvisible", "--name", "^platform harness$"));
  t.check("showAll → null", (await app("showAll")).value === null);
  t.check("… and it's back on the screen", await until(() => xdotool("search", "--onlyvisible", "--name", "^platform harness$")));
  await t.call("window", "focus");

  // ---- bookmarks, over real renames -----------------------------------------------------
  const dir = `/tmp/kitop-bookmarks-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/a.txt`;
  writeFileSync(file, "a");
  const bm = async (path: string) => (await t.call("files", "createBookmark", { path })).value?.bookmark as string;
  const open = (bookmark: unknown) => t.call("files", "openBookmark", { bookmark });
  t.check("createBookmark: a relative path → invalid_args", (await t.call("files", "createBookmark", { path: "a.txt" })).error?.code === "invalid_args");
  t.check("createBookmark: a missing file → unavailable", (await t.call("files", "createBookmark", { path: `${dir}/nope` })).error?.code === "unavailable");
  t.check("openBookmark: not a bookmark → invalid_args", (await open("!!")).error?.code === "invalid_args" && (await open(Buffer.from("{}").toString("base64"))).error?.code === "invalid_args");
  const home = await t.call("files", "createBookmark", { path: "~/" });
  t.check("createBookmark: ~/ is the home folder", home.ok, home);
  const b = await bm(file);
  let o = await open(b);
  t.check("openBookmark: unchanged, not stale", o.ok && o.value.path === file && o.value.stale === false && typeof o.value.id === "string", o);
  t.check("releaseBookmark → null, twice over", (await t.call("files", "releaseBookmark", { id: o.value.id })).value === null && (await t.call("files", "releaseBookmark", { id: o.value.id })).value === null);
  writeFileSync(file, "edited in place");
  t.check("edited in place: it's the same file, not stale", (await open(b)).value?.stale === false);
  renameSync(file, `${dir}/renamed.txt`);
  o = await open(b);
  t.check("renamed in its folder: stale, and found under its new name", o.value?.stale === true && o.value.path === `${dir}/renamed.txt`, o);
  writeFileSync(file, "another file in its place");
  o = await open(b);
  t.check("another file now at the old path: still the moved one", o.value?.stale === true && o.value.path === `${dir}/renamed.txt`, o);
  rmSync(`${dir}/renamed.txt`);
  o = await open(b);
  t.check("the original gone, something else in its place: stale, that path", o.value?.stale === true && o.value.path === file && statSync(file).size > 0, o);
  rmSync(file);
  t.check("nothing left there → unavailable", (await open(b)).error?.code === "unavailable");
  mkdirSync(`${dir}/sub`);
  writeFileSync(`${dir}/sub/c.txt`, "c");
  const c = await bm(`${dir}/sub/c.txt`);
  renameSync(`${dir}/sub/c.txt`, `${dir}/c.txt`);
  t.check("moved to another folder: it can't be found → unavailable", (await open(c)).error?.code === "unavailable");
  rmSync(dir, { recursive: true });

  // ---- GNOME's previewer -----------------------------------------------------------------
  const preview = "/tmp/kitop-preview.txt";
  writeFileSync(preview, "p");
  t.check("previewFile: no paths → invalid_args", (await t.call("shell", "previewFile", {})).error?.code === "invalid_args");
  t.check("previewFile: a missing file → invalid_args", (await t.call("shell", "previewFile", { paths: "/nope" })).error?.code === "invalid_args");
  t.check("previewFile without GNOME's previewer → unavailable", (await t.call("shell", "previewFile", { paths: preview })).error?.code === "unavailable");
  const log = "/tmp/fake-previewer.log";
  rmSync(log, { force: true });
  const previewer = Bun.spawn(["/tmp/fake-portal", "--previewer"], { env: { ...process.env, FAKE_PORTAL_LOG: log }, stdout: "ignore", stderr: "ignore" });
  await t.sleep(400);
  const shown = await t.call("shell", "previewFile", { paths: [preview] });
  t.check("previewFile: ShowFile answers → null", shown.ok && shown.value === null, shown);
  const called = readFileSync(log, "utf8");
  t.check("… with the file's URI, this window's XID, not as a toggle", called.includes("ShowFile") && called.includes(`file://${preview}`) && called.includes(String(Number(win))) && called.includes("false"), called);
  previewer.kill();
};
