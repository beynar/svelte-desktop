// webview.* on WebKitGTK: the implemented subset (zoom, JS, snapshots, navigation, UA, inspector).
import type { Harness } from "../harness-worker.ts";

const wv = (t: Harness, op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);

export default async (t: Harness) => {
  t.check("setZoom 1.5", (await wv(t, "setZoom", { zoom: 1.5 })).value?.zoom === 1.5);
  t.check("getZoom", (await wv(t, "getZoom")).value?.zoom === 1.5);
  t.check("page sees the zoom (innerWidth shrinks)", (await t.page<number>("return window.innerWidth")) < 600);
  t.check("setZoom bad → invalid_args", (await wv(t, "setZoom", { zoom: -1 })).error?.code === "invalid_args");
  await wv(t, "setZoom", { zoom: 1 });

  t.check("executeJavaScript expression", (await wv(t, "executeJavaScript", { code: "1 + 2" })).value === 3);
  t.check("executeJavaScript JSON value", JSON.stringify((await wv(t, "executeJavaScript", { code: "({ a: [1, 'x', null], b: true })" })).value) === '{"a":[1,"x",null],"b":true}');
  t.check("executeJavaScript awaits promises", (await wv(t, "executeJavaScript", { code: "new Promise(r => setTimeout(() => r('later'), 30))" })).value === "later");
  t.check("executeJavaScript undefined → null", (await wv(t, "executeJavaScript", { code: "void 0" })).value === null);
  const thrown = await wv(t, "executeJavaScript", { code: "throw new Error('boom')" });
  t.check("executeJavaScript error → internal with the message", thrown.error?.code === "internal" && /boom/.test(thrown.error.message), thrown);
  t.check("executeJavaScript without code → invalid_args", (await wv(t, "executeJavaScript", {})).error?.code === "invalid_args");
  t.check("window.eval", (await t.call("window", "eval", { js: "document.title" })).value === "harness");

  const shot = await wv(t, "capturePage");
  const png = shot.ok ? Buffer.from(shot.value.data, "base64") : Buffer.alloc(0);
  t.check("capturePage → PNG of the visible page", shot.ok && shot.value.format === "png" && png.subarray(1, 4).toString() === "PNG" && shot.value.width > 600 && shot.value.height > 300, shot.ok ? { w: shot.value.width, h: shot.value.height, bytes: png.length } : shot);
  await t.page(`document.body.style.background = 'rgb(255, 0, 0)'; return 1`);
  await t.sleep(150);
  const red = await wv(t, "capturePage", { rect: { x: 300, y: 300, width: 10, height: 10 } });
  t.check("capturePage rect (CSS px) → 10×10", red.ok && red.value.width === 10 && red.value.height === 10, red.ok ? red.value.width + "x" + red.value.height : red);
  // Decode the pixel with the page itself (no image library here).
  const px = red.ok ? await t.page<number[]>(`const img = new Image(); img.src = 'data:image/png;base64,${red.value.data}'; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 10; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return [...g.getImageData(5, 5, 1, 1).data]`) : [];
  t.check("captured pixels are the page's (red background)", px[0] > 240 && px[1] < 20 && px[2] < 20, px);
  await t.page(`document.body.style.background = ''; return 1`);
  const jpeg = await wv(t, "capturePage", { format: "jpeg", width: 200, quality: 0.5 });
  t.check("capturePage jpeg scaled to width 200", jpeg.ok && jpeg.value.format === "jpeg" && jpeg.value.width === 200 && Buffer.from(jpeg.value.data, "base64")[0] === 0xff, jpeg.ok ? jpeg.value.width : jpeg);

  const info = (await wv(t, "getInfo")).value;
  t.check("getInfo", info?.windowId === 0 && info.url?.startsWith("http://127.0.0.1:") && info.title === "harness" && info.loading === false && info.zoom === 1, info);
  t.check("setUserAgent", (await wv(t, "setUserAgent", { userAgent: "HarnessUA/1.0" })).ok && (await wv(t, "getUserAgent")).value === "HarnessUA/1.0");
  await wv(t, "reload");
  await t.sleep(800);
  t.check("reload applies the UA to the page", (await t.page("return navigator.userAgent")) === "HarnessUA/1.0");
  await wv(t, "setUserAgent", { userAgent: "" });
  t.check("setUserAgent '' restores WebKit's default", /AppleWebKit/.test((await wv(t, "getUserAgent")).value ?? ""));
  t.check("setInspectable", (await wv(t, "setInspectable", { enabled: true })).value?.inspectable === true && (await wv(t, "getInfo")).value.inspectable === true);
  await wv(t, "setInspectable", { enabled: false });
  await t.page(`history.pushState({}, '', '/?step2'); return 1`);
  t.check("goBack", (await wv(t, "goBack")).value?.navigated === true);
  await t.sleep(300);
  t.check("goForward", (await wv(t, "goForward")).value?.navigated === true);
  t.check("stop", (await wv(t, "stop")).ok);
  t.check("unknown popoverId → invalid_args", (await wv(t, "getZoom", { popoverId: "nope" })).error?.code === "invalid_args");
  t.check("getOpenedFiles", Array.isArray((await wv(t, "getOpenedFiles")).value?.paths));
  for (const op of ["find", "setContextMenu", "download", "print", "printToPDF", "setFileDrop"])
    t.check(`${op} → unsupported on Linux`, (await wv(t, op, { text: "x", mode: "none", url: "/x", path: "/tmp/x", enabled: true })).error?.code === "unsupported");
  const viaPage = (await t.pageCall("webview", "executeJavaScript", { code: "location.pathname" })) as any;
  t.check("page bridge: webview.executeJavaScript targets the caller", viaPage.ok && typeof viaPage.value === "string", viaPage);
};
