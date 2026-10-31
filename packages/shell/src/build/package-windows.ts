// Windows packaging, called by packageApp (package.ts) when build.target is
// 'windows' (or the host is Windows). Cross-builds from macOS/Linux:
//
//   staged server graph → bun build --compile --target=bun-windows-<arch>
//   --windows-hide-console → icon + version resources (patched into the PE here
//   when not on Windows: Bun only edits resources on a Windows host) →
//   <outDir>/<appName>-windows-<arch>/ { <Exe>.exe, shell.dll, app-native.dll,
//   addons/*.node, sidecars } → Authenticode (osslsigncode) → .zip → NSIS
//   per-user installer → release/ (tar.zst of the folder contents + update.json
//   key windows-<arch>) for the updater.
//
// Runtime layout contract (src/os.ts): shell.dll and app-native.dll sit next to
// the .exe; data in %APPDATA%\<identifier>, caches/logs in %LOCALAPPDATA%.
//
// Native code is cross-compiled with llvm-mingw in Docker (native/docker/windows):
// shell.dll (native/build-windows.sh), the plugin's C/C++ sources → app-native.dll,
// native/addons/*.c|cc|cpp → <name>.node (napi_* resolved from the host .exe via a
// delay-load hook, as node-gyp does). Swift / Objective-C plugins are macOS-only.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import type { Arch, PackageResult } from "./package.ts";

const shellRoot = resolve(import.meta.dir, "../..");
const nativeRoot = join(shellRoot, "native");
const IMAGE = process.env.SVELTE_DESKTOP_WINDOWS_IMAGE ?? "svelte-desktop-windows";
const log = (s: string) => console.log(`  \x1b[36m▸\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const mb = (p: string) => `${(statSync(p).size / 1048576).toFixed(1)} MB`;
const isWindowsHost = process.platform === "win32";

/** "Svelte Notes" → "SvelteNotes" (same rule as the macOS executable). */
export function windowsExeName(appName: string): string {
  return `${appName.replace(/[^A-Za-z0-9_-]/g, "") || "App"}.exe`;
}

/** "1.2.3-beta.1" → [1, 2, 3, 0] (VS_FIXEDFILEINFO / --windows-version). */
export function fileVersion(version: string): [number, number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(version) ?? [];
  return [1, 2, 3, 4].map((i) => Math.min(65535, Number(m[i] ?? 0))) as [number, number, number, number];
}

// ---------------------------------------------------------------------------
// Toolchain (Docker image with llvm-mingw, WebView2 headers, NSIS, osslsigncode)

let dockerOk: boolean | undefined;
async function hasDocker(): Promise<boolean> {
  if (dockerOk === undefined) dockerOk = (await $`docker info --format x`.nothrow().quiet()).exitCode === 0;
  return dockerOk;
}

async function ensureImage(): Promise<void> {
  if ((await $`docker image inspect ${IMAGE}`.nothrow().quiet()).exitCode === 0) return;
  log(`docker: building the ${IMAGE} toolchain image (llvm-mingw, WebView2 SDK, NSIS, osslsigncode)`);
  const r = await $`docker build -q -t ${IMAGE} ${join(nativeRoot, "docker", "windows")}`.nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`docker build ${IMAGE} failed:\n${r.stderr.toString()}`);
}

/** Run a shell script in the toolchain container with host directories mounted. */
async function inToolchain(mounts: Array<[string, string]>, script: string): Promise<{ ok: boolean; out: string }> {
  await ensureImage();
  const args = mounts.flatMap(([host, container]) => ["-v", `${host}:${container}`]);
  const r = await $`docker run --rm ${args} ${IMAGE} sh -c ${script}`.nothrow().quiet();
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
}

async function onPath(tool: string): Promise<boolean> {
  return (await $`${isWindowsHost ? "where" : "which"} ${tool}`.nothrow().quiet()).exitCode === 0;
}

function newestMtime(paths: string[]): number {
  let newest = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestMtime(readdirSync(p).map((f) => join(p, f))));
    else newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

export function shellDllPath(arch: Arch): string {
  return join(nativeRoot, "build", `windows-${arch}`, "shell.dll");
}

/** shell.dll for `arch`: prebuilt override, else native/build/windows-<arch>/shell.dll (rebuilt in Docker when stale). */
export async function ensureShellDll(arch: Arch): Promise<string> {
  const prebuilt = process.env[`SVELTE_DESKTOP_SHELL_DLL_${arch.toUpperCase()}`] ?? (arch === "x64" ? process.env.SVELTE_DESKTOP_SHELL_DLL : undefined);
  if (prebuilt) return prebuilt;
  const dll = shellDllPath(arch);
  const sources = ["windows", "portable", "shell.h", "include/svelte_desktop.h", "docker/windows/Dockerfile", "docker/windows/build.sh"].map((p) => join(nativeRoot, p));
  if (existsSync(dll) && statSync(dll).mtimeMs >= newestMtime(sources)) return dll;
  if (!(await hasDocker())) {
    if (existsSync(dll)) {
      warn(`shell.dll (${arch}) is older than native/windows sources and Docker is unavailable: using the stale build`);
      return dll;
    }
    throw new Error(`shell.dll (${arch}) is not built and Docker is unavailable: run native/build-windows.sh ${arch} where Docker runs, or set SVELTE_DESKTOP_SHELL_DLL_${arch.toUpperCase()}`);
  }
  log(`native: building shell.dll (${arch}, llvm-mingw in Docker)`);
  const r = await $`${join(nativeRoot, "build-windows.sh")} ${arch}`.nothrow().quiet();
  if (r.exitCode !== 0 || !existsSync(dll)) throw new Error(`native/build-windows.sh ${arch} failed:\n${r.stdout.toString()}${r.stderr.toString()}`);
  return dll;
}

const triple = (arch: Arch) => (arch === "arm64" ? "aarch64-w64-mingw32" : "x86_64-w64-mingw32");
const isPE = (file: string) => {
  try {
    const b = readFileSync(file);
    return b.length > 64 && b[0] === 0x4d && b[1] === 0x5a;
  } catch {
    return false;
  }
};

function listSources(dir: string, skipAddons = true): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!(skipAddons && e.name === "addons")) out.push(...listSources(p, skipAddons));
    } else if (/\.(swift|m|mm|c|cc|cpp)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The app's native plugin → app-native.dll (C/C++ only; Swift/Objective-C are macOS-only). */
export async function buildWindowsPlugin(c: ResolvedConfig, arch: Arch, outDir: string): Promise<string | null> {
  if (!c.native) return null;
  const files = listSources(c.native);
  if (!files.length) return null;
  const apple = files.filter((f) => /\.(swift|m|mm)$/.test(f));
  if (apple.length) {
    log(`native plugin: skipped on Windows (${apple.map((f) => relative(c.root, f)).join(", ")}: Swift/Objective-C can't be cross-compiled; a C/C++ plugin against native/include/svelte_desktop.h ships on every OS)`);
    return null;
  }
  if (!(await hasDocker())) {
    warn("native plugin: skipped (cross-compiling C/C++ for Windows needs Docker)");
    return null;
  }
  mkdirSync(outDir, { recursive: true });
  const rel = files.map((f) => `/plugin/${relative(c.native!, f).split("\\").join("/")}`);
  const cxx = files.some((f) => /\.(cc|cpp)$/.test(f));
  const script = [
    "set -e",
    `for f in ${rel.map((r) => `'${r}'`).join(" ")}; do`,
    `  case "$f" in *.c) ${triple(arch)}-clang -std=c17 -O2 -c -I/sdinclude "$f" -o "/tmp/$(basename "$f").o" ;;`,
    `  *) ${triple(arch)}-clang++ -std=c++17 -O2 -c -I/sdinclude "$f" -o "/tmp/$(basename "$f").o" ;; esac`,
    "done",
    `${triple(arch)}-${cxx ? "clang++" : "clang"} -shared -static -s -o /out/app-native.dll /tmp/*.o`,
  ].join("\n");
  log(`native plugin: ${files.map((f) => relative(c.root, f)).join(", ")} → app-native.dll (${arch})`);
  const r = await inToolchain([[c.native, "/plugin:ro"], [join(nativeRoot, "include"), "/sdinclude:ro"], [outDir, "/out"]], script);
  if (!r.ok) throw new Error(`native plugin (Windows ${arch}) failed:\n${r.out}`);
  return join(outDir, "app-native.dll");
}

// Node-API addons on Windows import napi_* from "node.exe"; node-gyp delay-loads
// them and redirects to the host process. Same here: the import library is
// generated from the vendored node_api.h, and the hook maps node.exe to the
// running executable (a Bun --compile exe exports the N-API symbols).
const NODE_HOOK = `#include <windows.h>
#include <delayimp.h>
#include <string.h>
static FARPROC WINAPI sd_node_exe_hook(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && info && info->szDll && _stricmp(info->szDll, "node.exe") == 0)
    return (FARPROC)GetModuleHandleW(NULL);
  return NULL;
}
PfnDliHook __pfnDliNotifyHook2 = sd_node_exe_hook;
`;

/** native/addons/*.c|cc|cpp → <name>.node for Windows; prebuilt `addons` are kept only if they are PE files. */
export async function buildWindowsAddons(c: ResolvedConfig, arch: Arch, outDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dir = c.native ? join(c.native, "addons") : null;
  const sources = dir && existsSync(dir) ? readdirSync(dir).filter((f) => /\.(c|cc|cpp)$/.test(f)) : [];
  if (sources.length) {
    if (!(await hasDocker())) warn(`addons: skipped ${sources.join(", ")} (cross-compiling for Windows needs Docker)`);
    else {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "sd_node_hook.c"), NODE_HOOK);
      const machine = arch === "arm64" ? "arm64" : "i386:x86-64";
      const script = [
        "set -e",
        "cd /out",
        `grep -ho 'NAPI_EXTERN[^;]*' /napi/js_native_api.h /napi/node_api.h | tr '\\n' ' ' | grep -o '\\b\\(napi\\|node_api\\)_[a-z0-9_]*\\s*(' | tr -d '( ' | sort -u > node.names`,
        `{ echo 'LIBRARY node.exe'; echo EXPORTS; cat node.names; } > node.def`,
        `llvm-dlltool -m ${machine} -d node.def -D node.exe -l libnode.a`,
        ...sources.map((src) => {
          const name = src.replace(/\.[^.]+$/, "");
          const cc = /\.(cc|cpp)$/.test(src) ? `${triple(arch)}-clang++ -std=c++17` : `${triple(arch)}-clang -std=c17`;
          return `${cc} -shared -static -s -O2 -I/napi -DNODE_GYP_MODULE_NAME=${name} '/addons/${src}' sd_node_hook.c -o '${name}.node' -L. -lnode -Wl,-delayload=node.exe`;
        }),
      ].join("\n");
      log(`addons: ${sources.join(", ")} → .node (${arch}, delay-loaded N-API)`);
      const r = await inToolchain([[dir!, "/addons:ro"], [join(nativeRoot, "vendor", "node-api", "include"), "/napi:ro"], [outDir, "/out"]], script);
      if (!r.ok) throw new Error(`addons (Windows ${arch}) failed:\n${r.out}`);
      for (const src of sources) out[src.replace(/\.[^.]+$/, "")] = join(outDir, `${src.replace(/\.[^.]+$/, "")}.node`);
    }
  }
  for (const [name, path] of Object.entries(c.addons ?? {})) {
    const abs = resolve(c.root, path);
    if (!existsSync(abs)) throw new Error(`addon "${name}": ${abs} not found`);
    if (isPE(abs)) out[name] = abs;
    else warn(`addon "${name}": ${relative(c.root, abs)} is not a Windows binary, not shipped (provide a Windows .node)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Icon: PNG → .ico (BMP entries ≤ 64 px for NSIS and old shell code paths, PNG above)

function bmpToIconDib(bmp: Buffer): Buffer | null {
  if (bmp.readUInt16LE(0) !== 0x4d42) return null;
  const off = bmp.readUInt32LE(10);
  const w = bmp.readInt32LE(18), hRaw = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28);
  if (bpp !== 32) return null;
  const h = Math.abs(hRaw), topDown = hRaw < 0, stride = w * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(stride * h + maskStride * h, 20);
  const xor = Buffer.alloc(stride * h), and = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const src = off + stride * (topDown ? y : h - 1 - y); // source row in top-down order
    const dst = h - 1 - y; // icon DIBs are bottom-up
    bmp.copy(xor, dst * stride, src, src + stride);
    for (let x = 0; x < w; x++) if (bmp[src + x * 4 + 3]! < 128) and[dst * maskStride + (x >> 3)]! |= 0x80 >> (x & 7);
  }
  return Buffer.concat([header, xor, and]);
}

function icoFile(entries: Array<{ size: number; data: Buffer }>): Buffer {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    head[o] = e.size >= 256 ? 0 : e.size;
    head[o + 1] = e.size >= 256 ? 0 : e.size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(e.data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

export async function buildIco(png: string, work: string): Promise<Buffer> {
  const dir = join(work, "ico");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!(await onPath("sips"))) {
    // No resampler outside macOS: one PNG entry, Windows scales it.
    const data = readFileSync(png);
    const w = data.readUInt32BE(16);
    log("icon: sips unavailable, single-size .ico from the PNG");
    return icoFile([{ size: Math.min(256, w), data }]);
  }
  const entries: Array<{ size: number; data: Buffer }> = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const p = join(dir, `${size}.png`);
    await $`sips -z ${size} ${size} ${png} --out ${p}`.quiet();
    if (size >= 128) {
      entries.push({ size, data: readFileSync(p) });
      continue;
    }
    const b = join(dir, `${size}.bmp`);
    await $`sips -s format bmp ${p} --out ${b}`.quiet();
    const dib = bmpToIconDib(readFileSync(b));
    entries.push({ size, data: dib ?? readFileSync(p) });
  }
  return icoFile(entries);
}

// ---------------------------------------------------------------------------
// PE resources: replace RT_ICON/RT_GROUP_ICON/RT_VERSION of the compiled exe,
// keep the rest (Bun's manifest). The new .rsrc is written in place when it
// fits, else as an appended section; nothing else in the image moves.

type ResKey = number | string;
interface ResLeaf { data: Buffer; codepage: number }
interface ResDir { entries: Array<{ key: ResKey; node: ResDir | ResLeaf }> }
const isDir = (n: ResDir | ResLeaf): n is ResDir => "entries" in n;
const RT_ICON = 3, RT_GROUP_ICON = 14, RT_VERSION = 16, RT_MANIFEST = 24;

interface PeSection { name: string; va: number; vs: number; raw: number; rawSize: number; hdr: number }
interface PeImage { buf: Buffer; pe: number; opt: number; dd: number; secTable: number; sections: PeSection[]; fileAlign: number; sectAlign: number }

function readPe(buf: Buffer): PeImage {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file (no MZ)");
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error("not a PE file (no PE signature)");
  const nsec = buf.readUInt16LE(pe + 6), optSize = buf.readUInt16LE(pe + 20), opt = pe + 24;
  const plus = buf.readUInt16LE(opt) === 0x20b;
  const secTable = opt + optSize;
  const sections: PeSection[] = [];
  for (let i = 0; i < nsec; i++) {
    const o = secTable + 40 * i;
    sections.push({
      name: buf.subarray(o, o + 8).toString("latin1").replace(/\0.*$/s, ""),
      vs: buf.readUInt32LE(o + 8), va: buf.readUInt32LE(o + 12), rawSize: buf.readUInt32LE(o + 16), raw: buf.readUInt32LE(o + 20), hdr: o,
    });
  }
  return { buf, pe, opt, dd: opt + (plus ? 112 : 96), secTable, sections, fileAlign: buf.readUInt32LE(opt + 36), sectAlign: buf.readUInt32LE(opt + 32) };
}

function rvaToOffset(img: PeImage, rva: number): number {
  for (const s of img.sections) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rawSize)) return s.raw + (rva - s.va);
  throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
}

function readResources(img: PeImage): ResDir {
  const rva = img.buf.readUInt32LE(img.dd + 16), size = img.buf.readUInt32LE(img.dd + 20);
  if (!rva || !size) return { entries: [] };
  const base = rvaToOffset(img, rva), b = img.buf;
  const readDir = (off: number, depth: number): ResDir => {
    if (depth > 3) throw new Error("resource tree too deep");
    const named = b.readUInt16LE(off + 12), ids = b.readUInt16LE(off + 14);
    const dir: ResDir = { entries: [] };
    for (let i = 0; i < named + ids; i++) {
      const e = off + 16 + 8 * i, nameField = b.readUInt32LE(e), dataField = b.readUInt32LE(e + 4);
      let key: ResKey = nameField;
      if (nameField & 0x80000000) {
        const s = base + (nameField & 0x7fffffff), len = b.readUInt16LE(s);
        key = b.subarray(s + 2, s + 2 + len * 2).toString("utf16le");
      }
      if (dataField & 0x80000000) dir.entries.push({ key, node: readDir(base + (dataField & 0x7fffffff), depth + 1) });
      else {
        const d = base + dataField, dataRva = b.readUInt32LE(d), dataSize = b.readUInt32LE(d + 4);
        const at = rvaToOffset(img, dataRva);
        dir.entries.push({ key, node: { data: Buffer.from(b.subarray(at, at + dataSize)), codepage: b.readUInt32LE(d + 8) } });
      }
    }
    return dir;
  };
  return readDir(base, 0);
}

function sortEntries(dir: ResDir) {
  dir.entries.sort((a, b) => {
    const as = typeof a.key === "string", bs = typeof b.key === "string";
    if (as !== bs) return as ? -1 : 1; // named entries first
    if (as) return (a.key as string).toUpperCase() < (b.key as string).toUpperCase() ? -1 : 1;
    return (a.key as number) - (b.key as number);
  });
}

function writeResources(root: ResDir, sectionRva: number): Buffer {
  const dirs: ResDir[] = [], leaves: ResLeaf[] = [], names: string[] = [];
  const queue = [root];
  while (queue.length) {
    const d = queue.shift()!;
    sortEntries(d);
    dirs.push(d);
    for (const e of d.entries) {
      if (typeof e.key === "string" && !names.includes(e.key)) names.push(e.key);
      if (isDir(e.node)) queue.push(e.node);
      else leaves.push(e.node);
    }
  }
  const align = (n: number, a: number) => Math.ceil(n / a) * a;
  const dirOff = new Map<ResDir, number>(), nameOff = new Map<string, number>(), entryOff = new Map<ResLeaf, number>(), dataOff = new Map<ResLeaf, number>();
  let off = 0;
  for (const d of dirs) {
    dirOff.set(d, off);
    off += 16 + 8 * d.entries.length;
  }
  for (const n of names) {
    nameOff.set(n, off);
    off = align(off + 2 + 2 * n.length, 2);
  }
  off = align(off, 4);
  for (const l of leaves) {
    entryOff.set(l, off);
    off += 16;
  }
  for (const l of leaves) {
    off = align(off, 8);
    dataOff.set(l, off);
    off += l.data.length;
  }
  const out = Buffer.alloc(align(off, 8));
  for (const d of dirs) {
    const o = dirOff.get(d)!;
    out.writeUInt16LE(d.entries.filter((e) => typeof e.key === "string").length, o + 12);
    out.writeUInt16LE(d.entries.filter((e) => typeof e.key !== "string").length, o + 14);
    d.entries.forEach((e, i) => {
      const eo = o + 16 + 8 * i;
      out.writeUInt32LE(typeof e.key === "string" ? (0x80000000 | nameOff.get(e.key)!) >>> 0 : e.key, eo);
      out.writeUInt32LE(isDir(e.node) ? (0x80000000 | dirOff.get(e.node)!) >>> 0 : entryOff.get(e.node)!, eo + 4);
    });
  }
  for (const n of names) {
    const o = nameOff.get(n)!;
    out.writeUInt16LE(n.length, o);
    out.write(n, o + 2, "utf16le");
  }
  for (const l of leaves) {
    const o = entryOff.get(l)!;
    out.writeUInt32LE(sectionRva + dataOff.get(l)!, o);
    out.writeUInt32LE(l.data.length, o + 4);
    out.writeUInt32LE(l.codepage, o + 8);
    l.data.copy(out, dataOff.get(l)!);
  }
  return out;
}

function peChecksum(buf: Buffer, checksumOffset: number): number {
  let sum = 0;
  const len = buf.length;
  for (let i = 0; i < len; i += 2) {
    if (i === checksumOffset || i === checksumOffset + 2) continue;
    sum += i + 1 < len ? buf[i]! | (buf[i + 1]! << 8) : buf[i]!;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + len) >>> 0;
}

/** VS_VERSIONINFO with one StringFileInfo table (040904B0, en-US / Unicode). */
export function versionResource(strings: Record<string, string>, version: [number, number, number, number]): Buffer {
  const pad4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const utf16z = (s: string) => Buffer.from(`${s}\0`, "utf16le");
  const block = (key: string, value: Buffer | null, text: boolean, children: Buffer[]): Buffer => {
    let body = pad4(Buffer.concat([Buffer.alloc(6), utf16z(key)]));
    if (value) body = Buffer.concat([body, value]);
    for (const child of children) body = Buffer.concat([pad4(body), child]);
    body.writeUInt16LE(body.length, 0);
    body.writeUInt16LE(value ? (text ? value.length / 2 : value.length) : 0, 2);
    body.writeUInt16LE(text ? 1 : 0, 4);
    return body;
  };
  const fixed = Buffer.alloc(52);
  const ms = (version[0] << 16) | version[1], ls = (version[2] << 16) | version[3];
  [0xfeef04bd, 0x00010000, ms, ls, ms, ls, 0x3f, 0, 0x00040004 /*VOS_NT_WINDOWS32*/, 1 /*VFT_APP*/, 0, 0, 0].forEach((v, i) => fixed.writeUInt32LE(v >>> 0, i * 4));
  const table = block("040904B0", null, true, Object.entries(strings).map(([k, v]) => block(k, utf16z(v), true, [])));
  const translation = Buffer.from([0x09, 0x04, 0xb0, 0x04]); // 0x0409, codepage 1200
  return block("VS_VERSION_INFO", fixed, false, [block("StringFileInfo", null, true, [table]), block("VarFileInfo", null, true, [block("Translation", translation, false, [])])]);
}

export function patchExeResources(exe: string, opts: { ico?: Buffer; version?: Buffer }): "in-place" | "appended" {
  let buf = readFileSync(exe);
  let img = readPe(buf);
  // A certificate table (signed input) would be invalidated anyway: drop it.
  const certOff = buf.readUInt32LE(img.dd + 32), certSize = buf.readUInt32LE(img.dd + 36);
  if (certOff && certSize) {
    buf = buf.subarray(0, certOff);
    buf.writeUInt32LE(0, img.dd + 32);
    buf.writeUInt32LE(0, img.dd + 36);
    img = readPe(buf);
  }
  const root = readResources(img);
  const typeDir = (type: number) => root.entries.find((e) => e.key === type)?.node as ResDir | undefined;
  // Keep the language of the existing resources (Bun ships en-US, 1033).
  const langOf = (d?: ResDir) => (d?.entries[0]?.node && isDir(d.entries[0].node) ? (d.entries[0].node.entries[0]?.key as number) : undefined);
  const lang = langOf(typeDir(RT_GROUP_ICON)) ?? langOf(typeDir(RT_VERSION)) ?? langOf(typeDir(RT_MANIFEST)) ?? 1033;
  const setType = (type: number, items: Array<{ id: number; data: Buffer }>) => {
    root.entries = root.entries.filter((e) => e.key !== type);
    root.entries.push({ key: type, node: { entries: items.map((it) => ({ key: it.id, node: { entries: [{ key: lang, node: { data: it.data, codepage: 0 } }] } })) } });
  };
  if (opts.ico) {
    const ico = opts.ico, count = ico.readUInt16LE(4);
    const icons: Array<{ id: number; data: Buffer }> = [];
    const group = Buffer.alloc(6 + 14 * count);
    group.writeUInt16LE(1, 2);
    group.writeUInt16LE(count, 4);
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i, size = ico.readUInt32LE(e + 8), offset = ico.readUInt32LE(e + 12);
      icons.push({ id: i + 1, data: Buffer.from(ico.subarray(offset, offset + size)) });
      const g = 6 + 14 * i;
      ico.copy(group, g, e, e + 8); // width, height, colors, reserved, planes, bitcount
      group.writeUInt32LE(size, g + 8);
      group.writeUInt16LE(i + 1, g + 12);
    }
    setType(RT_ICON, icons);
    setType(RT_GROUP_ICON, [{ id: 1, data: group }]);
  }
  if (opts.version) setType(RT_VERSION, [{ id: 1, data: opts.version }]);

  const rsrcRva = buf.readUInt32LE(img.dd + 16);
  const rsrc = img.sections.find((s) => rsrcRva && s.va === rsrcRva);
  let mode: "in-place" | "appended";
  if (rsrc && writeResources(root, rsrc.va).length <= rsrc.rawSize) {
    const data = writeResources(root, rsrc.va);
    buf.fill(0, rsrc.raw, rsrc.raw + rsrc.rawSize);
    data.copy(buf, rsrc.raw);
    if (data.length > rsrc.vs) buf.writeUInt32LE(data.length, rsrc.hdr + 8);
    buf.writeUInt32LE(data.length, img.dd + 20);
    mode = "in-place";
  } else {
    // New section after the last one (the old .rsrc stays, unreferenced).
    const align = (n: number, a: number) => Math.ceil(n / a) * a;
    const end = Math.max(...img.sections.map((s) => s.raw + s.rawSize));
    if (buf.length > end) throw new Error("the executable has trailing data after its sections; refusing to append a resource section");
    const hdr = img.secTable + 40 * img.sections.length;
    if (hdr + 40 > Math.min(...img.sections.map((s) => s.raw))) throw new Error("no room for another section header");
    const va = align(Math.max(...img.sections.map((s) => s.va + Math.max(s.vs, s.rawSize))), img.sectAlign);
    const data = writeResources(root, va);
    const raw = align(end, img.fileAlign), rawSize = align(data.length, img.fileAlign);
    const grown = Buffer.alloc(raw + rawSize);
    buf.copy(grown, 0, 0, buf.length);
    data.copy(grown, raw);
    grown.write(".sdrsrc\0", hdr, "latin1");
    grown.writeUInt32LE(data.length, hdr + 8);
    grown.writeUInt32LE(va, hdr + 12);
    grown.writeUInt32LE(rawSize, hdr + 16);
    grown.writeUInt32LE(raw, hdr + 20);
    grown.writeUInt32LE(0x40000040, hdr + 36); // INITIALIZED_DATA | MEM_READ
    grown.writeUInt16LE(img.sections.length + 1, img.pe + 6);
    grown.writeUInt32LE(align(va + data.length, img.sectAlign), img.opt + 56); // SizeOfImage
    grown.writeUInt32LE(grown.readUInt32LE(img.opt + 8) + rawSize, img.opt + 8); // SizeOfInitializedData
    grown.writeUInt32LE(va, img.dd + 16);
    grown.writeUInt32LE(data.length, img.dd + 20);
    buf = grown;
    mode = "appended";
  }
  buf.writeUInt32LE(peChecksum(buf, img.opt + 64), img.opt + 64);
  writeFileSync(exe, buf);
  return mode;
}

// ---------------------------------------------------------------------------
// Compile

async function compileExe(c: ResolvedConfig, stage: string, out: string, arch: Arch, ico: string | null): Promise<void> {
  const bun = c.build?.bun ?? process.env.SVELTE_DESKTOP_BUN ?? process.execPath;
  // A desktop app must not pick up bunfig.toml / .env from its working directory.
  const flags = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", `--target=bun-windows-${arch}`, "--windows-hide-console"];
  if (c.build?.trim) flags.push("--trim", "--trim-locales=en");
  if (c.build?.aot) warn("build.aot is ignored for Windows (Bun's --aot can't cross-compile)");
  // Bun edits PE resources only on a Windows host; elsewhere patchExeResources does it after.
  if (isWindowsHost) {
    const v = fileVersion(c.version).join(".");
    flags.push(`--windows-title=${c.appName}`, `--windows-publisher=${publisher(c)}`, `--windows-version=${v}`, `--windows-description=${c.appName}`);
    if (c.copyright) flags.push(`--windows-copyright=${c.copyright}`);
    if (ico) flags.push(`--windows-icon=${ico}`);
  }
  const rev = (await $`${bun} --revision`.text()).trim();
  log(`bun build --compile ${flags.filter((f) => !f.startsWith("--windows-") || f === "--windows-hide-console").join(" ")} (${rev})`);
  const r = await $`${bun} build --compile ${flags} ${join(stage, "desktop-main.js")} ${join(stage, "desktop-worker.js")} --outfile ${out}`.cwd(stage).nothrow().quiet();
  if (r.exitCode !== 0) throw new Error(`bun build --compile (windows-${arch}) failed:\n${r.stderr.toString()}${r.stdout.toString().slice(-4000)}`);
}

function publisher(c: ResolvedConfig): string {
  // Reverse-DNS identifier → publisher-ish name ("com.example.notes" → "example").
  return c.identifier.split(".")[1] ?? c.appName;
}

// ---------------------------------------------------------------------------
// Signing (Authenticode, osslsigncode)

interface SignSetup { pfx: string; password: string; timestamp: string }

function signSetup(c: ResolvedConfig): SignSetup | null {
  const pfx = c.sign?.windows?.certificateFile ?? process.env.WINDOWS_CERT_PFX;
  if (!pfx) return null;
  const abs = resolve(c.root, pfx);
  if (!existsSync(abs)) throw new Error(`Windows signing certificate not found: ${abs}`);
  return { pfx: abs, password: c.sign?.windows?.password ?? process.env.WINDOWS_CERT_PASSWORD ?? "", timestamp: c.sign?.windows?.timestampUrl ?? "http://timestamp.digicert.com" };
}

async function signFiles(files: string[], s: SignSetup, name: string): Promise<void> {
  if (!files.length) return;
  const host = await onPath("osslsigncode");
  if (!host && !(await hasDocker())) throw new Error("Windows signing needs osslsigncode (on PATH or in the Docker toolchain)");
  for (const f of files) {
    const signed = `${f}.signed`;
    rmSync(signed, { force: true });
    const args = ["sign", "-pkcs12", host ? s.pfx : `/certdir/${basename(s.pfx)}`, "-pass", s.password, "-n", name, "-h", "sha256", "-ts", s.timestamp];
    let ok: boolean, out: string;
    if (host) {
      const r = await $`osslsigncode ${args} -in ${f} -out ${signed}`.nothrow().quiet();
      ok = r.exitCode === 0;
      out = r.stdout.toString() + r.stderr.toString();
    } else {
      const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
      ({ ok, out } = await inToolchain(
        [[dirname(s.pfx), "/certdir:ro"], [dirname(f), "/f"]],
        `osslsigncode ${args.map(quote).join(" ")} -in /f/${quote(basename(f))} -out /f/${quote(basename(signed))}`,
      ));
    }
    if (!ok || !existsSync(signed)) throw new Error(`osslsigncode failed for ${basename(f)}:\n${out}`);
    rmSync(f);
    await $`mv ${signed} ${f}`.quiet();
  }
}

// ---------------------------------------------------------------------------
// NSIS installer (per-user, no elevation: the updater can swap files in place)

const nsisStr = (s: string) => s.replace(/\$/g, "$$$$").replace(/"/g, '$\\"');

export function nsisScript(c: ResolvedConfig, o: { exe: string; srcDir: string; outFile: string; icon: string | null; arch: Arch }): string {
  const name = nsisStr(c.appName), id = nsisStr(c.identifier), exe = nsisStr(o.exe);
  const v = fileVersion(c.version).join(".");
  const uninst = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`;
  const open = `"$INSTDIR\\${exe}" "%1"`;
  const lines: string[] = [
    "; Generated by @svelte-desktop/shell (package-windows.ts)",
    "Unicode true",
    "ManifestDPIAware true",
    "SetCompressor /SOLID lzma",
    '!include "MUI2.nsh"',
    '!include "FileFunc.nsh"',
    `Name "${name}"`,
    `OutFile "${o.outFile}"`,
    `InstallDir "$LOCALAPPDATA\\Programs\\${name}"`,
    `InstallDirRegKey HKCU "Software\\${id}" "InstallDir"`,
    "RequestExecutionLevel user",
    ...(o.icon ? [`!define MUI_ICON "${o.icon}"`, `!define MUI_UNICON "${o.icon}"`] : []),
    `!define MUI_FINISHPAGE_RUN "$INSTDIR\\${exe}"`,
    "!insertmacro MUI_PAGE_DIRECTORY",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_FINISH",
    "!insertmacro MUI_UNPAGE_CONFIRM",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    '!insertmacro MUI_LANGUAGE "English"',
    `VIProductVersion "${v}"`,
    `VIAddVersionKey "ProductName" "${name}"`,
    `VIAddVersionKey "ProductVersion" "${nsisStr(c.version)}"`,
    `VIAddVersionKey "FileVersion" "${v}"`,
    `VIAddVersionKey "FileDescription" "${name} Setup"`,
    `VIAddVersionKey "LegalCopyright" "${nsisStr(c.copyright ?? "")}"`,
    "",
    'Section "Install"',
    "  SetShellVarContext current",
    '  SetOutPath "$INSTDIR"',
    `  File /r "${o.srcDir}/*"`,
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    `  CreateShortCut "$SMPROGRAMS\\${name}.lnk" "$INSTDIR\\${exe}"`,
    `  WriteRegStr HKCU "Software\\${id}" "InstallDir" "$INSTDIR"`,
    `  WriteRegStr HKCU "${uninst}" "DisplayName" "${name}"`,
    `  WriteRegStr HKCU "${uninst}" "DisplayVersion" "${nsisStr(c.version)}"`,
    `  WriteRegStr HKCU "${uninst}" "Publisher" "${nsisStr(publisher(c))}"`,
    `  WriteRegStr HKCU "${uninst}" "DisplayIcon" "$INSTDIR\\${exe},0"`,
    `  WriteRegStr HKCU "${uninst}" "InstallLocation" "$INSTDIR"`,
    `  WriteRegStr HKCU "${uninst}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'`,
    `  WriteRegStr HKCU "${uninst}" "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'`,
    `  WriteRegDWORD HKCU "${uninst}" "NoModify" 1`,
    `  WriteRegDWORD HKCU "${uninst}" "NoRepair" 1`,
    '  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2',
    '  IntFmt $0 "0x%08X" $0',
    `  WriteRegDWORD HKCU "${uninst}" "EstimatedSize" "$0"`,
  ];
  const uninstall: string[] = [];
  for (const scheme of c.schemes ?? []) {
    const k = `Software\\Classes\\${nsisStr(scheme)}`;
    lines.push(
      `  WriteRegStr HKCU "${k}" "" "URL:${name}"`,
      `  WriteRegStr HKCU "${k}" "URL Protocol" ""`,
      `  WriteRegStr HKCU "${k}\\DefaultIcon" "" "$INSTDIR\\${exe},0"`,
      `  WriteRegStr HKCU "${k}\\shell\\open\\command" "" '${open}'`,
    );
    uninstall.push(`  DeleteRegKey HKCU "${k}"`);
  }
  for (const t of c.fileTypes ?? []) {
    const progId = nsisStr(`${c.identifier}.${t.name.replace(/[^A-Za-z0-9]/g, "")}`);
    const k = `Software\\Classes\\${progId}`;
    lines.push(
      `  WriteRegStr HKCU "${k}" "" "${nsisStr(t.name)}"`,
      `  WriteRegStr HKCU "${k}\\DefaultIcon" "" "$INSTDIR\\${exe},0"`,
      `  WriteRegStr HKCU "${k}\\shell\\open\\command" "" '${open}'`,
    );
    uninstall.push(`  DeleteRegKey HKCU "${k}"`);
    for (const raw of t.extensions) {
      const ext = nsisStr(raw.replace(/^\./, ""));
      lines.push(`  WriteRegStr HKCU "Software\\Classes\\.${ext}\\OpenWithProgids" "${progId}" ""`);
      uninstall.push(`  DeleteRegValue HKCU "Software\\Classes\\.${ext}\\OpenWithProgids" "${progId}"`);
      if (t.rank === "Owner") lines.push(`  WriteRegStr HKCU "Software\\Classes\\.${ext}" "" "${progId}"`);
    }
  }
  lines.push(
    "  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'",
    "SectionEnd",
    "",
    'Section "Uninstall"',
    "  SetShellVarContext current",
    `  Delete "$SMPROGRAMS\\${name}.lnk"`,
    '  RMDir /r "$INSTDIR"',
    `  DeleteRegKey HKCU "${uninst}"`,
    `  DeleteRegKey HKCU "Software\\${id}"`,
    `  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${name}"`,
    ...uninstall,
    "  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'",
    "SectionEnd",
    "",
  );
  return lines.join("\n");
}

async function buildInstaller(c: ResolvedConfig, appDir: string, exe: string, ico: string | null, arch: Arch, dist: string, work: string, tag: string): Promise<string | null> {
  const outName = `${tag}-setup.exe`;
  const out = join(dist, outName);
  rmSync(out, { force: true });
  if (await onPath("makensis")) {
    writeFileSync(join(work, "installer.nsi"), nsisScript(c, { exe, srcDir: appDir, outFile: out, icon: ico, arch }));
    const r = await $`makensis -V2 ${join(work, "installer.nsi")}`.nothrow().quiet();
    if (r.exitCode !== 0) throw new Error(`makensis failed:\n${r.stdout.toString()}${r.stderr.toString()}`);
  } else if (await hasDocker()) {
    if (ico) copyFileSync(ico, join(work, "app.ico"));
    writeFileSync(join(work, "installer.nsi"), nsisScript(c, { exe, srcDir: "/app", outFile: `/dist/${outName}`, icon: ico ? "/work/app.ico" : null, arch }));
    const r = await inToolchain([[appDir, "/app:ro"], [dist, "/dist"], [work, "/work"]], "makensis -V2 /work/installer.nsi");
    if (!r.ok) throw new Error(`makensis (Docker) failed:\n${r.out}`);
  } else {
    log("installer: skipped (makensis not on PATH and Docker unavailable)");
    return null;
  }
  return existsSync(out) ? out : null;
}

// ---------------------------------------------------------------------------
// Release (updater): the archive holds the folder's *contents* at its top level,
// the layout updater/index.ts swaps next to the installed .exe.

async function writeWindowsRelease(c: ResolvedConfig, appDir: string, exe: string, arch: Arch, dist: string): Promise<NonNullable<PackageResult["release"]>> {
  const { createArchive } = await import("../updater/archive.ts");
  const { sha256File } = await import("../updater/download.ts");
  const { signManifest } = await import("../updater/manifest.ts");
  const { privateKeyFromText } = await import("../updater/crypto.ts");
  const dir = join(dist, "release", c.version);
  mkdirSync(dir, { recursive: true });
  const file = `${exe.replace(/\.exe$/i, "")}-${c.version}-windows-${arch}.tar.zst`;
  const artifactPath = join(dir, file);
  rmSync(artifactPath, { force: true });
  const entries = readdirSync(appDir).map((e) => join(appDir, e));
  await createArchive(entries, artifactPath, "tar.zst");
  const url = c.update!.baseUrl ? `${c.update!.baseUrl.replace(/\/$/, "")}/${c.version}/${file}` : `${c.version}/${file}`;
  const artifact = { url, sha256: await sha256File(artifactPath), size: statSync(artifactPath).size, format: "tar.zst" as const };
  const key = `windows-${arch}`;
  const manifestPath = join(dist, "release", "update.json"), unsignedPath = join(dist, "release", "update.unsigned.json");
  // Same version already described (macOS/Linux builds into the same release/): merge the artifacts.
  let previous: any = null;
  for (const p of [manifestPath, unsignedPath])
    if (!previous && existsSync(p)) {
      try {
        const m = JSON.parse(readFileSync(p, "utf8"));
        if (m?.version === c.version && m?.name === c.identifier) previous = m;
      } catch {}
    }
  const manifest: any = {
    name: c.identifier,
    version: c.version,
    channel: c.update!.channel ?? "stable",
    releasedAt: new Date().toISOString(),
    artifacts: { ...(previous?.artifacts ?? {}), [key]: artifact },
    ...(previous?.patches ? { patches: Object.fromEntries(Object.entries(previous.patches).filter(([k]) => k !== key)) } : {}),
  };
  if (manifest.patches && !Object.keys(manifest.patches).length) delete manifest.patches;
  const keyPath = c.update!.privateKey ?? process.env.SVELTE_DESKTOP_UPDATE_KEY;
  if (keyPath && existsSync(resolve(c.root, keyPath))) {
    const signed = await signManifest(manifest, privateKeyFromText(await Bun.file(resolve(c.root, keyPath)).text()));
    await Bun.write(manifestPath, JSON.stringify(signed, null, 2));
    log(`release  ${relative(dist, artifactPath)} (${mb(artifactPath)}) + signed update.json [${Object.keys(manifest.artifacts).join(", ")}]`);
    return { dir, manifest: manifestPath, artifact: artifactPath, signed: true };
  }
  await Bun.write(unsignedPath, JSON.stringify(manifest, null, 2));
  log(`release  ${relative(dist, artifactPath)} (${mb(artifactPath)}) + update.unsigned.json [${Object.keys(manifest.artifacts).join(", ")}] (set update.privateKey or $SVELTE_DESKTOP_UPDATE_KEY to sign)`);
  return { dir, manifest: unsignedPath, artifact: artifactPath, signed: false };
}

async function zipFolder(appDir: string, zip: string): Promise<void> {
  rmSync(zip, { force: true });
  // No AppleDouble ._* entries (resource forks / xattrs mean nothing on Windows).
  if (process.platform === "darwin") await $`ditto -c -k --norsrc --noextattr --noacl --keepParent ${appDir} ${zip}`.quiet();
  else if (isWindowsHost) await $`tar.exe -a -c -f ${zip} -C ${dirname(appDir)} ${basename(appDir)}`.quiet();
  else await $`zip -qry ${zip} ${basename(appDir)}`.cwd(dirname(appDir)).quiet();
}

// ---------------------------------------------------------------------------

export async function packageWindows(c: ResolvedConfig, stage: string): Promise<PackageResult> {
  const t0 = performance.now();
  const arch: Arch = c.build?.targetArch ?? "x64";
  const dist = resolve(c.root, c.build?.outDir ?? ".desktop/dist");
  const work = join(dirname(dist), "work", `windows-${arch}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(dist, { recursive: true });
  const exe = windowsExeName(c.appName);
  const tag = `${exe.replace(/\.exe$/i, "")}-${c.version}-windows-${arch}`;

  // 1. icon (.ico from the app PNG)
  let icoPath: string | null = null;
  if (c.icon && existsSync(c.icon)) {
    icoPath = join(work, "app.ico");
    writeFileSync(icoPath, await buildIco(c.icon, work));
  }

  // 2. executable + resources
  const exeOut = join(work, exe);
  await compileExe(c, stage, exeOut, arch, icoPath);
  if (!isWindowsHost) {
    const v = fileVersion(c.version);
    const strings: Record<string, string> = {
      CompanyName: publisher(c),
      FileDescription: c.appName,
      FileVersion: v.join("."),
      InternalName: exe.replace(/\.exe$/i, ""),
      LegalCopyright: c.copyright ?? "",
      OriginalFilename: exe,
      ProductName: c.appName,
      ProductVersion: c.version,
    };
    const mode = patchExeResources(exeOut, { ico: icoPath ? readFileSync(icoPath) : undefined, version: versionResource(strings, v) });
    log(`resources: ${icoPath ? "icon + " : ""}version ${c.version} (${mode})`);
  }

  // 3. folder layout
  const appDir = join(dist, `${c.appName}-windows-${arch}`);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  copyFileSync(exeOut, join(appDir, exe));
  copyFileSync(await ensureShellDll(arch), join(appDir, "shell.dll"));
  const plugin = await buildWindowsPlugin(c, arch, join(work, "native"));
  if (plugin) copyFileSync(plugin, join(appDir, "app-native.dll"));
  const addons = await buildWindowsAddons(c, arch, join(work, "addons"));
  if (Object.keys(addons).length) {
    mkdirSync(join(appDir, "addons"), { recursive: true });
    for (const [name, file] of Object.entries(addons)) copyFileSync(file, join(appDir, "addons", `${name}.node`));
  }
  for (const [name, src] of Object.entries(c.sidecars ?? {})) {
    const from = resolve(c.root, src);
    if (!existsSync(from)) throw new Error(`sidecar "${name}": ${from} not found`);
    if (!isPE(from)) warn(`sidecar "${name}": ${relative(c.root, from)} is not a Windows executable`);
    copyFileSync(from, join(appDir, name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`));
  }
  log(`${basename(appDir)}/  ${exe} ${mb(join(appDir, exe))}, shell.dll${plugin ? ", app-native.dll" : ""}${Object.keys(addons).length ? `, addons/${Object.keys(addons).join(",")}` : ""}`);

  // 4. Authenticode
  const sign = signSetup(c);
  if (sign) {
    const pes = [join(appDir, exe), join(appDir, "shell.dll"), ...(plugin ? [join(appDir, "app-native.dll")] : []),
      ...Object.keys(addons).map((n) => join(appDir, "addons", `${n}.node`)),
      ...readdirSync(appDir).filter((f) => f.endsWith(".exe") && f !== exe).map((f) => join(appDir, f))];
    await signFiles(pes, sign, c.appName);
    log(`authenticode: ${pes.length} files signed (${basename(sign.pfx)})`);
  } else {
    log("authenticode: unsigned (set sign.windows.certificateFile or $WINDOWS_CERT_PFX to sign)");
  }

  // 5. archives
  const result: PackageResult = { app: appDir, artifacts: [], signed: sign ? "identity" : "ad-hoc", notarized: false, arches: [arch] };
  if (c.build?.zip !== false) {
    result.zip = join(dist, `${tag}.zip`);
    await zipFolder(appDir, result.zip);
    log(`zip  ${basename(result.zip)} ${mb(result.zip)}`);
  }
  const installer = await buildInstaller(c, appDir, exe, icoPath, arch, dist, work, tag);
  if (installer) {
    if (sign) await signFiles([installer], sign, `${c.appName} Setup`);
    result.artifacts!.push(installer);
    log(`installer  ${basename(installer)} ${mb(installer)} (NSIS, per-user)`);
  }

  // 6. updater release
  if (c.update) result.release = await writeWindowsRelease(c, appDir, exe, arch, dist);

  const size = Number((await $`du -sk ${appDir}`.nothrow().text()).split("\t")[0]) / 1024;
  console.log(`\n  \x1b[32m✓\x1b[0m ${appDir} (${size.toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}
