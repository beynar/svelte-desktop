// The Worker in workerd (`wrangler dev`, local Durable Objects + SQLite), driven by the real
// desktop client (shell/src/push/client.ts) and the real sender (createPush): the same
// scenario as the Bun push server's test, so both implementations honour one contract.
import { afterAll, beforeAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryContract, refusalContract } from "../../shell/src/push/contract.testkit.ts";

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

test("self-hosted push contract (Cloudflare): delivery", () => deliveryContract(base, dir), 60_000);
test("self-hosted push contract (Cloudflare): refusals", () => refusalContract(base));
