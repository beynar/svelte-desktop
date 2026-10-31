import { JSCallback, FFIType, type Pointer } from "bun:ffi";
import { openNative, cstr, takeString, type Native } from "../src/ffi.ts";

declare var self: Worker;

export type Reply = { ok: boolean; value?: any; error?: { code: string; message: string } };
export interface Harness {
  /** Call through the Worker transport (FFI). */
  call(service: string, op: string, args?: Record<string, unknown>): Promise<Reply>;
  /** Call from inside the page through window.__shell (origin-checked bridge). */
  pageCall(service: string, op: string, args?: Record<string, unknown>): Promise<Reply>;
  /** Evaluate JS in the page and get its JSON result back. */
  page<T = unknown>(js: string): Promise<T>;
  /** Platform events received so far, by name. */
  events: Map<string, any[]>;
  waitEvent(name: string, ms?: number): Promise<any | null>;
  check(name: string, pass: unknown, detail?: unknown): void;
  /** Mark as not testable here (needs a bundle, a permission prompt, a human...). */
  skip(name: string, why: string): void;
  sleep(ms: number): Promise<void>;
  native: Native;
  windowId: number;
}

self.onmessage = async (e: MessageEvent) => {
  const { lib, windowId, suite, keepOpen } = e.data;
  const native = openNative(lib);
  const pending = new Map<number, (r: Reply) => void>();
  const events = new Map<string, any[]>();
  const waiters = new Map<string, Array<(d: any) => void>>();
  let readyResolve: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));

  const sink = new JSCallback(
    (p: Pointer) => {
      const ev = JSON.parse(takeString(native, p));
      if (ev.type === "platformResult") pending.get(ev.id)?.(ev), pending.delete(ev.id);
      else if (ev.type === "platform") {
        (events.get(ev.name) ?? events.set(ev.name, []).get(ev.name)!).push(ev.data);
        for (const w of waiters.get(ev.name)?.splice(0) ?? []) w(ev.data);
      } else if (ev.type === "ready") readyResolve();
    },
    { args: [FFIType.ptr], returns: FFIType.void, threadsafe: true },
  );
  native.shell_set_event_sink(sink.ptr!);

  const pageResults = new Map<string, (v: any) => void>();
  let seq = 1;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/result") {
        const { key, value } = await req.json();
        pageResults.get(key)?.(value);
        return new Response("ok");
      }
      if (url.pathname === "/download.txt") {
        // ?slow → 10 × 64 KB chunks, 150 ms apart (progress / cancel tests).
        const chunk = "harness download\n".repeat(url.searchParams.has("slow") ? 3855 : 64);
        const body = !url.searchParams.has("slow") ? chunk : new ReadableStream({
          async pull(c) { await Bun.sleep(150); c.enqueue(new TextEncoder().encode(chunk)); if (++sent === 10) c.close(); },
        });
        let sent = 0;
        return new Response(body, {
          headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="harness-download.txt"',
            ...(url.searchParams.has("slow") ? { "content-length": String(chunk.length * 10) } : {}) },
        });
      }
      return new Response(
        `<!doctype html><title>harness</title><body style="font:13px system-ui;padding:1em"><h3>platform harness</h3><pre id=log></pre>
<script>
  // Minimal page-side bus over the native bridge.
  const pending = new Map(); let id = 1;
  window.__shell.setSink((name, data) => {
    if (name === 'platformResult') { pending.get(data.id)?.(data); pending.delete(data.id); }
  });
  window.pcall = (service, op, args = {}) => new Promise((res) => {
    const n = id++; pending.set(n, res); window.__shell.post({ id: n, service, op, args });
  });
  window.report = (key, value) => fetch('/result', { method: 'POST', body: JSON.stringify({ key, value }) });
</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  native.shell_set_app_origin(cstr(origin));
  native.shell_window_navigate(windowId, cstr(origin + "/"));
  await Promise.race([ready, Bun.sleep(5000)]);

  let failed = 0, passed = 0, skipped = 0;
  let callId = 1;
  const t: Harness = {
    native,
    windowId,
    events,
    call(service, op, args = {}) {
      const id = callId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        native.shell_platform_call(cstr(JSON.stringify({ id, service, op, args })));
        setTimeout(() => pending.has(id) && (pending.delete(id), resolve({ ok: false, error: { code: "timeout", message: "no reply in 8s" } })), 8000);
      });
    },
    page(js) {
      const key = `k${seq++}`;
      return new Promise((resolve) => {
        pageResults.set(key, resolve);
        native.shell_window_eval(windowId, cstr(`(async()=>{try{report(${JSON.stringify(key)}, await (async()=>{${js}})())}catch(e){report(${JSON.stringify(key)},{__error:String(e)})}})()`));
        setTimeout(() => resolve({ __error: "page timeout" } as any), 8000);
      });
    },
    pageCall(service, op, args = {}) {
      return t.page(`return await pcall(${JSON.stringify(service)}, ${JSON.stringify(op)}, ${JSON.stringify(args)})`);
    },
    waitEvent(name, ms = 3000) {
      return new Promise((resolve) => {
        (waiters.get(name) ?? waiters.set(name, []).get(name)!).push(resolve);
        setTimeout(() => resolve(null), ms);
      });
    },
    check(name, pass, detail) {
      pass ? passed++ : failed++;
      console.log(JSON.stringify({ check: name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }));
    },
    skip(name, why) {
      skipped++;
      console.log(JSON.stringify({ check: name, skip: why }));
    },
    sleep: (ms) => Bun.sleep(ms),
  };

  try {
    const mod = await import(suite);
    await mod.default(t);
  } catch (err) {
    t.check("suite threw", false, String((err as Error)?.stack ?? err));
  }
  console.log(JSON.stringify({ summary: { passed, failed, skipped } }));
  postMessage({ type: "done", failed });
  if (!keepOpen) native.shell_quit();
};
