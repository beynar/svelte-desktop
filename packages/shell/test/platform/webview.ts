import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "../harness-worker.ts";

const wv = (t: Harness, op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);

export default async (t: Harness) => {
  const origin: string = await t.page("return location.origin");

  // -- UI delegate
  t.check("our WKUIDelegate is installed on the window", (await wv(t, "_test", { action: "uiDelegate" })).value === "SDUIDelegate");

  // -- zoom
  t.check("setZoom 1.5", (await wv(t, "setZoom", { zoom: 1.5 })).value?.zoom === 1.5);
  t.check("getZoom", (await wv(t, "getZoom")).value?.zoom === 1.5);
  t.check("page sees the zoom (devicePixelRatio scales)", (await t.page<number>("return window.devicePixelRatio")) >= 1.5);
  t.check("setZoom bad → invalid_args", (await wv(t, "setZoom", { zoom: -1 })).error?.code === "invalid_args");
  await wv(t, "setZoom", { zoom: 1 });

  // -- find in page
  await t.page(`document.getElementById('log').textContent = 'The quick brown Zebra jumps'; return 1`);
  t.check("find known text", (await wv(t, "find", { text: "zebra" })).value?.matchFound === true);
  t.check("find caseSensitive miss", (await wv(t, "find", { text: "zebra", caseSensitive: true })).value?.matchFound === false);
  t.check("find backwards", (await wv(t, "find", { text: "quick", backwards: true })).value?.matchFound === true);
  t.check("find absent text", (await wv(t, "find", { text: "platypus-xyz" })).value?.matchFound === false);
  t.check("find without text → invalid_args", (await wv(t, "find", {})).error?.code === "invalid_args");
  t.check("clearFind drops the selection", (await wv(t, "clearFind")).ok && (await t.page("return String(getSelection())")) === "");

  // -- context menu policy (run on a WebKit-like menu: real right-clicks need input events)
  const menu = (ids: string[]) => wv(t, "_test", { action: "contextMenu", identifiers: ids }).then((r) => r.value);
  const cm = (await wv(t, "getContextMenu")).value;
  t.check("context menu defaults to none (window not in debug)", cm?.mode === "none" && cm.debug === false && cm.editMenu === true, cm);
  t.check("none: page items (Back/Reload/Inspect) removed → no menu", (await menu(["GoBack", "Reload", "-", "InspectElement"])).length === 0);
  { const m = await menu(["SpellingGuess", "-", "Cut", "Copy", "Paste", "-", "LookUp", "Reload"]); t.check("none: edit items kept", JSON.stringify(m) === '["SpellingGuess","Cut","Copy","Paste"]', m); }
  t.check("setContextMenu none editMenu:false", (await wv(t, "setContextMenu", { mode: "none", editMenu: false })).ok && (await menu(["Cut", "Copy", "Paste"])).length === 0);
  t.check("setContextMenu default → WebKit menu untouched", (await wv(t, "setContextMenu", { mode: "default", editMenu: true })).ok && (await menu(["Reload", "-", "InspectElement"])).length === 3);
  const custom = await wv(t, "setContextMenu", { mode: "custom", items: [{ id: "ctx-a", label: "Alpha" }, { type: "separator" }, { id: "ctx-b", label: "Beta" }] });
  t.check("setContextMenu custom", custom.ok, custom);
  t.check("custom: app items replace WebKit's", JSON.stringify(await menu(["Reload", "InspectElement"])) === '["Alpha","-","Beta"]');
  t.check("custom: edit items on top when editing", JSON.stringify(await menu(["Copy", "Reload"])) === '["Copy","-","Alpha","-","Beta"]');
  t.check("custom without items → invalid_args", (await wv(t, "setContextMenu", { mode: "custom" })).error?.code === "invalid_args");
  t.check("bad mode → invalid_args", (await wv(t, "setContextMenu", { mode: "fancy" })).error?.code === "invalid_args");
  const ctxEv = t.waitEvent("contextMenu");
  await t.page(`const a = document.createElement('a'); a.href = '/somewhere'; a.textContent = 'link'; a.id = 'lnk'; document.body.append(a);
    a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 })); return 1`);
  const ce = await ctxEv;
  t.check("contextMenu event {x,y,windowId,linkURL,editable}", ce?.windowId === 0 && ce.x === 12 && ce.y === 34 && ce.linkURL === origin + "/somewhere" && ce.editable === false && ce.mode === "custom", ce);
  const ctxEv2 = t.waitEvent("contextMenu");
  await t.page(`const i = document.createElement('input'); i.value = 'abc'; document.body.append(i); i.select();
    i.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 2 })); return 1`);
  const ce2 = await ctxEv2;
  t.check("contextMenu event on an input: editable", ce2?.editable === true && ce2.linkURL === undefined, ce2);
  // Real WebKit menus: in-process synthetic right-click (no Accessibility), tracking cancelled at once.
  const rclick = (x: number, y: number) => wv(t, "_test", { action: "rightClick", x, y }).then((r) => r.value);
  await t.page(`document.getElementById('log').textContent = 'plain text'; return 1`);
  await wv(t, "setContextMenu", { mode: "none" });
  const r1 = await rclick(30, 60);
  t.check("real right-click, none: WebKit's menu (Reload…) emptied → nothing shown", r1?.before?.includes("Reload") && r1.after.length === 0, r1);
  await t.page(`const i = document.createElement('input'); i.value = 'abc'; i.style = 'position:fixed;left:0;top:0;width:200px;height:40px';
    document.body.append(i); i.select(); return 1`);
  const r2 = await rclick(20, 20);
  t.check("real right-click in an input, none: only edit items", r2?.before?.length > r2?.after?.length && r2.after.includes("Paste") && r2.after.every((x: string) => ["Cut", "Copy", "Paste"].includes(x) || x.includes("Spelling")), r2);
  await wv(t, "setContextMenu", { mode: "custom", items: [{ id: "ctx-a", label: "Alpha" }] });
  const r3 = await rclick(20, 20);
  t.check("real right-click in an input, custom: edit items + app items", r3?.after?.at(-1) === "Alpha" && r3.after.includes("Paste"), r3);
  await t.page(`document.querySelector('input[style]').remove(); return 1`);
  await wv(t, "setContextMenu", { mode: "none" });

  // -- file drop: the patched WKWebView drag methods, fed an in-process NSDraggingInfo
  // (private pasteboard with file URLs; no Accessibility). WebKit gets the call-through.
  await t.page(`window.__dom = []; for (const n of ['dragenter', 'dragover', 'drop', 'dragleave'])
    addEventListener(n, (e) => { e.preventDefault(); window.__dom.push(n); }); return 1`);
  const enter = t.waitEvent("fileDragEnter"), drop = t.waitEvent("fileDrop");
  const rd = await wv(t, "_test", { action: "realDrop", paths: ["/etc/hosts", "/tmp"], x: 40, y: 50 });
  t.check("drop through WKWebView's performDragOperation:", rd.value?.performed === true, rd);
  const [en, dr] = [await enter, await drop];
  t.check("fileDragEnter {windowId, paths, x, y}", en?.windowId === 0 && en.paths?.[0] === "/etc/hosts" && en.x === 40 && en.y === 50, en);
  t.check("fileDrop {windowId, paths:[real paths], x, y}", dr?.windowId === 0 && dr.paths?.length === 2 && dr.paths[1].endsWith("tmp") && dr.x === 40 && dr.y === 50, dr);
  await t.sleep(300);
  t.check("page still gets DOM dragenter/dragover/drop", JSON.stringify(await t.page("return window.__dom")) === '["dragenter","dragover","drop"]');
  const leave = t.waitEvent("fileDragLeave");
  await wv(t, "_test", { action: "realDrop", paths: ["/etc/hosts"], leave: true });
  t.check("fileDragLeave", (await leave)?.windowId === 0);
  await wv(t, "setZoom", { zoom: 2 });
  const zdrop = t.waitEvent("fileDrop");
  await wv(t, "_test", { action: "realDrop", paths: ["/etc/hosts"], x: 100, y: 80 });
  const zd = await zdrop;
  t.check("drop coordinates are CSS px (divided by zoom)", zd?.x === 50 && zd.y === 40, zd);
  await wv(t, "setZoom", { zoom: 1 });
  t.check("setFileDrop false", (await wv(t, "setFileDrop", { enabled: false })).value?.enabled === false);
  const none = t.waitEvent("fileDrop", 600);
  await wv(t, "_test", { action: "realDrop", paths: ["/etc/hosts"] });
  t.check("disabled → no fileDrop event", (await none) === null);
  t.check("setFileDrop true", (await wv(t, "setFileDrop", { enabled: true })).value?.enabled === true);
  t.check("setFileDrop without enabled → invalid_args", (await wv(t, "setFileDrop", {})).error?.code === "invalid_args");
  t.skip("drag from Finder by hand (DOM File objects, sandbox extension)", "needs a human drag");

  // -- downloads
  const dir = mkdtempSync(join(tmpdir(), "sd-webview-dl-"));
  t.check("setDownloadDirectory", (await wv(t, "setDownloadDirectory", { path: dir })).value?.path === dir);
  t.check("getDownloadDirectory", (await wv(t, "getDownloadDirectory")).value?.path === dir);
  const started = t.waitEvent("downloadStarted", 6000), finished = t.waitEvent("downloadFinished", 6000);
  const dl = await wv(t, "download", { url: "/download.txt" });
  t.check("webview.download (relative URL) → id", dl.ok && typeof dl.value.id === "string" && dl.value.url === origin + "/download.txt", dl);
  const st = await started, fin = await finished;
  t.check("downloadStarted {id, path, suggestedFilename, windowId}", st?.id === dl.value?.id && st.suggestedFilename === "harness-download.txt" && st.windowId === 0, st);
  t.check("downloadFinished {path} and the file landed", fin?.id === dl.value?.id && fin.path === join(dir, "harness-download.txt") && existsSync(fin.path) && readFileSync(fin.path, "utf8").startsWith("harness download"), fin);
  const fin2 = t.waitEvent("downloadFinished", 6000);
  await t.page(`const a = document.createElement('a'); a.href = '/download.txt'; document.body.append(a); a.click(); return 1`);
  const f2 = await fin2;
  t.check("navigation to a Content-Disposition: attachment response downloads (unique name)", f2?.path === join(dir, "harness-download (1).txt") && existsSync(f2.path), f2);
  t.check("page stayed put after the attachment navigation", (await t.page("return location.pathname")) === "/");
  const fin3 = t.waitEvent("downloadFinished", 6000);
  await t.page(`const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['blob body'], {type:'text/plain'}));
    a.download = 'from-blob.txt'; document.body.append(a); a.click(); return 1`);
  const f3 = await fin3;
  t.check("<a download> blob → download", f3?.path === join(dir, "from-blob.txt") && readFileSync(f3.path, "utf8") === "blob body", f3);
  const target = join(dir, "sub", "explicit.txt");
  const fin4 = t.waitEvent("downloadFinished", 6000);
  await wv(t, "download", { url: origin + "/download.txt", path: target });
  t.check("download with explicit path", (await fin4)?.path === target && existsSync(target));
  t.check("download bad URL → invalid_args", (await wv(t, "download", { url: "ftp://x/y" })).error?.code === "invalid_args");
  t.check("cancelDownload unknown → invalid_args", (await wv(t, "cancelDownload", { id: "nope" })).error?.code === "invalid_args");
  t.check("listDownloads empty when idle", Array.isArray((await wv(t, "listDownloads")).value) && (await wv(t, "listDownloads")).value.length === 0);
  t.check("downloads produced only expected files", readdirSync(dir).sort().join(",") === "from-blob.txt,harness-download (1).txt,harness-download.txt,sub");
  const progress = t.waitEvent("downloadProgress", 6000), slowDone = t.waitEvent("downloadFinished", 8000);
  const slow = await wv(t, "download", { url: "/download.txt?slow" });
  const pg = await progress;
  t.check("downloadProgress {receivedBytes, totalBytes, fraction} (throttled)", pg?.id === slow.value?.id && pg.receivedBytes > 0 && pg.receivedBytes < 655350 && (pg.totalBytes === -1 ? pg.fraction === -1 : pg.fraction > 0 && pg.fraction < 1), pg);
  t.check("listDownloads shows the active one", (await wv(t, "listDownloads")).value?.some((d: any) => d.id === slow.value?.id));
  const sd = await slowDone;
  t.check("slow download finished with every byte", sd?.bytes === 655350, sd);
  t.check("progress events were throttled", (t.events.get("downloadProgress") ?? []).length <= 10, (t.events.get("downloadProgress") ?? []).length);
  const failed = t.waitEvent("downloadFailed", 6000);
  const cancel = await wv(t, "download", { url: "/download.txt?slow", path: join(dir, "canceled.txt") });
  await t.sleep(300);
  t.check("cancelDownload", (await wv(t, "cancelDownload", { id: cancel.value?.id })).ok);
  const fl = await failed;
  t.check("downloadFailed {canceled:true}, partial file removed", fl?.id === cancel.value?.id && fl.canceled === true && !existsSync(join(dir, "canceled.txt")), fl);
  rmSync(join(dir, "harness-download (2).txt"), { force: true });
  await wv(t, "setDownloadDirectory", { path: null });

  // -- executeJavaScript
  t.check("executeJavaScript expression", (await wv(t, "executeJavaScript", { code: "1 + 2" })).value === 3);
  t.check("executeJavaScript JSON value", JSON.stringify((await wv(t, "executeJavaScript", { code: "({ a: [1, 'x', null], b: true })" })).value) === '{"a":[1,"x",null],"b":true}');
  t.check("executeJavaScript awaits promises", (await wv(t, "executeJavaScript", { code: "new Promise(r => setTimeout(() => r('later'), 30))" })).value === "later");
  t.check("executeJavaScript statements → last value", (await wv(t, "executeJavaScript", { code: "let q = 5; q * 2" })).value === 10);
  t.check("executeJavaScript undefined → null", (await wv(t, "executeJavaScript", { code: "void 0" })).value === null);
  const thrown = await wv(t, "executeJavaScript", { code: "throw new Error('boom')" });
  t.check("executeJavaScript throw → internal with message", thrown.error?.code === "internal" && thrown.error.message.includes("boom"), thrown);

  // -- capturePage
  const shot = await wv(t, "capturePage");
  const png = shot.ok ? Buffer.from(shot.value.data, "base64") : Buffer.alloc(0);
  t.check("capturePage → PNG", png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && shot.value.width > 100, { width: shot.value?.width, bytes: png.length });
  const jpg = await wv(t, "capturePage", { format: "jpeg", rect: { x: 0, y: 0, width: 100, height: 50 } });
  t.check("capturePage jpeg rect", jpg.ok && Buffer.from(jpg.value.data, "base64").subarray(0, 2).toString("hex") === "ffd8" && jpg.value.width >= 100 && jpg.value.width <= 300, { w: jpg.value?.width });

  // -- print (PDF through the print system: no printer, no panel)
  const pdf = join(dir, "page.pdf");
  const pr = await wv(t, "printToPDF", { path: pdf });
  t.check("printToPDF writes a PDF", pr.ok && existsSync(pdf) && readFileSync(pdf).subarray(0, 4).toString() === "%PDF", pr);
  const pdf2 = join(dir, "silent.pdf");
  const printed = t.waitEvent("printFinished", 6000);
  const ps = await wv(t, "print", { silent: true, pdfPath: pdf2 });
  t.check("print {silent, pdfPath}", ps.value?.success === true && existsSync(pdf2), ps);
  t.check("printFinished event", (await printed)?.success === true);
  const pi = await wv(t, "print");
  t.check("interactive print starts as a sheet without blocking", pi.value?.started === true && (await wv(t, "_test", { action: "hasSheet" })).value === true, pi);
  t.check("second print while the sheet is up → unavailable", (await wv(t, "print")).error?.code === "unavailable");
  const canceled = t.waitEvent("printFinished", 4000);
  await wv(t, "_test", { action: "endSheet" });
  t.check("print panel dismissed → printFinished {success:false}", (await canceled)?.success === false);
  await t.sleep(300);
  await t.page("setTimeout(() => window.print(), 0); return 1");
  await t.sleep(500);
  t.check("window.print() in the page opens the print sheet", (await wv(t, "_test", { action: "hasSheet" })).value === true);
  await wv(t, "_test", { action: "endSheet" });
  await t.sleep(300);

  // -- alert / confirm / prompt (sheets; answered with respondToDialog)
  const opened = t.waitEvent("jsDialog");
  await t.page("setTimeout(() => { const t0 = performance.now(); alert('hello'); window.__alertMs = performance.now() - t0; }, 0); return 1");
  const od = await opened;
  t.check("alert → jsDialog event, sheet shown", od?.type === "alert" && od.message === "hello" && od.windowId === 0 && (await wv(t, "_test", { action: "hasSheet" })).value === true, od);
  t.check("getDialog", (await wv(t, "getDialog")).value?.type === "alert");
  await t.sleep(250);
  t.check("respondToDialog (alert)", (await wv(t, "respondToDialog")).value?.type === "alert");
  t.check("alert() blocked the page until answered", (await t.page<number>("return window.__alertMs")) >= 200);
  let next = t.waitEvent("jsDialog");
  await t.page("setTimeout(() => { window.__c = confirm('sure?'); }, 0); return 1");
  t.check("confirm → jsDialog", (await next)?.type === "confirm");
  await wv(t, "respondToDialog", { accept: false });
  t.check("confirm Cancel → false", (await t.page("return window.__c")) === false);
  next = t.waitEvent("jsDialog");
  await t.page("setTimeout(() => { window.__c2 = confirm('again?'); }, 0); return 1");
  await next;
  await wv(t, "respondToDialog", { accept: true });
  t.check("confirm OK → true", (await t.page("return window.__c2")) === true);
  next = t.waitEvent("jsDialog");
  await t.page("setTimeout(() => { window.__p = prompt('name?', 'def'); }, 0); return 1");
  t.check("prompt → jsDialog with defaultValue", (await next)?.defaultValue === "def");
  await wv(t, "respondToDialog", { text: "typed" });
  t.check("prompt returns typed text", (await t.page("return window.__p")) === "typed");
  next = t.waitEvent("jsDialog");
  await t.page("setTimeout(() => { window.__p2 = prompt('name?'); }, 0); return 1");
  await next;
  await wv(t, "respondToDialog", { accept: false });
  t.check("prompt Cancel → null", (await t.page("return window.__p2")) === null);
  t.check("respondToDialog with none open → unavailable", (await wv(t, "respondToDialog")).error?.code === "unavailable");

  // -- open files (through the real application:openURLs: hook)
  await wv(t, "_test", { action: "resetPageReady", value: false }); // as on a cold launch
  const of = t.waitEvent("openFiles"), ou = t.waitEvent("openUrls", 1000);
  await wv(t, "_test", { action: "openFiles", paths: ["/tmp/a.md", "/tmp/b c.md"], urls: ["harness-test://open"] });
  t.check("openFiles {paths}", JSON.stringify((await of)?.paths) === '["/tmp/a.md","/tmp/b c.md"]');
  t.check("scheme URLs still go to openUrls, without the files", JSON.stringify((await ou)?.urls) === '["harness-test://open"]');
  t.check("app.getOpenedFiles returns the cold-launch queue", JSON.stringify((await t.call("app", "getOpenedFiles")).value?.paths) === '["/tmp/a.md","/tmp/b c.md"]');
  t.check("…and clears it", (await t.call("app", "getOpenedFiles")).value?.paths.length === 0);
  await wv(t, "_test", { action: "resetPageReady", value: true });
  await wv(t, "_test", { action: "openFiles", paths: ["/tmp/warm.md"] });
  t.check("after a page is ready: event only, no queue", (await t.call("app", "getOpenedFiles")).value?.paths.length === 0);
  t.skip("double-click a document in Finder", "needs a bundled app with CFBundleDocumentTypes");

  // -- page bridge
  const pz = await t.pageCall("webview", "getZoom");
  t.check("page bridge: webview.getZoom resolves the caller window", (pz as any).ok && (pz as any).value.zoom === 1, pz);
  const pj = await t.pageCall("webview", "executeJavaScript", { code: "document.title" });
  t.check("page bridge: webview.executeJavaScript", (pj as any).value === "harness", pj);

  // -- misc webContents parity
  const info = (await wv(t, "getInfo")).value;
  t.check("getInfo", info?.url === origin + "/" && info.windowId === 0 && info.contextMenu === "none" && info.fileDrop === true, info);
  t.check("setUserAgent / getUserAgent", (await wv(t, "setUserAgent", { userAgent: "HarnessUA/1.0" })).ok && (await wv(t, "getUserAgent")).value === "HarnessUA/1.0");
  await wv(t, "setUserAgent", { userAgent: "" });
  t.check("user agent reset", String((await wv(t, "getUserAgent")).value).includes("AppleWebKit"));
  const insp = await wv(t, "setInspectable", { enabled: false });
  t.check("setInspectable → ok or unsupported (< 13.3)", insp.ok || insp.error?.code === "unsupported", insp);
  t.check("goBack with no history", (await wv(t, "goBack")).value?.navigated === false);
  t.check("unknown windowId → invalid_args", (await wv(t, "getZoom", { windowId: 999 })).error?.code === "invalid_args");

  // -- popovers get the same features, events carry popoverId
  const pready = t.waitEvent("popoverReady", 6000);
  await t.call("popover", "create", { id: "wvpop", route: "/?in=popover", width: 300, height: 200 });
  await pready;
  t.check("popover: UI delegate installed", (await wv(t, "_test", { action: "uiDelegate", popoverId: "wvpop" })).value === "SDUIDelegate");
  t.check("popover: getInfo carries popoverId", (await wv(t, "getInfo", { popoverId: "wvpop" })).value?.popoverId === "wvpop");
  const pdrop = t.waitEvent("fileDrop");
  await wv(t, "_test", { action: "fileDrop", popoverId: "wvpop", paths: ["/etc/hosts"], x: 1, y: 2 });
  t.check("popover: fileDrop {popoverId}", (await pdrop)?.popoverId === "wvpop");
  const pclose = t.waitEvent("closeRequested");
  await wv(t, "executeJavaScript", { popoverId: "wvpop", code: "window.close(); 1" });
  t.check("popover: window.close() → closeRequested {popoverId}", (await pclose)?.popoverId === "wvpop");
  t.check("unknown popoverId → invalid_args", (await wv(t, "getZoom", { popoverId: "zzz" })).error?.code === "invalid_args");
  await t.call("popover", "destroy", { id: "wvpop" });

  // -- window.close() in a page closes its window (close veto still applies)
  const w2 = await t.call("window", "create", { label: "wv-second", width: 300, height: 200, path: "/" });
  await t.sleep(800);
  const closed = t.waitEvent("closed");
  await wv(t, "executeJavaScript", { windowId: w2.value?.windowId, code: "window.close(); 1" });
  t.check("window.close() in the page closes the window", (await closed)?.windowId === w2.value?.windowId);

  // -- reload (last: it reloads the harness page)
  t.check("reload", (await wv(t, "reload")).ok);
  await t.sleep(800);
  t.check("page back after reload", (await t.page("return 7")) === 7);

  t.skip("getUserMedia permission", "needs Info.plist usage strings (bundled app) and a TCC prompt");
  rmSync(dir, { recursive: true, force: true });
};
