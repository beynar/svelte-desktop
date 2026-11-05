// Where a window's tabs are on screen with <WindowTabs split>: a tree of splits whose leaves are
// panes, each with its own tabs and its own active tab. Every tab stays in its own web view (its
// own process): moving a tab only changes where its view is, its page goes on running.
//
// The tree is state, nothing here touches the window: <Panes> draws it, TabGroup keeps it in step
// with the tabs.

/** A side of a pane, where a tab dropped there makes a new pane. */
export type PaneZone = 'left' | 'right' | 'top' | 'bottom';

export interface PaneLeaf {
	type: 'pane';
	id: string;
	/** Tab ids, in the order of the pane's bar. */
	tabs: string[];
	/** The tab this pane shows. */
	active: string | null;
	/** The tab on screen: the active one once drawn, until then the one before. */
	shown: string | null;
	/** The pane it took its room from: that room goes back there when it goes. */
	from?: string;
	/** It took its room from all its siblings (a whole side of the window): it goes back to them all. */
	fromAll?: boolean;
}

export interface PaneSplit {
	type: 'split';
	id: string;
	/** 'row': side by side. 'column': one above the other. */
	direction: 'row' | 'column';
	/** Each child's share of the split, summing to 1. */
	sizes: number[];
	children: PaneNode[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** How thick a boundary is, by the direction of its split (px). */
export type PaneGaps = { row: number; column: number };

/** Where a dragged tab lands. */
export type PaneDrop =
	| { kind: 'bar'; pane: string; index: number; x: number }
	| { kind: 'center'; pane: string }
	| { kind: 'side'; pane: string; zone: PaneZone }
	| { kind: 'root'; zone: PaneZone };

let seq = 0;
const paneId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;
const leaf = (id: string, tabs: string[] = [], active: string | null = tabs[0] ?? null): PaneLeaf => ({ type: 'pane', id, tabs, active, shown: null });
const directionOf = (zone: PaneZone): PaneSplit['direction'] => (zone === 'left' || zone === 'right' ? 'row' : 'column');
/** Saved ids go into selectors: only these are kept as they are. */
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]+$/.test(id);
const MAX_DEPTH = 32;

export class PaneLayout {
	root = $state<PaneNode>(leaf('p0'));
	focusedId = $state('p0');
	/** Where the tab being dragged would land. */
	drop = $state<PaneDrop | null>(null);
	/** Bumped when panes move without a tab changing: their views follow. */
	revision = $state(0);
	/** Right to left (the panes' `direction`): a row's first child is on the right. */
	rtl = $state(false);

	constructor(tabs: string[] = [], active: string | null = tabs[0] ?? null) {
		this.root = leaf('p0', tabs, active);
	}

	/** The panes, left to right and top to bottom. */
	get panes(): PaneLeaf[] {
		const out: PaneLeaf[] = [];
		const walk = (n: PaneNode) => (n.type === 'pane' ? void out.push(n) : n.children.forEach(walk));
		walk(this.root);
		return out;
	}

	get focused(): PaneLeaf {
		return this.pane(this.focusedId) ?? this.panes[0]!;
	}

	pane(id: string): PaneLeaf | undefined {
		return this.panes.find((p) => p.id === id);
	}

	paneOf(tab: string): PaneLeaf | undefined {
		return this.panes.find((p) => p.tabs.includes(tab));
	}

	/** Which sides of the window each pane touches: the top ones hold the title bar's room. */
	edges(): Map<string, { top: boolean; right: boolean; bottom: boolean; left: boolean }> {
		const out = new Map<string, { top: boolean; right: boolean; bottom: boolean; left: boolean }>();
		const walk = (n: PaneNode, e: { top: boolean; right: boolean; bottom: boolean; left: boolean }) => {
			if (n.type === 'pane') return void out.set(n.id, e);
			n.children.forEach((c, i) => {
				const first = i === 0;
				const last = i === n.children.length - 1;
				const [left, right] = this.rtl ? [last, first] : [first, last];
				walk(c, n.direction === 'row' ? { ...e, left: e.left && left, right: e.right && right } : { ...e, top: e.top && first, bottom: e.bottom && last });
			});
		};
		walk(this.root, { top: true, right: true, bottom: true, left: true });
		return out;
	}

	focus(pane: string): void {
		if (this.pane(pane)) this.focusedId = pane;
	}

	/** Put a tab in a pane (the focused one by default), after its active tab by default. */
	add(tab: string, opts: { pane?: string; index?: number; activate?: boolean } = {}): PaneLeaf {
		const pane = (opts.pane && this.pane(opts.pane)) || this.focused;
		const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length;
		pane.tabs.splice(Math.max(0, Math.min(opts.index ?? at, pane.tabs.length)), 0, tab);
		if (opts.activate !== false || !pane.active) pane.active = tab;
		return pane;
	}

	/** Put a tab not in a pane yet in a new one beside `target` (the focused pane if it's gone).
	 *  `focus` false: for a tab opened in the background. */
	addBeside(tab: string, target: string | undefined, zone: PaneZone, focus = true): void {
		// Nothing to be beside: the only pane, empty, takes it.
		if (this.root.type === 'pane' && !this.root.tabs.length) return void this.add(tab, { pane: this.root.id });
		const fresh = leaf(paneId(), [tab], tab);
		this.#insert(fresh, target && this.pane(target) ? target : this.focused.id, zone);
		if (focus) this.focusedId = fresh.id;
	}

	/** Another place in its pane's bar; what's active doesn't change. */
	reorder(tab: string, index: number): void {
		const pane = this.paneOf(tab);
		if (!pane) return;
		pane.tabs.splice(pane.tabs.indexOf(tab), 1);
		pane.tabs.splice(Math.max(0, Math.min(index, pane.tabs.length)), 0, tab);
	}

	/** Show a tab in its pane, which gets the focus. */
	activate(tab: string): void {
		const pane = this.paneOf(tab);
		if (!pane) return;
		pane.active = tab;
		this.focusedId = pane.id;
	}

	/** Take a tab out. Its pane shows the tab next to it, or goes when it was its last one (unless
	 *  it's the only pane left). */
	remove(tab: string): void {
		const pane = this.paneOf(tab);
		if (!pane) return;
		const i = pane.tabs.indexOf(tab);
		pane.tabs.splice(i, 1);
		if (pane.shown === tab) pane.shown = null;
		if (pane.active === tab) pane.active = pane.tabs[i] ?? pane.tabs[i - 1] ?? null;
		if (!pane.tabs.length) this.#collapse(pane.id);
	}

	/** Move a tab to a pane's bar, at `index` (the end by default). */
	moveToPane(tab: string, target: string, index?: number): void {
		const to = this.pane(target);
		const from = this.paneOf(tab);
		if (!to || !from) return;
		// Within a pane, `index` counts the tabs without this one.
		const same = from.id === to.id;
		if (same) from.tabs.splice(from.tabs.indexOf(tab), 1);
		else this.remove(tab);
		const pane = this.pane(target);
		if (!pane) return;
		pane.tabs.splice(Math.max(0, Math.min(index ?? pane.tabs.length, pane.tabs.length)), 0, tab);
		pane.active = tab;
		this.focusedId = pane.id;
	}

	/** Move a tab to a new pane beside `target`, or beside everything (`target` null). */
	moveBeside(tab: string, target: string | null, zone: PaneZone): void {
		const source = this.paneOf(tab);
		if (!source) return;
		if (target !== null && source.id === target && source.tabs.length === 1) return; // beside itself
		const fresh = leaf(paneId(), [tab], tab);
		if (!this.#insert(fresh, target, zone)) return;
		// Out of its pane by hand: the new pane holds it already.
		const from = this.pane(source.id)!;
		const i = from.tabs.indexOf(tab);
		from.tabs.splice(i, 1);
		if (from.shown === tab) from.shown = null;
		if (from.active === tab) from.active = from.tabs[i] ?? from.tabs[i - 1] ?? null;
		if (!from.tabs.length) this.#collapse(from.id);
		this.focusedId = fresh.id;
	}

	/** Apply where a dragged tab was let go. */
	apply(tab: string, drop: PaneDrop): void {
		if (drop.kind === 'bar') this.moveToPane(tab, drop.pane, drop.index);
		else if (drop.kind === 'center') this.moveToPane(tab, drop.pane);
		else if (drop.kind === 'side') this.moveBeside(tab, drop.pane, drop.zone);
		else this.moveBeside(tab, null, drop.zone);
	}

	/** Whether a drop would change anything. */
	allows(tab: string, drop: PaneDrop): boolean {
		const from = this.paneOf(tab);
		if (!from) return false;
		if (drop.kind === 'root') return this.panes.length > 1 || from.tabs.length > 1;
		if (drop.kind === 'center') return drop.pane !== from.id;
		if (drop.kind === 'side') return drop.pane !== from.id || from.tabs.length > 1;
		return true;
	}

	/** Give child `index` of a split this share, taken from or left to the next child: the others
	 *  don't move. `min`: what each of the two keeps (one share for both, or one each). */
	resizeTo(split: string, index: number, share: number, min: number | [number, number] = 0.05): void {
		const s = this.#find(split);
		if (!s || s.type !== 'split' || index < 0 || index >= s.sizes.length - 1) return;
		const pair = s.sizes[index]! + s.sizes[index + 1]!;
		const [minA, minB] = typeof min === 'number' ? [min, min] : min;
		// No room for both: what they need, in proportion.
		const next = minA + minB >= pair ? (minA + minB > 0 ? (pair * minA) / (minA + minB) : pair / 2) : Math.max(minA, Math.min(pair - minB, share));
		s.sizes[index] = next;
		s.sizes[index + 1] = pair - next;
		this.revision++;
	}

	/** The two children either side of a boundary back to equal shares (a double click on it). */
	resetBoundary(split: string, index: number): void {
		const s = this.#find(split);
		if (!s || s.type !== 'split' || index < 0 || index >= s.sizes.length - 1) return;
		const half = (s.sizes[index]! + s.sizes[index + 1]!) / 2;
		s.sizes[index] = half;
		s.sizes[index + 1] = half;
		this.revision++;
	}

	/** What a node needs along an axis for every pane in it to have `min` px. */
	#minOf(n: PaneNode, axis: 'width' | 'height', min: number, gaps: PaneGaps): number {
		if (n.type === 'pane') return min;
		const sizes = n.children.map((c) => this.#minOf(c, axis, min, gaps));
		return (n.direction === 'row') === (axis === 'width') ? sizes.reduce((a, b) => a + b, 0) + gaps[n.direction] * (sizes.length - 1) : Math.max(...sizes);
	}

	/** What the two children either side of a boundary need, as shares of a split `length` px long
	 *  (without its boundaries). */
	minShares(split: PaneSplit, index: number, min: number, gaps: PaneGaps, length: number): [number, number] {
		const axis = split.direction === 'row' ? 'width' : 'height';
		const share = (c: PaneNode | undefined) => (c && length > 0 ? this.#minOf(c, axis, min, gaps) / length : 0);
		return [share(split.children[index]), share(split.children[index + 1])];
	}

	/** Every pane at least `min` px where there's room for it, from the root down: a split gives
	 *  what its children need, nested panes included, taken from those above it. A split without
	 *  room for all stays as it is. `size`: the room for the root; `gaps`: the boundaries' thickness. */
	fit(size: { width: number; height: number }, min: number, gaps: PaneGaps): void {
		const walk = (n: PaneNode, width: number, height: number) => {
			if (n.type !== 'split') return;
			const row = n.direction === 'row';
			const length = (row ? width : height) - gaps[n.direction] * (n.children.length - 1);
			if (length <= 0) return;
			const floors = n.children.map((c) => this.#minOf(c, row ? 'width' : 'height', min, gaps) / length);
			if (floors.reduce((a, b) => a + b, 0) <= 1) {
				const short = n.sizes.reduce((sum, s, i) => sum + Math.max(0, floors[i]! - s), 0);
				if (short > 1e-6) {
					const spare = n.sizes.reduce((sum, s, i) => sum + Math.max(0, s - floors[i]!), 0);
					n.sizes = n.sizes.map((s, i) => (s <= floors[i]! ? floors[i]! : s - (s - floors[i]!) * (short / spare)));
					this.revision++;
				}
			}
			n.children.forEach((c, i) => walk(c, row ? n.sizes[i]! * length : width, row ? height : n.sizes[i]! * length));
		};
		walk(this.root, size.width, size.height);
	}

	/** Follow the tabs: those not in a pane go to the focused one, those gone leave. */
	reconcile(tabs: string[]): void {
		const known = new Set(tabs);
		for (const p of this.panes) for (const t of [...p.tabs]) if (!known.has(t)) this.remove(t);
		const placed = new Set(this.panes.flatMap((p) => p.tabs));
		for (const t of tabs) if (!placed.has(t)) this.add(t, { activate: false, index: Infinity }); // in their order
	}

	/** What's saved: the tree without what's on screen right now. */
	toJSON(): unknown {
		const save = (n: PaneNode): unknown =>
			n.type === 'pane'
				? { type: 'pane', id: n.id, tabs: [...n.tabs], active: n.active, from: n.from, fromAll: n.fromAll }
				: { type: 'split', id: n.id, direction: n.direction, sizes: [...n.sizes], children: n.children.map(save) };
		return { root: save(this.root), focused: this.focusedId };
	}

	/** A saved tree, for these tabs (anything else in it is dropped); false if it can't be used. */
	restore(saved: unknown, tabs: string[]): boolean {
		const known = new Set(tabs);
		const seen = new Set<string>();
		const ids = new Set<string>();
		// The ids it can keep: of the right shape, once each, a pane's and a split's alike. What the
		// saved tree says of an id that had to change (focused, from) follows it.
		const renamed = new Map<unknown, string>();
		const nodeId = (id: unknown): string => {
			let own = safeId(id) && !ids.has(id) ? id : paneId();
			while (ids.has(own)) own = paneId();
			ids.add(own);
			if (!renamed.has(id)) renamed.set(id, own);
			return own;
		};
		const read = (n: any, depth: number): PaneNode | null => {
			if (depth > MAX_DEPTH) return null;
			if (n?.type === 'pane' && Array.isArray(n.tabs)) {
				const own: string[] = [];
				for (const t of n.tabs) {
					if (typeof t !== 'string' || !known.has(t) || seen.has(t)) continue;
					seen.add(t);
					own.push(t);
				}
				if (!own.length) return null;
				const pane = leaf(nodeId(n.id), own, own.includes(n.active) ? n.active : own[0]!);
				if (n.from !== undefined) pane.from = n.from;
				if (n.fromAll === true) pane.fromAll = true;
				return pane;
			}
			if (n?.type === 'split' && (n.direction === 'row' || n.direction === 'column') && Array.isArray(n.children)) {
				const kept: Array<{ node: PaneNode; size: number }> = [];
				n.children.forEach((c: unknown, i: number) => {
					const node = read(c, depth + 1);
					const size = n.sizes?.[i];
					// A share, or what's fair.
					if (node) kept.push({ node, size: typeof size === 'number' && size > 0 && size <= 1 ? size : 1 / n.children.length });
				});
				if (!kept.length) return null;
				if (kept.length === 1) return kept[0]!.node;
				const total = kept.reduce((sum, k) => sum + k.size, 0);
				const shares = kept.map((k) => k.size / total);
				// One so small next to the others that it comes out as nothing: what's fair.
				const sizes = shares.every((share) => share > 1e-6) ? shares : kept.map(() => 1 / kept.length);
				return { type: 'split', id: nodeId(n.id), direction: n.direction, sizes, children: kept.map((k) => k.node) };
			}
			return null;
		};
		const root = read((saved as { root?: unknown } | null)?.root, 0);
		if (!root) return false;
		this.root = root;
		for (const pane of this.panes) if (pane.from !== undefined) pane.from = renamed.get(pane.from);
		this.focusedId = renamed.get((saved as { focused?: unknown }).focused) ?? '';
		if (!this.pane(this.focusedId)) this.focusedId = this.panes[0]!.id;
		this.reconcile(tabs);
		return true;
	}

	#find(id: string, n: PaneNode = this.root): PaneNode | undefined {
		if (n.id === id) return n;
		if (n.type === 'split') for (const c of n.children) {
			const found = this.#find(id, c);
			if (found) return found;
		}
	}

	#parent(id: string, n: PaneNode = this.root): PaneSplit | undefined {
		if (n.type !== 'split') return;
		if (n.children.some((c) => c.id === id)) return n;
		for (const c of n.children) {
			const found = this.#parent(id, c);
			if (found) return found;
		}
	}

	#replace(id: string, node: PaneNode): void {
		if (this.root.id === id) return void (this.root = node);
		const parent = this.#parent(id);
		if (parent) parent.children[parent.children.findIndex((c) => c.id === id)] = node;
	}

	/** A pane beside `target` (null: beside everything): a split in the same direction takes it as
	 *  one more child, sharing its neighbor's room. False if `target` isn't there. */
	#insert(fresh: PaneLeaf, target: string | null, zone: PaneZone): boolean {
		const direction = directionOf(zone);
		// Which comes first in the tree: right to left, a row's first child is on the right.
		const first = zone === 'top' || (zone === 'left' && !this.rtl) || (zone === 'right' && this.rtl);
		const id = target ?? this.root.id;
		const node = this.#find(id);
		if (!node) return false;
		if (target === null && node.type === 'split' && node.direction === direction) {
			const share = 1 / (node.children.length + 1);
			const sizes = node.sizes.map((s) => s * (1 - share));
			fresh.fromAll = true;
			node.children = first ? [fresh, ...node.children] : [...node.children, fresh];
			node.sizes = first ? [share, ...sizes] : [...sizes, share];
			return true;
		}
		const parent = target === null ? undefined : this.#parent(id);
		if (parent?.direction === direction) {
			const i = parent.children.findIndex((c) => c.id === id);
			const half = parent.sizes[i]! / 2;
			parent.sizes[i] = half;
			fresh.from = id;
			const at = first ? i : i + 1;
			parent.children.splice(at, 0, fresh);
			parent.sizes.splice(at, 0, half);
			return true;
		}
		const split: PaneSplit = { type: 'split', id: paneId(), direction, sizes: [0.5, 0.5], children: first ? [fresh, node] : [node, fresh] };
		this.#replace(id, split);
		return true;
	}

	/** An empty pane goes, its room to its neighbors; a split left with one child becomes that child. */
	#collapse(id: string): void {
		const parent = this.#parent(id);
		if (!parent) return; // the only pane: it stays, empty
		const i = parent.children.findIndex((c) => c.id === id);
		const left = parent.children[i] as PaneLeaf;
		const [gone] = parent.sizes.splice(i, 1);
		parent.children.splice(i, 1);
		// Its room goes back where it came from, else to the pane next to it: the others don't move.
		const heir = left.from ? parent.children.findIndex((c) => this.#find(left.from!, c)) : -1;
		if (left.fromAll && parent.sizes.length) {
			const rest = 1 - (gone ?? 0);
			parent.sizes = parent.sizes.map((s) => s / (rest || 1));
		} else parent.sizes[heir >= 0 ? heir : Math.max(0, i - 1)]! += gone ?? 0;
		if (this.focusedId === id) this.focusedId = this.#first(parent.children[Math.min(i, parent.children.length - 1)]!).id;
		if (parent.children.length === 1) {
			const only = parent.children[0]!;
			const outer = this.#parent(parent.id);
			// Its only child, a split in the direction of the split above: one level, not two.
			if (only.type === 'split' && outer?.direction === only.direction) {
				const at = outer.children.findIndex((c) => c.id === parent.id);
				const share = outer.sizes[at]!;
				outer.children.splice(at, 1, ...only.children);
				outer.sizes.splice(at, 1, ...only.sizes.map((s) => s * share));
			} else this.#replace(parent.id, only);
		}
		this.revision++;
	}

	#first(n: PaneNode): PaneLeaf {
		return n.type === 'pane' ? n : this.#first(n.children[0]!);
	}
}
