// Tabs, for a title-bar tab bar or any tab group inside a page: reactive state (Svelte 5 runes)
// plus the desktop integration — the window title, a Tab menu (⌘T ⌘W ⇧⌘T ⌃⇥), ⌘1–9,
// ⌘-click / middle-click on links, restoring the tabs at launch, dragging a tab out into its
// own window or onto another window's bar. Render them with <TabBar>, <TabContent> (route tabs)
// and <TabPanels> (state tabs), or with your own markup.
//
//   const tabs = new Tabs({ id: 'app', route: true, primary: true, create: () => ({ path: '/' }) });
//
// `route` tabs are app routes: activating one navigates to its path, and navigating changes the
// active tab's path (each tab remembers where it was). Otherwise a tab is plain state.
// `isolated` tabs live in their own web view (their own process): a third-party page (`url`) or
// an app route kept apart from the page.
import { callPlatform, onPlatform, platformReady } from '../platform/bus';
import { readAppFile, writeAppFile } from '../platform/app-files';

export interface Tab<D = unknown> {
	id: string;
	title: string;
	/** An app path (`route` tabs: where the tab is). */
	path?: string;
	/** A page of another site: always `isolated`. */
	url?: string;
	/** In its own web view (its own process), not the page. */
	isolated: boolean;
	/** Kept in place, and out of "close others". */
	pinned: boolean;
	/** false: no close button, not closed by ⌘W. */
	closable: boolean;
	/** Your own data, persisted with the tab (JSON). */
	data?: D;
}

export type TabInput<D = unknown> = Partial<Tab<D>> & ({ path: string } | { url: string } | { title: string });

export interface TabsOptions<D = unknown> {
	/** Names the group (saved tabs, element ids, views): unique per window. */
	id: string;
	/** Tabs are app routes: activating navigates, navigating updates the active tab. */
	route?: boolean;
	/** The window's own tab bar: the window title follows the active tab, a Tab menu and
	 *  ⌘T ⌘W ⇧⌘T ⌃⇥ ⌘1–9, ⌘-click / middle-click on a link opens it in a new tab (route). */
	primary?: boolean;
	/** Save the tabs and restore them at the next launch (the main window's). Default: `primary`. */
	restore?: boolean;
	/** The tabs to start with (nothing restored). Route groups default to the current page. */
	initial?: TabInput<D>[];
	/** What a new tab is (⌘T, the + button). Without it, no new-tab affordance. */
	create?: () => TabInput<D>;
	/** Closing the last tab: 'window' closes the window (default for `primary`), 'new' opens
	 *  `create()` instead, 'keep' leaves the group empty (default otherwise). A window a tab
	 *  was dragged into closes when its last tab leaves. */
	onLastClose?: 'window' | 'new' | 'keep';
	/** A route tab's title from its URL. Default: the path. */
	title?: (url: URL) => string;
	/** Drag a tab out of the bar: into a new window, or onto another window's bar.
	 *  Default: `primary` route groups. */
	detachable?: boolean;
}

const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';
let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const here = () => location.pathname + location.search + location.hash;
const ADOPT = 'tabs:adopt';
const ADOPTED = 'tabs:adopted';
/** A drop this close to another window's top lands on its tab bar. */
const BAR_BAND = 64;
/** A tab handed to the window it was dragged out into (shared storage: the same origin). */
const handoffKey = (group: string, label: string) => `sd-tabs:${group}:${label}`;

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

type WindowInfo = { windowId: number; label: string; focused: boolean; visible?: boolean; bounds: { x: number; y: number; width: number; height: number } };
type Message<T> = { channel?: string; data?: T };

export class Tabs<D = unknown> {
	items = $state<Tab<D>[]>([]);
	activeId = $state<string | null>(null);
	readonly active = $derived(this.items.find((t) => t.id === this.activeId));
	readonly id: string;
	readonly options: TabsOptions<D>;
	/** This page's window label ('main' for the first window), once connected. */
	window = $state<string | null>(null);
	/** This page is an isolated tab's own web view: the group stays local (no menu, nothing
	 *  saved) and <TabBar> renders nothing — drop your chrome too and show the page alone. */
	readonly embedded = isPage && '__desktopView' in globalThis;
	/** Recently closed, newest last (⇧⌘T). */
	#closed: Array<{ tab: Tab<D>; index: number }> = [];
	#connections = 0;
	#disconnect: (() => void) | null = null;
	#windowId: number | undefined;
	/** Whether this window is the focused one (null: not known yet). Window focus, not the
	 *  document's: an isolated tab's web view having the keyboard still counts. */
	#focused: boolean | null = null;
	#style: Promise<{ titleBarStyle?: string }> | undefined;

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

	get #detachable(): boolean {
		return this.options.detachable ?? (!!this.options.primary && !!this.options.route);
	}

	/** Whether a tab can be dragged out of the bar: an app route of a detachable group, closable,
	 *  not isolated (its own web view stays in its window). */
	canDetach(tab: Tab<D>): boolean {
		return this.#detachable && tab.closable && !tab.isolated && tab.path !== undefined;
	}

	#make(input: TabInput<D>): Tab<D> {
		const { path, url } = input;
		const title = input.title ?? (url ?? (path !== undefined ? this.#titleOf(path) : 'Untitled'));
		return {
			id: input.id ?? newId(),
			title,
			path,
			url,
			isolated: input.isolated ?? url !== undefined,
			pinned: input.pinned ?? false,
			closable: input.closable ?? true,
			data: input.data,
		};
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
		// An isolated tab shows its own web view: the page stays where it is.
		if (this.options.route && !tab.isolated && tab.path !== undefined && isPage && tab.path !== here()) navigate(tab.path);
	}

	close(id: string = this.activeId ?? ''): void {
		const tab = this.get(id);
		if (!tab || !tab.closable) return;
		this.#remove(id, 'closed');
	}

	/** Take a tab out, closed or moved to another window. The active one moves on; an empty group
	 *  does what `onLastClose` says — but a window tabs were dragged into closes, and the main
	 *  window a tab was moved out of opens `create()`. */
	#remove(id: string, how: 'closed' | 'moved'): void {
		const index = this.items.findIndex((t) => t.id === id);
		if (index < 0) return;
		if (how === 'closed') {
			this.#closed.push({ tab: $state.snapshot(this.items[index]) as Tab<D>, index });
			if (this.#closed.length > 20) this.#closed.shift();
		}
		this.items.splice(index, 1);
		if (this.activeId === id) {
			const next = this.items[index] ?? this.items[index - 1];
			this.activeId = null;
			if (next) this.activate(next.id);
		}
		if (this.items.length) return;
		const o = this.options;
		const last = o.primary && this.window && this.window !== 'main' ? 'window' : how === 'moved' ? 'new' : (o.onLastClose ?? (o.primary ? 'window' : 'keep'));
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

	/** Move a tab out of this window. With a screen point (a drop), onto the window whose tab bar
	 *  is there — it leaves only once that window took it — else into a new window of its own,
	 *  at that point. The last tab only moves onto another window. */
	async detach(id: string, at?: { x: number; y: number }): Promise<void> {
		const tab = this.get(id);
		if (!tab || !this.canDetach(tab) || !isPage) return;
		try {
			if (at) {
				const windows = await callPlatform<WindowInfo[]>('window', 'list').catch(() => [] as WindowInfo[]);
				const target = windows.find((w) => w.label !== this.window && w.visible !== false && at.x >= w.bounds.x && at.x <= w.bounds.x + w.bounds.width && at.y >= w.bounds.y && at.y <= w.bounds.y + BAR_BAND);
				if (target && (await this.#handOver(tab, target.label))) return this.#remove(id, 'moved');
			}
			if (this.items.length < 2) return;
			const label = `${this.id}-${tab.id}`;
			localStorage.setItem(handoffKey(this.id, label), JSON.stringify($state.snapshot(tab)));
			this.#style ??= callPlatform<{ style: string }>('window', 'getTitleBarStyle')
				.then((s) => (s.style && s.style !== 'default' ? { titleBarStyle: s.style } : {}))
				.catch(() => ({}));
			await callPlatform('window', 'create', {
				label,
				path: tab.path,
				width: innerWidth,
				height: innerHeight,
				...(at && { x: Math.round(at.x - 120), y: Math.round(at.y - 16) }),
				...(await this.#style),
			});
			this.#remove(id, 'moved');
		} catch (e) {
			console.error('[tabs] could not move the tab out', e);
		}
	}

	/** Offer a tab to another window's group; true once that window took it. */
	#handOver(tab: Tab<D>, target: string): Promise<boolean> {
		const nonce = newId();
		return new Promise((resolve) => {
			const done = (ok: boolean) => (off(), clearTimeout(timer), resolve(ok));
			const off = onPlatform<Message<{ nonce: string }>>('message', (m) => void (m?.channel === ADOPTED && m.data?.nonce === nonce && done(true)));
			const timer = setTimeout(() => done(false), 800);
			callPlatform('events', 'emit', { channel: ADOPT, data: { group: this.id, target, nonce, tab: $state.snapshot(tab) } }).catch(() => done(false));
		});
	}

	/** Wire the group to the page and the window (<TabBar> calls it); returns the cleanup. */
	connect(): () => void {
		if (!isPage || this.embedded) return () => {};
		if (this.#connections++ === 0) this.#disconnect = this.#wire();
		return () => {
			if (--this.#connections === 0) this.#disconnect?.();
		};
	}

	#wire(): () => void {
		const cleanups: Array<() => void> = [];
		const o = this.options;
		const persist = o.restore ?? o.primary;
		let restored = false;

		// Which window this is: the main window restores and saves its tabs; a window a tab was
		// dragged into starts from that tab. Without the shell (a browser), it's the main one.
		void (platformReady() ? callPlatform<WindowInfo>('window', 'getInfo') : Promise.resolve(null))
			.then(
				(info) => {
					this.window = info?.label ?? 'main';
					this.#windowId = info?.windowId;
					this.#focused = info?.focused ?? null;
					return this.window === 'main' ? (persist ? this.#restore() : undefined) : this.#adoptHandoff();
				},
				(e) => console.warn('[tabs] window.getInfo failed: the tabs are not saved', e),
			)
			.catch(() => {})
			.finally(() => (restored = true));

		cleanups.push(
			$effect.root(() => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				$effect(() => {
					const state = JSON.stringify({ items: this.items, activeId: this.activeId });
					if (!restored || !persist || this.window !== 'main') return;
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

		cleanups.push(onPlatform<{ windowId: number; focused: boolean }>('focusChanged', (e) => void (e?.windowId === this.#windowId && (this.#focused = e.focused))));

		// Route tabs follow navigation: the active tab is wherever the page went.
		if (o.route)
			cleanups.push(
				watchUrl(() => {
					const tab = this.active;
					if (tab && !tab.isolated && tab.path !== here()) {
						tab.path = here();
						if (o.title) tab.title = this.#titleOf(tab.path);
					}
				}),
			);

		// A tab dropped on this window's bar from another window: take it, say so.
		if (this.#detachable)
			cleanups.push(
				onPlatform<Message<{ group: string; target: string; nonce: string; tab: Tab<D> }>>('message', (m) => {
					const d = m?.channel === ADOPT ? m.data : undefined;
					if (!d || d.group !== this.id || d.target !== this.window) return;
					const { id: _id, ...tab } = d.tab;
					this.open(tab, { index: this.items.length });
					void callPlatform('events', 'emit', { channel: ADOPTED, data: { nonce: d.nonce } }).catch(() => {});
					void callPlatform('window', 'focus').catch(() => {});
				}),
			);

		if (o.primary) cleanups.push(this.#primary());
		return () => {
			for (const c of cleanups) c();
		};
	}

	async #restore(): Promise<void> {
		const text = await readAppFile('userData', `tabs-${this.id}.json`);
		const saved = text ? (JSON.parse(text) as { items: Tab<D>[]; activeId: string | null }) : null;
		if (!saved?.items?.length) return;
		this.items = saved.items.map((t) => ({ ...t, isolated: t.isolated ?? t.url !== undefined }));
		this.activeId = saved.activeId && this.get(saved.activeId) ? saved.activeId : saved.items[0]!.id;
		const active = this.active;
		if (this.options.route && active && !active.isolated && active.path !== undefined && active.path !== here()) navigate(active.path);
	}

	/** The tab this window was opened for, with its title, data and state. */
	#adoptHandoff(): void {
		const key = handoffKey(this.id, this.window!);
		const text = localStorage.getItem(key);
		if (!text) return;
		localStorage.removeItem(key);
		const tab = JSON.parse(text) as Tab<D>;
		this.items = [{ ...tab, path: here() }];
		this.activeId = tab.id;
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
			else if (id === 'tabs:detach' && this.active) void this.detach(this.active.id);
			else if (id.startsWith('tabs:select:')) {
				const n = Number(id.slice('tabs:select:'.length));
				const tab = n === 9 ? this.items.at(-1) : this.items[n - 1];
				if (tab) this.activate(tab.id);
			} else return false;
			return true;
		};
		// A Tab menu (before Window): its key equivalents win over the page — and over an isolated
		// tab's web view, which the page's own key listener doesn't hear. Every window's page
		// inserts the same one (it stays for the others when this page goes); the focused window
		// acts on it.
		let menu = false;
		if (platformReady()) {
			const items = [
				...(this.canCreate ? [{ id: 'tabs:new', label: 'New Tab', accelerator: 'CmdOrCtrl+T' }] : []),
				{ id: 'tabs:close', label: 'Close Tab', accelerator: 'CmdOrCtrl+W' },
				{ id: 'tabs:reopen', label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T' },
				{ type: 'separator' },
				{ id: 'tabs:next', label: 'Show Next Tab', accelerator: 'Ctrl+Tab' },
				{ id: 'tabs:previous', label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab' },
				{
					label: 'Select Tab',
					submenu: [
						...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `tabs:select:${n}`, label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}` })),
						{ id: 'tabs:select:9', label: 'Last Tab', accelerator: 'CmdOrCtrl+9' },
					],
				},
				...(this.#detachable ? [{ type: 'separator' }, { id: 'tabs:detach', label: 'Move Tab to New Window' }] : []),
			];
			void callPlatform('menu', 'insert', { name: 'Tab', items })
				.then(() => (menu = true))
				.catch(() => {});
			cleanups.push(onPlatform<{ id?: string }>('menuAction', (e) => void (e?.id && (this.#focused ?? document.hasFocus()) && act(e.id))));
		}
		// Without the menu (it failed, or a browser): the same keys from the page.
		const keys = (e: KeyboardEvent) => {
			if (menu) return;
			const mod = e.metaKey || e.ctrlKey;
			const k = e.key.toLowerCase();
			const id =
				mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(k) ? `tabs:select:${k}`
				: e.ctrlKey && k === 'tab' ? (e.shiftKey ? 'tabs:previous' : 'tabs:next')
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
		};
	}
}
