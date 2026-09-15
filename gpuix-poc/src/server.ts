/**
 * The "server" side of the remote-function boundary — plain Bun APIs.
 * In-process here; identical code would run behind HTTP in the SvelteKit build.
 */
import { Database } from 'bun:sqlite';

const db = new Database(
	(process.env.HOME ?? '/tmp') + '/.svelte-gpuix-demo.sqlite',
	{ create: true },
);
db.run('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT, created_at TEXT)');

export function getNotes() {
	return db.query('SELECT id, text, created_at FROM notes ORDER BY id DESC').all() as {
		id: number;
		text: string;
		created_at: string;
	}[];
}

export function addNote(text: string) {
	db.run('INSERT INTO notes (text, created_at) VALUES (?, ?)', [text, new Date().toISOString()]);
}

export function getNoteCount() {
	return (db.query('SELECT COUNT(*) as n FROM notes').get() as { n: number }).n;
}

export function runtimeInfo() {
	return `bun ${Bun.version} · ${process.platform}/${process.arch} · pid ${process.pid}`;
}
