// Launch at login: reads without side effects in the built app, and neither reads nor writes reject in
// `vite dev`, where it isn't available. Turning it on for real (a system notification, an entry in the
// user's Login Items) isn't part of the suite: KITOP_TEST_LOGIN_ITEM=1 runs it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

const off = { available: false, enabled: false, requiresApproval: false, launchedAtLogin: false };

describe('built app', () => {
	let app: AppHandle;
	beforeAll(async () => {
		app = await launch();
		await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
	});
	afterAll(() => app?.close());

	test('a launch by hand is not a launch at login', async () => {
		expect(await app.eval(`host.app.getLoginItem()`)).toMatchObject({ available: true, launchedAtLogin: false });
	});

	test.if(!!process.env.KITOP_TEST_LOGIN_ITEM)('on, then off', async () => {
		try {
			expect(await app.eval(`host.app.setLoginItem(true)`)).toMatchObject({ available: true, enabled: true });
			expect(await app.eval(`host.app.getLoginItem()`)).toMatchObject({ enabled: true });
		} finally {
			expect(await app.eval(`host.app.setLoginItem(false)`)).toMatchObject({ enabled: false });
		}
		expect(await app.eval(`host.app.setLoginItem(false)`)).toMatchObject({ enabled: false }); // already off
	});
});

test('vite dev: not available, and nothing rejects', async () => {
	const app = await launch({ dev: true, env: { VITE_TABS_SPLIT: '0' }, timeout: 60_000 });
	try {
		await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
		expect(await app.eval(`host.app.getLoginItem()`)).toEqual(off);
		expect(await app.eval(`host.app.setLoginItem(true)`)).toEqual(off);
		expect(await app.eval(`host.app.setLoginItem(false)`)).toEqual(off);
		expect(await app.eval(`fetch('/modules/command', { method: 'POST' }).then((r) => r.json())`)).toEqual({ path: null, onPath: false });
		expect(await app.eval(`host.deepLink.register('dashboard-test')`)).toEqual({ scheme: 'dashboard-test', registered: false });
		expect(await app.eval(`host.deepLink.isDefault('dashboard-test')`)).toBe(false);
		expect(await app.eval(`host.notifications.getPermissionStatus()`)).toEqual({ status: 'unavailable' });
		expect(await app.eval(`host.notifications.requestPermission()`)).toEqual({ status: 'unavailable' });
		expect(await app.eval(`host.notifications.isSupported()`)).toBe(false);
		expect(await app.eval(`host.notifications.show({ id: 'dev', title: 'Hello' })`)).toEqual({ id: 'dev', scheduled: false, skipped: true });
		expect(await app.eval(`host.notifications.dismiss('dev')`)).toBeNull();
		expect(await app.eval(`host.notifications.dismissAll()`)).toBeNull();
		expect(await app.eval(`host.notifications.delivered()`)).toEqual([]);
		expect(await app.eval(`host.notifications.pending()`)).toEqual([]);
	} finally {
		await app.close();
	}
}, 90_000);
