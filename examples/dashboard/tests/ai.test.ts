// host.ai and host.which in the built app (`bun run build` first). The model itself answers only on
// macOS 26 with Apple Intelligence on: elsewhere the calls must say why, with the right codes.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';

let app: AppHandle;
beforeAll(async () => {
	app = await launch(process.env.DESKTOP_TEST_DEV ? { dev: true, env: { VITE_TABS_SPLIT: '0' } } : {});
	await app.waitFor('[data-theme-toggle]', { timeout: 30_000 });
});
afterAll(() => app?.close());

test('host.ai: the plugin is loaded and says whether the model can run', async () => {
	const a = await app.eval<{ available: boolean; reason?: string }>(`host.ai.availability()`);
	// 'unsupported' would mean libshell-ai didn't load: on macOS it answers with the model's state.
	expect(a.reason).not.toBe('unsupported');
	if (a.available) {
		expect(await app.eval<string>(`host.ai.respond('Answer with one word: the color of the sky on a clear day?', { temperature: 0 })`)).toBeString();
		return;
	}
	const err = (expr: string) => app.eval<{ code: string }>(`${expr}.then(() => ({ code: 'ok' }), (e) => ({ code: e.code, message: e.message }))`);
	expect((await err(`host.ai.respond('Hello')`)).code).toBe('unavailable');
	expect((await err(`host.ai.session()`)).code).toBe('unavailable');
	// The caller's mistakes first: a schema the model can't follow is invalid_args wherever it runs.
	expect((await err(`host.ai.generate('x', { schema: { type: 'object', properties: { n: { enum: [1, 2] } } } })`)).code).toBe('invalid_args');
	expect((await err(`host.ai.respond('')`)).code).toBe('invalid_args');
});

test('host.which: the Modules page lists the tools found on the shell PATH', async () => {
	await app.goto('/modules');
	await app.waitFor('[data-module="tools"]', { timeout: 15_000 });
	const tools = await app.eval<string[]>(`[...document.querySelectorAll('[data-module="tools"] li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`);
	expect(tools.find((t) => t.startsWith('git'))).toMatch(/\/git/);
	await app.waitFor('[data-module="ai"] [data-ai-unavailable], [data-module="ai"] textarea', { timeout: 10_000 });
});

test('the server trusts the system certificates (desktop.config network, on by default)', async () => {
	await app.goto('/modules');
	await app.waitFor('[data-network]', { timeout: 15_000 });
	expect(await app.text('[data-network]')).toContain('the system’s certificates too');
});
