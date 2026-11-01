// Tabs, for a title-bar tab bar or any tab group inside a page: reactive state (Svelte 5 runes)
// plus the desktop integration — the window title, a Tab menu (⌘T ⌘W ⇧⌘T ⌃⇥), ⌘1–9,
// ⌘-click / middle-click on links, restoring the tabs at launch. Render them with <TabBar> and
// <TabPanels>, or with your own markup.
//
//   const tabs = new Tabs({ id: 'app', route: true, primary: true, create: () => ({ path: '/' }) });
//
// `route` tabs are app routes: activating one navigates to its path, and navigating changes the
// active tab's path (each tab remembers where it was). Otherwise a tab is plain state — show its
// content with <TabPanels> (kept alive) or `tabs.active`.
import { callPlatform, onPlatform, platformReady } from '../platform/bus';
import { readAppFile, writeAppFile } from '../platform/app-files';

export interface Tab<D = unknown> {
	id: string;
	title: string;
	/** An app path (`route` tabs: where the tab is). */
	path?: string;
	/** Kept in place, and out of "close others". */
	pinned: boolean;
	/** false: no close button, not closed by ⌘W. */
	closable: boolean;
	/** Your own data, persisted with the tab (JSON). */
	data?: D;
}

export type TabInput<D = unknown> = Partial<Tab<D>> & ({ path: string } | { title: string });

export interface TabsOptions<D = unknown> {
	/** Names the group (saved tabs, element ids): unique per window. */
	id: string;
	/** Tabs are app routes: activating navigates, navigating updates the active tab. */
	route?: boolean;
	/** The window's own tab bar: the window title follows the active tab, a Tab menu and
	 *  ⌘T ⌘W ⇧⌘T ⌃⇥ ⌘1–9, ⌘-click / middle-click on a link opens it in a new tab (route). */
	primary?: boolean;
	/** Save the tabs and restore them at the next launch. Default: `primary`. */
	restore?: boolean;
	/** The tabs to start with (nothing restored). Route groups default to the current page. */
	initial?: TabInput<D>[];
	/** What a new tab is (⌘T, the + button). Without it, no new-tab affordance. */
	create?: () => TabInput<D>;
	/** Closing the last tab: 'window' closes the window (default for `primary`), 'new' opens
	 *  `create()` instead, 'keep' leaves the group empty (default otherwise). */
	onLastClose?: 'window' | 'new' | 'keep';
	/** A route tab's title from its URL. Default: the path. */
	title?: (url: URL) => string;
}

const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';
let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const here = () => location.pathname + location.search + location.hash;

/** A navigation, with SvelteKit's client router when it's there (the desktop plugin exposes it). */
function navigate(path: string) {
	const goto = (globalThis as { __desktopGoto?: (url: string) => unknown }).__desktopGoto;
	if (goto) void goto(path);
	else location.assign(path);
}

/** One `desktop:urlchange` event per client-side navigation (pushState, replaceState, back/forward). */
function watchUrl(fn: () => void): () => void {
	const g = globalThis as { __sdHistoryPatched?: boolean };
	if (!g.__sdHistoryPatched) {
		g.__sdHistoryPatched = true;
		for (const m of ['pushState', 'replaceState'] as const) {
			const original = history[m].bind(history);
			history[m] = (...args: Parameters<History['pushState']>) => {
				original(...args);
				queueMicrotask(() => dispatchEvent(new Event('desktop:urlchange')));
			};
		}
		addEventListener('popstate', () => dispatchEvent(new Event('desktop:urlchange')));
	}
	addEventListener('desktop:urlchange', fn);
	return () => removeEventListener('desktop:urlchange', fn);
}

export class Tabs<D = unknown> {
	items = $state<Tab<D>[]>([]);
	activeId = $state<string | null>(null);
	readonly active = $derived(this.items.find((t) => t.id === this.activeId));
	readonly id: string;
	readonly options: TabsOptions<D>;
	/** Recently closed, newest last (⇧⌘T). */
	#closed: Array<{ tab: Tab<D>; index: number }> = [];
	#connections = 0;

	constructor(options: TabsOptions<D>) {
		this.options = options;
		this.id = options.id;
		const initial = options.initial ?? (options.route && isPage ? [{ path: here() }] : []);
		for (const t of initial) this.items.push(this.#make(t));
		this.activeId = this.items[0]?.id ?? null;
	}

	get canCreate(): boolean {
		return !!this.options.create;
	}

	#make(input: TabInput<D>): Tab<D> {
		const path = input.path;
		const title = input.title ?? (path !== undefined ? this.#titleOf(path) : 'Untitled');
		return { id: input.id ?? newId(), title, path, pinned: input.pinned ?? false, closable: input.closable ?? true, data: input.data };
	}

	#titleOf(path: string): string {
		if (!this.options.title || !isPage) return path;
		return this.options.title(new URL(path, location.origin));
	}

	get(id: string): Tab<D> | undefined {
		return this.items.find((t) => t.id === id);
	}

	/** Open a tab (an existing id is activated instead), right after the active one by default. */
	open(input: TabInput<D>, opts: { activate?: boolean; index?: number } = {}): Tab<D> {
		const existing = input.id ? this.get(input.id) : undefined;
		if (existing) {
			if (opts.activate !== false) this.activate(existing.id);
			return existing;
		}
		const tab = this.#make(input);
		const after = this.items.findIndex((t) => t.id === this.activeId);
		const index = Math.max(this.items.filter((t) => t.pinned).length, Math.min(opts.index ?? (after >= 0 ? after + 1 : this.items.length), this.items.length));
		this.items.splice(index, 0, tab);
		if (opts.activate !== false || !this.activeId) this.activate(tab.id);
		return this.get(tab.id)!;
	}

	/** A new tab from `create()`, at the end (a link opened from a tab goes next to it). */
	new(): Tab<D> | undefined {
		return this.options.create ? this.open(this.options.create(), { index: this.items.length }) : undefined;
	}

	activate(id: string): void {
		const tab = this.get(id);
		if (!tab) return;
		this.activeId = id;
		if (this.options.route && tab.path !== undefined && isPage && tab.path !== here()) navigate(tab.path);
	}

	close(id: string = this.activeId ?? ''): void {
		const index = this.items.findIndex((t) => t.id === id);
		const tab = this.items[index];
		if (!tab || !tab.closable) return;
		this.#closed.push({ tab: $state.snapshot(tab) as Tab<D>, index });
		if (this.#closed.length > 20) this.#closed.shift();
		this.items.splice(index, 1);
		if (this.activeId === id) {
			const next = this.items[index] ?? this.items[index - 1];
			this.activeId = null;
			if (next) this.activate(next.id);
		}
		if (this.items.length) return;
		const last = this.options.onLastClose ?? (this.options.primary ? 'window' : 'keep');
		if (last === 'new') this.new();
		else if (last === 'window' && isPage) void callPlatform('window', 'close').catch(() => {});
	}

	closeOthers(id: string): void {
		for (const t of [...this.items]) if (t.id !== id && !t.pinned) this.close(t.id);
	}

	/** Reopen the last closed tab. */
	reopen(): Tab<D> | undefined {
		const last = this.#closed.pop();
		return last ? this.open(last.tab, { index: last.index }) : undefined;
	}

	/** Activate the next (1) or previous (-1) tab, wrapping around. */
	cycle(step: 1 | -1 = 1): void {
		if (!this.items.length) return;
		const i = this.items.findIndex((t) => t.id === this.activeId);
		this.activate(this.items[(i + step + this.items.length) % this.items.length]!.id);
	}

	move(id: string, to: number): void {
		const from = this.items.findIndex((t) => t.id === id);
		if (from < 0) return;
		const [tab] = this.items.splice(from, 1);
		this.items.splice(Math.max(0, Math.min(to, this.items.length)), 0, tab!);
	}

	update(id: string, patch: Partial<Omit<Tab<D>, 'id'>>): void {
		const tab = this.get(id);
		if (tab) Object.assign(tab, patch);
	}

	/** Wire the group to the page and the window (<TabBar> calls it); returns the cleanup. */
	connect(): () => void {
		if (!isPage || this.#connections++ > 0) return () => void this.#connections--;
		const cleanups: Array<() => void> = [];
		const o = this.options;
		let restored = !(o.restore ?? o.primary);

		// Restore, then save every change.
		if (!restored)
			void readAppFile('userData', `tabs-${this.id}.json`)
				.then((text) => {
					const saved = text ? (JSON.parse(text) as { items: Tab<D>[]; activeId: string | null }) : null;
					if (saved?.items?.length) {
						this.items = saved.items;
						this.activeId = saved.activeId && this.get(saved.activeId) ? saved.activeId : saved.items[0]!.id;
						if (o.route && this.active?.path !== undefined && this.active.path !== here()) navigate(this.active.path);
					}
				})
				.catch(() => {})
				.finally(() => (restored = true));

		cleanups.push(
			$effect.root(() => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				$effect(() => {
					const state = JSON.stringify({ items: this.items, activeId: this.activeId });
					if (!restored || !(o.restore ?? o.primary)) return;
					clearTimeout(timer);
					timer = setTimeout(() => void writeAppFile('userData', `tabs-${this.id}.json`, state).catch(() => {}), 300);
				});
				// The window title follows the active tab.
				$effect(() => {
					const title = this.active?.title;
					if (o.primary && title && platformReady()) void callPlatform('window', 'setTitle', { title }).catch(() => {});
				});
			}),
		);

		// Route tabs follow navigation: the active tab is wherever the page went.
		if (o.route)
			cleanups.push(
				watchUrl(() => {
					const tab = this.active;
					if (tab && tab.path !== here()) {
						tab.path = here();
						if (o.title) tab.title = this.#titleOf(tab.path);
					}
				}),
			);

		if (o.primary) cleanups.push(this.#primary());
		return () => {
			if (--this.#connections > 0) return;
			for (const c of cleanups) c();
		};
	}

	/** The window's tab bar: a Tab menu, shortcuts, links opened in new tabs. */
	#primary(): () => void {
		const cleanups: Array<() => void> = [];
		const act = (id: string): boolean => {
			if (id === 'tabs:new') this.new();
			else if (id === 'tabs:close') this.close();
			else if (id === 'tabs:reopen') this.reopen();
			else if (id === 'tabs:next') this.cycle(1);
			else if (id === 'tabs:previous') this.cycle(-1);
			else return false;
			return true;
		};
		// A Tab menu (before Window): its key equivalents win over the page and the default Close.
		let menu = false;
		if (platformReady()) {
			const items = [
				...(this.canCreate ? [{ id: 'tabs:new', label: 'New Tab', accelerator: 'CmdOrCtrl+T' }] : []),
				{ id: 'tabs:close', label: 'Close Tab', accelerator: 'CmdOrCtrl+W' },
				{ id: 'tabs:reopen', label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T' },
				{ type: 'separator' },
				{ id: 'tabs:next', label: 'Show Next Tab', accelerator: 'Ctrl+Tab' },
				{ id: 'tabs:previous', label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab' },
			];
			void callPlatform('menu', 'insert', { name: 'Tab', items })
				.then(() => (menu = true))
				.catch(() => {});
			// The menu is the app's: only the focused window acts.
			cleanups.push(onPlatform<{ id?: string }>('menuAction', (e) => void (e?.id && document.hasFocus() && act(e.id))));
		}
		const keys = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
				const tab = e.key === '9' ? this.items.at(-1) : this.items[Number(e.key) - 1];
				if (tab) (e.preventDefault(), this.activate(tab.id));
				return;
			}
			if (menu) return; // the menu has them
			const k = e.key.toLowerCase();
			const id =
				e.ctrlKey && k === 'tab' ? (e.shiftKey ? 'tabs:previous' : 'tabs:next')
				: mod && k === 't' ? (e.shiftKey ? 'tabs:reopen' : 'tabs:new')
				: mod && k === 'w' && !e.shiftKey ? 'tabs:close'
				: null;
			if (id && act(id)) e.preventDefault();
		};
		addEventListener('keydown', keys, true);
		cleanups.push(() => removeEventListener('keydown', keys, true));
		// ⌘-click / middle-click on an app link: a new tab, in the background.
		if (this.options.route) {
			const links = (e: MouseEvent) => {
				const newTab = (e.type === 'click' && (e.metaKey || e.ctrlKey)) || (e.type === 'auxclick' && e.button === 1);
				const a = newTab && e.target instanceof Element ? e.target.closest('a[href]') : null;
				if (!(a instanceof HTMLAnchorElement) || a.target || a.origin !== location.origin) return;
				e.preventDefault();
				this.open({ path: a.pathname + a.search + a.hash }, { activate: false });
			};
			addEventListener('click', links, true);
			addEventListener('auxclick', links, true);
			cleanups.push(() => (removeEventListener('click', links, true), removeEventListener('auxclick', links, true)));
		}
		return () => {
			for (const c of cleanups) c();
			if (menu) void callPlatform('menu', 'remove', { name: 'Tab' }).catch(() => {});
		};
	}
}
