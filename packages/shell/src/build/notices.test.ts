import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { metafileInputs, packageDirs, thirdPartyNotices } from "./notices.ts";

const root = mkdtempSync(join(tmpdir(), "notices-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pkg(dir: string, manifest: object, files: Record<string, string> = {}) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, name), text);
}

test("a module's package is the one after the last node_modules, scoped or not", () => {
  expect(
    packageDirs([
      "/app/node_modules/svelte/src/internal/client/index.js",
      "/app/node_modules/.bun/devalue@5.9.4/node_modules/devalue/index.js",
      "\0/app/node_modules/@sveltejs/kit/src/runtime/client/client.js?v=1",
      "C:\\app\\node_modules\\@scope\\name\\dist\\a.js",
      "/app/src/routes/+page.svelte",
    ]),
  ).toEqual(["/app/node_modules/svelte", "/app/node_modules/.bun/devalue@5.9.4/node_modules/devalue", "/app/node_modules/@sveltejs/kit", "C:/app/node_modules/@scope/name"]);
});

test("a Bun metafile's inputs, from where Bun ran", () => {
  const meta = { inputs: { "a.js": {}, "../node_modules/dep/index.js": {} } };
  const inputs = [resolve("/app/stage/a.js"), resolve("/app/node_modules/dep/index.js")];
  expect(metafileInputs(JSON.stringify(meta), "/app/stage")).toEqual(inputs);
  expect(metafileInputs(meta, "/app/stage")).toEqual(inputs);
});

test("the notices: Bun and what it links, kitop, the native libraries, then each package with its own license file", () => {
  pkg("node_modules/zed", { name: "zed", version: "2.0.0", license: "MIT" }, { "LICENSE.md": "ZED LICENSE TEXT" });
  pkg("node_modules/@scope/alpha", { name: "@scope/alpha", version: "1.0.0", license: { type: "ISC" } }, { COPYING: "ALPHA COPYING TEXT" });
  pkg("node_modules/bare", { name: "bare", version: "0.1.0", license: "Apache-2.0" });
  const text = thirdPartyNotices({
    appName: "Notes",
    target: "windows",
    bunVersion: "1.4.4",
    addons: false,
    modules: [join(root, "node_modules/zed/index.js"), join(root, "node_modules/zed/other.js"), join(root, "node_modules/@scope/alpha/a.js"), join(root, "node_modules/bare/b.js"), join(root, "src/app.js")],
  });
  expect(text).toStartWith("Notes includes the software below");
  expect(text).toContain("the WebView2 runtime, part of Windows or installed with it: it isn't in the app");
  expect(text).toContain("Bun 1.4.4, the runtime in the executable");
  expect(text).toContain("statically links JavaScriptCore");
  expect(text).toContain("@kitop/shell");
  expect(text).toContain("Niels Lohmann");
  expect(text).toContain("Microsoft WebView2 SDK headers");
  expect(text).not.toContain("webview/webview");
  expect(text).not.toContain("Node-API headers");
  // Sorted, once each, with their own text.
  const alpha = text.indexOf("@scope/alpha 1.0.0 (ISC)");
  const zed = text.indexOf("zed 2.0.0 (MIT)");
  expect(alpha).toBeGreaterThan(0);
  expect(zed).toBeGreaterThan(alpha);
  expect(text.split("zed 2.0.0 (MIT)").length).toBe(2);
  expect(text).toContain("ALPHA COPYING TEXT");
  expect(text).toContain("ZED LICENSE TEXT");
  expect(text).toContain("(bare has no license file; its package.json says Apache-2.0)");
  // Another Bun than the license's: said so.
  expect(thirdPartyNotices({ appName: "N", target: "macos", bunVersion: "1.5.0", addons: true, modules: [] })).toContain("(Bun 1.4.4's LICENSE.md)");
});
