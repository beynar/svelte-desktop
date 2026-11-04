/** The publishing CLI (scripts/updater-cli.ts), driven as a subprocess. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSignedManifest } from "./manifest.ts";
import { createUpdater } from "./index.ts";
import { serveStatic, tempDir, writeFakeApp } from "./test-utils.ts";

const CLI = join(import.meta.dir, "..", "..", "scripts", "updater-cli.ts");
let root: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
	root = await tempDir("updater-cli-");
});
afterAll(() => root.cleanup());

async function cli(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd: root.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
	const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

test("keygen -> pack -> make-manifest -> verify -> client check+download", async () => {
	const kg = await cli(["keygen", "--out", "key.pem"]);
	expect(kg.code).toBe(0);
	const publicKey = kg.stdout;
	expect(Buffer.from(publicKey, "base64").length).toBe(32);
	expect((await Bun.file(join(root.dir, "key.pem")).text())).toStartWith("-----BEGIN PRIVATE KEY-----");
	expect((await stat(join(root.dir, "key.pem"))).mode & 0o077).toBe(0);
	expect((await cli(["keygen", "--out", "key.pem"])).code).toBe(1); // refuses to overwrite

	await writeFakeApp(join(root.dir, "dist"), "TestApp", "1.2.0", "/dev/null");
	const pk = await cli(["pack", "dist/TestApp.app", "--out", "out/TestApp-1.2.0-darwin-arm64.tar.zst"]);
	expect(pk.code).toBe(0);

	const mm = await cli([
		"make-manifest", "--name", "TestApp", "--version", "1.2.0", "--channel", "beta",
		"--artifact", "darwin-arm64=out/TestApp-1.2.0-darwin-arm64.tar.zst",
		"--key", "key.pem", "--notes", "Bug fixes", "--minimum-version", "1.0.0", "--out", "out/update.json",
	]);
	expect(mm.code).toBe(0);
	const text = await Bun.file(join(root.dir, "out", "update.json")).text();
	const manifest = await parseSignedManifest(text, [publicKey]);
	expect(manifest.artifacts["darwin-arm64"]).toMatchObject({ url: "TestApp-1.2.0-darwin-arm64.tar.zst", format: "tar.zst" });
	expect(manifest.artifacts["darwin-arm64"]!.size).toBe(Bun.file(join(root.dir, "out", "TestApp-1.2.0-darwin-arm64.tar.zst")).size);
	expect(manifest).toMatchObject({ channel: "beta", notes: "Bug fixes", minimumVersion: "1.0.0" });

	expect((await cli(["verify", "out/update.json", "--public-key", publicKey])).code).toBe(0);
	const other = (await cli(["keygen", "--out", "other.pem"])).stdout;
	expect((await cli(["verify", "out/update.json", "--public-key", other])).code).toBe(1);

	// The published directory works as-is from a static host (relative URL).
	const host = serveStatic({
		"/beta/update.json": () => new Response(Bun.file(join(root.dir, "out", "update.json"))),
		"/beta/TestApp-1.2.0-darwin-arm64.tar.zst": () => new Response(Bun.file(join(root.dir, "out", "TestApp-1.2.0-darwin-arm64.tar.zst"))),
	});
	const updater = createUpdater({
		manifestUrl: `${host.base}/{channel}/update.json`,
		publicKey: [other, publicKey],
		currentVersion: "1.1.0",
		appName: "TestApp",
		channel: "beta",
		dataDir: join(root.dir, "data"),
		platform: "darwin",
		arch: "arm64",
		installPath: join(root.dir, "Applications", "TestApp.app", "Contents", "MacOS", "TestApp"),
	});
	const staged = await updater.download((await updater.check())!);
	expect(staged.entries).toEqual(["TestApp.app"]);
	host.stop();
});

test("sign: re-signs an edited manifest in place; --key-env works; tampering is caught", async () => {
	const { stdout: publicKey } = await cli(["keygen", "--out", "k2.pem"]);
	const pem = await Bun.file(join(root.dir, "k2.pem")).text();
	const unsigned = {
		name: "TestApp", version: "3.0.0", channel: "stable", releasedAt: "2026-10-30T00:00:00Z",
		artifacts: { "linux-x64": { url: "https://cdn.example.com/a.tar.gz", sha256: "d".repeat(64), size: 5, format: "tar.gz" } },
	};
	await Bun.write(join(root.dir, "m.json"), JSON.stringify(unsigned));
	const r = await cli(["sign", "m.json", "--key-env", "UPDATER_KEY"], { UPDATER_KEY: pem });
	expect(r.code).toBe(0);
	const signed = await Bun.file(join(root.dir, "m.json")).json();
	expect(signed.signature).toBeString();
	expect((await cli(["verify", "m.json", "--public-key", publicKey])).code).toBe(0);
	await Bun.write(join(root.dir, "m.json"), JSON.stringify({ ...signed, version: "3.0.1" }));
	const bad = await cli(["verify", "m.json", "--public-key", publicKey]);
	expect(bad.code).toBe(1);
	expect(bad.stderr).toContain("signature");
});

test("make-manifest rejects bad artifact specs", async () => {
	await cli(["keygen", "--out", "k3.pem"]);
	await Bun.write(join(root.dir, "x.zip"), "zip");
	expect((await cli(["make-manifest", "--name", "A", "--version", "1.0.0", "--artifact", "beos-x64=x.zip", "--key", "k3.pem"])).stderr).toContain("bad --artifact");
	expect((await cli(["make-manifest", "--name", "A", "--version", "1.0.0", "--artifact", "linux-x64=x.zip", "--key", "k3.pem"])).stderr).toContain(".tar.zst or .tar.gz");
	expect((await cli(["make-manifest", "--name", "A", "--version", "nope", "--artifact", "linux-x64=missing.tar.gz", "--key", "k3.pem"])).code).toBe(1);
});

test("merge: one signed update.json from each platform's manifest; fetch-previous downloads the published archives", async () => {
	const publicKey = (await cli(["keygen", "--out", "km.pem"])).stdout;
	const art = (name: string, size: number) => ({ url: `1.3.0/${name}`, sha256: "a".repeat(64), size, format: "tar.zst" });
	const part = (key: string, file: string, patches?: unknown) => ({ name: "dev.test.app", version: "1.3.0", channel: "stable", releasedAt: "2026-11-03T10:00:00.000Z", artifacts: { [key]: art(file, 10) }, ...(patches ? { patches: { [key]: patches } } : {}) });
	await Bun.write(join(root.dir, "mac.json"), JSON.stringify(part("darwin-arm64", "A-1.3.0-darwin-arm64.tar.zst", [{ from: "1.2.0", url: "1.3.0/p.sdpatch", sha256: "b".repeat(64), size: 3 }])));
	await Bun.write(join(root.dir, "linux.json"), JSON.stringify(part("linux-x64", "a-1.3.0-linux-x64.tar.zst")));
	await Bun.write(join(root.dir, "win.json"), JSON.stringify(part("windows-x64", "A-1.3.0-windows-x64.tar.zst")));
	const mg = await cli(["merge", "mac.json", "linux.json", "win.json", "--key", "km.pem", "--out", "merged.json"]);
	expect(mg.code).toBe(0);
	const merged = await parseSignedManifest(await Bun.file(join(root.dir, "merged.json")).text(), [publicKey]);
	expect(Object.keys(merged.artifacts).sort()).toEqual(["darwin-arm64", "linux-x64", "windows-x64"]);
	expect(Object.keys(merged.patches as object)).toEqual(["darwin-arm64"]);
	// Another version among the parts: refused.
	await Bun.write(join(root.dir, "other.json"), JSON.stringify({ ...part("linux-arm64", "x.tar.zst"), version: "1.4.0" }));
	expect((await cli(["merge", "mac.json", "other.json", "--key", "km.pem", "--out", "x.json"])).stderr).toContain("merge:");

	// fetch-previous: the archive the manifest pins, into <dir>/<version>/; a 404 manifest is a first release.
	const bytes = new TextEncoder().encode("archive bytes");
	const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const signed = (await cli(["make-manifest", "--name", "dev.test.app", "--version", "1.3.0", "--artifact", "linux-x64=" + (await Bun.write(join(root.dir, "a-1.3.0-linux-x64.tar.zst"), bytes), "a-1.3.0-linux-x64.tar.zst"), "--key", "km.pem"])).stdout;
	const manifest = JSON.parse(signed);
	expect(manifest.artifacts["linux-x64"].sha256).toBe(sha);
	manifest.artifacts["linux-x64"].url = "1.3.0/a-1.3.0-linux-x64.tar.zst";
	await Bun.write(join(root.dir, "pub.json"), JSON.stringify(manifest));
	expect((await cli(["sign", "pub.json", "--key", "km.pem"])).code).toBe(0);
	const site = serveStatic({ "/stable/update.json": () => new Response(Bun.file(join(root.dir, "pub.json"))), "/stable/1.3.0/a-1.3.0-linux-x64.tar.zst": () => new Response(bytes) });
	try {
		const fp = await cli(["fetch-previous", `${site.base}/stable/update.json`, "--platform", "linux-x64", "--platform", "darwin-arm64", "--dir", "rel", "--public-key", publicKey]);
		expect(fp.code).toBe(0);
		expect(await Bun.file(join(root.dir, "rel/1.3.0/a-1.3.0-linux-x64.tar.zst")).text()).toBe("archive bytes");
		expect(fp.stderr).toContain("no darwin-arm64 archive");
		const none = await cli(["fetch-previous", `${site.base}/beta/update.json`, "--platform", "linux-x64", "--dir", "rel"]);
		expect(none.code).toBe(0);
		expect(none.stderr).toContain("first release");
	} finally {
		site.stop();
	}
});
