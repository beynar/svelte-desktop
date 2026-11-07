// `kitop build --release` with no bridge list (KIT_NO_LIST): the build you'd distribute. Started with
// every variable that would drive a test build, or the Bun runtime in it, it doesn't connect, runs
// nothing it's handed, and its test ops refuse. It runs: its server code reports what it finds
// (src/lib/server/release-probe.ts).
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from '@kitop/shell/test';

const dir = mkdtempSync(join(tmpdir(), 'kit-release-'));
const marker = join(dir, 'ran');
const preload = join(dir, 'preload.js');
writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);

function executable(): string {
	const root = resolve(process.env.KIT_APP ?? '.desktop/dist');
	const app = process.env.KIT_APP ? root : join(root, readdirSync(root).find((f) => f.endsWith('.app') || (!f.includes('.') && !f.startsWith('release')))!);
	if (process.platform === 'darwin') return join(app, 'Contents/MacOS', readdirSync(join(app, 'Contents/MacOS'))[0]!);
	if (process.platform === 'win32') return join(app, readdirSync(app).find((f) => f.endsWith('.exe'))!);
	return join(app, /^Exec=(\S+)/m.exec(readFileSync(join(app, readdirSync(app).find((f) => f.endsWith('.desktop'))!), 'utf8'))![1]!);
}

test('a released build has no test channel, runs what it was given by no variable, and pages with no list can call nothing', async () => {
	const out = join(dir, 'probe.json');
	// A runtime that can't load: a build that took this variable would have no web view at all.
	mkdirSync(join(dir, 'EBWebView', 'x64'), { recursive: true });
	writeFileSync(join(dir, 'EBWebView', 'x64', 'EmbeddedBrowserWebView.dll'), 'not a dll');
	// A debugger, if the runtime opens one: it answers on this port.
	const port = 20000 + Math.floor(Math.random() * 20000);
	let debuggerAnswered = false;
	const listening = setInterval(() => void fetch(`http://127.0.0.1:${port}/kit`).then(() => (debuggerAnswered = true), () => {}), 500);
	const failed = await launch({
		...(process.env.KIT_APP && { app: process.env.KIT_APP }),
		timeout: 30_000,
		env: {
			KIT_PROBE: out,
			WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: dir,
			WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333',
			BUN_OPTIONS: `--preload ${preload}`,
			BUN_INSPECT: `ws://127.0.0.1:${port}/kit`
		}
	}).then(
		async (app) => (await app.close(), null),
		(e: Error) => e.message
	);
	clearInterval(listening);
	expect(failed).toContain('did not connect');
	expect(existsSync(marker)).toBe(false);
	expect(debuggerAnswered).toBe(false);
	const probe = await Bun.file(out).json();
	console.log(JSON.stringify(probe));
	// Nothing listed: nothing called, and the features that ask the server say why at once.
	expect(probe.page.clipboard).toBe('denied');
	expect(probe.page.window).toBe('denied');
	expect(probe.page.store.code).toBe('denied');
	expect(probe.page.store.message).toContain('bridge.allow');
	expect(probe.page.store.ms).toBeLessThan(3000);
	// The test channel's ops.
	expect(probe.native.terminate).toBe('denied');
	expect(probe.native.policy).toBe('denied');
	expect(probe.alive).toBe(2);
	expect(probe.native.testScroll).toBe(process.platform === 'darwin' ? 'unknown' : 'unsupported');
	expect(probe.native.simulateResponse).toBe(process.platform === 'darwin' ? 'unknown' : 'unsupported');
	if (process.platform === 'linux') expect(probe.page.devices).not.toContain('videoinput'); // no mock camera
}, 60_000);

test('BUN_BE_BUN does not make it the bun command line', async () => {
	const proc = Bun.spawn([executable(), '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { env: { ...process.env, BUN_BE_BUN: '1' }, stdout: 'ignore', stderr: 'ignore' });
	await Promise.race([proc.exited, Bun.sleep(8000)]);
	proc.kill('SIGKILL');
	await proc.exited;
	expect(existsSync(marker)).toBe(false);
}, 30_000);
