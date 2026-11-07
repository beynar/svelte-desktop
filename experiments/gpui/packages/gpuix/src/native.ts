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
	let ws: { width: number; height: number } | undefined;
	try {
		ws = (renderer as { getWindowSize?: () => { width: number; height: number } }).getWindowSize?.();
	} catch {} // no window open / app not initialized — keep the last size
	if (ws && (ws.width !== lastW || ws.height !== lastH)) {
		lastW = ws.width; lastH = ws.height;
		onWindowSize?.(ws.width, ws.height);
	}
	for (const fn of afterRenderCalls.splice(0)) {
		try { fn(renderer); } catch {} // a deferred call on a dead window must not kill the loop
	}
}

/** Recipe configs shipped to the native registry — kept so a renderer
 *  (re)bind can resend every definition; the Rust-side registry is per-tree. */
const knownRecipes = new Map<string, unknown>();
/** Registered stylesheets — same resend contract as recipes. */
const knownSheets = new Map<string, unknown>();
/** The last `setTheme` declaration — tree-level state a fresh tree lacks. */
let lastThemeDecl: unknown = undefined;
/** The delegated event set — tree-level state, replayed on (re)bind. */
let lastDelegatedEvents: unknown = undefined;

/** nkit `recipe()` ships its config at definition time — the native engine
 *  compiles the StyleProps fragments once, then `setRecipe` ops carry only
 *  variant names. */
export function registerRecipe(name: string, config: unknown) {
	knownRecipes.set(name, config);
	emit('registerRecipe', name, config);
}

export function setRenderer(r: GpuixRenderer) {
	renderer = r;
	// A fresh tree has empty registries and no theme declaration — resend
	// every definition ahead of the queued ops that reference them.
	for (const [id, rules] of knownSheets) emit('stylesheet.register', id, rules);
	for (const [name, config] of knownRecipes) emit('registerRecipe', name, config);
	if (lastThemeDecl !== undefined) emit('setTheme', lastThemeDecl);
	if (lastDelegatedEvents !== undefined) emit('setDelegatedEvents', lastDelegatedEvents);
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
	let s: { currentMs?: number; p90Ms?: number; p99Ms?: number; maxMs?: number; frames: number; samples: number } | undefined;
	try {
		s = r?.getDebugFrameOverlayStats?.();
	} catch {} // window closed / app not initialized — return last-known
	if (!s) return null;
	const now = performance.now();
	const fps = lastFramesAt ? Math.round(((s.frames - lastFrames) * 1000) / (now - lastFramesAt)) : 0;
	lastFrames = s.frames;
	lastFramesAt = now;
	return { fps, ...s };
}

export function allocId() {
	// the id counter lives on globalThis so a module-reload realm resumes
	// from where the previous realm left off — a fresh `nextId = 1` would
	// collide with the old realm's live native ids
	const host = (globalThis as { __svelteNativeHost?: { nextId?: number } }).__svelteNativeHost;
	if (host) {
		if (host.nextId === undefined) host.nextId = nextId;
		return host.nextId++;
	}
	return nextId++;
}

/** True when queued ops may have changed layout since the last paint.
 *  Bounds reads go through a synchronous measure so Svelte transition
 *  constructors (slide/crossfade/flip) never capture pre-mutation rects —
 *  the equivalent of a browser's forced synchronous layout. One paint
 *  refreshes every recorded bound, so reads batch behind this flag. */
let boundsDirty = false;

export function clearBoundsDirty() {
	boundsDirty = false;
}

/** A painted frame only clears staleness when no ops still await
 *  application — a frame that predates the pending batch would report
 *  pre-mutation rects. Called from the frame-event handler. */
export function boundsFreshAfterFrame() {
	if (!flushScheduled && ops.length === 0) boundsDirty = false;
}

/** Flush pending ops and paint one frame so recorded bounds are fresh.
 *  No-ops when nothing mutated — per-read cost is zero unless a batch
 *  actually changed the tree. */
export function measureBounds() {
	if (!boundsDirty) return;
	flush();
	try {
		(renderer as unknown as { measureLayout?: () => void } | null)?.measureLayout?.();
	} finally {
		boundsDirty = false;
	}
}

export function emit(...op: unknown[]) {
	// Any queued op may change layout — mark bounds stale until the batch
	// applies and a frame paints (or a bounds read forces a measure first).
	boundsDirty = true;
	// Track registry-level ops so a renderer (re)bind can rebuild them — a
	// fresh native tree has no recipes, sheets, or theme declaration.
	if (op[0] === 'setTheme') lastThemeDecl = op[1];
	else if (op[0] === 'stylesheet.register') knownSheets.set(op[1] as string, op[2]);
	else if (op[0] === 'stylesheet.unregister') knownSheets.delete(op[1] as string);
	else if (op[0] === 'setDelegatedEvents') lastDelegatedEvents = op[1];
	// requestFrame is idempotent — one queued op already wakes every
	// window; without the coalesce an unbound renderer (flush() early-
	// returns on !renderer, ops keep piling) would accumulate one per
	// rAF tick and replay a stale storm on bind.
	if (op[0] === 'requestFrame' && ops.some((o) => o[0] === 'requestFrame')) return;
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
	const r = renderer as unknown as { getListScrollTop?: (id: number) => [number, number, number] | null };
	const v = r?.getListScrollTop?.(id);
	return v ? [v[0], v[1], v[2]] : null;
}

/** Live scroll offset [x, y] for an element, or null. */
export function scrollOffset(id: number): [number, number] | null {
	const r = renderer as unknown as { getScrollOffset?: (id: number) => [number, number] | null };
	const v = r?.getScrollOffset?.(id);
	return v ? [v[0], v[1]] : null;
}

/** The element's resolved symbolic style — the renderer's own cascade
 *  (sheet rules + setStyle payload + recipe + style-props + theme tokens),
 *  so JS introspection can't drift from what paints. camelCase StyleDesc
 *  keys → numbers (px for dimension fields), strings, or nested objects
 *  (state buckets, shadows). null when the renderer predates the op. */
export function computedStyle(id: number): Record<string, unknown> | null {
	const r = renderer as unknown as { computedStyle?: (id: number) => string };
	try {
		const s = r?.computedStyle?.(id);
		return s ? (JSON.parse(s) as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Layout bounds for a native element — per-id getElementBounds when the
 *  renderer has it (both do), automation-tree fallback otherwise. */
export function nativeBounds(id: number): { x: number; y: number; width: number; height: number } | null {
	const r = renderer as unknown as {
		getElementBounds?: (id: number) => [number, number, number, number] | { x: number; y: number; width: number; height: number } | null;
		getAutomationTree?: () => string;
	};
	const b = r?.getElementBounds?.(id);
	if (b) return Array.isArray(b) ? { x: b[0], y: b[1], width: b[2], height: b[3] } : b;
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
	if (ops.length || retryOps) {
		// A retry rides the SAME op array — ops queued since the failure append
		// behind it so FIFO order survives and no payload is ever re-run twice.
		const batch = retryOps ? retryOps.concat(ops.splice(0)) : ops.splice(0);
		const retriedLen = retryOps?.length ?? 0;
		try {
			// applyBatch returns all destroyed ids (destroy cascades natively)
			const destroyed = renderer.applyBatch(JSON.stringify(batch));
			for (const id of destroyed ?? []) unbindNative(id);
			retryOps = null;
		} catch (e) {
			if (retriedLen) {
				// Second failure on the retried prefix — it is poison. Drop it;
				// ops that arrived after it get requeued rather than dying
				// with it or head-of-line blocking forever.
				retryOps = null;
				const fresh = batch.slice(retriedLen);
				if (fresh.length) ops.unshift(...fresh);
				console.error('[gpuix] applyBatch failed twice — dropping batch:', e);
			} else {
				retryOps = batch;
				console.error('[gpuix] applyBatch failed — retrying once:', e);
				// The retry must not wait for the next unrelated emit — a
				// terminal batch (e.g. against a stale dylib) would sit
				// forever. Re-arm the macrotask so it rides the next tick.
				if (!flushScheduled) {
					flushScheduled = true;
					setTimeout(flush, 0);
				}
			}
		}
	}
	for (const fn of deferredCalls.splice(0)) fn(renderer);
}
let retryOps: unknown[][] | null = null;

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
