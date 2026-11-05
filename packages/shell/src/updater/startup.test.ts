import { expect, test } from "bun:test";
import { confirmWhenHealthy, countUpdateLaunch } from "./startup.ts";

const quiet = async <T>(fn: () => Promise<T>) => {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};

test("a launch: nothing to restore, nothing else happens; restored, the previous version starts", async () => {
  let restarts = 0;
  const restart = async () => void restarts++;
  expect(await countUpdateLaunch({ rollbackIfNeeded: async () => false, restart })).toBe(false);
  expect(restarts).toBe(0);
  expect(await quiet(() => countUpdateLaunch({ rollbackIfNeeded: async () => true, restart }))).toBe(true);
  expect(restarts).toBe(1);
});

test("the updater failing doesn't stop the app", async () => {
  const restart = async () => {};
  expect(await quiet(() => countUpdateLaunch({ rollbackIfNeeded: async () => { throw new Error("disk"); }, restart }))).toBe(false);
});

test("confirmed only after a page, and once", async () => {
  let confirms = 0;
  const healthy = confirmWhenHealthy({ confirm: async () => void confirms++ }, 10);
  await Bun.sleep(30);
  expect(confirms).toBe(0); // started, no page yet: not healthy
  healthy.pageReady();
  healthy.pageReady();
  expect(confirms).toBe(0); // a page that crashes at once isn't healthy either
  await Bun.sleep(30);
  expect(confirms).toBe(1);
  await healthy.quitting();
  expect(confirms).toBe(1);
});

test("quitting: a clean quit after a page confirms at once; before a page, it doesn't", async () => {
  let confirms = 0;
  const shown = confirmWhenHealthy({ confirm: async () => void confirms++ }, 60_000);
  shown.pageReady();
  await shown.quitting();
  expect(confirms).toBe(1);
  confirms = 0;
  const never = confirmWhenHealthy({ confirm: async () => void confirms++ }, 10);
  await never.quitting();
  expect(confirms).toBe(0);
});

test("a confirm that fails doesn't take the app down", async () => {
  const healthy = confirmWhenHealthy({ confirm: async () => { throw new Error("disk"); } }, 60_000);
  healthy.pageReady();
  await quiet(() => healthy.quitting());
});
