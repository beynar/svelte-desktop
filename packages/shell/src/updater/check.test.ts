import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createUpdater, type UpdaterOptions } from "./index.ts";
import { defaultDataDir, locateInstall, platformKeyOf } from "./platform.ts";
import { writeState } from "./state.ts";
import { makeKeys, signedManifest, tempDir } from "./test-utils.ts";
import type { UpdateManifest } from "./manifest.ts";

const art = (url: string) => ({ url, sha256: "c".repeat(64), size: 10, format: "tar.zst" as const });
const MANIFEST_URL = "https://updates.example.com/testapp/stable/update.json";

async function setup(fields: Partial<UpdateManifest>, opts: Partial<UpdaterOptions> = {}) {
	const keys = await makeKeys();
	const manifest = await signedManifest(keys.privateKey, {
		artifacts: { "darwin-arm64": art("TestApp-2.0.0-darwin-arm64.tar.zst"), "linux-x64": art("https://cdn.example.net/l.tar.zst") },
		...fields,
	});
	const requested: string[] = [];
	const fakeFetch = (async (input: string | URL | Request) => {
		requested.push(String(input));
		return new Response(JSON.stringify(manifest));
	}) as typeof fetch;
	const { dir, cleanup } = await tempDir();
	const updater = createUpdater({
		manifestUrl: MANIFEST_URL,
		publicKey: keys.publicKey,
		currentVersion: "1.0.0",
		appName: "TestApp",
		dataDir: dir,
		fetch: fakeFetch,
		platform: "darwin",
		arch: "arm64",
		...opts,
	});
	return { updater, keys, manifest, requested, dir, cleanup };
}

describe("check()", () => {
	test("newer version: returns info with resolved relative URL", async () => {
		const { updater, cleanup } = await setup({});
		const info = await updater.check();
		expect(info).not.toBeNull();
		expect(info!.version).toBe("2.0.0");
		expect(info!.platformKey).toBe("darwin-arm64");
		expect(info!.artifact.url).toBe("https://updates.example.com/testapp/stable/TestApp-2.0.0-darwin-arm64.tar.zst");
		expect(info!.mandatory).toBe(false);
		await cleanup();
	});

	test("absolute artifact URL is kept", async () => {
		const { updater, cleanup } = await setup({}, { platform: "linux", arch: "x64" });
		expect((await updater.check())!.artifact.url).toBe("https://cdn.example.net/l.tar.zst");
		await cleanup();
	});

	test("same or older version -> null (no downgrade via replayed manifest)", async () => {
		for (const [current, remote] of [
			["2.0.0", "2.0.0"],
			["2.1.0", "2.0.0"],
			["1.10.0", "1.9.0"],
			["2.0.0", "2.0.0-beta.3"],
		] as const) {
			const { updater, cleanup } = await setup({ version: remote }, { currentVersion: current });
			expect(await updater.check()).toBeNull();
			await cleanup();
		}
	});

	test("semver ordering: 1.10.0 > 1.9.0, prerelease < release", async () => {
		const a = await setup({ version: "1.10.0" }, { currentVersion: "1.9.0" });
		expect((await a.updater.check())?.version).toBe("1.10.0");
		await a.cleanup();
		const b = await setup({ version: "2.0.0" }, { currentVersion: "2.0.0-rc.1" });
		expect((await b.updater.check())?.version).toBe("2.0.0");
		await b.cleanup();
	});

	test("channel must match; {channel} is substituted in the URL", async () => {
		const a = await setup({ channel: "beta" });
		expect((await a.updater.check().catch((e) => e)).code).toBe("channel_mismatch");
		await a.cleanup();
		const b = await setup({ channel: "beta" }, { channel: "beta", manifestUrl: "https://u.example.com/{channel}/update.json" });
		expect((await b.updater.check())?.channel).toBe("beta");
		expect(b.requested).toEqual(["https://u.example.com/beta/update.json"]);
		await b.cleanup();
	});

	test("app name must match", async () => {
		const { updater, cleanup } = await setup({ name: "OtherApp" });
		expect((await updater.check().catch((e) => e)).code).toBe("name_mismatch");
		await cleanup();
	});

	test("minimumVersion marks the update mandatory for older installs", async () => {
		const a = await setup({ minimumVersion: "1.5.0" }, { currentVersion: "1.4.9" });
		expect((await a.updater.check())!.mandatory).toBe(true);
		await a.cleanup();
		const b = await setup({ minimumVersion: "1.5.0" }, { currentVersion: "1.5.0" });
		expect((await b.updater.check())!.mandatory).toBe(false);
		await b.cleanup();
	});

	test("no artifact for this platform -> null", async () => {
		const { updater, cleanup } = await setup({}, { platform: "win32", arch: "x64" });
		expect(await updater.check()).toBeNull();
		await cleanup();
	});

	test("bad signature from the server is rejected", async () => {
		const { updater, cleanup } = await setup({}, { publicKey: (await makeKeys()).publicKey });
		expect((await updater.check().catch((e) => e)).code).toBe("signature_invalid");
		await cleanup();
	});

	test("HTTP error -> manifest_fetch_failed", async () => {
		const { updater, cleanup } = await setup({}, { fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
		expect((await updater.check().catch((e) => e)).code).toBe("manifest_fetch_failed");
		await cleanup();
	});

	test("a version that was rolled back is not offered again", async () => {
		const { updater, dir, cleanup } = await setup({});
		await writeState(join(dir, "state.json"), {
			phase: "rolled-back", from: "1.0.0", to: "2.0.0", attempts: 2, platform: "darwin", moves: [], stagingDir: "", updatedAt: new Date().toISOString(),
		});
		expect(await updater.check()).toBeNull();
		await cleanup();
	});

	test("invalid currentVersion is a config error", () => {
		expect(() => createUpdater({ manifestUrl: MANIFEST_URL, publicKey: "x", currentVersion: "v1", appName: "A", dataDir: "/tmp/x" })).toThrow(/semver/);
	});
});

describe("platform helpers", () => {
	test("platform keys", () => {
		expect(platformKeyOf("darwin", "arm64")).toBe("darwin-arm64");
		expect(platformKeyOf("win32", "x64")).toBe("windows-x64");
		expect(platformKeyOf("linux", "ia32")).toBeNull();
	});
	test("default data dirs", () => {
		expect(defaultDataDir("My App", "darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/My App/updates");
		expect(defaultDataDir("My App", "linux", {}, "/home/u")).toBe("/home/u/.local/share/My App/updates");
		expect(defaultDataDir("My App", "linux", { XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/My App/updates");
		expect(defaultDataDir("My App", "win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe("C:\\Users\\u\\AppData\\Local\\My App\\updates");
		expect(() => defaultDataDir("../x", "linux")).toThrow();
	});
	test("install location", () => {
		expect(locateInstall("/Applications/My App.app/Contents/MacOS/myapp", "darwin")).toEqual({
			kind: "app-bundle", target: "/Applications/My App.app", dir: "/Applications",
		});
		expect(locateInstall("/opt/myapp/myapp", "linux", {})).toEqual({ kind: "executable", target: "/opt/myapp/myapp", dir: "/opt/myapp" });
		expect(locateInstall("/tmp/.mount_x/myapp", "linux", { APPIMAGE: "/home/u/Apps/MyApp.AppImage" }).target).toBe("/home/u/Apps/MyApp.AppImage");
		expect(locateInstall("C:\\Users\\u\\AppData\\Local\\Programs\\MyApp\\myapp.exe", "win32")).toEqual({
			kind: "executable", target: "C:\\Users\\u\\AppData\\Local\\Programs\\MyApp\\myapp.exe", dir: "C:\\Users\\u\\AppData\\Local\\Programs\\MyApp",
		});
	});
});
