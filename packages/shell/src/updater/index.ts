/**
 * Auto-updater: signed static manifest -> verified download -> post-exit swap
 * helper -> confirm / automatic rollback. See ./README.md.
 */
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractArchive } from "./archive.ts";
import { downloadVerified, hasVerifiedFile, type DownloadProgress } from "./download.ts";
import { UpdateError } from "./errors.ts";
import { helperCommand, psQuote, renderPs1Helper, renderShHelper, shQuote, type HelperPlan } from "./helper.ts";
import { isSemver, parseSignedManifest, type Artifact, type PlatformKey, type UpdateManifest } from "./manifest.ts";
import { defaultDataDir, isCompiledBinary, locateInstall, platformKeyOf, type InstallLocation } from "./platform.ts";
import { readState, writeState, clearState, type Move, type UpdateState } from "./state.ts";

export { UpdateError, type UpdateErrorCode } from "./errors.ts";
export type { DownloadProgress } from "./download.ts";
export type { Artifact, ArchiveFormat, PlatformKey, UpdateManifest } from "./manifest.ts";
export type { InstallLocation } from "./platform.ts";
export type { Move, Phase, UpdateState } from "./state.ts";

export interface UpdaterOptions {
	/** URL of update.json. `{channel}` is substituted with the channel. */
	manifestUrl: string;
	/** base64 raw Ed25519 public key(s). Several keys = rotation window. */
	publicKey: string | readonly string[];
	currentVersion: string;
	/** Must equal manifest.name; also names the default data directory. */
	appName: string;
	/** Default "stable". The manifest's channel must match exactly. */
	channel?: string;
	/** Where staged downloads, state.json and helper scripts live. Default: per-OS app data dir + "/updates". */
	dataDir?: string;
	fetch?: typeof fetch;

	// --- overrides (tests, unusual layouts) ---
	/** Default process.platform. */
	platform?: NodeJS.Platform;
	/** Default process.arch. */
	arch?: string;
	/** Executable or .app to update. Default: derived from process.execPath (compiled binaries only). */
	installPath?: string;
	/** Unconfirmed starts of a new version before rollbackIfNeeded() restores the old one. Default 2. */
	maxAttempts?: number;
	/** How long the helper waits for the app to exit. Default 120 s. */
	waitTimeoutSec?: number;
	/** How apply()/restart() terminate the app. Default: process.exit(0) on the main thread, SIGTERM to the process from a Worker. */
	quit?: () => unknown;
	/** argv the helper uses to relaunch. Default: `open <App>.app` on macOS, the executable elsewhere. */
	relaunchCommand?: string[];
}

export interface UpdateInfo {
	version: string;
	currentVersion: string;
	channel: string;
	releasedAt: string;
	notes?: string;
	/** True when currentVersion < manifest.minimumVersion: the app should not let the user skip this update. */
	mandatory: boolean;
	platformKey: PlatformKey;
	/** The artifact for this platform, `url` resolved to absolute. */
	artifact: Artifact;
	/** A delta patch from the installed version, when the release ships one (url resolved). */
	patch?: { from: string; url: string; sha256: string; size: number };
	manifest: UpdateManifest;
}

export interface Staged {
	info: UpdateInfo;
	stagingDir: string;
	archivePath: string;
	/** Extracted archive root. */
	payloadDir: string;
	/** Top-level names inside payloadDir. */
	entries: string[];
	/** Set when the bundle was rebuilt from a delta patch instead of the full archive. */
	delta?: { files: number; bytes: number };
}

export interface DownloadOptions {
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
}

export interface ApplyOptions {
	/** Relaunch the app after the swap (or after a failed swap, the restored version). */
	relaunch?: boolean;
	relaunchArgs?: string[];
	/** Quit the app after spawning the helper. Default true. Tests pass false. */
	quit?: boolean;
	/** PID the helper waits for. Default process.pid. */
	waitForPid?: number;
	/** Write the helper script and return its command without running it or quitting. */
	dryRun?: boolean;
}

export interface ApplyHandle {
	scriptPath: string;
	command: string[];
	moves: Move[];
	/** Set unless dryRun. */
	pid?: number;
	exited?: Promise<number>;
}

export interface Updater {
	readonly dataDir: string;
	readonly channel: string;
	check(opts?: { signal?: AbortSignal }): Promise<UpdateInfo | null>;
	download(info: UpdateInfo, opts?: DownloadOptions): Promise<Staged>;
	apply(staged: Staged, opts?: ApplyOptions): Promise<ApplyHandle>;
	/** Call after a healthy start of the new version: deletes `.old` copies, staging and state. */
	confirm(): Promise<void>;
	/** Call early at startup. Returns true if it restored the previous version (then call restart()). */
	rollbackIfNeeded(): Promise<boolean>;
	/** Current update state, if any. */
	status(): Promise<UpdateState | null>;
	/** Wait for this process to exit, then relaunch the installed app. Quits unless { quit: false }. */
	restart(opts?: { quit?: boolean; args?: string[]; waitForPid?: number }): Promise<void>;
	/** Resolved install location (throws install_not_found when running uncompiled without installPath). */
	install(): InstallLocation;
}

const MAX_MANIFEST_BYTES = 1 << 20;

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function rmQuiet(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch {
		// Windows: a running exe can be renamed but not deleted; cleaned up on a later start.
	}
}

export function createUpdater(options: UpdaterOptions): Updater {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const channel = options.channel ?? "stable";
	const keys = typeof options.publicKey === "string" ? [options.publicKey] : [...options.publicKey];
	const doFetch = options.fetch ?? fetch;
	const maxAttempts = options.maxAttempts ?? 2;
	const waitTimeoutSec = options.waitTimeoutSec ?? 120;
	const { currentVersion, appName } = options;

	if (!isSemver(currentVersion)) throw new UpdateError("config_invalid", `currentVersion ${JSON.stringify(currentVersion)} is not semver`);
	if (keys.length === 0) throw new UpdateError("config_invalid", "at least one publicKey is required");
	const dataDir = options.dataDir ?? defaultDataDir(appName, platform);
	const statePath = join(dataDir, "state.json");
	const logPath = join(dataDir, "helper.log");

	let cachedInstall: InstallLocation | undefined;
	function install(): InstallLocation {
		if (cachedInstall) return cachedInstall;
		if (!options.installPath && !isCompiledBinary()) {
			throw new UpdateError(
				"install_not_found",
				`not running from a compiled app (process.execPath is ${process.execPath}); pass installPath to override`,
			);
		}
		cachedInstall = locateInstall(options.installPath ?? process.execPath, platform);
		return cachedInstall;
	}

	function quitApp(): unknown {
		if (options.quit) return options.quit();
		if (Bun.isMainThread) process.exit(0);
		// process.exit() inside a Bun Worker only ends the Worker; terminate the whole app.
		process.kill(process.pid, "SIGTERM");
	}

	function relaunchArgv(loc: InstallLocation, args: string[] = []): string[] {
		if (options.relaunchCommand) return [...options.relaunchCommand, ...args];
		if (loc.kind === "app-bundle") return ["/usr/bin/open", "-n", loc.target, ...(args.length ? ["--args", ...args] : [])];
		return [loc.target, ...args];
	}

	async function check(opts: { signal?: AbortSignal } = {}): Promise<UpdateInfo | null> {
		const url = options.manifestUrl.replaceAll("{channel}", encodeURIComponent(channel));
		let res: Response;
		try {
			res = await doFetch(url, { headers: { "cache-control": "no-cache" }, signal: opts.signal });
		} catch (err) {
			throw new UpdateError("manifest_fetch_failed", `cannot fetch ${url}: ${(err as Error).message}`, { cause: err });
		}
		if (!res.ok) throw new UpdateError("manifest_fetch_failed", `cannot fetch ${url}: HTTP ${res.status}`);
		const text = await res.text();
		if (text.length > MAX_MANIFEST_BYTES) throw new UpdateError("manifest_invalid", "update manifest is too large");

		// Nothing in the manifest is looked at before the signature is verified.
		const manifest = await parseSignedManifest(text, keys);
		if (manifest.name !== appName) {
			throw new UpdateError("name_mismatch", `manifest is for ${JSON.stringify(manifest.name)}, this app is ${JSON.stringify(appName)}`);
		}
		if (manifest.channel !== channel) {
			throw new UpdateError("channel_mismatch", `manifest is for channel ${JSON.stringify(manifest.channel)}, expected ${JSON.stringify(channel)}`);
		}
		// Strictly newer only: replaying an older signed manifest cannot downgrade.
		if (Bun.semver.order(manifest.version, currentVersion) <= 0) return null;

		const state = await readState(statePath);
		if (state?.phase === "rolled-back" && state.to === manifest.version) return null;

		const platformKey = platformKeyOf(platform, arch);
		const artifact = platformKey ? manifest.artifacts[platformKey] : undefined;
		if (!platformKey || !artifact) return null;

		const resolved = new URL(artifact.url, url);
		if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
			throw new UpdateError("manifest_invalid", `artifact url must be http(s): ${resolved.href}`);
		}
		// Delta patches (signed with the manifest): pick the one from our version.
		const patches = (manifest.patches as Record<string, Array<{ from: string; url: string; sha256: string; size: number }>> | undefined)?.[platformKey];
		const p = Array.isArray(patches) ? patches.find((x) => x?.from === currentVersion && typeof x.url === "string" && /^[0-9a-f]{64}$/.test(x.sha256) && Number.isSafeInteger(x.size)) : undefined;
		const patchUrl = p ? new URL(p.url, url) : null;
		return {
			version: manifest.version,
			currentVersion,
			channel,
			releasedAt: manifest.releasedAt,
			notes: manifest.notes,
			mandatory: manifest.minimumVersion ? Bun.semver.order(currentVersion, manifest.minimumVersion) < 0 : false,
			platformKey,
			artifact: { ...artifact, url: resolved.href },
			...(p && patchUrl && /^https?:$/.test(patchUrl.protocol) ? { patch: { ...p, url: patchUrl.href } } : {}),
			manifest,
		};
	}

	function planMoves(staged: Staged, loc: InstallLocation): Move[] {
		if (loc.kind === "app-bundle") {
			const apps = staged.entries.filter((e) => e.endsWith(".app"));
			if (apps.length !== 1 || staged.entries.length !== 1) {
				throw new UpdateError("layout_invalid", `macOS archive must contain exactly one top-level .app, found: ${staged.entries.join(", ") || "(nothing)"}`);
			}
			return [{ src: join(staged.payloadDir, apps[0]!), dest: loc.target, backup: `${loc.target}.old`, existed: true }];
		}
		const exe = basename(loc.target);
		let mapping: [string, string][];
		if (staged.entries.includes(exe)) {
			mapping = staged.entries.map((e) => [e, join(loc.dir, e)]);
		} else if (staged.entries.length === 1) {
			// Single-file archive: it is the executable, whatever the installed name (renamed exe, AppImage).
			mapping = [[staged.entries[0]!, loc.target]];
		} else {
			throw new UpdateError("layout_invalid", `archive must contain the executable ${JSON.stringify(exe)} at its top level, found: ${staged.entries.join(", ") || "(nothing)"}`);
		}
		return mapping.map(([entry, dest]) => ({ src: join(staged.payloadDir, entry), dest, backup: `${dest}.old`, existed: false }));
	}

	async function validatePayload(staged: Staged): Promise<void> {
		if (staged.entries.length === 0) throw new UpdateError("layout_invalid", "archive is empty");
		let loc: InstallLocation;
		try {
			loc = install();
		} catch {
			return; // Can't know the install layout (dev run); apply() will re-check.
		}
		const moves = planMoves(staged, loc);
		if (loc.kind === "app-bundle") {
			const app = moves[0]!.src;
			if (!(await exists(join(app, "Contents", "MacOS"))) || !(await exists(join(app, "Contents", "Info.plist")))) {
				throw new UpdateError("layout_invalid", `${basename(app)} is not an app bundle (missing Contents/MacOS or Contents/Info.plist)`);
			}
		}
	}

	async function download(info: UpdateInfo, opts: DownloadOptions = {}): Promise<Staged> {
		const stagingRoot = join(dataDir, "staging");
		const stagingDir = join(stagingRoot, info.version);
		await mkdir(stagingDir, { recursive: true });
		// Drop older staged versions.
		for (const name of await readdir(stagingRoot)) if (name !== info.version) await rmQuiet(join(stagingRoot, name));

		// Delta first (app bundles): rebuild the new .app from the installed one; any
		// failure (installed copy modified, bad patch, I/O) falls back to the full archive.
		if (info.patch) {
			try {
				const loc = install();
				if (loc.kind === "app-bundle") {
					const patchPath = join(stagingDir, "update.sdpatch");
					if (await hasVerifiedFile(patchPath, info.patch)) {
						opts.onProgress?.({ received: info.patch.size, total: info.patch.size, fraction: 1 });
					} else {
						await downloadVerified(info.patch.url, patchPath, info.patch, { fetch: doFetch, signal: opts.signal, onProgress: opts.onProgress });
					}
					const payloadDir = join(stagingDir, "payload");
					await rmQuiet(payloadDir);
					const { applyTreePatch } = await import("./delta.ts");
					const r = applyTreePatch(await Bun.file(patchPath).bytes(), loc.target, join(payloadDir, basename(loc.target)));
					const staged: Staged = { info, stagingDir, archivePath: patchPath, payloadDir, entries: [basename(loc.target)], delta: { files: r.files, bytes: info.patch.size } };
					await validatePayload(staged);
					return staged;
				}
			} catch (err) {
				if ((err as Error)?.name === "AbortError") throw err;
				// fall through to the full archive
			}
		}

		const archivePath = join(stagingDir, `update.${info.artifact.format}`);
		if (await hasVerifiedFile(archivePath, info.artifact)) {
			opts.onProgress?.({ received: info.artifact.size, total: info.artifact.size, fraction: 1 });
		} else {
			await downloadVerified(info.artifact.url, archivePath, info.artifact, { fetch: doFetch, signal: opts.signal, onProgress: opts.onProgress });
		}

		const payloadDir = join(stagingDir, "payload");
		await rmQuiet(payloadDir);
		await extractArchive(archivePath, info.artifact.format, payloadDir, platform);
		const entries = (await readdir(payloadDir)).filter((n) => n !== ".DS_Store" && !n.startsWith("._")).sort();
		const staged: Staged = { info, stagingDir, archivePath, payloadDir, entries };
		await validatePayload(staged);
		return staged;
	}

	async function assertWritable(dir: string): Promise<void> {
		if (dir.includes("/AppTranslocation/")) {
			throw new UpdateError("not_writable", "the app is running translocated (quarantined, read-only); move it to /Applications first");
		}
		const probe = join(dir, `.update-probe-${process.pid}-${Date.now()}`);
		try {
			await Bun.write(probe, "");
			await rm(probe, { force: true });
		} catch (err) {
			throw new UpdateError("not_writable", `install directory ${dir} is not writable by this user`, { cause: err });
		}
	}

	async function apply(staged: Staged, opts: ApplyOptions = {}): Promise<ApplyHandle> {
		const loc = install();
		const moves = planMoves(staged, loc);
		for (const m of moves) {
			if (!(await exists(m.src))) throw new UpdateError("layout_invalid", `staged file missing: ${m.src}`);
			m.existed = await exists(m.dest);
		}
		await assertWritable(loc.dir);
		await mkdir(dataDir, { recursive: true });

		const base = {
			from: currentVersion,
			to: staged.info.version,
			attempts: 0,
			platform,
			moves,
			stagingDir: staged.stagingDir,
			updatedAt: new Date().toISOString(),
		};
		const json = (s: UpdateState) => JSON.stringify(s);
		const plan: HelperPlan = {
			waitPid: opts.waitForPid ?? process.pid,
			waitTimeoutSec,
			moves,
			statePath,
			logPath,
			appliedJson: json({ ...base, phase: "applied" }),
			failedTimeoutJson: json({ ...base, phase: "failed", error: "timed out waiting for the app to exit" }),
			failedSwapJson: json({ ...base, phase: "failed", error: "swap failed; previous version restored (see helper.log)" }),
			relaunch: opts.relaunch ? relaunchArgv(loc, opts.relaunchArgs) : null,
			relaunchCwd: loc.dir,
		};
		const isWin = platform === "win32";
		const scriptPath = join(dataDir, isWin ? "apply-helper.ps1" : "apply-helper.sh");
		await Bun.write(scriptPath, isWin ? renderPs1Helper(plan) : renderShHelper(plan));
		if (!isWin) await chmod(scriptPath, 0o700);
		const command = helperCommand(platform, scriptPath);
		if (opts.dryRun) return { scriptPath, command, moves };

		// Must be written before spawning: the helper may finish before we get to run again.
		await writeState(statePath, { ...base, phase: "applying" });
		let proc;
		try {
			proc = Bun.spawn(command, { detached: true, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
		} catch (err) {
			await clearState(statePath);
			throw new UpdateError("helper_failed", `cannot start update helper: ${(err as Error).message}`, { cause: err });
		}
		proc.unref();
		const handle: ApplyHandle = { scriptPath, command, moves, pid: proc.pid, exited: proc.exited };
		if (opts.quit !== false) await quitApp();
		return handle;
	}

	async function restoreBackups(moves: Move[]): Promise<boolean> {
		for (const m of moves) if (m.existed && !(await exists(m.backup))) return false;
		for (const m of [...moves].reverse()) {
			const bad = `${m.dest}.bad`;
			await rmQuiet(bad);
			// Rename rather than delete: works for a running exe on Windows too.
			if (await exists(m.dest)) await rename(m.dest, bad);
			if (await exists(m.backup)) await rename(m.backup, m.dest);
			await rmQuiet(bad);
		}
		return true;
	}

	async function cleanupLeftovers(moves: Move[], backups: boolean): Promise<void> {
		for (const m of moves) {
			await rmQuiet(`${m.dest}.bad`);
			if (backups) await rmQuiet(m.backup);
		}
	}

	async function rollbackIfNeeded(): Promise<boolean> {
		const state = await readState(statePath);
		if (!state) return false;
		if (state.phase === "applying") {
			const age = Date.now() - Date.parse(state.updatedAt);
			if (!(age > (waitTimeoutSec + 60) * 1000)) return false; // helper may still be running
			// Helper died mid-swap: put back anything that went missing.
			for (const m of state.moves) {
				if (!(await exists(m.dest)) && (await exists(m.backup))) await rename(m.backup, m.dest);
			}
			await writeState(statePath, { ...state, phase: "failed", error: "update helper did not finish", updatedAt: new Date().toISOString() });
			return false;
		}
		if (state.phase === "failed" || state.phase === "rolled-back") {
			await cleanupLeftovers(state.moves, false);
			return false;
		}
		// phase === "applied"
		if (state.to !== currentVersion) return false;
		const attempts = state.attempts + 1;
		if (attempts < maxAttempts) {
			await writeState(statePath, { ...state, attempts, updatedAt: new Date().toISOString() });
			return false;
		}
		const restored = await restoreBackups(state.moves);
		await writeState(statePath, {
			...state,
			attempts,
			phase: restored ? "rolled-back" : "failed",
			error: restored
				? `${state.to} did not confirm a healthy start after ${attempts} launches; restored ${state.from}`
				: `${state.to} is unhealthy but no backup of ${state.from} was found`,
			updatedAt: new Date().toISOString(),
		});
		return restored;
	}

	async function confirm(): Promise<void> {
		const state = await readState(statePath);
		if (!state) return;
		if (state.phase === "applied" && state.to === currentVersion) {
			await cleanupLeftovers(state.moves, true);
			await rmQuiet(state.stagingDir);
			await rmQuiet(join(dataDir, "apply-helper.sh"));
			await rmQuiet(join(dataDir, "apply-helper.ps1"));
			await clearState(statePath);
		} else if (state.phase === "rolled-back" || state.phase === "failed") {
			// Running the previous version healthily. Keep a rolled-back state so check() skips that version.
			await cleanupLeftovers(state.moves, false);
			await rmQuiet(state.stagingDir);
			if (state.phase === "failed") await clearState(statePath);
		}
	}

	async function restart(opts: { quit?: boolean; args?: string[]; waitForPid?: number } = {}): Promise<void> {
		const loc = install();
		const argv = relaunchArgv(loc, opts.args);
		const pid = opts.waitForPid ?? process.pid;
		const command =
			platform === "win32"
				? [
						helperCommand("win32", "")[0]!,
						"-NoProfile",
						"-NonInteractive",
						"-WindowStyle",
						"Hidden",
						"-Command",
						`while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 100 }; Start-Process -FilePath ${psQuote(argv[0]!)}${argv.length > 1 ? ` -ArgumentList @(${argv.slice(1).map(psQuote).join(", ")})` : ""}`,
					]
				: ["/bin/sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 0.1; done; ${argv.map(shQuote).join(" ")} >/dev/null 2>&1 &`];
		const proc = Bun.spawn(command, { detached: true, stdio: ["ignore", "ignore", "ignore"], windowsHide: true, cwd: loc.dir });
		proc.unref();
		if (opts.quit !== false) await quitApp();
	}

	return {
		dataDir,
		channel,
		check,
		download,
		apply,
		confirm,
		rollbackIfNeeded,
		status: () => readState(statePath),
		restart,
		install,
	};
}

export { canonicalize, signManifest, verifyManifestSignature, parseSignedManifest, validateManifest, SIGNATURE_CONTEXT } from "./manifest.ts";
export { defaultDataDir, locateInstall, platformKeyOf } from "./platform.ts";
export { createArchive, extractArchive } from "./archive.ts";
