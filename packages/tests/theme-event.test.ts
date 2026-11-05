/**
 * theme-event.test.ts — Theme.svelte's event-driven system appearance.
 *
 * Mounts the compiled <Theme> against a fake renderer that records the op
 * stream and answers platformCall (GpuixRenderer-shaped). Verifies:
 *   - deferCall reaches platformCall: `theme.get` is the initial read that
 *     covers an appearanceChanged emitted before the subscription, and
 *     `system.getAccessibility` seeds osReduced — both instead of spawnSync.
 *   - `platform:appearanceChanged` payloads ({appearance, dark}) drive
 *     ThemeState.system via gdom's onPlatformEvent tap.
 *   - once the first event lands the spawnSync fallback poll is retired:
 *     an event value that contradicts the real macOS pref must stick.
 *
 * The macOS-only poll-retirement asserts branch on the real `defaults read`
 * value so they stay meaningful on both light and dark hosts; on non-darwin
 * (spawnSync unavailable) the event-delivery asserts still run.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import {
	installGlobals,
	doc,
	dispatchPayload,
	materializeRoot,
	PLATFORM_EVENT_ID,
} from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';

installGlobals();

const ops: unknown[][] = [];
const platformRequests: { service: string; op: string }[] = [];
/** theme.get answers with the OPPOSITE of the real pref so an applied read is
 *  distinguishable from the spawnSync baseline. */
let realDark: boolean | null = null;
try {
	if (process.platform === 'darwin') {
		realDark = Bun.spawnSync(['defaults', 'read', '-g', 'AppleInterfaceStyle']).exitCode === 0;
	}
} catch {
	realDark = null; // no defaults binary / not macOS
}

setRenderer({
	applyBatch: (json: string) => {
		ops.push(...(JSON.parse(json) as unknown[][]));
		return [];
	},
	platformCall: (req: string) => {
		const r = JSON.parse(req) as { service: string; op: string };
		platformRequests.push(r);
		if (r.service === 'theme' && r.op === 'get') {
			return JSON.stringify({ ok: true, value: { appearance: realDark === false ? 'dark' : 'light', dark: realDark === false } });
		}
		if (r.service === 'system' && r.op === 'getAccessibility') {
			return JSON.stringify({ ok: true, value: { reduceMotion: true } });
		}
		return JSON.stringify({ ok: true, value: null });
	},
} as never);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const appearance = (dark: boolean) =>
	dispatchPayload({
		elementId: PLATFORM_EVENT_ID,
		eventType: 'platform:appearanceChanged',
		data: { appearance: dark ? 'dark' : 'light', dark },
	} as never);

let themeState: () => { system: string; resolvedTheme: string; osReduced: boolean; preferReducesMotion: boolean };
let mount: (c: unknown, o: { target: unknown; props?: Record<string, unknown> }) => unknown;
let unmount: (a: unknown) => void;
let Theme: unknown;
let ThemeFn: unknown;
let ThemeNested: unknown;

beforeAll(async () => {
	({ themeState } = await import('@svelte-desktop/gpuix/gen/nkit/theming.js'));
	({ mount, unmount } = await import('@svelte-desktop/svelte/svelte-client.js'));
	Theme = (await import('@svelte-desktop/gpuix/gen/nkit/Theme.js')).default;
	ThemeFn = (await import('./gen/cases/themefn.js')).default;
	ThemeNested = (await import('./gen/cases/themenested.js')).default;
});

async function mountTheme() {
	const target = doc.createElement('div');
	doc.body.appendChild(target);
	materializeRoot(target);
	// unique storageKey — a real ~/.config/nkit/theme.json may exist on this
	// machine and would restore over defaultTheme='system'
	const app = mount(Theme, { target, props: { defaultTheme: 'system', storageKey: `theme-event-test-${process.pid}` } });
	await sleep(30);
	flush();
	await sleep(0);
	return app;
}

describe('Theme — native appearance events', () => {
	test('theme.get + system.getAccessibility run as the initial read', async () => {
		const app = await mountTheme();
		try {
			expect(platformRequests.some((r) => r.service === 'theme' && r.op === 'get')).toBe(true);
			expect(platformRequests.some((r) => r.service === 'system' && r.op === 'getAccessibility')).toBe(true);
			if (realDark !== null) expect(themeState().system).toBe(realDark === false ? 'dark' : 'light');
			expect(themeState().osReduced).toBe(true);
			expect(themeState().preferReducesMotion).toBe(true);
		} finally {
			unmount(app);
		}
	});

	test('appearanceChanged drives ThemeState.system', async () => {
		const app = await mountTheme();
		try {
			appearance(false);
			expect(themeState().system).toBe('light');
			expect(themeState().resolvedTheme).toBe('light');
			appearance(true);
			expect(themeState().system).toBe('dark');
			expect(themeState().resolvedTheme).toBe('dark');
		} finally {
			unmount(app);
		}
	});

	test('first event retires the spawnSync fallback poll', async () => {
		if (realDark === null) return; // non-darwin: nothing honest to assert against
		const app = await mountTheme();
		try {
			// push the opposite of the real pref — if the poll still ran it would
			// drag system back to realDark on the next 1.5s tick
			appearance(!realDark);
			expect(themeState().system).toBe(realDark ? 'light' : 'dark');
			await sleep(1700);
			expect(themeState().system).toBe(realDark ? 'light' : 'dark');
		} finally {
			unmount(app);
		}
	});
});

describe('theme() — function call, no wrapper element', () => {
	test('ships the resolved declaration through the setTheme op', async () => {
		const target = doc.createElement('div');
		doc.body.appendChild(target);
		materializeRoot(target);
		const before = ops.length; // earlier <Theme> mounts leave theme props behind
		const app = mount(ThemeFn, { target });
		await sleep(30);
		flush();
		await sleep(0);
		try {
			const fresh = ops.slice(before);
			const setTheme = fresh.find((o) => o[0] === 'setTheme');
			expect(setTheme).toBeTruthy();
			const decl = setTheme?.[1] as Record<string, unknown>;
			expect(decl.mode).toBe('dark');
			expect(decl.defaultColor).toBe('neutral');
			// the case paints app.resolvedTheme + useTheme()===app — context was
			// provided at init, without a component wrapper
			const text = fresh
				.filter((o) => o[0] === 'setText')
				.map((o) => String(o[2]))
				.join('|');
			expect(text).toContain('dark');
			expect(text).toContain('same');
			// the scoped lane: plain `theme={…}` attribute → setCustomProp —
			// folds over the app-level decl for that subtree only
			const themed = fresh.find((o) => o[0] === 'setCustomProp' && o[2] === 'theme');
			expect(themed?.[3]).toEqual({ colors: { brand: '#123456' } });
		} finally {
			unmount(app);
		}
	});

	test('a nested theme() overrides context without touching the global decl', async () => {
		const target = doc.createElement('div');
		doc.body.appendChild(target);
		materializeRoot(target);
		const before = ops.length;
		const app = mount(ThemeNested, { target });
		await sleep(30);
		flush();
		await sleep(0);
		try {
			const fresh = ops.slice(before);
			// every setTheme carries the parent's dark decl — the parent may
			// re-emit as osDetect fields resolve (osReduced → motion), but the
			// nested theme() detected the parent context and skipped the
			// global emit entirely: nothing may ship its light mode.
			const setThemes = fresh.filter((o) => o[0] === 'setTheme');
			expect(setThemes.length).toBeGreaterThan(0);
			expect(
				setThemes.every((o) => (o[1] as Record<string, unknown>).mode === 'dark'),
			).toBe(true);
			// context override: the child's theme() provided its own state —
			// parent paints dark, child paints light
			const text = fresh
				.filter((o) => o[0] === 'setText')
				.map((o) => String(o[2]))
				.join('|');
			expect(text).toContain('parent=dark');
			expect(text).toContain('child=light');
		} finally {
			unmount(app);
		}
	});
});
