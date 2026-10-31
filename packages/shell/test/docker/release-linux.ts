// Updater release artifacts for Linux (package-linux.ts → writeRelease(…, "linux")):
// packages examples/notes' staged build as 0.1.0 then 0.2.0 with a signing key,
// then verifies the signed manifest (key linux-<arch>), the artifact hashes, and
// that the 0.1.0 → 0.2.0 delta patch rebuilds the 0.2.0 tree byte for byte.
// Run inside the Docker image after `vite build` (notes.sh), from examples/notes.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { packageLinux } from "../../src/build/package-linux.ts";
import { generateKeyPair, privateKeyToPem, toBase64 } from "../../src/updater/crypto.ts";
import { parseSignedManifest } from "../../src/updater/manifest.ts";
import { extractArchive } from "../../src/updater/archive.ts";
import { applyTreePatch } from "../../src/updater/delta.ts";

const root = process.cwd();
const out = "/tmp/release-test";
rmSync(out, { recursive: true, force: true });
const keys = await generateKeyPair();
writeFileSync("/tmp/release-key.pem", privateKeyToPem(keys.privateKey));
const publicKey = toBase64(keys.publicKey);
const arch = process.arch === "arm64" ? "arm64" : "x64";
const key = `linux-${arch}`;
let failed = 0;
const check = (name: string, pass: unknown, detail?: unknown) => {
  if (!pass) failed++;
  console.log(`${pass ? "✓" : "✗"} ${name}${pass || detail === undefined ? "" : " " + JSON.stringify(detail)}`);
};

for (const version of ["0.1.0", "0.2.0"]) {
  const c = await loadConfig(root, { update: { manifestUrl: "https://updates.example.com/update.json", publicKey, privateKey: "/tmp/release-key.pem" }, build: { outDir: out } } as any);
  c.version = version;
  if (version === "0.2.0") writeFileSync(join(root, ".desktop/stage/CHANGED"), "0.2.0"); // (unused by the app, just a different input)
  const r = await packageLinux(c, join(root, ".desktop/stage"));
  check(`${version}: release written + signed`, r.release?.signed === true, r.release);
}
const manifestText = readFileSync(join(out, "release/update.json"), "utf8");
const m = await parseSignedManifest(manifestText, [publicKey]);
check("update.json verifies with the public key (ed25519)", m.version === "0.2.0" && m.name === "dev.svelte-desktop.notes");
const art = (m.artifacts as any)[key];
check(`artifact under ${key} (tar.zst)`, art?.format === "tar.zst" && art.url === `0.2.0/svelte-notes-0.2.0-linux-${arch}.tar.zst`.replace("svelte-notes", "SvelteNotes"), art);
const file = join(out, "release", art.url);
check("artifact sha256 + size match the file", createHash("sha256").update(readFileSync(file)).digest("hex") === art.sha256 && statSync(file).size === art.size);
const patch = (m.patches as any)?.[key]?.[0];
check("delta patch 0.1.0 → 0.2.0 listed", patch?.from === "0.1.0" && patch.size < art.size / 10, patch && { from: patch.from, size: patch.size, full: art.size });
const oldDir = "/tmp/release-old", newDir = "/tmp/release-new";
rmSync(oldDir, { recursive: true, force: true });
rmSync(newDir, { recursive: true, force: true });
await extractArchive(join(out, "release/0.1.0", readdirSync(join(out, "release/0.1.0")).find((f) => f.endsWith(".tar.zst"))!), "tar.zst", oldDir);
const applied = applyTreePatch(new Uint8Array(readFileSync(join(out, "release", patch.url))), join(oldDir, "Svelte Notes"), newDir);
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
const want = join(out, "Svelte Notes");
const same = files(want).every((f) => {
  const g = join(newDir, relative(want, f));
  try { return readFileSync(f).equals(readFileSync(g)); } catch { return false; }
});
check(`patch applied to the 0.1.0 tree reproduces 0.2.0 (${applied.files} files)`, same && files(newDir).length === files(want).length);
rmSync(join(root, ".desktop/stage/CHANGED"), { force: true });
console.log(failed ? `FAILED ${failed}` : "release: all checks passed");
process.exit(failed ? 1 : 0);
