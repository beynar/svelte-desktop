import { expect, test } from 'bun:test';
import { PlatformTransport, initPlatformForTests } from './bus';
import { downloads } from './downloads';
import { files } from './files';
import { webview, dialog } from './index';

function transport() {
	const t = new PlatformTransport();
	t.serve('notifications', 'responses', { ok: true, value: [] });
	initPlatformForTests(t);
	t.requests.length = 0;
	return t;
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('download decision is awaited, scoped to its handler, and thrown decisions cancel', async () => {
	const t = transport();
	let calls = 0;
	const off = await downloads.onRequested(async () => {
		calls++;
		await Promise.resolve();
		if (calls === 2) throw new Error('no destination');
		return { path: '/tmp/chosen.bin' };
	});
	const handlerId = t.requests[0]!.args.handlerId;
	t.emit('downloadRequested', { id: 'other', handlerId: 'not-ours' });
	t.emit('downloadRequested', { id: 'one', handlerId });
	await settled();
	expect(t.requests.at(-1)).toMatchObject({ service: 'webview', op: 'decideDownload', args: { id: 'one', decision: { path: '/tmp/chosen.bin' } } });
	t.emit('downloadRequested', { id: 'two', handlerId });
	await settled();
	expect(t.requests.at(-1)?.args.decision).toBe('cancel');
	await off();
	t.emit('downloadRequested', { id: 'three', handlerId });
	await settled();
	expect(calls).toBe(2);
});

test('bookmark release is idempotent for concurrent callers and retries native failure', async () => {
	const t = transport();
	t.serve('files', 'openBookmark', { ok: true, value: { id: 'scope-1', path: '/tmp/folder', stale: true } });
	const access = await files.openBookmark('opaque');
	expect(access.path).toBe('/tmp/folder'); expect(access.stale).toBe(true);
	t.serve('files', 'releaseBookmark', { ok: false, error: { code: 'unavailable', message: 'retry' } });
	await expect(access.release()).rejects.toThrow('retry');
	t.serve('files', 'releaseBookmark', { ok: true, value: null });
	await Promise.all([access.release(), access.release()]);
	expect(t.requests.filter((r) => r.op === 'releaseBookmark')).toHaveLength(2);
});

test('legacy download API, print options and scoped dialogs preserve their wire contracts', async () => {
	const t = transport();
	const options = { printer: 'Office', copies: 2, pageRanges: [{ from: 2, to: 3 }], paperSize: { width: 420, height: 595 }, orientation: 'landscape' as const, margins: { top: 10, right: 10, bottom: 10, left: 10 } };
	await webview.print({ ...options, silent: true });
	await webview.printToPDF('/tmp/output.pdf', options);
	await webview.getPrinters();
	await dialog.showOpenDialog({ directories: true, securityScoped: true });
	await downloads.pause('one'); await downloads.resume('one', { viewId: 'preview' }); await downloads.cancel('one'); await downloads.get('one'); await downloads.list();
	expect(t.requests[0]?.args).toEqual({ ...options, silent: true });
	expect(t.requests[1]?.args).toEqual({ ...options, path: '/tmp/output.pdf' });
	expect(t.requests[3]?.args).toEqual({ directories: true, securityScoped: true });
	expect(t.requests[5]?.args).toEqual({ id: 'one', viewId: 'preview' });
});
