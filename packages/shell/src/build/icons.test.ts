import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config.ts";
import { decodePng, encodePng, generateIcons } from "./icons.ts";

const tmp = mkdtempSync(join(tmpdir(), "sd-icons-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A white disc on a gradient square (full bleed) or on transparency (already shaped). */
function source(name: string, bleed: boolean, size = 1024): string {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, d = Math.hypot(x - size / 2, y - size / 2) / size;
      if (d < 0.3) px.set([255, 255, 255, 255], i);
      else if (bleed) px.set([40, 90 + (x * 100) / size, 200, 255], i);
      else if (d < 0.41) px.set([230, 80, 60, 255], i);
    }
  const file = join(tmp, name);
  writeFileSync(file, encodePng({ w: size, h: size, px }));
  return file;
}
const alphaAt = (png: string, fx: number, fy: number) => {
  const r = decodePng(readFileSync(png));
  return r.px[(Math.floor(fy * r.h) * r.w + Math.floor(fx * r.w)) * 4 + 3];
};
const bleed = source("bleed.png", true);
const shaped = source("shaped.png", false);

test("png codec round-trips RGBA", () => {
  const px = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255]);
  expect(decodePng(encodePng({ w: 2, h: 2, px })).px).toEqual(px);
});

test("a square artwork: macOS squircle on Apple's grid, every container", async () => {
  const icons = await generateIcons({ source: bleed }, join(tmp, "bleed"));
  expect(alphaAt(icons.macosPng, 0.5, 0.5)).toBe(255);
  expect(alphaAt(icons.macosPng, 0.05, 0.5)).toBe(0); // 100/1024 margin
  expect(alphaAt(icons.macosPng, 0.12, 0.12)).toBe(0); // rounded corner
  expect(alphaAt(icons.png(1024), 0.01, 0.01)).toBe(255); // desktop PNGs: as drawn

  const icns = readFileSync(icons.icns);
  expect(icns.toString("latin1", 0, 4)).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const types: string[] = [];
  for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4)) types.push(icns.toString("latin1", o, o + 4));
  expect(types).toEqual(["icp4", "icp5", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]);

  const ico = readFileSync(icons.ico);
  expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 7]);
  expect([...Array(7)].map((_, i) => ico[6 + 16 * i] || 256)).toEqual([16, 24, 32, 48, 64, 128, 256]);

  const composer = JSON.parse(readFileSync(join(icons.iconComposer, "icon.json"), "utf8"));
  expect(composer.groups[0].layers[0]["image-name"]).toBe("artwork.png");
  expect(composer.fill.solid).toBe("srgb:0.15686,0.35294,0.78431,1.00000"); // the corner color
  expect(decodePng(readFileSync(join(icons.iconComposer, "Assets", "artwork.png"))).w).toBe(1024);
});

test("transparent corners: taken as shaped; on the background in macOS 26's icon", async () => {
  const icons = await generateIcons({ source: shaped, background: "#123456" }, join(tmp, "shaped"));
  expect(readFileSync(icons.macosPng)).toEqual(readFileSync(icons.png(1024))); // no squircle
  const composer = JSON.parse(readFileSync(join(icons.iconComposer, "icon.json"), "utf8"));
  expect(composer.fill.solid).toBe("srgb:0.07059,0.20392,0.33725,1.00000");
  expect(alphaAt(join(icons.iconComposer, "Assets", "artwork.png"), 0.05, 0.05)).toBe(0); // artwork inset over the fill
});

test("generated once per source and options; rejects bad input before any work", async () => {
  const dir = join(tmp, "cache");
  const icons = await generateIcons({ source: bleed }, dir);
  const first = statSync(icons.icns).mtimeMs;
  await Bun.sleep(5);
  await generateIcons({ source: bleed }, dir);
  expect(statSync(icons.icns).mtimeMs).toBe(first);
  await generateIcons({ source: bleed, background: "#fff" }, dir);
  expect(statSync(icons.icns).mtimeMs).toBeGreaterThan(first);

  expect(generateIcons({ source: bleed, background: "teal" }, join(tmp, "bad"))).rejects.toThrow("not a hex color");
  expect(generateIcons({ source: join(tmp, "missing.png") }, join(tmp, "bad"))).rejects.toThrow("not found");
  expect(existsSync(join(tmp, "bad"))).toBe(false);
});

test("config: a path or { source, background }; icon.png found by default", () => {
  writeFileSync(join(tmp, "icon.png"), readFileSync(shaped));
  expect(resolveConfig(tmp, { appName: "A", identifier: "a.b" }).icon).toEqual({ source: join(tmp, "icon.png") });
  expect(resolveConfig(tmp, { appName: "A", identifier: "a.b", icon: "art/x.png" }).icon).toEqual({ source: join(tmp, "art/x.png") });
  expect(resolveConfig(tmp, { appName: "A", identifier: "a.b", icon: { source: "x.png", background: "#000" } }).icon).toEqual({ source: join(tmp, "x.png"), background: "#000" });
});
