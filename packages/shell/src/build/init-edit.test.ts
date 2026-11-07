import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDesktopPlugin, bridgeRules, desktopConfig, stringifyLike } from "./init-edit.ts";

test("desktop() goes next to sveltekit(), which keeps its options", () => {
  const head = "import { sveltekit } from '@sveltejs/kit/vite';\nimport { desktop } from '@kitop/shell/vite';\n";
  expect(addDesktopPlugin("import { sveltekit } from '@sveltejs/kit/vite';\nplugins: [sveltekit({ adapter: adapter() })],")).toBe(`${head}plugins: [sveltekit({ adapter: adapter() }), desktop()],`);
  // On lines of its own, with a parenthesis in a string and a plugin after it.
  expect(addDesktopPlugin("import { sveltekit } from '@sveltejs/kit/vite';\n\tplugins: [\n\t\tsveltekit({\n\t\t\tout: join('a', 'b)'),\n\t\t}),\n\t\tother()\n\t]")).toBe(`${head}\tplugins: [\n\t\tsveltekit({\n\t\t\tout: join('a', 'b)'),\n\t\t}),\n\t\tdesktop(),\n\t\tother()\n\t]`);
  expect(addDesktopPlugin("plugins: []")).toBeNull();
  expect(addDesktopPlugin("sveltekit({ unfinished")).toBeNull();
});

test("a rewritten package.json keeps its indentation and final newline", () => {
  const value = { name: "a", scripts: { dev: "x" } };
  expect(stringifyLike('{\n  "name": "a"\n}\n', value)).toBe('{\n  "name": "a",\n  "scripts": {\n    "dev": "x"\n  }\n}\n');
  expect(stringifyLike('{\n\t"name": "a"\n}', value)).toBe('{\n\t"name": "a",\n\t"scripts": {\n\t\t"dev": "x"\n\t}\n}');
  expect(stringifyLike('{"name":"a"}\n', { name: "a" })).toBe('{\n\t"name": "a"\n}\n');
});

test("bridge.allow: nothing for pages with no host code, the notifications for the web's Notification API", () => {
  const src = mkdtempSync(join(tmpdir(), "init-bridge-"));
  try {
    mkdirSync(join(src, "routes/chat"), { recursive: true });
    writeFileSync(join(src, "routes/+page.svelte"), "<p>Notifications are off</p>\n");
    // Server code isn't limited by the list.
    writeFileSync(join(src, "routes/+page.server.ts"), "new Notification('x');\n");
    expect(bridgeRules(src)).toEqual([]);
    writeFileSync(join(src, "routes/chat/+page.svelte"), "<script>\n\tif (Notification.permission === 'granted') new Notification('New message');\n</script>\n");
    expect(bridgeRules(src)).toEqual(["notifications.*"]);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("desktop.config.ts from init loads, and says what bridge.allow is for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "init-config-"));
  try {
    const text = desktopConfig("My Site", "com.example.mysite", ["notifications.*"], "https://docs.example");
    expect(text).toContain("bridge: { allow: ['notifications.*'] }");
    expect(text).toContain("https://docs.example/host#restricting-pages");
    expect(desktopConfig("My Site", "com.example.mysite", [], "x")).toContain("bridge: { allow: [] }");
    // What defineConfig takes, without the package installed there.
    writeFileSync(join(dir, "desktop.config.ts"), text.replace("import { defineConfig } from '@kitop/shell/config';", "const defineConfig = (c: object) => c;"));
    const { default: config } = await import(join(dir, "desktop.config.ts"));
    expect(config.bridge.allow).toEqual(["notifications.*"]);
    expect(config.appName).toBe("My Site");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
