// Python commands: the modules of native/python/, run in one Python process of the app's own.
//
// The shell side is a plugin like the Rust and Go ones, libapp-python (native/sdk/python/bridge.cc):
// it registers each command as a platform op and relays the calls to the process. It reads a
// manifest written here — the interpreter, its arguments, the commands and their types:
//   - `vite dev`: the interpreter of a uv environment in .desktop/python/venv (synced from
//     native/python/pyproject.toml), the sources read in place;
//   - a build: a standalone CPython (the uv-managed one the environment was made from), the
//     dependencies and the sources, in Contents/Resources/python, signed with the app.
// The types come from the functions' annotations (`python -m kitop describe`), through
// the bridge's `sd_plugin_describe`, like every other plugin's.
import { $ } from "bun";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import type { PluginDescription } from "./native-types.ts";
import type { Arch } from "./package.ts";
import type { PluginOS } from "./native-langs.ts";

const SDK = resolve(import.meta.dir, "../../native/sdk/python");
const INCLUDE = resolve(import.meta.dir, "../../native/include");
const EXT: Record<PluginOS, string> = { macos: "dylib", linux: "so", windows: "dll" };
export const PYTHON_LIB = (os: PluginOS) => `${os === "windows" ? "" : "lib"}app-python.${EXT[os]}`;

/** `python -I` ignores the user's PYTHON* variables and site: the paths come as arguments
 *  (mode, SDK, site-packages or "", sources). `site.addsitedir` runs the packages' .pth files. */
const BOOT =
  "import sys,site,runpy;m,s=sys.argv[1],sys.argv[2:5];sys.path.insert(0,s[0]);s[1] and site.addsitedir(s[1]);sys.argv=['kitop',m,s[2]];runpy.run_module('kitop',run_name='__main__',alter_sys=True)";
/** -B: no .pyc written next to the sources (or into a signed bundle); -X utf8: UTF-8 everywhere. */
const FLAGS = ["-I", "-B", "-X", "utf8"];

/** native/python/, when it holds Python modules. */
export function pythonSources(c: Pick<ResolvedConfig, "native">): string | null {
  if (!c.native) return null;
  const dir = join(c.native, "python");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return readdirSync(dir).some((f) => f.endsWith(".py")) ? dir : null;
}

function uv(): string {
  const bin = Bun.which("uv");
  if (!bin) throw new Error("native/python/: Python commands need uv to set up Python — https://docs.astral.sh/uv/getting-started/installation/");
  return bin;
}

const venvPython = (venv: string) => (process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"));

/** A uv environment for native/python/ (its pyproject.toml's dependencies, or none), made from a
 *  uv-managed CPython: the one a build ships. Returns its interpreter. */
async function syncEnvironment(c: ResolvedConfig, src: string, venv: string, opts: { dev: boolean }): Promise<string> {
  const bin = uv();
  if (existsSync(join(src, "pyproject.toml"))) {
    const r = await $`${bin} sync --project ${src} --managed-python --no-install-project ${opts.dev ? [] : ["--no-dev"]}`
      .env({ ...process.env, UV_PROJECT_ENVIRONMENT: venv })
      .nothrow()
      .quiet();
    if (r.exitCode !== 0) throw new Error(`native/python/: uv sync failed\n${r.stderr.toString().trim().split("\n").slice(-20).join("\n")}`);
  } else if (!existsSync(venvPython(venv))) {
    const version = existsSync(join(src, ".python-version")) ? readFileSync(join(src, ".python-version"), "utf8").trim() : "3.12";
    const r = await $`${bin} venv ${venv} --managed-python --python ${version} --quiet`.nothrow().quiet();
    if (r.exitCode !== 0) throw new Error(`native/python/: uv venv failed\n${r.stderr.toString().trim()}`);
  }
  return venvPython(venv);
}

/** The commands and their TypeScript types, read from the sources. */
export async function describePython(python: string, src: string): Promise<PluginDescription> {
  const r = await $`${python} ${FLAGS} -c ${BOOT} describe ${SDK} ${""} ${src}`.cwd(src).nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`native/python/: reading the commands failed\n${r.stderr.toString().trim().split("\n").slice(-20).join("\n")}`);
  return JSON.parse(r.stdout.toString()) as PluginDescription;
}

interface Manifest {
  python: string;
  args: string[];
  cwd: string;
  description: PluginDescription;
}

function writeManifest(file: string, m: Manifest) {
  const lines = [
    `# Written by kitop: the Python process of the app (native/sdk/python/bridge.cc reads it).`,
    `python ${m.python}`,
    ...m.args.map((a) => `arg ${a}`),
    `cwd ${m.cwd}`,
    ...m.description.commands.map((cmd) => `command ${cmd.service} ${cmd.op}`),
    `describe ${JSON.stringify(m.description)}`,
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
}

/** libapp-python for `os`/`arch` (rebuilt when the bridge's sources change). */
export async function buildBridge(os: PluginOS, arch: Arch, out: string, minimumSystemVersion = "12.0"): Promise<string> {
  const src = join(SDK, "bridge.cc");
  const newest = Math.max(statSync(src).mtimeMs, statSync(join(INCLUDE, "kitop.h")).mtimeMs);
  if (existsSync(out) && statSync(out).mtimeMs >= newest) return out;
  mkdirSync(dirname(out), { recursive: true });
  const common = ["-std=c++17", "-O2", "-fvisibility=hidden", `-I${INCLUDE}`, src, "-o", out];
  const r =
    os === "macos"
      ? await $`clang++ -dynamiclib -arch ${arch === "arm64" ? "arm64" : "x86_64"} -mmacosx-version-min=${minimumSystemVersion} -install_name @rpath/${PYTHON_LIB(os)} ${common}`.nothrow().quiet()
      : os === "linux"
        ? await $`c++ -shared -fPIC -pthread ${common} -ldl`.nothrow().quiet()
        : await $`clang++ -shared ${common}`.nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`native/python/: building the Python bridge failed\n${r.stderr.toString().trim().split("\n").slice(-20).join("\n")}`);
  return out;
}

const commandNames = (d: PluginDescription) => d.commands.map((c) => `${c.service}.${c.op}`).sort().join(",");

/** `vite dev`: the environment, the bridge in `outDir` and its manifest (the sources run in
 *  place). Returns the library, or null without native/python/. */
export async function preparePythonDev(c: ResolvedConfig, opts: { arch: Arch; outDir: string }): Promise<{ lib: string; commands: string } | null> {
  const src = pythonSources(c);
  if (!src) return null;
  const venv = join(c.root, ".desktop", "python", "venv");
  const python = await syncEnvironment(c, src, venv, { dev: true });
  // The SDK on the environment's path: editors resolve `kitop`, and tests run with it.
  const site = existsSync(join(venv, "lib")) ? readdirSync(join(venv, "lib")).map((d) => join(venv, "lib", d, "site-packages")).find(existsSync) : join(venv, "Lib", "site-packages");
  if (site && existsSync(site)) writeFileSync(join(site, "kitop_sdk.pth"), SDK + "\n");
  const description = await describePython(python, src);
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const lib = await buildBridge(os, opts.arch, join(opts.outDir, PYTHON_LIB(os)), c.build?.minimumSystemVersion);
  writeManifest(lib.replace(/\.[^.]+$/, ".manifest"), { python, args: [...FLAGS, "-c", BOOT, "run", SDK, "", src], cwd: src, description });
  return { lib, commands: commandNames(description) };
}

/** Files of the standalone CPython a packaged app doesn't need: headers, Tcl/Tk, the test suite,
 *  pip, and libpython (the interpreter is linked statically; extension modules don't link it). */
const RUNTIME_SKIP = [
  /^include$/,
  /^share$/,
  /^lib\/pkgconfig$/,
  /^lib\/(tcl|tk|itcl|thread)[\d.]*$/,
  /^lib\/lib(tcl|tk)[\w.]*\.(dylib|so|a)$/,
  /^lib\/libpython3[\w.]*\.(dylib|so|a)$/,
  /^lib\/python3\.\d+\/(test|idlelib|tkinter|turtledemo|ensurepip|lib2to3|pydoc_data|config-3[^/]*)$/,
  /^lib\/python3\.\d+\/lib-dynload\/_tkinter[^/]*$/,
  /^lib\/python3\.\d+\/site-packages$/,
  /(^|\/)__pycache__$/,
];

function copyTree(from: string, to: string, skip: (rel: string) => boolean, rel = "") {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const r = rel ? `${rel}/${entry}` : entry;
    if (skip(r)) continue;
    const s = join(from, entry);
    const d = join(to, entry);
    const st = lstatSync(s);
    if (st.isDirectory()) copyTree(s, d, skip, r);
    else cpSync(s, d, { verbatimSymlinks: true });
  }
}

/** A build (macOS): the runtime, dependencies and sources in `resources`/python, the bridge in
 *  `pluginsDir`. Returns the bridge (with its manifest next to it in `work`, for the types). */
export async function bundlePython(
  c: ResolvedConfig,
  opts: { os: PluginOS; arches: Arch[]; resources: string; pluginsDir: string; work: string },
): Promise<{ lib: string; describeLib: string } | null> {
  const src = pythonSources(c);
  if (!src) return null;
  if (opts.os !== "macos") throw new Error(`native/python/: Python commands are packaged for macOS for now (building for ${opts.os})`);
  if (opts.arches.length !== 1) throw new Error(`native/python/: Python ships one architecture per app — build arm64 and x64 separately (build.arch)`);
  const arch = opts.arches[0]!;
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  if (arch !== hostArch) throw new Error(`native/python/: Python is packaged for the host's architecture (${hostArch}), not ${arch}`);

  // The environment without dev dependencies: its interpreter's CPython and its site-packages.
  const venv = join(opts.work, "python-venv");
  const python = await syncEnvironment(c, src, venv, { dev: false });
  const description = await describePython(python, src);
  const cfg = readFileSync(join(venv, "pyvenv.cfg"), "utf8");
  const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim();
  const version = /^version(?:_info)?\s*=\s*(\d+\.\d+)/m.exec(cfg)?.[1];
  if (!home || !version) throw new Error(`native/python/: can't read the interpreter of ${venv}/pyvenv.cfg`);
  const runtime = dirname(home);

  const out = join(opts.resources, "python");
  rmSync(out, { recursive: true, force: true });
  copyTree(runtime, join(out, "runtime"), (rel) => RUNTIME_SKIP.some((re) => re.test(rel)) || (rel.startsWith("bin/") && rel !== `bin/python${version}`));
  const site = readdirSync(join(venv, "lib")).map((d) => join(venv, "lib", d, "site-packages")).find(existsSync);
  if (site) copyTree(site, join(out, "site-packages"), (rel) => /^(_virtualenv\.(pth|py)|__editable__.*)$/.test(rel) || /(^|\/)__pycache__$/.test(rel));
  copyTree(SDK, join(out, "sdk"), (rel) => !rel.startsWith("kitop") || /(^|\/)__pycache__$/.test(rel));
  copyTree(src, join(out, "app"), (rel) => /^(\.|__pycache__$|pyproject\.toml$|uv\.lock$|tests?$)/.test(rel) || /(^|\/)__pycache__$/.test(rel));
  // Bytecode now — the bundle is signed, the app can't write it later (-B) — checked against
  // nothing: copies, archives and installs change the sources' times.
  const compiled = await $`${join(out, "runtime", "bin", `python${version}`)} -I -m compileall -q -j 0 --invalidation-mode unchecked-hash ${join(out, "runtime", "lib", `python${version}`)} ${join(out, "sdk")} ${join(out, "app")} ${existsSync(join(out, "site-packages")) ? [join(out, "site-packages")] : []}`.nothrow().quiet();
  if (compiled.exitCode !== 0) console.warn(`  \x1b[33m!\x1b[0m python: some modules didn't compile (they're compiled at each start)\n${compiled.stdout.toString().trim().split("\n").slice(-5).join("\n")}`);

  const manifest: Manifest = {
    python: `\${here}/runtime/bin/python${version}`,
    args: [...FLAGS, "-c", BOOT, "run", "${here}/sdk", existsSync(join(out, "site-packages")) ? "${here}/site-packages" : "", "${here}/app"],
    cwd: "${here}/app",
    description,
  };
  writeManifest(join(out, "manifest"), manifest);
  const lib = await buildBridge("macos", arch, join(opts.work, "python-bridge", PYTHON_LIB("macos")), c.build?.minimumSystemVersion);
  // The copy the build reads the types from, with its manifest next to it.
  writeManifest(lib.replace(/\.[^.]+$/, ".manifest"), manifest);
  mkdirSync(opts.pluginsDir, { recursive: true });
  cpSync(lib, join(opts.pluginsDir, PYTHON_LIB("macos")));
  return { lib: join(opts.pluginsDir, PYTHON_LIB("macos")), describeLib: lib };
}

const MACHO = [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca];

/** Every Mach-O file under `dir` (the Python runtime's executable, libraries and extensions). */
export function machOFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        const head = Buffer.alloc(4);
        const fd = openSync(p, "r");
        const n = readSync(fd, head, 0, 4, 0);
        closeSync(fd);
        if (n === 4 && MACHO.includes(head.readUInt32BE(0))) out.push(p);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  // Deepest first: a library before what loads it.
  return out.sort((a, b) => b.split("/").length - a.split("/").length);
}
