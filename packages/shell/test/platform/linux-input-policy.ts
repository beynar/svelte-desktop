// Input policy on GTK: real X11 key events (xdotool), under Xvfb + openbox. A rule keeps a key from the
// page and the menus, and menuShortcuts false keeps accelerators from running with the key still reaching the page.
import type { Harness } from "../harness-worker.ts";

const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]);

export default async (t: Harness) => {
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  await t.page(`window.__keys = []; addEventListener("keydown", (e) => __keys.push(e.key + (e.ctrlKey ? "+ctrl" : "") + (e.shiftKey ? "+shift" : "")), true); addEventListener("keyup", (e) => __keys.push("up:" + e.key), true); return 1`);
  const keys = () => t.page<string[]>(`const k = __keys.splice(0); return k`);
  const press = async (combo: string) => {
    xdotool("key", "--clearmodifiers", combo);
    await t.sleep(250);
  };
  await t.call("window", "focus");
  await t.sleep(300);

  const initial = await wv("getInputPolicy");
  t.check("getInputPolicy: nothing set", initial.value?.monitorInstalled === true && initial.value.intercept.length === 0 && initial.value.menuShortcuts === true, initial);
  await press("x");
  t.check("(without a policy the page gets the key)", (await keys()).includes("x"));

  for (const args of [{ intercept: 3 }, { menuShortcuts: "no" }, { intercept: [3] }, { intercept: [{ key: "" }] }, { intercept: [{ key: "k", modifiers: "shift" }] }, { intercept: [{ key: "k", modifiers: ["hyper"] }] }])
    t.check(`setInputPolicy ${JSON.stringify(args)} → invalid_args`, (await wv("setInputPolicy", args)).error?.code === "invalid_args");
  t.check("an unknown window → unavailable", (await wv("setInputPolicy", { windowId: 999 })).error?.code === "unavailable" && (await wv("getInputPolicy", { windowId: 999 })).error?.code === "unavailable");
  t.check("(a refused policy changes nothing)", (await wv("getInputPolicy")).value.intercept.length === 0);

  // ---- a rule ------------------------------------------------------------------------------
  const set = await wv("setInputPolicy", { intercept: [{ key: "k", modifiers: ["control", "shift"] }, { key: "Escape" }, { key: "j", modifiers: ["control"] }] });
  t.check("setInputPolicy", set.value?.monitorInstalled === true && set.value.interceptCount === 3 && set.value.menuShortcuts === true, set);
  const got = (await wv("getInputPolicy")).value;
  t.check("getInputPolicy: as set", got.intercept.length === 3 && got.intercept[0].key === "k" && JSON.stringify(got.intercept[0].modifiers) === JSON.stringify(["control", "shift"]) && JSON.stringify(got.intercept[1].modifiers) === "[]", got);
  const events = () => t.events.get("beforeInput") ?? [];
  await t.page(`window.__seen = []; window.__shell.setSink((n, d) => { if (n === "beforeInput") __seen.push(d); if (n === "platformResult") { pending.get(d.id)?.(d); pending.delete(d.id); } }); return 1`);
  await press("ctrl+shift+k");
  const down = events().find((e) => e.type === "keyDown");
  t.check("beforeInput: keyDown", down?.windowId === 0 && down.key === "k" && down.isAutoRepeat === false && down.intercepted === true && JSON.stringify(down.modifiers) === JSON.stringify(["control", "shift"]) && typeof down.keyCode === "number" && down.keyCode > 0, events());
  t.check("the page doesn't get it", !(await keys()).some((k) => k.toLowerCase().startsWith("k")));
  // Modifiers must match exactly.
  await press("ctrl+k");
  t.check("other modifiers: the page gets it", (await keys()).some((k) => k.startsWith("k")));
  await press("k");
  t.check("no modifier: the page gets it", (await keys()).includes("k"));
  t.check("…no event for those", events().filter((e) => e.key === "k" && e.type === "keyDown").length === 1);
  await press("Escape");
  t.check("a named key, no modifier", events().some((e) => e.key === "Escape" && e.type === "keyDown") && !(await keys()).includes("Escape"));
  t.check("a key's release is intercepted too, keyUp", events().some((e) => e.key === "Escape" && e.type === "keyUp"), events());
  const inPage = (await t.page(`return __seen`)) as any[];
  t.check("the page hears beforeInput, marked as its own window's", inPage.some((e) => e.key === "k" && e.target === true), inPage);
  t.check("…the Worker's has no target", !("target" in (down ?? {})));

  // Auto-repeat: held down, X11 sends more presses.
  const count = events().filter((e) => e.key === "j" && e.type === "keyDown").length;
  xdotool("keydown", "ctrl");
  xdotool("keydown", "j");
  await t.sleep(900);
  xdotool("keyup", "j");
  xdotool("keyup", "ctrl");
  await t.sleep(200);
  const held = events().filter((e) => e.key === "j" && e.type === "keyDown").slice(count);
  t.check("…its release, with the modifiers still down, keyUp", events().some((e) => e.key === "j" && e.type === "keyUp"), events());
  if (held.length > 1) t.check("held down: isAutoRepeat after the first", held[0].isAutoRepeat === false && held[1].isAutoRepeat === true, held);
  else t.skip("held down: isAutoRepeat", "this X server sent no auto-repeat");

  // ---- menus ------------------------------------------------------------------------------
  await t.call("menu", "setAppMenu", { menus: [{ name: "File", items: [{ label: "Hello", id: "hello", accelerator: "Ctrl+Shift+Y" }, { label: "Rule", id: "ruled", accelerator: "Ctrl+Shift+K" }] }] });
  await t.sleep(200);
  const menus = () => (t.events.get("menuAction") ?? []).map((e) => e.id);
  await press("ctrl+shift+y");
  t.check("menuShortcuts default: the accelerator runs", menus().includes("hello"), menus());
  await keys();
  await press("ctrl+shift+k");
  t.check("a rule comes before the menu", !menus().includes("ruled"), menus());
  const before = menus().length;
  t.check("menuShortcuts false", (await wv("setInputPolicy", { menuShortcuts: false, intercept: [{ key: "q" }] })).value?.menuShortcuts === false);
  await press("ctrl+shift+y");
  t.check("…the accelerator doesn't run", menus().length === before, menus());
  t.check("…the page gets the key instead", (await keys()).some((k) => k.toLowerCase().startsWith("y")));
  await press("q");
  t.check("…rules still hold", events().some((e) => e.key === "q" && e.type === "keyDown") && !(await keys()).includes("q"));
  await press("w");
  t.check("…other keys reach the page, down and up", (await keys()).join().includes("w,up:w"));
  t.check("replaced, not merged", (await wv("getInputPolicy")).value.intercept.length === 1 && (await wv("getInputPolicy")).value.intercept[0].key === "q");
  t.check("menuShortcuts back on", (await wv("setInputPolicy", {})).value?.menuShortcuts === true);
  await press("ctrl+shift+y");
  t.check("…the accelerator runs", menus().length === before + 1, menus());
  await keys();
  await press("q");
  t.check("…the rule is gone", (await keys()).includes("q"));

  // ---- per window ---------------------------------------------------------------------------
  const other = await t.call("window", "create", { html: "<!doctype html><title>second</title><body>second", width: 300, height: 200 });
  const id = other.value?.windowId;
  await t.sleep(300);
  await wv("setInputPolicy", { windowId: id, intercept: [{ key: "z" }] });
  t.check("a window's own", (await wv("getInputPolicy", { windowId: id })).value.intercept.length === 1 && (await wv("getInputPolicy", { windowId: 0 })).value.intercept.length === 0);
  await t.call("window", "focus", { windowId: id });
  await t.sleep(400);
  await press("z");
  const forSecond = events().filter((e) => e.key === "z" && e.type === "keyDown").at(-1);
  t.check("beforeInput names that window", forSecond?.windowId === id, events());
  const inMain = (await t.page(`return __seen.filter((e) => e.key === "z")`)) as any[];
  t.check("…for another window's page, target false", inMain.length > 0 && inMain.every((e) => e.target === false), inMain);
  await t.call("window", "close", { windowId: id });
  await t.sleep(200);
  t.check("it ends with its window", (await wv("getInputPolicy", { windowId: id })).error?.code === "unavailable");
  await t.call("menu", "setAppMenu", { menus: null });
};
