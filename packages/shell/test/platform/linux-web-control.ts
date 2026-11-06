// Find, context menu, JavaScript dialogs, media, background throttling, crash recovery and file
// drop on WebKitGTK, with real effects: the selection a find leaves, real X11 clicks and keys
// (xdotool), a real XDND drag from another process (test/docker/fake-drag.c), real timers.
import { writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]).stdout.toString().trim();

export default async (t: Harness) => {
  const seen = new Set<any>();
  async function nextEvent(name: string, pred: (e: any) => boolean = () => true, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = (t.events.get(name) ?? []).find((x) => !seen.has(x) && pred(x));
      if (e) {
        seen.add(e);
        return e;
      }
      await t.sleep(20);
    }
    return null;
  }
  const none = async (name: string, ms = 400) => (await nextEvent(name, () => true, ms)) === null;
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  const win = xdotool("search", "--name", "platform harness").split("\n")[0];

  // ---- getInfo: real values, not constants -------------------------------------
  let info = (await wv("getInfo")).value;
  t.check("getInfo: the defaults (no debug: the menu is off)", info?.fileDrop === true && info.contextMenu === "none" && info.backgroundThrottling === true && info.recovery === "reload", info);

  // ---- find ----------------------------------------------------------------------
  await t.page(`document.body.innerHTML = '<p id=f>alpha needle beta Needle gamma</p>'; return 1`);
  const selection = () => t.page<any>(`const s = getSelection(); return { text: String(s), at: s.rangeCount ? s.getRangeAt(0).startOffset : -1 }`);
  t.check("find: empty text → invalid_args", (await wv("find", { text: "" })).error?.code === "invalid_args");
  let found = await wv("find", { text: "needle" });
  let sel = await selection();
  t.check("find: match found and selected", found.value?.matchFound === true && sel.text === "needle" && sel.at === 6, { found, sel });
  found = await wv("find", { text: "needle" });
  sel = await selection();
  t.check("find again: the next match (case-insensitive by default)", found.value?.matchFound === true && sel.text === "Needle" && sel.at === 18, { found, sel });
  found = await wv("find", { text: "needle" });
  sel = await selection();
  t.check("find again: wraps by default", found.value?.matchFound === true && sel.at === 6, { found, sel });
  found = await wv("find", { text: "needle", backwards: true });
  sel = await selection();
  t.check("find backwards", found.value?.matchFound === true && sel.at === 18, { found, sel });
  found = await wv("find", { text: "needle", wraps: false });
  t.check("wraps:false: nothing after the last match", found.value?.matchFound === false, found);
  await wv("clearFind");
  found = await wv("find", { text: "Needle", caseSensitive: true });
  sel = await selection();
  t.check("caseSensitive", found.value?.matchFound === true && sel.at === 18, { found, sel });
  t.check("caseSensitive: no match in another case", (await wv("find", { text: "ALPHA", caseSensitive: true })).value?.matchFound === false);
  t.check("no match", (await wv("find", { text: "nowhere" })).value?.matchFound === false);
  t.check("clearFind", (await wv("clearFind")).ok && (await selection()).text === "");

  // ---- context menu: real right clicks ---------------------------------------------
  await t.page(`document.body.innerHTML = '<a id=l href="https://example.com/x" style="position:fixed;left:40px;top:40px">link</a><input id=i value=text style="position:fixed;left:40px;top:100px;width:200px"><p id=s style="position:fixed;left:40px;top:160px;margin:0">words to select</p>'; return 1`);
  const rightClick = async (x: number, y: number) => {
    xdotool("mousemove", "--window", win, String(x), String(y), "click", "3");
    await t.sleep(400);
  };
  const lastMenu = async () => (await wv("_contextMenuForTesting")).value;
  const escape = async () => {
    xdotool("key", "Escape");
    await t.sleep(200);
  };
  await rightClick(50, 45);
  let ev = await nextEvent("contextMenu");
  t.check("contextMenu event: position, link, mode, target", ev?.windowId === 0 && Math.abs(ev.x - 50) < 3 && Math.abs(ev.y - 45) < 3 && ev.linkURL === "https://example.com/x" && ev.editable === false && ev.mode === "none", ev);
  let menu = await lastMenu();
  t.check("none: WebKit had a menu, none is shown", menu?.before?.length > 0 && menu.after.length === 0, menu);
  xdotool("mousemove", "--window", win, "55", "168", "click", "--repeat", "2", "--delay", "60", "1"); // a word, as a user selects it
  await t.sleep(200);
  await rightClick(55, 168);
  ev = await nextEvent("contextMenu");
  t.check("contextMenu event: the selection", ev?.selectionText?.trim() === "words", { ev, selection: await t.page("return String(getSelection())") });
  menu = await lastMenu();
  t.check("none + editMenu: only the edit items are left", menu?.after?.length > 0 && menu.after.length < menu.before.length, menu);
  await escape();
  await rightClick(60, 110);
  ev = await nextEvent("contextMenu");
  t.check("contextMenu event: editable", ev?.editable === true, ev);
  await escape();
  const noEdit = await wv("setContextMenu", { mode: "none", editMenu: false });
  await rightClick(60, 110);
  t.check("none, editMenu:false: nothing on an input either", noEdit.value?.mode === "none" && (await lastMenu())?.after.length === 0, await lastMenu());
  t.check("setContextMenu: unknown mode → invalid_args", (await wv("setContextMenu", { mode: "nope" })).error?.code === "invalid_args");
  t.check("setContextMenu: custom without items → invalid_args", (await wv("setContextMenu", { mode: "custom" })).error?.code === "invalid_args");
  t.check("setContextMenu: invalid items → invalid_args", (await wv("setContextMenu", { mode: "custom", items: [{ label: "x", role: "nope" }] })).error?.code === "invalid_args");
  const items = [{ id: "first", label: "First" }, { type: "separator" }, { id: "off", label: "Off", enabled: false }, { label: "More", submenu: [{ id: "inner", label: "Inner" }] }];
  await wv("setContextMenu", { mode: "custom", items, editMenu: false });
  const read = (await wv("getContextMenu")).value;
  t.check("getContextMenu", read?.mode === "custom" && read.editMenu === false && read.debug === false && read.items.length === 4, read);
  t.check("getInfo reports the mode", (await wv("getInfo")).value?.contextMenu === "custom");
  await rightClick(120, 300);
  menu = await lastMenu();
  t.check("custom: the app's items", JSON.stringify(menu?.after?.filter((x: unknown) => x !== "-").slice(0, 2)) === JSON.stringify(["First", "Off"]), menu);
  xdotool("key", "Down");
  await t.sleep(100);
  xdotool("key", "Return");
  const action = await nextEvent("menuAction");
  t.check("custom: choosing an item (real keys) → menuAction {id}", action?.id === "first", { action, menu });
  await wv("setContextMenu", { mode: "default" });
  await rightClick(120, 300);
  menu = await lastMenu();
  t.check("default: WebKit's menu, untouched", menu?.after?.length > 0 && JSON.stringify(menu.after) === JSON.stringify(menu.before), menu);
  await escape();
  await t.call("view", "create", { id: "debug", url: "about:blank", bounds: { x: 0, y: 0, width: 50, height: 50 }, debug: true });
  const debugMenu = (await wv("getContextMenu", { viewId: "debug" })).value;
  t.check("a view in debug defaults to WebKit's menu", debugMenu?.mode === "default" && debugMenu.debug === true, debugMenu);
  t.check("getInfo: per view", (await wv("getInfo", { viewId: "debug" })).value?.contextMenu === "default" && (await wv("getInfo")).value?.contextMenu === "default");
  await t.call("view", "destroy", { id: "debug" });
  await wv("setInspectable", { enabled: true });
  await wv("setContextMenu", { mode: "none", editMenu: false });
  await t.page(`setTimeout(() => location.reload(), 10); return 1`); // WebKit adds its item to what the page's settings allow
  await t.sleep(500);
  await t.page(`document.body.innerHTML = '<p>page</p>'; return 1`);
  await rightClick(120, 300);
  menu = await lastMenu();
  t.check("debug: `none` keeps Inspect Element", menu?.after?.length === 1 && menu.after[0] === 31 && menu.before.includes(13), menu);
  await escape();
  await wv("setInspectable", { enabled: false });
  await wv("setContextMenu", { mode: "none", editMenu: true, all: true });
  await t.call("view", "create", { id: "after-all", url: "about:blank", bounds: { x: 0, y: 0, width: 50, height: 50 }, debug: true });
  t.check("all: the current views and the next ones", (await wv("getContextMenu")).value?.mode === "none" && (await wv("getContextMenu", { viewId: "after-all" })).value?.mode === "none", (await wv("getContextMenu", { viewId: "after-all" })).value);
  await t.call("view", "destroy", { id: "after-all" });

  // ---- JavaScript dialogs ----------------------------------------------------------
  t.check("getDialog: none open → null", (await wv("getDialog")).ok && (await wv("getDialog")).value === null);
  t.check("respondToDialog: none open → unavailable", (await wv("respondToDialog")).error?.code === "unavailable");
  const run = (js: string) => t.page(`window.__r = 'pending'; setTimeout(() => { window.__r = ${js}; }, 0); return 1`);
  const answer = () => t.page<any>("return window.__r");
  await run(`alert('hello')`);
  ev = await nextEvent("jsDialog");
  t.check("alert: jsDialog event", ev?.type === "alert" && ev.message === "hello" && ev.windowId === 0 && !("defaultValue" in ev), ev);
  const open = (await wv("getDialog")).value;
  t.check("getDialog", open?.type === "alert" && open.message === "hello", open);
  t.check("respondToDialog", (await wv("respondToDialog")).value?.type === "alert");
  await t.sleep(100);
  t.check("the page goes on", (await answer()) === undefined || (await answer()) === null, await answer());
  t.check("…and the dialog is gone", (await wv("getDialog")).value === null);
  await run(`confirm('sure?')`);
  await nextEvent("jsDialog");
  await wv("respondToDialog", { accept: true });
  await t.sleep(100);
  t.check("confirm accepted → true", (await answer()) === true);
  await run(`confirm('sure?')`);
  ev = await nextEvent("jsDialog");
  t.check("confirm: event type", ev?.type === "confirm", ev);
  await wv("respondToDialog", { accept: false });
  await t.sleep(100);
  t.check("confirm refused → false", (await answer()) === false);
  await run(`prompt('name?', 'ada')`);
  ev = await nextEvent("jsDialog");
  t.check("prompt: event with its default", ev?.type === "prompt" && ev.message === "name?" && ev.defaultValue === "ada", ev);
  await wv("respondToDialog", {});
  await t.sleep(100);
  t.check("prompt accepted as is → the default", (await answer()) === "ada", await answer());
  await run(`prompt('name?', 'ada')`);
  await nextEvent("jsDialog");
  await wv("respondToDialog", { text: "grace" });
  await t.sleep(100);
  t.check("prompt with text → the text", (await answer()) === "grace", await answer());
  await run(`prompt('name?', 'ada')`);
  await nextEvent("jsDialog");
  await wv("respondToDialog", { accept: false });
  await t.sleep(100);
  t.check("prompt refused → null", (await answer()) === null, await answer());
  await run(`confirm('by hand?')`);
  await nextEvent("jsDialog");
  await t.sleep(400);
  xdotool("key", "--clearmodifiers", "Return");
  await t.sleep(300);
  t.check("a real key press answers the real dialog", (await answer()) === true && (await wv("getDialog")).value === null, await answer());

  // ---- media --------------------------------------------------------------------------
  const wav = (() => {
    const rate = 8000, samples = rate * 2, b = new DataView(new ArrayBuffer(44 + samples));
    const put = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
    put(0, "RIFF"); b.setUint32(4, 36 + samples, true); put(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, rate, true); b.setUint32(28, rate, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true); put(36, "data"); b.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) b.setUint8(44 + i, 128 + 60 * Math.sin((i * 2 * Math.PI * 440) / rate));
    return Buffer.from(b.buffer).toString("base64");
  })();
  const media = async () => (await wv("getMediaState")).value;
  t.check("getMediaState: nothing going on", ((m) => m?.playback === "none" && m.audible === false && m.muted === false && m.camera === "none" && m.microphone === "none")(await media()), await media());
  const started = await t.page<any>(`
    const url = 'data:audio/wav;base64,${wav}';
    const inDoc = document.createElement('audio'); inDoc.src = url; inDoc.loop = true; document.body.append(inDoc);
    const loose = new Audio(url); loose.loop = true;
    const frame = document.createElement('iframe'); frame.srcdoc = '<!doctype html><audio></audio>'; document.body.append(frame);
    await new Promise((r) => { frame.onload = r; });
    const inFrame = frame.contentDocument.querySelector('audio'); inFrame.src = url; inFrame.loop = true; inFrame.muted = true; // WebKit's autoplay rule: a frame only plays without sound
    window.__a = [inDoc, loose, inFrame];
    try { await inDoc.play(); await loose.play(); await inFrame.play(); window.__playing = window.__a.filter((a) => !a.paused).length; return { ok: true }; } catch (e) { return { ok: false, name: e.name, message: e.message }; }`);
  t.check("audio really plays here", started?.ok === true, started);
  let m = await media();
  t.check("getMediaState: playing", m?.playback === "playing", m);
  await t.sleep(500);
  m = await media();
  if (m?.audible) t.check("getMediaState: audible", true, m);
  else t.skip("getMediaState: audible", "no audio device here for WebKit to report sound");
  t.check("setAudioMuted", (await wv("setAudioMuted", { muted: true })).ok);
  m = await media();
  t.check("muted: reported, not audible, still playing", m?.muted === true && m.audible === false && m.playback === "playing" && (await t.page<any>("return !window.__a[0].paused")) === true, m);
  await wv("setAudioMuted", { muted: false });
  t.check("unmuted", (await media())?.muted === false);
  t.check("pauseMedia", (await wv("pauseMedia")).ok);
  t.check("all three were playing", (await t.page<any>("return window.__playing")) === 3);
  const paused = await t.page<any>("return window.__a.map((a) => a.paused)");
  t.check("pauseMedia really paused them all: in the document, outside it, in a same-origin frame", paused?.length === 3 && paused.every(Boolean), paused);
  m = await media();
  t.check("getMediaState: paused", m?.playback === "paused", m);
  const live = await t.page<any>(`window.__cam = await navigator.mediaDevices.getUserMedia({video:true}).catch((e) => e.name); return typeof window.__cam === 'string' ? window.__cam : 'ok'`);
  await t.sleep(300);
  let cam = await media();
  t.check("getMediaState: the camera is active", live === "ok" && cam?.camera === "active", { live, cam });
  await t.page(`window.__cam.getTracks().forEach((x) => x.stop()); return 1`);
  for (let i = 0; i < 40 && cam?.camera !== "none"; i++) {
    await t.sleep(100);
    cam = await media();
  }
  t.check("…then not", cam?.camera === "none", cam);

  // ---- background throttling: real timers in a hidden window ------------------------
  await t.page(`window.__ticks = 0; window.__timer = setInterval(() => { window.__ticks++; }, 20); return 1`);
  const ticksWhileHidden = async () => {
    await t.call("window", "hide");
    await t.sleep(1000); // hidden for a moment: WebKit's throttling starts
    const a = (await wv("executeJavaScript", { code: "window.__ticks" })).value;
    await t.sleep(2000);
    const b = (await wv("executeJavaScript", { code: "window.__ticks" })).value;
    await t.call("window", "show");
    await t.sleep(300);
    return b - a;
  };
  const throttled = await ticksWhileHidden();
  t.check("setBackgroundThrottling(false)", (await wv("setBackgroundThrottling", { enabled: false })).ok && (await wv("getInfo")).value?.backgroundThrottling === false);
  const fullSpeed = await ticksWhileHidden();
  t.check("hidden, throttled: timers slow down; not throttled: full speed", throttled < 15 && fullSpeed > 50, { throttled, fullSpeed });
  t.check("setBackgroundThrottling(true)", (await wv("setBackgroundThrottling", { enabled: true })).ok && (await wv("getInfo")).value?.backgroundThrottling === true);
  const again = await ticksWhileHidden();
  t.check("throttled again", again < 15, { again });
  await t.page(`clearInterval(window.__timer); return 1`);

  // ---- recovery: a view, so that a real server counts the reloads ----------------------
  let loads = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { loads++; return new Response("<!doctype html><title>r</title>page", { headers: { "content-type": "text/html", "cache-control": "no-store" } }); } });
  await t.call("view", "create", { id: "crash", url: `http://127.0.0.1:${server.port}/`, bounds: { x: 0, y: 0, width: 100, height: 100 } });
  await t.sleep(500);
  const target = { viewId: "crash" };
  t.check("setRecovery: unknown policy → invalid_args", (await wv("setRecovery", { ...target, recovery: "nope" })).error?.code === "invalid_args");
  const baseline = loads;
  t.check("_terminateForTesting", (await wv("_terminateForTesting", target)).ok);
  ev = await nextEvent("webviewLifecycle");
  t.check("webviewLifecycle: terminated, with the target and the policy", ev?.type === "terminated" && ev.viewId === "crash" && ev.recovery === "reload" && ev.reason === "unknown" && ev.navigationId === null && ev.url.startsWith("http://127.0.0.1"), ev);
  await t.sleep(1500);
  t.check("reload (the default): a new request, a live page", loads === baseline + 1 && (await wv("executeJavaScript", { ...target, code: "1 + 1" })).value === 2, { loads, baseline });
  t.check("setRecovery manual", (await wv("setRecovery", { ...target, recovery: "manual" })).ok && (await wv("getInfo", target)).value?.recovery === "manual");
  const before = loads;
  await wv("_terminateForTesting", target);
  ev = await nextEvent("webviewLifecycle");
  t.check("manual: the event says so", ev?.recovery === "manual" && !("gaveUp" in ev), ev);
  await t.sleep(2000);
  t.check("manual: stays stopped, no request", loads === before, { loads, before });
  t.check("manual: reload brings it back", (await wv("reload", target)).ok);
  await t.sleep(800);
  t.check("…a new request, a live page", loads === before + 1 && (await wv("executeJavaScript", { ...target, code: "2 + 2" })).value === 4, { loads, before });
  await t.call("view", "destroy", { id: "crash" });
  server.stop(true);

  // ---- file drop: a real XDND drag from another process --------------------------------
  const file = "/tmp/kitop-drop-test.txt";
  writeFileSync(file, "dropped");
  await t.page(`window.__drops = []; document.body.innerHTML = '<div style="position:fixed;inset:0">drop here</div>';
    addEventListener('dragover', (e) => e.preventDefault()); addEventListener('drop', (e) => { e.preventDefault(); window.__drops.push([...e.dataTransfer.files].map((f) => f.name)); }); return 1`);
  const source = Bun.spawn(["/tmp/fake-drag", `file://${file}`], { stdout: "ignore", stderr: "ignore" });
  let src = "";
  for (let i = 0; i < 50 && !src; i++) {
    src = xdotool("search", "--name", "fake-drag").split("\n")[0];
    await t.sleep(100);
  }
  src = xdotool("search", "--name", "fake-drag").split("\n").pop()!; // the last: the window, not GTK's leader
  const position = (id: string) => Object.fromEntries(xdotool("getwindowgeometry", "--shell", id).split("\n").map((l) => l.split("="))) as Record<string, string>;
  const page = position(win), from = position(src);
  const target_ = { x: Number(page.X) + 150, y: Number(page.Y) + 120 };
  const startDrag = async () => {
    xdotool("windowraise", src);
    xdotool("mousemove", String(Number(from.X) + 40), String(Number(from.Y) + 40));
    await t.sleep(100);
    xdotool("mousedown", "1");
    await t.sleep(100);
    // Steps: GTK starts a drag on motion, and XDND needs to see the pointer enter the target.
    for (let i = 1; i <= 6; i++) {
      xdotool("mousemove", String(Number(from.X) + 40 + ((target_.x - Number(from.X) - 40) * i) / 6), String(Number(from.Y) + 40 + ((target_.y - Number(from.Y) - 40) * i) / 6));
      await t.sleep(80);
    }
    await t.sleep(300);
  };
  await startDrag();
  ev = await nextEvent("fileDragEnter");
  t.check("fileDragEnter: real paths, where it came in, target", ev?.windowId === 0 && ev.paths?.[0] === file && ev.x >= 0 && ev.x <= 150 && ev.y >= 0 && ev.y <= 120, { ev, page, from, src });
  xdotool("mouseup", "1");
  await t.sleep(400);
  ev = await nextEvent("fileDrop");
  t.check("fileDrop: real paths, position, target", ev?.windowId === 0 && ev.paths?.[0] === file && Math.abs(ev.x - 150) < 5, ev);
  t.check("a drop is not a leave", await none("fileDragLeave"));
  const dom = await t.page<any>("return window.__drops");
  // Its `files` come empty from WebKitGTK here, with or without these handlers: the paths are the native event's.
  t.check("the page still gets its DOM drop", dom?.length === 1, dom);
  await startDrag();
  await nextEvent("fileDragEnter");
  xdotool("mousemove", String(Number(from.X) + 40), String(Number(from.Y) + 40));
  await t.sleep(400);
  ev = await nextEvent("fileDragLeave");
  t.check("fileDragLeave: the drag left the view", ev?.windowId === 0 && !("paths" in ev), ev);
  xdotool("mouseup", "1");
  await t.sleep(1000); // GTK slides a refused drag back before it can start another
  t.check("setFileDrop: enabled is required", (await wv("setFileDrop", {})).error?.code === "invalid_args");
  const off = await wv("setFileDrop", { enabled: false });
  t.check("setFileDrop off, in getInfo too", off.value?.enabled === false && (await wv("getInfo")).value?.fileDrop === false, off);
  await startDrag();
  xdotool("mouseup", "1");
  await t.sleep(400);
  t.check("off: no native events", (await none("fileDragEnter", 100)) && (await none("fileDrop", 100)));
  t.check("off: the page's own drop still works", (await t.page<any>("return window.__drops.length")) === 2, await t.page("return window.__drops"));
  const allOn = await wv("setFileDrop", { enabled: true, all: true });
  await startDrag();
  xdotool("mouseup", "1");
  await t.sleep(400);
  t.check("setFileDrop all: back on", allOn.value?.enabled === true && (await nextEvent("fileDrop"))?.paths?.[0] === file);
  source.kill();
};
