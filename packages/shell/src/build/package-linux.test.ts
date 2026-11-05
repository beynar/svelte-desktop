import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config.ts";
import { extractArchive } from "../updater/archive.ts";
import { desktopEntry, linuxFileTypes, sharedMimeInfo } from "./package-linux.ts";
import { writeRelease } from "./package.ts";

test("fileTypes → MIME types (known ones reused, others declared)", () => {
  const c = resolveConfig("/tmp", {
    appName: "Notes",
    identifier: "dev.x.notes",
    fileTypes: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Notes bundle", extensions: [".notes"] },
      { name: "Custom", extensions: ["abc"], mimeTypes: ["application/vnd.custom"] },
    ],
  });
  const { mimes, declared } = linuxFileTypes(c);
  expect(mimes).toEqual(["text/markdown", "application/x-dev-x-notes-notes", "application/vnd.custom"]);
  expect(declared).toEqual([{ type: "application/x-dev-x-notes-notes", comment: "Notes bundle", glob: "*.notes" }]);
  const xml = sharedMimeInfo(declared);
  expect(xml).toContain('<mime-type type="application/x-dev-x-notes-notes">');
  expect(xml).toContain('<glob pattern="*.notes"/>');
});

test("desktop entry: file id = identifier (notifications desktop-entry hint), GNOME notification settings", () => {
  const c = resolveConfig("/tmp", { appName: "Notes", identifier: "dev.x.notes" });
  const entry = desktopEntry(c, "notes", true);
  expect(entry).toContain("StartupWMClass=dev.x.notes\n");
  expect(entry).toContain("Icon=dev.x.notes\n");
  expect(entry).toContain("X-GNOME-UsesNotifications=true\n");
});

test("release: the folder under linux-<arch>, the AppImage under appimage-<arch>, each in its archive", async () => {
  const dist = mkdtempSync(join(tmpdir(), "release-linux-"));
  try {
    const app = join(dist, "My Notes");
    mkdirSync(join(app, "lib"), { recursive: true });
    writeFileSync(join(app, "notes"), "exe");
    writeFileSync(join(app, "lib", "libshell.so"), "lib");
    const image = join(dist, "my-notes-1.2.0-linux-x64.AppImage");
    writeFileSync(image, "image", { mode: 0o755 });
    const c = resolveConfig(dist, { appName: "My Notes", identifier: "dev.x.notes", version: "1.2.0", update: { manifestUrl: "https://u.example/update.json", publicKey: "k" } });
    const r = await writeRelease(c, app, ["x64"], dist, "linux", image);
    expect(r.signed).toBe(false);
    const m = await Bun.file(r.manifest).json();
    expect(Object.keys(m.artifacts).sort()).toEqual(["appimage-x64", "linux-x64"]);
    expect(m.artifacts["linux-x64"].url).toBe("1.2.0/MyNotes-1.2.0-linux-x64.tar.zst");
    expect(m.artifacts["appimage-x64"]).toMatchObject({ url: "1.2.0/MyNotes-1.2.0-appimage-x64.tar.zst", format: "tar.zst" });

    const out = join(dist, "out");
    await extractArchive(join(dist, "release", m.artifacts["appimage-x64"].url), "tar.zst", join(out, "image"));
    expect(await Bun.file(join(out, "image", "my-notes-1.2.0-linux-x64.AppImage")).text()).toBe("image");
    await extractArchive(join(dist, "release", m.artifacts["linux-x64"].url), "tar.zst", join(out, "folder"));
    expect(await Bun.file(join(out, "folder", "My Notes", "lib", "libshell.so")).text()).toBe("lib");

    // No AppImage made (no appimagetool): the folder alone.
    const alone = await writeRelease(c, app, ["x64"], dist, "linux");
    expect(Object.keys((await Bun.file(alone.manifest).json()).artifacts)).toEqual(["linux-x64"]);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
