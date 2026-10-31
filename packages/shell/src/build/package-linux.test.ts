import { expect, test } from "bun:test";
import { resolveConfig } from "../config.ts";
import { desktopEntry, linuxFileTypes, sharedMimeInfo } from "./package-linux.ts";

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
