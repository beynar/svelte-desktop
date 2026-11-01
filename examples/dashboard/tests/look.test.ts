// Screenshots of the three pages (bun test tests/look.test.ts) — a visual check, not assertions.
import { test } from 'bun:test';
import { launch } from '@svelte-desktop/shell/test';

test('dashboard pages', async () => {
	const app = await launch({ dev: true });
	await app.waitFor('main', { timeout: 30_000 });
	for (const [path, name] of [['/', 'overview'], ['/board', 'board'], ['/calendar', 'calendar']]) {
		await app.goto(path);
		await Bun.sleep(1200);
		await app.screenshot(`/tmp/dashboard-${name}.png`);
	}
	console.log('errors:', await app.eval(`document.querySelectorAll('.error, [data-sveltekit-error]').length`));
	await app.close();
}, 120_000);
