// An isolated tab's own web view (host.view), laid over the element it's attached to: created with
// the tab for an app route (it runs from then on, a background tab too; at launch, once the page
// is up), or ahead when a link to it is hovered; the first time it's activated for another site —
// out of sight until its page is drawn, the tab shown before staying meanwhile —, kept on the
// element's bounds, hidden while another tab is shown, destroyed with the tab. Its navigations and
// title flow back into the tab.
import { callPlatform, onPlatform } from '../platform/bus';
import type { TabGroup, TabLike } from './tabs.svelte.ts';

export interface IsolatedParams {
	tabs: TabGroup<any>;
	tab: TabLike;
	/** The active tab: its view comes in front once drawn. */
	active: boolean;
	/** The tab on screen (the active one, or the one before while the active one loads). */
	shown: boolean;
	/** Its view suspended (memory): closed while not on screen, made again when shown. */
	suspended?: boolean;
	/** Where its view goes (panes: its pane's box), rather than this element's. */
	box?: () => Rect | null;
	/** Changes when `box` does, without this element changing (panes moving). */
	revision?: unknown;
	/** Along its edges, what it leaves to the window's page under it (px; macOS): the line between two panes. */
	grab?: () => { top: number; right: number; bottom: number; left: number } | null;
}

/** How long a view may take to draw its page before it's shown anyway. */
const READY_TIMEOUT = 3000;

type Rect = { x: number; y: number; width: number; height: number };

/** An element's box — with no height of its own (a parent sized by the page it hides), down to
 *  the bottom of the window. */
function boxOf(el: Element): Rect {
	const r = el.getBoundingClientRect();
	const bottom = r.height > 1 ? r.bottom : innerHeight;
	return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(bottom - r.top) };
}

/** Where tabs' content goes: the page or the view on screen. */
export function contentBox(): Rect {
	const el = document.querySelector(':is([data-sd-tabcontent], [data-sd-tabview]):not([hidden])');
	return el ? boxOf(el) : { x: 0, y: 0, width: innerWidth, height: innerHeight };
}

/** Its page drawn: the app's (a route) says so once rendered, another site once loaded. */
function drawn(id: string, route: boolean): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => (clearTimeout(timer), offReady(), offFailed(), resolve());
		const timer = setTimeout(done, READY_TIMEOUT);
		const offReady = route
			? onPlatform<{ channel?: string; data?: { id?: string } }>('message', (m) => void (m?.channel === 'tabs:view-ready' && m.data?.id === id && done()))
			: onPlatform<{ id: string }>('viewLoaded', (e) => void (e?.id === id && done()));
		const offFailed = onPlatform<{ id: string }>('viewFailed', (e) => void (e?.id === id && done()));
	});
}

/** Make a view out of sight (see-through in the window, still drawing) and wait for its page to
 *  be drawn; false if it couldn't be made. An app page is see-through for good: where it paints
 *  nothing, your layout's background under it shows (not WebKit's own, black or white); another
 *  site keeps a browser's white. */
async function make(id: string, target: { route: string } | { url: string }, bounds: Rect, pane: boolean, stopped?: Promise<void>): Promise<boolean> {
	const route = 'route' in target;
	const ready = drawn(id, route);
	const made = await callPlatform('view', 'create', { id, ...target, tab: true, ...(pane && { pane: true }), transparent: route, bounds, hidden: true }).then(() => true, () => false);
	if (made) await (stopped ? Promise.race([ready, stopped]) : ready);
	return made;
}

/** Views going away: their last step. A tab closed and reopened at once has the same view id: its
 *  new view waits for the old one to be gone, or that one's end would take the new one with it. */
const retiring = new Map<string, Promise<unknown>>();

/** Views made ahead for a tab about to open (a hovered link, the spare one): drawn, then out of
 *  the window. `want`: the page the tab it went to is at, when not the one it was made on. */
type Ahead = { made: Promise<boolean>; path: string; want?: string; abandoned?: boolean };
const ahead = new Map<string, Ahead>();
/** Those a tab took, not drawn yet: where it should go can still change. */
const adopting = new Map<string, Ahead>();

/** Make the view of a tab not open yet (its view id), for an app path: opened, it shows at once. */
export function prepareView(id: string, path: string, bounds: Rect, pane = false): void {
	if (ahead.has(id)) return;
	const entry: Ahead = { path, made: Promise.resolve(false) };
	// Its tab closed before it was drawn: another view may have this id by now, not to be hidden.
	entry.made = make(id, { route: path }, bounds, pane).then(async (ok) => {
		if (ok && !entry.abandoned) await callPlatform('view', 'hide', { id }).catch(() => {});
		return ok;
	});
	ahead.set(id, entry);
}

/** A view made ahead goes to a tab at another page (the spare one): it goes there when the tab
 *  takes it, by SvelteKit's router — no new process, no app start. */
export function retargetView(id: string, path: string): void {
	const entry = ahead.get(id);
	if (entry) entry.want = path;
}

/** Take a view made ahead to `path`, in the window but see-through (macOS; elsewhere out of sight),
 *  then wait for the page drawn. */
async function retarget(id: string, path: string): Promise<void> {
	if (/Mac/.test(navigator.platform)) await callPlatform('view', 'show', { id, seeThrough: true }).catch(() => {});
	// Two frames to draw it — or a moment, when nothing draws (the window covered by another app).
	// Failed: no router yet (not hydrated either: it would start again where it was loaded), it refused (no such route), or something canceled it (it says nothing: no
	// navigation ended, and the page isn't there). The page is loaded instead, so the tab is at its path
	// whatever happens. Not failed: a navigation ended, even elsewhere or back here (a redirect, a
	// trailing slash), or another came meanwhile, which is the one that counts. The mark goes either way, or this page
	// would never again leave for a kept route's tab.
	const to = JSON.stringify(path);
	const code = `(async () => { const g = globalThis; const norm = (u) => { const url = new URL(u, location.href); return url.pathname + url.search + url.hash; }; if (!g.__desktopGoto || !document.documentElement.hasAttribute('data-desktop-hydrated')) return false; g.__desktopRetarget = true; const before = g.__desktopPageUrl?.(); const asked = g.__desktopNavigations ?? 0; let done = false; const off = g.__desktopAfterNavigate?.(() => { done = true; }); try { await g.__desktopGoto(${to}, { replace: true }); } catch { if ((g.__desktopNavigations ?? 0) === asked) return false; } finally { delete g.__desktopRetarget; off?.(); } const after = g.__desktopPageUrl?.(); if (!done && before !== undefined && after === before && norm(before) !== norm(${to}) && (g.__desktopNavigations ?? 0) === asked) return false; await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 300); }); return true; })()`;
	const went = await callPlatform('view', 'executeJavaScript', { id, code }).catch(() => true);
	if (went === false) await callPlatform('view', 'navigate', { id, route: path }).catch(() => {});
}

// The page going (a reload) takes the views made ahead along.
if (typeof window !== 'undefined') addEventListener('pagehide', () => [...ahead.keys()].forEach(dropView));

/** A view made ahead, not used: gone — right away (calls run in order: after its create, even one
 *  in flight; a page unloading can't wait for an answer). */
export function dropView(id: string): void {
	if (ahead.delete(id)) void callPlatform('view', 'destroy', { id }).catch(() => {});
}

/** What goto() took in the window's page, for its pane's router. */
export type GotoOptions = {
	replace?: boolean;
	/** A link to where it is, or goto() said so: its loads run again. */
	refreshAll?: boolean;
	/** Back or Forward in the window: where it was scrolled comes back. */
	traversal?: boolean;
	/** `data-sveltekit-reset`, goto()'s. */
	reset?: boolean;
	persistState?: boolean;
	shallow?: boolean;
	/** A shallow entry's page. */
	pageUrl?: string;
	/** The state as SvelteKit serialized it (a Date stays one). */
	stateJson?: string;
};

/** Give a page its navigation's state, if it's there: the app's page, hydrated, at that path. Not
 *  there: false, and it says so when it is (`tabs:view-url`, `tabs:view-ready`). */
export function deliverState(id: string, path: string, options: GotoOptions): Promise<boolean> {
	const to = JSON.stringify(path);
	// Another site's page at the same path, or claiming to have the router, gets nothing: its origin comes first.
	const code = `(async () => { if (location.origin !== ${JSON.stringify(location.origin)}) return false; const g = globalThis; const norm = (u) => { const url = new URL(u, location.href); return url.pathname + url.search + url.hash; }; if (!g.__desktopGoto || !document.documentElement.hasAttribute('data-desktop-hydrated') || norm(location.href) !== norm(${to})) return false; let off; let done = false; off = g.__desktopAfterNavigate?.(() => { done = true; }); try { await g.__desktopGoto(${to}, ${JSON.stringify({ ...options, replace: true })}); } catch {} finally { off?.(); } g.__desktopCanceled = !done; return true; })()`;
	return callPlatform<boolean>('view', 'executeJavaScript', { id, code }).then(
		(done) => done === true,
		() => false, // not made yet
	);
}

/** The last navigation asked of a view's page got there: false if its page canceled it. */
export function navigationTaken(id: string): Promise<boolean> {
	return callPlatform<boolean>('view', 'executeJavaScript', { id, code: 'globalThis.__desktopCanceled !== true' }).then(
		(taken) => taken !== false,
		() => true,
	);
}

/** A navigation that found no view: where a view being made should go once it's there. */
const missed = new Map<string, string>();

/** A spare view still on its way to its tab: it isn't where it's going yet. */
export const viewComing = (id: string): boolean => adopting.has(id);

/** Its tab closed: a tab reopened with this id starts afresh. */
export const forgetMissed = (id: string): void => void missed.delete(id);

/** A view at another page of the app, by SvelteKit's router (loaded when it's on another site).
 *  Resolves where its page is then: something in it may have canceled that. Null: no view yet.
 *  Undefined: being loaded there; what it is isn't known yet (it may be a download). */
export function navigateView(id: string, path: string, otherSite: boolean, options?: GotoOptions): Promise<string | null | undefined> {
	// A spare view still on its way to its tab: it goes here instead, when it's ready.
	const coming = adopting.get(id);
	if (coming) {
		coming.want = path;
		return Promise.resolve(path);
	}
	if (otherSite) return callPlatform('view', 'navigate', { id, route: path }).then(() => undefined, () => null);
	// No router to take it yet (not hydrated), or no page of its for that address (a file, an endpoint):
	// false, the address is loaded instead. A navigation that fails stays as it is. Another navigation of its own getting there first ends the wait
	// (this one may never be done); a shallow entry's page, on its way there, doesn't.
	const shallowWait = options?.shallow
		? `if (!document.documentElement.hasAttribute('data-desktop-hydrated') && location.origin === ${JSON.stringify(location.origin)}) await new Promise((resolve) => { addEventListener('desktop:hydrated', resolve, { once: true }); setTimeout(resolve, 10000); });`
		: '';
	// Shallow: it's about the page it has, which a load would replace; it waits for its router.
	// Never ready: it stays where it is (as if canceled), the page it has isn't replaced.
	const notReady = options?.shallow ? '(g.__desktopCanceled = true, location.pathname + location.search + location.hash)' : 'false';
	const code = `(async () => { const g = globalThis; ${shallowWait} if (!g.__desktopGoto || !document.documentElement.hasAttribute('data-desktop-hydrated')) return ${notReady}; g.__desktopNavigations = (g.__desktopNavigations ?? 0) + 1; let off; let done = false; const overtaken = new Promise((resolve) => { off = g.__desktopAfterNavigate?.((nav) => { const href = nav?.to?.url?.href; if (href !== ${JSON.stringify(options?.pageUrl ?? null)} || href === new URL(${JSON.stringify(path)}, location.href).href) { done = true; resolve(); } }); }); const go = async () => { if ((await g.__desktopRouteOf?.(${JSON.stringify(path)}).catch(() => '')) === null) return false; await g.__desktopGoto(${JSON.stringify(path)}, ${JSON.stringify(options ?? {})}); }; try { if ((await Promise.race([go(), overtaken])) === false) return false; } catch {} finally { off?.(); } g.__desktopCanceled = !done; return g.__desktopShownUrl?.() ?? null; })()`;
	return callPlatform<string | null | false>('view', 'executeJavaScript', { id, code }).catch((e) => {
		missed.set(id, path); // no view yet: it may be being made
		throw e;
	}).then(
		// Its page is still loading, its router isn't there yet: it's loaded at that path instead.
		(at) => {
			if (at !== false) return at;
			return callPlatform('view', 'navigate', { id, route: path }).then(() => undefined, () => null);
		},
		() => null,
	);
}

/** At launch, views of tabs in the background wait for the window's page: hydrated (without the
 *  desktop plugin's signal, a while). */
let calm = false;
const settled =
	typeof document === 'undefined'
		? Promise.resolve()
		: new Promise<void>((resolve) => {
				const go = () => setTimeout(resolve, 0);
				if (document.documentElement.hasAttribute('data-desktop-hydrated')) go();
				else addEventListener('desktop:hydrated', go, { once: true });
				setTimeout(resolve, 3000);
			}).then(() => void (calm = true));
export const whenSettled = (): Promise<void> => settled;

export function isolatedView(node: HTMLElement, params: IsolatedParams) {
	let p = params;
	const id = `${p.tabs.id}-${p.tab.id}`;
	// 'loading': in the window, see-through, until its page is drawn.
	let view: 'none' | 'loading' | 'shown' | 'hidden' = 'none';
	let placed = '';
	let grabbed = '';
	let queue: Promise<unknown> = retiring.get(id) ?? Promise.resolve();
	let frame = 0;
	let gone = false;
	let adopted: { abandoned?: boolean } | null = null;
	let stop = () => {};
	const stopped = new Promise<void>((resolve) => (stop = resolve));
	const call = (op: string, args: object = {}) => callPlatform('view', op, { id, ...args });

	// The element's box — hidden while its view loads, the box of the one shown in its place (the
	// page, another tab's view).
	const bounds = () => {
		if (p.box) return p.box() ?? { x: 0, y: 0, width: 0, height: 0 };
		const shown = node.hidden
			? node.parentElement?.querySelector<HTMLElement>(':scope > :is([data-sd-tabcontent], [data-sd-tabview]):not([hidden])')
			: null;
		return boxOf(shown ?? node);
	};

	// One step at a time, each on the latest state: a quick switch can't leave the view over the page.
	async function sync() {
		if (gone) return;
		const entry = view === 'none' && ahead.get(id);
		if (entry) {
			// Made ahead (a hovered link, the spare one): drawn already, or soon — at another page,
			// taken there first.
			// It's this action's from here: closed meanwhile, its end takes the view along, and a tab
			// reopened at once doesn't wait for a page that may never come.
			ahead.delete(id);
			adopted = entry;
			adopting.set(id, entry);
			view = 'hidden';
			const made = await Promise.race([entry.made, stopped.then(() => true)]);
			if (adopting.get(id) === entry) adopting.delete(id);
			if (!made) view = 'none';
			else if (entry.want && entry.want !== entry.path) {
				await Promise.race([retarget(id, entry.want), stopped]);
				view = 'loading';
			}
			placed = '';
			return void run();
		}
		const route = !(p.tab.url && !p.tab.path);
		if (!p.active && !p.shown && p.suspended) {
			if (view !== 'none') (view = 'none'), await call('destroy').catch(() => {});
			return;
		}
		if (!p.active && !p.shown) {
			// Out of the window (still running): it doesn't stand over the page.
			if (view === 'shown' || view === 'loading') (view = 'hidden'), await call('hide').catch(() => {});
			if (view !== 'none' || !route) return;
			if (!calm) {
				await settled; // at launch: after the window's page
				return void run();
			}
		}
		const b = bounds();
		if (b.width <= 0 || b.height <= 0) {
			// Nothing of its pane left (the room for a dragged tab): it doesn't stay over it.
			if (p.box && view === 'shown') {
				view = 'hidden';
				placed = '';
				await call('hide').catch(() => {});
			}
			return;
		}
		const key = `${b.x},${b.y},${b.width},${b.height}`;
		if (view === 'none') {
			view = 'loading';
			placed = key;
			grabbed = '';
			const asked = p.tab.path;
			if (!(await make(id, route ? { route: p.tab.path ?? '/' } : { url: p.tab.url! }, b, !!p.box, stopped))) view = 'none';
			else {
				// Sent elsewhere too early for it, just before it was made or meanwhile (a link right after its
				// tab came back): there. Unless it's where it was made.
				const to = missed.get(id);
				missed.delete(id);
				if (to !== undefined && route && p.box && to === p.tab.path && to !== asked) await call('navigate', { route: to }).catch(() => {});
				run();
			} // the tab may have changed meanwhile (not awaited: the queue is waiting on this step)
			return;
		}
		if (key !== placed) (placed = key), await call('setBounds', b).catch(() => {});
		const grab = p.grab?.();
		const grabKey = grab ? JSON.stringify(grab) : '';
		if (grab && grabKey !== grabbed) (grabbed = grabKey), void call('setHitInset', grab).catch(() => {}); // only macOS's page hears under a view
		if (view !== 'shown') {
			view = 'shown';
			await call('show').catch(() => {});
			// In panes the keyboard goes to the tab in focus (its window's page has it otherwise).
			if (p.box && p.tabs.activeId === p.tab.id && !p.tabs.pageKeyboard) await call('focus').catch(() => {});
		}
		if (p.active) p.tabs.reveal(p.tab.id); // in front: the tab shown, the address its own
	}
	const run = () => (queue = queue.then(sync).catch((e) => console.error('[tabs] isolated view', e)));
	// Layout changes: once per frame — or a moment later when no frames come (the window covered by
	// another app, where a view still has to follow).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		if (frame) return;
		const go = () => {
			if (!frame) return;
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			frame = 0;
			run();
		};
		frame = requestAnimationFrame(go);
		timer = setTimeout(go, 100);
	};

	// The page going (a reload) takes its views along: they belong to the window, not the page.
	const unload = () => void (view !== 'none' && call('destroy').catch(() => {}));
	const observer = new ResizeObserver(schedule);
	observer.observe(node);
	addEventListener('resize', schedule);
	addEventListener('scroll', schedule, true);
	addEventListener('pagehide', unload);
	const offNav = onPlatform<{ id: string; url: string }>('viewNavigated', (e) => {
		if (e?.id !== id) return;
		const url = new URL(e.url, location.origin);
		if (p.box) queueMicrotask(() => p.tabs.followAddress(p.tab.id));
		// In panes a tab is at one place: another site's page isn't at the path it left (a link to that
		// path has to go there, a new window has to open what it shows).
		if (url.origin === location.origin) p.tabs.update(p.tab.id, { path: url.pathname + url.search + url.hash, ...(p.box && { url: undefined }) });
		else if (!p.box || /^https?:$/.test(url.protocol)) p.tabs.update(p.tab.id, { url: e.url, ...(p.box && { path: undefined }) });
	});
	// Another site's own router (panes: a tab reopens where it was; the app's pages say so themselves).
	const offUrl = onPlatform<{ id: string; url: string }>('viewUrl', (e) => {
		if (e?.id !== id || !/^https?:/.test(e.url)) return;
		// Without panes, a tab keeps its path whatever its page's router does; its fragment it follows.
		if (!p.box) {
			const url = new URL(e.url);
			const noFragment = (at: string) => new URL(at, location.origin).href.split('#')[0];
			const now = p.tab.url ?? p.tab.path;
			if (now === undefined || noFragment(now) !== url.href.split('#')[0]) return;
			if (p.tab.url !== undefined) p.tabs.update(p.tab.id, { url: e.url });
			else if (p.tab.path !== url.pathname + url.search + url.hash) p.tabs.update(p.tab.id, { path: url.pathname + url.search + url.hash });
			return;
		}
		if (new URL(e.url).origin !== location.origin && p.tab.url !== e.url) p.tabs.update(p.tab.id, { url: e.url, path: undefined });
	});
	const offTitle = onPlatform<{ id: string; title: string }>('viewTitle', (e) => {
		if (e?.id === id && e.title) p.tabs.update(p.tab.id, { title: e.title });
	});
	run();

	return {
		update(next: IsolatedParams) {
			const switched = next.active !== p.active || next.shown !== p.shown || next.suspended !== p.suspended;
			p = next;
			if (switched) run(); // shown / hidden now, not a frame later
			else schedule();
		},
		destroy() {
			gone = true;
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			observer.disconnect();
			removeEventListener('resize', schedule);
			removeEventListener('scroll', schedule, true);
			removeEventListener('pagehide', unload);
			offNav();
			offUrl();
			offTitle();
			stop();
			if (adopted) {
				adopted.abandoned = true;
				if (adopting.get(id) === adopted) adopting.delete(id);
			}
			const last = queue.then(() => view !== 'none' && call('destroy').catch(() => {}));
			queue = last;
			retiring.set(id, last);
			void last.finally(() => retiring.get(id) === last && retiring.delete(id));
		},
	};
}
