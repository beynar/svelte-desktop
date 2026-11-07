import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notarySubmit, verifyCodesign } from "./package.ts";

test("notarytool: no answer is tried again, a refusal isn't, and it stops somewhere", async () => {
  const replies = (...outs: string[]) => {
    const asked: string[][] = [];
    return { asked, run: async (argv: string[]) => (asked.push(argv), outs[asked.length - 1] ?? "") };
  };
  const flaky = replies("", "not json", '{"status":"Accepted","id":"1"}');
  expect(await notarySubmit("a.zip", "p", flaky.run, 0)).toMatchObject({ status: "Accepted" });
  expect(flaky.asked.length).toBe(3);
  expect(flaky.asked[0]).toContain("--timeout");

  const invalid = replies('{"status":"Invalid","id":"2"}');
  expect(await notarySubmit("a.zip", "p", invalid.run, 0)).toMatchObject({ status: "Invalid" });
  expect(invalid.asked.length).toBe(1);

  const waitRanOut = replies('{"status":"In Progress"}', '{"status":"In Progress"}', '{"status":"In Progress"}', '{"status":"Accepted"}');
  expect(await notarySubmit("a.zip", "p", waitRanOut.run, 0)).toMatchObject({ status: "In Progress" });
  expect(waitRanOut.asked.length).toBe(3);
});

test.if(process.platform === "darwin")("for real: what doesn't verify stops the build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitop-codesign-"));
  try {
    const file = join(dir, "tool");
    copyFileSync("/usr/bin/true", file);
    expect(Bun.spawnSync(["/usr/bin/codesign", "--force", "-s", "-", file]).exitCode).toBe(0);
    await verifyCodesign(file);
    appendFileSync(file, "tampered");
    await expect(verifyCodesign(file)).rejects.toThrow("doesn't verify after signing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
