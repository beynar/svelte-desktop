/**
 * Persisted JSON key-value store. Pure JS: a flat record flushed to
 * `${app.getPath('appData')}/svelte-desktop-store.json` — writes are
 * debounced 250ms so bursts of set() calls coalesce into one write.
 * From a page, the app's server process does the file I/O (app-files.ts).
 * Call load() once at init (the stores-module `store` namespace does it);
 * failures there land on `store.error` like every other namespace.
 */
import { readAppFile, writeAppFile } from './app-files';

const FILE_NAME = 'svelte-desktop-store.json';
const SAVE_DEBOUNCE_MS = 250;

let data: Record<string, unknown> = {};
let loaded = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function persist(): Promise<void> {
	if (!loaded) return; // flush() guards; a stray timer before load() is a no-op
	await writeAppFile('appData', FILE_NAME, JSON.stringify(data, null, 2));
}

function scheduleSave(): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		// Debounced writes can't propagate — a failed write (permissions,
		// full disk) must not surface as an unhandled rejection. flush()
		// is the propagating lane for callers that need the error.
		void persist().catch(() => {});
	}, SAVE_DEBOUNCE_MS);
}

export const store = {
	/** The file's name in the app data directory — null until load() runs. */
	get path() {
		return loaded ? FILE_NAME : null;
	},
	/** Live in-memory record — the source of truth between saves. */
	get data() {
		return data;
	},

	get<T = unknown>(key: string): T | undefined {
		return data[key] as T | undefined;
	},
	set(key: string, value: unknown): void {
		// `undefined` can't round-trip through JSON — treat it as delete so
		// memory and disk stay in agreement after reload.
		if (value === undefined) delete data[key];
		else data[key] = value;
		scheduleSave();
	},
	delete(key: string): void {
		delete data[key];
		scheduleSave();
	},
	clear(): void {
		data = {};
		scheduleSave();
	},

	/** Resolve the file path and read it into memory. Missing file → {}. */
	async load(): Promise<Record<string, unknown>> {
		const text = await readAppFile('appData', FILE_NAME);
		loaded = true;
		if (text === null) {
			data = {};
			return data;
		}
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			// Corrupt file falls back to {} — matches windowState.load()'s
			// tolerance; a broken store must not brick the namespace.
		}
		data =
			parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		return data;
	},

	/** Cancel the pending debounced write and flush to disk immediately. */
	async flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!loaded) throw new Error('store.flush() before load()');
		await persist();
	},
};
