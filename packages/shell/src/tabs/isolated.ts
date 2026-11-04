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
async function make(id: string, target: { route: string } | { url: string }, bounds: Rect): Promise<boolean> {
	const route = 'route' in target;
	const ready = drawn(id, route);
	const made = await callPlatform('view', 'create', { id, ...target, transparent: route, bounds, hidden: true }).then(() => true, () => false);
	if (made) await ready;
	return made;
}

/** Views made ahead for a tab about to open (a hovered link, the spare one): drawn, then out of
 *  the window. `want`: the page the tab it went to is at, when not the one it was made on. */
const ahead = new Map<string, { made: Promise<boolean>; path: string; want?: string }>();

/** Make the view of a tab not open yet (its view id), for an app path: opened, it shows at once. */
export function prepareView(id: string, path: string, bounds: Rect): void {
	if (!ahead.has(id)) ahead.set(id, { path, made: make(id, { route: path }, bounds).then(async (ok) => (ok && (await callPlatform('view', 'hide', { id }).catch(() => {})), ok)) });
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
	const code = `(async () => { await globalThis.__desktopGoto?.(${JSON.stringify(path)}, { replace: true }); await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 300); }); return true; })()`;
	await callPlatform('view', 'executeJavaScript', { id, code }).catch(() => {});
}

// The page going (a reload) takes the views made ahead along.
if (typeof window !== 'undefined') addEventListener('pagehide', () => [...ahead.keys()].forEach(dropView));

/** A view made ahead, not used: gone — right away (calls run in order: after its create, even one
 *  in flight; a page unloading can't wait for an answer). */
export function dropView(id: string): void {
	if (ahead.delete(id)) void callPlatform('view', 'destroy', { id }).catch(() => {});
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
	let queue: Promise<unknown> = Promise.resolve();
	let frame = 0;
	let gone = false;
	const call = (op: string, args: object = {}) => callPlatform('view', op, { id, ...args });

	// The element's box — hidden while its view loads, the box of the one shown in its place (the
	// page, another tab's view).
	const bounds = () => {
		const shown = node.hidden
			? node.parentElement?.querySelector<HTMLElement>(':scope > :is([data-sd-tabcontent], [data-sd-tabview], [data-sd-tabpanel]):not([hidden])')
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
			ahead.delete(id);
			if (!(await entry.made)) return void run();
			if (entry.want && entry.want !== entry.path) {
				await retarget(id, entry.want);
				view = 'loading';
			} else view = 'hidden';
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
		if (!b.width || !b.height) return;
		const key = `${b.x},${b.y},${b.width},${b.height}`;
		if (view === 'none') {
			view = 'loading';
			placed = key;
			if (!(await make(id, route ? { route: p.tab.path ?? '/' } : { url: p.tab.url! }, b))) view = 'none';
			else run(); // the tab may have changed meanwhile (not awaited: the queue is waiting on this step)
			return;
		}
		if (key !== placed) (placed = key), await call('setBounds', b).catch(() => {});
		if (view !== 'shown') (view = 'shown'), await call('show').catch(() => {});
		if (p.active) p.tabs.reveal(p.tab.id); // in front: the tab shown, the address its own
	}
	const run = () => (queue = queue.then(sync).catch((e) => console.error('[tabs] isolated view', e)));
	// Layout changes: once per frame.
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(() => ((frame = 0), run()));
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
		if (url.origin === location.origin) p.tabs.update(p.tab.id, { path: url.pathname + url.search + url.hash });
		else p.tabs.update(p.tab.id, { url: e.url });
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
			observer.disconnect();
			removeEventListener('resize', schedule);
			removeEventListener('scroll', schedule, true);
			removeEventListener('pagehide', unload);
			offNav();
			offTitle();
			queue = queue.then(() => view !== 'none' && call('destroy').catch(() => {}));
		},
	};
}
