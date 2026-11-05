#!/usr/bin/env bun
/**
 * package-app.ts — assemble a .app bundle around a `bun build --compile` binary.
 * Exported as the `svelte-native-package` CLI:
 *
 *   svelte-native-package <entry.ts|entry.js> [AppName] [bundleId]
 *       [--out-dir <dir>] [--external <spec>] [--usage <name>=<reason>]
 *       [--icon <path>] [--no-icon]
 *
 * `--out-dir`  — parent dir for <AppName>.app (default `build`, relative to cwd).
 * `--external` — repeatable; forwarded to `bun build --compile`. Needed for
 *                napi loaders whose optional platform-package fallbacks
 *                (`require('@gpuix/native-darwin-arm64')` etc.) aren't
 *                installed next to the pinned loader — the sibling `.node`
 *                require wins at runtime, so the external stays dead code.
 * `--icon`     — app icon: .icns (copied), .iconset/ (iconutil), or .png
 *                (sips builds the full iconset, iconutil compiles it).
 *                With no flag, the cwd is probed for icon.icns/icon.iconset/
 *                icon.png — drop the file next to package.json, done.
 *                `--no-icon` opts out of discovery. Resolved icons land at
 *                Contents/Resources/AppIcon.icns + CFBundleIconFile.
 * `--usage`    — repeatable; declares a TCC usage description in Info.plist.
 *                `camera`/`microphone` map to NS{Camera,Microphone}Usage-
 *                Description; any other `NS*UsageDescription` key passes
 *                through verbatim. Without the key, `system.requestPermission`
 *                returns `unavailable` (the unguarded AVFoundation call would
 *                abort the process — TCC requires the declaration up front).
 *
 * Verified 2026-09-15: embedded .node extracts once (content-cache), so later
 * launches pay ~0 extraction tax; `open App.app` registers LaunchServices
 * (dock presence, URL schemes, document types).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveAppIcon } from './app-icon.ts';

const argv = process.argv.slice(2);
const externals: string[] = [];
const usages: [string, string][] = [];
let outDir = 'build';
let iconArg: string | null | false = null; // null=discover, false=--no-icon
const positional: string[] = [];

// Friendly names → Info.plist keys; any other `NS*UsageDescription` key
// passes through for domains the list omits (protected folders, contacts…).
const USAGE_KEYS: Record<string, string> = {
	camera: 'NSCameraUsageDescription',
	microphone: 'NSMicrophoneUsageDescription',
};

function parseUsage(spec: string): [string, string] {
	const eq = spec.indexOf('=');
	const name = eq < 0 ? spec : spec.slice(0, eq);
	const text = eq < 0 ? '' : spec.slice(eq + 1);
	const key = USAGE_KEYS[name] ?? (/^NS[A-Za-z]+UsageDescription$/.test(name) ? name : '');
	if (!key || !text) {
		console.error(
			`bad --usage '${spec}' — expected camera|microphone|NS*UsageDescription=<reason>`,
		);
		process.exit(1);
	}
	return [key, text];
}

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--out-dir') outDir = argv[++i];
	else if (a === '--external') externals.push(argv[++i]);
	else if (a === '--usage') usages.push(parseUsage(argv[++i]));
	else if (a === '--icon') iconArg = argv[++i];
	else if (a === '--no-icon') iconArg = false;
	else positional.push(a);
}

const [entry, name = 'MissionDemo', bundleId = 'dev.svelte-desktop.mission-demo'] =
	positional;
if (!entry) {
	console.error(
		'usage: svelte-native-package <entry> [AppName] [bundleId] [--out-dir dir] [--external spec] [--icon path|--no-icon] [--usage name=reason]',
	);
	process.exit(1);
}

const out = join(outDir, `${name}.app`);
const contents = join(out, 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(contents, 'Resources'), { recursive: true });
mkdirSync(join(contents, 'Frameworks'), { recursive: true });

const bin = await Bun.$`bun build --compile ${entry} ${externals.flatMap((e) => ['--external', e])} --outfile ${join(contents, 'MacOS', name)}`.quiet();
if (bin.exitCode !== 0) { console.error(bin.stderr.toString()); process.exit(1); }

const icon = await resolveAppIcon(iconArg, join(contents, 'Resources'));
if (icon) console.log(`[icon] ${icon.origin} → ${icon.icnsName}.icns`);

// plist strings must escape & < > — an unescaped reason makes the whole
// plist unparseable, which silently drops the bundle identity (and with it
// notifications, TCC records, deep links — everything keyed on it).
const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>CFBundleIdentifier</key><string>${esc(bundleId)}</string>
	<key>CFBundleName</key><string>${esc(name)}</string>
	<key>CFBundleDisplayName</key><string>${esc(name)}</string>
	<key>CFBundleVersion</key><string>0.2.0</string>
	<key>CFBundleShortVersionString</key><string>0.2.0</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>${esc(name)}</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
${icon ? `\t<key>CFBundleIconFile</key><string>${esc(icon.icnsName)}</string>\n` : ''}
	<key>CFBundleURLTypes</key>
	<array><dict>
		<key>CFBundleURLSchemes</key><array><string>${esc(name.toLowerCase())}</string></array>
	</dict></array>
${usages.map(([key, text]) => `\t<key>${key}</key><string>${esc(text)}</string>`).join('\n')}
</dict></plist>
`);

const size = (await Bun.file(join(contents, 'MacOS', name)).size) / 1048576;
console.log(`${out}  (${size.toFixed(1)} MiB binary) — open ${out} to launch via LaunchServices`);
