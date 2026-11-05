#!/usr/bin/env bun
// kitop CLI
//   create   scaffold a new desktop app (SvelteKit + config + native plugin + tests)
//   init     add desktop support to a SvelteKit project (config, vite plugin, scripts)
//   doctor   check the toolchain, the project and signing/notarization setup
//   keygen   create the ed25519 key pair for signed updates
//   preflight <App.app>  check a bundle against Apple's notarization requirements
//   release <merge|fetch-previous|sign|verify|make-manifest|pack>  publishing updates (CI)
//   icon [source]  generate every target's app icons from one image (the build does it too)
//   add rust|go|python    a native plugin in Rust (native/rust) or Go (native/go), or Python
//                         commands (native/python), typed for the pages
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import shell from "../package.json";
import { removeAdapterOption } from "../src/build/init-edit.ts";

const [cmd, ...rest] = process.argv.slice(2);
const root = process.cwd();
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
let failed = 0;
const bad = (m: string) => {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
// What an app must install, from the manifest so the CLI can't drift from it.
const peers = shell.peerDependencies;
const adapter = `@sveltejs/adapter-bun@${peers["@sveltejs/adapter-bun"]}`;

async function init() {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) throw new Error("run `kitop init` in a SvelteKit project (no package.json here)");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const name = pkg.productName ?? String(pkg.name ?? "App").replace(/(^|[-_ ])(\w)/g, (_: string, s: string, c: string) => (s ? " " : "") + c.toUpperCase());
  const id = `com.example.${String(pkg.name ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "")}`;

  if (!existsSync(join(root, "desktop.config.ts"))) {
    writeFileSync(
      join(root, "desktop.config.ts"),
      `import { defineConfig } from '@kitop/shell/config';\n\nexport default defineConfig({\n\tappName: ${JSON.stringify(name)},\n\tidentifier: ${JSON.stringify(id)},\n\twindow: { width: 1024, height: 720, autosaveName: 'main' }\n});\n`,
    );
    ok("desktop.config.ts");
  } else warn("desktop.config.ts exists — left as is");

  const viteConfig = ["vite.config.ts", "vite.config.js"].map((f) => join(root, f)).find(existsSync);
  if (viteConfig) {
    let src = readFileSync(viteConfig, "utf8");
    if (src.includes("@kitop/shell/vite")) warn(`${viteConfig} already uses the desktop plugin`);
    else if (/sveltekit\(/.test(src)) {
      src = src
        .replace(/import\s*\{\s*sveltekit\s*\}\s*from\s*['"]@sveltejs\/kit\/vite['"];?/, "import { desktop } from '@kitop/shell/vite';")
        .replace(/\bsveltekit\(/g, "desktop(");
      // the desktop plugin sets the adapter itself
      src = removeAdapterOption(src).replace(/import adapter from ['"][^'"]+['"];?\n?/g, "");
      writeFileSync(viteConfig, src);
      ok(`${viteConfig}: sveltekit(…) → desktop(…)`);
    } else warn(`add desktop() from '@kitop/shell/vite' to ${viteConfig} manually`);
  }
  const svelteConfig = ["svelte.config.js", "svelte.config.ts"].map((f) => join(root, f)).find(existsSync);
  if (svelteConfig && /\badapter\b/.test(readFileSync(svelteConfig, "utf8"))) warn(`${svelteConfig} sets an adapter: remove it, desktop() sets its own`);

  pkg.scripts = { ...pkg.scripts, dev: "bunx --bun vite dev", build: "bunx --bun vite build", "test:desktop": "bun test --timeout 30000 tests/" };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
  ok("package.json scripts: dev, build, test:desktop");

  const gi = join(root, ".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!lines.split("\n").includes(".desktop")) writeFileSync(gi, `${lines.replace(/\n?$/, "\n")}.desktop\n`);
  ok(".gitignore: .desktop");
  console.log(`\n  Next: bun add -d @kitop/shell@${shell.version} ${adapter} && bun run dev\n`);
}

async function create(dir: string | undefined) {
  if (!dir) throw new Error("usage: kitop create <directory>");
  const target = resolve(dir);
  if (existsSync(target) && require("node:fs").readdirSync(target).length) throw new Error(`${target} is not empty`);
  const name = target.split("/").pop()!.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const title = name.replace(/(^|-)(\w)/g, (_: string, s: string, c: string) => (s ? " " : "") + c.toUpperCase());
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name,
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: { dev: "bunx --bun vite dev", build: "bunx --bun vite build", test: "bun test --timeout 30000 tests/", prepare: "svelte-kit sync || echo ''" },
        imports: { "#lib": "./src/lib/index.ts", "#lib/*": "./src/lib/*" },
        devDependencies: {
          // The version that wrote this project: its templates and its API go together.
          "@kitop/shell": shell.version,
          "@sveltejs/adapter-bun": peers["@sveltejs/adapter-bun"],
          "@sveltejs/kit": peers["@sveltejs/kit"],
          "@sveltejs/vite-plugin-svelte": "^7.2.0",
          "@types/bun": "latest",
          svelte: peers.svelte,
          typescript: "^6.0.3",
          vite: "^8.1.5",
        },
      },
      null,
      "\t",
    ),
    "vite.config.ts": `import { desktop } from '@kitop/shell/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n\tplugins: [desktop({ compilerOptions: { experimental: { async: true } }, experimental: { remoteFunctions: true } })]\n});\n`,
    "desktop.config.ts": `import { defineConfig } from '@kitop/shell/config';\n\nexport default defineConfig({\n\tappName: ${JSON.stringify(title)},\n\tidentifier: 'com.example.${name.replace(/-/g, "")}',\n\twindow: { width: 900, height: 640, autosaveName: 'main' }\n});\n`,
    "tsconfig.json": JSON.stringify({ extends: "$app/tsconfig", compilerOptions: { strict: true, types: ["$app/types", "bun"] } }, null, "\t"),
    ".gitignore": "node_modules\n.svelte-kit\n.desktop\n",
    "src/app.html": `<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />\n\t\t%sveltekit.head%\n\t</head>\n\t<body>\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n`,
    "src/lib/hello.remote.ts": `import { command, query } from '$app/server';\nimport { isDesktop } from '@kitop/shell/server';\n\nlet clicks = 0;\nexport const getClicks = query(async () => ({ clicks, runtime: \`bun \${Bun.version}\`, desktop: isDesktop() }));\nexport const click = command(async () => {\n\tclicks++;\n\tawait getClicks().refresh();\n});\n`,
    "src/routes/+page.svelte": `<script lang="ts">\n\timport { click, getClicks } from '#lib/hello.remote';\n\timport { theme } from '@kitop/shell/stores';\n</script>\n\n<main>\n\t<h1>${title}</h1>\n\t<svelte:boundary>\n\t\t{@const s = await getClicks()}\n\t\t<p>Server: {s.runtime} · {s.desktop ? 'desktop shell' : 'browser'} · {theme.dark ? 'dark' : 'light'} mode</p>\n\t\t<button onclick={() => click()}>Clicked <span id="clicks">{s.clicks}</span> times</button>\n\t</svelte:boundary>\n</main>\n\n<style>\n\tmain { font-family: system-ui; padding: 2rem; }\n</style>\n`,
    "native/Hello.swift": `// Native plugin: commands callable from pages and server code, typed — native.hello.greet({ name }).\nimport AppKit\n\nstruct GreetArgs: Codable { let name: String }\n\nfunc desktopSetup() {\n  Desktop.command("hello.greet") { (a: GreetArgs) in "Hello \\(a.name) from Swift" }\n}\n`,
    "tests/app.test.ts": `import { afterAll, beforeAll, expect, test } from 'bun:test';\nimport { launch, type AppHandle } from '@kitop/shell/test';\n\nlet app: AppHandle;\nbeforeAll(async () => (app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true } : {})));\nafterAll(() => app?.close());\n\ntest('button calls a remote command', async () => {\n\tawait app.click('button');\n\tawait app.waitFor(() => document.querySelector('#clicks')?.textContent === '1');\n});\n\ntest.if(process.platform === 'darwin')('native plugin', async () => {\n\texpect(await app.platform<string>('hello', 'greet', { name: 'test' })).toContain('from Swift');\n});\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = join(target, rel);
    require("node:fs").mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  ok(`created ${target}`);
  console.log(`\n  cd ${dir} && bun install && bun run dev\n`);
}

/** The version of what `root` has installed, wherever node_modules is above it. */
function installedVersion(name: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
    if (dir === dirname(dir)) return undefined;
  }
}

async function doctor() {
  console.log("\n  kitop doctor\n");
  const bunVersion = Bun.version;
  Bun.semver.order(bunVersion, "1.4.0") >= 0 ? ok(`Bun ${bunVersion}`) : bad(`Bun ${bunVersion} (needs ≥ 1.4)`);
  const canary = (await $`bun --revision`.nothrow().text()).includes("canary");
  canary ? ok("Bun canary: --aot/--trim available") : warn("Bun stable: build.aot/trim need canary (KITOP_BUN or build.bun)");
  const has = async (tool: string) => (await $`which ${tool}`.nothrow().quiet()).exitCode === 0;
  if (process.platform === "darwin") {
    ok(`macOS ${(await $`sw_vers -productVersion`.text()).trim()} ${process.arch}`);
    for (const [tool, why] of [["clang", "libshell + native plugins"], ["swiftc", "Swift native plugins"], ["codesign", "signing"], ["hdiutil", "DMG"], ["lipo", "universal builds"]] as const)
      (await has(tool)) ? ok(`${tool} (${why})`) : bad(`${tool} missing — xcode-select --install (${why})`);
  } else if (process.platform === "linux") {
    ok(`Linux ${process.arch}`);
    (await $`pkg-config --exists webkit2gtk-4.1`.nothrow().quiet()).exitCode === 0 ? ok("WebKitGTK 4.1") : bad("WebKitGTK 4.1 missing — e.g. apt install libwebkit2gtk-4.1-dev (or build in Docker)");
    for (const [tool, why] of [["c++", "native plugins"], ["appimagetool", "AppImage"]] as const) (await has(tool)) ? ok(`${tool} (${why})`) : warn(`${tool} missing (${why})`);
  } else if (process.platform === "win32") {
    ok(`Windows ${process.arch}`);
    for (const [tool, why] of [["makensis", "installer"], ["osslsigncode", "Authenticode"]] as const) (await has(tool)) ? ok(`${tool} (${why})`) : warn(`${tool} missing (${why})`);
  } else bad(`${process.platform} is not supported (macOS, Linux, Windows)`);
  for (const [tool, why] of [["cargo", "Rust plugins"], ["go", "Go plugins"], ["uv", "Python commands"]] as const) if (await has(tool)) ok(`${tool} (${why})`);

  for (const [name, range] of Object.entries(peers)) {
    const version = installedVersion(name);
    if (!version) bad(`${name} missing — bun add -d ${name}@${range}`);
    else if (!Bun.semver.satisfies(version, range)) bad(`${name} ${version} is not ${range} — bun add -d ${name}@${range}`);
    else ok(`${name} ${version}`);
  }
  try {
    const { loadConfig } = await import("../src/config.ts");
    const c = await loadConfig(root);
    ok(`desktop.config: ${c.appName} (${c.identifier}) v${c.version}${c.native ? `, native plugin in ${c.native}` : ""}`);
    c.icon ? ok(`icon ${relative(root, c.icon.source)}`) : warn("no icon (icon.png, static/icon.png or `icon` in desktop.config)");
    c.bridgeAllow ? ok(`bridge.allow: pages can call ${c.bridgeAllow.length} rule${c.bridgeAllow.length === 1 ? "" : "s"}`) : warn("no bridge.allow: a page can call every native operation, so an XSS reaches the keychain and files. List what your pages use before shipping");
    // Apple's signing tools: nothing to check on another OS.
    if (process.platform === "darwin") {
      const identity = c.sign?.identity ?? process.env.CODESIGN_IDENTITY;
      const ids = await $`security find-identity -v -p codesigning`.nothrow().text();
      if (identity) ids.includes(identity) ? ok(`signing identity found: ${identity}`) : bad(`signing identity not in keychain: ${identity}`);
      else warn(`no signing identity — builds are ad-hoc signed. Available: ${(ids.match(/"([^"]+)"/g) ?? []).join(", ") || "none"}`);
      if (identity && !/Developer ID Application/.test(identity) && !/^[0-9A-F]{40}$/.test(identity)) warn("distribution outside the App Store needs a \"Developer ID Application\" certificate");
      const profile = c.sign?.notaryProfile ?? process.env.NOTARY_PROFILE;
      if (profile) {
        const r = await $`xcrun notarytool history --keychain-profile ${profile}`.nothrow().quiet();
        r.exitCode === 0 ? ok(`notary profile "${profile}" works`) : bad(`notary profile "${profile}" fails: ${r.stderr.toString().trim().split("\n")[0]}`);
      } else warn("no notary profile (NOTARY_PROFILE) — builds are not notarized");
    }
    if (c.update) {
      const key = c.update.privateKey ?? process.env.KITOP_UPDATE_KEY;
      key && existsSync(resolve(root, key)) ? ok("update signing key present") : warn("update configured but no private key — release/update.json will be unsigned");
    }
  } catch (err) {
    bad(`desktop.config: ${(err as Error).message}`);
  }
  console.log("");
  // A failed check fails the command, so CI can gate on it. Warnings don't.
  if (failed) process.exitCode = 1;
}

/** `kitop icon [source] [--background #hex] [--out dir]`: the icons the build ships,
 *  generated now — into .desktop/icons (what the build uses) or `--out`. */
async function icon(args: string[]) {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const background = flag("--background"), out = flag("--out");
  const { loadConfig } = await import("../src/config.ts");
  const configured = existsSync(join(root, "desktop.config.ts")) ? (await loadConfig(root)).icon : undefined;
  const spec = args[0] ? { source: resolve(args[0]), background: configured?.background } : configured;
  if (!spec) throw new Error("usage: kitop icon <image> (or set `icon` in desktop.config.ts, or add icon.png)");
  if (background) spec.background = background;
  const { generateIcons } = await import("../src/build/icons.ts");
  const icons = await generateIcons(spec, out ? resolve(out) : join(root, ".desktop", "icons"), { force: true });
  const rel = (p: string) => relative(root, p) || ".";
  console.log(`\n  icons from ${rel(spec.source)} → ${rel(icons.dir)}\n`);
  ok(`macOS    ${rel(icons.icns)}`);
  ok(`Windows  ${rel(icons.ico)}`);
  ok(`Linux    ${rel(join(icons.dir, "png"))}/{16…1024}.png`);
  if (args[0] && configured?.source !== spec.source) warn(`the build uses desktop.config \`icon\`: set icon: '${relative(root, spec.source)}' to ship this one`);
  console.log("");
}

/** `kitop add rust|go|python`: a working native plugin wired to the SDK in this package. */
function addPlugin(lang: string | undefined) {
  if (lang !== "rust" && lang !== "go" && lang !== "python") throw new Error("usage: kitop add rust|go|python");
  const dir = join(root, "native", lang);
  if (existsSync(dir)) throw new Error(`native/${lang} exists — left as is`);
  if (lang === "python") {
    // The SDK comes with the app's Python process (and the dev environment): nothing to wire.
    mkdirSync(dir, { recursive: true });
    const name = basename(root).replace(/[^A-Za-z0-9]+/g, "-").toLowerCase() || "app";
    writeFileSync(
      join(dir, "pyproject.toml"),
      `# The Python commands' dependencies: \`uv add <package>\` here, or edit the list. They ship with the app.\n[project]\nname = "${name}-python"\nversion = "0.0.0"\nrequires-python = ">=3.10"\ndependencies = []\n`,
    );
    writeFileSync(
      join(dir, "hello.py"),
      `# Python commands: callable from pages and server code, typed from the annotations —\n# native.hello.python({ name }) (types in src/native.d.ts, written by the build).\nfrom dataclasses import dataclass\n\nfrom kitop import InvalidArgs, command\n\n\n@dataclass\nclass Greeting:\n    message: str\n\n\n@command("hello.python")\ndef hello(name: str) -> Greeting:\n    if not name:\n        raise InvalidArgs("name is empty")\n    return Greeting(message=f"Hello {name} from Python")\n`,
    );
    ok("native/python");
    console.log("\n  `bun run dev` sets up Python with uv (https://docs.astral.sh/uv) and types native.hello in src/native.d.ts.\n");
    return;
  }
  // The SDK through node_modules when the package is installed there (stable), else where it is.
  const installed = join(root, "node_modules", "@kitop", "shell");
  const sdk = join(existsSync(installed) ? installed : resolve(import.meta.dir, ".."), "native", "sdk", lang);
  const rel = relative(dir, sdk);
  mkdirSync(join(dir, lang === "rust" ? "src" : "."), { recursive: true });
  if (lang === "rust") {
    writeFileSync(
      join(dir, "Cargo.toml"),
      `[package]\nname = "app-native"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nkitop = { path = ${JSON.stringify(rel)} }\nserde = { version = "1", features = ["derive"] }\nts-rs = "12"\n`,
    );
    writeFileSync(
      join(dir, "src", "lib.rs"),
      `// Native plugin in Rust: every command is callable from pages and server code,\n// typed — native.hello.rust({ name }) (types in src/native.d.ts, written by the build).\nuse serde::{Deserialize, Serialize};\nuse kitop::{plugin, Error, Plugin, TS};\n\n#[derive(Deserialize, TS)]\nstruct GreetArgs {\n    name: String,\n}\n\n#[derive(Serialize, TS)]\nstruct Greeting {\n    message: String,\n}\n\nfn setup(p: &mut Plugin) {\n    p.command("hello.rust", |a: GreetArgs| -> Result<Greeting, Error> {\n        if a.name.is_empty() {\n            return Err(Error::invalid_args("name is empty"));\n        }\n        Ok(Greeting { message: format!("Hello {} from Rust", a.name) })\n    });\n}\n\nplugin!(setup);\n`,
    );
    const gi = join(dir, ".gitignore");
    writeFileSync(gi, "target/\n");
  } else {
    writeFileSync(join(dir, "go.mod"), `module app-native\n\ngo 1.22\n\nrequire kitop.dev/go/desktop v0.0.0\n\nreplace kitop.dev/go/desktop => ${rel}\n`);
    writeFileSync(
      join(dir, "main.go"),
      `// Native plugin in Go: every command is callable from pages and server code,\n// typed — native.hello.go({ name }) (types in src/native.d.ts, written by the build).\npackage main\n\nimport "kitop.dev/go/desktop"\n\ntype GreetArgs struct {\n\tName string \`json:"name"\`\n}\n\ntype Greeting struct {\n\tMessage string \`json:"message"\`\n}\n\nfunc init() {\n\tdesktop.Command("hello.go", func(a GreetArgs) (Greeting, error) {\n\t\tif a.Name == "" {\n\t\t\treturn Greeting{}, desktop.InvalidArgs("name is empty")\n\t\t}\n\t\treturn Greeting{Message: "Hello " + a.Name + " from Go"}, nil\n\t})\n}\n\nfunc main() {}\n`,
    );
  }
  ok(`native/${lang} — SDK at ${rel}`);
  console.log(`\n  \`bun run dev\` builds it (${lang === "rust" ? "cargo" : "go"} needed) and types native.hello in src/native.d.ts.\n`);
}

try {
  if (cmd === "init") await init();
  else if (cmd === "add") addPlugin(rest[0]);
  else if (cmd === "icon") await icon(rest);
  else if (cmd === "create") await create(rest[0]);
  else if (cmd === "doctor") await doctor();
  else if (cmd === "preflight") {
    const app = rest[0];
    if (!app) throw new Error("usage: kitop preflight <App.app>");
    const { notaryPreflight, formatPreflight } = await import("../src/build/notary-preflight.ts");
    const issues = await notaryPreflight(resolve(app));
    console.log(formatPreflight(issues));
    process.exit(issues.some((i) => i.level === "error") ? 1 : 0);
  } else if (cmd === "keygen") await $`bun ${join(import.meta.dir, "../scripts/updater-cli.ts")} keygen ${rest}`;
  else if (cmd === "release") await $`bun ${join(import.meta.dir, "../scripts/updater-cli.ts")} ${rest}`;
  else {
    console.log(`usage: kitop <create|init|doctor|icon|add|preflight|keygen|release> — see ${shell.homepage}/reference/cli`);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`kitop: ${(err as Error).message}`);
  process.exit(1);
}
