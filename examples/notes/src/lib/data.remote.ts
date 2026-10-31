import { command, form, query } from '$app/server';
import { getDb } from '#lib/server/db.ts';

export const getState = query(async () => {
	const db = getDb();
	const counter = db.query('SELECT value FROM counter WHERE id = 1').get() as { value: number };
	const notes = db.query('SELECT id, text FROM notes ORDER BY id DESC LIMIT 10').all() as {
		id: number;
		text: string;
	}[];
	return { counter: counter.value, notes, runtime: `bun ${Bun.version}` };
});

export const increment = command(async () => {
	const db = getDb();
	db.run('UPDATE counter SET value = value + 1 WHERE id = 1');
	await getState().refresh();
	const { value } = db.query('SELECT value FROM counter WHERE id = 1').get() as { value: number };
	return { counter: value };
});

export const addNote = form('unchecked', async (data) => {
	const text = String((data as { text?: string }).text ?? '').trim();
	if (!text) return { error: 'empty note' };
	getDb().run('INSERT INTO notes (text) VALUES (?)', [text]);
	await getState().refresh();
	return { ok: true };
});
