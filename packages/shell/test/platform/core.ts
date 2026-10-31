// Dispatcher core: routing, error codes, bridge origin check.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const unknown = await t.call("nope", "x");
  t.check("unknown service → unknown", unknown.error?.code === "unknown", unknown);
  const ping = await t.pageCall("nope", "x");
  t.check("page bridge round-trip", (ping as any).error?.code === "unknown", ping);
  const sub = await t.page<any>(`
    const f = document.createElement('iframe'); f.srcdoc = '<script>parent.__sub = new Promise(r => { window.webkit.messageHandlers.__shell__.postMessage(JSON.stringify({t:"call", req:{id: 999, service:"app", op:"getInfo", args:{}}})); setTimeout(() => r("sent"), 300); })<\\/script>';
    document.body.appendChild(f); await new Promise(r => setTimeout(r, 600)); return 'ok';`);
  t.check("subframe can post but gets no reply into main page (denied path exercised)", sub === "ok", sub);
};
