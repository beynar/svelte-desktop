// The Worker in workerd (`wrangler dev`, local Durable Objects + SQLite), driven by the real
// desktop client (shell/src/push/client.ts) and the real sender (createPush): the same
// scenario as the Bun push server's test, so both implementations honour one contract.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushClient, type PushPayload } from "../../shell/src/push/client.ts";
import { createPush, generateVapidKeys, PushError } from "../../shell/src/push/server.ts";

const dir = mkdtempSync(join(tmpdir(), "sd-push-worker-"));
const port = 18000 + Math.floor(Math.random() * 2000);
// PUSH_WORKER_URL=https://svelte-desktop-push.<you>.workers.dev: the same tests against a deployed Worker.
const deployed = process.env.PUSH_WORKER_URL?.replace(/\/+$/, "");
const base = deployed ?? `http://127.0.0.1:${port}`;
let dev: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  if (deployed) return;
  dev = Bun.spawn(["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  for (let i = 0; i < 300; i++) {
    if (await fetch(`${base}/v1/health`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("wrangler dev did not start");
});
afterAll(() => {
  dev?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(25);
  return ok();
};

test("Cloudflare push: subscribe, encrypted delivery over a hibernatable WebSocket, Topic dedupe offline, TTL 0, VAPID, unsubscribe", async () => {
  const vapid = await generateVapidKeys();
  const got: PushPayload[] = [];
  const file = join(dir, "device.json");
  let open = false;
  const client = createPushClient({ server: base, file, applicationServerKey: vapid.publicKey, onMessage: (m) => void got.push(m), onState: (s) => (open = s === "open") });
  const target = await client.register();
  expect(target.endpoint).toMatch(new RegExp(`^${base}/v1/push/[\\w-]{43}/[\\w-]+$`));
  expect(await until(() => open)).toBe(true);

  const push = createPush({ webpush: { ...vapid, subject: "mailto:ops@example.com" } });
  await push.send(target, { id: "msg-1", title: "Alice", body: "Lunch?", url: "/chat/1", data: { n: 1 } });
  expect(await until(() => got.length === 1)).toBe(true);
  expect(got[0]).toMatchObject({ id: "msg-1", title: "Alice", body: "Lunch?" });
  expect(JSON.parse(String(got[0].payload))).toEqual({ url: "/chat/1", data: { n: 1 } });

  // Offline: queued in the Durable Object; the same id (Topic) replaces → delivered once, the latest.
  client.stop();
  await Bun.sleep(300);
  await push.send(target, { id: "msg-2", title: "Bob", body: "first" });
  await push.send(target, { id: "msg-2", title: "Bob", body: "second" });
  await push.send(target, { id: "msg-3", title: "Carol", body: "other" });
  await push.send(target, { id: "now-or-never", title: "x", ttl: 0 }); // TTL 0 while offline: dropped
  const again = createPushClient({ server: base, file, onMessage: (m) => void got.push(m) });
  again.start();
  expect(await until(() => got.length === 3)).toBe(true);
  await Bun.sleep(300);
  expect(got.slice(1).map((m) => `${m.id}:${m.body}`)).toEqual(["msg-2:second", "msg-3:other"]);

  // Acked → not redelivered on the next connection.
  again.stop();
  await Bun.sleep(300);
  let reopened = false;
  const third = createPushClient({ server: base, file, onMessage: (m) => void got.push(m), onState: (s) => (reopened = s === "open") });
  third.start();
  await until(() => reopened);
  await Bun.sleep(500);
  expect(got.length).toBe(3);

  // Live again: the keep-alive ping is answered by the auto-response (no wake-up) and delivery still works.
  await push.send(target, { id: "msg-4", title: "Dan", body: "live" });
  expect(await until(() => got.length === 4)).toBe(true);

  // VAPID-locked subscription.
  const intruder = createPush({ webpush: { ...(await generateVapidKeys()), subject: "mailto:evil@example.com" } });
  const denied = await intruder.send(target, { title: "spam" }).catch((e) => e);
  expect(denied).toBeInstanceOf(PushError);
  expect(denied.status).toBe(401);

  // Unsubscribed → 410 → `expired` for the sender.
  await third.unregister();
  const gone = await push.send(target, { title: "late" }).catch((e) => e);
  expect(gone).toBeInstanceOf(PushError);
  expect(gone.status).toBe(410);
  expect(gone.expired).toBe(true);
});

test("Cloudflare push rejects bad requests", async () => {
  const fake = "a".repeat(43);
  expect((await fetch(`${base}/v1/push/${fake}/nope`, { method: "POST" })).status).toBe(404);
  const secret = "0123456789abcdef0123";
  const sub = (await (await fetch(`${base}/v1/subscribe`, { method: "POST", headers: { authorization: `Bearer ${secret}` } })).json()) as { endpoint: string };
  expect((await fetch(sub.endpoint, { method: "POST", body: "hello" })).status).toBe(415);
  expect((await fetch(sub.endpoint, { method: "POST", headers: { "content-encoding": "aes128gcm", topic: "not a topic!" }, body: "x" })).status).toBe(400);
  expect((await fetch(sub.endpoint, { method: "POST", headers: { "content-encoding": "aes128gcm" }, body: new Uint8Array(9000) })).status).toBe(413);
  expect((await fetch(`${base}/v1/subscribe`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base}/v1/connect`)).status).toBe(401);
});
