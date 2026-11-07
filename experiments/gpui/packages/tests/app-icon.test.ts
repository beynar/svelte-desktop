// app-icon — the .app icon pipeline: png/iconset/icns inputs → AppIcon.icns,
// cwd discovery, --no-icon. Uses the real toolchain (sips + iconutil) — these
// are macOS built-ins; the suite only runs where packaging runs.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveAppIcon, discoverIcon, ICONSET_SLOTS } from '@svelte-desktop/gpuix/scripts/app-icon.ts';

const SEED_PNG = join(import.meta.dir, '../../app/src/lib/assets/tray.png'); // 18×18 — small source also exercises the upscale warn

const tmp = () => mkdtempSync(join(tmpdir(), 'appicon-test-'));
const resDir = (dir: string) => {
	const r = join(dir, 'Resources');
	mkdirSync(r, { recursive: true });
	return r;
};

/** iconutil -c iconset — read an icns back into its slot files */
async function icnsSlots(icns: string, dir: string): Promise<string[]> {
	const out = join(dir, 'read.iconset');
	const r = await Bun.$`iconutil -c iconset ${icns} -o ${out}`.quiet();
	expect(r.exitCode).toBe(0);
	return readdirSync(out).sort();
}

test('png → AppIcon.icns with all 10 representations', async () => {
	const dir = tmp();
	const icon = await resolveAppIcon(SEED_PNG, resDir(dir));
	expect(icon).not.toBeNull();
	expect(icon!.icnsName).toBe('AppIcon');
	expect(existsSync(icon!.icnsPath)).toBe(true);
	// icns files carry the 'icns' magic — and roundtrip to the full slot set
	expect(statSync(icon!.icnsPath).size).toBeGreaterThan(0);
	expect(await icnsSlots(icon!.icnsPath, dir)).toEqual(ICONSET_SLOTS.map((s) => s[0]).sort());
});

test('.icns copies verbatim', async () => {
	const dir = tmp();
	// bootstrap a real icns through the png path, then feed it back as input
	const first = await resolveAppIcon(SEED_PNG, resDir(join(dir, 'a')));
	const icon = await resolveAppIcon(first!.icnsPath, resDir(join(dir, 'b')));
	const a = await Bun.file(first!.icnsPath).arrayBuffer();
	const b = await Bun.file(icon!.icnsPath).arrayBuffer();
	expect(new Uint8Array(b)).toEqual(new Uint8Array(a));
});

test('.iconset dir compiles via iconutil', async () => {
	const dir = tmp();
	const first = await resolveAppIcon(SEED_PNG, resDir(join(dir, 'a')));
	// turn the icns back into an on-disk .iconset, feed the dir as input
	const iconset = join(dir, 'App.iconset');
	const r = await Bun.$`iconutil -c iconset ${first!.icnsPath} -o ${iconset}`.quiet();
	expect(r.exitCode).toBe(0);
	const icon = await resolveAppIcon(iconset, resDir(join(dir, 'b')));
	expect(existsSync(icon!.icnsPath)).toBe(true);
});

test('discovery: icon.icns > icon.iconset > icon.png', async () => {
	const dir = tmp();
	writeFileSync(join(dir, 'icon.png'), await Bun.file(SEED_PNG).arrayBuffer());
	expect(discoverIcon(dir)).toBe(join(dir, 'icon.png'));
	mkdirSync(join(dir, 'icon.iconset'));
	expect(discoverIcon(dir)).toBe(join(dir, 'icon.iconset'));
	writeFileSync(join(dir, 'icon.icns'), 'x');
	expect(discoverIcon(dir)).toBe(join(dir, 'icon.icns'));
});

test('discovery picked up by resolveAppIcon when no --icon', async () => {
	const dir = tmp();
	writeFileSync(join(dir, 'icon.png'), await Bun.file(SEED_PNG).arrayBuffer());
	const icon = await resolveAppIcon(null, resDir(dir), dir);
	expect(icon!.origin).toBe(join(dir, 'icon.png'));
});

test('no icon configured → null, nothing written', async () => {
	const dir = tmp();
	const res = resDir(dir);
	expect(await resolveAppIcon(null, res, dir)).toBeNull();
	expect(readdirSync(res)).toEqual([]);
});

test('--no-icon wins over discovery', async () => {
	const dir = tmp();
	writeFileSync(join(dir, 'icon.png'), await Bun.file(SEED_PNG).arrayBuffer());
	expect(await resolveAppIcon(false, resDir(dir), dir)).toBeNull();
});

test('bad inputs throw', async () => {
	const dir = tmp();
	writeFileSync(join(dir, 'icon.gif'), 'GIF89a');
	await expect(resolveAppIcon(join(dir, 'icon.gif'), resDir(dir))).rejects.toThrow('must be .icns, .iconset/, or .png');
	await expect(resolveAppIcon(join(dir, 'missing.png'), resDir(dir))).rejects.toThrow('does not exist');
});
