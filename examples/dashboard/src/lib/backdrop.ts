// The window's material: it's behind the window's page, and a pane's page is in its own web view, so the
// Native page asks the window's page, which has the sidebar and the title bar (the CSS is in app.css).
import { askWindow, fromPanes, inPane } from './window-page';

export type Backdrop = { backdrop: string | null; intensity: number; tint: string };
const CHANNEL = 'dashboard:backdrop';

function applyBackdrop({ backdrop, intensity, tint }: Backdrop) {
	const root = document.documentElement;
	if (backdrop) root.dataset.backdrop = backdrop;
	else delete root.dataset.backdrop;
	root.style.setProperty('--backdrop', backdrop ?? 'none');
	root.style.setProperty('--backdrop-veil', `${100 - intensity}%`);
	root.style.setProperty('--backdrop-tint', tint);
}

export function setBackdrop(backdrop: Backdrop) {
	if (inPane()) void askWindow(CHANNEL, backdrop);
	else applyBackdrop(backdrop);
}

let owner: string | undefined;
const off: Backdrop = { backdrop: null, intensity: 100, tint: 'none' };

/** The window's tabs' views: the one that set it may have closed, which says nothing (its page isn't unmounted). */
export function backdropTabs(views: string[]) {
	if (owner !== undefined && !views.includes(owner)) {
		owner = undefined;
		applyBackdrop(off);
	}
}

/** In the window's page. Off only from the tab that set it: another Native page may be at it. */
export function followBackdrop(): () => void {
	return fromPanes<Backdrop>(CHANNEL, (backdrop, from) => {
		if (backdrop.backdrop) owner = from;
		else if (from !== owner) return;
		applyBackdrop(backdrop);
	});
}
