// Delta updates: per-file rsync-style diffs between two app bundles, packed into
// one zstd-compressed `.sdpatch`. A release lists its patches in the signed
// manifest (`patches[platformKey] = [{ from, url, sha256, size }]`); the client
// rebuilds the new bundle from the installed one, verifies every file's sha256,
// and falls back to the full archive on any mismatch.
//
// Container (inside zstd): "SDPATCH1" | u32 headerLength | header JSON | data
//   header = { from, to, root, entries: [{ path, kind, mode, size?, sha256?, link?, op, offset, length }] }
//   op: "same" (copy the old file) | "delta" (op stream vs old file) | "new" (raw bytes)
// Delta op stream: 0x01 COPY u32 offHi u32 offLo u32 len | 0x02 DATA u32 len bytes
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import zlib from "node:zlib";

const BLOCK = 4096;
const MAGIC = "SDPATCH1";

// ---------------------------------------------------------------------------
// Byte-level diff (rolling weak checksum over BLOCK-sized windows, exact verify)

function weakOf(buf: Uint8Array, start: number, len: number): [number, number] {
  let a = 0;
  let b = 0;
  for (let i = 0; i < len; i++) {
    const x = buf[start + i]!;
    a = (a + x) & 0xffff;
    b = (b + (len - i) * x) & 0xffff;
  }
  return [a, b];
}

function equalRange(a: Uint8Array, ai: number, b: Uint8Array, bi: number, len: number): boolean {
  return Buffer.compare(a.subarray(ai, ai + len), b.subarray(bi, bi + len)) === 0;
}

export function diffBytes(oldBuf: Uint8Array, newBuf: Uint8Array): Uint8Array {
  const out: Buffer[] = [];
  const pushCopy = (off: number, len: number) => {
    const r = Buffer.alloc(13);
    r[0] = 1;
    r.writeUInt32LE(Math.floor(off / 0x100000000), 1);
    r.writeUInt32LE(off >>> 0, 5);
    r.writeUInt32LE(len, 9);
    out.push(r);
  };
  const pushData = (from: number, to: number) => {
    if (to <= from) return;
    const r = Buffer.alloc(5);
    r[0] = 2;
    r.writeUInt32LE(to - from, 1);
    out.push(r, Buffer.from(newBuf.subarray(from, to)));
  };
  if (oldBuf.length < BLOCK || newBuf.length < BLOCK) {
    pushData(0, newBuf.length);
    return Buffer.concat(out);
  }
  const index = new Map<number, number[]>();
  for (let off = 0; off + BLOCK <= oldBuf.length; off += BLOCK) {
    const [a, b] = weakOf(oldBuf, off, BLOCK);
    const key = (a | (b << 16)) >>> 0;
    const list = index.get(key);
    if (list) {
      if (list.length < 8) list.push(off);
    } else index.set(key, [off]);
  }

  let p = 0;
  let literalStart = 0;
  let [a, b] = weakOf(newBuf, 0, BLOCK);
  while (p + BLOCK <= newBuf.length) {
    const key = (a | (b << 16)) >>> 0;
    let matched = -1;
    const candidates = index.get(key);
    if (candidates) {
      // Prefer the same offset (unchanged region), else the first exact match.
      for (const off of candidates.includes(p) ? [p, ...candidates] : candidates) {
        if (equalRange(oldBuf, off, newBuf, p, BLOCK)) {
          matched = off;
          break;
        }
      }
    }
    if (matched >= 0) {
      pushData(literalStart, p);
      let len = BLOCK;
      while (p + len < newBuf.length && matched + len < oldBuf.length && oldBuf[matched + len] === newBuf[p + len]) len++;
      pushCopy(matched, len);
      p += len;
      literalStart = p;
      if (p + BLOCK <= newBuf.length) [a, b] = weakOf(newBuf, p, BLOCK);
      continue;
    }
    // Roll one byte.
    const outByte = newBuf[p]!;
    const inByte = p + BLOCK < newBuf.length ? newBuf[p + BLOCK]! : 0;
    a = (a - outByte + inByte) & 0xffff;
    b = (b - BLOCK * outByte + a) & 0xffff;
    p++;
  }
  pushData(literalStart, newBuf.length);
  return Buffer.concat(out);
}

export function patchBytes(oldBuf: Uint8Array, ops: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const view = Buffer.from(ops.buffer, ops.byteOffset, ops.byteLength);
  let i = 0;
  while (i < view.length) {
    const op = view[i]!;
    if (op === 1) {
      const off = view.readUInt32LE(i + 1) * 0x100000000 + view.readUInt32LE(i + 5);
      const len = view.readUInt32LE(i + 9);
      if (off + len > oldBuf.length) throw new Error("delta: copy out of range");
      parts.push(oldBuf.subarray(off, off + len));
      i += 13;
    } else if (op === 2) {
      const len = view.readUInt32LE(i + 1);
      parts.push(view.subarray(i + 5, i + 5 + len));
      i += 5 + len;
    } else throw new Error(`delta: bad op ${op}`);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Tree patches

type Entry = {
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  size?: number;
  sha256?: string;
  link?: string;
  op?: "same" | "delta" | "new";
  offset?: number;
  length?: number;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function walk(root: string, rel = ""): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (name === ".DS_Store") continue;
    const r = rel ? `${rel}/${name}` : name;
    const abs = join(root, r);
    out.push({ rel: r, abs });
    if (lstatSync(abs).isDirectory()) out.push(...walk(root, r));
  }
  return out;
}

/** Patch turning bundle `oldDir` into `newDir` (both e.g. ".../Foo.app"). */
export function createTreePatch(oldDir: string, newDir: string, meta: { from: string; to: string; root: string }): Uint8Array {
  const entries: Entry[] = [];
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const { rel, abs } of walk(newDir)) {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      entries.push({ path: rel, kind: "dir", mode: st.mode & 0o7777 });
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.push({ path: rel, kind: "symlink", mode: st.mode & 0o7777, link: readlinkSync(abs) });
      continue;
    }
    const data = readFileSync(abs);
    const e: Entry = { path: rel, kind: "file", mode: st.mode & 0o7777, size: data.length, sha256: sha256(data) };
    const old = join(oldDir, rel);
    let blob: Buffer | null = null;
    if (existsSync(old) && lstatSync(old).isFile()) {
      const oldData = readFileSync(old);
      if (oldData.length === data.length && Buffer.compare(oldData, data) === 0) e.op = "same";
      else {
        const d = Buffer.from(diffBytes(oldData, data));
        if (d.length < data.length) {
          e.op = "delta";
          blob = d;
        }
      }
    }
    if (!e.op) {
      e.op = "new";
      blob = data;
    }
    if (blob) {
      e.offset = offset;
      e.length = blob.length;
      offset += blob.length;
      blobs.push(blob);
    }
    entries.push(e);
  }
  const header = Buffer.from(JSON.stringify({ ...meta, entries }));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const container = Buffer.concat([Buffer.from(MAGIC), len, header, ...blobs]);
  return zlib.zstdCompressSync(container, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
}

/** Rebuild the new bundle at `outDir` from the installed `oldDir`; verifies every file. */
export function applyTreePatch(patch: Uint8Array, oldDir: string, outDir: string): { from: string; to: string; root: string; files: number } {
  const container = zlib.zstdDecompressSync(patch);
  if (container.subarray(0, 8).toString() !== MAGIC) throw new Error("delta: not an .sdpatch");
  const headerLen = container.readUInt32LE(8);
  const header = JSON.parse(container.subarray(12, 12 + headerLen).toString()) as { from: string; to: string; root: string; entries: Entry[] };
  const data = container.subarray(12 + headerLen);
  mkdirSync(outDir, { recursive: true });
  let files = 0;
  for (const e of header.entries) {
    const dest = join(outDir, e.path);
    if (relative(outDir, dest).startsWith("..")) throw new Error(`delta: path escapes the bundle: ${e.path}`);
    if (e.kind === "dir") {
      mkdirSync(dest, { recursive: true });
      chmodSync(dest, e.mode);
      continue;
    }
    if (e.kind === "symlink") {
      symlinkSync(e.link!, dest);
      continue;
    }
    let bytes: Uint8Array;
    if (e.op === "same") bytes = readFileSync(join(oldDir, e.path));
    else if (e.op === "delta") bytes = patchBytes(readFileSync(join(oldDir, e.path)), data.subarray(e.offset!, e.offset! + e.length!));
    else bytes = data.subarray(e.offset!, e.offset! + e.length!);
    if (bytes.length !== e.size || sha256(bytes) !== e.sha256) throw new Error(`delta: ${e.path} does not match the release (installed copy modified?)`);
    writeFileSync(dest, bytes);
    chmodSync(dest, e.mode);
    files++;
  }
  return { from: header.from, to: header.to, root: header.root, files };
}
