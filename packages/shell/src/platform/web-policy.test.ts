import { afterEach, expect, test } from 'bun:test';
import { mockPlatform } from './bus';
import { webPolicy } from './web-policy';

const request = { requestId: 'request-one', origin: 'https://third.example', frame: { origin: 'https://third.example', url: 'https://third.example/', main: true }, permission: 'camera', viewId: 'preview', windowId: 0 };
afterEach(async () => { mockPlatform(); await webPolicy.setPermissionHandler(null); await webPolicy.onAuthChallenge(null); });
const tick = () => new Promise((r) => setTimeout(r, 0));
test('async permission handler receives native scope and replies to that request only', async () => {
	const t = mockPlatform();
	await webPolicy.setPermissionHandler(async (r) => { expect(r.origin).toBe(request.origin); expect('requestId' in r).toBe(false); expect(r.viewId).toBe('preview'); return 'allow'; });
	t.emit('webPermissionRequest', request); await tick();
	expect(t.requests.at(-1)).toMatchObject({ op: 'respondPolicy', args: { requestId: request.requestId, answer: 'allow' } });
});
test('permission exceptions deny and late native replies are contained', async () => {
	const t = mockPlatform(); await webPolicy.setPermissionHandler(() => { throw new Error('private failure'); });
	t.serve('webview', 'respondPolicy', { ok: false, error: { code: 'unavailable', message: 'expired' } });
	t.emit('webPermissionRequest', request); await tick();
	expect(t.requests.at(-1)?.args.answer).toBe('deny');
});
test('auth credentials stay in the response lane and retain request identity', async () => {
	const t = mockPlatform(); await webPolicy.onAuthChallenge(async (r) => r.method === 'basic' && r.previousFailures === 0 ? { username: 'demo', password: 'test-value' } : 'cancel');
	t.emit('webAuthChallenge', { requestId: 'auth-one', origin: 'http://localhost:123', method: 'basic', previousFailures: 0 }); await tick();
	expect(t.requests.at(-1)).toMatchObject({ op: 'respondPolicy', args: { requestId: 'auth-one', answer: { username: 'demo', password: 'test-value' } } });
});
test('auth exceptions cancel and null removes the handler', async () => {
	const t = mockPlatform(); await webPolicy.onAuthChallenge(() => { throw new Error('no credentials'); });
	t.emit('webAuthChallenge', { requestId: 'auth-two' }); await tick(); expect(t.requests.at(-1)?.args.answer).toBe('cancel');
	await webPolicy.onAuthChallenge(null); expect(t.requests.at(-1)?.args).toMatchObject({ kind: 'auth', enabled: false });
});
test('persistence and certificate exceptions retain exact explicit scope', async () => {
	const t = mockPlatform();
	await webPolicy.setPermissionDecision({ origin: request.origin, permission: 'camera', decision: 'deny' });
	expect(t.requests.at(-1)?.args).toEqual({ origin: request.origin, permission: 'camera', decision: 'deny' });
	await webPolicy.revokePermissionDecision({ origin: request.origin, permission: 'camera' });
	expect(t.requests.at(-1)?.op).toBe('revokePermissionDecision');
	await webPolicy.allowCertificate({ host: 'self.example', fingerprint: 'a'.repeat(64) });
	expect(t.requests.at(-1)?.args).toEqual({ host: 'self.example', fingerprint: 'a'.repeat(64) });
});
