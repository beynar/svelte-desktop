import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { desktop, isDesktop } from '@svelte-desktop/shell/server';

let db: Database | undefined;

// Persistent in the app's data directory when running as a desktop app,
// in-memory under `vite dev` in a browser.
export function getDb(): Database {
	if (db) return db;
	db = new Database(isDesktop() ? join(desktop.paths.data, 'notes.sqlite') : ':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)');
	db.run('INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)');
	db.run('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)');
	return db;
}
