import { command, form, query } from '$app/server';
import { Database } from 'bun:sqlite';
import { homedir, hostname, platform, arch } from 'node:os';
import { join } from 'node:path';

// Injected by the host shell (electrobun main process) before the kit build is
// imported. Absent under plain `bun ./build` or vite dev.
const native = () => (globalThis as Record<string, any>).__nativeBridge;

const db = new Database(join(homedir(), '.svelte-desktop-demo.sqlite'), { create: true });
db.run('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)');
db.run('INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)');
db.run(
	'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)'
);

export const getState = query(async () => {
	const counter = db.query('SELECT value FROM counter WHERE id = 1').get() as { value: number };
	const notes = db
		.query('SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 10')
		.all() as { id: number; text: string; created_at: string }[];
	return {
		counter: counter.value,
		notes,
		runtime: `bun ${Bun.version}`,
		pid: process.pid,
		servedAt: new Date().toISOString(),
		host: `${hostname()} ${platform()}/${arch()}`,
		nativeBridge: !!native()
	};
});

export const openNativeDialog = command(async () => {
	const bridge = native();
	if (!bridge) return { native: false as const };
	const response = await bridge.showMessageBox({
		type: 'info',
		message: 'Hello from a SvelteKit remote function',
		detail: 'This native dialog was opened by the Electrobun main process via command().',
		buttons: ['Nice', 'Dismiss']
	});
	return { native: true as const, response };
});

export const increment = command(async () => {
	db.run('UPDATE counter SET value = value + 1 WHERE id = 1');
	await getState().refresh();
});

export const addNote = form('unchecked', async (data) => {
	const text = String((data as { text?: string }).text ?? '').trim();
	if (!text) return { error: 'empty note' };
	db.run('INSERT INTO notes (text, created_at) VALUES (?, ?)', [
		text,
		new Date().toISOString()
	]);
	await getState().refresh();
	return { ok: true };
});
