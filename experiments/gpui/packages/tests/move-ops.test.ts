/**
 * move-ops.test.ts — the `moveBefore` op, JS side.
 *
 * A reparent or same-parent reorder of a materialized element must move the
 * live native subtree — same element id, children, state — never a
 * destroy+recreate. Asserts on the emitted op stream (stub renderer) and on
 * the quickgui mirror's retained tree (QuickguiSink + RecordingHost):
 *   - reparent emits ['moveBefore', parentId, childId, beforeId|null] and
 *     keeps every nativeId in the subtree
 *   - no destroyElement/createElement ops for the moved subtree
 *   - same-parent reorder carries the anchor id
 *   - fresh inserts still emit appendChild/insertBefore, not moveBefore
 *   - the mirror applies the op as a native move (insert op logged, no
 *     remove/cleanup), preserving sibling order
 */
import { describe, test, expect } from 'bun:test';
import { installGlobals, doc, materializeRoot, type GNode } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';
import { QuickguiSink, createHeadlessRoot } from './qg-backend';

installGlobals();

/** Op-recording renderer stand-in — same applyBatch shape as QuickguiSink. */
const ops: unknown[][] = [];
setRenderer({
	applyBatch: (json: string) => {
		ops.push(...(JSON.parse(json) as unknown[][]));
		return [];
	},
} as never);

function drainOps(): unknown[][] {
	flush();
	return ops.splice(0);
}

/** A connected, materialized element (nativeId bound; body is a dead-end host). */
function mountEl(tag = 'div') {
	const el = doc.createElement(tag);
	doc.body.appendChild(el);
	materializeRoot(el);
	return el;
}

/** nativeIds of the whole subtree — the identity set a move must preserve. */
function subtreeIds(el: GNode): number[] {
	return [el.nativeId, ...el.childNodes.flatMap((c) => subtreeIds(c))];
}

describe('moveBefore — gdom op emission', () => {
	test('reparent emits moveBefore and keeps every nativeId', () => {
		const host = mountEl();
		const a = doc.createElement('div');
		const b = doc.createElement('div');
		host.appendChild(a);
		host.appendChild(b);
		const x = doc.createElement('div');
		const leaf = doc.createElement('div');
		x.appendChild(leaf);
		a.appendChild(x);
		drainOps();
		const ids = subtreeIds(x);

		b.appendChild(x); // reparent a → b
		const emitted = drainOps();

		expect(emitted).toContainEqual(['moveBefore', b.nativeId, x.nativeId, null]);
		// no destroy and no recreate for the moved subtree — a recreate would
		// allocate fresh ids, which subtreeIds catches too
		expect(emitted.some((op) => op[0] === 'destroyElement' && ids.includes(op[1] as number))).toBe(false);
		expect(emitted.some((op) => op[0] === 'createElement')).toBe(false);
		expect(subtreeIds(x)).toEqual(ids); // same ids, children intact
		expect(b.childNodes).toEqual([x]);
		expect(a.childNodes).toEqual([]);
	});

	test('same-parent reorder emits moveBefore with the anchor id', () => {
		const p = mountEl();
		const c1 = doc.createElement('div');
		const c2 = doc.createElement('div');
		p.appendChild(c1);
		p.appendChild(c2);
		drainOps();

		p.insertBefore(c2, c1);
		const emitted = drainOps();

		expect(emitted).toContainEqual(['moveBefore', p.nativeId, c2.nativeId, c1.nativeId]);
		expect(emitted.some((op) => op[0] === 'destroyElement' && op[1] === c2.nativeId)).toBe(false);
		expect(p.childNodes).toEqual([c2, c1]);
	});

	test('a fresh child still emits appendChild/insertBefore, not moveBefore', () => {
		const p = mountEl();
		const c1 = doc.createElement('div');
		p.appendChild(c1);
		drainOps();

		const c2 = doc.createElement('div');
		p.insertBefore(c2, c1); // fresh insert before an anchor
		const n = doc.createElement('div');
		p.appendChild(n); // fresh insert at the end
		const emitted = drainOps();

		expect(emitted).toContainEqual(['insertBefore', p.nativeId, c2.nativeId, c1.nativeId]);
		expect(emitted).toContainEqual(['appendChild', p.nativeId, n.nativeId]);
		expect(emitted.some((op) => op[0] === 'moveBefore')).toBe(false);
	});

	test('reparent into a detached parent dematerializes — no orphan natives', () => {
		const host = mountEl();
		const detached = doc.createElement('div'); // never connected
		const x = doc.createElement('div');
		host.appendChild(x);
		drainOps();
		const xId = x.nativeId;

		detached.appendChild(x); // new parent can't host → destroy, not move
		const emitted = drainOps();
		expect(emitted).toContainEqual(['destroyElement', xId]);
		expect(emitted.some((op) => op[0] === 'moveBefore')).toBe(false);
		expect(x.nativeId).toBe(0);
	});
});

describe('moveBefore — quickgui mirror', () => {
	function makeSink() {
		const { root, host, ops: hostOps } = createHeadlessRoot();
		const sink = new QuickguiSink(root);
		return { sink, root, host, hostOps };
	}

	test('reparent is a native move: insert logged, no remove/cleanup', () => {
		const { sink, root, hostOps } = makeSink();
		sink.applyBatch(
			JSON.stringify([
				['createElement', 1, 'div'],
				['createElement', 2, 'div'],
				['createElement', 3, 'div'],
				['createElement', 4, 'text'],
				['setText', 4, 'x'],
				['appendChild', 3, 4],
				['appendChild', 1, 3],
				['appendChild', 0, 1],
				['appendChild', 0, 2],
			]),
		);
		hostOps.splice(0);

		sink.applyBatch(JSON.stringify([['moveBefore', 2, 3, null]]));

		expect(hostOps).toContain('insert:2<-3');
		expect(hostOps.some((o) => o.startsWith('remove:') || o.startsWith('cleanup:'))).toBe(false);
		expect(root.children.map((c) => c.id)).toEqual([1, 2]);
		expect(sink.nodes.get(3)?.parent?.id).toBe(2);
		expect(sink.nodes.get(3)?.children.map((c) => c.id)).toEqual([4]); // subtree intact
		expect(sink.getPaintedText()).toEqual(['x']);
	});

	test('same-parent reorder lands at the anchor', () => {
		const { sink, root, hostOps } = makeSink();
		sink.applyBatch(
			JSON.stringify([
				['createElement', 1, 'div'],
				['createElement', 2, 'div'],
				['appendChild', 0, 1],
				['appendChild', 0, 2],
			]),
		);
		hostOps.splice(0);

		sink.applyBatch(JSON.stringify([['moveBefore', 0, 2, 1]]));
		expect(hostOps).toContain('insert:0<-2@1');
		expect(root.children.map((c) => c.id)).toEqual([2, 1]);
	});
});
