// The package as it would be published (scripts/check-package.ts), and the check itself: a check
// that can't fail proves nothing, so each way the package can be incomplete is tried on a copy.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkPackage } from "../../scripts/check-package.ts";

const shell = join(import.meta.dir, "../..");
const copies: string[] = [];
afterAll(() => copies.forEach((c) => rmSync(c, { recursive: true, force: true })));

/** A copy of what the package is made from, changed, and what the check says about it. */
async function problemsWith(change: (dir: string, pkg: any) => void): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "kitop-package-"));
  copies.push(dir);
  cpSync(shell, dir, { recursive: true, filter: (p) => !/^(node_modules|native\/build|bench|test)(\/|$)/.test(relative(shell, p)) });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  change(dir, pkg);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, "\t"));
  return checkPackage(dir);
}

test("the package is complete", async () => {
  expect(await checkPackage(shell)).toEqual([]);
});

test("stays private, and that line alone stands between it and a publish", async () => {
  const pkg = JSON.parse(readFileSync(join(shell, "package.json"), "utf8"));
  expect(pkg.private).toBe(true);
  expect(await problemsWith((_, p) => delete p.private)).toEqual([]);
});

describe("the docs say what the package requires", () => {
  const docs = join(shell, "../../website/docs");
  const pkg = JSON.parse(readFileSync(join(shell, "package.json"), "utf8"));

  for (const page of ["quickstart.mdx", "reference/versioning.mdx"])
    test(page, () => {
      const text = readFileSync(join(docs, page), "utf8");
      for (const [name, range] of Object.entries<string>(pkg.peerDependencies)) expect(text).toContain(`| \`${name}\` | \`${range}\``);
    });

  test("the installs name the adapter's version", () => {
    const adapter = pkg.peerDependencies["@sveltejs/adapter-bun"];
    for (const page of ["quickstart.mdx", "concepts/adopting.mdx"]) expect(readFileSync(join(docs, page), "utf8")).toContain(`@sveltejs/adapter-bun@${adapter}`);
  });

  test("create names the package: `bunx kitop` before a project is something else's", () => {
    for (const page of new Bun.Glob("**/*.mdx").scanSync(docs)) expect(readFileSync(join(docs, page), "utf8")).not.toContain("bunx kitop create");
  });
});

describe("an incomplete package fails", () => {
  const cases: [string, (dir: string, pkg: any) => void, string][] = [
    ["no files field: native code isn't listed", (_, p) => (p.files = ["bin", "src", "!src/**/*.test.ts", "!src/mcp/fixture-app.ts", "scripts/updater-cli.ts", "CHANGELOG.md"]), "tarball: no native/build-linux.sh"],
    ["a test file shipped", (_, p) => (p.files = p.files.filter((f: string) => f !== "!src/**/*.test.ts")), ".test.ts"],
    ["a missing field", (_, p) => delete p.repository, 'no "repository"'],
    ["a version that isn't one", (_, p) => (p.version = "0.0.1"), "not a release version"],
    ["engines without Bun", (_, p) => (p.engines = {}), "engines.bun"],
    ["unscoped access", (_, p) => (p.publishConfig = {}), "publishConfig.access"],
    ["no changelog entry for the version", (_, p) => (p.version = "9.9.9"), 'no "## 9.9.9" section'],
    ["an export to nowhere", (_, p) => (p.exports["./gone"] = { types: "./src/gone.ts", default: "./src/gone.ts" }), "./src/gone.ts isn't in the tarball"],
    ["a TypeScript export without types", (_, p) => (p.exports["."] = "./src/index.ts"), 'exports["."]: no "types"'],
    ["a .js export with a .d.ts left out", (_, p) => (p.exports["./adapter"] = { default: "./src/adapter.js" }), "src/adapter.d.ts exists"],
    ["a Svelte component without the condition", (_, p) => (p.exports["./platform/MenuBar.svelte"] = { default: "./src/platform/components/MenuBar.svelte" }), 'exports["./platform/MenuBar.svelte"]: no "svelte"'],
    ["an entry leading to runes without the condition", (_, p) => (p.exports["./tabs"] = { types: "./src/tabs/index.ts", default: "./src/tabs/index.ts" }), 'exports["./tabs"]: no "svelte"'],
    ["types after default", (_, p) => (p.exports["."] = { default: "./src/index.ts", types: "./src/index.ts" }), '"types" must come first'],
    ["a bin without its shebang", (d) => writeFileSync(join(d, "bin/kitop.ts"), readFileSync(join(d, "bin/kitop.ts"), "utf8").replace(/^#!.*\n/, "")), "no bun shebang"],
    ["an undeclared dependency", (d) => writeFileSync(join(d, "src/leak.ts"), 'import "left-pad";\n'), "left-pad, which isn't a dependency"],
    ["an import of what isn't shipped", (d) => writeFileSync(join(d, "src/leak.ts"), 'import "../test/harness.ts";\n'), "../test/harness.ts, which isn't in the tarball"],
    ["a self-import that isn't exported", (d) => writeFileSync(join(d, "src/leak.ts"), 'import "@kitop/shell/gone";\n'), "@kitop/shell/gone, which isn't exported"],
    ["a dependency only the repo has", (_, p) => delete p.dependencies["@modelcontextprotocol/client"], "@modelcontextprotocol/client, which isn't a dependency"],
  ];
  for (const [name, change, expected] of cases)
    test(name, async () => {
      expect((await problemsWith(change)).join("\n")).toContain(expected);
    });

  test.skipIf(process.platform === "win32")("a build script that lost its mode", async () => {
    const problems = await problemsWith((d) => require("node:fs").chmodSync(join(d, "native/build-linux.sh"), 0o644));
    expect(problems.join("\n")).toContain("native/build-linux.sh isn't executable");
  });
});
