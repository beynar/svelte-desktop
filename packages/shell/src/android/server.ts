// Android: the server process. The Java host (native/android) spawns the
// compiled server (lib/<abi>/libappserver.so) with a one-time secret, reads the
// READY line and points its WebView at the gate's auth URL — the same loopback
// gate as desktop (Host check, HttpOnly session cookie).
//
// Page ↔ native: the gate injects ANDROID_BRIDGE into every HTML response
// (before any module script runs). It keeps the desktop API (window.__shell)
// and talks to the host over a WebMessagePort the host posts to the app
// origin's main frame after each page load (WebView.postWebMessage with a
// target origin), so third-party frames never get a channel to native.
//
// Server ↔ native: the server's stdin/stdout, a pipe only the host holds.
// stdout lines `SVELTE_DESKTOP_RPC {id, service, op, args}` are platform calls;
// the host writes `{t:"result", id, ok, …}` and `{t:"platform", name, data}`
// lines back on stdin. Same bus and `desktop` API as the desktop Worker.
import { createDesktopRuntime } from "../desktop-api.ts";
import { startGate } from "../gate.ts";
import { deliverPlatformEvent, initPlatform } from "../platform/bus.ts";
import { installDesktopApi } from "../server.ts";
import { attachTestChannel } from "../test-channel.ts";

type KitHandler = Parameters<typeof startGate>[0]["handler"];

export const PORT_MESSAGE = "__shell_port__";

export const ANDROID_BRIDGE =
  "(()=>{if(window.__shell)return;const out=[];const q=[];let sink=null,port=null;" +
  "const send=(m)=>{const s=JSON.stringify(m);port?port.postMessage(s):out.push(s);};" +
  // Only the host's postWebMessage has no source window; a frame posting a fake port has one.
  `window.addEventListener('message',(e)=>{if(e.data!=='${PORT_MESSAGE}'||e.source!==null||!e.ports||!e.ports[0])return;` +
  // A newer port takes over for new requests; older ones keep delivering their replies.
  "e.stopImmediatePropagation();port=e.ports[0];" +
  "port.onmessage=(ev)=>{try{const m=JSON.parse(ev.data);window.__shell.deliver(m.n,m.d);}catch(err){console.error('[shell] bad message',err);}};" +
  "port.postMessage(JSON.stringify({t:'ready'}));for(const s of out.splice(0))port.postMessage(s);},true);" +
  "window.__shell=Object.freeze({" +
  "post:(req)=>send({t:'call',req:typeof req==='string'?JSON.parse(req):req})," +
  "setSink:(fn)=>{sink=fn;for(const [n,d] of q.splice(0))fn(n,d);}," +
  "deliver:(n,d)=>{sink?sink(n,d):q.push([n,d]);}});})();";

export const RPC_PREFIX = "SVELTE_DESKTOP_RPC ";

function readHostLines(onLine: (line: string) => void, onEnd: () => Promise<void> = async () => {}) {
  // process.stdin rather than Bun.stdin.stream(): the latter stalled on Android
  // after a burst of host messages (reply + event back to back).
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  // stdin closed: the host is gone (activity destroyed) — don't linger.
  process.stdin.on("end", () => void onEnd().finally(() => process.exit(0)));
}

export function startAndroidServer({ handler, routes = {}, app }: { handler: KitHandler; routes?: Record<string, any>; app: { appName: string; identifier: string } }) {
  const secret = process.env.SVELTE_DESKTOP_SECRET;
  if (!secret) throw new Error("SVELTE_DESKTOP_SECRET is required (set by the Android host)");
  const tag = `<script>${ANDROID_BRIDGE}</script>`;
  // E2E: the runner connects to /__desktop/test?t=<token> through `adb forward`
  // (token from the host, debuggable builds only).
  const testToken = process.env.SVELTE_DESKTOP_TEST_LISTEN;
  const frames = new WeakMap<object, (raw: string) => void>();
  let origin = "";
  const gate = startGate({
    ...(testToken && {
      socket: {
        path: "/__desktop/test",
        token: testToken,
        open: (ws) => frames.set(ws, attachTestChannel(ws, { origin, appName: app.appName })),
        message: (ws, data) => frames.get(ws)?.(data),
      },
    }),
    handler,
    routes,
    secret,
    debug: !!process.env.SVELTE_DESKTOP_DEBUG,
    transformHtml: (html) => (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html),
  });

  if (process.env.SVELTE_DESKTOP_ANDROID_HOST) {
    initPlatform({
      platformCall(request: string) {
        process.stdout.write(`${RPC_PREFIX}${request.replace(/\n/g, " ")}\n`);
        return '{"pending":true}';
      },
    });
    const runtime = createDesktopRuntime({ ...app, origin: gate.origin, trackCrashes: true, quit: () => process.stdout.write(`${RPC_PREFIX}{"id":0,"service":"app","op":"quit","args":{}}\n`) });
    installDesktopApi(runtime.api);
    readHostLines((line) => {
      try {
        const m = JSON.parse(line);
        if (m.t === "result") deliverPlatformEvent("platformResult", m);
        else if (m.t === "platform") deliverPlatformEvent(m.name, m.data);
        else if (m.t === "shell") runtime.feed(m.event);
      } catch (err) {
        console.error("[shell] bad host message", err);
      }
    }, () => runtime.runBeforeQuit());
  }
  origin = gate.origin;
  // The host reads this line from stdout.
  console.log(`SVELTE_DESKTOP_ANDROID_READY ${JSON.stringify({ origin: gate.origin, auth: gate.authUrl("/") })}`);
}
