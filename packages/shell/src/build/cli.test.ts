// The kitop command itself, run the way a shell runs it: exit codes are part of what it promises.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shell from "../../package.json";

const kitop = join(import.meta.dir, "../../bin/kitop.ts");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kitop-cli-"));
  dirs.push(d);
  return d;
}

function run(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, kitop, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function installed(dir: string, name: string, version: string) {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
}

/** A project with the peers at versions that fit, and a config that loads. */
function project(): string {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", type: "module" }));
  writeFileSync(join(dir, "desktop.config.ts"), "export default { appName: 'App', identifier: 'com.example.app', bridge: { allow: ['app.*'] } };\n");
  installed(dir, "@sveltejs/adapter-bun", "1.0.0-next.2");
  installed(dir, "@sveltejs/kit", "3.1.1");
  installed(dir, "svelte", "5.57.3");
  return dir;
}

describe("kitop create", () => {
  const scaffold = () => {
    const dir = join(tempDir(), "my-app");
    const r = run(tempDir(), "create", dir);
    expect(r.code).toBe(0);
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  };

  test("pins the version it was shipped with", () => {
    expect(scaffold().devDependencies["@kitop/shell"]).toBe(shell.version);
  });

  test("asks for what the package's peers ask for", () => {
    const { devDependencies } = scaffold();
    for (const [name, range] of Object.entries(shell.peerDependencies)) expect(devDependencies[name]).toBe(range);
  });
});

describe("kitop doctor", () => {
  test("exits non-zero when a check fails", () => {
    const dir = project();
    rmSync(join(dir, "node_modules", "@sveltejs", "adapter-bun"), { recursive: true });
    const r = run(dir, "doctor");
    expect(r.out).toContain("@sveltejs/adapter-bun missing");
    expect(r.code).toBe(1);
  });

  test("a config that doesn't load is a failed check", () => {
    const dir = project();
    writeFileSync(join(dir, "desktop.config.ts"), "throw new Error('broken config');\n");
    const r = run(dir, "doctor");
    expect(r.out).toContain("broken config");
    expect(r.code).toBe(1);
  });

  test("a peer outside the required range is a failed check, with the install that fixes it", () => {
    const dir = project();
    installed(dir, "@sveltejs/adapter-bun", "1.0.0");
    const r = run(dir, "doctor");
    expect(r.out).toContain(`@sveltejs/adapter-bun 1.0.0 is not ${shell.peerDependencies["@sveltejs/adapter-bun"]}`);
    expect(r.out).toContain(`bun add -d @sveltejs/adapter-bun@${shell.peerDependencies["@sveltejs/adapter-bun"]}`);
    expect(r.code).toBe(1);
  });

  test("warnings alone don't fail it, and the exit status follows the report", () => {
    const r = run(project(), "doctor");
    expect(r.out).toContain("!"); // at the least, no icon
    // The host's toolchain is what it is: here or in CI, only ✗ may fail the command.
    expect(r.code).toBe(r.out.includes("✗") ? 1 : 0);
  });
});
