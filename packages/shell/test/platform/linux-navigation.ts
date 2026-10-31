// Navigation policy, page-bridge origin/frame checks and web-process crash
// recovery on WebKitGTK. xdg-open is the recording stand-in from
// test/docker/session.sh (appends its arguments to /tmp/xdg-open.log).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const LOG = "/tmp/xdg-open.log";
const opened = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : []);
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

export default async (t: Harness) => {
  writeFileSync(LOG, "");
  const origin: string = await t.page("return location.origin");
  await t.page("window.__marker = 42; return 1");

  // Other origin, user link click → default browser, window stays.
  await t.page(`const a = document.createElement('a'); a.href = 'https://example.com/clicked'; a.textContent = 'x'; document.body.append(a); a.click(); return 1`);
  t.check("link to another origin → xdg-open", await until(() => opened().includes("https://example.com/clicked")), opened());
  t.check("window stayed on the app page", (await t.page("return location.origin + ':' + window.__marker")) === `${origin}:42`);
  // target=_blank and window.open → default browser.
  await t.page(`const a = document.createElement('a'); a.href = 'https://example.com/blank'; a.target = '_blank'; document.body.append(a); a.click(); return 1`);
  t.check("target=_blank → xdg-open", await until(() => opened().includes("https://example.com/blank")), opened());
  await t.page(`window.open('https://example.com/popup'); return 1`);
  t.check("window.open → xdg-open", await until(() => opened().includes("https://example.com/popup")), opened());
  // Scripted top-level navigation away (no user gesture) is caught at load start.
  await t.page(`setTimeout(() => { location.href = 'https://example.com/scripted' }, 10); return 1`);
  t.check("scripted top-level navigation → xdg-open", await until(() => opened().includes("https://example.com/scripted")), opened());
  await t.sleep(300);
  t.check("…and the page is untouched", (await t.page("return location.origin + ':' + window.__marker")) === `${origin}:42`);
  t.check("mailto: → xdg-open", (await t.page(`location.href = 'mailto:someone@example.com'; return 1`)) === 1 && (await until(() => opened().includes("mailto:someone@example.com"))));
  // Same-origin navigation stays in the window.
  await t.page(`setTimeout(() => { location.href = '/?same' }, 10); return 1`);
  await t.sleep(800);
  t.check("same-origin navigation stays in the window", (await t.page("return location.href")) === `${origin}/?same` && !opened().some((u) => u.includes("?same")));
  t.check("bridge works after navigation", (await t.pageCall("app", "getName") as any).ok);
  // A cross-origin iframe may load (subframe navigations are allowed) but can't use the bridge.
  const frame = await t.page<any>(`
    const f = document.createElement('iframe'); f.src = 'about:blank'; document.body.append(f);
    await new Promise(r => setTimeout(r, 200));
    const w = f.contentWindow;
    return { hasHandler: !!(w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.__shell__), hasBridge: !!w.__shell };`);
  t.check("subframes get no bridge object (top-frame-only script)", frame?.hasBridge === false, frame);
  // A subframe posts a forged call straight to the handler (no nonce); the reply
  // lands in the top page. (Replacing the sink breaks the harness's pcall; the
  // crash test below reloads the page, which restores it.)
  const denied = await t.page<any>(`
    const f = document.createElement('iframe'); f.srcdoc = '<script>window.webkit.messageHandlers.__shell__.postMessage(JSON.stringify({t:"call", req:{id: 4242, service:"app", op:"getName", args:{}}}))<\\/script>';
    const replies = []; window.__shell.setSink((n, d) => { if (n === 'platformResult') replies.push(d); });
    document.body.append(f); await new Promise(r => setTimeout(r, 500)); return replies.find(r => r.id === 4242) ?? null;`);
  t.check("forged subframe call (no nonce) → denied", denied?.ok === false && denied.error?.code === "denied", denied);

  // Web process crash → reload, then ready again.
  await t.page("window.__marker = 7; return 1");
  const kill = await t.call("webview", "_test", { action: "terminate" });
  t.check("terminate web process", kill.ok, kill);
  await t.sleep(1500);
  const after = await t.page<any>("return { marker: window.__marker ?? null, bridge: !!window.__shell }");
  t.check("page reloaded after the web process died (state reset, bridge back)", after?.marker === null && after.bridge === true, after);
  t.check("bridge answers after the reload", (await t.pageCall("app", "getName") as any).ok);
};
