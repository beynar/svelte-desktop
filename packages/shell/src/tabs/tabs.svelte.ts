// A tab group: reactive state (Svelte 5 runes) plus the desktop integration — the window title,
// a Tab menu (⌘T ⌘W ⇧⌘T ⌃⇥), ⌘1–9, ⌘-click / middle-click on links, restoring the tabs at
// launch, dragging a tab out into its own window or onto another window's bar. <Tabs> makes one
// on your tabs (bind:tabs, bind:active) and hands it to <TabBar>, <TabContent>, <TabPanels> and
// useTabs(); every change goes through its methods, onto your array.
//
// `route` tabs are app routes: activating one navigates to its path, and navigating changes the
// active tab's path (each tab remembers where it was). Otherwise a tab is plain state.
// `isolated` tabs live in their own web view (their own process): a third-party page (`url`) or
// an app route kept apart from the page. The window's address is the active tab's, a kept-alive
// one's too (page.url, the sidebar): its page isn't rendered in the window, its view shows it.
import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { callPlatform, onPlatform, platformReady } from '../platform/bus';
import { readAppFile, writeAppFile } from '../platform/app-files';
import type { WindowAnimation } from '../platform/index';
import { contentBox, dropView, prepareView, retargetView, whenSettled } from './isolated.ts';

/** A tab: yours, of any shape — an `id`, the fields the bar knows, and your own. */
export interface TabLike {
	id: string;
	/** Default: from `title(url)` for a route tab, else its url or path. */
	title?: string;
	/** An app path: a route tab (activating it navigates there; navigating moves it). */
	path?: string;
	/** A page of another site: always `isolated`. */
	url?: string;
	/** In its own web view (its own process), not the page. Default: `url` tabs. */
	isolated?: boolean;
	/** Kept first, no close button, out of "close others". */
	pinned?: boolean;
	/** false: no close button, not closed by ⌘W. */
	closable?: boolean;
}

/** An in-page tab: a string, or a value and a label plus your own fields. */
export type TabItem = string | { value?: string; label: string; pinned?: boolean; closable?: boolean; [key: string]: any };

/** What a `tab` snippet gets. */
export interface TabRender<Item> {
	/** The tab (a window tab: its path, url, title). */
	tab: TabLike;
	/** Your item (in-page tabs); the tab itself for window tabs. */
	item: Item;
	index: number;
	active: boolean;
	/** Whether it shows a close control. */
	closable: boolean;
	close: () => void;
}

/** A tab before it has an id (one is made). */
export type TabInit<T extends TabLike = TabLike> = Omit<T, 'id'> & { id?: string };

export interface TabsOptions<T extends TabLike = TabLike> {
	/** Names the group: saved tabs, element ids, its windows. Default: 'app' for the window's bar. */
	id?: string;
	/** Tabs are app routes: activating navigates, navigating moves the active tab. */
	route?: boolean;
	/** The window's own tab bar: the window title follows the active tab, a Tab menu and
	 *  ⌘T ⌘W ⇧⌘T ⌃⇥ ⌘1–9, ⌘-click / middle-click on a link opens it in a new tab (route). */
	primary?: boolean;
	/** Save the tabs and restore them at the next launch (the main window's). Default: `primary`. */
	restore?: boolean;
	/** Routes that keep running when their tab isn't shown (SvelteKit route ids: '/chat',
	 *  '/terminal/[id]'): their tabs live in their own web view. */
	keepAlive?: string[];
	/** Tabs can be dragged to another place in the bar. Default true. */
	reorderable?: boolean;
	/** A new tab (⌘T, the + button) — without it, no new-tab affordance. */
	newTab?: () => TabInit<T>;
	/** Drag a tab out of the window: into a new window, or onto another window's bar. A function
	 *  decides per tab. Default: route groups of the window's bar. */
	detachable?: boolean | ((tab: T) => boolean);
	/** How a window a tab was dragged into comes in (macOS): `true` (default), `false`, or your own. */
	windowAnimation?: boolean | WindowAnimation;
	/** Keep a view ready for the next kept-alive tab (one web process, ~40 MB): it opens without
	 *  starting a process or the app — any kept-alive route, by SvelteKit's router. */
	prewarm?: boolean;
	/** Views running at once (kept-alive tabs, other sites): beyond, the least recently shown one is
	 *  suspended — its page loads again when shown. The system short of memory suspends every
	 *  hidden one. Default: no limit. */
	maxViews?: number;
	/** A tab is closing (×, ⌘W, a middle click): return false to keep it. */
	onclose?: (tab: T) => boolean | void;
	/** Another tab became the active one: 'user' (a click, a key, a link, your code) or
	 *  'missing' (the active one was closed or left). */
	onactivate?: (tab: T, reason: 'user' | 'missing') => void;
	/** A tab moved to `index` (dragged in the bar). */
	onmove?: (tab: T, index: number) => void;
	/** A tab left for another window. */
	ondetach?: (tab: T) => void;
}

/** Where the tabs live: the <Tabs> props (bind:tabs, bind:active). */
export interface TabStore<T> {
	items: T[] | undefined;
	active: string | undefined;
}

const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';
let seq = 0;
let groups = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const here = () => location.pathname + location.search + location.hash;
/** The page's address, reactive: set as history changes, before SvelteKit renders the page. */
const address = $state({ path: isPage ? here() : '/' });
const ADOPTED = 'tabs:adopted';
/** A tab handed to the window it was dragged out into (shared storage: the same origin). */
const handoffKey = (group: string, label: string) => `sd-tabs:${group}:${label}`;

/** This page is a kept-alive tab's own web view (the app again, in its own process): render the
 *  page alone there. */
export const embedded = isPage && '__desktopView' in globalThis;

/** Rendering for a kept-alive tab's view: in its page, or on the server for a request it made
 *  (X-Desktop-View) — so the server renders what the view shows. */
export function forView(): boolean {
	return embedded || (!isPage && !!(globalThis as { __desktopViewRequest?: () => string | undefined }).__desktopViewRequest?.());
}

/** A navigation, with SvelteKit's client router when it's there (the desktop plugin exposes it). */
function navigate(path: string) {
	const goto = (globalThis as { __desktopGoto?: (url: string) => unknown }).__desktopGoto;
	if (goto) void goto(path);
	else location.assign(path);
}

/** A tab of the page at `path`: the page SvelteKit has already (the window was at a kept-alive
 *  tab's address), the address alone; else a navigation. */
function goTo(path: string) {
	const page = (globalThis as { __desktopPageUrl?: () => string | undefined }).__desktopPageUrl?.();
	if (page === path) showAddress(path);
	else navigate(path);
}

/** The window at a kept-alive tab's address without navigating there — no load, no page code (its
 *  view runs the page); page.url, your sidebar follow. Without the desktop plugin: a navigation. */
function showAddress(path: string) {
	const set = (globalThis as { __desktopAddress?: (url: string) => void }).__desktopAddress;
	if (!set) return navigate(path);
	set(path);
	address.path = here();
	dispatchEvent(new Event('desktop:urlchange'));
}

/** A SvelteKit route id ('/terminal/[id]', '/docs/[...rest]', '/(app)/[[lang]]/home') as a
 *  matcher of paths. */
export function routeMatcher(id: string): RegExp {
	let re = '';
	for (const part of id.split('/').filter(Boolean)) {
		if (/^\(.+\)$/.test(part)) continue; // (group): not in the URL
		if (/^\[\.\.\.\w+(=\w+)?\]$/.test(part)) re += '(?:/.*)?';
		else if (/^\[\[\w+(=\w+)?\]\]$/.test(part)) re += '(?:/[^/]+)?';
		else re += '/' + part.replace(/[.+?^${}()|\\]/g, '\\$&').replace(/\[\w+(=\w+)?\]/g, '[^/]+');
	}
	return new RegExp(`^${re || '/'}/?$`);
}
const pathOnly = (path: string) => path.replace(/[?#].*$/, '');

/** SvelteKit's preload levels, from its link options. */
const PRELOAD = { off: 0, tap: 1, hover: 2 } as const;
/** How eagerly SvelteKit preloads a link: the nearest data-sveltekit-preload-data / -code on it or
 *  an ancestor, the stronger of the two ('' is 'hover'; 'viewport' and 'eager' count as 'hover'). */
function preloadLevel(a: Element): number {
	const level = (name: string) => {
		const value = a.closest(`[data-sveltekit-preload-${name}]`)?.getAttribute(`data-sveltekit-preload-${name}`);
		return value == null || value === 'false' || value === 'off' ? PRELOAD.off : value === 'tap' ? PRELOAD.tap : PRELOAD.hover;
	};
	return Math.max(level('data'), level('code'));
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
				address.path = here();
				queueMicrotask(() => dispatchEvent(new Event('desktop:urlchange')));
			};
		}
		addEventListener('popstate', () => ((address.path = here()), dispatchEvent(new Event('desktop:urlchange'))));
	}
	addEventListener('desktop:urlchange', fn);
	return () => removeEventListener('desktop:urlchange', fn);
}

type Rect = { x: number; y: number; width: number; height: number };
type WindowInfo = { windowId: number; label: string; focused: boolean; visible?: boolean; bounds: Rect };
type Message<T> = { channel?: string; data?: T };

export class TabGroup<T extends TabLike = TabLike> {
	readonly id: string;
	#options: () => TabsOptions<T>;
	#store: TabStore<T>;
	/** This page's window label ('main' for the first window), once connected. */
	window = $state<string | null>(null);
	/** This page is an isolated tab's own web view: the group stays local (no menu, nothing
	 *  saved) and <TabBar> renders nothing — drop your chrome too and show the page alone. */
	readonly embedded = embedded;
	/** The tab on screen: the active one once its content is there — the page at its path, its
	 *  own view drawn — until then the one before (never a blank between two tabs). */
	shown = $state<string | null>(null);
	/** The last tab of the page shown (where a link followed from a kept-alive tab goes). */
	#lastPage: string | null = null;
	/** Tabs in their own view whose view is suspended (closed to free memory): it loads again when
	 *  the tab is shown. */
	readonly suspended = new SvelteSet<string>();
	/** Tabs in their own view, least recently shown first (which to suspend). */
	#recent: string[] = [];
	/** The view kept ready for the next kept-alive tab (`prewarm`): its tab's id, the page it's at. */
	#spare: { tab: string; path: string } | null = null;
	/** The next spare, made a moment after the last one was taken. */
	#warmTimer: ReturnType<typeof setTimeout> | undefined;
	/** A view made ahead for a kept-alive route about to open (a hovered link): its tab's id. */
	#ahead: { path: string; tab: string; timer: ReturnType<typeof setTimeout> } | null = null;
	/** Recently closed, newest last (⇧⌘T). */
	#closed: Array<{ tab: T; index: number }> = [];
	#connections = 0;
	#disconnect: (() => void) | null = null;
	#windowId: number | undefined;
	/** Whether this window is the focused one (null: not known yet). Window focus, not the
	 *  document's: an isolated tab's web view having the keyboard still counts. */
	#focused: boolean | null = null;
	#style: Promise<{ titleBarStyle?: string }> | undefined;
	/** The tab being dragged out (its handoff), and whether another window took it. */
	#outgoing: { id: string; adopted: boolean; off: () => void } | null = null;

	/** `options` are read each time they're used (live props); the tabs live in `store`. */
	constructor(options: () => TabsOptions<T>, store: TabStore<T> = { items: undefined, active: undefined }) {
		this.#options = options;
		this.#store = store;
		const o = this.options;
		this.id = o.id ?? (o.primary ? 'app' : `tabs-${++groups}`);
		// A route group starts on the page it's on.
		if (!this.items.length && o.route && isPage) this.items = [{ id: newId(), path: here() } as T];
		if (!this.active) this.activeId = this.items[0]?.id ?? null;
		if (this.active) this.#show(this.active);
	}

	get options(): TabsOptions<T> {
		return this.#options();
	}

	/** The tabs, in order (your array, with bind:tabs). */
	get items(): T[] {
		return this.#store.items ?? [];
	}
	set items(items: T[]) {
		this.#store.items = items;
	}

	get activeId(): string | null {
		return this.#store.active ?? null;
	}
	set activeId(id: string | null) {
		this.#store.active = id ?? undefined;
	}

	get active(): T | undefined {
		return this.get(this.activeId ?? '');
	}

	get(id: string): T | undefined {
		return this.items.find((t) => t.id === id);
	}

	/** What the bar shows for a tab: its title (a route tab's is its page's <title>), else its
	 *  address. */
	titleOf(tab: T): string {
		return tab.title || tab.url || tab.path || 'Untitled';
	}

	/** In its own web view: another site, a kept-alive route, or `isolated`. */
	isIsolated(tab: T): boolean {
		return tab.isolated ?? (tab.url !== undefined || (tab.path !== undefined && this.keepsAlive(tab.path)));
	}

	/** Whether the page is on screen (not a tab's own view). */
	get pageShown(): boolean {
		const tab = this.get(this.shown ?? '');
		return !tab || !this.isIsolated(tab);
	}

	/** Whether the page renders: not at the address of a tab in its own view (a kept-alive route,
	 *  an isolated tab) — its view runs that page. */
	get pageRendered(): boolean {
		if (!this.options.route) return true;
		const path = address.path;
		return !this.keepsAlive(path) && !this.items.some((t) => t.path === path && (t.id === this.activeId || t.id === this.shown) && this.isIsolated(t));
	}

	/** Whether a path is one of the `keepAlive` routes. */
	keepsAlive(path: string): boolean {
		const routes = this.options.keepAlive;
		return !!routes?.length && routes.some((id) => routeMatcher(id).test(pathOnly(path)));
	}

	get canReorder(): boolean {
		return this.options.reorderable ?? true;
	}

	isClosable(tab: T): boolean {
		return tab.closable ?? true;
	}

	get canCreate(): boolean {
		return !!this.options.newTab;
	}

	#detachable(tab?: T): boolean {
		const d = this.options.detachable ?? (!!this.options.primary && !!this.options.route);
		return typeof d === 'function' ? (tab ? d(tab) : true) : d;
	}

	/** Whether a tab can leave the window: an app route of a detachable group, closable, not
	 *  isolated (its own web view stays in its window). */
	canDetach(tab: T): boolean {
		return this.isClosable(tab) && !this.isIsolated(tab) && tab.path !== undefined && this.#detachable(tab);
	}

	/** Open a tab — a path or a URL, or a tab — right after the active one by default. An existing
	 *  id is activated instead, and so is a kept-alive route already open unless `reuse: false`
	 *  (another one: ⌘-click, a middle click, target="_blank"). */
	open(target: string | TabInit<T>, opts: { activate?: boolean; background?: boolean; index?: number; reuse?: boolean } = {}): T {
		const init = (typeof target === 'string' ? (/^[a-z][a-z0-9+.-]*:/i.test(target) ? { url: target } : { path: target }) : target) as TabInit<T>;
		if (opts.background) opts = { ...opts, activate: false };
		const kept = opts.reuse !== false && init.path !== undefined && this.keepsAlive(init.path);
		const existing = init.id ? this.get(init.id) : kept ? this.items.find((t) => t.path !== undefined && pathOnly(t.path) === pathOnly(init.path!)) : undefined;
		if (existing) {
			if (opts.activate !== false) this.activate(existing.id);
			return existing;
		}
		const tab = { ...init, id: init.id ?? this.#takeAhead(init.path) ?? this.#takeSpare(init.path) ?? newId() } as T;
		const items = this.items;
		const after = items.findIndex((t) => t.id === this.activeId);
		const index = Math.max(items.filter((t) => t.pinned).length, Math.min(opts.index ?? (after >= 0 ? after + 1 : items.length), items.length));
		this.items = [...items.slice(0, index), tab, ...items.slice(index)];
		if (opts.activate !== false || !this.activeId) this.activate(tab.id);
		if (this.isIsolated(tab)) this.#used(tab.id);
		return this.get(tab.id) ?? tab;
	}

	/** Make the view of a kept-alive route ahead (a link to it hovered): opened within a while,
	 *  its tab shows at once. Not when a click would go to its open tab. */
	prepare(path: string): void {
		if (!isPage || !platformReady() || embedded || !this.keepsAlive(path) || this.#ahead?.path === path || this.#spare?.path === path) return;
		if (this.items.some((t) => t.path === path && this.isIsolated(t))) return;
		this.#dropAhead();
		const tab = newId();
		this.#ahead = { path, tab, timer: setTimeout(() => this.#dropAhead(), 5_000) };
		prepareView(`${this.id}-${tab}`, path, contentBox());
	}

	#takeAhead(path: string | undefined): string | undefined {
		const a = this.#ahead;
		if (!a || a.path !== path) return;
		clearTimeout(a.timer);
		this.#ahead = null;
		return a.tab;
	}

	#dropAhead(): void {
		if (!this.#ahead) return;
		clearTimeout(this.#ahead.timer);
		dropView(`${this.id}-${this.#ahead.tab}`);
		this.#ahead = null;
	}

	/** A new tab from `newTab()`, at the end (a link opened from a tab goes next to it). */
	new(): T | undefined {
		const init = this.options.newTab?.();
		return init ? this.open(init, { index: this.items.length }) : undefined;
	}

	activate(id: string, reason: 'user' | 'missing' = 'user'): void {
		const tab = this.get(id);
		if (!tab) return;
		const changed = this.activeId !== id;
		this.activeId = id;
		// A tab of the page is shown once the page is at its path; an isolated tab once its view
		// is drawn (see reveal).
		if (!this.isIsolated(tab)) {
			if (this.options.route && tab.path !== undefined && isPage && tab.path !== here()) goTo(tab.path);
			else this.#show(tab);
		}
		if (changed) this.options.onactivate?.(tab, reason);
	}

	/** An isolated tab's view is on screen (drawn, in front): it's the one shown, and the window's
	 *  address follows it. */
	reveal(id: string): void {
		const tab = this.get(id);
		if (!tab || this.activeId !== id) return;
		this.#show(tab);
		if (this.options.route && tab.path !== undefined && isPage && tab.path !== here()) showAddress(tab.path);
	}

	#show(tab: T): void {
		this.shown = tab.id;
		if (!this.isIsolated(tab)) this.#lastPage = tab.id;
		else this.#used(tab.id);
	}

	/** A tab in its own view was opened or shown: running again, and within `maxViews`. */
	#used(id: string): void {
		this.suspended.delete(id);
		this.#recent = [...this.#recent.filter((r) => r !== id && this.get(r)), id];
		this.#limit();
	}

	/** Within `maxViews`: the least recently shown views beyond it suspended (never the one on
	 *  screen or the active one). */
	#limit(): void {
		const max = this.options.maxViews;
		if (max === undefined) return;
		const running = this.#recent.filter((r) => !this.suspended.has(r));
		for (const r of running.slice(0, Math.max(0, running.length - max))) if (r !== this.activeId && r !== this.shown) this.suspended.add(r);
	}

	/** Free memory: every view not on screen suspended, nothing made ahead. */
	#relieve(): void {
		for (const t of this.items) if (this.isIsolated(t) && t.id !== this.activeId && t.id !== this.shown) this.suspended.add(t.id);
		clearTimeout(this.#warmTimer);
		this.#dropAhead();
		this.#dropSpare();
	}

	/** Keep a view ready for the next kept-alive tab (`prewarm`): at a kept-alive route not open
	 *  (taken as is), else at the app's root (taken to the tab's route). */
	#warm(): void {
		const o = this.options;
		if (!this.#connections || !o.prewarm || !o.keepAlive?.length || this.#spare || !isPage || embedded || !platformReady()) return;
		const fixed = o.keepAlive
			.filter((id) => !id.includes('['))
			.map((id) => '/' + id.split('/').filter((p) => p && !/^\(.+\)$/.test(p)).join('/'))
			.find((path) => !this.items.some((t) => t.path !== undefined && pathOnly(t.path) === path));
		const tab = newId();
		this.#spare = { tab, path: fixed ?? '/' };
		prepareView(`${this.id}-${tab}`, this.#spare.path, contentBox());
	}

	#takeSpare(path: string | undefined): string | undefined {
		const spare = this.#spare;
		if (!spare || path === undefined || !this.keepsAlive(path)) return;
		this.#spare = null;
		retargetView(`${this.id}-${spare.tab}`, path);
		clearTimeout(this.#warmTimer);
		this.#warmTimer = setTimeout(() => this.#warm(), 1000); // the next one, once this tab is up
		return spare.tab;
	}

	#dropSpare(): void {
		if (!this.#spare) return;
		dropView(`${this.id}-${this.#spare.tab}`);
		this.#spare = null;
	}

	/** Close a tab (the active one by default), unless `onclose` keeps it. The main window's bar
	 *  keeps its last tab when there's no `newTab` to replace it. */
	close(id: string = this.activeId ?? ''): void {
		const tab = this.get(id);
		if (!tab || !this.isClosable(tab)) return;
		const o = this.options;
		if (o.primary && this.items.length === 1 && this.window !== null && this.window === 'main' && !o.newTab) return;
		if (o.onclose?.(tab) === false) return;
		this.#remove(id, 'closed');
	}

	/** Take a tab out, closed or moved to another window; the active one moves on. A window tabs
	 *  were dragged into closes with its last tab; the main window's bar opens `newTab()`. */
	#remove(id: string, how: 'closed' | 'moved'): void {
		const items = this.items;
		const index = items.findIndex((t) => t.id === id);
		if (index < 0) return;
		if (how === 'closed') {
			this.#closed.push({ tab: $state.snapshot(items[index]) as T, index });
			if (this.#closed.length > 20) this.#closed.shift();
		}
		const rest = items.filter((t) => t.id !== id);
		this.items = rest;
		this.suspended.delete(id);
		if (this.activeId === id) {
			const next = rest[index] ?? rest[index - 1];
			this.activeId = null;
			if (next) this.activate(next.id, 'missing');
		}
		if (rest.length || !this.options.primary) return;
		if (this.window && this.window !== 'main') void callPlatform('window', 'close').catch(() => {});
		else this.new();
	}

	closeOthers(id: string): void {
		for (const t of this.items) if (t.id !== id && !t.pinned) this.close(t.id);
	}

	/** Reopen the last closed tab. */
	reopen(): T | undefined {
		const last = this.#closed.pop();
		return last ? this.open(last.tab, { index: last.index }) : undefined;
	}

	/** Activate the next (1) or previous (-1) tab, wrapping around. */
	cycle(step: 1 | -1 = 1): void {
		const items = this.items;
		if (!items.length) return;
		const i = items.findIndex((t) => t.id === this.activeId);
		this.activate(items[(i + step + items.length) % items.length]!.id);
	}

	move(id: string, to: number): void {
		const tab = this.get(id);
		if (!tab) return;
		const rest = this.items.filter((t) => t.id !== id);
		const index = Math.max(0, Math.min(to, rest.length));
		this.items = [...rest.slice(0, index), tab, ...rest.slice(index)];
		this.options.onmove?.(tab, index);
	}

	update(id: string, patch: Partial<Omit<T, 'id'>>): void {
		if (this.get(id)) this.items = this.items.map((t) => (t.id === id ? ({ ...t, ...patch } as T) : t));
	}

	/** Open a tab in a new window of its own (at a screen point), and take it out of this one —
	 *  with its title, data and state. The last tab stays. */
	async detach(id: string, at?: { x: number; y: number }): Promise<void> {
		const tab = this.get(id);
		if (!tab || !this.canDetach(tab) || !isPage || this.items.length < 2) return;
		try {
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
				animate: this.options.windowAnimation ?? true,
			});
			this.#remove(id, 'moved');
			this.options.ondetach?.(tab);
		} catch (e) {
			console.error('[tabs] could not open the tab in a new window', e);
		}
	}

	/** What a tab dragged out of the bar carries (<TabBar> puts it on the drag): another window's
	 *  bar can take it — see `receive`. */
	handoff(id: string): string {
		this.#outgoing?.off();
		const nonce = newId();
		const out = { id, adopted: false, off: () => {} };
		out.off = onPlatform<Message<{ nonce: string }>>('message', (m) => void (m?.channel === ADOPTED && m.data?.nonce === nonce && (out.adopted = true)));
		this.#outgoing = out;
		return JSON.stringify({ group: this.id, nonce, tab: $state.snapshot(this.get(id)) });
	}

	/** A dragged tab was let go: on this window's bar (`at` null: nothing to do), else away from
	 *  it — it moved if another window's bar took it, otherwise it opens in a new window there. */
	async release(id: string, at: { x: number; y: number } | null): Promise<void> {
		const out = this.#outgoing?.id === id ? this.#outgoing : null;
		this.#outgoing = null;
		if (!out) return;
		try {
			// The pointer, from the system (the drag's own end point is the drag image's); over
			// another window, that window's bar may have taken the tab: it says so through the
			// app, a few ms after the drop.
			let over = false;
			if (at) {
				const [cursor, windows] = await Promise.all([
					callPlatform<{ x: number; y: number }>('screen', 'getCursorScreenPoint').catch(() => at!),
					callPlatform<WindowInfo[]>('window', 'list').catch(() => [] as WindowInfo[]),
				]);
				at = cursor;
				over = windows.some((w) => w.label !== this.window && w.visible !== false && cursor.x >= w.bounds.x && cursor.x <= w.bounds.x + w.bounds.width && cursor.y >= w.bounds.y && cursor.y <= w.bounds.y + w.bounds.height);
			}
			for (let i = 0; over && !out.adopted && i < 10; i++) await new Promise((r) => setTimeout(r, 30));
			const tab = this.get(id);
			if (out.adopted && tab) {
				this.#remove(id, 'moved');
				this.options.ondetach?.(tab);
			} else if (at) await this.detach(id, at);
		} finally {
			out.off();
		}
	}

	/** A tab dragged here from another window's bar (its `handoff`), opened at `index`. */
	receive(handoff: string, index?: number): boolean {
		const d = JSON.parse(handoff) as { group: string; nonce: string; tab: T };
		if (d.group !== this.id || !this.#detachable()) return false;
		this.open({ ...d.tab, id: this.get(d.tab.id) ? undefined : d.tab.id }, { index });
		void callPlatform('events', 'emit', { channel: ADOPTED, data: { nonce: d.nonce } }).catch(() => {});
		void callPlatform('window', 'focus').catch(() => {});
		return true;
	}

	/** Whether tabs dragged from other windows can land here. */
	get canReceive(): boolean {
		return this.#detachable();
	}

	/** Wire the group to the page and the window (<Tabs> does); returns the cleanup. */
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
		let connected = true;
		let warm = true; // false once memory ran short: no spare made again

		// Which window this is: the main window restores and saves its tabs; a window a tab was
		// dragged into starts from that tab. Without the shell (a browser), it's the main one.
		void (platformReady() ? callPlatform<WindowInfo>('window', 'getInfo') : Promise.resolve(null))
			.then(
				(info) => {
					if (!connected) return;
					this.window = info?.label ?? 'main';
					this.#windowId = info?.windowId;
					this.#focused = info?.focused ?? null;
					return this.window === 'main' ? (persist ? this.#restore() : undefined) : this.#adoptHandoff();
				},
				(e) => console.warn('[tabs] window.getInfo failed: the tabs are not saved', e),
			)
			.catch(() => {})
			.finally(() => {
				if (!connected) return;
				restored = true;
				void whenSettled().then(() => void (connected && warm && this.#warm())); // after the window's page
				if (o.route) this.#syncTitle(); // the restored / handed-over tab is this page
			});

		cleanups.push(
			$effect.root(() => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				let save: (() => void) | undefined;
				$effect(() => {
					// `start`: where the window opens next time (the shell reads it): the active tab's
					// page, or the last page shown under a tab in its own view (its view comes over it).
					const active = this.active;
					const page = active && !this.isIsolated(active) ? active : this.get(this.#lastPage ?? '');
					const state = JSON.stringify({ items: this.items, activeId: this.activeId, start: page?.path ?? '/' });
					if (!restored || !persist || this.window !== 'main') return;
					clearTimeout(timer);
					save = () => void writeAppFile('userData', `tabs-${this.id}.json`, state).catch(() => {});
					timer = setTimeout(() => (save?.(), (save = undefined)), 300);
				});
				// The window title follows the active tab.
				$effect(() => {
					const active = this.active;
					const title = active && this.titleOf(active);
					if (o.primary && title && platformReady()) void callPlatform('window', 'setTitle', { title }).catch(() => {});
				});
				// Disconnected: a save still waiting goes out now.
				return () => (clearTimeout(timer), save?.());
			}),
		);

		cleanups.push(onPlatform<{ windowId: number; focused: boolean }>('focusChanged', (e) => void (e?.windowId === this.#windowId && (this.#focused = e.focused))));

		// Route tabs follow navigation: the active tab is wherever the page went.
		if (o.route)
			cleanups.push(
				watchUrl(() => {
					const tab = this.active;
					const to = here();
					if (!tab || (this.isIsolated(tab) && tab.path === to)) return;
					// A kept-alive route reached by goto / back: its own tab (the open one or a new
					// one) — the tab you were on stays where it was.
					if (this.keepsAlive(to)) return void this.open(to);
					// Away from a kept-alive tab (a link, back): to a tab of the page — the one at
					// that address, else the last one shown, else a new one.
					if (this.isIsolated(tab)) {
						const page = this.items.find((t) => !this.isIsolated(t) && t.path === to) ?? this.get(this.#lastPage ?? '');
						if (!page) return void this.open(to);
						if (page.path !== to) this.update(page.id, { path: to, title: undefined } as Partial<Omit<T, 'id'>>);
						return this.activate(page.id);
					}
					if (tab.path !== to) this.update(tab.id, { path: to, title: undefined } as Partial<Omit<T, 'id'>>);
					this.#show(tab);
				}),
			);

		// A route tab's title is its page's <title>.
		if (o.route) {
			const observer = new MutationObserver(() => this.#syncTitle());
			observer.observe(document.head, { subtree: true, childList: true, characterData: true });
			queueMicrotask(() => this.#syncTitle());
			cleanups.push(() => observer.disconnect());
		}

		// The system short of memory: views not on screen are suspended.
		cleanups.push(onPlatform('memoryPressure', () => ((warm = false), this.#relieve())));
		// Disconnected: nothing left behind (the spare, a view made ahead, a tab on its way out).
		cleanups.push(() => {
			clearTimeout(this.#warmTimer);
			this.#dropAhead();
			this.#dropSpare();
			this.#outgoing?.off();
			this.#outgoing = null;
		});

		if (o.primary) cleanups.push(this.#primary());
		return () => {
			connected = false;
			for (const c of cleanups) c();
		};
	}

	/** The active route tab takes the page's <title>. */
	#syncTitle(): void {
		const tab = this.active;
		const title = document.title.trim();
		if (tab && !this.isIsolated(tab) && tab.path === here() && title && tab.title !== title) this.update(tab.id, { title } as Partial<Omit<T, 'id'>>);
	}

	async #restore(): Promise<void> {
		const text = await readAppFile('userData', `tabs-${this.id}.json`);
		const saved = text ? (JSON.parse(text) as { items: T[]; activeId: string | null }) : null;
		if (!saved?.items?.length) return;
		this.items = saved.items;
		this.activeId = saved.activeId && this.get(saved.activeId) ? saved.activeId : saved.items[0]!.id;
		// Tabs in their own view, the active one most recent: within `maxViews` from the start.
		const own = this.items.filter((t) => this.isIsolated(t)).map((t) => t.id);
		this.#recent = [...own.filter((id) => id !== this.activeId), ...own.filter((id) => id === this.activeId)];
		this.#limit();
		const active = this.active;
		if (active && !this.isIsolated(active)) return this.activate(active.id);
		// The window opened at the page under it (`start`): that page's tab stays on screen until
		// the active tab's view is drawn.
		const page = this.items.find((t) => !this.isIsolated(t) && t.path === here());
		if (page) this.#show(page);
	}

	/** The tab this window was opened for, with its title, data and state. */
	#adoptHandoff(): void {
		const key = handoffKey(this.id, this.window!);
		const text = localStorage.getItem(key);
		if (!text) return;
		localStorage.removeItem(key);
		const tab = JSON.parse(text) as T;
		this.items = [{ ...tab, path: here() }];
		this.activeId = tab.id;
		this.#show(this.get(tab.id)!);
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
				...(this.#detachable() ? [{ type: 'separator' }, { id: 'tabs:detach', label: 'Move Tab to New Window' }] : []),
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
			// App links: ⌘-click / middle click → a tab in the background, target="_blank" → a tab in
			// front, a kept-alive route → its own tab (the one already open, or a new one).
			const links = (e: MouseEvent) => {
				if (e.defaultPrevented || (e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return;
				const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
				if (!(a instanceof HTMLAnchorElement) || a.origin !== location.origin || a.hasAttribute('download')) return;
				const path = a.pathname + a.search + a.hash;
				const background = e.type === 'auxclick' || e.metaKey || e.ctrlKey;
				const blank = a.target === '_blank';
				// The page SvelteKit has, the window at a kept-alive tab's address: the address alone
				// (SvelteKit would see no change).
				if (!background && !blank && !a.target && path !== here() && path === (globalThis as { __desktopPageUrl?: () => string }).__desktopPageUrl?.()) {
					e.preventDefault();
					return showAddress(path);
				}
				if (!background && !blank && !this.keepsAlive(path)) return;
				if (a.target && !blank) return;
				e.preventDefault();
				this.open(path, { background, reuse: !background && !blank });
			};
			addEventListener('click', links, true);
			addEventListener('auxclick', links, true);
			cleanups.push(() => (removeEventListener('click', links, true), removeEventListener('auxclick', links, true)));
			// A link to a kept-alive route makes its view ahead when SvelteKit would preload it
			// (data-sveltekit-preload-data / -code): 'hover' once the pointer rests on it, 'tap' when
			// pressed, never with 'false' / 'off' or neither attribute.
			let resting: ReturnType<typeof setTimeout> | undefined;
			const ahead = (e: PointerEvent) => {
				clearTimeout(resting);
				const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
				if (!(a instanceof HTMLAnchorElement) || a.origin !== location.origin || a.hasAttribute('download')) return;
				const path = a.pathname + a.search + a.hash;
				const level = preloadLevel(a);
				if (e.type === 'pointerdown' ? level >= PRELOAD.tap : level >= PRELOAD.hover) resting = setTimeout(() => this.prepare(path), e.type === 'pointerdown' ? 0 : 50);
			};
			const away = () => clearTimeout(resting);
			addEventListener('pointerover', ahead, true);
			addEventListener('pointerdown', ahead, true);
			addEventListener('pointerout', away, true);
			cleanups.push(() => {
				away();
				removeEventListener('pointerover', ahead, true);
				removeEventListener('pointerdown', ahead, true);
				removeEventListener('pointerout', away, true);
				this.#dropAhead();
			});
		}
		return () => {
			for (const c of cleanups) c();
		};
	}
}

const KEY = Symbol('svelte-desktop tabs');

/** <Tabs> hands its group to everything inside it. */
export function setTabs<T extends TabLike>(group: TabGroup<T>): TabGroup<T> {
	return setContext(KEY, group);
}

/** The group of the nearest <Tabs> around this component: its tabs, `open`, `close`, … */
export function useTabs<T extends TabLike = TabLike & Record<string, any>>(): TabGroup<T> {
	const group = getContext<TabGroup<T> | undefined>(KEY);
	if (!group) throw new Error('useTabs(): no <Tabs> around this component');
	return group;
}
