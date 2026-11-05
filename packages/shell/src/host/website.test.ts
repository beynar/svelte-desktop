import { expect, test } from "bun:test";

test("in a website, host says it isn't the desktop and its calls reject", async () => {
  delete (globalThis as { host?: unknown }).host;
  await import("./website.js");
  const site = (globalThis as unknown as { host: any }).host;
  expect(site.available).toBe(false);
  expect(`${site}`).toBeString(); // reading it doesn't throw, as a template or a log would
  await expect(site.window.setTitle("x")).rejects.toMatchObject({ code: "unavailable", message: "host.window.setTitle needs the desktop app" });
  const member = site.window;
  expect(await Promise.resolve(member)).toBe(member); // not taken for a promise
  delete (globalThis as { host?: unknown }).host;
});
