// App icons: one source image → every target's icon files, generated at build (cached in
// .desktop/icons) or with `svelte-desktop icon`. Bun.Image decodes and resamples; the
// shaping (macOS squircle, iOS flatten, Android adaptive layers) and the containers
// (.icns, .ico) are written here — no sips/iconutil, so any OS builds any target's icons.
//
// A full-bleed source (opaque corners: a square artwork) is shaped per platform the way
// each expects; a source with transparent corners is taken as already shaped.
import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export interface IconSpec {
  /** Absolute path of the source: PNG, JPEG or WebP, square, 1024 px or more (SVG on macOS). */
  source: string;
  /** Hex color behind the artwork where a platform needs an opaque or layered icon
   *  (iOS, Android adaptive background). Default: the artwork's corner color, else white. */
  background?: string;
}

/** Paths of the generated files (all absolute). */
export interface AppIcons {
  dir: string;
  /** macOS bundle icon. */
  icns: string;
  /** macOS-shaped 1024 px PNG (the dev Dock icon). */
  macosPng: string;
  /** macOS 26: Icon Composer bundle (artwork layer over the background; the system shapes and
   *  lights it), compiled into Assets.car by the macOS packager. */
  iconComposer: string;
  /** Windows: 16–256 px. */
  ico: string;
  /** Unshaped PNG at a desktop size (Linux, Windows toasts): 16, 32, 48, 64, 128, 256, 512 or 1024. */
  png: (size: (typeof DESKTOP_SIZES)[number]) => string;
  /** iOS: opaque 1024 px PNG (the system applies the mask). */
  ios: string;
  /** Android `res` tree: mipmap-* (legacy, round, adaptive foreground) + adaptive XML + background color. */
  androidRes: string;
}

const VERSION = 2; // bump when the output changes for the same input
const DESKTOP_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024] as const;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// OSType → pixel size; PNG payloads are valid for all of them (macOS 10.7+).
const ICNS_TYPES: Array<[string, number]> = [
  ["icp4", 16], ["icp5", 32], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
  ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
];
const ANDROID_DENSITIES: Array<[string, number]> = [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]];
const MASTER = 1024;

/** The icons for `spec`, generated into `<root>/.desktop/icons` unless already up to date. */
export async function appIcons(root: string, spec: IconSpec): Promise<AppIcons> {
  return generateIcons(spec, join(root, ".desktop", "icons"));
}

export async function generateIcons(spec: IconSpec, dir: string, opts: { force?: boolean } = {}): Promise<AppIcons> {
  if (!existsSync(spec.source)) throw new Error(`icon: ${spec.source} not found`);
  if (spec.background !== undefined) parseColor(spec.background); // fail before any work
  const out = paths(dir);
  const stamp = createHash("sha256").update(readFileSync(spec.source)).update(JSON.stringify({ VERSION, background: spec.background ?? null })).digest("hex");
  const stampFile = join(dir, ".stamp");
  if (!opts.force && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return out;

  const master = await loadMaster(spec.source);
  const bleed = fullBleed(master);
  const background = spec.background !== undefined ? parseColor(spec.background) : bleed ? cornerColor(master) : ([255, 255, 255] as Rgb);

  rmSync(dir, { recursive: true, force: true });
  for (const d of ["macos", "windows", "png", "ios", "android/res/mipmap-anydpi-v26", "android/res/values"]) mkdirSync(join(dir, d), { recursive: true });

  // Desktop (Linux, Windows): the artwork as drawn.
  for (const s of DESKTOP_SIZES) writeFileSync(out.png(s), await resized(master, s));
  writeFileSync(out.ico, await ico(master));

  // macOS: a square artwork goes on Apple's grid (824 px squircle on a 1024 canvas).
  const mac = bleed ? mask(await place(master, 824 / 1024), "squircle", 100 / 1024) : master;
  writeFileSync(out.macosPng, encodePng(mac));
  writeFileSync(out.icns, await icns(mac));
  mkdirSync(join(out.iconComposer, "Assets"), { recursive: true });
  writeFileSync(join(out.iconComposer, "Assets", "artwork.png"), encodePng(bleed ? master : await place(master, 0.8)));
  writeFileSync(join(out.iconComposer, "icon.json"), iconComposerJson(background));

  // iOS: opaque, full-bleed (the system rounds it); a shaped artwork sits on the background.
  writeFileSync(out.ios, encodePng(flatten(bleed ? master : await place(master, 0.8), background), { opaque: true }));

  // Android: legacy (pre-8.0) square and round icons, and the adaptive foreground (108 dp,
  // content kept inside the 72 dp visible area) over a background color.
  const round = mask(bleed ? master : flatten(await place(master, 0.8), background), "circle", 0);
  const foreground = await place(master, bleed ? 72 / 108 : 0.6);
  for (const [density, scale] of ANDROID_DENSITIES) {
    const res = join(out.androidRes, `mipmap-${density}`);
    mkdirSync(res, { recursive: true });
    writeFileSync(join(res, "ic_launcher.png"), await resized(mac, Math.round(48 * scale)));
    writeFileSync(join(res, "ic_launcher_round.png"), await resized(round, Math.round(48 * scale)));
    writeFileSync(join(res, "ic_launcher_foreground.png"), await resized(foreground, Math.round(108 * scale)));
  }
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n</adaptive-icon>\n`;
  writeFileSync(join(out.androidRes, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptive);
  writeFileSync(join(out.androidRes, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptive);
  writeFileSync(join(out.androidRes, "values", "ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${hex(background)}</color>\n</resources>\n`);

  writeFileSync(stampFile, stamp);
  return out;
}

function paths(dir: string): AppIcons {
  return {
    dir,
    icns: join(dir, "macos", "AppIcon.icns"),
    macosPng: join(dir, "macos", "AppIcon.png"),
    iconComposer: join(dir, "macos", "AppIcon.icon"),
    ico: join(dir, "windows", "app.ico"),
    png: (size) => join(dir, "png", `${size}.png`),
    ios: join(dir, "ios", "AppIcon.png"),
    androidRes: join(dir, "android", "res"),
  };
}

// ---------------------------------------------------------------------------
// Rasters (RGBA, straight alpha)

type Raster = { w: number; h: number; px: Uint8Array };
type Rgb = [number, number, number];

/** The source on a transparent MASTER×MASTER canvas (centered if not square). */
async function loadMaster(source: string): Promise<Raster> {
  if (/\.svg$/i.test(source)) source = await rasterizeSvg(source);
  const { width, height } = await new Bun.Image(source).metadata();
  if (Math.max(width, height) < MASTER) console.warn(`  \x1b[33m!\x1b[0m icon: ${source} is ${width}×${height}, upscaled to ${MASTER} px (use ${MASTER} px or more)`);
  const fitted = decodePng(await new Bun.Image(source).resize(MASTER, MASTER, { fit: "inside" }).png().bytes());
  return fitted.w === MASTER && fitted.h === MASTER ? fitted : centered(fitted, MASTER);
}

/** SVG → PNG with the system's renderer: sips on macOS (Bun.Image has no SVG decoder). */
async function rasterizeSvg(svg: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error(`icon: ${svg}: SVG sources need macOS (sips); export a ${MASTER} px PNG`);
  const png = join(mkdtempSync(join(tmpdir(), "sd-icon-")), "source.png");
  const r = await $`sips -s format png -Z ${MASTER} ${svg} --out ${png}`.nothrow().quiet();
  if (r.exitCode !== 0 || !existsSync(png)) throw new Error(`icon: ${svg}: sips could not render it (${r.stderr.toString().trim()})`);
  return png;
}

function centered(r: Raster, size: number): Raster {
  const px = new Uint8Array(size * size * 4);
  const ox = (size - r.w) >> 1, oy = (size - r.h) >> 1;
  for (let y = 0; y < r.h; y++) px.set(r.px.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((oy + y) * size + ox) * 4);
  return { w: size, h: size, px };
}

/** `r` scaled to `fraction` of the canvas, centered on a transparent canvas of the same size. */
async function place(r: Raster, fraction: number): Promise<Raster> {
  const s = Math.round(r.w * fraction);
  return centered(decodePng(await new Bun.Image(encodePng(r)).resize(s, s).png().bytes()), r.w);
}

async function resized(r: Raster, size: number): Promise<Uint8Array> {
  return size === r.w ? encodePng(r) : new Bun.Image(encodePng(r)).resize(size, size).png().bytes();
}

/** Opaque corners: a square artwork, to be shaped per platform. */
function fullBleed(r: Raster): boolean {
  const inset = 4;
  return [[inset, inset], [r.w - 1 - inset, inset], [inset, r.h - 1 - inset], [r.w - 1 - inset, r.h - 1 - inset]].every(([x, y]) => r.px[(y! * r.w + x!) * 4 + 3]! >= 250);
}

function cornerColor(r: Raster): Rgb {
  const i = (4 * r.w + 4) * 4;
  return [r.px[i]!, r.px[i + 1]!, r.px[i + 2]!];
}

function flatten(r: Raster, bg: Rgb): Raster {
  const px = new Uint8Array(r.px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = r.px[i + 3]! / 255;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(r.px[i + c]! * a + bg[c]! * (1 - a));
    px[i + 3] = 255;
  }
  return { w: r.w, h: r.h, px };
}

/** Multiply alpha by the coverage of a centered squircle (Apple's continuous-corner shape,
 *  approximated by a superellipse, n = 5) or circle, `inset` (fraction) from each edge. */
function mask(r: Raster, shape: "squircle" | "circle", inset: number): Raster {
  const px = r.px.slice();
  const half = (r.w * (1 - 2 * inset)) / 2, c = r.w / 2, n = shape === "circle" ? 2 : 5;
  const inside = (x: number, y: number) => Math.abs((x - c) / half) ** n + Math.abs((y - c) / half) ** n <= 1;
  const SS = 4; // 4×4 supersampling on the edge
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const i = (y * r.w + x) * 4;
      const corners = +inside(x, y) + +inside(x + 1, y) + +inside(x, y + 1) + +inside(x + 1, y + 1);
      if (corners === 4) continue;
      let cover = 0;
      if (corners > 0) for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) cover += +inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      px[i + 3] = Math.round((px[i + 3]! * cover) / (SS * SS));
    }
  return { w: r.w, h: r.h, px };
}

function parseColor(s: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) throw new Error(`icon.background: "${s}" is not a hex color (#rrggbb)`);
  const h = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join("") : m[1]!;
  return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)) as Rgb;
}

const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ---------------------------------------------------------------------------
// Containers

/** One flat layer (no glass, shadow or translucency: the artwork as drawn) on a solid fill. */
function iconComposerJson(fill: Rgb): string {
  const color = `srgb:${fill.map((v) => (v / 255).toFixed(5)).join(",")},1.00000`;
  const icon = {
    fill: { solid: color },
    groups: [{ layers: [{ "image-name": "artwork.png", name: "artwork", glass: false }], shadow: { kind: "none", opacity: 0 }, translucency: { enabled: false, value: 0 } }],
    "supported-platforms": { squares: "shared" },
  };
  return `${JSON.stringify(icon, null, 2)}\n`;
}

async function icns(r: Raster): Promise<Buffer> {
  const entries = await Promise.all(
    ICNS_TYPES.map(async ([type, size]) => {
      const png = await resized(r, size);
      const head = Buffer.alloc(8);
      head.write(type, 0, "latin1");
      head.writeUInt32BE(8 + png.length, 4);
      return Buffer.concat([head, png]);
    }),
  );
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

/** BMP entries up to 64 px (NSIS and older shell code paths read only those), PNG above. */
async function ico(r: Raster): Promise<Buffer> {
  const entries = await Promise.all(
    ICO_SIZES.map(async (size) => {
      const png = await resized(r, size);
      return { size, data: size >= 128 ? Buffer.from(png) : iconDib(decodePng(png)) };
    }),
  );
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    head[o] = head[o + 1] = e.size >= 256 ? 0 : e.size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(e.data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

/** 32-bit BGRA DIB, bottom-up, with the 1-bit AND mask an icon entry carries. */
function iconDib(r: Raster): Buffer {
  const stride = r.w * 4, maskStride = Math.ceil(r.w / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(r.w, 4);
  header.writeInt32LE(r.h * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE((stride + maskStride) * r.h, 20);
  const xor = Buffer.alloc(stride * r.h), and = Buffer.alloc(maskStride * r.h);
  for (let y = 0; y < r.h; y++) {
    const dst = r.h - 1 - y;
    for (let x = 0; x < r.w; x++) {
      const s = (y * r.w + x) * 4, d = dst * stride + x * 4;
      xor[d] = r.px[s + 2]!;
      xor[d + 1] = r.px[s + 1]!;
      xor[d + 2] = r.px[s]!;
      xor[d + 3] = r.px[s + 3]!;
      if (r.px[s + 3]! < 128) and[dst * maskStride + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, xor, and]);
}

// ---------------------------------------------------------------------------
// PNG (what Bun.Image emits: 8- or 16-bit gray/RGB/palette/±alpha, not interlaced)

export function decodePng(buf: Uint8Array): Raster {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("icon: not a PNG");
  let w = 0, h = 0, depth = 0, type = 0, palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o), name = b.toString("latin1", o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
    if (name === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8]!;
      type = data[9]!;
      if (data[12]) throw new Error("icon: interlaced PNG");
    } else if (name === "PLTE") palette = data;
    else if (name === "tRNS") trns = data;
    else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || (depth !== 8 && depth !== 16) || (type === 3 && depth !== 8)) throw new Error(`icon: unsupported PNG (type ${type}, ${depth}-bit)`);
  const bpp = (channels * depth) / 8, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!, src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[dst + x - bpp]! : 0, up = y ? rows[dst - stride + x]! : 0, ul = y && x >= bpp ? rows[dst - stride + x - bpp]! : 0;
      const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
      const pred = f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul) : 0;
      rows[dst + x] = (raw[src + x]! + pred) & 0xff;
    }
  }
  const px = new Uint8Array(w * h * 4), step = depth / 8;
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp, ch = (k: number) => rows[s + k * step]!; // 16-bit: the high byte
    let r: number, g: number, bl: number, al = 255;
    if (type === 3) {
      const idx = rows[s]!;
      [r, g, bl] = [palette![idx * 3]!, palette![idx * 3 + 1]!, palette![idx * 3 + 2]!];
      if (trns && idx < trns.length) al = trns[idx]!;
    } else if (type === 0 || type === 4) {
      r = g = bl = ch(0);
      if (type === 4) al = ch(1);
    } else {
      [r, g, bl] = [ch(0), ch(1), ch(2)];
      if (type === 6) al = ch(3);
    }
    px.set([r, g, bl, al], i * 4);
  }
  return { w, h, px };
}

/** RGBA, or RGB with `opaque` (the App Store rejects an iOS icon that has an alpha channel). */
export function encodePng(r: Raster, opts: { opaque?: boolean } = {}): Uint8Array {
  const ch = opts.opaque ? 3 : 4, stride = r.w * ch;
  const rows = Buffer.alloc((stride + 1) * r.h); // filter 0 on every row
  for (let i = 0; i < r.w * r.h; i++) {
    const d = Math.floor(i / r.w) * (stride + 1) + 1 + (i % r.w) * ch;
    for (let c = 0; c < ch; c++) rows[d + c] = r.px[i * 4 + c]!;
  }
  const chunk = (name: string, data: Buffer) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(name, "latin1"), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.w, 0);
  ihdr.writeUInt32BE(r.h, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
