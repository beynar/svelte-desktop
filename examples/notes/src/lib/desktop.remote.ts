import { command, query } from '$app/server';
import { desktop, isDesktop, loadAddon } from '@svelte-desktop/shell/server';
import { getDb } from '#lib/server/db.ts';
import { greeter } from '#lib/native.ts';

export const shellInfo = query(async () =>
	isDesktop()
		? { desktop: true, appName: desktop.appName, origin: desktop.origin, data: desktop.paths.data }
		: { desktop: false }
);

export const setTitle = command('unchecked', async (title: string) => {
	desktop.window.setTitle(String(title));
});

export const importNotes = command(async () => {
	const paths = await desktop.dialog.open({ title: 'Import notes from text files', multiple: true, extensions: ['txt', 'md'] });
	if (!paths) return { imported: 0 };
	const db = getDb();
	let imported = 0;
	for (const path of paths) {
		for (const line of (await Bun.file(path).text()).split('\n')) {
			if (line.trim()) {
				db.run('INSERT INTO notes (text) VALUES (?)', [line.trim().slice(0, 500)]);
				imported++;
			}
		}
	}
	return { imported, paths };
});

export const exportNotes = command(async () => {
	const path = await desktop.dialog.save({ defaultName: 'notes.md', extensions: ['md'] });
	if (!path) return { saved: null };
	const notes = getDb().query('SELECT text FROM notes ORDER BY id').all() as { text: string }[];
	await Bun.write(path, notes.map((n) => `- ${n.text}`).join('\n') + '\n');
	return { saved: path };
});

export const clearNotes = command(async () => {
	const button = await desktop.dialog.message({
		message: 'Delete all notes?',
		detail: 'This cannot be undone.',
		style: 'warning',
		buttons: ['Delete', 'Cancel']
	});
	if (button !== 0) return { cleared: false };
	getDb().run('DELETE FROM notes');
	return { cleared: true };
});

export const openDocs = command(async () => {
	await desktop.openExternal('https://svelte.dev/docs/kit');
});

export const quitApp = command(async () => {
	desktop.quit();
});

/** Server code calling the Swift plugin (same API as from a page). */
export const nativeGreeting = query(async () =>
	isDesktop() ? greeter.hello({ name: 'server' }).catch(() => 'native plugin not available on this OS (Swift is macOS-only)') : null
);

/** Server code calling a C Node-API addon (native/addons/fastmath.c). */
export const fib = query('unchecked', async (n: number) => {
	const math = loadAddon<{ fib(n: number): number }>('fastmath');
	const t = performance.now();
	const value = math.fib(Number(n));
	return { value, ms: Math.round((performance.now() - t) * 100) / 100 };
});
