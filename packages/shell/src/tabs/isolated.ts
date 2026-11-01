// An isolated tab's own web view (host.view), laid over the element it's attached to: created the
// first time the tab is shown, kept on the element's bounds, hidden while another tab is shown,
// destroyed with the tab. Its navigations and title flow back into the tab.
import { callPlatform, onPlatform } from '../platform/bus';
import type { TabGroup, TabLike } from './tabs.svelte.ts';

export interface IsolatedParams {
	tabs: TabGroup<any>;
	tab: TabLike;
	active: boolean;
}

export function isolatedView(node: HTMLElement, params: IsolatedParams) {
	let p = params;
	const id = `${p.tabs.id}-${p.tab.id}`;
	let view: 'none' | 'shown' | 'hidden' = 'none';
	let placed = '';
	let queue: Promise<unknown> = Promise.resolve();
	let frame = 0;
	let gone = false;
	const call = (op: string, args: object = {}) => callPlatform('view', op, { id, ...args });

	// The element's box — with no height of its own (a parent sized by the page it hides), down to
	// the bottom of the window.
	const bounds = () => {
		const r = node.getBoundingClientRect();
		const bottom = r.height > 1 ? r.bottom : innerHeight;
		return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(bottom - r.top) };
	};

	// One step at a time, each on the latest state: a quick switch can't leave the view over the page.
	async function sync() {
		if (gone) return;
		if (!p.active) {
			if (view === 'shown') (view = 'hidden'), await call('hide').catch(() => {});
			return;
		}
		const b = bounds();
		if (!b.width || !b.height) return;
		const key = `${b.x},${b.y},${b.width},${b.height}`;
		if (view === 'none') {
			const target = p.tab.url && !p.tab.path ? { url: p.tab.url } : { route: p.tab.path ?? '/' };
			if (!(await call('create', { ...target, bounds: b }).then(() => true, () => false))) return;
			view = 'shown';
			placed = key;
			return void run(); // the tab may have changed meanwhile (not awaited: the queue is waiting on this step)
		}
		if (key !== placed) (placed = key), await call('setBounds', b).catch(() => {});
		if (view === 'hidden') (view = 'shown'), await call('show').catch(() => {});
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
			const switched = next.active !== p.active;
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
