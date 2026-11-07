import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planRoutes, writeRoutes } from "./routes-overlay.js";

const root = mkdtempSync(join(tmpdir(), "routes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(files: string[]) {
  const dir = join(root, String(n++));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
}
const seen = (plan: Map<string, string> | null, dir: string) => (plan ? Object.fromEntries([...plan].map(([as, file]) => [as.replaceAll("\\", "/"), file.slice(dir.length + 1).replaceAll("\\", "/")])) : null);

describe("planRoutes", () => {
  test("a project using none of it keeps its own folder", () => {
    const dir = project(["+page.svelte", "a/+page.ts", "a/helper.ts"]);
    expect(planRoutes(dir, "web")).toBeNull();
    expect(planRoutes(dir, "desktop")).toBeNull();
    expect(planRoutes(dir, "desktop", ["/nothing-here/**"])).toBeNull();
  });

  test("a variant takes the place of its file on the desktop, and the website doesn't see it", () => {
    const dir = project(["a/+page.svelte", "a/+page.desktop.svelte", "a/+page.server.ts", "a/+page.server.desktop.ts", "a/+page.ts", "a/+layout.svelte", "only/+page.desktop.svelte", "a/+page.test.ts", "a/helper.ts"]);
    expect(seen(planRoutes(dir, "desktop"), dir)).toEqual({
      "a/+page.svelte": "a/+page.desktop.svelte",
      "a/+page.server.ts": "a/+page.server.desktop.ts",
      "a/+page.ts": "a/+page.ts",
      "a/+layout.svelte": "a/+layout.svelte",
      "only/+page.svelte": "only/+page.desktop.svelte",
    });
    expect(seen(planRoutes(dir, "web"), dir)).toEqual({ "a/+page.svelte": "a/+page.svelte", "a/+page.server.ts": "a/+page.server.ts", "a/+page.ts": "a/+page.ts", "a/+layout.svelte": "a/+layout.svelte" });
  });

  test("a component's variant isn't its module's, and a layout reset is the same page", () => {
    const dir = project(["+page.svelte", "+page.ts", "+page.desktop.ts", "b/+page@.svelte", "b/+page.desktop.svelte"]);
    expect(seen(planRoutes(dir, "desktop"), dir)).toEqual({ "+page.svelte": "+page.svelte", "+page.ts": "+page.desktop.ts", "b/+page.svelte": "b/+page.desktop.svelte" });
  });

  test("exclude: a route alone, a whole subtree, and only on the desktop", () => {
    const dir = project(["+page.svelte", "admin/+layout.svelte", "admin/+page.svelte", "admin/users/+page.svelte", "(marketing)/pricing/+page.svelte", "api/+server.ts", "api/v1/+server.ts"]);
    expect(seen(planRoutes(dir, "desktop", ["/admin", "/(marketing)/**", "/api/**"]), dir)).toEqual({ "+page.svelte": "+page.svelte", "admin/+layout.svelte": "admin/+layout.svelte", "admin/users/+page.svelte": "admin/users/+page.svelte" });
    expect(planRoutes(dir, "web", ["/admin", "/(marketing)/**"])).toBeNull();
  });

  test("exclude: a wildcard in a segment, and at any depth", () => {
    const dir = project(["+page.svelte", "a/debug/+page.svelte", "b/c/debug/+page.svelte", "admin-x/+page.svelte", "admin-y/+page.svelte", "keep/+page.svelte"]);
    expect(Object.keys(seen(planRoutes(dir, "desktop", ["**/debug/**", "/admin-*/**"]), dir)!).sort()).toEqual(["+page.svelte", "keep/+page.svelte"]);
  });
});

describe("writeRoutes", () => {
  test("holds exactly these links, and leaves alone what didn't change", () => {
    const dir = project(["x/+page.svelte", "x/+page.desktop.svelte", "y/+page.svelte"]);
    const out = join(dir, "out");
    const link = (as: string, file: string) => [join(as), join(dir, file)] as const;
    writeRoutes(out, new Map([link("x/+page.svelte", "x/+page.svelte"), link("y/+page.svelte", "y/+page.svelte")]));
    expect(readlinkSync(join(out, "x/+page.svelte"))).toBe(join(dir, "x/+page.svelte"));
    const before = lstatSync(join(out, "y/+page.svelte"), { bigint: true }).ino;

    writeRoutes(out, new Map([link("x/+page.svelte", "x/+page.desktop.svelte"), link("y/+page.svelte", "y/+page.svelte")]));
    expect(readlinkSync(join(out, "x/+page.svelte"))).toBe(join(dir, "x/+page.desktop.svelte"));
    expect(lstatSync(join(out, "y/+page.svelte"), { bigint: true }).ino).toBe(before);

    writeRoutes(out, new Map([link("x/+page.svelte", "x/+page.desktop.svelte")]));
    expect(existsSync(join(out, "y"))).toBe(false);
  });
});
