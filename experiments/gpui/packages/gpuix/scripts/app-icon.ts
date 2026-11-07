#!/usr/bin/env bun
/**
 * app-icon.ts — the .app icon pipeline, gpuix-style. Library for the bundler
 * plus the `svelte-native-icon` CLI (import.meta.main block at the bottom):
 *
 *   svelte-native-icon icon.png                 → ./icon.icns
 *   svelte-native-icon icon.png -o AppIcon.icns
 *   svelte-native-icon App.iconset/             → ./App.icns
 *   svelte-native-icon AppIcon.icns -o out.icns (verbatim copy)
 *
 * Three accepted inputs, one output — the bundler variant writes
 * `AppIcon.icns` into Contents/Resources and emits CFBundleIconFile:
 *
 *   --icon AppIcon.icns    → copied verbatim
 *   --icon App.iconset/    → iconutil -c icns
 *   --icon icon.png        → sips generates the full 10-slot .iconset,
 *                            iconutil compiles it — the common case: drop a
 *                            1024×1024 png in and get a real icns out.
 *
 * Convention: with no --icon, the app dir is probed for `icon.icns`,
 * `icon.iconset`, `icon.png` (in that order) — drop the file in, rebuild,
 * done. Explicit --icon wins; pass --no-icon to opt out of discovery.
 */
import { existsSync, statSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from 'fs';
import { join, basename, extname, resolve } from 'path';
import { tmpdir } from 'os';

/** Apple's .iconset slots — (filename, pixel size). */
export const ICONSET_SLOTS: [string, number][] = [
	['icon_16x16.png', 16],
	['icon_16x16@2x.png', 32],
	['icon_32x32.png', 32],
	['icon_32x32@2x.png', 64],
	['icon_128x128.png', 128],
	['icon_128x128@2x.png', 256],
	['icon_256x256.png', 256],
	['icon_256x256@2x.png', 512],
	['icon_512x512.png', 512],
	['icon_512x512@2x.png', 1024],
];

const DISCOVERY = ['icon.icns', 'icon.iconset', 'icon.png'];

export interface AppIcon {
	/** file name inside Contents/Resources — the CFBundleIconFile value minus .icns */
	icnsName: string;
	icnsPath: string;
	origin: string; // for the build log — flag value or discovered file
}

/** probe the app dir for the conventional icon files, flag order = priority */
export function discoverIcon(cwd: string): string | null {
	for (const f of DISCOVERY) {
		const p = join(cwd, f);
		if (existsSync(p)) return p;
	}
	return null;
}

async function sips(...args: string[]) {
	const r = await Bun.$`sips ${args}`.quiet();
	if (r.exitCode !== 0) throw new Error(`sips ${args[0]} failed: ${r.stderr.toString().trim()}`);
	return r.stdout.toString();
}

async function pngSize(path: string): Promise<number> {
	const out = await sips('-g', 'pixelWidth', path);
	return parseInt(out.trim().split(/\s+/).pop() ?? '0', 10) || 0;
}

/** png → full .iconset via sips, then iconutil → dest .icns */
async function buildIcnsFromPng(png: string, dest: string) {
	const srcW = await pngSize(png);
	if (srcW > 0 && srcW < 1024)
		console.warn(`[icon] ${basename(png)} is ${srcW}px — 1024px source recommended, 512px+ slots will be upscaled`);
	const dir = mkdtempSync(join(tmpdir(), 'appicon-'));
	try {
		const iconset = join(dir, 'App.iconset');
		mkdirSync(iconset);
		for (const [file, px] of ICONSET_SLOTS)
			await sips('-z', String(px), String(px), png, '--out', join(iconset, file));
		const r = await Bun.$`iconutil -c icns ${iconset} -o ${dest}`.quiet();
		if (r.exitCode !== 0) throw new Error(`iconutil failed: ${r.stderr.toString().trim()}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** any accepted input → a compiled .icns at `dest` */
export async function buildAppIconIcns(src: string, dest: string): Promise<void> {
	const ext = extname(src).toLowerCase();
	if (ext === '.icns') {
		copyFileSync(src, dest);
	} else if (ext === '.iconset' && statSync(src).isDirectory()) {
		const r = await Bun.$`iconutil -c icns ${src} -o ${dest}`.quiet();
		if (r.exitCode !== 0) throw new Error(`iconutil failed on ${basename(src)}: ${r.stderr.toString().trim()}`);
	} else if (ext === '.png') {
		await buildIcnsFromPng(src, dest);
	} else {
		throw new Error(`icon must be .icns, .iconset/, or .png — got '${basename(src)}'`);
	}
}

/**
 * Resolve + materialize the icon into `resourcesDir`. Returns null when no
 * icon is configured (discovery found nothing) — the bundle stays iconless,
 * LaunchServices shows the generic app icon.
 */
export async function resolveAppIcon(
	arg: string | null | false, // --icon value, null = not passed, false = --no-icon
	resourcesDir: string,
	cwd = process.cwd(),
): Promise<AppIcon | null> {
	let src = arg || null;
	if (arg === false) return null;
	if (!src) {
		src = discoverIcon(cwd);
		if (!src) return null;
	}
	src = resolve(src);
	if (!existsSync(src)) throw new Error(`--icon '${arg ?? src}' does not exist`);

	const dest = join(resourcesDir, 'AppIcon.icns');
	await buildAppIconIcns(src, dest);
	return { icnsName: 'AppIcon', icnsPath: dest, origin: src };
}

// ── svelte-native-icon CLI ───────────────────────────────────────────────────

if (import.meta.main) {
	const argv = process.argv.slice(2);
	let src: string | null = null;
	let out: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-o' || a === '--out') out = argv[++i];
		else src = a;
	}
	if (!src) {
		console.error('usage: svelte-native-icon <icon.png|icon.iconset|icon.icns> [-o out.icns]');
		process.exit(1);
	}
	src = resolve(src);
	if (!existsSync(src)) {
		console.error(`svelte-native-icon: '${src}' does not exist`);
		process.exit(1);
	}
	out = resolve(out ?? basename(src, extname(src)) + '.icns');
	try {
		await buildAppIconIcns(src, out);
	} catch (e) {
		console.error(`svelte-native-icon: ${e instanceof Error ? e.message : e}`);
		process.exit(1);
	}
	console.log(`${src} → ${out}`);
}
