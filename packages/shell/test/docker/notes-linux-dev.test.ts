// `vite dev` on Linux: the WebKitGTK window on the Vite server, driven through the
// test channel (the Vite-side bridge connects it in dev).
import { afterAll, expect, test } from "bun:test";
import { launch, type AppHandle } from "../../src/test.ts";

let app: AppHandle;
afterAll(() => app?.close());

test("vite dev opens the native window with SSR, remote functions and the platform API", async () => {
  app = await launch({ dev: { cwd: process.cwd() }, timeout: 120_000 });
  await app.waitFor("#counter", { timeout: 60_000 });
  const before = Number(await app.text("#counter"));
  await app.click("button:not([type=button])");
  await app.waitFor((n: number) => Number(document.querySelector("#counter")?.textContent) > n, { timeout: 10_000 }).catch(() => {});
  expect(Number(await app.text("#counter"))).toBeGreaterThan(before);
  expect(await app.platform<string>("app", "getName")).toBe("Svelte Notes");
  expect(app.origin).toMatch(/^http:\/\/localhost:\d+/);
});
