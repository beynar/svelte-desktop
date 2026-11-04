// The Modules page's terminal (built app): the user's shell in a pseudo-terminal on the app's server
// (src/websocket.ts, /terminal), drawn by xterm.js.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true } : {});
	await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
});
afterAll(() => app?.close());

test('a command typed in the shell answers through the PTY', async () => {
	const out = await app.eval<string>(`new Promise((resolve) => {
		const ws = new WebSocket(location.origin.replace('http', 'ws') + '/terminal?cols=100&rows=30');
		ws.binaryType = 'arraybuffer';
		let text = '';
		ws.onmessage = (e) => { text += typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data); if (text.includes('pty-42')) { ws.close(); resolve(text); } };
		ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ input: 'echo pty-$((6*7)) $TERM\\r' })), 300);
		setTimeout(() => { ws.close(); resolve(text); }, 8000);
	})`);
	expect(out).toContain('pty-42');
	expect(out).toContain('xterm-256color');
});

test('the Modules page draws it', async () => {
	await app.goto('/modules');
	await app.waitFor('[data-terminal] .xterm', { timeout: 15_000 });
});
