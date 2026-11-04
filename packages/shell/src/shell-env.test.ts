import { expect, test } from "bun:test";
import { shellEnv, which } from "./shell-env.ts";

test.skipIf(process.platform === "win32")("the login shell's environment: PATH and all, read once", async () => {
  const env = await shellEnv();
  expect(env.PATH).toBeString();
  expect(env.HOME).toBe(process.env.HOME!);
  expect(await shellEnv()).toBe(env); // kept
  expect(await which("sh")).toMatch(/\/sh$/);
  expect(await which("no-such-command-anywhere")).toBeNull();
}, 20_000);
