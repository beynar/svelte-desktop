import { expect, test } from 'bun:test';
import { PlatformTransport, initPlatformForTests } from './bus';
const mockPlatform = () => {
	const t = new PlatformTransport();
	t.serve('notifications', 'responses', { ok: true, value: [] });
	initPlatformForTests(t);
	t.requests.length = 0;
	return t;
};
import { sessions } from './sessions';
import { webview, view, windows, popover } from './index';

test('session API routes explicit profile and cookie options without changing units', async () => {
	const t = mockPlatform();
	await sessions.create({ id: 'private', persistent: false });
	await sessions.list();
	await sessions.cookies.get({ session: 'private', url: 'https://example.com/a', name: 'account' });
	await sessions.cookies.set({ session: 'private', url: 'https://example.com', name: 'account', value: 'one', expires: 2000000000, httpOnly: true });
	await sessions.cookies.remove({ session: 'private', url: 'https://example.com', name: 'account' });
	await sessions.setProxy('private', { type: 'socks', host: 'localhost', port: 1080 });
	await sessions.setProxy('private', null);
	await sessions.getProxy('private');
	await sessions.capabilities();
	await sessions.remove('private');
	expect(t.requests.map((r) => r.op)).toEqual(['create', 'list', 'cookiesGet', 'cookiesSet', 'cookiesRemove', 'setProxy', 'setProxy', 'getProxy', 'capabilities', 'remove']);
	expect(t.requests[3]?.args).toMatchObject({ expires: 2000000000, httpOnly: true });
	expect(t.requests[6]?.args).toEqual({ session: 'private', proxy: null });
	expect(t.requests.at(-1)?.args).toEqual({ session: 'private' });
});

test('cookie and lifecycle subscriptions preserve targets and unsubscribe', () => {
	const t = mockPlatform();
	const cookies: unknown[] = [], lifecycle: unknown[] = [];
	const offCookie = sessions.cookies.onChanged((e) => cookies.push(e));
	const offLife = webview.onLifecycle((e) => lifecycle.push(e));
	const changed = { session: 'private', cookie: { name: 'a', value: 'b' }, removed: false };
	const failed = { type: 'failed', windowId: 0, viewId: 'preview', domain: 'NSURLErrorDomain', code: -1004, url: 'http://127.0.0.1:1', provisional: true };
	t.emit('sessionCookieChanged', changed); t.emit('webviewLifecycle', failed);
	offCookie(); offLife();
	t.emit('sessionCookieChanged', changed); t.emit('webviewLifecycle', failed);
	expect(cookies).toEqual([changed]); expect(lifecycle).toEqual([failed]);
});

test('all view constructors carry the session and recovery; webview controls accept viewId', async () => {
	const t = mockPlatform();
	await windows.create({ session: 'account', recovery: 'manual' });
	await popover.create({ session: 'account', recovery: 'manual', route: '/' });
	await view.create({ session: 'account', recovery: 'manual', route: '/', bounds: { x: 0, y: 0, width: 100, height: 100 } });
	await webview.setRecovery('manual', { viewId: 'preview' });
	await webview.reload({ viewId: 'preview' });
	for (const r of t.requests.slice(0, 3)) expect(r.args).toMatchObject({ session: 'account', recovery: 'manual' });
	expect(t.requests[3]?.args).toEqual({ viewId: 'preview', recovery: 'manual' });
	expect(t.requests[4]?.args).toEqual({ viewId: 'preview' });
});
