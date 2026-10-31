import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushClient } from "./client.ts";
import { deliveryContract, refusalContract } from "./contract.testkit.ts";
import { servePush } from "./push-server.ts";

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

test("self-hosted push contract (Bun): delivery", () => deliveryContract(base, dir), 30_000);
test("self-hosted push contract (Bun): refusals", () => refusalContract(base));

test("a server that lost the subscription → the client re-subscribes on reconnect and reports the new target", async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;
  let first = servePush({ port, hostname: "127.0.0.1" });
  const targets: string[] = [];
  const client = createPushClient({ server: url, file: join(dir, "rotate.json"), onMessage: () => {}, onTarget: (t) => void targets.push(t.endpoint) });
  const a = await client.register();
  first.stop(true); // the client is left reconnecting…
  first = servePush({ port, hostname: "127.0.0.1" }); // …to a fresh database
  expect(await until(() => targets.length === 2, 8000)).toBe(true);
  expect(targets[1]).not.toBe(a.endpoint);
  expect(client.target()?.endpoint).toBe(targets[1]);
  client.stop();
  first.stop(true);
});

test("unregister keeps the subscription when the server refuses (retryable), forgets it once confirmed", async () => {
  let refuseDelete = true;
  const fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/subscribe") return Response.json({ id: "s1", endpoint: "http://x/v1/push/s1" }, { status: 201 });
      if (req.method === "DELETE") return new Response(null, { status: refuseDelete ? 503 : 204 });
      if (path === "/v1/subscriptions/s1") return Response.json({ id: "s1" });
      return new Response(null, { status: 426 });
    },
  });
  const client = createPushClient({ server: `http://127.0.0.1:${fake.port}`, file: join(dir, "unsub.json"), onMessage: () => {} });
  await client.register();
  expect(await client.unregister().catch((e) => e.message)).toContain("HTTP 503");
  expect(client.target()?.endpoint).toBe("http://x/v1/push/s1");
  refuseDelete = false;
  await client.unregister();
  expect(client.target()).toBeNull();
  fake.stop(true);
});
