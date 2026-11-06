import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformTransport, initPlatformForTests } from './bus';
import { quitFlushes, store } from './store';
import { createDesktopRuntime } from '../desktop-api';

const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

// One test: the module's state (the path it remembers) lasts as long as the file.
test('what server code just set is written at quit, once nothing answers platform calls', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'sd-store-'));
	const t = new PlatformTransport();
	t.serve('app', 'getPath', { ok: true, value: dir });
	initPlatformForTests(t);
	await store.load();
	expect(t.requests.filter((r) => r.op === 'getPath').length).toBe(1);

	// The native run loop has stopped: a platform call would never come back.
	const realCall = t.platformCall.bind(t);
	t.platformCall = () => '{"pending":true}';
	store.set('last', 'before quit');
	for (const flush of quitFlushes()) await flush();
	expect(JSON.parse(readFileSync(join(dir, 'kitop-store.json'), 'utf8'))).toEqual({ last: 'before quit' });

	// Nothing pending: nothing to do, and no timer left behind to write later.
	store.set('later', 1);
	for (const flush of quitFlushes()) await flush();
	await Bun.sleep(300);
	expect(JSON.parse(readFileSync(join(dir, 'kitop-store.json'), 'utf8'))).toEqual({ last: 'before quit', later: 1 });

	// Each save keeps the one before. A file that went bad comes back from it, and isn't lost either.
	expect(JSON.parse(readFileSync(join(dir, 'kitop-store.json.bak'), 'utf8'))).toEqual({ last: 'before quit' });
	t.platformCall = realCall;
	writeFileSync(join(dir, 'kitop-store.json'), '{"last": "cut off');
	expect(await store.load()).toEqual({ last: 'before quit' });
	expect(readFileSync(join(dir, 'kitop-store.json.corrupt'), 'utf8')).toBe('{"last": "cut off');
});

test('a write that never finishes does not hold up the quit, and the rest of it still runs', async () => {
	const home = mkdtempSync(join(tmpdir(), 'sd-home-'));
	process.env.HOME = home;
	process.env.XDG_DATA_HOME = join(home, 'data');
	process.env.XDG_CACHE_HOME = join(home, 'cache');
	process.env.XDG_STATE_HOME = join(home, 'state');
	const runtime = createDesktopRuntime({ appName: 'T', identifier: 'dev.kitop.store-test', origin: 'http://127.0.0.1:1', quit() {} });
	const order: string[] = [];
	const stuck = async () => {
		order.push('flush');
		await new Promise(() => {});
	};
	quitFlushes().add(stuck);
	runtime.api.onBeforeQuit(() => void order.push('hook'));
	const started = performance.now();
	try {
		await runtime.runBeforeQuit();
	} finally {
		quitFlushes().delete(stuck);
	}
	const took = performance.now() - started;
	expect(order).toEqual(['hook', 'flush']); // after the hooks, which may still set something
	expect(took).toBeGreaterThan(900);
	expect(took).toBeLessThan(3000);
});
