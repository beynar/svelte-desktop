// Runs on a Worker thread: owns Bun.serve and talks to the UI only through the
// thread-safe shell_* shims (never the raw webview_* calls, which are UI-thread only).
import { open, cstr } from "./ffi.ts";

declare var self: Worker;
const t0 = Number(process.env.SPIKE_T0 ?? performance.timeOrigin);
const log = (msg: string) => postMessage({ log: `[worker +${(Date.now() - t0).toFixed(0)}ms] ${msg}` });

self.onmessage = async (e: MessageEvent<{ lib: string; w: number; entry?: string }>) => {
  const { lib, w } = e.data;
  const ui = open(lib);
  const results: Record<string, unknown> = {};

  const keepOpen = process.env.SPIKE_KEEP_OPEN === "1";
  const finish = () => {
    postMessage({ results });
    const rows = Object.entries(results).map(([k, v]: any) => `<li><b>${k}</b> +${Math.round(v.atMs)}ms <code>${String(v.detail ?? "").replace(/[<&]/g, "")}</code></li>`).join("");
    ui.shell_eval_async(w as any, cstr(`document.getElementById('s').innerHTML = ${JSON.stringify(`<ul>${rows}</ul><p>pid ${process.pid} · Bun ${Bun.version} · close the window to quit</p>`)}`));
    if (keepOpen) return;
    // webview_terminate is documented thread-safe; it makes webview_run return on the UI thread.
    setTimeout(() => ui.webview_terminate(w as any), 50);
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/beacon") {
        const ev = url.searchParams.get("ev")!;
        results[ev] = { atMs: Date.now() - t0, detail: url.searchParams.get("d") };
        log(`beacon ${ev} ${url.searchParams.get("d") ?? ""}`);
        if (ev === "loaded") {
          // T2: worker -> UI push through the dispatch shim.
          ui.shell_set_title_async(w as any, cstr("pushed-from-worker"));
          ui.shell_eval_async(w as any, cstr(`fetch('/beacon?ev=pushed&d='+encodeURIComponent(document.title))`));
        }
        if (ev === "bound") finish();
        return new Response("ok");
      }
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    },
  });
  log(`serving ${server.url}`);
  ui.shell_navigate_async(w as any, cstr(server.url.href));
};

const PAGE = `<!doctype html><title>spike</title><body style="font:16px system-ui;padding:2em">
<h1>Bun Worker + WKWebView spike</h1><p id=s>loading…</p>
<script>
  fetch('/beacon?ev=loaded&d=' + encodeURIComponent(navigator.userAgent.slice(0, 60)));
  // T3: page -> UI-thread JS via webview_bind, after the push round-trip.
  setTimeout(async () => {
    try {
      const r = await window.__shell_ping({ hello: 'from page' });
      fetch('/beacon?ev=bound&d=' + encodeURIComponent(JSON.stringify(r)));
    } catch (err) {
      fetch('/beacon?ev=bound&d=ERR' + encodeURIComponent(String(err)));
    }
  }, 300);
</script>`;
