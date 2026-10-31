// The iOS app in offline mode (ios.offline): the client build, prerendered pages and an
// SPA fallback bundled into the app, served from app://localhost — no server at all.
//   SVELTE_DESKTOP_TARGET=ios SVELTE_DESKTOP_IOS_OFFLINE=1 bunx --bun vite build && bun run test:ios-offline
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

describe.skipIf(!process.env.IOS_OFFLINE_E2E)('ios offline', () => {
	let app: AppHandle;
	beforeAll(async () => {
		app = await launch({ ios: { udid: process.env.IOS_UDID }, timeout: 60_000 });
	});
	afterAll(() => app?.close());

	test('served from the bundle, no server', async () => {
		expect(await app.eval<string>('location.origin')).toBe('app://localhost');
		expect(await app.platform('app', 'getInfo')).toMatchObject({ platform: 'ios', offline: true });
	});

	test('a prerendered page loads from the bundle', async () => {
		await app.eval(`location.href = 'app://localhost/about'`);
		await Bun.sleep(500);
		await app.waitFor(() => document.body.innerText.includes('prerendered at build time'), { timeout: 10_000 });
		expect(await app.text('h1')).toBe('About (prerendered)');
	});

	test('the SvelteKit client router runs (SPA fallback → client navigation)', async () => {
		await app.waitFor(() => document.documentElement.hasAttribute('data-desktop-hydrated'), { timeout: 10_000 });
		await app.goto('/about');
		expect(await app.eval<string>('location.pathname')).toBe('/about');
	});

	test('the page bridge and the Swift plugin work offline', async () => {
		expect(await app.platform<number>('device', 'multiply', { a: 3, b: 4 })).toBe(12);
		const pong = app.nextEvent<{ at: number }>('device.pong');
		await app.platform('device', 'ping');
		expect((await pong).at).toBeGreaterThan(0);
		// A round trip from the page itself: its bus → window.__shell → host → platformResult.
		const fromPage = await app.eval<string>(`new Promise((done, fail) => {
			const S = globalThis[Symbol.for('svelte-desktop.bus')];
			if (!S?.backend) return fail(new Error('no platform bus in the page'));
			const id = S.nextCallId++;
			S.pending.set(id, { resolve: done, reject: fail });
			S.backend.platformCall(JSON.stringify({ id, service: 'app', op: 'getName', args: {} }));
		})`);
		expect(fromPage).toBe('Svelte Notes');
	});
});
