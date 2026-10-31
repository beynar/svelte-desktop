// Linux desktop integration of the built notes app: what it was opened with
// (scheme URLs, documents → deepLink.getInitialUrls / app.getOpenedFiles, and
// openUrls / openFiles from a second instance), the .desktop / MIME declarations,
// and autosaveName (window frame across launches). Run by notes.sh after the main e2e.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../../src/test.ts";

const dist = join(process.cwd(), ".desktop/dist/Svelte Notes");
const exe = join(dist, readdirSync(dist).find((f) => f === "svelte-notes")!);

test(".desktop entry declares the scheme and the document type", () => {
  const entry = readFileSync(join(dist, "share/applications/dev.svelte-desktop.notes.desktop"), "utf8");
  expect(entry).toContain("Exec=svelte-notes %U");
  expect(entry).toMatch(/MimeType=.*x-scheme-handler\/svelte-notes;/);
  expect(entry).toMatch(/MimeType=.*text\/markdown;/);
});

test("opened with a URL and a document: initial URLs, opened files, openUrls/openFiles from a second instance", async () => {
  const doc = "/tmp/opened-note.md";
  writeFileSync(doc, "# hello\n");
  const app = await launch({ args: ["svelte-notes://open/first", doc], timeout: 60_000 });
  try {
    await app.waitFor("#counter", { timeout: 20_000 });
    expect(await app.platform<string[]>("deepLink", "getInitialUrls")).toEqual(["svelte-notes://open/first"]);
    expect(await app.platform<{ paths: string[] }>("app", "getOpenedFiles")).toEqual({ paths: [doc] });
    expect(await app.platform<{ paths: string[] }>("app", "getOpenedFiles")).toEqual({ paths: [] }); // read once
    // Single instance: a second launch hands its arguments to this one.
    expect(await app.platform<{ acquired: boolean }>("app", "requestSingleInstanceLock")).toEqual({ acquired: true });
    const urls = app.nextEvent<{ urls: string[] }>("openUrls");
    const files = app.nextEvent<{ paths: string[] }>("openFiles");
    const second = Bun.spawn([exe, "svelte-notes://open/second", "opened-note.md"], { cwd: "/tmp", env: { ...process.env, SVELTE_DESKTOP_TEST: "" }, stdout: "ignore", stderr: "ignore" });
    expect((await urls).urls).toEqual(["svelte-notes://open/second"]);
    expect((await files).paths).toEqual([doc]);
    second.kill();
  } finally {
    await app.close();
  }
}, 120_000);

test("autosaveName: the window frame comes back on the next launch", async () => {
  let app = await launch({ timeout: 60_000 });
  await app.waitFor("#counter", { timeout: 20_000 });
  await app.platform("window", "setBounds", { x: 140, y: 120, width: 700, height: 500 });
  await Bun.sleep(800); // the frame is saved 300 ms after the last change
  const before = (await app.platform<{ bounds: { x: number; y: number; width: number; height: number } }>("window", "getBounds")).bounds;
  await app.close();
  app = await launch({ timeout: 60_000 });
  try {
    await app.waitFor("#counter", { timeout: 20_000 });
    const after = (await app.platform<{ bounds: { x: number; y: number; width: number; height: number } }>("window", "getBounds")).bounds;
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(4);
  } finally {
    await app.close();
  }
}, 120_000);
