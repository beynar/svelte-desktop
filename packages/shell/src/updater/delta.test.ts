import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTreePatch, createTreePatch, diffBytes, patchBytes } from "./delta.ts";

const rand = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return b;
};

test("byte diff: identical, edited, inserted, shrunk, tiny", () => {
  const base = rand(300_000);
  const cases: Uint8Array[] = [
    base,
    (() => { const c = base.slice(); c.set(rand(100, 7), 150_000); return c; })(),
    new Uint8Array([...base.subarray(0, 100_000), ...rand(5000, 3), ...base.subarray(100_000)]),
    base.subarray(0, 200_000),
    new Uint8Array([1, 2, 3]),
  ];
  for (const next of cases) {
    const ops = diffBytes(base, next);
    expect(Buffer.compare(Buffer.from(patchBytes(base, ops)), Buffer.from(next))).toBe(0);
  }
  // an insertion shifts content: the delta stays close to the inserted size
  const shifted = cases[2]!;
  expect(diffBytes(base, shifted).length).toBeLessThan(5000 + 4096 * 2 + 200);
});

test("tree patch: same/delta/new/removed files, dirs, symlinks, modes; tamper detected", () => {
  const root = mkdtempSync(join(tmpdir(), "sdpatch-"));
  const a = join(root, "a/App.app"), b = join(root, "b/App.app");
  mkdirSync(join(a, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(a, "Contents/MacOS/App"), rand(200_000));
  writeFileSync(join(a, "Contents/Info.plist"), "<plist>1</plist>");
  writeFileSync(join(a, "Contents/old.txt"), "gone in b");
  cpSync(a, b, { recursive: true });
  const exe = readFileSync(join(b, "Contents/MacOS/App"));
  exe.set(rand(64, 9), 100_000);
  writeFileSync(join(b, "Contents/MacOS/App"), exe);
  require("node:fs").chmodSync(join(b, "Contents/MacOS/App"), 0o755);
  writeFileSync(join(b, "Contents/new.bin"), rand(10_000, 4));
  symlinkSync("MacOS/App", join(b, "Contents/link"));
  require("node:fs").rmSync(join(b, "Contents/old.txt"));

  const patch = createTreePatch(a, b, { from: "1.0.0", to: "1.1.0", root: "App.app" });
  expect(patch.length).toBeLessThan(20_000);
  const out = join(root, "out/App.app");
  const r = applyTreePatch(patch, a, out);
  expect(r.to).toBe("1.1.0");
  expect(Buffer.compare(readFileSync(join(out, "Contents/MacOS/App")), exe)).toBe(0);
  expect(readFileSync(join(out, "Contents/new.bin")).length).toBe(10_000);
  expect(require("node:fs").readlinkSync(join(out, "Contents/link"))).toBe("MacOS/App");
  expect(require("node:fs").existsSync(join(out, "Contents/old.txt"))).toBe(false);
  expect(require("node:fs").statSync(join(out, "Contents/MacOS/App")).mode & 0o777).toBe(0o755);

  writeFileSync(join(a, "Contents/MacOS/App"), rand(200_000, 99)); // installed copy differs
  expect(() => applyTreePatch(patch, a, join(root, "out2/App.app"))).toThrow(/does not match/);
});
