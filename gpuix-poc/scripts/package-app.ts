/**
 * package-app.ts — assemble a .app bundle around a `bun build --compile` binary.
 * `bun scripts/package-app.ts <entry.ts> <AppName> <bundleId>`
 * Verified 2026-09-15: embedded .node extracts once (content-cache), so later
 * launches pay ~0 extraction tax; `open App.app` registers LaunchServices
 * (dock presence, URL schemes, document types).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const [entry, name = 'MissionDemo', bundleId = 'dev.svelte-desktop.mission-demo'] =
	process.argv.slice(2);
if (!entry) {
	console.error('usage: bun scripts/package-app.ts <entry.ts> [AppName] [bundleId]');
	process.exit(1);
}

const out = `build/${name}.app`;
const contents = join(out, 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(contents, 'Resources'), { recursive: true });
mkdirSync(join(contents, 'Frameworks'), { recursive: true });

const bin = await Bun.$`bun build --compile ${entry} --outfile ${join(contents, 'MacOS', name)}`.quiet();
if (bin.exitCode !== 0) { console.error(bin.stderr.toString()); process.exit(1); }

writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>CFBundleIdentifier</key><string>${bundleId}</string>
	<key>CFBundleName</key><string>${name}</string>
	<key>CFBundleDisplayName</key><string>${name}</string>
	<key>CFBundleVersion</key><string>0.2.0</string>
	<key>CFBundleShortVersionString</key><string>0.2.0</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>${name}</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
	<key>CFBundleURLTypes</key>
	<array><dict>
		<key>CFBundleURLSchemes</key><array><string>${name.toLowerCase()}</string></array>
	</dict></array>
</dict></plist>
`);

const size = (await Bun.file(join(contents, 'MacOS', name)).size) / 1048576;
console.log(`${out}  (${size.toFixed(1)} MiB binary) — open ${out} to launch via LaunchServices`);
