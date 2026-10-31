/**
 * End-to-end swap cycles in temp dirs. The real helper script runs; the "app"
 * is a fake executable (a shell script that writes its version to a marker
 * file when launched) or a fake .app bundle; the PID the helper waits for is a
 * short-lived `sleep`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createUpdater, type Staged, type UpdaterOptions } from "./index.ts";
import { renderPs1Helper, renderShHelper, type HelperPlan } from "./helper.ts";
import { buildArtifact, makeKeys, serveStatic, signedManifest, tempDir, waitFor, writeFakeApp, writeFakeExe } from "./test-utils.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

const read = (p: string) => Bun.file(p).text();
const exists = (p: string) => Bun.file(p).exists();
const dirExists = async (p: string) => {
	try {
		await readdir(p);
		return true;
	} catch {
		return false;
	}
};

type Layout = "exe" | "app";

/** Version the relaunched fake app wrote to its marker file (waits for the detached relaunch). */
async function launchedVersion(marker: string): Promise<string> {
	return (await waitFor(async () => ((await exists(marker)) ? (await read(marker)).trim() : ""))) as string;
}

/** Installs v1, publishes v2, returns updaters for both versions sharing one data dir. */
async function scenario(layout: Layout, extra: Partial<UpdaterOptions> = {}) {
	const { dir, cleanup } = await tempDir("updater-apply-");
	cleanups.push(cleanup);
	const marker = join(dir, "launched.txt");
	const installDir = join(dir, layout === "app" ? "Applications" : "opt/myapp");
	const build = join(dir, "build");
	await mkdir(installDir, { recursive: true });
	await mkdir(build, { recursive: true });

	let installPath: string;
	let inputs: string[];
	let relaunchCommand: string[] | undefined;
	if (layout === "app") {
		const app = await writeFakeApp(installDir, "MyApp", "1.0.0", marker);
		installPath = join(app, "Contents", "MacOS", "MyApp");
		inputs = [await writeFakeApp(build, "MyApp", "2.0.0", marker)];
		// Real default is `open -n <App>.app`; run the bundle's binary directly so the test never involves LaunchServices.
		relaunchCommand = [installPath];
	} else {
		installPath = join(installDir, "myapp");
		await writeFakeExe(installPath, "1.0.0", marker);
		await Bun.write(join(installDir, "libnative.so"), "native-1");
		await writeFakeExe(join(build, "myapp"), "2.0.0", marker);
		await Bun.write(join(build, "libnative.so"), "native-2");
		await Bun.write(join(build, "resources.dat"), "added-in-2");
		inputs = ["myapp", "libnative.so", "resources.dat"].map((n) => join(build, n));
	}

	const keys = await makeKeys();
	const artifact = await buildArtifact(inputs, join(dir, "pub", "update.tar.zst"));
	const platform = layout === "app" ? "darwin" : "linux";
	const manifest = await signedManifest(keys.privateKey, {
		artifacts: { [`${platform}-arm64`]: { url: "update.tar.zst", sha256: artifact.sha256, size: artifact.size, format: "tar.zst" } },
	});
	const host = serveStatic({
		"/update.json": () => Response.json(manifest),
		"/update.tar.zst": () => new Response(Bun.file(artifact.path)),
	});
	cleanups.push(host.stop);

	const make = (currentVersion: string) =>
		createUpdater({
			manifestUrl: `${host.base}/update.json`,
			publicKey: keys.publicKey,
			currentVersion,
			appName: "TestApp",
			dataDir: join(dir, "data"),
			platform,
			arch: "arm64",
			installPath,
			relaunchCommand,
			...extra,
		});
	return { dir, marker, installDir, installPath, v1: make("1.0.0"), v2: make("2.0.0") };
}

/** check + download + apply with a dummy PID; resolves once the helper has exited. */
async function runUpdate(s: Awaited<ReturnType<typeof scenario>>, opts: { relaunch: boolean; beforeExit?: (staged: Staged) => Promise<void> }) {
	const info = (await s.v1.check())!;
	expect(info.version).toBe("2.0.0");
	const staged = await s.v1.download(info);
	const dummy = Bun.spawn(["sleep", "0.3"]);
	const handle = await s.v1.apply(staged, { relaunch: opts.relaunch, quit: false, waitForPid: dummy.pid });
	expect((await s.v1.status())?.phase).toBe("applying");
	await opts.beforeExit?.(staged);
	await dummy.exited;
	const code = await handle.exited!;
	return { code, staged, handle };
}

describe("apply: bare executable + sibling files (Linux/Windows layout)", () => {
	test("waits for the PID, swaps, keeps .old, relaunches, then confirm() cleans up", async () => {
		const s = await scenario("exe");
		let sawOldWhileRunning = false;
		const { code, staged } = await runUpdate(s, {
			relaunch: true,
			beforeExit: async () => {
				// The app is still "running": nothing may have been touched yet.
				sawOldWhileRunning = (await read(s.installPath)).includes("1.0.0") && !(await exists(`${s.installPath}.old`));
			},
		});
		expect(code).toBe(0);
		expect(sawOldWhileRunning).toBe(true);

		expect(await read(s.installPath)).toContain("2.0.0");
		expect(await read(`${s.installPath}.old`)).toContain("1.0.0");
		expect(await read(join(s.installDir, "libnative.so"))).toBe("native-2");
		expect(await read(join(s.installDir, "libnative.so.old"))).toBe("native-1");
		expect(await read(join(s.installDir, "resources.dat"))).toBe("added-in-2");
		expect((await launchedVersion(s.marker))).toBe("2.0.0");

		const state = (await s.v2.status())!;
		expect(state).toMatchObject({ phase: "applied", from: "1.0.0", to: "2.0.0", attempts: 0 });
		expect(await exists(join(s.dir, "data", "apply-helper.sh"))).toBe(false); // helper removed itself

		// New version starts healthy.
		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		expect((await s.v2.status())!.attempts).toBe(1);
		await s.v2.confirm();
		expect(await s.v2.status()).toBeNull();
		expect(await exists(`${s.installPath}.old`)).toBe(false);
		expect(await exists(join(s.installDir, "libnative.so.old"))).toBe(false);
		expect(await dirExists(staged.stagingDir)).toBe(false);
		expect(await s.v2.check()).toBeNull();
	});

	test("rollback: two unconfirmed starts restore the previous version", async () => {
		const s = await scenario("exe");
		const { code } = await runUpdate(s, { relaunch: false });
		expect(code).toBe(0);
		expect(await exists(s.marker)).toBe(false); // relaunch not requested

		expect(await s.v2.rollbackIfNeeded()).toBe(false); // 1st start, crashes before confirm()
		expect(await s.v2.rollbackIfNeeded()).toBe(true); // 2nd start -> rollback
		expect(await read(s.installPath)).toContain("1.0.0");
		expect(await read(join(s.installDir, "libnative.so"))).toBe("native-1");
		expect(await exists(join(s.installDir, "resources.dat"))).toBe(false); // file added by 2.0.0 removed
		expect(await exists(`${s.installPath}.old`)).toBe(false);
		expect(await exists(`${s.installPath}.bad`)).toBe(false);
		expect((await s.v1.status())).toMatchObject({ phase: "rolled-back", to: "2.0.0", attempts: 2 });

		// Back on 1.0.0: start + confirm keep the rolled-back marker so 2.0.0 isn't re-offered.
		expect(await s.v1.rollbackIfNeeded()).toBe(false);
		await s.v1.confirm();
		expect((await s.v1.status())?.phase).toBe("rolled-back");
		expect(await s.v1.check()).toBeNull();
	});

	test("restart() relaunches the installed app once the PID is gone (used after a rollback)", async () => {
		const s = await scenario("exe");
		const dummy = Bun.spawn(["sleep", "0.2"]);
		await s.v1.restart({ quit: false, waitForPid: dummy.pid });
		await Bun.sleep(50);
		expect(await exists(s.marker)).toBe(false); // still waiting
		await dummy.exited;
		expect(await launchedVersion(s.marker)).toBe("1.0.0");
	});

	test("swap failure restores the original files and records the failure", async () => {
		const s = await scenario("exe");
		const { code } = await runUpdate(s, {
			relaunch: true,
			// Sabotage: remove one staged file after apply() but before the app exits.
			beforeExit: (staged) => rm(join(staged.payloadDir, "resources.dat")),
		});
		expect(code).toBe(1);
		expect(await read(s.installPath)).toContain("1.0.0");
		expect(await read(join(s.installDir, "libnative.so"))).toBe("native-1");
		expect(await exists(`${s.installPath}.old`)).toBe(false);
		expect(await exists(join(s.installDir, "libnative.so.old"))).toBe(false);
		expect(await s.v1.status()).toMatchObject({ phase: "failed" });
		// Relaunched the restored old version.
		expect((await launchedVersion(s.marker))).toBe("1.0.0");
		expect(await read(join(s.dir, "data", "helper.log"))).toContain("restoring");
	});

	test("helper gives up (no swap) if the app does not exit in time", async () => {
		const s = await scenario("exe", { waitTimeoutSec: 1 });
		const staged = await s.v1.download((await s.v1.check())!);
		const dummy = Bun.spawn(["sleep", "30"]);
		cleanups.push(() => dummy.kill());
		const handle = await s.v1.apply(staged, { relaunch: false, quit: false, waitForPid: dummy.pid });
		expect(await handle.exited!).toBe(1);
		expect(await read(s.installPath)).toContain("1.0.0");
		expect(await s.v1.status()).toMatchObject({ phase: "failed", error: expect.stringContaining("timed out") });
	}, 10_000);

	test("unwritable install dir is refused before spawning anything", async () => {
		const s = await scenario("exe");
		const staged = await s.v1.download((await s.v1.check())!);
		const { chmod } = await import("node:fs/promises");
		await chmod(s.installDir, 0o555);
		cleanups.push(() => chmod(s.installDir, 0o755));
		expect((await s.v1.apply(staged, { quit: false }).catch((e) => e)).code).toBe("not_writable");
		expect(await s.v1.status()).toBeNull();
	});
});

describe("apply: macOS .app bundle", () => {
	test("swaps <App>.app -> <App>.app.old, relaunches, confirm() deletes .old", async () => {
		const s = await scenario("app");
		const app = join(s.installDir, "MyApp.app");
		const { code, handle } = await runUpdate(s, { relaunch: true });
		expect(code).toBe(0);
		expect(handle.moves).toEqual([
			{ src: expect.stringContaining("payload/MyApp.app"), dest: app, backup: `${app}.old`, existed: true },
		]);
		expect(await read(join(app, "Contents", "Info.plist"))).toContain("2.0.0");
		expect(await read(join(`${app}.old`, "Contents", "MacOS", "MyApp"))).toContain("1.0.0");
		expect((await launchedVersion(s.marker))).toBe("2.0.0");
		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		await s.v2.confirm();
		expect(await dirExists(`${app}.old`)).toBe(false);
		expect(await s.v2.status()).toBeNull();
	});

	test("rollback restores the old bundle", async () => {
		const s = await scenario("app");
		const app = join(s.installDir, "MyApp.app");
		expect((await runUpdate(s, { relaunch: false })).code).toBe(0);
		expect(await s.v2.rollbackIfNeeded()).toBe(false);
		expect(await s.v2.rollbackIfNeeded()).toBe(true);
		expect(await read(join(app, "Contents", "Info.plist"))).toContain("1.0.0");
		expect(await dirExists(`${app}.old`)).toBe(false);
		expect(await dirExists(`${app}.bad`)).toBe(false);
	});

	test("archive with more than one top-level entry is rejected", async () => {
		const s = await scenario("app");
		const info = (await s.v1.check())!;
		const staged = await s.v1.download(info);
		await Bun.write(join(staged.payloadDir, "stray.txt"), "x");
		expect((await s.v1.apply({ ...staged, entries: ["MyApp.app", "stray.txt"] }, { quit: false }).catch((e) => e)).code).toBe("layout_invalid");
	});
});

describe("helper scripts", () => {
	const plan: HelperPlan = {
		waitPid: 4242,
		waitTimeoutSec: 60,
		moves: [{ src: "C:\\Users\\O'Brien\\AppData\\Local\\My App\\updates\\staging\\2.0.0\\payload\\myapp.exe", dest: "C:\\Users\\O'Brien\\Programs\\My App\\myapp.exe", backup: "C:\\Users\\O'Brien\\Programs\\My App\\myapp.exe.old", existed: true }],
		statePath: "C:\\Users\\O'Brien\\AppData\\Local\\My App\\updates\\state.json",
		logPath: "C:\\Users\\O'Brien\\AppData\\Local\\My App\\updates\\helper.log",
		appliedJson: JSON.stringify({ phase: "applied", note: "it's" }),
		failedTimeoutJson: "{}",
		failedSwapJson: "{}",
		relaunch: ["C:\\Users\\O'Brien\\Programs\\My App\\myapp.exe"],
		relaunchCwd: "C:\\Users\\O'Brien\\Programs\\My App",
	};

	test("PowerShell helper (Windows) renders with escaped literals (not executed on this host)", () => {
		const ps1 = renderPs1Helper(plan);
		expect(ps1).toContain("$TargetPid = 4242");
		expect(ps1).toContain("Move-Retry 'C:\\Users\\O''Brien\\Programs\\My App\\myapp.exe' 'C:\\Users\\O''Brien\\Programs\\My App\\myapp.exe.old'");
		expect(ps1).toContain(`Write-State '{"phase":"applied","note":"it''s"}'`);
		expect(ps1).toContain("Start-Process -FilePath 'C:\\Users\\O''Brien\\Programs\\My App\\myapp.exe' -WorkingDirectory");
		// No unescaped single quote inside any literal: every quote run has even length except the delimiters.
		expect(ps1.includes("O'Brien")).toBe(false);
	});

	test("sh helper quotes hostile paths safely", async () => {
		const { dir, cleanup } = await tempDir("updater-quote-");
		cleanups.push(cleanup);
		const weird = join(dir, `it's $(touch pwned) "q" \`x\``);
		await mkdir(weird, { recursive: true });
		await Bun.write(join(weird, "new"), "2");
		await Bun.write(join(weird, "cur"), "1");
		const script = renderShHelper({
			...plan,
			waitPid: 999999,
			moves: [{ src: join(weird, "new"), dest: join(weird, "cur"), backup: join(weird, "cur.old"), existed: true }],
			statePath: join(weird, "state.json"),
			logPath: join(weird, "log"),
			relaunch: null,
			relaunchCwd: weird,
		});
		const scriptPath = join(dir, "h.sh");
		await Bun.write(scriptPath, script);
		const proc = Bun.spawn(["/bin/sh", scriptPath], { cwd: dir });
		expect(await proc.exited).toBe(0);
		expect(await read(join(weird, "cur"))).toBe("2");
		expect(await read(join(weird, "cur.old"))).toBe("1");
		expect(await exists(join(dir, "pwned"))).toBe(false);
		expect(JSON.parse(await read(join(weird, "state.json")))).toEqual({ phase: "applied", note: "it's" });
	});
});
