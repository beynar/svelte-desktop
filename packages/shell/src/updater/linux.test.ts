/**
 * What kitop ships on Linux, in temp dirs with the real helper: the app folder from the .tar.gz and
 * the AppImage. The real app goes through the same steps in test/docker/update-linux.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createArchive, createUpdater, extractArchive, locateInstall, platformKeyOf, type UpdaterOptions } from "./index.ts";
import { createTreePatch } from "./delta.ts";
import { sha256File } from "./download.ts";
import { validateManifest } from "./manifest.ts";
import { buildArtifact, makeKeys, serveStatic, signedManifest, tempDir, waitFor, writeFakeExe } from "./test-utils.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

const isRoot = process.getuid?.() === 0;
// The real helper here is /bin/sh, and these are Linux's layouts. Windows has its own: update-real.test.ts.
const posix = process.platform !== "win32";
const read = (p: string) => readFileSync(p, "utf8");

/** A folder as the packager makes it. */
async function appFolder(dir: string, version: string, marker: string, extra: Record<string, string> = {}) {
	mkdirSync(join(dir, "lib"), { recursive: true });
	await writeFakeExe(join(dir, "myapp"), version, marker);
	writeFileSync(join(dir, "lib", "libshell.so"), `shell-${version}`);
	writeFileSync(join(dir, ".kitop-app"), "dev.test.app\n");
	for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
}

async function base(prefix: string) {
	const { dir: tmp, cleanup } = await tempDir(prefix);
	cleanups.push(cleanup);
	const dir = realpathSync(tmp); // the executable's path is a real one
	return { dir, marker: join(dir, "launched.txt"), keys: await makeKeys() };
}

function feed(files: Record<string, string>, manifest: unknown) {
	const routes: Record<string, () => Response> = { "/update.json": () => Response.json(manifest) };
	for (const [path, file] of Object.entries(files)) routes[path] = () => new Response(Bun.file(file));
	const host = serveStatic(routes);
	cleanups.push(host.stop);
	return host;
}

/** Installed 1.0.0 under a name of its own; the release's 2.0.0 folder is called something else. */
async function folderScenario(extra: Partial<UpdaterOptions> = {}) {
	const { dir, marker, keys } = await base("updater-folder-");
	const parent = join(dir, "apps");
	const folder = join(parent, `Arnaud's Notes`);
	await appFolder(folder, "1.0.0", marker, { "old-only.txt": "gone after the update" });
	const built = join(dir, "build", "Svelte Notes");
	await appFolder(built, "2.0.0", marker, { "new-only.txt": "added" });
	const artifact = await buildArtifact([built], join(dir, "pub", "update.tar.zst"));
	const fields = { url: "update.tar.zst", sha256: artifact.sha256, size: artifact.size, format: "tar.zst" as const };
	const manifest = await signedManifest(keys.privateKey, { artifacts: { "linux-arm64": fields } });
	const host = feed({ "/update.tar.zst": artifact.path }, manifest);
	const make = (currentVersion: string) =>
		createUpdater({ manifestUrl: `${host.base}/update.json`, publicKey: keys.publicKey, currentVersion, appName: "TestApp", dataDir: extra.dataDir ?? join(dir, "data"), platform: "linux", arch: "arm64", installPath: join(folder, "myapp"), env: {}, ...extra });
	return { dir, marker, parent, folder, built, host, keys, fields, v1: make("1.0.0"), v2: make("2.0.0") };
}

/** Running from a mount of /…/Apps/notes-1.0.0.AppImage. */
async function appImageScenario(artifacts?: (fields: any) => object) {
	const { dir, marker, keys } = await base("updater-appimage-");
	const image = join(dir, "Apps", "notes-1.0.0.AppImage");
	mkdirSync(join(dir, "Apps"));
	await writeFakeExe(image, "1.0.0", marker);
	const built = join(dir, "build", "notes-2.0.0.AppImage");
	await writeFakeExe(built, "2.0.0", marker);
	const mount = join(dir, "mnt");
	mkdirSync(mount);
	const artifact = await buildArtifact([built], join(dir, "pub", "image.tar.zst"));
	const fields = { url: "image.tar.zst", sha256: artifact.sha256, size: artifact.size, format: "tar.zst" as const };
	const manifest = await signedManifest(keys.privateKey, { artifacts: (artifacts?.(fields) ?? { "appimage-arm64": fields }) as any });
	const host = feed({ "/image.tar.zst": artifact.path }, manifest);
	const make = (currentVersion: string) =>
		createUpdater({ manifestUrl: `${host.base}/update.json`, publicKey: keys.publicKey, currentVersion, appName: "TestApp", dataDir: join(dir, "data"), platform: "linux", arch: "arm64", installPath: join(mount, "notes"), env: { APPIMAGE: image, APPDIR: mount } });
	return { dir, marker, image, host, v1: make("1.0.0"), v2: make("2.0.0") };
}

/** check + download + apply, the app being a `sleep` that ends when told; resolves once the helper has exited. */
async function update(u: ReturnType<typeof createUpdater>, opts: { relaunch: boolean; beforeExit?: (payloadDir: string) => unknown }) {
	const staged = await u.download((await u.check())!);
	const app = Bun.spawn(["sleep", "60"]);
	const handle = await u.apply(staged, { relaunch: opts.relaunch, quit: false, waitForPid: app.pid });
	await opts.beforeExit?.(staged.payloadDir);
	app.kill();
	await app.exited;
	return { staged, handle, code: await handle.exited! };
}

describe.if(posix)("the app folder", () => {
	test("is replaced whole under its installed name; the old one is kept until the new one is healthy", async () => {
		const s = await folderScenario();
		expect(s.v1.install()).toEqual({ kind: "app-folder", target: s.folder, dir: s.parent, exe: join(s.folder, "myapp") });
		const { code, staged } = await update(s.v1, { relaunch: true });
		expect(code).toBe(0);

		expect(read(join(s.folder, "myapp"))).toContain("2.0.0");
		expect(read(join(s.folder, "lib", "libshell.so"))).toBe("shell-2.0.0");
		expect(existsSync(join(s.folder, "new-only.txt"))).toBe(true);
		expect(existsSync(join(s.folder, "old-only.txt"))).toBe(false); // not merged: what the old version had is gone
		expect(read(join(`${s.folder}.old`, "myapp"))).toContain("1.0.0");
		expect(existsSync(`${s.folder}.new`)).toBe(false);
		expect(await waitFor(() => existsSync(s.marker) && read(s.marker).trim())).toBe("2.0.0"); // relaunched: the executable, not the folder

		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		await s.v2.confirm();
		expect(existsSync(`${s.folder}.old`)).toBe(false);
		expect(existsSync(staged.stagingDir)).toBe(false);
		expect(await s.v2.status()).toBeNull();
	});

	test("rollback brings the old folder back, whole", async () => {
		const s = await folderScenario();
		expect((await update(s.v1, { relaunch: false })).code).toBe(0);
		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		expect(await s.v2.rollbackIfNeeded()).toBe(true);
		expect(read(join(s.folder, "myapp"))).toContain("1.0.0");
		expect(existsSync(join(s.folder, "old-only.txt"))).toBe(true);
		expect(existsSync(join(s.folder, "new-only.txt"))).toBe(false);
		expect(existsSync(`${s.folder}.old`)).toBe(false);
		expect(existsSync(`${s.folder}.bad`)).toBe(false);
		expect(await s.v1.status()).toMatchObject({ phase: "rolled-back", to: "2.0.0" });
		expect(await s.v1.check()).toBeNull();
	});

	test("a failed swap leaves the installed folder as it was, and relaunches it", async () => {
		const s = await folderScenario();
		const { code } = await update(s.v1, { relaunch: true, beforeExit: (payload) => rmSync(payload, { recursive: true }) });
		expect(code).toBe(1);
		expect(read(join(s.folder, "myapp"))).toContain("1.0.0");
		expect(existsSync(`${s.folder}.old`)).toBe(false);
		expect(existsSync(`${s.folder}.new`)).toBe(false);
		expect(await s.v1.status()).toMatchObject({ phase: "failed" });
		expect(await waitFor(() => existsSync(s.marker) && read(s.marker).trim())).toBe("1.0.0");
	});

	// /dev/shm is another filesystem than the temp dir: `mv` copies there, which is why `via` exists.
	test.skipIf(!existsSync("/dev/shm"))("staged on another filesystem: same result", async () => {
		const dataDir = mkdtempSync("/dev/shm/updater-");
		cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
		const s = await folderScenario({ dataDir });
		expect(statSync(dataDir).dev).not.toBe(statSync(s.parent).dev);
		expect((await update(s.v1, { relaunch: false })).code).toBe(0);
		expect(read(join(s.folder, "myapp"))).toContain("2.0.0");
		expect(read(join(`${s.folder}.old`, "myapp"))).toContain("1.0.0");
		expect(statSync(join(s.folder, "myapp")).mode & 0o111).toBeGreaterThan(0);
	});

	test.skipIf(isRoot)("a stale backup that can't be removed stops the update: it must not take the install's place", async () => {
		const s = await folderScenario();
		const stuck = join(`${s.folder}.old`, "stuck");
		mkdirSync(stuck, { recursive: true });
		writeFileSync(join(stuck, "file"), "from an older update");
		chmodSync(stuck, 0o555);
		cleanups.push(() => chmodSync(stuck, 0o755));
		expect((await update(s.v1, { relaunch: false })).code).toBe(1);
		expect(read(join(s.folder, "myapp"))).toContain("1.0.0");
		expect(existsSync(join(s.folder, "stuck"))).toBe(false);
		expect(await s.v1.status()).toMatchObject({ phase: "failed" });
	});

	test("a delta patch rebuilds the folder from the installed one; a modified install falls back to the full archive", async () => {
		const s = await folderScenario();
		const patchFile = join(s.dir, "pub", "update.sdpatch");
		await Bun.write(patchFile, createTreePatch(s.folder, s.built, { from: "1.0.0", to: "2.0.0", root: "Svelte Notes" }));
		const patch = { from: "1.0.0", url: "update.sdpatch", sha256: await sha256File(patchFile), size: Bun.file(patchFile).size };
		const manifest = await signedManifest(s.keys.privateKey, { artifacts: { "linux-arm64": s.fields }, patches: { "linux-arm64": [patch] } });
		const host = feed({ "/update.tar.zst": join(s.dir, "pub", "update.tar.zst"), "/update.sdpatch": patchFile }, manifest);
		const v1 = createUpdater({ manifestUrl: `${host.base}/update.json`, publicKey: s.keys.publicKey, currentVersion: "1.0.0", appName: "TestApp", dataDir: join(s.dir, "data"), platform: "linux", arch: "arm64", installPath: join(s.folder, "myapp"), env: {} });

		const fromPatch = await v1.download((await v1.check())!);
		expect(fromPatch.delta).toBeDefined();
		expect(host.hits).not.toContain("/update.tar.zst");
		expect(read(join(fromPatch.payloadDir, fromPatch.entries[0]!, "lib", "libshell.so"))).toBe("shell-2.0.0");

		writeFileSync(join(s.folder, ".kitop-app"), "tampered"); // a file the patch says is unchanged
		const full = await v1.download((await v1.check())!);
		expect(full.delta).toBeUndefined();
		expect(host.hits).toContain("/update.tar.zst");
		const app = Bun.spawn(["sleep", "0.1"]);
		const handle = await v1.apply(full, { quit: false, waitForPid: app.pid });
		expect(await handle.exited!).toBe(0);
		expect(read(join(s.folder, ".kitop-app"))).toBe("dev.test.app\n");
		expect(read(join(s.folder, "lib", "libshell.so"))).toBe("shell-2.0.0");
	});

	test("an archive that isn't this app's folder is refused before anything moves", async () => {
		const s = await folderScenario();
		const staged = await s.v1.download((await s.v1.check())!);
		const inner = join(staged.payloadDir, staged.entries[0]!);
		rmSync(join(inner, ".kitop-app"));
		expect((await s.v1.apply(staged, { quit: false }).catch((e) => e)).code).toBe("layout_invalid");
		await Bun.write(join(inner, ".kitop-app"), "");
		rmSync(join(inner, "myapp"));
		expect((await s.v1.apply(staged, { quit: false }).catch((e) => e)).code).toBe("layout_invalid");
		expect(read(join(s.folder, "myapp"))).toContain("1.0.0");
		expect(await s.v1.status()).toBeNull();
	});
});

describe.if(posix)("installs that can't be replaced", () => {
	test("an executable outside an app folder is never replaced by a folder (the archive's shape on Linux)", async () => {
		const s = await folderScenario();
		// Copied out of the folder: no marker, and it has neighbours that aren't ours.
		const bin = join(s.dir, "bin");
		mkdirSync(bin);
		await writeFakeExe(join(bin, "myapp"), "1.0.0", s.marker);
		writeFileSync(join(bin, "someone-elses-tool"), "keep me");
		const u = createUpdater({ manifestUrl: `${s.host.base}/update.json`, publicKey: s.keys.publicKey, currentVersion: "1.0.0", appName: "TestApp", dataDir: join(s.dir, "data2"), platform: "linux", arch: "arm64", installPath: join(bin, "myapp"), env: {} });
		expect(u.install().kind).toBe("executable");
		const err = await u.download((await u.check())!).catch((e) => e);
		expect(err.code).toBe("layout_invalid");
		expect(err.message).toContain(".kitop-app");
		expect(read(join(bin, "myapp"))).toContain("1.0.0");
		expect(statSync(join(bin, "myapp")).isFile()).toBe(true);
		expect(read(join(bin, "someone-elses-tool"))).toBe("keep me");
	});

	test.skipIf(isRoot)("a folder in a directory this user can't write to: not_writable, before downloading", async () => {
		const s = await folderScenario();
		chmodSync(s.parent, 0o555);
		cleanups.push(() => chmodSync(s.parent, 0o755));
		const info = (await s.v1.check())!;
		expect(info.version).toBe("2.0.0"); // still told about it: the app can say how to get it
		const err = await s.v1.download(info).catch((e) => e);
		expect(err.code).toBe("not_writable");
		expect(err.message).toContain(s.parent);
		expect(s.host.hits).not.toContain("/update.tar.zst");
		expect(await s.v1.status()).toBeNull();
		expect(read(join(s.folder, "myapp"))).toContain("1.0.0");
	});

	test.skipIf(isRoot)("a folder this user can't write to, in a directory they can: not_writable", async () => {
		const s = await folderScenario();
		chmodSync(s.folder, 0o555);
		cleanups.push(() => chmodSync(s.folder, 0o755));
		expect((await s.v1.download((await s.v1.check())!).catch((e) => e)).code).toBe("not_writable");
		expect(existsSync(`${s.folder}.old`)).toBe(false);
	});

	test.skipIf(isRoot)("permissions that change after the download: not_writable from apply(), nothing started", async () => {
		const s = await folderScenario();
		const staged = await s.v1.download((await s.v1.check())!);
		chmodSync(s.parent, 0o555);
		cleanups.push(() => chmodSync(s.parent, 0o755));
		expect((await s.v1.apply(staged, { quit: false }).catch((e) => e)).code).toBe("not_writable");
		expect(await s.v1.status()).toBeNull();
	});

	test.skipIf(isRoot)("an AppImage in a directory this user can't write to: not_writable", async () => {
		const s = await appImageScenario();
		chmodSync(join(s.dir, "Apps"), 0o555);
		cleanups.push(() => chmodSync(join(s.dir, "Apps"), 0o755));
		expect((await s.v1.download((await s.v1.check())!).catch((e) => e)).code).toBe("not_writable");
		expect(read(s.image)).toContain("1.0.0");
	});
});

describe.if(posix)("the AppImage", () => {
	test("is replaced under its installed name, in one rename: the backup is the same file", async () => {
		const s = await appImageScenario();
		expect(s.v1.install()).toEqual({ kind: "appimage", target: s.image, dir: join(s.dir, "Apps") });
		const before = statSync(s.image).ino;
		const { code } = await update(s.v1, { relaunch: true });
		expect(code).toBe(0);
		expect(read(s.image)).toContain("2.0.0");
		expect(statSync(s.image).mode & 0o111).toBeGreaterThan(0);
		expect(statSync(`${s.image}.old`).ino).toBe(before);
		expect(existsSync(`${s.image}.new`)).toBe(false);
		expect(await waitFor(() => existsSync(s.marker) && read(s.marker).trim())).toBe("2.0.0");
		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		await s.v2.confirm();
		expect(existsSync(`${s.image}.old`)).toBe(false);
	});

	// A filesystem without hard links, then one that runs out of space while copying: a fake `ln` and `cp`.
	async function updateWithTools(s: { dir: string; v1: ReturnType<typeof createUpdater> }, tools: Record<string, string>) {
		const bin = join(s.dir, "fake-bin");
		mkdirSync(bin);
		for (const [name, body] of Object.entries(tools)) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		const staged = await s.v1.download((await s.v1.check())!);
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		const { command } = await s.v1.apply(staged, { dryRun: true, waitForPid: dead.pid });
		return Bun.spawn(command, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).exited;
	}

	test("no hard links: the backup is a copy", async () => {
		const s = await appImageScenario();
		const before = statSync(s.image).ino;
		expect(await updateWithTools(s, { ln: "exit 1" })).toBe(0);
		expect(read(s.image)).toContain("2.0.0");
		expect(read(`${s.image}.old`)).toContain("1.0.0");
		expect(statSync(`${s.image}.old`).ino).not.toBe(before);
		expect(statSync(`${s.image}.old`).mode & 0o111).toBeGreaterThan(0);
		expect(existsSync(`${s.image}.old.tmp`)).toBe(false);
	});

	test("no hard links and a copy that fails half way: the partial backup never replaces the install", async () => {
		const s = await appImageScenario();
		// As a full disk would: part of the file written to the target, then an error.
		expect(await updateWithTools(s, { ln: "exit 1", cp: 'echo partial > "$3"; exit 1' })).toBe(1);
		expect(read(s.image)).toContain("1.0.0");
		expect(existsSync(`${s.image}.old`)).toBe(false);
		expect(existsSync(`${s.image}.old.tmp`)).toBe(false);
		expect(existsSync(`${s.image}.new`)).toBe(false);
		expect(await s.v1.status()).toMatchObject({ phase: "failed" });
	});

	test("rollback brings the old file back", async () => {
		const s = await appImageScenario();
		expect((await update(s.v1, { relaunch: false })).code).toBe(0);
		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		expect(await s.v2.rollbackIfNeeded()).toBe(true);
		expect(read(s.image)).toContain("1.0.0");
		expect(existsSync(`${s.image}.old`)).toBe(false);
		expect(await s.v1.check()).toBeNull();
	});

	test("a failed swap leaves it as it was", async () => {
		const s = await appImageScenario();
		const { code } = await update(s.v1, { relaunch: false, beforeExit: (payload) => rmSync(payload, { recursive: true }) });
		expect(code).toBe(1);
		expect(read(s.image)).toContain("1.0.0");
		expect(existsSync(`${s.image}.old`)).toBe(false);
	});

	test("an archive with a folder in it, or a file that can't run, is refused", async () => {
		const s = await appImageScenario();
		const staged = await s.v1.download((await s.v1.check())!);
		chmodSync(join(staged.payloadDir, staged.entries[0]!), 0o644);
		expect((await s.v1.apply(staged, { quit: false }).catch((e) => e)).code).toBe("layout_invalid");
		rmSync(join(staged.payloadDir, staged.entries[0]!));
		mkdirSync(join(staged.payloadDir, staged.entries[0]!));
		expect((await s.v1.apply(staged, { quit: false }).catch((e) => e)).code).toBe("layout_invalid");
		expect(read(s.image)).toContain("1.0.0");
	});
});

describe.if(posix)("extraction", () => {
	test("tar leaving at the end-of-archive marker, before the padding after it, isn't a failure", async () => {
		const { dir } = await base("updater-extract-");
		writeFileSync(join(dir, "file"), "content");
		await createArchive([join(dir, "file")], join(dir, "plain.tar.zst"), "tar.zst");
		const tar = zstdDecompressSync(readFileSync(join(dir, "plain.tar.zst")));
		// More padding than a pipe holds: writing it can't succeed once tar has gone.
		writeFileSync(join(dir, "padded.tar.zst"), zstdCompressSync(Buffer.concat([tar, Buffer.alloc(8 << 20)])));
		for (let i = 0; i < 5; i++) {
			await extractArchive(join(dir, "padded.tar.zst"), "tar.zst", join(dir, `out${i}`));
			expect(read(join(dir, `out${i}`, "file"))).toBe("content");
		}
	});

	test("a truncated archive still fails", async () => {
		const { dir } = await base("updater-extract-");
		writeFileSync(join(dir, "file"), Buffer.alloc(1 << 20, 7));
		await createArchive([join(dir, "file")], join(dir, "whole.tar.zst"), "tar.zst");
		const tar = zstdDecompressSync(readFileSync(join(dir, "whole.tar.zst")));
		writeFileSync(join(dir, "cut.tar.zst"), zstdCompressSync(tar.subarray(0, 1 << 19)));
		expect((await extractArchive(join(dir, "cut.tar.zst"), "tar.zst", join(dir, "out")).catch((e) => e)).code).toBe("extract_failed");
	});
});

describe.if(posix)("which artifact a running copy takes", () => {
	test("the kind it is, and nothing else", async () => {
		const both = (f: any) => ({ "linux-arm64": { ...f, url: "folder.tar.zst" }, "appimage-arm64": f });
		const image = await appImageScenario(both);
		expect((await image.v1.check())!).toMatchObject({ platformKey: "appimage-arm64", artifact: { url: expect.stringContaining("image.tar.zst") } });

		// A release without an AppImage: a copy running as one has no update, it doesn't take the folder.
		const noImage = await appImageScenario((f) => ({ "linux-arm64": f }));
		expect(await noImage.v1.check()).toBeNull();

		const folder = await folderScenario();
		expect((await folder.v1.check())!.platformKey).toBe("linux-arm64");
		expect(platformKeyOf("linux", "x64", "app-folder")).toBe("linux-x64");
		expect(platformKeyOf("linux", "x64", "appimage")).toBe("appimage-x64");
	});

	test("$APPIMAGE inherited from another AppImage doesn't make this one: the file it names is left alone", async () => {
		const { dir, marker } = await base("updater-inherit-");
		const folder = join(dir, "Notes");
		await appFolder(folder, "1.0.0", marker);
		const env = { APPIMAGE: "/home/u/Apps/Terminal.AppImage", APPDIR: "/tmp/.mount_term" };
		expect(locateInstall(join(folder, "myapp"), "linux", env)).toMatchObject({ kind: "app-folder", target: folder });
		expect(locateInstall(join(folder, "myapp"), "linux", { APPIMAGE: env.APPIMAGE })).toMatchObject({ kind: "app-folder" });
		expect(locateInstall("/tmp/.mount_term/kitty", "linux", env)).toEqual({ kind: "appimage", target: env.APPIMAGE, dir: "/home/u/Apps" });
		expect(locateInstall("/tmp/.mount_termx/kitty", "linux", env).kind).toBe("executable"); // a mount with the same prefix
		expect(locateInstall(join(folder, "myapp"), "darwin", env).kind).toBe("executable");
	});

	test("the new keys pass the check every client runs on a manifest", () => {
		const a = { url: "a.tar.zst", sha256: "a".repeat(64), size: 1, format: "tar.zst" };
		expect(() =>
			validateManifest({ name: "x", version: "1.0.0", channel: "stable", releasedAt: "2026-01-01T00:00:00Z", signature: "s", artifacts: { "appimage-x64": a, "appimage-arm64": a, "linux-x64": a, "darwin-arm64": a, "windows-x64": a } }),
		).not.toThrow();
		// A longer key or a new format would have made every older client refuse the whole feed.
		expect(() => validateManifest({ name: "x", version: "1.0.0", channel: "stable", releasedAt: "2026-01-01T00:00:00Z", signature: "s", artifacts: { "linux-x64-appimage": a } })).toThrow();
	});
});
