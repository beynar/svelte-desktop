/**
 * Mutation sink: fake-DOM → gpuix applyBatch protocol.
 * Owns the op queue, the native-id registry, and the renderer handle.
 */
import type { GpuixRenderer } from '@gpuix/native';

let renderer: GpuixRenderer | null = null;
let nextId = 1;
const byNativeId = new Map<number, unknown>();
const ops: unknown[][] = [];
const deferredCalls: Array<(r: GpuixRenderer) => void> = [];
const afterRenderCalls: Array<(r: GpuixRenderer) => void> = [];
let flushScheduled = false;

/** Native method calls that must run outside the event callback, at flush time. */
export function deferCall(fn: (r: GpuixRenderer) => void) {
	deferredCalls.push(fn);
	if (!flushScheduled) {
		flushScheduled = true;
		setTimeout(flush, 0);
	}
}

/** Calls that need a rendered frame first (FocusHandle exists only post-render). */
export function deferAfterRender(fn: (r: GpuixRenderer) => void) {
	afterRenderCalls.push(fn);
}

/** gdom registers its viewport sink here — avoids a native→gdom import cycle. */
let onWindowSize: ((w: number, h: number) => void) | null = null;
export function setWindowSizeSink(fn: (w: number, h: number) => void) { onWindowSize = fn; }
let lastW = 0, lastH = 0;

/** Run after the native side has rendered a frame (post-tick / post-flush). */
export function drainAfterRender() {
	if (!renderer) return;
	// window resize: keep the JS-side viewport (innerWidth/vh units/overlay math) honest
	const ws = (renderer as { getWindowSize?: () => { width: number; height: number } }).getWindowSize?.();
	if (ws && (ws.width !== lastW || ws.height !== lastH)) {
		lastW = ws.width; lastH = ws.height;
		onWindowSize?.(ws.width, ws.height);
	}
	for (const fn of afterRenderCalls.splice(0)) fn(renderer);
}

export function setRenderer(r: GpuixRenderer) {
	renderer = r;
}

let lastFrames = 0;
let lastFramesAt = 0;
/** Real frame stats from the renderer's debug overlay sampler (fps is the
 * delta of cumulative `frames` between calls — poll once per second). */
export function frameStats() {
	const r = renderer as unknown as {
		getDebugFrameOverlayStats?: () => {
			currentMs?: number; p90Ms?: number; p99Ms?: number; maxMs?: number;
			frames: number; samples: number;
		};
	};
	const s = r?.getDebugFrameOverlayStats?.();
	if (!s) return null;
	const now = performance.now();
	const fps = lastFramesAt ? Math.round(((s.frames - lastFrames) * 1000) / (now - lastFramesAt)) : 0;
	lastFrames = s.frames;
	lastFramesAt = now;
	return { fps, ...s };
}

export function allocId() {
	return nextId++;
}

export function emit(...op: unknown[]) {
	ops.push(op);
	if (!flushScheduled) {
		flushScheduled = true;
		// setTimeout, not queueMicrotask: ops queued inside a native event
		// callback must not applyBatch while GpuixView is mid-update — GPUI
		// panics on reentrant tree updates. A macrotask is outside the callback.
		setTimeout(flush, 0);
	}
}

/** Exact logical scroll anchor of a <virtual-list>: [itemIndex, offsetInItemPx, viewportPx]. */
export function listScrollTop(id: number): [number, number, number] | null {
	const r = renderer as unknown as { getListScrollTop?: (id: number) => number[] | null };
	const v = r?.getListScrollTop?.(id);
	return v ? [v[0], v[1], v[2]] : null;
}

/** Live scroll offset [x, y] for an element, or null. */
export function scrollOffset(id: number): [number, number] | null {
	const r = renderer as unknown as { getScrollOffset?: (id: number) => number[] | null };
	const v = r?.getScrollOffset?.(id);
	return v ? [v[0], v[1]] : null;
}

/** Layout bounds for a native element — per-id getElementBounds when the
 *  renderer has it (both do), automation-tree fallback otherwise. */
export function nativeBounds(id: number): { x: number; y: number; width: number; height: number } | null {
	const r = renderer as unknown as {
		getElementBounds?: (id: number) => number[] | null;
		getAutomationTree?: () => string;
	};
	const b = r?.getElementBounds?.(id);
	if (b) return { x: b[0], y: b[1], width: b[2], height: b[3] };
	if (!r?.getAutomationTree) return null;
	try {
		const tree = JSON.parse(r.getAutomationTree());
		const walk = (n: { id?: number; bounds?: { x: number; y: number; width: number; height: number }; children?: unknown[] }): { x: number; y: number; width: number; height: number } | null => {
			if (n.id === id) return n.bounds ?? null;
			for (const c of (n.children ?? []) as { id?: number; bounds?: never; children?: unknown[] }[]) {
				const hit = walk(c);
				if (hit) return hit;
			}
			return null;
		};
		return walk(tree);
	} catch {
		return null;
	}
}

export function flush() {
	flushScheduled = false;
	if (!renderer) return;
	if (ops.length) {
		const batch = ops.splice(0);
		try {
			// applyBatch returns all destroyed ids (destroy cascades natively)
			const destroyed = renderer.applyBatch(JSON.stringify(batch));
			for (const id of destroyed ?? []) unbindNative(id);
			failedBatch = null;
		} catch (e) {
			// retry the batch once — a deterministically failing op must not
			// head-of-line-block every later mutation forever
			if (failedBatch === batch) {
				failedBatch = null;
				console.error('[gpuix] applyBatch failed twice — dropping batch:', e);
			} else {
				failedBatch = batch;
				ops.unshift(...batch);
				console.error('[gpuix] applyBatch failed:', e);
			}
		}
	}
	for (const fn of deferredCalls.splice(0)) fn(renderer);
}
let failedBatch: unknown[][] | null = null;

// deferredCalls drained in flush() above; afterRenderCalls drain post-render.

export function bindNative(id: number, node: object) {
	byNativeId.set(id, node);
}

export function unbindNative(id: number) {
	byNativeId.delete(id);
}

export function nodeForNativeId(id: number) {
	return byNativeId.get(id);
}
