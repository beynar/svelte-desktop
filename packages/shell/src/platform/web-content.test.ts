import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mockPlatform } from './bus';
import { webContent } from './web-content';
import { protocol, validateProtocolScheme } from './protocol';
import { resolveConfig } from '../config';

beforeEach(() => mockPlatform());
afterEach(() => protocol.unhandle('asset-test'));
test('rules and scripts retain WebKit JSON and targeting on the wire', async () => {
	const transport = mockPlatform();
	const rule = { trigger: { 'url-filter': 'tracker' }, action: { type: 'block' as const } };
	await webContent.setContentRules({ id: 'privacy', rules: [rule] });
	await webContent.scripts.register({ id: 'reader', source: 'globalThis.reader = true', timing: 'start', world: 'reader', target: { viewId: 'article' } });
	await webContent.scripts.unregister('reader');
	await webContent.removeContentRules('privacy');
	expect(transport.requests.map(({ op, args }) => ({ op, args }))).toEqual([
		{ op: 'setContentRules', args: { id: 'privacy', rules: [rule] } },
		{ op: 'registerScript', args: { id: 'reader', source: 'globalThis.reader = true', timing: 'start', world: 'reader', target: { viewId: 'article' } } },
		{ op: 'unregisterScript', args: { id: 'reader' } },
		{ op: 'removeContentRules', args: { id: 'privacy' } },
	]);
});
test('custom protocols reject reserved schemes in config and handlers', () => {
	for (const scheme of ['http', 'https', 'file', 'data', 'javascript', 'Asset', '', 'asset:']) {
		expect(() => validateProtocolScheme(scheme)).toThrow();
		expect(() => resolveConfig('/tmp', { appName: 'test', protocols: [scheme] })).toThrow();
	}
	expect(resolveConfig('/tmp', { appName: 'test', protocols: ['asset'] }).protocols).toEqual(['asset']);
	protocol.handle('asset-test', () => new Response('ok'));
	expect(protocol.isProtocolHandled('asset-test')).toBe(true);
	expect(() => protocol.handle('asset-test', () => new Response('duplicate'))).toThrow();
	protocol.unhandle('asset-test');
	expect(protocol.isProtocolHandled('asset-test')).toBe(false);
});
test('protocol responses are acknowledged in bounded chunks and preserve status and headers', async () => {
	const transport = mockPlatform();
	protocol.handle('asset-test', () => new Response(new Uint8Array(150000), { status: 201, headers: { 'content-type': 'application/octet-stream' } }));
	transport.emit('protocolRequest', { requestId: 'large', url: 'asset-test://test/large', method: 'GET', headers: {} });
	for (let i = 0; i < 100 && !transport.requests.some(r => r.op === 'finish'); i++) await Bun.sleep(1);
	const calls = transport.requests.filter(r => r.service === 'protocol');
	expect(calls[0].op).toBe('response');
	expect(calls.at(-1)?.op).toBe('finish');
	expect(calls[0].args).toMatchObject({ status: 201, headers: { 'content-type': 'application/octet-stream' } });
	const lengths = calls.filter(r => r.op === 'data').map(r => Buffer.from(r.args.data as string, 'base64').length);
	expect(lengths.reduce((a, b) => a + b, 0)).toBe(150000);
	expect(lengths.every(n => n > 0 && n <= 65536)).toBe(true);
	protocol.unhandle('asset-test');
});
test('protocol cancellation aborts Request and cancels its response reader', async () => {
	const transport = mockPlatform();
	let signal: AbortSignal | undefined, cancelled = false;
	protocol.handle('asset-test', (request) => {
		signal = request.signal;
		return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }));
	});
	transport.emit('protocolRequest', { requestId: 'cancel', url: 'asset-test://test/cancel', method: 'GET', headers: {} });
	await Bun.sleep(10);
	transport.emit('protocolCancel', { requestId: 'cancel' });
	await Bun.sleep(10);
	expect(signal?.aborted).toBe(true);
	expect(cancelled).toBe(true);
	expect(transport.requests.some(r => r.op === 'finish' || r.op === 'fail')).toBe(false);
	protocol.unhandle('asset-test');
});
test('handler failures fail the resource and missing handlers return 404', async () => {
	const transport = mockPlatform();
	protocol.handle('asset-test', () => { throw new Error('read failed'); });
	transport.emit('protocolRequest', { requestId: 'failure', url: 'asset-test://test/failure', method: 'GET', headers: {} });
	await Bun.sleep(5);
	expect(transport.requests.filter(r => r.service === 'protocol').map(r => r.op)).toEqual(['fail']);
	expect(transport.requests[0].args.message).toBe('read failed');
	protocol.unhandle('asset-test');
	transport.emit('protocolRequest', { requestId: 'missing', url: 'asset-test://test/missing', method: 'GET', headers: {} });
	await Bun.sleep(5);
	expect(transport.requests.find(r => r.op === 'response')?.args.status).toBe(404);
	expect(transport.requests.at(-1)?.op).toBe('finish');
});
test('navigation callbacks allow, cancel on exceptions and remove their listener', async () => {
	const transport = mockPlatform();
	await webContent.setNavigationPolicy(({ url }) => new URL(url).pathname === '/allow' ? 'allow' : Promise.reject(new Error('denied')));
	transport.emit('webContentNavigation', { requestId: 'allow', url: 'asset://test/allow', isMainFrame: true, viewId: 'v' });
	transport.emit('webContentNavigation', { requestId: 'deny', url: 'asset://test/deny', isMainFrame: true, viewId: 'v' });
	await Bun.sleep(5);
	expect(transport.requests.filter(r => r.op === 'navigationDecision').map(r => r.args)).toEqual([
		{ requestId: 'allow', allow: true }, { requestId: 'deny', allow: false },
	]);
	await webContent.setNavigationPolicy(null);
	const count = transport.requests.length;
	transport.emit('webContentNavigation', { requestId: 'removed', url: 'asset://test/allow', isMainFrame: true, viewId: 'v' });
	await Bun.sleep(5);
	expect(transport.requests.length).toBe(count);
});
test('a response body is released when native rejects its headers after cancellation', async () => {
	const transport = mockPlatform();
	transport.serve('protocol', 'response', { ok: false, error: { code: 'unavailable', message: 'task stopped' } });
	let cancelled = false;
	protocol.handle('asset-test', () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
	transport.emit('protocolRequest', { requestId: 'stopped', url: 'asset-test://test/stopped', method: 'GET', headers: {} });
	await Bun.sleep(5);
	expect(cancelled).toBe(true);
	expect(transport.requests.some(r => r.op === 'data' || r.op === 'finish')).toBe(false);
});
