// What kitop relies on in SvelteKit that isn't public: the options its setup plugin shows (`api.options`),
// which kitop reads and changes before SvelteKit builds from them. Against the SvelteKit installed here,
// and in CI against its newest release in the peer range: a SvelteKit that changes them fails here first.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { createBuilder } from "vite";
import kit from "@sveltejs/kit/package.json";
import { flatPlugins, kitOptions, kitOptionsProblem, routesOverlay } from "./routes-overlay.js";

// In the package, so that the project's files find svelte and SvelteKit in its node_modules.
const shellRoot = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("sveltekit() shows the options kitop reads", async () => {
  expect(kitOptionsProblem(await flatPlugins(sveltekit()))).toBeNull();
});

test("without them, both sides fail and name the SvelteKit installed", async () => {
  const changed = [{ name: "vite-plugin-sveltekit-setup", api: {} }];
  await expect(kitOptions(changed, shellRoot)).rejects.toThrow(`SvelteKit ${kit.version} doesn't show its options the way kitop reads them`);
  const web = routesOverlay("web").config.handler;
  await expect(web({ root: shellRoot, plugins: changed })).rejects.toThrow(`SvelteKit ${kit.version}`);
  await expect(web({ root: shellRoot, plugins: [{ name: "vite-plugin-svelte" }] })).rejects.toThrow(`desktop() goes next to SvelteKit's plugin, plugins: [sveltekit(), desktop()], and there's none here (SvelteKit ${kit.version})`);
});

// Links: Windows makes them only in Developer Mode.
test.skipIf(process.platform === "win32")("what kitop changes in them is what SvelteKit builds: the routes, the hooks, the adapter", async () => {
  const dir = mkdtempSync(join(shellRoot, ".kit-contract-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "src/app.html": "<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>\n",
    "src/routes/+page.svelte": "<p>CONTRACT_WEB_PAGE</p>\n",
    "src/routes/+page.desktop.svelte": "<p>CONTRACT_DESKTOP_PAGE</p>\n",
    "src/hooks.server.ts": "export const handle = ({ event, resolve }) => resolve(event, { transformPageChunk: ({ html }) => html + 'CONTRACT_WEB_HOOK' });\n",
    "src/hooks.server.desktop.ts": "export const handle = ({ event, resolve }) => resolve(event, { transformPageChunk: ({ html }) => html + 'CONTRACT_DESKTOP_HOOK' });\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  let adapted = false;
  const adapter = {
    name: "contract",
    adapt(builder: { writeServer(dir: string): void }) {
      adapted = true;
      builder.writeServer(join(dir, "out"));
    },
  };
  // What the shell's adapter plugin does for a desktop target, with this adapter.
  const swap = { name: "contract:adapter", enforce: "pre", config: { order: "pre", handler: async (user: { plugins?: unknown }) => void ((await kitOptions(user.plugins, dir)).adapter = adapter) } };
  // SvelteKit takes the project from the working directory, as `vite build` there would.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const builder = await createBuilder({ root: dir, configFile: false, logLevel: "silent", plugins: [sveltekit({ adapter: { name: "project", adapt() {} } }), routesOverlay("desktop"), swap] });
    await builder.buildApp();
  } finally {
    process.chdir(cwd);
  }
  expect(adapted).toBe(true);
  const server = readdirSync(join(dir, "out"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");
  expect(server).toContain("CONTRACT_DESKTOP_PAGE");
  expect(server).not.toContain("CONTRACT_WEB_PAGE");
  expect(server).toContain("CONTRACT_DESKTOP_HOOK");
  expect(server).not.toContain("CONTRACT_WEB_HOOK");
}, 120_000);
