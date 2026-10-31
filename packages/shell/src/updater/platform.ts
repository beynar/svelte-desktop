import { basename, join, posix, win32 } from "node:path";
import { homedir } from "node:os";
import type { Arch, OS, PlatformKey } from "./manifest.ts";
import { UpdateError } from "./errors.ts";

export function osOf(platform: string): OS | null {
	if (platform === "darwin") return "darwin";
	if (platform === "linux") return "linux";
	if (platform === "win32" || platform === "windows") return "windows";
	return null;
}

export function platformKeyOf(platform: string, arch: string): PlatformKey | null {
	const os = osOf(platform);
	const a: Arch | null = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
	return os && a ? `${os}-${a}` : null;
}

/** Per-OS default directory for staged updates and updater state. */
export function defaultDataDir(
	appName: string,
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	if (!appName || /[\\/:*?"<>|\0]/.test(appName) || appName.startsWith(".")) {
		throw new UpdateError("config_invalid", `appName ${JSON.stringify(appName)} cannot be used as a directory name`);
	}
	const os = osOf(platform);
	if (os === "darwin") return join(home, "Library", "Application Support", appName, "updates");
	if (os === "windows") {
		const base = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
		return win32.join(base, appName, "updates");
	}
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), appName, "updates");
}

export interface InstallLocation {
	/** "app-bundle": swap the whole .app (macOS). "executable": swap files in `dir`. */
	kind: "app-bundle" | "executable";
	/** The .app directory, or the executable file. */
	target: string;
	/** Directory containing `target`; must be writable. */
	dir: string;
}

/** True when running from a `bun build --compile` executable rather than `bun file.ts`. */
export function isCompiledBinary(): boolean {
	const main = typeof Bun !== "undefined" ? Bun.main : "";
	return main.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(main);
}

/**
 * Locate the installed app from an executable path.
 * macOS: the outermost enclosing `*.app` bundle (Contents/MacOS/<exe> -> <App>.app).
 * Linux: $APPIMAGE when running from an AppImage, else the executable.
 * Windows: the executable.
 */
export function locateInstall(
	execPath: string,
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): InstallLocation {
	const os = osOf(platform);
	const path = os === "windows" ? win32 : posix;
	const { dirname } = path;
	const p = path.resolve(execPath);
	if (os === "darwin") {
		const parts = p.split("/");
		const idx = parts.findIndex((seg) => seg.endsWith(".app"));
		if (idx > 0) {
			const target = parts.slice(0, idx + 1).join("/");
			return { kind: "app-bundle", target, dir: dirname(target) };
		}
		// Not inside a bundle (bare binary distribution): fall through and swap the file.
	}
	if (os === "linux" && env.APPIMAGE) {
		const target = path.resolve(env.APPIMAGE);
		return { kind: "executable", target, dir: dirname(target) };
	}
	return { kind: "executable", target: p, dir: dirname(p) };
}

export function exeBasename(loc: InstallLocation): string {
	return basename(loc.target);
}
