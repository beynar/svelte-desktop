/**
 * Persisted JSON key-value store. Pure JS: a flat record flushed to
 * `${app.getPath('userData')}/kitop-store.json`, this app's own —
 * writes are debounced 250ms so bursts of set() calls coalesce into one write.
 * From a page, the app's server process does the file I/O (app-files.ts).
 * Call load() once at init (the stores-module `store` namespace does it);
 * failures there land on `store.error` like every other namespace.
 */
import { readAppFile, writeAppFile } from './app-files';

const FILE_NAME = 'kitop-store.json';
const CORRUPT_NAME = `${FILE_NAME}.corrupt`;
const SAVE_DEBOUNCE_MS = 250;

let data: Record<string, unknown> = {};
let loaded = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<unknown> = Promise.resolve();

function persist(): Promise<void> {
	if (!loaded) return Promise.resolve(); // flush() guards; a stray timer before load() is a no-op
	const text = JSON.stringify(data, null, 2);
	// One at a time, in order, so that quitting can wait for the last one.
	const done = writing.catch(() => {}).then(() => writeAppFile('userData', FILE_NAME, text));
	writing = done;
	return done;
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

// A page going away (its window closing, a reload) doesn't lose what it just set.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
	window.addEventListener('pagehide', () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
		void persist().catch(() => {});
	});
} else {
	// Server code: the app quitting doesn't either (desktop-api.ts runs these). By way of globalThis:
	// the app's server bundle has its own copy of this module.
	quitFlushes().add(async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
			void persist().catch(() => {});
		}
		await writing;
	});
}

export function quitFlushes(): Set<() => Promise<void>> {
	return ((globalThis as Record<symbol, Set<() => Promise<void>> | undefined>)[Symbol.for('kitop.quitFlushes')] ??= new Set());
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
		const text = await readAppFile('userData', FILE_NAME);
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
			// tolerance; a broken store must not brick the namespace. Its content stays
			// beside it: the next save would otherwise erase what might be recovered.
			console.error(`store: ${FILE_NAME} isn't valid JSON: starting empty, its content is kept in ${CORRUPT_NAME}`);
			await writeAppFile('userData', CORRUPT_NAME, text).catch(() => {});
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
