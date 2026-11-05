// Dragging a tab between panes, with the pointer rather than a native drag: a native drag over a
// pane goes to that pane's web view, another process the window's page can't hear. The pointer
// stays with the page it was pressed in, over the views too. What's drawn under a view can't be
// seen: the view over a drop zone makes room for it (see Panes.svelte).
import { callPlatform } from '../platform/bus';
import { pointerDrag } from './pointer-drag.ts';
import { decodedPath, plainRouteId, routeMatcher, type TabGroup, type TabLike } from './tabs.svelte.ts';
import type { PaneDrop, PaneZone } from './panes.svelte.ts';

/** How far a press moves before it's a drag (px). */
const THRESHOLD = 4;
/** A band along the panes' outer edge: a whole side of the window (px). */
const ROOT_EDGE = 18;
/** The share of a pane, from each side, that makes a new pane there. */
const SIDE = 0.28;

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const inside = (r: Rect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** The side of a box a point is nearest to, if it's within SIDE of it. */
function sideOf(r: Rect, x: number, y: number): PaneZone | null {
	const dist: Array<[PaneZone, number]> = [
		['left', (x - r.left) / r.width],
		['right', (r.right - x) / r.width],
		['top', (y - r.top) / r.height],
		['bottom', (r.bottom - y) / r.height],
	];
	const [zone, d] = dist.reduce((a, b) => (b[1] < a[1] ? b : a));
	return d < SIDE ? zone : null;
}

/** Where a tab let go at a point lands, if anywhere. */
export function dropAt(tabs: TabGroup<any>, id: string, x: number, y: number): PaneDrop | null {
	const panes = tabs.panes!;
	const root = document.querySelector(`[data-sd-panes="${tabs.id}"]`)?.getBoundingClientRect();
	if (!root || !inside(root, x, y)) return null;
	// Along the panes' own edge (their padding included): that whole side, when something else is
	// there to go beside. A bar wins over it.
	const edge: PaneZone | null = panes.panes.length < 2 ? null : x - root.left < ROOT_EDGE ? 'left' : root.right - x < ROOT_EDGE ? 'right' : root.bottom - y < ROOT_EDGE ? 'bottom' : null;
	for (const pane of panes.panes) {
		const bar = document.querySelector(`[data-sd-pane="${pane.id}"] > [data-sd-tabbar]`);
		if (bar && inside(bar.getBoundingClientRect(), x, y)) {
			const stripEl = bar.querySelector('[data-sd-tabs]')!;
			const strip = stripEl.getBoundingClientRect();
			const others = [...bar.querySelectorAll<HTMLElement>('[data-sd-tablist] > [role=tab]')].filter((t) => t.id !== `${tabs.id}-tab-${id}`).map((t) => t.getBoundingClientRect());
			const rtl = panes.rtl;
			const pinned = pane.tabs.filter((t) => t !== id && tabs.get(t)?.pinned).length;
			// After every tab whose middle it passed, in the bar's order; never before a pinned one.
			const index = Math.max(pinned, others.filter((r) => (rtl ? x < r.left + r.width / 2 : x > r.left + r.width / 2)).length);
			const near = (r: DOMRect) => (rtl ? r.left : r.right);
			const far = (r: DOMRect) => (rtl ? r.right : r.left);
			const a = others[index - 1];
			const b = others[index];
			const edge = a && b ? (near(a) + far(b)) / 2 : b ? far(b) : a ? near(a) : rtl ? strip.right : strip.left;
			return { kind: 'bar', pane: pane.id, index, x: edge - strip.left + stripEl.scrollLeft };
		}
	}
	if (edge) return { kind: 'root', zone: edge };
	for (const pane of panes.panes) {
		const box = document.querySelector(`[data-sd-pane="${pane.id}"] > [data-sd-pane-body]`)?.getBoundingClientRect();
		if (!box || !inside(box, x, y)) continue;
		const zone = sideOf(box, x, y);
		const drop: PaneDrop = zone ? { kind: 'side', pane: pane.id, zone } : { kind: 'center', pane: pane.id };
		return panes.allows(id, drop) ? drop : null;
	}
	return null;
}

/** Near the end of a bar with tabs out of sight: it scrolls, so a place among them can be reached. */
const AUTOSCROLL_EDGE = 28;
const AUTOSCROLL_STEP = 16;
function scrollBarAt(tabs: TabGroup<any>, x: number, y: number): boolean {
	for (const pane of tabs.panes!.panes) {
		const strip = document.querySelector(`[data-sd-pane="${pane.id}"] > [data-sd-tabbar] [data-sd-tabs]`);
		if (!strip || strip.scrollWidth <= strip.clientWidth) continue;
		const r = strip.getBoundingClientRect();
		if (!inside(r, x, y)) continue;
		const before = strip.scrollLeft;
		if (x - r.left < AUTOSCROLL_EDGE) strip.scrollLeft -= AUTOSCROLL_STEP;
		else if (r.right - x < AUTOSCROLL_EDGE) strip.scrollLeft += AUTOSCROLL_STEP;
		return strip.scrollLeft !== before;
	}
	return false;
}

type KitNavigation = { from: { url: URL } | null; to: { url: URL; route?: { id: string | null } } | null; type: string; cancel: () => void };

export interface PaneTabDragParams {
	tabs: TabGroup<any>;
	tab: TabLike;
	dragging: (on: boolean) => void;
}

/** A tab of a pane's bar, draggable: onto a bar, onto a pane or one of its sides, or out of the
 *  window (an app route opens in a new window). Escape cancels. */
export function paneTabDrag(node: HTMLElement, params: PaneTabDragParams) {
	let p = params;
	let ghost: HTMLElement | null = null;

	let scrolling: ReturnType<typeof setInterval> | undefined;
	let pointer = { x: 0, y: 0 };
	const stop = () => {
		clearInterval(scrolling);
		scrolling = undefined;
		ghost?.remove();
		ghost = null;
		document.documentElement.removeAttribute('data-sd-pane-dragging');
		p.dragging(false);
		if (p.tabs.panes) p.tabs.panes.drop = null;
	};
	const off = pointerDrag(node, {
		threshold: THRESHOLD,
		canStart: (e) => !p.tab.pinned && !(e.target instanceof Element && e.target.closest('button, input, textarea, select, a[href], [contenteditable], [data-sd-tab-close]')),
		onStart() {
			p.dragging(true);
			document.documentElement.setAttribute('data-sd-pane-dragging', '');
			// It follows the pointer where the page shows: over the bars and between the panes.
			ghost = node.cloneNode(true) as HTMLElement;
			ghost.removeAttribute('id');
			ghost.setAttribute('data-sd-tab-ghost', '');
			ghost.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:${node.offsetWidth}px;height:${node.offsetHeight}px;opacity:.8`;
			document.body.appendChild(ghost);
		},
		onMove({ x, y }) {
			if (ghost) ghost.style.transform = `translate(${x + 12}px, ${y + 8}px)`;
			pointer = { x, y };
			p.tabs.panes!.drop = dropAt(p.tabs, p.tab.id, x, y);
			// The pointer resting at the end of a bar: it goes on scrolling.
			scrolling ??= setInterval(() => {
				if (scrollBarAt(p.tabs, pointer.x, pointer.y)) p.tabs.panes!.drop = dropAt(p.tabs, p.tab.id, pointer.x, pointer.y);
			}, 40);
		},
		onEnd({ event, x, y }) {
			const drop = dropAt(p.tabs, p.tab.id, x, y);
			const away = x < 0 || y < 0 || x > innerWidth || y > innerHeight;
			const { tabs, tab } = p;
			stop();
			if (drop) tabs.place(tab.id, drop);
			else if (away && tabs.canDetach(tab)) void tabs.detach(tab.id, { x: event.screenX, y: event.screenY });
			// Let go where nothing changes: the keyboard to what shows, as for a click.
			if (!drop) tabs.focus(tabs.panes!.focusedId);
		},
		onCancel() {
			stop();
			p.tabs.focus(p.tabs.panes!.focusedId);
		},
		// A click on the tab: now the keyboard goes to its view.
		onPress: () => p.tabs.activate(p.tab.id),
	});
	return {
		update: (next: PaneTabDragParams) => void (p = next),
		destroy: off,
	};
}

/** In a pane's own page: its window hears where SvelteKit's router went (nothing native sees it), a
 *  link to open in a tab opens one next to it rather than in the default browser, and a `keepAlive`
 *  route goes to its own tab: the navigation is canceled before anything loads, so this page stays
 *  as it is, with what the user typed, and its history. */
/** An event a handler stops doesn't get to the listeners further on, while its default action still
 *  happens: `fn`, once that handler is done (what it did to the event counts). */
export function whenStopped(e: Event, fn: () => void): void {
	for (const m of ['stopPropagation', 'stopImmediatePropagation'] as const) {
		const stop = e[m];
		if (typeof stop !== 'function') continue;
		e[m] = function (this: Event) {
			stop.call(this);
			queueMicrotask(fn);
		};
	}
}

export function connectPaneView(keepAlive: string[] = []): () => void {
	const g = globalThis as {
		__desktopView?: string;
		__desktopTabView?: boolean;
		__desktopRetarget?: unknown;
		__desktopNavigating?: () => boolean;
		__desktopGotoAsked?: { state?: unknown };
		__desktopSerialized?: (state: unknown) => string;
		__desktopOnLink?: (e: MouseEvent) => void;
		__desktopStaying?: (was: boolean) => void;
		__desktopPageUrl?: () => string | undefined;
		__desktopShownUrl?: () => string | undefined;
		__desktopBeforeNavigate?: (fn: (nav: KitNavigation) => void) => () => void;
		__desktopAfterNavigate?: (fn: () => void) => () => void;
		__desktopRouteOf?: (href: string) => Promise<string | null>;
	};
	const id = g.__desktopView;
	// A view of the app's own (host.view): no tab to tell, no window to take it to.
	if (id === undefined || !g.__desktopTabView) return () => {};
	const kept = keepAlive.map(plainRouteId);
	const patterns = keepAlive.map(routeMatcher);
	const send = (channel: string, data: object) => callPlatform('events', 'emit', { channel, data: { id, ...data } });
	let last = '';
	let replaced = false; // how its last history entry was made
	let first = true; // its first report: where it was opened, its state may be on its way
	let gone = false;
	// Where the page is, not the address: in a traversal the address goes first, and may be sent back.
	const report = () => {
		const path = g.__desktopShownUrl?.() ?? location.pathname + location.search + location.hash;
		// Its entry too: the window keeps it with the address, to come back to it with its state, and a
		// new state at the same address is an entry of its own.
		const entry = (g as { __desktopEntryOptions?: () => object }).__desktopEntryOptions?.();
		const at = `${path} ${JSON.stringify(entry ?? {})}`;
		if (gone || at === last) return;
		last = at;
		void send('tabs:view-url', { path, entry, replace: replaced, first }).catch(() => {});
		first = false;
	};
	const scrolls = new Map<string, [number, number]>();
	(g as { __desktopRestoreScroll?: () => void }).__desktopRestoreScroll = () => {
		const at = scrolls.get(location.pathname + location.search + location.hash);
		if (at) scrollTo(at[0], at[1]);
	};
	const stopBefore = g.__desktopBeforeNavigate?.((nav) => {
		// Where it was, for Back or Forward in the window to come back to it.
		if (nav.from) scrolls.set(nav.from.url.pathname + nav.from.url.search + nav.from.url.hash, [scrollX, scrollY]);
		// What goto() was asked, for this navigation only (a form's redirect has no goto()).
		const askedFor = nav.type === 'goto' ? g.__desktopGotoAsked : undefined;
		delete g.__desktopGotoAsked;
		const to = nav.to?.url;
		// A spare view being taken to its tab's route isn't leaving for it.
		if (!to || g.__desktopRetarget || to.origin !== location.origin) return;
		// From what the page is at: in a traversal the address is already the destination's.
		if (to.pathname === (nav.from?.url.pathname ?? location.pathname)) return;
		// goto()'s state goes along, canceled here before an entry has it.
		const stateJson = askedFor?.state === undefined ? undefined : g.__desktopSerialized?.(askedFor.state);
		const open = () => send('tabs:view-open', { path: to.pathname + to.search + to.hash, reuse: true, stateJson }).then(() => {}, () => location.assign(to.href)); // its window didn't get it: not a navigation that does nothing
		// The route as SvelteKit resolved it: its matchers, a static route beside it.
		const route = nav.to?.route?.id;
		if (route) {
			if (!kept.includes(plainRouteId(route))) return;
			nav.cancel();
			return void open();
		}
		// A link it leaves to the browser (target="_self", data-sveltekit-reload): not resolved. If it may
		// be one, held back while that's found out, and the browser's after all if it isn't.
		if (!patterns.some((m) => m.test(decodedPath(to.pathname)))) return;
		nav.cancel();
		void Promise.resolve(g.__desktopRouteOf?.(to.href)).then(
			(id) => (id && kept.includes(plainRouteId(id)) ? open() : location.assign(to.href)),
			() => location.assign(to.href),
		);
	});
	const stopAfter = g.__desktopAfterNavigate?.(report);
	const originals = { pushState: history.pushState, replaceState: history.replaceState };
	for (const m of ['pushState', 'replaceState'] as const)
		history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
			originals[m].apply(this, args);
			replaced = m === 'replaceState';
			// In a navigation of SvelteKit's, it says when it's there (afterNavigate); until then its page
			// is the one it's leaving, not a place this tab is at.
			const kit = (args[0] as { 'sveltekit:metadata'?: { pageUrl?: string } } | null)?.['sveltekit:metadata'];
			if (!kit || kit.pageUrl) queueMicrotask(report);
		};
	// A hash change back or forward: no navigation to wait for.
	// Once SvelteKit is there, if it's on its way: it may get there saying nothing (a shallow entry).
	const popped = () => {
		let tries = 0;
		const look = () => {
			if (g.__desktopNavigating?.() && ++tries < 100) return void setTimeout(look, 50);
			replaced = false; // SvelteKit writes on the entry the browser made (a fragment): it's a new one all the same
			report();
		};
		setTimeout(look, 50);
	};
	const linkOf = (e: MouseEvent) => {
		if (e.defaultPrevented || (e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return null;
		const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
		if (!a || a.hasAttribute('download')) return null;
		// An SVG link's href isn't a string.
		const href = (a as HTMLAnchorElement).href as string | SVGAnimatedString;
		try {
			return { url: new URL(typeof href === 'string' ? href : href.baseVal, document.baseURI), target: a.getAttribute('target') };
		} catch {
			return null;
		}
	};
	let navigating = false;
	const plugin = !!g.__desktopSerialized;
	const early = (e: MouseEvent) => {
		// Before SvelteKit takes a link out of the app for a page about to unload.
		navigating = g.__desktopNavigating?.() ?? false;
		// Last of all whatever the page registered since: it can still cancel. Or its handler stops the event.
		removeEventListener(e.type as 'click', out);
		addEventListener(e.type as 'click', out);
		whenStopped(e, () => (links(e), out(e)));
		// Without the plugin's listener, which comes after the page's handlers and before SvelteKit's.
		if (!plugin) links(e);
	};
	const links = (e: MouseEvent) => {
		const link = linkOf(e);
		if (!link || link.url.origin !== location.origin) return;
		const background = e.type === 'auxclick' || e.metaKey || e.ctrlKey;
		if (!background && link.target !== '_blank') return;
		e.preventDefault();
		const { url } = link;
		void send('tabs:view-open', { path: url.pathname + url.search + url.hash, background }).catch(() => location.assign(url.href));
	};
	// A link out of the app: the browser's or the mail client's, as from a window's page; this page stays.
	// Last: after the page's own handlers and SvelteKit's (a beforeNavigate can still cancel it), which
	// takes it for a page about to unload and has to be told it isn't.
	const out = (e: MouseEvent) => {
		const link = linkOf(e);
		if (!link || link.url.origin === location.origin || ['javascript:', 'data:', 'about:', 'blob:', 'file:'].includes(link.url.protocol)) return;
		e.preventDefault();
		g.__desktopStaying?.(navigating);
		void callPlatform('shell', 'openExternal', { url: link.url.href }).catch(() => {});
	};
	// Its page can take a navigation's state from now on (see deliverState).
	const hydrated = () => void send('tabs:view-ready', {}).catch(() => {});
	addEventListener('popstate', popped);
	if (plugin) g.__desktopOnLink = links;
	addEventListener('click', early, true);
	addEventListener('auxclick', early, true);
	if (plugin) addEventListener('auxclick', links);
	addEventListener('hashchange', popped); // SvelteKit leaves a link to a fragment to the browser
	addEventListener('click', out);
	addEventListener('auxclick', out);
	if (document.documentElement.hasAttribute('data-desktop-hydrated')) hydrated();
	else addEventListener('desktop:hydrated', hydrated, { once: true });
	report();
	return () => {
		gone = true;
		stopBefore?.();
		stopAfter?.();
		history.pushState = originals.pushState;
		history.replaceState = originals.replaceState;
		removeEventListener('popstate', popped);
		delete g.__desktopOnLink;
		removeEventListener('click', early, true);
		removeEventListener('auxclick', early, true);
		removeEventListener('auxclick', links);
		removeEventListener('hashchange', popped);
		removeEventListener('click', out);
		removeEventListener('auxclick', out);
		removeEventListener('desktop:hydrated', hydrated);
	};
}
