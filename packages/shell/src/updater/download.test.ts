import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { extractArchive } from "./archive.ts";
import { downloadVerified, type DownloadProgress } from "./download.ts";
import { createUpdater } from "./index.ts";
import { buildArtifact, chunkedResponse, makeKeys, serveStatic, signedManifest, tempDir, writeFakeApp, writeFakeExe } from "./test-utils.ts";

let root: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
	root = await tempDir("updater-dl-");
});
afterAll(async () => {
	await root.cleanup();
});

describe("downloadVerified", () => {
	const payload = crypto.getRandomValues(new Uint8Array(3 * 65536 + 17));
	const sha256 = new Bun.CryptoHasher("sha256").update(payload).digest("hex");

	test("streams with progress and verifies", async () => {
		const host = serveStatic({ "/a.bin": () => chunkedResponse(payload, 10) });
		const dest = join(root.dir, "ok.bin");
		const events: DownloadProgress[] = [];
		await downloadVerified(`${host.base}/a.bin`, dest, { sha256, size: payload.length }, { onProgress: (p) => events.push(p) });
		host.stop();
		expect(new Uint8Array(await Bun.file(dest).arrayBuffer())).toEqual(payload);
		expect(events.length).toBeGreaterThan(3);
		expect(events.at(-1)).toEqual({ received: payload.length, total: payload.length, fraction: 1 });
		for (let i = 1; i < events.length; i++) expect(events[i]!.received).toBeGreaterThan(events[i - 1]!.received);
	});

	test("sha256 mismatch is rejected and nothing is left behind", async () => {
		const tampered = payload.slice();
		tampered[1000]! ^= 0xff;
		const host = serveStatic({ "/a.bin": () => new Response(tampered) });
		const dest = join(root.dir, "bad-hash.bin");
		const err = await downloadVerified(`${host.base}/a.bin`, dest, { sha256, size: payload.length }).catch((e) => e);
		host.stop();
		expect(err.code).toBe("hash_mismatch");
		expect(await Bun.file(dest).exists()).toBe(false);
		expect(await Bun.file(`${dest}.part`).exists()).toBe(false);
	});

	test("size mismatch: declared content-length differs", async () => {
		const host = serveStatic({ "/a.bin": () => new Response(payload) });
		const err = await downloadVerified(`${host.base}/a.bin`, join(root.dir, "s1.bin"), { sha256, size: payload.length + 1 }).catch((e) => e);
		host.stop();
		expect(err.code).toBe("size_mismatch");
	});

	test("size mismatch: chunked body longer than pinned is cut off", async () => {
		const bigger = new Uint8Array(payload.length * 4);
		const host = serveStatic({ "/a.bin": () => chunkedResponse(bigger, 40) });
		const events: DownloadProgress[] = [];
		const err = await downloadVerified(`${host.base}/a.bin`, join(root.dir, "s2.bin"), { sha256, size: payload.length }, { onProgress: (p) => events.push(p) }).catch((e) => e);
		host.stop();
		expect(err.code).toBe("size_mismatch");
		expect(events.length).toBeGreaterThan(0);
		expect(events.at(-1)!.received).toBeLessThanOrEqual(payload.length);
		expect(await Bun.file(join(root.dir, "s2.bin.part")).exists()).toBe(false);
	});

	test("size mismatch: chunked body shorter than pinned", async () => {
		const host = serveStatic({ "/a.bin": () => chunkedResponse(payload.slice(0, 100), 2) });
		const err = await downloadVerified(`${host.base}/a.bin`, join(root.dir, "s3.bin"), { sha256, size: payload.length }).catch((e) => e);
		host.stop();
		expect(err.code).toBe("size_mismatch");
	});

	test("HTTP 404 -> download_failed; abort -> aborted", async () => {
		const host = serveStatic({
			"/slow.bin": () =>
				new Response(
					new ReadableStream({
						async pull(c) {
							await Bun.sleep(50);
							c.enqueue(new Uint8Array(1024));
						},
					}),
				),
		});
		expect((await downloadVerified(`${host.base}/missing`, join(root.dir, "x"), { sha256, size: 1 }).catch((e) => e)).code).toBe("download_failed");
		const ac = new AbortController();
		const p = downloadVerified(`${host.base}/slow.bin`, join(root.dir, "y"), { sha256, size: 1 << 30 }, {
			signal: ac.signal,
			onProgress: (e) => e.received > 2048 && ac.abort(),
		});
		expect((await p.catch((e) => e)).code).toBe("aborted");
		host.stop();
	});
});

describe("extraction", () => {
	for (const format of ["tar.zst", "tar.gz"] as const) {
		test(`${format}: preserves files, modes and symlinks`, async () => {
			const src = join(root.dir, `src-${format}`);
			const app = await writeFakeApp(src, "Demo", "2.0.0", "/dev/null");
			await mkdir(join(app, "Contents", "Frameworks", "X.framework", "Versions", "A"), { recursive: true });
			await Bun.write(join(app, "Contents", "Frameworks", "X.framework", "Versions", "A", "X"), "lib");
			await symlink("Versions/A/X", join(app, "Contents", "Frameworks", "X.framework", "X"));
			const archive = join(root.dir, `demo.${format}`);
			await buildArtifact([app], archive, format);
			const out = join(root.dir, `out-${format}`);
			await extractArchive(archive, format, out);
			expect(await readdir(out)).toEqual(["Demo.app"]);
			const exe = Bun.file(join(out, "Demo.app", "Contents", "MacOS", "Demo"));
			expect(await exe.text()).toContain("2.0.0");
			expect(((await exe.stat()).mode & 0o111) !== 0).toBe(true);
			expect(await readlink(join(out, "Demo.app", "Contents", "Frameworks", "X.framework", "X"))).toBe("Versions/A/X");
		});
	}

	test("corrupt zstd stream -> extract_failed", async () => {
		const bad = join(root.dir, "bad.tar.zst");
		await Bun.write(bad, crypto.getRandomValues(new Uint8Array(4096)));
		expect((await extractArchive(bad, "tar.zst", join(root.dir, "bad-out")).catch((e) => e)).code).toBe("extract_failed");
	});
});

describe("Updater.download()", () => {
	async function fixture(entries: (dir: string) => Promise<string[]>, install: string) {
		const keys = await makeKeys();
		const { dir, cleanup } = await tempDir();
		const build = join(dir, "build");
		await mkdir(build, { recursive: true });
		const artifact = await buildArtifact(await entries(build), join(dir, "pub", "app.tar.zst"));
		const manifest = await signedManifest(keys.privateKey, {
			artifacts: { "linux-x64": { url: "files/app.tar.zst", sha256: artifact.sha256, size: artifact.size, format: "tar.zst" } },
		});
		const host = serveStatic({
			"/stable/update.json": () => Response.json(manifest),
			"/stable/files/app.tar.zst": () => new Response(Bun.file(artifact.path)),
		});
		const updater = createUpdater({
			manifestUrl: `${host.base}/stable/update.json`,
			publicKey: keys.publicKey,
			currentVersion: "1.0.0",
			appName: "TestApp",
			dataDir: join(dir, "data"),
			platform: "linux",
			arch: "x64",
			installPath: join(dir, install),
		});
		return { updater, host, dir, cleanup: async () => (host.stop(), await cleanup()) };
	}

	test("downloads (relative URL), verifies, extracts; second call is a cache hit", async () => {
		const f = await fixture(async (b) => {
			await writeFakeExe(join(b, "myapp"), "2.0.0", "/dev/null");
			await Bun.write(join(b, "libnative.so"), "native");
			return [join(b, "myapp"), join(b, "libnative.so")];
		}, "install/myapp");
		const info = (await f.updater.check())!;
		let last: DownloadProgress | undefined;
		const staged = await f.updater.download(info, { onProgress: (p) => (last = p) });
		expect(last!.fraction).toBe(1);
		expect(staged.entries).toEqual(["libnative.so", "myapp"]);
		expect(await Bun.file(join(staged.payloadDir, "myapp")).text()).toContain("2.0.0");
		const before = f.host.hits.length;
		await f.updater.download(info);
		expect(f.host.hits.length).toBe(before); // verified cached archive reused
		await f.cleanup();
	});

	test("archive without the executable is rejected (layout_invalid)", async () => {
		const f = await fixture(async (b) => {
			await Bun.write(join(b, "a"), "1");
			await Bun.write(join(b, "b"), "2");
			return [join(b, "a"), join(b, "b")];
		}, "install/myapp");
		const info = (await f.updater.check())!;
		expect((await f.updater.download(info).catch((e) => e)).code).toBe("layout_invalid");
		await f.cleanup();
	});
});
