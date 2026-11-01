// Dragging tabs, with pragmatic-drag-and-drop: native drag and drop, so the system's drag image
// follows the pointer — out of the window too, and onto another window's tab bar.
//   use:tabDrag on each tab, use:tabDrop on the bar.
import type { Tab, TabGroup } from './tabs.svelte.ts';

/** A tab's data on a drag (the bar of another window reads it on the drop). */
const TAB_TYPE = 'application/x-svelte-desktop-tab';

type Dnd = {
	element: typeof import('@atlaskit/pragmatic-drag-and-drop/element/adapter');
	external: typeof import('@atlaskit/pragmatic-drag-and-drop/external/adapter');
	preview: typeof import('@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview');
	offset: typeof import('@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview');
};
let loading: Promise<Dnd> | undefined;
// Loaded by the page only, the first time a bar mounts (never during SSR).
const load = () =>
	(loading ??= Promise.all([
		import('@atlaskit/pragmatic-drag-and-drop/element/adapter'),
		import('@atlaskit/pragmatic-drag-and-drop/external/adapter'),
		import('@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview'),
		import('@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview'),
	]).then(([element, external, preview, offset]) => ({ element, external, preview, offset })));

/** The tab as it looks in its bar (its own computed box: the bar's selectors don't reach the
 *  copy), for the drag image. */
function snapshot(node: HTMLElement): HTMLElement {
	const copy = node.cloneNode(true) as HTMLElement;
	const css = getComputedStyle(node);
	for (const p of ['display', 'align-items', 'gap', 'box-sizing', 'padding', 'border', 'border-radius', 'background', 'color', 'font', 'letter-spacing', 'box-shadow'])
		copy.style.setProperty(p, css.getPropertyValue(p));
	copy.style.width = `${node.offsetWidth}px`;
	copy.style.height = `${node.offsetHeight}px`;
	copy.removeAttribute('id');
	return copy;
}

/** Wire once the library is there; the returned cleanup undoes it (even while it loads). */
function lazy(wire: (dnd: Dnd) => () => void): () => void {
	let off: (() => void) | undefined;
	let gone = false;
	void load().then((dnd) => void (gone || (off = wire(dnd))));
	return () => {
		gone = true;
		off?.();
	};
}

export interface TabDragParams {
	tabs: TabGroup<any>;
	tab: Tab<any>;
	dragging: (on: boolean) => void;
}

/** A draggable tab. Let go out of the window, it moves to the window whose bar took it, else
 *  into a new window there (a detachable group). Let go anywhere else in the window (or with
 *  Escape), nothing happens. */
export function tabDrag(node: HTMLElement, params: TabDragParams) {
	let p = params;
	// Where it was let go: in the window, from the library; on the screen, from the native
	// "dragend" (which follows the library's drop).
	let dropped: { onBar: boolean; inside: boolean } | null = null;
	const dragend = (e: DragEvent) => {
		if (!dropped) return;
		const away = !dropped.onBar && !dropped.inside;
		dropped = null;
		void p.tabs.release(p.tab.id, away ? { x: e.screenX, y: e.screenY } : null);
	};
	node.addEventListener('dragend', dragend);
	const off = lazy(({ element, preview, offset }) =>
		element.draggable({
			element: node,
			canDrag: () => !p.tab.pinned,
			// Beside the pointer, not under it: what's under the pointer (the drop line, the other
			// window's bar) stays in sight.
			onGenerateDragPreview: ({ nativeSetDragImage }) =>
				preview.setCustomNativeDragPreview({
					nativeSetDragImage,
					getOffset: offset.pointerOutsideOfPreview({ x: '14px', y: '10px' }),
					render: ({ container }) => void container.appendChild(snapshot(node)),
				}),
			getInitialData: () => ({ type: TAB_TYPE, group: p.tabs.id, id: p.tab.id }),
			getInitialDataForExternal: () => (p.tabs.canDetach(p.tab) ? { [TAB_TYPE]: p.tabs.handoff(p.tab.id) } : {}),
			onDragStart: () => p.dragging(true),
			onDrop: ({ location }) => {
				p.dragging(false);
				const { clientX: x, clientY: y } = location.current.input;
				dropped = { onBar: location.current.dropTargets.length > 0, inside: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight };
			},
		}),
	);
	return {
		update: (next: TabDragParams) => void (p = next),
		destroy: () => (off(), node.removeEventListener('dragend', dragend)),
	};
}

export interface TabDropParams {
	tabs: TabGroup<any>;
	/** Where the drop indicator goes (px from the tabs' left edge), or null. */
	indicate: (x: number | null) => void;
}

/** The bar: tabs of its group dropped there reorder, tabs from another window's bar join it. */
export function tabDrop(node: HTMLElement, params: TabDropParams) {
	let p = params;
	// The tabs' boxes, measured once per drag over the bar (nothing moves meanwhile).
	let boxes: { strip: DOMRect; tabs: Array<{ id: string; box: DOMRect }> } | null = null;
	const measure = () => {
		const prefix = `${p.tabs.id}-tab-`;
		const tabs = [...node.querySelectorAll<HTMLElement>('[data-sd-tabs] > [role=tab]')].map((el) => ({ id: el.id.slice(prefix.length), box: el.getBoundingClientRect() }));
		return { strip: node.querySelector('[data-sd-tabs]')!.getBoundingClientRect(), tabs };
	};
	// Where a tab let go at `x` goes: after every other tab whose middle is left of it, never
	// before a pinned one — its index, and the indicator's place (null: where it already is).
	const place = (x: number, dragged?: string) => {
		boxes ??= measure();
		const others = boxes.tabs.filter((t) => t.id !== dragged);
		const pinned = p.tabs.items.filter((t) => t.pinned && t.id !== dragged).length;
		const index = Math.max(pinned, others.filter((t) => x > t.box.left + t.box.width / 2).length);
		const before = others[index - 1]?.box;
		const after = others[index]?.box;
		const edge = before && after ? (before.right + after.left) / 2 : (after?.left ?? before?.right ?? boxes.strip.left);
		const same = dragged !== undefined && p.tabs.items.findIndex((t) => t.id === dragged) === index;
		return { index, at: same ? null : edge - boxes.strip.left };
	};
	const done = () => {
		boxes = null;
		p.indicate(null);
	};
	const off = lazy(({ element, external }) => {
		const offTabs = element.dropTargetForElements({
			element: node,
			canDrop: ({ source }) => source.data.type === TAB_TYPE && source.data.group === p.tabs.id,
			onDrag: ({ source, location }) => p.indicate(place(location.current.input.clientX, source.data.id as string).at),
			onDragLeave: done,
			onDrop: ({ source, location }) => {
				const id = source.data.id as string;
				const { index } = place(location.current.input.clientX, id);
				done();
				p.tabs.move(id, index);
			},
		});
		const offOthers = external.dropTargetForExternal({
			element: node,
			canDrop: ({ source }) => p.tabs.canReceive && source.types.includes(TAB_TYPE),
			onDrag: ({ location }) => p.indicate(place(location.current.input.clientX).at),
			onDragLeave: done,
			onDrop: ({ source, location }) => {
				const { index } = place(location.current.input.clientX);
				done();
				const handoff = source.getStringData(TAB_TYPE);
				if (handoff) p.tabs.receive(handoff, index);
			},
		});
		return () => (offTabs(), offOthers());
	});
	return {
		update: (next: TabDropParams) => void (p = next),
		destroy: off,
	};
}
