/**
 * filedrop.test.ts — the fileDrop/fileDrag* wire contract, JS side.
 *
 * Synthetic native payloads go through dispatchPayload exactly like the
 * renderer's TSFN events (elementTree.rs EventPayload → camelCase fields:
 * `paths`, `x`, `y`). Asserts:
 *   - DOM 'drop'/'dragenter'/'dragover'/'dragleave' listeners emit the right
 *     setEventListener gpuix names (fileDrop/fileDragEnter/fileDragOver/
 *     fileDragLeave) — no focusable exemption needed for file drops.
 *   - the DOM event carries a synthetic dataTransfer per the contract:
 *     {types:['Files'], files:[frozen {name,path}], dropEffect:'copy',
 *      effectAllowed:'all', getData('text/uri-list')→paths.join('\n'), else ''}
 *   - x/y map onto clientX/clientY (same convention as pointer events)
 *   - fileDragLeave tolerates absent `paths` (contract: {x,y} only)
 *   - the onPlatformEvent tap fans out platform:* payloads (Theme.svelte's
 *     appearanceChanged lane — gpuix can't import the platform bus)
 */
import { describe, test, expect } from 'bun:test';
import {
	installGlobals,
	doc,
	dispatchPayload,
	materializeRoot,
	domEvent,
	onPlatformEvent,
	PLATFORM_EVENT_ID,
} from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';

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

const listenerOps = () =>
	drainOps().filter((op) => op[0] === 'setEventListener');

describe('DOM type → gpuix event name (setEventListener op)', () => {
	test("drop → 'fileDrop'", () => {
		const el = mountEl();
		el.addEventListener('drop', () => {});
		const emitted = listenerOps();
		expect(emitted).toContainEqual(['setEventListener', el.nativeId, 'fileDrop', true]);
	});

	test('dragenter/dragover/dragleave → fileDrag*', () => {
		const el = mountEl();
		el.addEventListener('dragenter', () => {});
		el.addEventListener('dragover', () => {});
		el.addEventListener('dragleave', () => {});
		const emitted = listenerOps();
		expect(emitted).toContainEqual(['setEventListener', el.nativeId, 'fileDragEnter', true]);
		expect(emitted).toContainEqual(['setEventListener', el.nativeId, 'fileDragOver', true]);
		expect(emitted).toContainEqual(['setEventListener', el.nativeId, 'fileDragLeave', true]);
	});

	test('drag/drop listeners register on non-focusable elements', () => {
		// a plain div is not focusable — fileDrop must not hit the
		// FOCUS_KEY_TYPES/isFocusable exemption that key/focus events have
		const el = mountEl(); // div, no tabindex
		drainOps(); // isolate the addEventListener emits from materialize's
		el.addEventListener('drop', () => {});
		el.addEventListener('dragover', () => {});
		const emitted = listenerOps();
		expect(emitted.map((op) => op[2])).toEqual(['fileDrop', 'fileDragOver']);
	});

	test('reverse map: native names → DOM types', () => {
		expect(domEvent('fileDrop')).toBe('drop');
		expect(domEvent('fileDragEnter')).toBe('dragenter');
		expect(domEvent('fileDragOver')).toBe('dragover');
		expect(domEvent('fileDragLeave')).toBe('dragleave');
	});
});

describe('fileDrop → DOM drop event', () => {
	test('drop listener fires with dataTransfer + coords', () => {
		const el = mountEl();
		let ev: any = null;
		el.addEventListener('drop', (e: any) => {
			ev = e;
		});
		drainOps();
		dispatchPayload({
			elementId: el.nativeId,
			eventType: 'fileDrop',
			x: 12,
			y: 34,
			paths: ['/tmp/screen shot.png', '/Users/x/report.pdf'],
		} as never);
		expect(ev).not.toBeNull();
		expect(ev.type).toBe('drop');
		expect(ev.target).toBe(el);
		expect(ev.clientX).toBe(12);
		expect(ev.clientY).toBe(34);
		expect(ev.bubbles).toBe(true);

		const dt = ev.dataTransfer;
		expect(dt).toBeTruthy();
		expect(dt.types).toEqual(['Files']);
		expect(dt.dropEffect).toBe('copy');
		expect(dt.effectAllowed).toBe('all');
		expect(dt.files.length).toBe(2);
		expect(dt.files[0]).toEqual({ name: 'screen shot.png', path: '/tmp/screen shot.png' });
		expect(dt.files[1]).toEqual({ name: 'report.pdf', path: '/Users/x/report.pdf' });
		// FileLike entries are frozen records — NOT DOM File instances
		expect(Object.isFrozen(dt.files[0])).toBe(true);
		expect(dt.getData('text/uri-list')).toBe('/tmp/screen shot.png\n/Users/x/report.pdf');
		expect(dt.getData('text/plain')).toBe('');
		expect(dt.getData('Files')).toBe('');
	});

	test('drop bubbles to ancestor + document listeners', () => {
		const parent = mountEl();
		const child = doc.createElement('div');
		parent.appendChild(child); // materializes: parent connected + has nativeId
		const seen: string[] = [];
		child.addEventListener('drop', () => seen.push('child'));
		parent.addEventListener('drop', () => seen.push('parent'));
		doc.addEventListener('drop', () => seen.push('doc'));
		drainOps();
		dispatchPayload({ elementId: child.nativeId, eventType: 'fileDrop', x: 1, y: 1, paths: ['/a'] } as never);
		expect(seen).toEqual(['child', 'parent', 'doc']);
	});
});

describe('fileDrag* → DOM dragenter/over/leave', () => {
	test('dragenter + dragover carry dataTransfer', () => {
		const el = mountEl();
		const seen: Record<string, any> = {};
		el.addEventListener('dragenter', (e: any) => {
			seen.enter = e;
		});
		el.addEventListener('dragover', (e: any) => {
			seen.over = e;
		});
		drainOps();
		dispatchPayload({ elementId: el.nativeId, eventType: 'fileDragEnter', x: 5, y: 6, paths: ['/x'] } as never);
		dispatchPayload({ elementId: el.nativeId, eventType: 'fileDragOver', x: 7, y: 8, paths: ['/x', '/y'] } as never);
		expect(seen.enter.type).toBe('dragenter');
		expect(seen.enter.clientX).toBe(5);
		expect(seen.enter.dataTransfer.files).toEqual([{ name: 'x', path: '/x' }]);
		expect(seen.over.type).toBe('dragover');
		expect(seen.over.clientX).toBe(7);
		expect(seen.over.clientY).toBe(8);
		expect(seen.over.dataTransfer.getData('text/uri-list')).toBe('/x\n/y');
	});

	test('dragleave tolerates absent paths (contract: {x,y} only)', () => {
		const el = mountEl();
		let ev: any = null;
		el.addEventListener('dragleave', (e: any) => {
			ev = e;
		});
		drainOps();
		dispatchPayload({ elementId: el.nativeId, eventType: 'fileDragLeave', x: 9, y: 10 } as never);
		expect(ev.type).toBe('dragleave');
		expect(ev.clientX).toBe(9);
		expect(ev.dataTransfer.files).toEqual([]);
		expect(ev.dataTransfer.getData('text/uri-list')).toBe('');
	});

	test('a drop listener alone receives drop — no dragover.preventDefault dance', () => {
		// native model honesty: registering `drop` is enough, matching the
		// contract's "more permissive than DOM" note.
		const el = mountEl();
		let fired = 0;
		el.addEventListener('drop', () => fired++);
		drainOps();
		dispatchPayload({ elementId: el.nativeId, eventType: 'fileDrop', x: 0, y: 0, paths: ['/f'] } as never);
		expect(fired).toBe(1);
	});
});

describe('platform event tap (onPlatformEvent)', () => {
	test('fans out platform:* payloads beside the bus sink', () => {
		const seen: [string, unknown][] = [];
		const off = onPlatformEvent((type: string, data: unknown) => seen.push([type, data]));
		dispatchPayload({
			elementId: PLATFORM_EVENT_ID,
			eventType: 'platform:appearanceChanged',
			data: { appearance: 'dark', dark: true },
		} as never);
		off();
		dispatchPayload({
			elementId: PLATFORM_EVENT_ID,
			eventType: 'platform:appearanceChanged',
			data: { appearance: 'light', dark: false },
		} as never);
		expect(seen).toEqual([['platform:appearanceChanged', { appearance: 'dark', dark: true }]]);
	});
});
