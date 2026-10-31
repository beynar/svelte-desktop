// The self-hosted push contract as tests, run against both servers: push-server.test.ts (Bun)
// and packages/push-worker/test/worker.test.ts (Cloudflare, in workerd or deployed).
import { expect } from "bun:test";
import { join } from "node:path";
import { createPushClient } from "./client.ts";
import type { WirePushMessage } from "./protocol.ts";
import { createPush, generateVapidKeys, PushError } from "./server.ts";

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(25);
  return ok();
};

function device(base: string, file: string, extra: Partial<Parameters<typeof createPushClient>[0]> = {}) {
  const got: WirePushMessage[] = [];
  let open = false;
  const client = createPushClient({ server: base, file, onMessage: (m) => void got.push(m), onState: (s) => (open = s === "open"), ...extra });
  return { client, got, isOpen: () => open };
}

/** Subscribe, encrypted delivery, offline queue with Topic dedupe, TTL, ack, VAPID lock, unsubscribe. */
export async function deliveryContract(base: string, dir: string) {
  const vapid = await generateVapidKeys();
  const file = join(dir, "device.json");
  const a = device(base, file, { applicationServerKey: vapid.publicKey });
  // Concurrent registrations share one identity.
  const [t1, t2] = await Promise.all([a.client.register(), a.client.register()]);
  expect(t2).toEqual(t1);
  const target = t1;
  expect(await until(a.isOpen)).toBe(true);

  const push = createPush({ webpush: { ...vapid, subject: "mailto:ops@example.com" } });
  await push.send(target, { id: "msg-1", title: "Alice", body: "Lunch?", url: "/chat/1", data: { n: 1 } });
  expect(await until(() => a.got.length === 1)).toBe(true);
  expect(a.got[0]).toMatchObject({ id: "msg-1", title: "Alice", body: "Lunch?" });
  expect(JSON.parse(String(a.got[0].payload))).toEqual({ url: "/chat/1", data: { n: 1 } });

  // Offline: queued; the same id (Topic) replaces → delivered once, the latest. TTL 0 → dropped.
  // A 1-second TTL expires (no minimum lifetime).
  a.client.stop();
  await Bun.sleep(300);
  await push.send(target, { id: "msg-2", title: "Bob", body: "first" });
  await push.send(target, { id: "msg-2", title: "Bob", body: "second" });
  await push.send(target, { id: "msg-3", title: "Carol", body: "other" });
  await push.send(target, { id: "now-or-never", title: "x", ttl: 0 });
  await push.send(target, { id: "short", title: "x", ttl: 1 });
  await Bun.sleep(2200);
  // The persisted keys survive a restart (a new client on the same file).
  const b = device(base, file);
  b.client.start();
  expect(await until(() => b.got.length === 2)).toBe(true);
  await Bun.sleep(300);
  expect(b.got.map((m) => `${m.id}:${m.body}`)).toEqual(["msg-2:second", "msg-3:other"]);

  // Acked → not delivered again.
  b.client.stop();
  await Bun.sleep(300);
  // A handler that fails leaves the message on the server: delivered again next time.
  let fail = true;
  const c = device(base, file, { onMessage: (m) => { if (fail) throw new Error("not now"); b.got.push(m); } });
  await push.send(target, { id: "retry-me", title: "Dan", body: "again" });
  c.client.start();
  await until(c.isOpen);
  await Bun.sleep(500);
  c.client.stop();
  await Bun.sleep(300);
  fail = false;
  const d = device(base, file, { onMessage: (m) => void b.got.push(m) });
  d.client.start();
  expect(await until(() => b.got.length === 3)).toBe(true);
  await Bun.sleep(300);
  expect(b.got.map((m) => m.id)).toEqual(["msg-2", "msg-3", "retry-me"]);

  // Live delivery after reconnections.
  await push.send(target, { id: "msg-4", title: "Eve", body: "live" });
  expect(await until(() => b.got.length === 4)).toBe(true);

  // VAPID-locked subscription.
  const intruder = createPush({ webpush: { ...(await generateVapidKeys()), subject: "mailto:evil@example.com" } });
  const denied = await intruder.send(target, { title: "spam" }).catch((e) => e);
  expect(denied).toBeInstanceOf(PushError);
  expect(denied.status).toBe(401);

  // Unsubscribed → 410 → `expired` for the sender.
  await d.client.unregister();
  const gone = await push.send(target, { title: "late" }).catch((e) => e);
  expect(gone).toBeInstanceOf(PushError);
  expect(gone.status).toBe(410);
  expect(gone.expired).toBe(true);
  expect(d.client.target()).toBeNull();
}

/** Requests refused at the door, before any effect. */
export async function refusalContract(base: string) {
  const secret = "0123456789abcdef0123";
  const auth = { authorization: `Bearer ${secret}` };
  const sub = (await (await fetch(`${base}/v1/subscribe`, { method: "POST", headers: auth })).json()) as { id: string; endpoint: string };
  const unknown = sub.endpoint.replace(/[\w-]+$/, "unknown");
  expect((await fetch(unknown, { method: "POST" })).status).toBe(404);
  expect((await fetch(sub.endpoint, { method: "POST", headers: { ttl: "60" }, body: "hello" })).status).toBe(415);
  expect((await fetch(sub.endpoint, { method: "POST", headers: { "content-encoding": "aes128gcm", topic: "not a topic!" }, body: "x" })).status).toBe(400);
  expect((await fetch(sub.endpoint, { method: "POST", headers: { "content-encoding": "aes128gcm", ttl: "-1" }, body: "x" })).status).toBe(400);
  expect((await fetch(sub.endpoint, { method: "POST", headers: { "content-encoding": "aes128gcm" }, body: new Uint8Array(5000) })).status).toBe(413);
  for (const body of ["null", "{", "[]", '{"applicationServerKey":"%%%"}', '{"applicationServerKey":"AAAA"}'])
    expect((await fetch(`${base}/v1/subscribe`, { method: "POST", headers: auth, body })).status).toBe(400);
  expect((await fetch(`${base}/v1/subscribe`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base}/v1/subscribe`, { method: "POST", headers: { authorization: "Bearer short" } })).status).toBe(401);
  expect((await fetch(`${base}/v1/connect`)).status).toBe(401);
  expect((await fetch(`${base}/v1/subscriptions/${sub.id}`, { headers: auth })).status).toBe(200);
  expect((await fetch(`${base}/v1/subscriptions/${sub.id}`, { headers: { authorization: "Bearer someone-else-0000" } })).status).toBe(404);
}
