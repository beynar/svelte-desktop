// A tab group: reactive state (Svelte 5 runes) plus the desktop integration — the window title,
// a Tab menu (⌘T ⌘W ⇧⌘T ⌃⇥), ⌘1–9, ⌘-click / middle-click on links, restoring the tabs at
// launch, dragging a tab out into its own window or onto another window's bar. <WindowTabs> makes
// one and hands it to <TabBar>, <TabContent> and useTabs(); every change goes through its methods.
//
// A tab is an app route: activating it navigates to its path, and navigating changes the active
// tab's path (each tab remembers where it was).
// `isolated` tabs live in their own web view (their own process): a third-party page (`url`) or
// an app route kept apart from the page. The window's address is the active tab's, a kept-alive
// one's too (page.url, the sidebar): its page isn't rendered in the window, its view shows it.
import { getContext, setContext, tick } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { callPlatform, onPlatform, platformReady, reducesMotion, STATE_CHANNEL, watchPlatformOp } from '../platform/bus';
import { readAppFile, writeAppFile } from '../platform/app-files';
import type { WindowAnimation } from '../platform/index';
import { whenStopped } from './panes-drag.ts';
import { contentBox, deliverState, dropView, forgetMissed, navigateView, prepareView, navigationTaken, retargetView, viewComing, whenSettled, type GotoOptions } from './isolated.ts';
import { PaneLayout, type PaneZone } from './panes.svelte.ts';

/** A tab: yours, of any shape — an `id`, the fields the bar knows, and your own. */
export interface TabLike {
	id: string;
	/** Default: its page's <title>, else its url or path. */
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

/** What a `tab` snippet gets. */
export interface TabRender {
	/** The tab: its path, url, title. */
	tab: TabLike;
	index: number;
	active: boolean;
	/** Whether it shows a close control. */
	closable: boolean;
	close: () => void;
}

/** A tab before it has an id (one is made). */
export type TabInit<T extends TabLike = TabLike> = Omit<T, 'id'> & { id?: string };

export interface TabsOptions<T extends TabLike = TabLike> {
	/** Save the tabs and restore them at the next launch (the main window's). Default: true. */
	restore?: boolean;
	/** Routes that keep running when their tab isn't shown (SvelteKit route ids: '/chat',
	 *  '/terminal/[id]'): their tabs live in their own web view. */
	keepAlive?: string[];
	/** Split the window into panes: every tab in its own web view, its pane a place on screen. */
	split?: boolean;
	/** Tabs can be dragged to another place in the bar. Default true. */
	reorderable?: boolean;
	/** A new tab (⌘T, the + button) — without it, no new-tab affordance. */
	newTab?: () => TabInit<T>;
	/** Drag a tab out of the window: into a new window, or onto another window's bar. A function
	 *  decides per tab. Default: true. */
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

/** Where the tabs live: the <WindowTabs> state. */
export interface TabStore<T> {
	items: T[] | undefined;
	active: string | undefined;
}

const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';

/** How the window of a tab dragged out comes in: not moving when the system asks for less motion. */
export const windowAnimation = (wanted?: boolean | WindowAnimation): boolean | WindowAnimation => (reducesMotion() ? false : (wanted ?? true));
let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const here = () => location.pathname + location.search + location.hash;
/** The page's address, reactive: set as history changes, before SvelteKit renders the page. */
const address = $state({ path: isPage ? here() : '/' });
const ADOPTED = 'tabs:adopted';
/** A tab handed to the window it was dragged out into (shared storage: the same origin). */
const handoffKey = (group: string, label: string) => `sd-tabs:${group}:${label}`;

/** This page is a kept-alive tab's own web view (the app again, in its own process), or a popover's:
 *  render the page alone there. */
export const embedded = isPage && ('__desktopView' in globalThis || '__shellPopover' in globalThis);

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

/** Where the window is in its history (`split`), written in its entries: how far a traversal went. */
let position = 0;
let tracking = false;
/** The last move in the window's history, and how to take it back. */
type HistoryMove = { at: number } & ({ go: number } | { state: unknown; url: string });
let lastMove: HistoryMove | null = null;
/** Only in an object of its own: anything else an app gives the history stays what it is, its entry unnumbered. */
const written = (state: unknown, at = position) =>
	state === null || state === undefined || Object.getPrototypeOf(state) === Object.prototype ? { ...(state as object), desktopIndex: at } : state;
const indexOfEntry = () => {
	const at = (history.state as { desktopIndex?: unknown } | null)?.desktopIndex;
	return typeof at === 'number' ? at : NaN; // not one of ours (a fragment): how far from here isn't known
};
const addressFollows = () => {
	(globalThis as { __desktopAddressFollows?: () => void }).__desktopAddressFollows?.();
	address.path = here();
};

/** Its own address change being announced (showAddress), not a navigation. */
let settingAddress = false;

/** The window at a kept-alive tab's address without navigating there — no load, no page code (its
 *  view runs the page); page.url, your sidebar follow. Without the desktop plugin: a navigation. */
function showAddress(path: string, replace = false, entry?: GotoOptions) {
	const set = (globalThis as { __desktopAddress?: (url: string, index?: number, replace?: boolean, entry?: GotoOptions) => void }).__desktopAddress;
	if (!set) return navigate(path);
	const next = replace ? position : position + 1;
	try {
		set(path, tracking ? next : undefined, replace, entry);
	} catch {
		return; // the browser's limit on history calls (a tab shortcut held down): the next one will do
	}
	if (tracking) position = next;
	address.path = here();
	settingAddress = true;
	dispatchEvent(new Event('desktop:urlchange'));
	settingAddress = false;
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
/** A route id without its (groups): what `keepAlive` names and what SvelteKit resolves compare. */
export const plainRouteId = (id: string) => '/' + id.split('/').filter((part) => part && !/^\(.+\)$/.test(part)).join('/');
/** A URL's path as a route id writes it (/café, not /caf%C3%A9). As SvelteKit reads it: an encoded
 *  slash stays one, and %25 stays %25 (/a%252Fb isn't /a%2Fb). */
export const decodedPath = (path: string) => {
	try {
		return path.split('%25').map(decodeURI).join('%25');
	} catch {
		return path;
	}
};

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

/** The last history call, for a navigation the window's page passes on to a pane's. */
let lastHistoryCall: 'pushState' | 'replaceState' | 'popstate' = 'pushState';

/** One `desktop:urlchange` event per client-side navigation (pushState, replaceState, back/forward). */
function watchUrl(fn: () => void): () => void {
	const g = globalThis as { __sdHistoryPatched?: boolean };
	if (!g.__sdHistoryPatched) {
		g.__sdHistoryPatched = true;
		for (const m of ['pushState', 'replaceState'] as const) {
			const original = history[m].bind(history);
			history[m] = (...args: Parameters<History['pushState']>) => {
				const next = m === 'pushState' ? position + 1 : position;
				const prior = { state: history.state, url: location.href };
				if (tracking) args[0] = written(args[0], next);
				original(...args); // if it refuses (too many calls, another origin): nothing happened
				if (tracking) {
					lastMove = m === 'pushState' ? { go: -1, at: next } : { ...prior, at: next };
					position = next;
				}
				lastHistoryCall = m;
				address.path = here();
				queueMicrotask(() => dispatchEvent(new Event('desktop:urlchange')));
			};
		}
		addEventListener('popstate', () => {
			lastHistoryCall = 'popstate';
			if (tracking) {
				let to = indexOfEntry();
				// A new entry for a fragment (no state, and nothing was ever left unnumbered): the next one.
				if (Number.isNaN(to) && history.state === null) {
					to = position + 1;
					History.prototype.replaceState.call(history, written(null, to), '');
				}
				lastMove = position - to ? { go: position - to, at: to } : null; // NaN or 0: nothing to go by
				position = to;
			}
			address.path = here();
			dispatchEvent(new Event('desktop:urlchange'));
		});
	}
	addEventListener('desktop:urlchange', fn);
	return () => removeEventListener('desktop:urlchange', fn);
}

/** How the current history entry was made, for a pane's goto() (the desktop plugin's). */
const entryOptions = (): GotoOptions => (globalThis as { __desktopEntryOptions?: () => GotoOptions }).__desktopEntryOptions?.() ?? {};
const entryKey = (e: { stateJson?: string; shallow?: boolean }) => `${e.stateJson ?? '[{}]'}${e.shallow ? ' shallow' : ''}`;

/** The groups of this page, for a notification's tab. */
const revealers = new Set<(view: string) => boolean>();

type Rect = { x: number; y: number; width: number; height: number };
type WindowInfo = { windowId: number; label: string; focused: boolean; visible?: boolean; bounds: Rect };
type Message<T> = { channel?: string; data?: T };

export class TabGroup<T extends TabLike = TabLike> {
	readonly id = 'app';
	#options: () => TabsOptions<T>;
	#store: TabStore<T>;
	/** Where the tabs are on screen (`split`), else null. */
	readonly panes: PaneLayout | null;
	/** The keyboard is in the window's page by choice (moving along a bar, in a field): a view coming
	 *  on screen leaves it there. */
	pageKeyboard = false;
	/** This page's window label ('main' for the first window), once connected. */
	window = $state<string | null>(null);
	/** This page is an isolated tab's own web view and this is <WindowTabs>' group: it stays local
	 *  (no menu, nothing saved) and <TabBar> renders nothing — drop your chrome too and show the page
	 *  alone. */
	readonly embedded: boolean;
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
		this.embedded = embedded;
		this.panes = o.split ? new PaneLayout() : null;
		// It starts on the page it's on.
		if (!this.items.length && isPage) this.items = [{ id: newId(), path: here() } as T];
		this.panes?.reconcile(this.items.map((t) => t.id));
		if (!this.active) this.activeId = this.items[0]?.id ?? null;
		if (this.active) {
			this.panes?.activate(this.active.id);
			this.#show(this.active);
		}
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
		if (this.panes) return true;
		return tab.isolated ?? (tab.url !== undefined || (tab.path !== undefined && this.keepsAlive(tab.path)));
	}

	/** Whether the page is on screen (not a tab's own view). */
	get pageShown(): boolean {
		if (this.panes) return false;
		const tab = this.get(this.shown ?? '');
		return !tab || !this.isIsolated(tab);
	}

	/** Whether the page renders: not at the address of a tab in its own view (a kept-alive route,
	 *  an isolated tab) — its view runs that page. */
	get pageRendered(): boolean {
		if (this.panes) return false;
		const path = address.path;
		return !this.keepsAlive(path) && !this.items.some((t) => t.path === path && (t.id === this.activeId || t.id === this.shown) && this.isIsolated(t));
	}

	/** Whether a path is one of the `keepAlive` routes. */
	keepsAlive(path: string): boolean {
		const routes = this.options.keepAlive;
		const at = this.panes ? decodedPath(pathOnly(path)) : pathOnly(path);
		return !!routes?.length && routes.some((id) => routeMatcher(id).test(at));
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
		const d = this.options.detachable ?? true;
		return typeof d === 'function' ? (tab ? d(tab) : true) : d;
	}

	/** Whether a tab can leave the window: an app route of a detachable group, closable, not
	 *  isolated (its own web view stays in its window). In panes every tab is in its own view: an
	 *  app route opens again in the new window. */
	canDetach(tab: T): boolean {
		return this.isClosable(tab) && (!!this.panes || !this.isIsolated(tab)) && tab.path !== undefined && this.#detachable(tab);
	}

	/** Right to left or not, as the panes are drawn now: a side means where it looks. */
	#syncDirection(): void {
		if (!this.panes || !isPage) return;
		const el = document.querySelector(`[data-sd-panes="${this.id}"]`) ?? document.documentElement;
		this.panes.rtl = getComputedStyle(el).direction === 'rtl';
	}

	/** The tabs of the bar in focus: the focused pane's, or all of them. */
	get #barItems(): T[] {
		if (!this.panes) return this.items;
		return this.panes.focused.tabs.map((id) => this.get(id)).filter((t): t is T => !!t);
	}

	/** On screen: never suspended. */
	#onScreen(id: string): boolean {
		if (this.panes) {
			const pane = this.panes.paneOf(id);
			return !!pane && (pane.active === id || pane.shown === id);
		}
		return id === this.activeId || id === this.shown;
	}

	/** The same route's address. In panes a tab's path comes from its page, encoded (/caf%C3%A9). */
	#samePath(a: string, b: string): boolean {
		return this.panes ? decodedPath(pathOnly(a)) === decodedPath(pathOnly(b)) : pathOnly(a) === pathOnly(b);
	}

	/** Tabs that came through `items`, not `open`, count for `maxViews`, and those gone don't. */
	syncViews(): void {
		const known = new Set(this.#recent);
		const fresh = this.items.filter((t) => !known.has(t.id));
		const left = this.#recent.filter((r) => this.get(r));
		if (!fresh.length && left.length === this.#recent.length) return;
		this.#recent = [...fresh.map((t) => t.id), ...left];
		this.#limit();
	}

	/** Whether a path's tab would run in its own view (what a spare or a view made ahead is for). */
	#ownView(path: string): boolean {
		return !!this.panes || this.keepsAlive(path);
	}

	/** Open a tab — a path or a URL, or a tab — right after the active one by default. An existing
	 *  id is activated instead, and so is a kept-alive route already open unless `reuse: false`
	 *  (another one: ⌘-click, a middle click, target="_blank"). */
	open(target: string | TabInit<T>, opts: { activate?: boolean; background?: boolean; index?: number; reuse?: boolean; pane?: string; split?: PaneZone } = {}): T {
		const init = (typeof target === 'string' ? (/^[a-z][a-z0-9+.-]*:/i.test(target) ? { url: target } : { path: target }) : target) as TabInit<T>;
		if (opts.background) opts = { ...opts, activate: false };
		const kept = opts.reuse !== false && init.path !== undefined && this.keepsAlive(init.path);
		const existing = init.id ? this.get(init.id) : kept ? this.items.find((t) => t.path !== undefined && this.#samePath(t.path, init.path!)) : undefined;
		if (existing) {
			if (opts.activate !== false) this.activate(existing.id);
			return existing;
		}
		const tab = { ...init, id: init.id ?? this.#takeAhead(init.path) ?? this.#takeSpare(init.path) ?? newId() } as T;
		const items = this.items;
		if (this.panes) {
			const activate = opts.activate !== false;
			this.#syncDirection();
			if (opts.split) this.panes.addBeside(tab.id, opts.pane, opts.split, activate);
			else {
				const into = (opts.pane && this.panes.pane(opts.pane)) || this.panes.focused;
				const at = opts.index ?? (into.active ? into.tabs.indexOf(into.active) + 1 : into.tabs.length);
				const pinned = into.tabs.filter((id) => this.get(id)?.pinned).length;
				this.panes.add(tab.id, { pane: into.id, index: Math.max(pinned, at), activate });
			}
			this.items = [...items, tab];
		} else {
			const after = items.findIndex((t) => t.id === this.activeId);
			const index = Math.max(items.filter((t) => t.pinned).length, Math.min(opts.index ?? (after >= 0 ? after + 1 : items.length), items.length));
			this.items = [...items.slice(0, index), tab, ...items.slice(index)];
		}
		if (opts.activate !== false || !this.activeId) this.activate(tab.id);
		if (this.isIsolated(tab)) this.#used(tab.id);
		return this.get(tab.id) ?? tab;
	}

	/** Make the view of a kept-alive route ahead (a link to it hovered): opened within a while,
	 *  its tab shows at once. Not when a click would go to its open tab. */
	prepare(path: string): void {
		if (!isPage || !platformReady() || embedded || !this.#ownView(path) || this.#ahead?.path === path || this.#spare?.path === path) return;
		if (this.items.some((t) => t.path === path && this.isIsolated(t))) return;
		this.#dropAhead();
		const tab = newId();
		this.#ahead = { path, tab, timer: setTimeout(() => this.#dropAhead(), 5_000) };
		prepareView(`${this.id}-${tab}`, path, contentBox(), !!this.panes);
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
	new(opts: { pane?: string; split?: PaneZone } = {}): T | undefined {
		const init = this.options.newTab?.();
		return init ? this.open(init, { index: this.items.length, ...(this.panes && { reuse: false }), ...opts }) : undefined;
	}

	/** Open the active tab's page, or `newTab`, in a new pane on this side of the focused one. */
	split(zone: PaneZone): T | undefined {
		if (!this.panes) return;
		const init = this.options.newTab?.();
		const active = this.active;
		const target = init ?? (active && ({ path: active.path, url: active.url } as TabInit<T>));
		return target ? this.open(target, { split: zone, reuse: false }) : undefined;
	}

	/** The focus to another pane (1: the next one, -1: the one before). */
	focusPane(step: 1 | -1): void {
		if (!this.panes) return;
		const all = this.panes.panes;
		const i = all.findIndex((p) => p.id === this.panes!.focusedId);
		const next = all[(i + step + all.length) % all.length];
		if (next) this.focus(next.id);
	}

	/** A pane in focus: the window's title and address are its active tab's. */
	focus(pane: string, opts: { keyboard?: boolean } = {}): void {
		const p = this.panes?.pane(pane);
		if (!p) return;
		this.panes!.focus(pane);
		if (p.active) this.activate(p.active, 'user', opts);
	}

	/** The system says a pane's view has the keyboard: it's the pane in focus. Nothing is asked of
	 *  the system back: two of these crossing each other would go on for good. */
	#focused_(pane: string): void {
		const p = this.panes?.pane(pane);
		if (!p) return;
		this.panes!.focus(pane);
		if (p.active) this.#activate(p.active, 'user', false);
	}

	/** Where a dragged tab was let go, in panes. `keyboard` false: the keyboard stays in the bar. */
	place(id: string, drop: Parameters<PaneLayout['apply']>[1], opts: { keyboard?: boolean } = {}): boolean {
		if (!this.panes?.allows(id, drop)) return false;
		this.#syncDirection();
		this.panes.apply(id, drop);
		this.activate(id, 'user', opts);
		return true;
	}

	/** A step along its bar, with the keyboard: what a drag can do, never before a pinned tab. */
	shift(id: string, step: 1 | -1): boolean {
		const tab = this.get(id);
		if (!tab || tab.pinned) return false;
		const pane = this.panes?.paneOf(id);
		if (!pane && !this.canReorder) return false;
		const list = pane ? pane.tabs : this.items.map((t) => t.id);
		const to = list.indexOf(id) + step;
		const pinned = list.filter((t) => t !== id && this.get(t)?.pinned).length;
		if (to < pinned || to >= list.length) return false;
		if (pane) return this.place(id, { kind: 'bar', pane: pane.id, index: to, x: 0 }, { keyboard: false });
		this.move(id, to);
		return true;
	}

	/** To the pane before or after its own, with the keyboard. */
	toPane(id: string, step: 1 | -1): boolean {
		const panes = this.panes;
		const from = panes?.paneOf(id);
		if (!panes || !from || this.get(id)?.pinned) return false;
		const all = panes.panes;
		const next = all[all.findIndex((p) => p.id === from.id) + step];
		return !!next && this.place(id, { kind: 'center', pane: next.id }, { keyboard: false });
	}

	/** Into a new pane on this side of its own, with the keyboard. */
	toSide(id: string, zone: PaneZone): boolean {
		const from = this.panes?.paneOf(id);
		return !!from && !this.get(id)?.pinned && this.place(id, { kind: 'side', pane: from.id, zone }, { keyboard: false });
	}

	/** The keyboard on a tab in its bar (the active one by default), once it's drawn. */
	async focusTab(id?: string): Promise<void> {
		this.pageKeyboard = true;
		await tick();
		if (isPage) document.getElementById(`${this.id}-tab-${id ?? this.activeId}`)?.focus();
	}

	/** The keyboard into what a tab shows: its web view, or the page. */
	focusContent(id: string = this.activeId ?? ''): void {
		const tab = this.get(id);
		if (!tab || !isPage) return;
		if (this.panes || this.isIsolated(tab)) {
			this.pageKeyboard = false;
			if (platformReady()) void callPlatform('view', 'focus', { id: `${this.id}-${id}` }).catch(() => {});
			return;
		}
		// Not one to stay focusable: a press in the page would land on it rather than on the body.
		const panel = document.querySelector<HTMLElement>('[data-sd-tabcontent]');
		if (!panel) return;
		panel.tabIndex = -1;
		panel.focus();
		panel.addEventListener('blur', () => panel.removeAttribute('tabindex'), { once: true });
	}

	/** Between the bar and what the active tab shows: the way back from a web view, which has the
	 *  keyboard for itself and where Tab may never leave. */
	toggleBar(): void {
		const inBar = document.hasFocus() && !!document.activeElement?.closest('[data-sd-tabbar]');
		if (inBar) return this.focusContent();
		if (platformReady()) void callPlatform('view', 'focusPage').catch(() => {});
		void this.focusTab();
	}

	/** A tab the keyboard is on, for the keyboard to stay in the bar when it goes. A press leaves it
	 *  as it was: with the pointer, the keyboard goes to what's shown next. */
	#hasKeyboard(id: string): boolean {
		if (!isPage || !document.hasFocus()) return false;
		const el = document.activeElement;
		return !!el?.matches(':focus-visible') && el.closest('[role=tab]')?.id === `${this.id}-tab-${id}`;
	}

	/** The window's history entry, as last seen (`split`): its state going to the tab in focus. */
	#entry = '';
	/** A `keepAlive` route, as SvelteKit resolves it: its matchers, a static route beside it. */
	#routeIsKept(path: string): Promise<boolean> {
		if (!this.keepsAlive(path)) return Promise.resolve(false);
		const routeOf = (globalThis as { __desktopRouteOf?: (href: string) => Promise<string | null> }).__desktopRouteOf;
		if (!routeOf) return Promise.resolve(true);
		const kept = (this.options.keepAlive ?? []).map(plainRouteId);
		return routeOf(path).then((id) => id !== null && kept.includes(plainRouteId(id)), () => true);
	}

	/** Tabs whose view is on its way somewhere (`#goActive`): the latest request. */
	#going = new Map<string, object>();

	/** The active tab's view at another page of the app (a link in the window's page, goto()): its
	 *  own router moves it. A `keepAlive` route has its own tab. */
	#goActive(path: string, options?: GotoOptions, move: HistoryMove | null = null): void {
		const tab = this.active;
		const pane = this.panes?.focusedId; // the one it was asked in, whichever has the focus by the time it's known
		const open = () => {
			const before = this.items.length;
			const opened = this.open(path, pane && this.panes?.pane(pane) ? { pane } : {});
			// A tab just made starts with no state; the open one may have one to replace, and may cancel it.
			const fresh = this.items.length !== before;
			// The open one stays at its address (reused by its path, another query or fragment asked): it's there.
			if (opened && (!fresh || options?.stateJson !== '[{}]')) this.#stateLater(opened.id, opened.path ?? path, options, fresh ? null : move);
		};
		if (!tab) return open();
		if (!this.keepsAlive(path)) return this.#goTab(tab, path, options, move);
		// A route id written without its matcher, or a static route beside it: as SvelteKit resolves it.
		const routeOf = (globalThis as { __desktopRouteOf?: (href: string) => Promise<string | null> }).__desktopRouteOf;
		if (!routeOf) return open();
		const kept = (this.options.keepAlive ?? []).map(plainRouteId);
		// Resolving takes a moment: a newer navigation of this tab wins over this one. If it was on its
		// way elsewhere, this one has to overtake that, even to where it is.
		const busy = this.#going.has(tab.id);
		const going = {};
		this.#going.set(tab.id, going);
		const still = () => this.#going.get(tab.id) === going;
		void routeOf(path).then(
			(id) => {
				if (!still()) return;
				if (id !== null && kept.includes(plainRouteId(id))) {
					// Back to its own route while it's going elsewhere: that one is called off.
					// Or a link to where it is, exactly: its loads run again.
					if ((busy && tab.path !== undefined && this.#samePath(tab.path, path)) || (!move && tab.path === path)) return this.#goTab(tab, path, options, move);
					this.#going.delete(tab.id);
					return open();
				}
				if (!busy) this.#going.delete(tab.id);
				this.#goTab(tab, path, options, move);
			},
			() => {
				if (!still()) return;
				this.#going.delete(tab.id);
				open();
			},
		);
	}

	/** `move`: what the window's history just did for it (goto(), back), to take back if the page cancels it. */
	#goTab(tab: T, path: string, options?: GotoOptions, move: HistoryMove | null = null): void {
		// Back to where it is while it's going elsewhere: that's a navigation too, the latest one wins.
		// So is another state there. A link to where it is too: SvelteKit runs its loads again, or scrolls
		// to the fragment again.
		if (tab.path === path && !move && !options?.stateJson) options = { replace: true, refreshAll: !path.includes('#'), ...options };
		const view = `${this.id}-${tab.id}`;
		this.#states.delete(tab.id); // the one it was waiting to give is out of date
		if (tab.url !== undefined) return this.#loadTab(tab, path, options, move);
		// Where it is once its router is done: its page can cancel. No view yet: it's made there.
		const going = {};
		const before = tab.path;
		const count = this.#navigation(tab.id);
		this.#reported.delete(tab.id);
		this.#going.set(tab.id, going);
		if (viewComing(view)) this.#stateLater(tab.id, path, options, move, count);
		void navigateView(view, path, false, options).then((at) => {
			if (this.#going.get(tab.id) !== going) return;
			this.#going.delete(tab.id);
			const now = this.get(tab.id);
			if (!now) return;
			if (at === undefined || at === null) this.#stateLater(tab.id, path, options, move, count); // loaded there instead
			if (at === undefined) {
				this.#loadingAt.set(tab.id, path);
				return void (move && this.#loading(view, move, count));
			}
			const to = at ?? path;
			if (now.path !== to) this.update(tab.id, { path: to, title: undefined } as Partial<Omit<T, 'id'>>);
			if (now.id !== this.activeId) return;
			if (to === here()) {
				// The same address: only the state tells it was canceled.
				// A newer entry its page made in the meantime (a modal's state): the window's history has it too.
				const newer = this.#reported.get(tab.id);
				this.#reported.delete(tab.id);
				if (newer?.path === to && entryKey(newer.entry) !== this.#entry) showAddress(to, newer.replace, newer.entry);
				else if (to === before && move && options?.stateJson) this.#takeBackIfCanceled(tab.id, move, count);
				// Asked to make an entry of its own, at the same address: the window's history has one too.
				else if (!move && options?.replace === false) {
					const at = position;
					void navigationTaken(view).then((taken) => {
						if (taken && tab.id === this.activeId && count === this.#navigations.get(tab.id) && at === position) showAddress(to);
					});
				}
				return;
			}
			// Canceled by its page: the window's history as it was (an entry more for where it stayed would
			// make a trap for Back). Shallow, not canceled: the address is the window's own, the tab's path
			// its page's.
			if (to === before && move && move.at === position) this.#takeBack(move);
			else if (!options?.shallow || to === before) showAddress(to, !move && !!options?.replace);
		});
	}

	/** Navigations asked of each tab's view: which one is its latest. */
	#navigations = new Map<string, number>();

	#navigation(id: string): number {
		const count = (this.#navigations.get(id) ?? 0) + 1;
		this.#navigations.set(id, count);
		return count;
	}

	#takeBackIfCanceled(id: string, move: HistoryMove, count: number): void {
		void navigationTaken(`${this.id}-${id}`).then((taken) => {
			if (!taken && move.at === position && count === this.#navigations.get(id)) this.#takeBack(move);
		});
	}

	/** A tab's view at a page by loading it, not by its router (it's on another site, a link says so). */
	#loadTab(tab: T, path: string, options?: GotoOptions, move: HistoryMove | null = null): void {
		this.#going.delete(tab.id); // what it was resolving is out of date
		const count = this.#navigation(tab.id);
		this.#stateLater(tab.id, path, options, move, count);
		const view = `${this.id}-${tab.id}`;
		void navigateView(view, path, true).then((at) => {
			if (at === undefined) return void (move && this.#loading(view, move, count));
			// No view to ask yet: it's made there.
			this.update(tab.id, { path, url: undefined, title: undefined } as Partial<Omit<T, 'id'>>);
			if (path !== here() && tab.id === this.activeId) showAddress(path);
		});
	}

	/** Pages being loaded for a move of the window's history. Its path and the address follow once it's
	 *  there (`viewNavigated`): it may be a download, and stay where it is. No page came of it: the
	 *  move is taken back. */
	#loads = new Map<string, { move: HistoryMove; count: number; older: number }>();

	/** One still going when a newer starts: its failure (canceled by this one) comes first. */
	#loading(view: string, move: HistoryMove, count: number): void {
		const going = this.#loads.get(view);
		this.#loads.set(view, { move, count, older: going ? going.older + 1 : 0 });
	}

	/** A notification's tab, for when the tabs are back. */
	#revealOnce: string | null = null;

	/** Taking back a move of the window's history: for nobody to see, SvelteKit included (it could cancel it). */
	#undoing = false;

	#takeBack(move: HistoryMove): void {
		if ('go' in move) {
			this.#undoing = true;
			return history.go(move.go);
		}
		History.prototype.replaceState.call(history, move.state, '', move.url);
		this.#tookBack();
	}

	#tookBack(): void {
		addressFollows();
		this.#entry = entryKey(entryOptions());
	}

	/** A state for a page that isn't there yet, by tab: given when it says it is. */
	#states = new Map<string, { path: string; options: GotoOptions; move: HistoryMove | null; count: number }>();

	#stateLater(id: string, path: string, options?: GotoOptions, move: HistoryMove | null = null, count?: number): void {
		if (!options?.stateJson) return void this.#states.delete(id);
		this.#states.set(id, { path, options, move, count: count ?? this.#navigation(id) });
		this.#giveState(id);
	}

	#giveState(id: string): void {
		const state = this.#states.get(id);
		if (!state) return;
		void deliverState(`${this.id}-${id}`, state.path, state.options).then((done) => {
			if (!done || this.#states.get(id) !== state) return;
			this.#states.delete(id);
			if (state.move) this.#takeBackIfCanceled(id, state.move, state.count);
		});
	}

	/** `keyboard` false: the keyboard stays where it is (moving along a bar with the arrows). */
	activate(id: string, reason: 'user' | 'missing' = 'user', opts: { keyboard?: boolean } = {}): void {
		this.pageKeyboard = opts.keyboard === false;
		this.#activate(id, reason, opts.keyboard !== false);
	}

	#activate(id: string, reason: 'user' | 'missing', keyboard: boolean): void {
		const tab = this.get(id);
		if (!tab) return;
		const changed = this.activeId !== id;
		this.activeId = id;
		if (this.panes) {
			this.panes.activate(id);
			// Drawn already (the other pane's tab on screen): the window's address, the keyboard.
			if (this.panes.paneOf(id)?.shown === id) this.reveal(id);
			if (keyboard && isPage && platformReady()) void callPlatform('view', 'focus', { id: `${this.id}-${id}` }).catch(() => {});
		}
		// A tab of the page is shown once the page is at its path; an isolated tab once its view
		// is drawn (see reveal).
		if (!this.isIsolated(tab)) {
			if (tab.path !== undefined && isPage && tab.path !== here()) goTo(tab.path);
			else this.#show(tab);
		}
		if (changed) this.options.onactivate?.(tab, reason);
	}

	/** An isolated tab's view is on screen (drawn, in front): it's the one shown, and the window's
	 *  address follows it. */
	reveal(id: string): void {
		const tab = this.get(id);
		if (!tab) return;
		if (this.panes) {
			const pane = this.panes.paneOf(id);
			if (pane?.active === id && pane.shown !== id) {
				pane.shown = id;
				this.#used(id); // on screen, in a pane without the focus too; what it replaced may be over the limit
			}
		}
		if (this.activeId !== id) return;
		this.#show(tab);
		this.followAddress(id);
	}

	/** The window's address at the active tab's path. On its way somewhere for the window: the window has
	 *  the address already, its path is out of date. */
	followAddress(id: string): void {
		const tab = this.get(id);
		if (tab && id === this.activeId && tab.path !== undefined && isPage && tab.path !== here() && !this.#going.has(id)) showAddress(tab.path, false, this.#entries.get(id));
	}

	/** Tabs whose page is being replaced by a load: where to. */
	#loadingAt = new Map<string, string>();

	/** What a tab's page said while a navigation of the window's was on its way. */
	#reported = new Map<string, { path: string; entry: GotoOptions; replace: boolean }>();

	/** Each tab's history entry as its page last said, for the window's address when it's back in focus. */
	#entries = new Map<string, GotoOptions>();

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
		if (!this.panes) {
			for (const r of running.slice(0, Math.max(0, running.length - max))) if (r !== this.activeId && r !== this.shown) this.suspended.add(r);
			return;
		}
		// Several panes on screen: they stay, and don't count for the one to suspend.
		let over = running.length - max;
		for (const r of running) {
			if (over <= 0) break;
			if (this.#onScreen(r)) continue;
			this.suspended.add(r);
			over--;
		}
	}

	/** Free memory: every view not on screen suspended, nothing made ahead. */
	#relieve(): void {
		for (const t of this.items) if (this.isIsolated(t) && !this.#onScreen(t.id)) this.suspended.add(t.id);
		clearTimeout(this.#warmTimer);
		this.#dropAhead();
		this.#dropSpare();
	}

	/** Keep a view ready for the next kept-alive tab (`prewarm`): at a kept-alive route not open
	 *  (taken as is), else at the app's root (taken to the tab's route). */
	#warm(): void {
		const o = this.options;
		if (!this.#connections || !o.prewarm || (!o.keepAlive?.length && !this.panes) || this.#spare || !isPage || embedded || !platformReady()) return;
		const fixed = (o.keepAlive ?? [])
			.filter((id) => !id.includes('['))
			.map((id) => '/' + id.split('/').filter((p) => p && !/^\(.+\)$/.test(p)).join('/'))
			.find((path) => !this.items.some((t) => t.path !== undefined && pathOnly(t.path) === path));
		const tab = newId();
		this.#spare = { tab, path: fixed ?? '/' };
		prepareView(`${this.id}-${tab}`, this.#spare.path, contentBox(), !!this.panes);
	}

	#takeSpare(path: string | undefined): string | undefined {
		const spare = this.#spare;
		if (!spare || path === undefined || !this.#ownView(path)) return;
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
	 *  keeps its last tab when there's no `newTab` to replace it. `keepFocus`: the keyboard stays in
	 *  the bar, on the tab shown next (as it does when the tab closed had it anyway). */
	close(id: string = this.activeId ?? '', opts: { keepFocus?: boolean } = {}): void {
		const tab = this.get(id);
		if (!tab || !this.isClosable(tab)) return;
		const o = this.options;
		if (this.items.length === 1 && this.window !== null && this.window === 'main' && !o.newTab) return;
		if (o.onclose?.(tab) === false) return;
		this.#remove(id, 'closed', opts.keepFocus);
	}

	/** Take a tab out, closed or moved to another window; the active one moves on. A window tabs
	 *  were dragged into closes with its last tab; the main window's bar opens `newTab()`. */
	#remove(id: string, how: 'closed' | 'moved', keepFocus = false): void {
		const items = this.items;
		const index = items.findIndex((t) => t.id === id);
		if (index < 0) return;
		const stay = how === 'closed' && (keepFocus || this.#hasKeyboard(id));
		if (how === 'closed') {
			this.#closed.push({ tab: $state.snapshot(items[index]) as T, index });
			if (this.#closed.length > 20) this.#closed.shift();
		}
		const rest = items.filter((t) => t.id !== id);
		// The pane first: what it shows next, and whether it stays, decide who's active.
		this.panes?.remove(id);
		this.#going.delete(id); // its answer is for this view: a tab reopened with this id has another
		this.#states.delete(id);
		this.#loads.delete(`${this.id}-${id}`);
		this.#navigations.delete(id);
		this.#entries.delete(id);
		this.#loadingAt.delete(id);
		this.#reported.delete(id);
		forgetMissed(`${this.id}-${id}`);
		this.items = rest;
		this.suspended.delete(id);
		if (this.activeId === id) {
			const next = this.panes ? this.get(this.panes.focused.active ?? '') : (rest[index] ?? rest[index - 1]);
			this.activeId = null;
			if (next) this.activate(next.id, 'missing', stay ? { keyboard: false } : {});
		}
		if (!rest.length) {
			if (this.window && this.window !== 'main') void callPlatform('window', 'close').catch(() => {});
			else this.new();
		}
		// Left on the body otherwise, with nothing to go on from.
		if (stay) void this.focusTab();
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
		const items = this.#barItems;
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
		this.panes?.reorder(id, to); // its place in its pane's bar
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
		// A window of its own each time: it may have come out of one with that tab's name.
		const label = `${this.id}-${tab.id}-${Date.now().toString(36)}`;
		try {
			// The same profile (only macOS has several): its cookies, and the handoff stored next. Not known: it stays here.
			const session = /Mac/.test(navigator.platform) ? (await callPlatform<{ session?: string }>('window', 'getInfo')).session : undefined;
			localStorage.setItem(handoffKey(this.id, label), JSON.stringify($state.snapshot(tab)));
			this.#style ??= callPlatform<{ style: string }>('window', 'getTitleBarStyle')
				.then((s) => (s.style && s.style !== 'default' ? { titleBarStyle: s.style } : {}))
				.catch(() => ({}));
			await callPlatform('window', 'create', {
				label,
				path: tab.path,
				...(session && { session }),
				width: innerWidth,
				height: innerHeight,
				...(at && { x: Math.round(at.x - 120), y: Math.round(at.y - 16) }),
				...(await this.#style),
				animate: windowAnimation(this.options.windowAnimation),
			});
			this.#remove(id, 'moved');
			this.options.ondetach?.(tab);
		} catch (e) {
			console.error('[tabs] could not open the tab in a new window', e);
			localStorage.removeItem(handoffKey(this.id, label));
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

	/** Wire the group to the page and the window (<WindowTabs> does); returns the cleanup. */
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
		const persist = o.restore ?? true;
		let restored = false;
		// What a notification's click waits for, to go to its tab.
		let tabsBack: (() => void) | undefined;
		if (this.panes && persist) {
			const g = globalThis as { __desktopTabsBack?: Promise<void> };
			const back = new Promise<void>((resolve) => (tabsBack = resolve));
			g.__desktopTabsBack = back;
			void back.then(() => void (g.__desktopTabsBack === back && delete g.__desktopTabsBack));
			cleanups.push(() => tabsBack?.());
		}
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
				if (this.#revealOnce && this.get(this.#revealOnce)) this.activate(this.#revealOnce);
				this.#revealOnce = null;
				tabsBack?.();
				void whenSettled().then(() => void (connected && warm && this.#warm())); // after the window's page
				this.#syncTitle(); // the restored / handed-over tab is this page
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
					const state = JSON.stringify({ items: this.items, activeId: this.activeId, start: (this.panes ? active : page)?.path ?? '/', panes: this.panes?.toJSON() });
					if (!restored || !persist || this.window !== 'main') return;
					clearTimeout(timer);
					save = () => void writeAppFile('userData', `tabs-${this.id}.json`, state).catch(() => {});
					timer = setTimeout(() => (save?.(), (save = undefined)), 300);
				});
				// The window title follows the active tab.
				$effect(() => {
					const active = this.active;
					const title = active && this.titleOf(active);
					if (title && platformReady()) void callPlatform('window', 'setTitle', { title }).catch(() => {});
					// In panes no route of the window's page gives it a <title>: it names the document too.
					if (title && this.panes && isPage) document.title = title;
				});
				// Disconnected: a save still waiting goes out now.
				return () => (clearTimeout(timer), save?.());
			}),
		);

		if (this.panes) cleanups.push(...this.#wirePanes());
		// Back to a notification's tab, whatever its view has become (suspended, made again).
		const revealView = (view: string) => {
			const prefix = `${this.id}-`;
			if (!view.startsWith(prefix)) return false;
			const id = view.slice(prefix.length);
			// Its tabs still coming back (a click that launched the app): once they're there.
			if (!restored) this.#revealOnce = id;
			else if (this.get(id)) this.activate(id);
			return true;
		};
		revealers.add(revealView);
		const notified = globalThis as { __desktopRevealView?: (view: string) => void; __desktopRevealLater?: string };
		notified.__desktopRevealView = (view) => {
			if (![...revealers].some((reveal) => reveal(view))) notified.__desktopRevealLater = view; // for when its tabs are here
		};
		if (notified.__desktopRevealLater && revealView(notified.__desktopRevealLater)) delete notified.__desktopRevealLater;
		cleanups.push(() => void revealers.delete(revealView));
		// A view's page was given the user's attention (a click on its notification): its tab on screen.
		cleanups.push(
			onPlatform<{ id: string }>('viewReveal', (e) => {
				const prefix = `${this.id}-`;
				const tab = e?.id?.startsWith(prefix) ? e.id.slice(prefix.length) : undefined;
				if (tab && this.get(tab)) this.activate(tab);
			}),
		);
		cleanups.push(onPlatform<{ windowId: number; focused: boolean }>('focusChanged', (e) => void (e?.windowId === this.#windowId && (this.#focused = e.focused))));

		// Route tabs follow navigation: the active tab is wherever the page went.
		cleanups.push(
			watchUrl(() => {
				const tab = this.active;
				const to = here();
					if (this.panes) {
						// The address it was given itself isn't a navigation. Back or goto() is, also to
						// the path it's at, when it's on its way elsewhere (the latest one wins) or when
						// the entry's state is another one.
						const entry: GotoOptions = entryOptions();
						// A shallow entry's page is for coming back to it; a new one stays on the page the tab has
						// (the window's page.url may be another shallow address of that tab's).
						if (lastHistoryCall !== 'popstate') delete entry.pageUrl;
						else entry.traversal = true;
						// goto(here, { refreshAll: true }) says so to no entry.
						const g = globalThis as { __desktopGotoAsked?: { refreshAll?: boolean; invalidateAll?: boolean; persistState?: boolean; reset?: boolean } };
						const asked = lastHistoryCall !== 'popstate' ? g.__desktopGotoAsked : undefined;
						const refresh = asked?.refreshAll ?? asked?.invalidateAll;
						delete g.__desktopGotoAsked;
						if (refresh) entry.refreshAll = true;
						if (asked?.persistState !== undefined) entry.persistState = asked.persistState;
						if (asked?.reset !== undefined) entry.reset = asked.reset;
						// A goto() there is a navigation too: it scrolls to the top, as it would have in its page.
						const changed = entryKey(entry) !== this.#entry || !!asked;
						this.#entry = entryKey(entry);
						if (settingAddress || !tab) return;
						if (tab.path !== to || this.#going.has(tab.id) || changed)
							this.#goActive(to, { replace: lastHistoryCall === 'replaceState', ...entry }, lastMove);
						return;
					}
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
		const observer = new MutationObserver(() => this.#syncTitle());
		observer.observe(document.head, { subtree: true, childList: true, characterData: true });
		queueMicrotask(() => this.#syncTitle());
		cleanups.push(() => observer.disconnect());

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

		cleanups.push(this.#wireWindow());
		return () => {
			connected = false;
			for (const c of cleanups) c();
		};
	}

	/** What only panes need: a click in a view is that pane in focus; a view's page tells where its
	 *  router went, and asks for tabs; the window's address follows the tab in focus. */
	#wirePanes(): Array<() => void> {
		const tabOf = (view?: string) => {
			const prefix = `${this.id}-`;
			return view?.startsWith(prefix) ? view.slice(prefix.length) : undefined;
		};
		this.#entry = entryKey(entryOptions());
		const settled = (view?: string) => void this.#loadingAt.delete(tabOf(view) ?? '');
		const loaded = onPlatform<{ id: string }>('viewNavigated', (e) => {
			settled(e?.id);
			this.#loads.delete(e?.id);
		});
		const failed = onPlatform<{ id: string }>('viewFailed', (e) => {
			settled(e?.id);
			const load = this.#loads.get(e?.id);
			if (!load) return;
			if (load.older > 0) return void load.older--;
			this.#loads.delete(e.id);
			const tab = tabOf(e.id);
			if (tab && load.move.at === position && load.count === this.#navigations.get(tab)) this.#takeBack(load.move);
		});
		const g = globalThis as { __desktopAddressFollows?: unknown; __desktopOnPopstate?: () => boolean };
		// Taking back a move takes the desktop plugin: it has the first word on a traversal.
		if (g.__desktopAddressFollows) {
			tracking = true;
			const at = indexOfEntry();
			if (Number.isNaN(at)) History.prototype.replaceState.call(history, written(history.state), '');
			else position = at;
			g.__desktopOnPopstate = () => {
				if (!this.#undoing) return false;
				this.#undoing = false;
				position = indexOfEntry();
				this.#tookBack();
				return true;
			};
		}
		return [
			loaded,
			failed,
			() => {
				tracking = false;
				delete g.__desktopOnPopstate;
			},
			onPlatform<{ id: string }>('viewFocused', (e) => {
				const pane = this.panes!.paneOf(tabOf(e?.id) ?? '');
				if (!pane) return;
				this.pageKeyboard = false; // the keyboard is in a view again
				if (pane.id !== this.panes!.focusedId) this.#focused_(pane.id);
			}),
			onPlatform<Message<{ id: string; path: string; background?: boolean; reuse?: boolean; stateJson?: string; entry?: GotoOptions; replace?: boolean; first?: boolean }>>('message', (m) => {
				if (m?.channel !== 'tabs:view-url' && m?.channel !== 'tabs:view-open' && m?.channel !== 'tabs:view-ready') return;
				const id = tabOf(m.data?.id);
				const tab = id && this.get(id);
				if (!tab || !m.data) return;
				if (m.channel === 'tabs:view-ready') return this.#giveState(tab.id);
				// From the page it's leaving, being replaced by a load: it isn't where the tab is going.
				const loadingAt = this.#loadingAt.get(tab.id);
				if (m.channel === 'tabs:view-url' && loadingAt !== undefined && !this.#samePath(m.data.path, loadingAt)) return;
				if (m.channel === 'tabs:view-url') {
					const to = m.data.path;
					// From the app's page it left: it's at another site now.
					if (tab.url !== undefined && tab.path === undefined) return;
					if (tab.path !== to) this.update(tab.id, { path: to } as Partial<Omit<T, 'id'>>);
					// On its way somewhere for the window: where it's at for now isn't the window's address.
					// Its history as the window's: the entry goes along, for Back to come back to it with its state;
					// a replace replaces, and a new state at the same address is an entry too.
					const entry = m.data.entry;
					if (entry) this.#entries.set(tab.id, entry);
					// While the window waits for it: for when it has its answer.
					if (entry && this.#going.has(tab.id)) this.#reported.set(tab.id, { path: to, entry, replace: !!m.data.replace });
					if (tab.id === this.activeId && !this.#going.has(tab.id) && (to !== here() || (entry && !m.data.first && entryKey(entry) !== this.#entry))) showAddress(to, !!m.data.replace, entry);
					// There, or gone elsewhere (a redirect, its own link): the state waiting for it is settled.
					const state = this.#states.get(tab.id);
					if (state && this.#samePath(to, state.path)) this.#giveState(tab.id);
					else if (state && !viewComing(`${this.id}-${tab.id}`) && !this.#going.has(tab.id)) this.#states.delete(tab.id);
				} else {
					// Its route's tab: another one than the view asking (which may be reported there for a moment).
					const to = m.data.path;
					const other = m.data.reuse ? this.items.find((t) => t.id !== tab.id && t.path !== undefined && this.#samePath(t.path, to)) : undefined;
					if (other) this.activate(other.id);
					const opened = other ?? this.open(to, { pane: this.panes!.paneOf(tab.id)?.id, background: m.data.background, reuse: false });
					if (opened) this.#stateLater(opened.id, opened.path ?? to, m.data.stateJson ? { stateJson: m.data.stateJson } : undefined);
				}
			}),
		];
	}

	/** The active route tab takes the page's <title>. */
	#syncTitle(): void {
		const tab = this.active;
		const title = document.title.trim();
		if (tab && !this.isIsolated(tab) && tab.path === here() && title && tab.title !== title) this.update(tab.id, { title } as Partial<Omit<T, 'id'>>);
	}

	async #restore(): Promise<void> {
		const text = await readAppFile('userData', `tabs-${this.id}.json`);
		const saved = text ? (JSON.parse(text) as { items: T[]; activeId: string | null; panes?: unknown }) : null;
		if (!saved?.items?.length) return;
		this.items = saved.items;
		this.activeId = saved.activeId && this.get(saved.activeId) ? saved.activeId : saved.items[0]!.id;
		if (this.panes) {
			const ids = this.items.map((t) => t.id);
			if (!this.panes.restore(saved.panes, ids)) this.panes.reconcile(ids);
			this.panes.activate(this.activeId!);
		}
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
	#wireWindow(): () => void {
		const cleanups: Array<() => void> = [];
		const act = (id: string): boolean => {
			if (id === 'tabs:new') this.new();
			else if (id === 'tabs:close') this.close();
			else if (id === 'tabs:reopen') this.reopen();
			else if (id === 'tabs:next') this.cycle(1);
			else if (id === 'tabs:previous') this.cycle(-1);
			else if (id === 'tabs:detach' && this.active) void this.detach(this.active.id);
			else if (id === 'tabs:split-right') this.split('right');
			else if (id === 'tabs:split-down') this.split('bottom');
			else if (id === 'tabs:pane-next') this.focusPane(1);
			else if (id === 'tabs:pane-previous') this.focusPane(-1);
			else if (id === 'tabs:focus-bar') this.toggleBar();
			else if (id.startsWith('tabs:select:')) {
				const n = Number(id.slice('tabs:select:'.length));
				const bar = this.#barItems;
				const tab = n === 9 ? bar.at(-1) : bar[n - 1];
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
				...(this.panes
					? [
							{ type: 'separator' },
							{ id: 'tabs:split-right', label: 'Split Right', accelerator: 'CmdOrCtrl+\\' },
							{ id: 'tabs:split-down', label: 'Split Down', accelerator: 'CmdOrCtrl+Shift+\\' },
							{ id: 'tabs:pane-next', label: 'Next Pane', accelerator: 'CmdOrCtrl+Alt+]' },
							{ id: 'tabs:pane-previous', label: 'Previous Pane', accelerator: 'CmdOrCtrl+Alt+[' },
						]
					: []),
				{ type: 'separator' },
				{ id: 'tabs:focus-bar', label: 'Focus Tab Bar', accelerator: 'F6' },
				...(this.#detachable() ? [{ type: 'separator' }, { id: 'tabs:detach', label: 'Move Tab to New Window' }] : []),
			];
			const insert = () =>
				void callPlatform('menu', 'insert', { name: 'Tab', items }).then(
					() => (menu = true),
					() => (menu = false),
				);
			insert();
			// The app's menu replaced: it goes in the new one.
			watchPlatformOp('menu.setAppMenu');
			watchPlatformOp('menu.setApplicationMenu');
			cleanups.push(
				onPlatform<Message<{ op?: string }>>('message', (m) => {
					if (m?.channel === STATE_CHANNEL && (m.data?.op === 'menu.setAppMenu' || m.data?.op === 'menu.setApplicationMenu')) insert();
				}),
			);
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
				: k === 'f6' && !mod && !e.shiftKey && !e.altKey ? 'tabs:focus-bar'
				: null;
			if (id && act(id)) e.preventDefault();
		};
		addEventListener('keydown', keys, true);
		cleanups.push(() => removeEventListener('keydown', keys, true));
		// ⌘-click / middle-click on an app link: a new tab, in the background.
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
			if (!this.panes && !background && !blank && !a.target && path !== here() && path === (globalThis as { __desktopPageUrl?: () => string }).__desktopPageUrl?.()) {
				e.preventDefault();
				return showAddress(path);
			}
			// In panes the window's page shows no route: a link moves the active tab's view.
			if (this.panes && !background && !blank && (!a.target || a.target === '_self' || a.target === '_top' || a.target === '_parent')) {
				e.preventDefault();
				// target="_self" is SvelteKit's way to ask for a load too. In the window's page it'd be all the panes'.
				// As SvelteKit reads them: not said, on, or off (which counts too).
				const said = (name: string) => {
					const value = a.closest(`[data-sveltekit-${name}]`)?.getAttribute(`data-sveltekit-${name}`);
					return value == null ? undefined : value !== 'off' && value !== 'false';
				};
				if (said('reload') || a.target === '_self' || a.getAttribute('rel')?.split(/\s+/).includes('external')) {
					const asked = this.active;
					const at = asked?.path;
					const count = asked && this.#navigation(asked.id);
					return void this.#routeIsKept(path).then((kept) => {
						// Its tab closed meanwhile, or sent elsewhere, by this window or its own page: it's out of date.
						if (asked && (count !== this.#navigations.get(asked.id) || this.get(asked.id)?.path !== at)) return;
						const tab = kept ? this.open(path) : asked && this.get(asked.id);
						if (tab) this.#loadTab(tab, path);
					});
				}
				const replace = said('replacestate');
				const reset = said('reset');
				return this.#goActive(path, replace !== undefined || reset !== undefined ? { ...(replace !== undefined && { replace }), ...(reset !== undefined && { reset }) } : undefined);
			}
			if (!background && !blank && !this.keepsAlive(path)) return;
			if (a.target && !blank) return;
			e.preventDefault();
			this.open(path, { background, reuse: !background && !blank });
		};
		const g = globalThis as { __desktopAddressFollows?: unknown; __desktopOnLink?: (e: MouseEvent) => void };
		if (this.panes && g.__desktopAddressFollows) {
			// Once the page's handlers had their say (they can cancel it), before SvelteKit has the click.
			const stopped = (e: MouseEvent) => whenStopped(e, () => links(e));
			g.__desktopOnLink = links;
			addEventListener('click', stopped, true);
			addEventListener('auxclick', links);
			cleanups.push(() => {
				delete g.__desktopOnLink;
				removeEventListener('click', stopped, true);
				removeEventListener('auxclick', links);
			});
		} else {
			addEventListener('click', links, true);
			addEventListener('auxclick', links, true);
			cleanups.push(() => (removeEventListener('click', links, true), removeEventListener('auxclick', links, true)));
		}
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
		return () => {
			for (const c of cleanups) c();
		};
	}
}

const KEY = Symbol('kitop tabs');

/** <WindowTabs> hands its group to everything inside it. */
export function setTabs<T extends TabLike>(group: TabGroup<T>): TabGroup<T> {
	return setContext(KEY, group);
}

/** The group of the <WindowTabs> around this component: its tabs, `open`, `close`, … */
export function useTabs<T extends TabLike = TabLike & Record<string, any>>(): TabGroup<T> {
	const group = getContext<TabGroup<T> | undefined>(KEY);
	if (!group) throw new Error('useTabs(): no <WindowTabs> around this component');
	return group;
}
