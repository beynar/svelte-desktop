#!/usr/bin/env bun
// svelte-desktop CLI
//   create   scaffold a new desktop app (SvelteKit + config + native plugin + tests)
//   init     add desktop support to a SvelteKit project (config, vite plugin, scripts)
//   doctor   check the toolchain, the project and signing/notarization setup
//   keygen   create the ed25519 key pair for signed updates
//   preflight <App.app>  check a bundle against Apple's notarization requirements
//   icon [source]  generate every target's app icons from one image (the build does it too)
//   add rust|go    a native plugin in Rust (native/rust) or Go (native/go), typed for the pages
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const root = process.cwd();
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

async function init() {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) throw new Error("run `svelte-desktop init` in a SvelteKit project (no package.json here)");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const name = pkg.productName ?? String(pkg.name ?? "App").replace(/(^|[-_ ])(\w)/g, (_: string, s: string, c: string) => (s ? " " : "") + c.toUpperCase());
  const id = `com.example.${String(pkg.name ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "")}`;

  if (!existsSync(join(root, "desktop.config.ts"))) {
    writeFileSync(
      join(root, "desktop.config.ts"),
      `import { defineConfig } from '@svelte-desktop/shell/config';\n\nexport default defineConfig({\n\tappName: ${JSON.stringify(name)},\n\tidentifier: ${JSON.stringify(id)},\n\twindow: { width: 1024, height: 720, autosaveName: 'main' }\n});\n`,
    );
    ok("desktop.config.ts");
  } else warn("desktop.config.ts exists — left as is");

  const viteConfig = ["vite.config.ts", "vite.config.js"].map((f) => join(root, f)).find(existsSync);
  if (viteConfig) {
    let src = readFileSync(viteConfig, "utf8");
    if (src.includes("@svelte-desktop/shell/vite")) warn(`${viteConfig} already uses the desktop plugin`);
    else if (/sveltekit\(/.test(src)) {
      src = src
        .replace(/import\s*\{\s*sveltekit\s*\}\s*from\s*['"]@sveltejs\/kit\/vite['"];?/, "import { desktop } from '@svelte-desktop/shell/vite';")
        .replace(/\bsveltekit\(/g, "desktop(");
      // the desktop plugin sets the adapter itself
      src = src.replace(/\n?\s*adapter:\s*adapter\([^)]*\),?/g, "").replace(/import adapter from ['"][^'"]+['"];?\n?/g, "");
      writeFileSync(viteConfig, src);
      ok(`${viteConfig}: sveltekit(…) → desktop(…)`);
    } else warn(`add desktop() from '@svelte-desktop/shell/vite' to ${viteConfig} manually`);
  }

  pkg.scripts = { ...pkg.scripts, dev: "bunx --bun vite dev", build: "bunx --bun vite build", "test:desktop": "bun test --timeout 30000 tests/" };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
  ok("package.json scripts: dev, build, test:desktop");

  const gi = join(root, ".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!lines.split("\n").includes(".desktop")) writeFileSync(gi, `${lines.replace(/\n?$/, "\n")}.desktop\n`);
  ok(".gitignore: .desktop");
  console.log(`\n  Next: bun add -d @sveltejs/adapter-bun @svelte-desktop/shell && bun run dev\n`);
}

async function create(dir: string | undefined) {
  if (!dir) throw new Error("usage: svelte-desktop create <directory>");
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
          "@svelte-desktop/shell": "latest",
          "@sveltejs/adapter-bun": "1.0.0-next.2",
          "@sveltejs/kit": "^3.0.0-next.0",
          "@sveltejs/vite-plugin-svelte": "^7.2.0",
          "@types/bun": "latest",
          svelte: "^5.56.7",
          typescript: "^6.0.3",
          vite: "^8.1.5",
        },
      },
      null,
      "\t",
    ),
    "vite.config.ts": `import { desktop } from '@svelte-desktop/shell/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n\tplugins: [desktop({ compilerOptions: { experimental: { async: true } }, experimental: { remoteFunctions: true } })]\n});\n`,
    "desktop.config.ts": `import { defineConfig } from '@svelte-desktop/shell/config';\n\nexport default defineConfig({\n\tappName: ${JSON.stringify(title)},\n\tidentifier: 'com.example.${name.replace(/-/g, "")}',\n\twindow: { width: 900, height: 640, autosaveName: 'main' }\n});\n`,
    "tsconfig.json": JSON.stringify({ extends: "$app/tsconfig", compilerOptions: { strict: true, types: ["$app/types", "bun"] } }, null, "\t"),
    ".gitignore": "node_modules\n.svelte-kit\n.desktop\n",
    "src/app.html": `<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />\n\t\t%sveltekit.head%\n\t</head>\n\t<body>\n\t\t<div style="display: contents">%sveltekit.body%</div>\n\t</body>\n</html>\n`,
    "src/lib/hello.remote.ts": `import { command, query } from '$app/server';\nimport { isDesktop } from '@svelte-desktop/shell/server';\n\nlet clicks = 0;\nexport const getClicks = query(async () => ({ clicks, runtime: \`bun \${Bun.version}\`, desktop: isDesktop() }));\nexport const click = command(async () => {\n\tclicks++;\n\tawait getClicks().refresh();\n});\n`,
    "src/routes/+page.svelte": `<script lang="ts">\n\timport { click, getClicks } from '#lib/hello.remote';\n\timport { theme } from '@svelte-desktop/shell/stores';\n</script>\n\n<main>\n\t<h1>${title}</h1>\n\t<svelte:boundary>\n\t\t{@const s = await getClicks()}\n\t\t<p>Server: {s.runtime} · {s.desktop ? 'desktop shell' : 'browser'} · {theme.dark ? 'dark' : 'light'} mode</p>\n\t\t<button onclick={() => click()}>Clicked <span id="clicks">{s.clicks}</span> times</button>\n\t</svelte:boundary>\n</main>\n\n<style>\n\tmain { font-family: system-ui; padding: 2rem; }\n</style>\n`,
    "native/Hello.swift": `// Native plugin: commands callable from pages and server code, typed — native.hello.greet({ name }).\nimport AppKit\n\nstruct GreetArgs: Codable { let name: String }\n\nfunc desktopSetup() {\n  Desktop.command("hello.greet") { (a: GreetArgs) in "Hello \\(a.name) from Swift" }\n}\n`,
    "tests/app.test.ts": `import { afterAll, beforeAll, expect, test } from 'bun:test';\nimport { launch, type AppHandle } from '@svelte-desktop/shell/test';\n\nlet app: AppHandle;\nbeforeAll(async () => (app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true } : {})));\nafterAll(() => app?.close());\n\ntest('button calls a remote command', async () => {\n\tawait app.click('button');\n\tawait app.waitFor(() => document.querySelector('#clicks')?.textContent === '1');\n});\n\ntest('native plugin', async () => {\n\texpect(await app.platform<string>('hello', 'greet', { name: 'test' })).toContain('from Swift');\n});\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = join(target, rel);
    require("node:fs").mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  ok(`created ${target}`);
  console.log(`\n  cd ${dir} && bun install && bun run dev\n`);
}

async function doctor() {
  console.log("\n  svelte-desktop doctor\n");
  const bunVersion = Bun.version;
  Bun.semver.order(bunVersion, "1.4.0") >= 0 ? ok(`Bun ${bunVersion}`) : bad(`Bun ${bunVersion} (needs ≥ 1.4)`);
  const canary = (await $`bun --revision`.nothrow().text()).includes("canary");
  canary ? ok("Bun canary: --aot/--trim available") : warn("Bun stable: build.aot/trim need canary (SVELTE_DESKTOP_BUN or build.bun)");
  process.platform === "darwin" ? ok(`macOS ${(await $`sw_vers -productVersion`.text()).trim()} ${process.arch}`) : bad(`${process.platform} is not supported yet (macOS only)`);
  for (const [tool, why] of [["clang", "libshell + native plugins"], ["swiftc", "Swift native plugins"], ["codesign", "signing"], ["hdiutil", "DMG"], ["lipo", "universal builds"]] as const)
    (await $`which ${tool}`.nothrow().quiet()).exitCode === 0 ? ok(`${tool} (${why})`) : bad(`${tool} missing — xcode-select --install (${why})`);

  try {
    Bun.resolveSync("@sveltejs/adapter-bun", root);
    ok("@sveltejs/adapter-bun installed");
  } catch {
    bad("@sveltejs/adapter-bun missing — bun add -d @sveltejs/adapter-bun");
  }
  try {
    const { loadConfig } = await import("../src/config.ts");
    const c = await loadConfig(root);
    ok(`desktop.config: ${c.appName} (${c.identifier}) v${c.version}${c.native ? `, native plugin in ${c.native}` : ""}`);
    c.icon ? ok(`icon ${relative(root, c.icon.source)}`) : warn("no icon (icon.png, static/icon.png or `icon` in desktop.config)");
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
    if (c.update) {
      const key = c.update.privateKey ?? process.env.SVELTE_DESKTOP_UPDATE_KEY;
      key && existsSync(resolve(root, key)) ? ok("update signing key present") : warn("update configured but no private key — release/update.json will be unsigned");
    }
  } catch (err) {
    bad(`desktop.config: ${(err as Error).message}`);
  }
  console.log("");
}

/** `svelte-desktop icon [source] [--background #hex] [--out dir]`: the icons the build ships,
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
  if (!spec) throw new Error("usage: svelte-desktop icon <image> (or set `icon` in desktop.config.ts, or add icon.png)");
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

/** `svelte-desktop add rust|go`: a working native plugin wired to the SDK in this package. */
function addPlugin(lang: string | undefined) {
  if (lang !== "rust" && lang !== "go") throw new Error("usage: svelte-desktop add rust|go");
  const dir = join(root, "native", lang);
  if (existsSync(dir)) throw new Error(`native/${lang} exists — left as is`);
  // The SDK through node_modules when the package is installed there (stable), else where it is.
  const installed = join(root, "node_modules", "@svelte-desktop", "shell");
  const sdk = join(existsSync(installed) ? installed : resolve(import.meta.dir, ".."), "native", "sdk", lang);
  const rel = relative(dir, sdk);
  mkdirSync(join(dir, lang === "rust" ? "src" : "."), { recursive: true });
  if (lang === "rust") {
    writeFileSync(
      join(dir, "Cargo.toml"),
      `[package]\nname = "app-native"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nsvelte-desktop = { path = ${JSON.stringify(rel)} }\nserde = { version = "1", features = ["derive"] }\nts-rs = "12"\n`,
    );
    writeFileSync(
      join(dir, "src", "lib.rs"),
      `// Native plugin in Rust: every command is callable from pages and server code,\n// typed — native.hello.rust({ name }) (types in src/native.d.ts, written by the build).\nuse serde::{Deserialize, Serialize};\nuse svelte_desktop::{plugin, Error, Plugin, TS};\n\n#[derive(Deserialize, TS)]\nstruct GreetArgs {\n    name: String,\n}\n\n#[derive(Serialize, TS)]\nstruct Greeting {\n    message: String,\n}\n\nfn setup(p: &mut Plugin) {\n    p.command("hello.rust", |a: GreetArgs| -> Result<Greeting, Error> {\n        if a.name.is_empty() {\n            return Err(Error::invalid_args("name is empty"));\n        }\n        Ok(Greeting { message: format!("Hello {} from Rust", a.name) })\n    });\n}\n\nplugin!(setup);\n`,
    );
    const gi = join(dir, ".gitignore");
    writeFileSync(gi, "target/\n");
  } else {
    writeFileSync(join(dir, "go.mod"), `module app-native\n\ngo 1.22\n\nrequire svelte-desktop.dev/go/desktop v0.0.0\n\nreplace svelte-desktop.dev/go/desktop => ${rel}\n`);
    writeFileSync(
      join(dir, "main.go"),
      `// Native plugin in Go: every command is callable from pages and server code,\n// typed — native.hello.go({ name }) (types in src/native.d.ts, written by the build).\npackage main\n\nimport "svelte-desktop.dev/go/desktop"\n\ntype GreetArgs struct {\n\tName string \`json:"name"\`\n}\n\ntype Greeting struct {\n\tMessage string \`json:"message"\`\n}\n\nfunc init() {\n\tdesktop.Command("hello.go", func(a GreetArgs) (Greeting, error) {\n\t\tif a.Name == "" {\n\t\t\treturn Greeting{}, desktop.InvalidArgs("name is empty")\n\t\t}\n\t\treturn Greeting{Message: "Hello " + a.Name + " from Go"}, nil\n\t})\n}\n\nfunc main() {}\n`,
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
    if (!app) throw new Error("usage: svelte-desktop preflight <App.app>");
    const { notaryPreflight, formatPreflight } = await import("../src/build/notary-preflight.ts");
    const issues = await notaryPreflight(resolve(app));
    console.log(formatPreflight(issues));
    process.exit(issues.some((i) => i.level === "error") ? 1 : 0);
  } else if (cmd === "keygen") await $`bun ${join(import.meta.dir, "../scripts/updater-cli.ts")} keygen ${rest}`;
  else {
    console.log("usage: svelte-desktop <create|init|doctor|icon|add|preflight|keygen> — see packages/shell/README.md");
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`svelte-desktop: ${(err as Error).message}`);
  process.exit(1);
}
