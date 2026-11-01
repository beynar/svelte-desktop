// An isolated tab's own web view (host.view), laid over the element it's attached to: created the
// first time the tab is shown, kept on the element's bounds, hidden while another tab is shown,
// destroyed with the tab. Its navigations and title flow back into the tab.
import { callPlatform, onPlatform } from '../platform/bus';
import type { Tab, Tabs } from './tabs.svelte.ts';

export interface IsolatedParams {
	tabs: Tabs<any>;
	tab: Tab<any>;
	active: boolean;
}

export function isolatedView(node: HTMLElement, params: IsolatedParams) {
	let p = params;
	const id = `${p.tabs.id}-${p.tab.id}`;
	let created: Promise<unknown> | null = null;
	let shown = false;

	// The area the view covers: the element's own box, or — with no height of its own (a parent
	// sized by the page it hides) — down to the bottom of the nearest scrolling container, else
	// of the window.
	const scroller = (() => {
		for (let el = node.parentElement; el && el !== document.body; el = el.parentElement)
			if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowY) && el.clientHeight > 0) return el;
		return null;
	})();
	const bounds = () => {
		const r = node.getBoundingClientRect();
		const bottom = r.height > 1 ? r.bottom : scroller ? scroller.getBoundingClientRect().bottom : innerHeight;
		return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(bottom - r.top) };
	};
	async function sync() {
		if (!p.active) {
			if (created && shown) await created.then(() => callPlatform('view', 'hide', { id })).catch(() => {});
			shown = false;
			return;
		}
		const b = bounds();
		if (!b.width || !b.height) return;
		if (!created) {
			const target = p.tab.url && !p.tab.path ? { url: p.tab.url } : { route: p.tab.path ?? '/' };
			created = callPlatform('view', 'create', { id, ...target, bounds: b }).catch(() => (created = null));
			shown = true;
			return;
		}
		await created;
		await callPlatform('view', 'setBounds', { id, ...b }).catch(() => {});
		if (!shown) await callPlatform('view', 'show', { id }).catch(() => {});
		shown = true;
	}

	const observer = new ResizeObserver(() => void sync());
	observer.observe(node);
	if (scroller) observer.observe(scroller);
	addEventListener('resize', sync);
	const offNav = onPlatform<{ id: string; url: string }>('viewNavigated', (e) => {
		if (e?.id !== id) return;
		const url = new URL(e.url, location.origin);
		if (url.origin === location.origin) p.tabs.update(p.tab.id, { path: url.pathname + url.search + url.hash });
		else p.tabs.update(p.tab.id, { url: e.url });
	});
	const offTitle = onPlatform<{ id: string; title: string }>('viewTitle', (e) => {
		if (e?.id === id && e.title) p.tabs.update(p.tab.id, { title: e.title });
	});
	void sync();

	return {
		update(next: IsolatedParams) {
			p = next;
			void sync();
		},
		destroy() {
			observer.disconnect();
			removeEventListener('resize', sync);
			offNav();
			offTitle();
			if (created) void created.then(() => callPlatform('view', 'destroy', { id })).catch(() => {});
		},
	};
}
