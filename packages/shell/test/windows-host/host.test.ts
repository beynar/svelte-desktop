// What a developer does on a Windows machine, on its real filesystem: the package from a tarball in a
// new project, the website's dev and build with its links in .desktop/routes, then the app's. It changes
// the machine (a user, Developer Mode), so it's for CI: windows.yml, job `host`.
//   WINDOWS_SHELL_DLL  the shell.dll the build job cross-compiled: Docker on a runner can't make one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { launch, type AppHandle } from "../../src/test.ts";

const shellRoot = resolve(import.meta.dir, "../..");
// Not the runner's %TEMP%: it's C:\Users\RUNNER~1\…, a short name SvelteKit's manifest paths don't match.
const T = process.platform === "win32" ? realpathSync.native(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "kh-"))) : "";
const project = join(T, "hello");
const dll = process.env.WINDOWS_SHELL_DLL;

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}) {
  const r = Bun.spawnSync(cmd, { cwd: options.cwd ?? project, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe", timeout: options.timeout ?? 300_000 });
  const out = r.stdout.toString() + r.stderr.toString();
  console.log(`$ ${cmd.join(" ")} (exit ${r.exitCode})\n${out.split("\n").filter((l) => !/gzip|^\s*$/.test(l)).slice(-25).join("\n")}`);
  return { code: r.exitCode, out };
}
const write = (rel: string, text: string, root = project) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const edit = (rel: string, change: (s: string) => string) => write(rel, change(readFileSync(join(project, rel), "utf8")));
/** The whole tree: `kitop` runs bunx, which runs vite. */
const killTree = (pid: number) => Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
const without = (tool: string) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (/^path$/i.test(key)) env[key] = value!.split(delimiter).filter((dir) => !existsSync(join(dir, tool))).join(delimiter);
  return env;
};

describe.if(process.platform === "win32" && !!process.env.CI)("on a Windows host", () => {
  beforeAll(() => {
    expect(run(["bun", "pm", "pack", "--destination", T, "--quiet"], { cwd: shellRoot }).code).toBe(0);
    const { version } = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8"));
    mkdirSync(join(T, "cli"));
    write("package.json", '{ "name": "cli", "private": true }', join(T, "cli"));
    expect(run(["bun", "add", join(T, `kitop-shell-${version}.tgz`).replaceAll("\\", "/")], { cwd: join(T, "cli") }).code).toBe(0);
    expect(run(["bunx", "kitop", "create", project], { cwd: join(T, "cli") }).code).toBe(0);
    cpSync(join(T, `kitop-shell-${version}.tgz`), join(project, "kitop-shell.tgz"));
    edit("package.json", (s) => s.replace(`"@kitop/shell": "${version}"`, '"@kitop/shell": "file:./kitop-shell.tgz"'));
    const install = run(["bun", "install"]);
    expect(install.code).toBe(0);
    // A website too, each side with its own files.
    edit("vite.config.ts", (s) =>
      s
        .replace("sveltekit({", "sveltekit({ adapter: { name: 'host-test', adapt: (b) => { b.writeClient('site/client'); b.writeServer('site/server'); } },")
        .replace("desktop({ website: false })", "desktop({ routes: { exclude: ['/web-only'] } })"),
    );
    write("src/routes/where/+page.svelte", "<p>host is {host.available ? 'the desktop' : 'a website'}</p>\n");
    write("src/routes/where/+page.desktop.svelte", "<script lang=\"ts\">\n  import type { PageProps } from './$types';\n  let { data }: PageProps = $props();\n</script>\n<p>SIDE_DESKTOP_PAGE {data.from}</p>\n");
    write("src/routes/where/+page.server.ts", "export const load = () => ({ from: 'SIDE_WEB_LOAD' });\n");
    write("src/routes/where/+page.server.desktop.ts", "export const load = () => ({ from: 'SIDE_DESKTOP_LOAD' });\n");
    write("src/routes/web-only/+page.svelte", "<p>SIDE_WEB_ONLY</p>\n");
    write("src/routes/only-desktop/+page.desktop.svelte", "<p>SIDE_ONLY_DESKTOP</p>\n");
  }, 300_000);
  afterAll(() => rmSync(T, { recursive: true, force: true, maxRetries: 5 }));

  test("kitop create names the project after its folder, not its path", () => {
    expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).name).toBe("hello");
    expect(readFileSync(join(project, "desktop.config.ts"), "utf8")).toContain('appName: "Hello"');
  });

  test("kitop build: the website, its .desktop routes through links, nothing of the app's", () => {
    const r = run(["bunx", "kitop", "build"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(project, "site/server"))).toBe(true);
    expect(existsSync(join(project, ".desktop/dist"))).toBe(false);
    expect(lstatSync(join(project, ".desktop/routes/where/+page.svelte")).isSymbolicLink()).toBe(true);
    const site = [...new Bun.Glob("**/*").scanSync({ cwd: join(project, "site"), onlyFiles: true })].map((f) => readFileSync(join(project, "site", f), "latin1")).join("\n");
    for (const marker of ["SIDE_DESKTOP_PAGE", "SIDE_ONLY_DESKTOP", "SIDE_DESKTOP_LOAD"]) expect(site).not.toContain(marker);
    expect(site).toContain("SIDE_WEB_ONLY");
  }, 300_000);

  test("kitop dev: the website, and a route added while it runs reaches it through the links", async () => {
    const port = 4188;
    const dev = Bun.spawn(["bunx", "kitop", "dev", "--port", String(port), "--strictPort"], { cwd: project, stdout: "pipe", stderr: "pipe" });
    const page = async (path: string, ms = 60_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = await fetch(`http://localhost:${port}${path}`).catch(() => null);
        if (r?.ok) return r.text();
        await Bun.sleep(500);
      }
      return `no answer at ${path}`;
    };
    try {
      expect(await page("/where")).toContain("a website");
      write("src/routes/added-later/+page.svelte", "<p>SIDE_ADDED_LATER</p>\n");
      expect(await page("/added-later", 30_000)).toContain("SIDE_ADDED_LATER");
    } finally {
      killTree(dev.pid);
      rmSync(join(project, "src/routes/added-later"), { recursive: true });
    }
  }, 180_000);

  test("what another OS must do says so", () => {
    const dev = run(["bunx", "kitop", "dev", "--mac"]);
    expect(dev.code).not.toBe(0);
    expect(dev.out).toContain("needs macOS");
    const build = run(["bunx", "kitop", "build", "--mac"]);
    expect(build.code).not.toBe(0);
    expect(build.out).toContain("needs a Mac");
  });

  test("no shell.dll, and a Docker that only runs Windows containers: the build and doctor say what to do", () => {
    const os = Bun.spawnSync(["docker", "info", "--format", "{{.OSType}}"]).stdout.toString().trim();
    console.log(`docker runs: ${os}`);
    expect(os).toBe("windows");
    const build = run(["bunx", "kitop", "build", "--windows"]);
    expect(build.code).not.toBe(0);
    expect(build.out).toContain("Windows containers");
    expect(build.out).toContain("KITOP_SHELL_DLL");
    const doctor = run(["bunx", "kitop", "doctor"]);
    expect(doctor.code).not.toBe(0);
    expect(doctor.out).toContain("Windows containers");
  }, 300_000);

  test("no shell.dll, and no Docker", () => {
    const env = without("docker.exe");
    const build = run(["bunx", "kitop", "build", "--windows"], { env });
    expect(build.code).not.toBe(0);
    expect(build.out).toContain("Docker");
    expect(build.out).toContain("KITOP_SHELL_DLL");
    const doctor = run(["bunx", "kitop", "doctor"], { env });
    expect(doctor.code).not.toBe(0);
    expect(doctor.out).toContain("KITOP_SHELL_DLL");
  }, 300_000);

  describe.if(!!dll)("with a shell.dll from elsewhere", () => {
    const env = { KITOP_SHELL_DLL: dll! };

    test("doctor has nothing against it", () => {
      expect(run(["bunx", "kitop", "doctor"], { env }).code).toBe(0);
    });

    test("kitop build --windows: the app, its .desktop files in place, running", async () => {
      const build = run(["bunx", "kitop", "build", "--windows"], { env });
      expect(build.code).toBe(0);
      const folder = join(project, ".desktop/dist/Hello-windows-x64");
      expect(existsSync(join(folder, "Hello.exe"))).toBe(true);
      expect(existsSync(join(folder, "shell.dll"))).toBe(true);
      const app: AppHandle = await launch({ app: folder, timeout: 60_000 });
      try {
        await app.waitFor("#clicks");
        const get = (path: string) => app.eval<{ status: number; text: string }>(`fetch('${path}').then(async (r) => ({ status: r.status, text: await r.text() }))`);
        expect((await get("/where")).text).toContain("SIDE_DESKTOP_PAGE");
        expect((await get("/only-desktop")).text).toContain("SIDE_ONLY_DESKTOP");
        expect((await get("/web-only")).status).toBe(404);
      } finally {
        await app.close();
      }
    }, 300_000);

    test("kitop dev --windows: a window, on the dev server", async () => {
      const app: AppHandle = await launch({ dev: { cwd: project }, env, timeout: 180_000 });
      try {
        await app.waitFor("#clicks", { timeout: 60_000 });
        await app.click("button");
        await app.waitFor(() => document.querySelector("#clicks")?.textContent === "1", { timeout: 30_000 });
      } finally {
        await app.close();
      }
    }, 300_000);
  });

  // Runners run as an administrator, who can make links whatever Developer Mode says.
  test("links, without the privilege: the build says Developer Mode, and a project with no .desktop file needs none", () => {
    const script = join(import.meta.dir, "plain-user.ps1");
    const bun = process.execPath;
    const kitop = join(project, "node_modules/@kitop/shell/bin/kitop.ts");
    const asUser = (cwd: string) => run(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Bun", bun, "-Dir", T, "-Cwd", cwd, "-Kitop", kitop], { cwd: T });
    rmSync(join(project, ".desktop"), { recursive: true, force: true });
    const r = asUser(project);
    expect(r.out).toContain("Developer Mode");
    expect(r.out).toContain("exit 1");
    for (const dir of ["where", "web-only", "only-desktop"]) rmSync(join(project, "src/routes", dir), { recursive: true, force: true });
    edit("vite.config.ts", (s) => s.replace("desktop({ routes: { exclude: ['/web-only'] } })", "desktop()"));
    rmSync(join(project, ".desktop"), { recursive: true, force: true });
    const plain = asUser(project);
    expect(plain.out).toContain("exit 0");
    expect(plain.out).not.toContain("Developer Mode");
  }, 300_000);
});
