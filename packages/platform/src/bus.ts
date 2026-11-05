/**
 * Transport for the brokered platform API.
 *
 * One napi call (`renderer.platformCall`) carries a JSON request
 * `{id, service, op, args}` into the GPUI UI thread and returns a JSON reply:
 *   {ok:true, value}                  — resolved now
 *   {ok:false, error:{code,message}}  — typed failure
 *   {pending:true, id}                — async op; result arrives later as a
 *                                       `platformResult` platform event
 *
 * Platform events (`platform:*`) arrive on the same TSFN channel as element
 * events, routed here via gdom's PLATFORM_EVENT_ID sentinel.
 */
import type { GpuixRenderer } from '@gpuix/native';
import { destroyWindowRoot, setPlatformEventSink } from '@svelte-desktop/gpuix/gdom';

export type PlatformErrorCode =
	| 'invalid_args'
	| 'unknown'
	| 'unsupported'
	| 'unavailable'
	| 'denied'
	| 'internal';

export class NativeApiError extends Error {
	readonly code: PlatformErrorCode;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'NativeApiError';
		this.code = code as PlatformErrorCode;
	}
}

interface PlatformCapable {
	platformCall(request: string): string;
}

let backend: PlatformCapable | null = null;
let nextCallId = 1;
/** Op allowlist from initPlatform's opts — null means everything passes. */
let allowlist: ReadonlySet<string> | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(data: unknown) => void>>();
const anyListeners = new Set<(event: string, data: unknown) => void>();
const readyCallbacks: (() => void)[] = [];

export interface PlatformInitOptions {
	/**
	 * Ops the renderer is allowed to invoke — `'service.op'` entries or
	 * `'service.*'` wildcards. Empty/absent means no restriction. Denied
	 * calls reject with NativeApiError('denied') without hitting the wire.
	 */
	allow?: string[];
}

function applyInitOptions(opts?: PlatformInitOptions) {
	allowlist = opts?.allow?.length ? new Set(opts.allow) : null;
}

/** Re-bind side effects shared by initPlatform/initPlatformForTests:
 * in-flight pendings can never resolve against the new backend — reject
 * them; channels belong to the old transport — drop them. Event listeners
 * are logical subscriptions and deliberately survive a re-bind. */
function resetForRebind() {
	for (const { reject } of pending.values()) {
		reject(new NativeApiError('unavailable', 'platform layer re-bound while the call was in flight'));
	}
	pending.clear();
	channels.clear();
}

/** Bind the platform layer to the live renderer. Call after renderer.init(). */
export function initPlatform(r: GpuixRenderer | PlatformCapable, opts?: PlatformInitOptions) {
	resetForRebind();
	backend = r as PlatformCapable;
	applyInitOptions(opts);
	setPlatformEventSink(handlePlatformEvent);
	for (const cb of readyCallbacks.splice(0)) cb();
}

/**
 * Run cb once a backend is bound — deferred to a microtask if one already is.
 * Lets dependent modules self-initialize without the app sequencing them.
 */
export function onPlatformReady(cb: () => void): void {
	if (backend) queueMicrotask(cb);
	else readyCallbacks.push(cb);
}

/** Test seam: inject a fake transport without a renderer. */
export function initPlatformForTests(call: PlatformCapable, opts?: PlatformInitOptions) {
	resetForRebind();
	backend = call;
	applyInitOptions(opts);
	setPlatformEventSink(handlePlatformEvent);
	// Symmetric with initPlatform — a bound mock is still "ready" (browser
	// previews and stores auto-init depend on it).
	for (const cb of readyCallbacks.splice(0)) cb();
}

export function platformReady(): boolean {
	return backend !== null;
}

function handlePlatformEvent(eventType: string, data: unknown) {
	const name = eventType.startsWith('platform:') ? eventType.slice(9) : eventType;
	if (name === 'channelMessage') {
		const msg = data as { channel?: string | number; value?: unknown };
		const raw = msg?.channel;
		// '{channel: "__channel__:<id>" | "<id>" | <id>, value}' — the
		// '__channel__:' prefix is what Channel.toJSON() emits.
		const id =
			typeof raw === 'number'
				? raw
				: Number(String(raw ?? '').replace(/^__channel__:/, ''));
		if (Number.isFinite(id)) channels.get(id)?.onmessage(msg?.value);
		return;
	}
	if (name === 'platformResult') {
		const result = data as {
			id: number;
			ok: boolean;
			value?: unknown;
			error?: { code: string; message: string };
		};
		const entry = pending.get(result.id);
		if (!entry) return;
		pending.delete(result.id);
		if (result.ok) entry.resolve(result.value);
		else entry.reject(new NativeApiError(result.error?.code ?? 'internal', result.error?.message ?? 'platform call failed'));
		return;
	}
	dispatchLocal(name, data);
}

/** Deliver `data` to `event`'s subscribers + the any-listeners — the shared
 *  tail of handlePlatformEvent, also used by emitTo's local dispatch.
 *  Each callback is isolated — a throwing listener must not abort the
 *  remaining subscribers for this event (or starve anyListeners). */
function dispatchLocal(name: string, data: unknown) {
	for (const cb of listeners.get(name) ?? []) {
		try {
			cb(data);
		} catch {
			/* listener errors stay listener-local */
		}
	}
	for (const cb of anyListeners) {
		try {
			cb(name, data);
		} catch {
			/* same isolation */
		}
	}
}

export function callPlatform<T = unknown>(service: string, op: string, args: Record<string, unknown> = {}): Promise<T> {
	if (!backend) {
		return Promise.reject(
			new NativeApiError('unavailable', 'platform layer is not initialized — call initPlatform(renderer)'),
		);
	}
	if (allowlist && !allowlist.has(`${service}.${op}`) && !allowlist.has(`${service}.*`)) {
		return Promise.reject(
			new NativeApiError('denied', `${service}.${op} is not in platform.allow`),
		);
	}
	const id = nextCallId++;
	let raw: {
		ok?: boolean;
		pending?: boolean;
		value?: unknown;
		error?: { code: string; message: string };
	} | null;
	try {
		raw = JSON.parse(backend.platformCall(JSON.stringify({ id, service, op, args })));
	} catch (error) {
		return Promise.reject(new NativeApiError('internal', `platformCall transport failed: ${error}`));
	}
	// A malformed transport reply must reject, not throw synchronously —
	// callers are promised a Promise<T> contract.
	if (typeof raw !== 'object' || raw === null) {
		return Promise.reject(new NativeApiError('internal', `platformCall malformed reply: ${JSON.stringify(raw)}`));
	}
	if ('pending' in raw && raw.pending) {
		return new Promise<T>((resolve, reject) => {
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
		});
	}
	if (raw.ok) return Promise.resolve(raw.value as T);
	return Promise.reject(
		new NativeApiError(raw.error?.code ?? 'internal', raw.error?.message ?? 'platform call failed'),
	);
}

/** Subscribe to a platform event. Returns an unsubscribe function. */
export function onPlatform<T = unknown>(event: string, cb: (data: T) => void): () => void {
	let set = listeners.get(event);
	if (!set) {
		set = new Set();
		listeners.set(event, set);
	}
	set.add(cb as (data: unknown) => void);
	return () => {
		set!.delete(cb as (data: unknown) => void);
		if (set!.size === 0) listeners.delete(event);
	};
}

/** Every platform event (for diagnostics). Unsubscribe via the return value. */
export function onAnyPlatform(cb: (event: string, data: unknown) => void): () => void {
	anyListeners.add(cb);
	return () => {
		anyListeners.delete(cb);
	};
}

/**
 * Like onPlatform but unsubscribes after the first delivery. The returned
 * function cancels the subscription before the event arrives (no-op after).
 */
export function oncePlatform<T = unknown>(event: string, cb: (data: T) => void): () => void {
	let off: () => void = () => {};
	off = onPlatform(event, (data: T) => {
		off();
		cb(data);
	});
	return off;
}

// ── multi-window: window-scoped local events ────────────────────────
// One realm owns N windows — emitTo/onWindow scope the local bus to a
// window. `windowId` is a top-level field of the delivered data, mirroring
// how native window-scoped events serialize EventPayload.window_id
// ({focused, windowId}), so onWindow filters real and synthetic events alike.

/**
 * Emit a local event scoped to `windowId` (single-realm scoping — the event
 * never crosses to other processes). Delivered data:
 *   object payload    → `{...payload, windowId}` — windowId always wins
 *   primitive/array   → `{windowId, data: payload}`
 *   no payload        → `{windowId}`
 */
export function emitTo(windowId: number, event: string, payload?: unknown): void {
	const data =
		payload === undefined
			? { windowId }
			: typeof payload === 'object' && payload !== null && !Array.isArray(payload)
				? { ...(payload as Record<string, unknown>), windowId }
				: { windowId, data: payload };
	dispatchLocal(event, data);
}

/**
 * Subscribe to `event` scoped to one window — cb fires only when the
 * delivered data carries `windowId === w` (data is passed through intact,
 * windowId included). Returns the same unsubscribe handle onPlatform gives.
 */
export function onWindow<T = { windowId: number }>(
	windowId: number,
	event: string,
	cb: (data: T) => void,
): () => void {
	return onPlatform(event, (data) => {
		if ((data as { windowId?: unknown } | null)?.windowId !== windowId) return;
		cb(data as T);
	});
}

// `closed {windowId}` — an OS-side close of a secondary window already
// dropped its native roots[w] binding; the JS subtree is destroyed through
// gdom's normal dematerialize path (destroyElement on the root cascades
// natively). Registered once at module level — listeners survive re-binds.
onPlatform('closed', (data) => {
	const w = (data as { windowId?: unknown } | null)?.windowId;
	if (typeof w === 'number') destroyWindowRoot(w);
});

// ── Channel ─────────────────────────────────────────────────────────
// A Channel passed through callPlatform args serializes to
// '__channel__:<id>' (via toJSON); the native side streams values back as
// `channelMessage` platform events {channel: '__channel__:<id>'|'<id>', value}
// which the bus routes to onmessage.

const channels = new Map<number, Channel<unknown>>();
let nextChannelId = 1;

/** Streaming return lane — create one, pass it in op args, receive values. */
export class Channel<T = unknown> {
	readonly id: number;
	onmessage: (value: T) => void;
	constructor(onmessage: (value: T) => void) {
		this.id = nextChannelId++;
		this.onmessage = onmessage;
		channels.set(this.id, this as Channel<unknown>);
	}
	/** Serialized form native ops see inside args: '__channel__:<id>'. */
	toJSON(): string {
		return `__channel__:${this.id}`;
	}
	/** Stop routing — later channelMessage events for this id are dropped. */
	dispose(): void {
		channels.delete(this.id);
	}
}

// ── PlatformTransport + mockPlatform ────────────────────────────────

/**
 * Test/dev transport double implementing the platformCall contract: records
 * every request and serves canned replies. `serve()` installs a sticky
 * per-`service.op` reply; `pushReply()` queues one-shot replies that take
 * precedence. `emit()` injects a platform event as if native sent it.
 */
export class PlatformTransport {
	requests: { id: number; service: string; op: string; args: Record<string, unknown> }[] = [];
	private queue: string[] = [];
	replies = new Map<string, unknown>();

	pushReply(reply: unknown) {
		this.queue.push(JSON.stringify(reply));
	}
	pushRaw(raw: string) {
		this.queue.push(raw);
	}
	/** Sticky reply for every `service.op` call — for multi-call inits. */
	serve(service: string, op: string, reply: unknown) {
		this.replies.set(`${service}.${op}`, reply);
	}
	/** Inject a platform event (e.g. 'appearanceChanged') into the bus. */
	emit(event: string, data: unknown) {
		handlePlatformEvent(`platform:${event}`, data);
	}
	platformCall(request: string): string {
		const parsed = JSON.parse(request);
		this.requests.push(parsed);
		const canned =
			this.queue.shift() ??
			JSON.stringify(this.replies.get(`${parsed.service}.${parsed.op}`) ?? { ok: true, value: null });
		return canned;
	}
}

/**
 * Convenience for tests and browser previews: binds a fresh
 * PlatformTransport via initPlatformForTests and returns it for stubbing.
 *
 *   const t = mockPlatform();
 *   t.serve('app', 'getInfo', { ok: true, value: { name: 'demo', … } });
 */
export function mockPlatform(opts?: PlatformInitOptions): PlatformTransport {
	const transport = new PlatformTransport();
	initPlatformForTests(transport, opts);
	return transport;
}
