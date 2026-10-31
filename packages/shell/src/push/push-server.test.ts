import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushClient, type PushPayload } from "./client.ts";
import { servePush } from "./push-server.ts";
import { createPush, generateVapidKeys, PushError } from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "sd-push-"));
const server = servePush({ port: 0, hostname: "127.0.0.1", db: join(dir, "push.sqlite") });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(20);
  return ok();
};

test("self-hosted push: subscribe, end-to-end encrypted delivery, Topic dedupe offline, TTL 0, VAPID, unsubscribe", async () => {
  const vapid = await generateVapidKeys();
  const got: PushPayload[] = [];
  const file = join(dir, "device.json");
  const client = createPushClient({ server: base, file, applicationServerKey: vapid.publicKey, onMessage: (m) => void got.push(m) });
  const target = await client.register();
  expect(target.provider).toBe("webpush");
  expect(target.endpoint).toStartWith(`${base}/v1/push/`);
  expect(await until(() => client.connected)).toBe(true);

  // The app server sends exactly as to a browser push service.
  const push = createPush({ webpush: { ...vapid, subject: "mailto:ops@example.com" } });
  await push.send(target, { id: "msg-1", title: "Alice", body: "Lunch?", url: "/chat/1", data: { n: 1 } });
  expect(await until(() => got.length === 1)).toBe(true);
  expect(got[0]).toMatchObject({ id: "msg-1", title: "Alice", body: "Lunch?" });
  expect(JSON.parse(String(got[0].payload))).toEqual({ url: "/chat/1", data: { n: 1 } });

  // Offline: queued; the same id (Topic) replaces the queued one → delivered once, the latest.
  client.stop();
  await until(() => server.push.connected() === 0);
  await push.send(target, { id: "msg-2", title: "Bob", body: "first" });
  await push.send(target, { id: "msg-2", title: "Bob", body: "second" });
  await push.send(target, { id: "msg-3", title: "Carol", body: "other" });
  // TTL 0 while offline: dropped (RFC 8030).
  await push.send(target, { id: "now-or-never", title: "x", ttl: 0 });
  // The persisted keys survive a "restart" (a new client on the same file).
  const again = createPushClient({ server: base, file, onMessage: (m) => void got.push(m) });
  again.start();
  expect(await until(() => got.length === 3)).toBe(true);
  await Bun.sleep(200);
  expect(got.slice(1).map((m) => `${m.id}:${m.body}`)).toEqual(["msg-2:second", "msg-3:other"]);
  // Acked → not delivered again on the next connection.
  again.stop();
  await until(() => server.push.connected() === 0);
  const third = createPushClient({ server: base, file, onMessage: (m) => void got.push(m) });
  third.start();
  await until(() => third.connected);
  await Bun.sleep(300);
  expect(got.length).toBe(3);

  // VAPID: the subscription is locked to the app server's key.
  const other = await generateVapidKeys();
  const intruder = createPush({ webpush: { ...other, subject: "mailto:evil@example.com" } });
  const denied = await intruder.send(target, { title: "spam" }).catch((e) => e);
  expect(denied).toBeInstanceOf(PushError);
  expect(denied.status).toBe(401);

  // Unsubscribed → 410 → the sender sees `expired`.
  await third.unregister();
  const gone = await push.send(target, { title: "late" }).catch((e) => e);
  expect(gone).toBeInstanceOf(PushError);
  expect(gone.status).toBe(410);
  expect(gone.expired).toBe(true);
  expect(third.target()).toBeNull();
});

test("push server rejects plaintext bodies, unknown subscriptions and bad topics", async () => {
  expect((await fetch(`${base}/v1/push/nope`, { method: "POST" })).status).toBe(404);
  const sub = (await (await fetch(`${base}/v1/subscribe`, { method: "POST", headers: { authorization: "Bearer 0123456789abcdef0123" } })).json()) as { id: string };
  expect((await fetch(`${base}/v1/push/${sub.id}`, { method: "POST", body: "hello" })).status).toBe(415);
  expect((await fetch(`${base}/v1/push/${sub.id}`, { method: "POST", headers: { "content-encoding": "aes128gcm", topic: "not a topic!" }, body: "x" })).status).toBe(400);
  expect((await fetch(`${base}/v1/subscribe`, { method: "POST" })).status).toBe(401);
});

test("a server that lost the subscription (reset, another server at the URL) → the client re-subscribes and reports the new target", async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;
  let first = servePush({ port, hostname: "127.0.0.1" });
  const targets: string[] = [];
  const file = join(dir, "rotate.json");
  const client = createPushClient({ server: url, file, onMessage: () => {}, onTarget: (t) => void targets.push(t.endpoint) });
  const a = await client.register();
  client.stop();
  first.stop(true);
  first = servePush({ port, hostname: "127.0.0.1" }); // fresh database
  const again = createPushClient({ server: url, file, onMessage: () => {}, onTarget: (t) => void targets.push(t.endpoint) });
  again.start(); // validates at startup
  expect(await until(() => targets.length === 2)).toBe(true);
  expect(targets[1]).not.toBe(a.endpoint);
  expect((await again.register()).endpoint).toBe(targets[1]);
  again.stop();
  first.stop(true);
});
