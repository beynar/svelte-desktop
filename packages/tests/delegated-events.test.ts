/**
 * delegated-events.test.ts — native-side delegation, JS side.
 *
 * Svelte delegates events by registering handle_event_propagation on the
 * document root — historically gdom backfilled a setEventListener op onto
 * EVERY element per delegated type. Now the type set ships once via
 * `setDelegatedEvents` and the Rust side attaches dispatch at build.
 *
 * Asserts:
 *   - document.addEventListener(type) emits a setDelegatedEvents op carrying
 *     the gpuix-mapped names (click→click, input→change)
 *   - focus/key types (keydown→keyDown) stay OUT of the set — they keep
 *     element-scoped feeds because needs_focus/focus subscriptions read
 *     element.events
 *   - elements materialized after delegation get NO per-element ops for
 *     delegated types
 *   - focusables still receive the focus-scoped keyDown feed
 */
import { test, expect } from 'bun:test';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';

installGlobals();
const ops: unknown[][] = [];
setRenderer({
	applyBatch: (json: string) => { ops.push(...(JSON.parse(json) as unknown[][])); return []; },
} as never);
const named = (n: string) => ops.filter((o) => o[0] === n);

test('delegated types: one setDelegatedEvents op, zero per-element backfill', async () => {
	const root = doc.createElement('div');
	doc.documentElement.appendChild(root);
	materializeRoot(root);
	// Svelte delegate(): handle_event_propagation on document
	doc.addEventListener('click', () => {});
	doc.addEventListener('input', () => {});
	doc.addEventListener('keydown', () => {}); // focus type — stays element-scoped
	flush();
	const sets = named('setDelegatedEvents');
	expect(sets.length).toBeGreaterThanOrEqual(1);
	const last = sets.at(-1)![1] as string[];
	expect(last).toContain('click');
	expect(last).toContain('change'); // input → change
	expect(last).not.toContain('keyDown'); // focus-scoped stays element-level
	// children materialized AFTER delegation carry no click/change listener ops
	ops.length = 0;
	const a = doc.createElement('div');
	root.appendChild(a); a.appendChild(doc.createElement('span'));
	flush();
	expect(named('setEventListener').filter((o) => o[2] === 'click' || o[2] === 'change')).toEqual([]);
	// a focusable still gets the focus-scoped keyDown feed
	ops.length = 0;
	const inp = doc.createElement('input');
	root.appendChild(inp);
	flush();
	const inpOps = named('setEventListener').filter((o) => o[1] === (inp as { nativeId: number }).nativeId);
	expect(inpOps.map((o) => o[2])).toContain('keyDown');
});
