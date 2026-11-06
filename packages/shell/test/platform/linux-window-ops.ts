// The window operations that have a meaning on X11, read back from the X server and driven with the real
// pointer under openbox: xprop, xwininfo, xdotool, XFixes for the cursor. Nothing here trusts a getter alone.
import type { Harness } from "../harness-worker.ts";

const run = (...args: string[]) => Bun.spawnSync(args).stdout.toString().trim();
const xdotool = (...args: string[]) => run("xdotool", ...args);
const prop = (id: string, name: string) => run("xprop", "-id", id, name);
const near = (a: number, b: number, by = 3) => Math.abs(a - b) <= by;
// xwininfo, not xdotool: xdotool counts the title bar twice under a reparenting window manager.
const client = (id: string) => {
  const info = run("xwininfo", "-id", id), n = (label: string) => Number(info.match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1]);
  return { x: n("Absolute upper-left X"), y: n("Absolute upper-left Y"), width: n("Width"), height: n("Height") };
};
const page = (body = "") => `<!doctype html><body style="margin:0;height:100vh">${body}`;

const CURSOR_C = `
#include <X11/Xlib.h>
#include <X11/extensions/Xfixes.h>
#include <stdio.h>
int main(void) {
  Display *d = XOpenDisplay(NULL);
  XFixesCursorImage *c = XFixesGetCursorImage(d);
  int painted = 0;
  for (int i = 0; i < c->width * c->height; i++) if ((c->pixels[i] >> 24) & 0xff) painted++;
  printf("%d\\n", painted);
  return 0;
}`;

export default async (t: Harness) => {
  const until = async (f: () => unknown, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await t.sleep(30)) if (f()) return true;
    return !!f();
  };
  const findWin = async (title: string) => {
    let id = "";
    await until(() => (id = xdotool("search", "--onlyvisible", "--name", `^${title.replace(/[•]/g, ".")}$`).split("\n").pop()!));
    return id;
  };
  await t.call("window", "setTitle", { title: "ops main" });
  const main = await findWin("ops main");
  t.check("the main window is on the X server", main, main);
  const bounds = async (windowId = 0) => (await t.call("window", "getBounds", { windowId })).value.bounds;
  const drag = async (fromX: number, fromY: number, toX: number, toY: number) => {
    xdotool("mousemove", String(fromX), String(fromY));
    await t.sleep(150);
    xdotool("mousedown", "1");
    await t.sleep(150);
    for (let i = 1; i <= 8; i++) {
      xdotool("mousemove", String(fromX + ((toX - fromX) * i) / 8), String(fromY + ((toY - fromY) * i) / 8));
      await t.sleep(30);
    }
    await t.sleep(150);
    xdotool("mouseup", "1");
    await t.sleep(300);
  };
  const dragCorner = async (byX: number, byY: number) => {
    const f = await bounds();
    await drag(f.x + f.width - 2, f.y + f.height - 2, f.x + f.width - 2 + byX, f.y + f.height - 2 + byY);
  };
  await t.call("window", "focus");
  await t.call("window", "setBounds", { x: 200, y: 100, width: 800, height: 500 });

  // ── aspect ratio ────────────────────────────────────────────────────
  t.check("getAspectRatio: free at first", (await t.call("window", "getAspectRatio")).value === null);
  t.check("setAspectRatio", (await t.call("window", "setAspectRatio", { ratio: 2 })).ok);
  t.check("getAspectRatio", (await t.call("window", "getAspectRatio")).value === 2);
  t.check("WM_NORMAL_HINTS carries it", /aspect/.test(prop(main, "WM_NORMAL_HINTS")), prop(main, "WM_NORMAL_HINTS"));
  await dragCorner(180, 20);
  const kept = client(main);
  t.check("a real resize keeps it", near(kept.width / kept.height, 2, 0.03) && kept.width > 300, kept);
  await t.call("window", "setMinSize", { width: 200, height: 100 });
  await t.sleep(200);
  t.check("setMinSize keeps the hint", /aspect/.test(prop(main, "WM_NORMAL_HINTS")), prop(main, "WM_NORMAL_HINTS"));
  await t.call("window", "setMinSize", { width: 0, height: 0 });
  await t.call("window", "setAspectRatio", { ratio: 0 });
  t.check("freed: null, and no hint", (await t.call("window", "getAspectRatio")).value === null && (await until(() => !/aspect/.test(prop(main, "WM_NORMAL_HINTS")))), prop(main, "WM_NORMAL_HINTS"));
  await t.call("window", "setSize", { width: 700, height: 500 });
  await t.sleep(200);
  await dragCorner(100, -80);
  const free = client(main);
  t.check("freed: a real resize goes where it's dragged", near(free.width, 800, 8) && near(free.height, 420, 8), free);

  // ── parent and children ─────────────────────────────────────────────
  const a = (await t.call("window", "create", { label: "ops-a", title: "ops a", html: page(), width: 420, height: 300, x: 300, y: 200, hiddenUntilReady: false, parentId: 0 })).value.windowId;
  const aWin = await findWin("ops a");
  t.check("parentId at creation: transient for it on the server", prop(aWin, "WM_TRANSIENT_FOR").includes(`0x${Number(main).toString(16)}`), prop(aWin, "WM_TRANSIENT_FOR"));
  t.check("getParent → the parent's row", (await t.call("window", "getParent", { windowId: a })).value?.windowId === 0);
  t.check("the row says so", (await t.call("window", "getInfo", { windowId: a })).value.parentId === 0 && (await t.call("window", "getInfo", { windowId: 0 })).value.parentId === null);
  t.check("getChildren → it", (await t.call("window", "getChildren", { windowId: 0 })).value.map((w: any) => w.windowId).join() === String(a));
  t.check("a cycle → invalid_args", (await t.call("window", "setParent", { windowId: 0, parentId: a })).error?.code === "invalid_args");
  t.check("no such parent → invalid_args", (await t.call("window", "setParent", { windowId: a, parentId: 999 })).error?.code === "invalid_args");
  t.check("no parentId → invalid_args", (await t.call("window", "setParent", { windowId: a })).error?.code === "invalid_args");
  t.check("create with no such parent → invalid_args", (await t.call("window", "create", { label: "ops-none", parentId: 999 })).error?.code === "invalid_args");
  t.check("setParent(null) detaches on the server", (await t.call("window", "setParent", { windowId: a, parentId: null })).ok && !prop(aWin, "WM_TRANSIENT_FOR").includes("0x") && (await t.call("window", "getParent", { windowId: a })).value === null);
  t.check("setParent again", (await t.call("window", "setParent", { windowId: a, parentId: 0 })).ok && prop(aWin, "WM_TRANSIENT_FOR").includes(`0x${Number(main).toString(16)}`));
  const b = (await t.call("window", "create", { label: "ops-b", title: "ops b", html: page(), width: 300, height: 200, hiddenUntilReady: false, parentId: a })).value.windowId;
  const bWin = await findWin("ops b");
  const closing = t.waitEvent("closed");
  await t.call("window", "close", { windowId: a });
  t.check("closing a parent closes its child, on the server too", (await closing) !== null && (await until(() => !xdotool("search", "--onlyvisible", "--name", "^ops b$"))) && (await t.call("window", "list")).value.length === 1, { bWin, b });

  // ── level ───────────────────────────────────────────────────────────
  const state = () => prop(main, "_NET_WM_STATE");
  t.check("getLevel: normal", (await t.call("window", "getLevel")).value === 0);
  await t.call("window", "setAlwaysOnTop", { enabled: true });
  t.check("always on top: the level, and the WM says above", (await t.call("window", "getLevel")).value === 3 && (await until(() => state().includes("_NET_WM_STATE_ABOVE"))), state());
  await t.call("window", "setAlwaysOnTop", { enabled: false });
  await t.call("window", "setAlwaysOnBottom", { enabled: true });
  t.check("always on bottom: the level, and the WM says below", (await t.call("window", "getLevel")).value < 0 && (await until(() => state().includes("_NET_WM_STATE_BELOW"))), state());
  await t.call("window", "setAlwaysOnBottom", { enabled: false });
  t.check("back to normal", (await t.call("window", "getLevel")).value === 0 && (await until(() => !state().includes("_NET_WM_STATE_BELOW"))));

  // ── simple full screen ──────────────────────────────────────────────
  await t.call("window", "setBounds", { x: 200, y: 100, width: 800, height: 500 });
  const before = await bounds();
  t.check("isSimpleFullscreen: off", (await t.call("window", "isSimpleFullscreen")).value.simpleFullscreen === false);
  await t.call("window", "setSimpleFullscreen", { enabled: true });
  const covering = client(main);
  t.check("borderless over the whole screen", covering.x === 0 && covering.y === 0 && covering.width === 1920 && covering.height === 1080, covering);
  t.check("… and not the WM's full screen", !state().includes("FULLSCREEN") && (await t.call("window", "isFullscreen")).value === false && (await t.call("window", "isSimpleFullscreen")).value.simpleFullscreen === true, state());
  await t.call("window", "setSimpleFullscreen", { enabled: false });
  const after = await bounds();
  t.check("back where it was, with its frame", near(after.x, before.x) && near(after.y, before.y) && near(after.width, before.width) && near(after.height, before.height) && (await t.call("window", "hasDecorations")).value === true, { before, after });

  // ── movable, minimizable, maximizable: what the WM then allows ──────
  await t.call("window", "focus");
  const allowed = () => prop(main, "_NET_WM_ALLOWED_ACTIONS");
  t.check("isMovable: yes at first, the WM allows it", (await t.call("window", "isMovable")).value === true && allowed().includes("_NET_WM_ACTION_MOVE"), allowed());
  await t.call("window", "setMovable", { enabled: false });
  t.check("setMovable(false): the WM stops allowing it", (await t.call("window", "isMovable")).value === false && (await until(() => !allowed().includes("_NET_WM_ACTION_MOVE"))), allowed());
  let f = await bounds();
  await drag(f.x + 200, f.y + 8, f.x + 330, f.y + 68);
  const stayed = await bounds();
  t.check("a real drag of the title bar doesn't move it", near(stayed.x, f.x) && near(stayed.y, f.y), { f, stayed });
  t.check("the shell's own moves still work", (await t.call("window", "setPosition", { x: 240, y: 130 })).ok && near((await bounds()).x, 240));
  await t.call("window", "setMovable", { enabled: true });
  await until(() => allowed().includes("_NET_WM_ACTION_MOVE"));
  f = await bounds();
  await drag(f.x + 200, f.y + 8, f.x + 330, f.y + 68);
  const moved = await bounds();
  t.check("setMovable(true): a real drag moves it", near(moved.x, f.x + 130, 8) && near(moved.y, f.y + 60, 8), { f, moved });
  // In the Motif hints: openbox only follows their resize and move, and leaves its buttons.
  const functions = () => Number(prop(main, "_MOTIF_WM_HINTS").split("=")[1]?.split(",")[1] ?? 1);
  const MOVE = 4, MINIMIZE = 8, MAXIMIZE = 16, CLOSE = 32;
  t.check("no limit: the hints say all (1)", functions() === 1, prop(main, "_MOTIF_WM_HINTS"));
  await t.call("window", "setMinimizable", { enabled: false });
  await t.call("window", "setMaximizable", { enabled: false });
  await t.call("window", "setClosable", { enabled: false });
  t.check("the getters", (await t.call("window", "isMinimizable")).value.minimizable === false && (await t.call("window", "isMaximizable")).value.maximizable === false);
  t.check("the hints lose all three", !(functions() & (MINIMIZE | MAXIMIZE | CLOSE | 1)) && !!(functions() & MOVE), prop(main, "_MOTIF_WM_HINTS"));
  await t.call("window", "setMinimizable", { enabled: true });
  t.check("one back: the others stay off", !!(functions() & MINIMIZE) && !(functions() & (MAXIMIZE | CLOSE)), prop(main, "_MOTIF_WM_HINTS"));
  await t.call("window", "setClosable", { enabled: true });
  t.check("… and closable keeps what's off", !!(functions() & CLOSE) && !(functions() & MAXIMIZE), prop(main, "_MOTIF_WM_HINTS"));
  await t.call("window", "setMaximizable", { enabled: true });
  t.check("all back", functions() === 1, prop(main, "_MOTIF_WM_HINTS"));
  const opt = (await t.call("window", "create", { label: "ops-opt", title: "ops opt", html: page(), width: 400, height: 200, hiddenUntilReady: false, movable: false, minimizable: false, aspectRatio: 2 })).value.windowId;
  const optWin = await findWin("ops opt");
  t.check("the options at creation: movable, aspectRatio", await until(() => !prop(optWin, "_NET_WM_ALLOWED_ACTIONS").includes("_MOVE") && /aspect/.test(prop(optWin, "WM_NORMAL_HINTS"))), prop(optWin, "_NET_WM_ALLOWED_ACTIONS"));
  await t.call("window", "close", { windowId: opt });

  // ── focusable ───────────────────────────────────────────────────────
  const active = () => run("xprop", "-root", "_NET_ACTIVE_WINDOW").split(" ").pop()!;
  const un = (await t.call("window", "create", { label: "ops-un", title: "ops un", html: page(`<script>addEventListener("mousedown",()=>{window.pressed=1})</script>`), width: 300, height: 200, x: 1300, y: 500, hiddenUntilReady: false, focusable: false })).value.windowId;
  const unWin = await findWin("ops un");
  await t.call("window", "focus");
  await until(() => active() === `0x${Number(main).toString(16)}`);
  t.check("focusable: false: the WM is told, the row says so", prop(unWin, "WM_HINTS").includes("input or input focus: False") && (await t.call("window", "isFocusable", { windowId: un })).value === false && (await t.call("window", "getInfo", { windowId: un })).value.focusable === false, prop(unWin, "WM_HINTS"));
  const u = client(unWin);
  xdotool("mousemove", String(u.x + 100), String(u.y + 100));
  await t.sleep(150);
  xdotool("click", "1");
  await t.sleep(400);
  t.check("a real click reaches the page and doesn't take the keyboard", (await t.call("window", "eval", { windowId: un, js: "window.pressed" })).value === 1 && active() === `0x${Number(main).toString(16)}` && (await t.call("window", "isFocused", { windowId: un })).value === false, active());
  t.check("focus → unavailable, as on macOS", (await t.call("window", "focus", { windowId: un })).error?.code === "unavailable");
  await t.call("window", "close", { windowId: un });

  // ── theme ───────────────────────────────────────────────────────────
  const variant = (id: string) => prop(id, "_GTK_THEME_VARIANT");
  const dark = () => t.call("window", "eval", { windowId: 0, js: `matchMedia("(prefers-color-scheme: dark)").matches` }).then((r) => r.value);
  const other = (await t.call("window", "create", { label: "ops-other", title: "ops other", html: page(), width: 300, height: 200, hiddenUntilReady: false })).value.windowId;
  const otherWin = await findWin("ops other");
  const otherDark = () => t.call("window", "eval", { windowId: other, js: `matchMedia("(prefers-color-scheme: dark)").matches` }).then((r) => r.value);
  const settled = async (want: boolean) => (await t.sleep(300), (await dark()) === want && (await otherDark()) === want);
  const appTheme = async () => (await t.call("theme", "get")).value.appearance;
  t.check("getTheme: system", (await t.call("window", "getTheme", { windowId: 0 })).value === "system");
  t.check("setTheme bogus → invalid_args", (await t.call("window", "setTheme", { windowId: 0, theme: "bogus" })).error?.code === "invalid_args");
  t.check("light to begin with", await settled(false) && (await appTheme()) === "light");
  const appearances = (t.events.get("appearanceChanged") ?? []).length;
  await t.call("window", "setTheme", { windowId: 0, theme: "dark" });
  t.check("setTheme: the window's own hint on the server, not the other's", variant(main).includes('"dark"') && !variant(otherWin).includes('"dark"') && (await t.call("window", "getTheme", { windowId: 0 })).value === "dark" && (await t.call("window", "getTheme", { windowId: other })).value === "system", [variant(main), variant(otherWin)]);
  await t.sleep(200);
  t.check("… the title bar's stays right once GTK has written its own", variant(main).includes('"dark"') && !variant(otherWin).includes('"dark"'), [variant(main), variant(otherWin)]);
  t.check("prefers-color-scheme moves, and in every window: GTK's settings are the screen's", await settled(true));
  t.check("the app's appearance hasn't moved, and said nothing", (await appTheme()) === "light" && (t.events.get("appearanceChanged") ?? []).length === appearances);
  await t.call("theme", "set", { appearance: "dark" });
  await t.sleep(200);
  t.check("theme.set: the app's appearance, and a window on system follows", (await appTheme()) === "dark" && variant(otherWin).includes('"dark"') && (t.events.get("appearanceChanged") ?? []).at(-1)?.appearance === "dark", variant(otherWin));
  await t.call("window", "setTheme", { windowId: 0, theme: "light" });
  await t.sleep(200);
  t.check("light over a dark app: each window's hint", variant(main).includes('"light"') && variant(otherWin).includes('"dark"'), [variant(main), variant(otherWin)]);
  t.check("the last one set is what the pages get", await settled(false));
  await t.call("window", "setTheme", { windowId: 0, theme: "system" });
  await t.sleep(200);
  t.check("system: back to the app's, hint and pages", variant(main).includes('"dark"') && (await settled(true)) && (await t.call("window", "getTheme", { windowId: 0 })).value === "system", variant(main));
  await t.call("theme", "set", { appearance: "system" });
  t.check("the app back on system", await settled(false));
  await t.call("window", "close", { windowId: other });

  // ── cursor ──────────────────────────────────────────────────────────
  await Bun.write("/tmp/cursor-image.c", CURSOR_C);
  const built = Bun.spawnSync(["gcc", "/tmp/cursor-image.c", "-o", "/tmp/cursor-image", "-lX11", "-lXfixes"]);
  t.check("the probe builds", built.exitCode === 0, built.stderr.toString());
  const painted = () => Number(run("/tmp/cursor-image"));
  await t.call("window", "focus");
  await t.call("window", "setBounds", { x: 200, y: 100, width: 800, height: 500 });
  await t.call("window", "eval", { js: `document.body.innerHTML='<a href="#" id="ln" style="position:fixed;left:0;top:0;width:200px;height:100px;display:block;cursor:pointer">x</a><div style="position:fixed;left:300px;top:0;width:200px;height:100px;cursor:crosshair">y</div>';1` });
  const c = client(main);
  const hover = async (x: number, y: number) => {
    xdotool("mousemove", String(c.x + x), String(c.y + y));
    await t.sleep(120);
    xdotool("mousemove", String(c.x + x + 2), String(c.y + y + 2));
    await t.sleep(300);
  };
  t.check("isCursorHidden: no", (await t.call("window", "isCursorHidden")).value === false);
  await hover(50, 50);
  const seen = painted();
  t.check("the page's cursor is on the screen", seen > 0, seen);
  await t.call("window", "setCursorHidden", { hidden: true });
  await t.sleep(100);
  t.check("hidden: the server's cursor has no pixel", (await t.call("window", "isCursorHidden")).value === true && painted() === 0, painted());
  await hover(350, 50);
  t.check("… the page's next cursor doesn't bring it back", painted() === 0, painted());
  await hover(50, 50);
  t.check("… nor another one", painted() === 0, painted());
  await t.call("window", "setCursorHidden", { hidden: false });
  await hover(350, 50);
  t.check("shown again, on the next move", (await t.call("window", "isCursorHidden")).value === false && painted() > 0, painted());
  await hover(50, 50);

  // ── document edited ─────────────────────────────────────────────────
  const name = () => prop(main, "_NET_WM_NAME");
  t.check("isDocumentEdited: no", (await t.call("window", "isDocumentEdited")).value.edited === false);
  await t.call("window", "setDocumentEdited", { edited: true });
  t.check("edited: the title bar has the mark, getTitle doesn't", name().includes('"• ops main"') && (await t.call("window", "getTitle")).value === "ops main" && (await t.call("window", "isDocumentEdited")).value.edited === true, name());
  await t.call("window", "setTitle", { title: "ops renamed" });
  t.check("a new title keeps it", name().includes('"• ops renamed"') && (await t.call("window", "getTitle")).value === "ops renamed", name());
  await t.call("window", "setDocumentEdited", { edited: false });
  t.check("not edited: gone", name().includes('"ops renamed"') && !name().includes("•"), name());

  // ── what stays out, and a page that doesn't know ─────────────────────
  for (const op of ["setRepresentedFilename", "getRepresentedFilename", "setTrafficLightPosition", "getTrafficLightPosition", "setContentProtected", "isContentProtected", "setHasShadow", "hasShadow", "invalidateShadow", "showCharacterPalette", "setVibrancy", "getVibrancy", "setGlass", "getGlass", "setMaterialRegions", "setMovableByWindowBackground", "isMovableByWindowBackground", "testScroll"])
    t.check(`${op} → unsupported`, (await t.call("window", op, { enabled: true })).error?.code === "unsupported");
  const fromPage = await t.pageCall("window", "setMaterialRegions", { regions: [{ id: 1, material: "sidebar", x: 0, y: 0, width: 10, height: 10, radius: 0 }] }) as any;
  t.check("setMaterialRegions from a page rejects, what materials.ts takes quietly", fromPage.error?.code === "unsupported", fromPage);
  t.check("html has no data-desktop-materials: materials.ts never starts", (await t.call("window", "eval", { js: `document.documentElement.hasAttribute("data-desktop-materials")` })).value === false);
};
