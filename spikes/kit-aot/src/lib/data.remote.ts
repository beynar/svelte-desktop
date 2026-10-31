import { command, form, query } from '$app/server';
import { Database } from 'bun:sqlite';

// in-memory: every process starts from the same seed
const db = new Database(':memory:');
db.run('CREATE TABLE counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)');
db.run('INSERT INTO counter (id, value) VALUES (1, 0)');
db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)');
db.run("INSERT INTO notes (text) VALUES ('seed note from bun:sqlite')");

export const getState = query(async () => {
	const counter = db.query('SELECT value FROM counter WHERE id = 1').get() as { value: number };
	const notes = db.query('SELECT id, text FROM notes ORDER BY id DESC LIMIT 10').all() as {
		id: number;
		text: string;
	}[];
	return { counter: counter.value, notes, runtime: `bun ${Bun.version}` };
});

export const increment = command(async () => {
	db.run('UPDATE counter SET value = value + 1 WHERE id = 1');
	await getState().refresh();
	const { value } = db.query('SELECT value FROM counter WHERE id = 1').get() as { value: number };
	return { counter: value };
});

export const addNote = form('unchecked', async (data) => {
	const text = String((data as { text?: string }).text ?? '').trim();
	if (!text) return { error: 'empty note' };
	db.run('INSERT INTO notes (text) VALUES (?)', [text]);
	await getState().refresh();
	return { ok: true };
});
