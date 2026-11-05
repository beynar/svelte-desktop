// What a drag does, with the keyboard, and what asks for less motion. In a real window: test/docker/a11y.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { TabGroup, windowAnimation, type TabLike, type TabsOptions } from './tabs.svelte.ts';
import { PlatformTransport, initPlatformForTests, onAccessibilityMedia, reducesMotion } from '../platform/bus';
import { popover } from '../platform/index';

function group(items: TabLike[], options: TabsOptions<TabLike> = {}) {
	return new TabGroup<TabLike>(() => options, { items, active: items[0]?.id });
}
const abc = (extra: Partial<TabLike> = {}): TabLike[] => [
	{ id: 'a', title: 'A', ...extra },
	{ id: 'b', title: 'B' },
	{ id: 'c', title: 'C' },
];
const ids = (t: TabGroup<TabLike>) => t.items.map((x) => x.id);

function fakeMedia(matching: string[] = []) {
	const listeners = new Map<string, Set<() => void>>();
	(globalThis as any).matchMedia = (q: string) => ({
		matches: matching.includes(q),
		addEventListener: (_: string, f: () => void) => void (listeners.get(q) ?? listeners.set(q, new Set()).get(q)!).add(f),
		removeEventListener: (_: string, f: () => void) => void listeners.get(q)?.delete(f),
	});
	return listeners;
}
afterEach(() => void delete (globalThis as any).matchMedia);

test('a step along the bar: to its ends, and no further', () => {
	const t = group(abc());
	expect(t.shift('a', -1)).toBe(false);
	expect(t.shift('a', 1)).toBe(true);
	expect(ids(t)).toEqual(['b', 'a', 'c']);
	expect(t.shift('a', 1)).toBe(true);
	expect(t.shift('a', 1)).toBe(false);
	expect(ids(t)).toEqual(['b', 'c', 'a']);
});

test('like a drag: a pinned tab stays, nothing goes before it, and `reorderable` is heard', () => {
	const t = group(abc({ pinned: true }));
	expect(t.shift('a', 1)).toBe(false);
	expect(t.shift('b', -1)).toBe(false);
	expect(ids(t)).toEqual(['a', 'b', 'c']);
	const fixed = group(abc(), { reorderable: false });
	expect(fixed.shift('a', 1)).toBe(false);
	expect(ids(fixed)).toEqual(['a', 'b', 'c']);
});

test('panes: a new pane on a side, the next pane, its own bar; the keyboard asks nothing of a view', () => {
	const t = group(abc(), { split: true });
	const panes = t.panes!;
	expect(t.toSide('b', 'right')).toBe(true);
	expect(panes.panes.map((p) => p.tabs)).toEqual([['a', 'c'], ['b']]);
	expect(panes.focused.tabs).toEqual(['b']);
	expect(t.pageKeyboard).toBe(true);
	expect(t.toSide('b', 'left')).toBe(false); // alone in its pane: beside itself
	expect(t.toPane('b', 1)).toBe(false); // the last pane
	expect(t.toPane('b', -1)).toBe(true);
	expect(panes.panes.map((p) => p.tabs)).toEqual([['a', 'c', 'b']]); // its pane went with it
	expect(t.shift('b', -1)).toBe(true);
	expect(panes.panes[0]!.tabs).toEqual(['a', 'b', 'c']);
	expect(t.shift('a', -1)).toBe(false);
});

test('without panes, the keys that need them do nothing', () => {
	const t = group(abc());
	expect(t.toSide('a', 'right')).toBe(false);
	expect(t.toPane('a', 1)).toBe(false);
});

test('less motion: a tab dragged out comes in still, whatever was asked', () => {
	fakeMedia();
	expect(reducesMotion()).toBe(false);
	expect(windowAnimation()).toBe(true);
	expect(windowAnimation(false)).toBe(false);
	fakeMedia(['(prefers-reduced-motion: reduce)']);
	expect(reducesMotion()).toBe(true);
	expect(windowAnimation()).toBe(false);
	expect(windowAnimation(true)).toBe(false);
});

test('less motion: a popover is still by default, and the app can say otherwise', async () => {
	const t = new PlatformTransport();
	t.serve('notifications', 'responses', { ok: true, value: [] });
	t.serve('popover', 'create', { ok: true, value: {} });
	initPlatformForTests(t);
	const args = () => t.requests.at(-1)?.args as { animate?: boolean };
	await popover.create({ id: 'p', route: '/p' });
	expect(args().animate).toBeUndefined();
	fakeMedia(['(prefers-reduced-motion: reduce)']);
	await popover.create({ id: 'p', route: '/p' });
	expect(args().animate).toBe(false);
	await popover.create({ id: 'p', route: '/p', animate: true });
	expect(args().animate).toBe(true);
});

// Its store, in a real window: test/docker/a11y.test.ts. Importing the stores here would have them
// all answer the transports of the other test files.
test('a preference changing is heard, on each query, until it is let go', () => {
	expect(onAccessibilityMedia(() => {})).toBeFunction(); // no matchMedia: nothing to hear
	const listeners = fakeMedia();
	let heard = 0;
	const off = onAccessibilityMedia(() => heard++);
	expect([...listeners.keys()]).toEqual(['(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(forced-colors: active)', '(prefers-reduced-transparency: reduce)']);
	for (const set of listeners.values()) for (const f of set) f();
	expect(heard).toBe(4);
	off();
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});
