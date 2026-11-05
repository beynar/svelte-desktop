// Linux desktop integration of the built notes app: what it was opened with
// (scheme URLs, documents → deepLink.getInitialUrls / app.getOpenedFiles, and
// openUrls / openFiles from a second instance), the .desktop / MIME declarations,
// and autosaveName (window frame across launches). Run by notes.sh after the main e2e.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launch } from "../../src/test.ts";

const dist = join(process.cwd(), ".desktop/dist/Svelte Notes");
const exe = join(dist, readdirSync(dist).find((f) => f === "svelte-notes")!);

test(".desktop entry declares the scheme and the document type", () => {
  const entry = readFileSync(join(dist, "share/applications/dev.kitop.notes.desktop"), "utf8");
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
    const second = Bun.spawn([exe, "svelte-notes://open/second", "opened-note.md"], { cwd: "/tmp", env: { ...process.env, KITOP_TEST: "" }, stdout: "ignore", stderr: "ignore" });
    expect((await urls).urls).toEqual(["svelte-notes://open/second"]);
    expect((await files).paths).toEqual([doc]);
    second.kill();
  } finally {
    await app.close();
  }
}, 120_000);

test("launch at login: the autostart entry, the user turning it off, and a launch from it", async () => {
  const entry = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart/dev.kitop.notes.desktop");
  let app = await launch({ timeout: 60_000 });
  try {
    await app.waitFor("#counter", { timeout: 20_000 });
    const state = () => app.platform<Record<string, boolean>>("app", "getLoginItem");
    expect(await state()).toEqual({ available: true, enabled: false, requiresApproval: false, launchedAtLogin: false });
    expect(await app.platform("app", "setLoginItem", { enabled: true })).toMatchObject({ enabled: true });
    const written = readFileSync(entry, "utf8");
    expect(written).toMatch(/^Exec=.* --launched-at-login$/m);
    writeFileSync(entry, written.replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false")); // the desktop's settings keep the file
    expect((await state()).enabled).toBe(false);
    expect(await app.platform("app", "setLoginItem", { enabled: false })).toMatchObject({ enabled: false });
    expect(existsSync(entry)).toBe(false);
  } finally {
    await app.close();
  }
  app = await launch({ args: ["--launched-at-login"], timeout: 60_000 });
  try {
    await app.waitFor("#counter", { timeout: 20_000 });
    expect(await app.platform("app", "getLoginItem")).toMatchObject({ launchedAtLogin: true });
    expect(await app.platform<{ paths: string[] }>("app", "getOpenedFiles")).toEqual({ paths: [] });
  } finally {
    await app.close();
  }
}, 120_000);

test("what the setters set reads back", async () => {
  const app = await launch({ timeout: 60_000 });
  try {
    await app.waitFor("#counter", { timeout: 20_000 });
    for (const enabled of [true, false]) {
      await app.platform("window", "setAlwaysOnTop", { enabled });
      expect(await app.platform("window", "isAlwaysOnTop")).toBe(enabled);
      await app.platform("window", "setVisibleOnAllWorkspaces", { enabled });
      expect(await app.platform("window", "isVisibleOnAllWorkspaces")).toBe(enabled);
    }
    await app.platform("window", "setMinSize", { width: 400, height: 300 });
    expect(await app.platform("window", "getMinSize")).toEqual({ width: 400, height: 300 });
    await app.platform("window", "setMaxSize", { width: 5000, height: 4000 });
    expect(await app.platform("window", "getMaxSize")).toEqual({ width: 5000, height: 4000 });
    expect(await app.platform("window", "getTitleBarStyle")).toEqual({ style: "hiddenInset", frameless: true });
    expect((await app.platform<{ width: number }>("window", "getContentSize")).width).toBeGreaterThan(0);
    expect(await app.platform("app", "getActivationPolicy")).toBe("regular");
    for (const enabled of [true, false]) {
      await app.platform("window", "setAlwaysOnBottom", { enabled });
      expect(await app.platform("window", "isAlwaysOnBottom")).toBe(enabled);
      await app.platform("window", "setCloseVeto", { enabled });
      expect(await app.platform("window", "hasCloseVeto")).toBe(enabled);
      await app.platform("window", "setFocusable", { enabled: !enabled });
      expect(await app.platform("window", "isFocusable")).toBe(!enabled);
    }
    await app.platform("window", "setDecorations", { enabled: false });
    expect(await app.platform("window", "hasDecorations")).toBe(false);
    await app.platform("window", "setDecorations", { enabled: true });
    const menus = async () => ((await app.platform<{ name: string }[] | null>("menu", "getAppMenu")) ?? []).map((m) => m.name);
    await app.platform("menu", "insert", { name: "Extras", items: [{ id: "x", title: "X" }] });
    expect(await menus()).toContain("Extras");
    await app.platform("menu", "remove", { name: "Extras" });
    expect(await menus()).not.toContain("Extras");
  } finally {
    await app.close();
  }
}, 120_000);

test("deepLink.register: installs the entry and sets the default, keeping what's there", async () => {
  const id = "dev.kitop.notes.desktop";
  const entry = join(homedir(), ".local/share/applications", id), list = join(homedir(), ".config/mimeapps.list");
  rmSync(entry, { force: true });
  mkdirSync(join(homedir(), ".config"), { recursive: true });
  writeFileSync(list, "[Default Applications]\ntext/plain=other.desktop\n");
  const app = await launch({ timeout: 60_000 });
  try {
    await app.waitFor("#counter", { timeout: 20_000 });
    expect(await app.platform("deepLink", "isDefault", { scheme: "svelte-notes" })).toBe(false);
    expect(await app.platform("deepLink", "register", { scheme: "svelte-notes://" })).toEqual({ scheme: "svelte-notes", registered: true });
    expect(await app.platform("deepLink", "register", { scheme: "other-scheme" })).toEqual({ scheme: "other-scheme", registered: true });
    expect(await app.platform("deepLink", "register", { scheme: "not a scheme" }).catch((e) => e.code)).toBe("invalid_args");
    const written = readFileSync(entry, "utf8");
    expect(written).toContain(`Exec='${exe}' %U`);
    expect(written).toMatch(/^MimeType=.*x-scheme-handler\/svelte-notes;.*x-scheme-handler\/other-scheme;/m);
    expect(written.match(/x-scheme-handler\/svelte-notes;/g)).toHaveLength(1);
    const defaults = readFileSync(list, "utf8");
    expect(defaults).toContain(`x-scheme-handler/svelte-notes=${id}`);
    expect(defaults).toContain("text/plain=other.desktop");
    let isDefault = false;
    for (let i = 0; i < 40 && !isDefault; i++) {
      isDefault = await app.platform("deepLink", "isDefault", { scheme: "svelte-notes" });
      if (!isDefault) await Bun.sleep(50);
    }
    expect(isDefault).toBe(true);
  } finally {
    await app.close();
  }
  rmSync(entry, { force: true });
  rmSync(list, { force: true });
}, 120_000);

test("default URL handler: not until the system says so", async () => {
  const id = "dev.kitop.notes.desktop";
  const isDefault = async () => {
    const app = await launch({ timeout: 60_000 });
    try {
      await app.waitFor("#counter", { timeout: 20_000 });
      expect(await app.platform("deepLink", "isDefault", { scheme: "not a scheme" }).catch((e) => e.code)).toBe("invalid_args");
      return await app.platform("deepLink", "isDefault", { scheme: "svelte-notes" });
    } finally {
      await app.close();
    }
  };
  expect(await isDefault()).toBe(false);
  // Installed for the user: GLib finds the entry, and mimeapps.list makes it the default.
  const entry = readFileSync(join(dist, `share/applications/${id}`), "utf8").replace(/^Exec=\S+/m, `Exec="${exe}"`);
  mkdirSync(join(homedir(), ".local/share/applications"), { recursive: true });
  mkdirSync(join(homedir(), ".config"), { recursive: true });
  writeFileSync(join(homedir(), ".local/share/applications", id), entry);
  writeFileSync(join(homedir(), ".config/mimeapps.list"), `[Default Applications]\nx-scheme-handler/svelte-notes=${id}\n`);
  expect(await isDefault()).toBe(true);
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
