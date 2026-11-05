/**
 * End-to-end: emitEntry + vite build (SSR) + execute the bundle on
 * TestGpuixRenderer and assert painted text.
 *
 * Requires @gpuix/native resolvable from the fixture app (a node_modules
 * symlink into packages/gpuix's copy is created when missing) — and a renderer
 * binary new enough for the `setClass`/`stylesheet.register` ops (the owned
 * native/ build; the npm 0.8.0 binary predates them — see README).
 */
import { test, expect } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeApp } from '../emit.js';
import { PACKAGES, SVELTE_PKG } from '../paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'app');

// the fixture needs svelte + @svelte-desktop/platform resolvable — symlink
// the sibling packages' copies when the fixture has none of its own
// (@gpuix/native is self-hosted here: GPUIX_NATIVE points at this fixture's
// node_modules). lstatSync detects a broken symlink existsSync would miss;
// a stale link gets replaced.
for (const [dir, target] of [
	['svelte', join(SVELTE_PKG, 'node_modules/svelte')],
	['@svelte-desktop/platform', join(PACKAGES, 'platform')],
]) {
	const p = join(appRoot, 'node_modules', dir);
	let stat = null;
	try {
		stat = lstatSync(p);
	} catch {}
	if (stat && existsSync(p)) continue; // present and resolves
	if (!existsSync(target)) continue;
	mkdirSync(dirname(p), { recursive: true });
	if (stat) rmSync(p, { force: true }); // broken/stale link
	symlinkSync(target, p);
}

test('build + headless run paints the route tree', async () => {
	const { bundlePath } = await buildNativeApp({
		root: appRoot,
		rendererClass: 'TestGpuixRenderer',
		headless: true,
		title: 'fixture',
		width: 800,
		height: 600,
		vite: { logLevel: 'warn' },
	});
	expect(existsSync(bundlePath)).toBe(true);

	const proc = Bun.spawn(['bun', bundlePath], { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;

	expect(out).toContain('[svelte-native painted]');
	// +layout.ts load → +page.ts parent() chain → $app/state page.url
	expect(out).toContain('hello fixture');
	expect(out).toContain('(/)');
	// child component + dynamic content rendered
	expect(out).toContain('card 0');
}, 60_000);
