// Native materials declared in CSS (--desktop-material), on the built app (`bun run build` first):
// the Native page's card puts one on the title bar and the sidebar; an element of the page's own
// gets one too. The shell draws them behind the web view — what a test can see is the page side:
// html[data-desktop-materials], and [data-desktop-material-on] on what's drawn right now.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true, env: { VITE_TABS_SPLIT: '0' } } : {});
	await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
});
afterAll(() => app?.close());

const click = (label: string) => app.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(), true`);

test('the native op: vibrancy and glass regions, an unknown material refused', async () => {
	expect(await app.eval(`document.documentElement.hasAttribute('data-desktop-materials')`)).toBe(true);
	const regions = [
		{ id: 1, material: 'hud', x: 10, y: 10, width: 100, height: 50, radius: 8 },
		{ id: 2, material: 'glass-clear', x: 10, y: 100, width: 100, height: 50, radius: 12, tint: '#5f62ef4d' }
	];
	expect(await app.platform('window', 'setMaterialRegions', { regions })).toBeNull();
	const bad = (await app.platform('window', 'setMaterialRegions', { regions: [{ id: 3, material: 'nope', x: 0, y: 0, width: 1, height: 1 }] }).catch((e: unknown) => e)) as { code: string };
	expect(bad.code).toBe('invalid_args');
	expect(await app.platform('window', 'setMaterialRegions', { regions: [] })).toBeNull();
});

test('the Native page: the title bar and the sidebar take the material, not their children', async () => {
	await app.goto('/native');
	await app.waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Sidebar'), { timeout: 10_000 });
	await click('Sidebar');
	await app.waitFor(() => !!document.querySelector('.titlebar[data-desktop-material-on]'), { timeout: 5000 });
	const info = await app.eval<{ titlebar: string; child: string; drawn: number; bg: string }>(`(() => {
		const t = document.querySelector('.titlebar');
		return {
			titlebar: getComputedStyle(t).getPropertyValue('--desktop-material').trim(),
			child: getComputedStyle(t.firstElementChild).getPropertyValue('--desktop-material').trim(),
			drawn: document.querySelectorAll('[data-desktop-material-on]').length,
			bg: getComputedStyle(t).backgroundColor,
		};
	})()`);
	expect(info).toEqual({ titlebar: 'sidebar', child: '', drawn: 2, bg: 'oklab(0 0 0 / 0)' });
	await click('Regular');
	await app.waitFor(() => getComputedStyle(document.querySelector('.titlebar')!).getPropertyValue('--desktop-material').trim() === 'glass', { timeout: 5000 });
	await click('Off');
	await app.waitFor(() => !document.querySelector('[data-desktop-material-on]'), { timeout: 5000 });
});

test('an element of the page: declared inline, drawn while it is there', async () => {
	await app.eval(`(() => {
		const d = document.createElement('div');
		d.id = 'material-probe';
		d.style.cssText = 'position:fixed;left:40px;top:300px;width:200px;height:120px;border-radius:16px;--desktop-material:glass-clear;--desktop-material-tint:oklch(60% 0.2 280 / 30%)';
		document.body.append(d);
		return true;
	})()`);
	await app.waitFor(() => !!document.querySelector('#material-probe[data-desktop-material-on]'), { timeout: 5000 });
	await app.eval(`document.querySelector('#material-probe').remove(), true`);
	await app.waitFor(() => !document.querySelector('[data-desktop-material-on]'), { timeout: 5000 });
});
