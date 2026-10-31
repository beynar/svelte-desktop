/**
 * host.notifications / host.push — one API over every backend (native/NOTIFICATIONS.md)
 * and, in a plain browser tab, the Notification API + a service worker for Web Push.
 *
 *   await host.notifications.show({ id: 'msg-42', title: 'Alice', body: 'Lunch?', url: '/chat/42' })
 *   host.notifications.on('click', (e) => { … })      // e.preventDefault() skips the navigation
 *   const target = await host.push.register()          // send it to your server
 *
 * - `id` dedupes: showing an id that is delivered or pending replaces it (`replace: false`
 *   keeps the existing one instead).
 * - `url` deep-links: a click navigates the window that showed it (app paths with the
 *   SvelteKit router, the app's custom scheme through `deepLink`, http(s) in the browser).
 *   Actions can carry their own `url`.
 * - A click that launched the app is replayed once the page starts; listeners added later
 *   still receive it (events wait for their first listener).
 */
import { callPlatform, deliverPlatformEvent, NativeApiError, onPlatform, onPlatformReady, platformReady } from './bus';
import type { PushTarget } from '../push/protocol.ts';
import { CHANNEL, PUSH_CLIENT, type DesktopPushClient, type DesktopPushOp, type DesktopPushOps, type DesktopPushReply } from '../push/desktop-channel.ts';

export type { PushTarget, WebPushTarget } from '../push/protocol.ts';

export type NotificationUrgency = 'low' | 'normal' | 'critical';
export type NotificationRepeat = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
export type NotificationPermission = 'granted' | 'denied' | 'notDetermined' | 'unavailable';

export interface NotificationAction {
	id: string;
	title: string;
	/** @deprecated `title` */
	label?: string;
	/** A text field (reply): the response is a `reply` event with `input`. */
	input?: boolean | { placeholder?: string; button?: string };
	/** Shown in red where the OS supports it. */
	destructive?: boolean;
	/** Bring the app to front when chosen. Default true. */
	foreground?: boolean;
	/** Navigate here when chosen (instead of the notification's `url`). */
	url?: string;
}

export interface NotificationOptions<D = unknown> {
	/** Dedupe key: a delivered or pending notification with this id is replaced. Default: a new id. */
	id?: string;
	/** @deprecated `id` */
	tag?: string;
	title: string;
	body?: string;
	subtitle?: string;
	/** Thread / group them (Apple threads, Android groups, Windows groups). */
	group?: string;
	/** Picture shown in the notification: a path, a file:// / data: / http(s) URL, or an app URL ('/img/x.png'). */
	image?: string;
	/** Large icon / logo override (Android, Windows, Linux). Same forms as `image`. */
	icon?: string;
	/** 'default' or the name of a sound shipped with the app. */
	sound?: string;
	silent?: boolean;
	/** Alert again when replacing an existing id. Default true. */
	renotify?: boolean;
	/** App icon badge carried by the notification (Apple, Android). */
	badge?: number;
	urgency?: NotificationUrgency;
	/** Stay on screen until the user acts (Linux, Windows, Android). */
	requireInteraction?: boolean;
	/** Time shown on it. */
	timestamp?: Date | number;
	actions?: NotificationAction[];
	/** Android channel (desktop.config `notifications.channels`). */
	channel?: string;
	/** Show it while the app is frontmost (default: desktop.config `notifications.foreground`, true). */
	foreground?: boolean;
	/** Deliver later. Survives the app quitting where the OS schedules (macOS, iOS, Android, Windows). */
	at?: Date | number | string;
	/** Deliver in `delay` ms. */
	delay?: number;
	/** With `at`/`delay`: repeat every minute/hour/day/week/month/year. */
	repeat?: NotificationRepeat;
	/** Navigate here on click. */
	url?: string;
	/** Anything JSON: handed back in events and lists. */
	data?: D;
	/** false: if this id is already delivered or pending, do nothing. Default true. */
	replace?: boolean;
	/** Inbox style (Android); joined into `body` elsewhere when there is no body. */
	lines?: string[];
	/** Summary text under the content (Android). */
	summary?: string;
	/** Can't be swiped away (Android), stays in the list (Linux, Windows). */
	ongoing?: boolean;
	/** Removed when clicked. Default true. */
	autoCancel?: boolean;
	/** Accent color, '#rrggbb' (Android). */
	color?: string;
	/** Lock-screen visibility (Android). */
	visibility?: 'public' | 'private' | 'secret';
	/** Label of a dismiss button (Windows, Linux). */
	closeButtonText?: string;
	/** Windows: raw toast XML, used as is. */
	toastXml?: string;
}

export interface NotificationInfo<D = unknown> {
	id: string;
	title: string;
	body: string;
	subtitle?: string;
	group?: string;
	url?: string;
	data?: D;
	/** When it was delivered. */
	date?: Date;
}

export interface PendingNotification<D = unknown> extends NotificationInfo<D> {
	/** Next delivery. */
	at: Date | null;
	repeat?: NotificationRepeat;
}

export type NotificationEventKind = 'click' | 'action' | 'reply' | 'dismiss';

export interface NotificationEvent<D = unknown> {
	id: string;
	kind: NotificationEventKind;
	/** The action chosen (action/reply), else null. */
	actionId: string | null;
	/** Reply text. */
	input?: string;
	/** Where the default action navigates (the action's url, else the notification's). */
	url?: string;
	data?: D;
	/** True when this context runs the default action: the page of the window that showed it. */
	target: boolean;
	/** Skip the default navigation (synchronous listeners only). */
	preventDefault(): void;
	readonly defaultPrevented: boolean;
}

export interface NotificationShownEvent<D = unknown> {
	id: string;
	url?: string;
	data?: D;
	/** A remote push arriving while the app runs. */
	push: boolean;
}

export interface NotificationChannel {
	id: string;
	name: string;
	description?: string;
	importance?: 'min' | 'low' | 'default' | 'high' | 'max';
	sound?: boolean | string;
	vibrate?: boolean;
	lights?: boolean;
	badge?: boolean;
	visibility?: 'public' | 'private' | 'secret';
}

export interface PushMessage<D = unknown> {
	id?: string;
	/** The push's custom keys (APNs) / data (FCM). */
	raw: Record<string, unknown>;
	data?: D;
	url?: string;
	notification?: { title: string; body: string };
	/** The app was frontmost when it arrived. */
	foreground: boolean;
}

// ── wire ────────────────────────────────────────────────────────────

interface Payload { url?: string; data?: unknown; actions?: Record<string, string> }

interface WireResponse {
	seq?: number;
	id: string;
	tag?: string;
	kind?: NotificationEventKind;
	actionId: string | null;
	input?: string;
	payload?: string;
	target?: boolean;
}

interface WireInfo {
	id: string; title: string; body: string; subtitle?: string; group?: string;
	payload?: string; date?: number; at?: number; repeat?: NotificationRepeat;
}

function parsePayload(text: unknown): Payload {
	if (typeof text !== 'string' || !text) return {};
	try {
		const p = JSON.parse(text);
		return p && typeof p === 'object' ? p : {};
	} catch {
		return {};
	}
}

const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';
const native = () => platformReady();

// Self-hosted push (desktop.config `push.server`) on desktop: the client runs in the app's
// server process (push/desktop.ts); pages ask it over the `push:*` broadcast channel.
declare const __SVELTE_DESKTOP_PUSH__: { server?: string | null } | undefined;
function selfHostedPush(): boolean {
	const c = typeof __SVELTE_DESKTOP_PUSH__ !== 'undefined' ? __SVELTE_DESKTOP_PUSH__ : undefined;
	if (!c?.server || !native()) return false;
	return isPage ? !/Android|iPhone|iPad/i.test(navigator.userAgent) : !process.env.SVELTE_DESKTOP_ANDROID_HOST;
}
async function desktopPush<O extends DesktopPushOp>(op: O): Promise<DesktopPushOps[O]> {
	if (!isPage) {
		const client = (globalThis as Record<symbol, DesktopPushClient | undefined>)[PUSH_CLIENT];
		if (!client) throw new NativeApiError('unavailable', 'push: the self-hosted push client is not started yet (push.server)');
		return client.run(op);
	}
	const nonce = randomId();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { off(); reject(new NativeApiError('unavailable', `push.${op}: no answer from the app server (push.server)`)); }, 30_000);
		const off = onPlatform<{ channel: string; data: DesktopPushReply }>('message', (m) => {
			if (m?.channel !== CHANNEL.reply || m.data?.nonce !== nonce) return;
			clearTimeout(timer);
			off();
			if (m.data.ok) resolve(m.data.value as DesktopPushOps[O]);
			else reject(new NativeApiError('unavailable', `push.${op}: ${m.data.error}`));
		});
		void callPlatform('events', 'emit', { channel: CHANNEL.request, data: { op, nonce } }).catch((e) => { clearTimeout(timer); off(); reject(e); });
	});
}

function toMillis(v: Date | number | string): number {
	const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
	if (!Number.isFinite(ms)) throw new NativeApiError('invalid_args', `notifications.show: invalid date ${String(v)}`);
	return ms;
}

function randomId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Native backends take paths, file:// and data: URLs: fetch the rest here (the page has the app's cookie). */
async function resolveImage(src: string | undefined): Promise<string | undefined> {
	if (!src || src.startsWith('data:') || src.startsWith('file:')) return src;
	const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(src);
	// An absolute filesystem path in server code; an app URL in a page.
	if (!isUrl && !(isPage && src.startsWith('/'))) return src;
	const url = isPage ? new URL(src, location.href).href : src;
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const type = res.headers.get('content-type')?.split(';')[0] || 'image/png';
		const bytes = new Uint8Array(await res.arrayBuffer());
		let bin = '';
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return `data:${type};base64,${btoa(bin)}`;
	} catch (err) {
		throw new NativeApiError('invalid_args', `notifications.show: could not load image ${src}: ${(err as Error).message}`);
	}
}

function toInfo<D>(w: WireInfo): NotificationInfo<D> {
	const p = parsePayload(w.payload);
	const info: NotificationInfo<D> = { id: w.id, title: w.title ?? '', body: w.body ?? '' };
	if (w.subtitle) info.subtitle = w.subtitle;
	if (w.group) info.group = w.group;
	if (p.url) info.url = p.url;
	if (p.data !== undefined) info.data = p.data as D;
	if (w.date) info.date = new Date(w.date);
	return info;
}

// ── responses: dispatch, retention, default action ──────────────────

type Listener = (e: never) => void;
interface State {
	listeners: Map<string, Set<Listener>>;
	retained: { type: string; event: unknown }[];
	seen: Set<number>;
	bound: boolean;
}
const S: State = ((globalThis as Record<symbol, State | undefined>)[Symbol.for('svelte-desktop.notifications')] ??= {
	listeners: new Map(),
	retained: [],
	seen: new Set(),
	bound: false,
});

function emitLocal(types: string[], event: unknown): boolean {
	let delivered = false;
	for (const type of types)
		for (const fn of S.listeners.get(type) ?? []) {
			delivered = true;
			try {
				(fn as (e: unknown) => void)(event);
			} catch (err) {
				console.error(err);
			}
		}
	return delivered;
}

/** Deliver to listeners; keep it for the first listener when there is none yet. true = heard now. */
function emit(types: string[], event: unknown): boolean {
	if (emitLocal(types, event)) return true;
	S.retained.push({ type: types[0], event });
	if (S.retained.length > 50) S.retained.shift();
	return false;
}

export function onNotificationEvent(type: string, fn: (e: never) => void): () => void {
	let set = S.listeners.get(type);
	if (!set) S.listeners.set(type, (set = new Set()));
	set.add(fn);
	const matches = (t: string) => t === type || (type === 'response' && ['click', 'action', 'reply', 'dismiss'].includes(t));
	const due = S.retained.filter((r) => matches(r.type));
	if (due.length) {
		S.retained = S.retained.filter((r) => !due.includes(r));
		queueMicrotask(() => due.forEach((r) => (fn as (e: unknown) => void)(r.event)));
	}
	return () => set!.delete(fn);
}

function hydrated(): Promise<void> {
	if (document.documentElement.hasAttribute('data-desktop-hydrated')) return Promise.resolve();
	return new Promise((resolve) => {
		addEventListener('desktop:hydrated', () => resolve(), { once: true });
		// Not a desktop-plugin page (no marker): don't wait forever.
		if (document.readyState === 'complete') setTimeout(resolve, 1500);
		else addEventListener('load', () => setTimeout(resolve, 1500), { once: true });
	});
}

/** The default action of a notification url: route in-app, deep link, or open externally. */
export async function openNotificationUrl(url: string): Promise<void> {
	if (!isPage) return;
	let u: URL;
	try {
		u = new URL(url, location.href);
	} catch {
		return;
	}
	if (u.origin === location.origin) {
		await hydrated();
		const goto = (globalThis as { __desktopGoto?: (url: string) => Promise<void> }).__desktopGoto;
		// No client route (a +server.ts, a 404): Kit 3's goto throws — let the server answer.
		if (!goto) return location.assign(u.href);
		await goto(u.pathname + u.search + u.hash).catch(() => location.assign(u.href));
	} else if (u.protocol === 'http:' || u.protocol === 'https:') {
		if (native()) await callPlatform('shell', 'openExternal', { url: u.href });
		else window.open(u.href, '_blank', 'noopener');
	} else {
		// The app's own scheme: same path as an OS deep link.
		deliverPlatformEvent('openUrls', { urls: [u.href] });
	}
}

function handleResponse(r: WireResponse, opts: { target?: boolean; navigated?: boolean } = {}) {
	const target = opts.target ?? r.target === true;
	// Several windows: only the target page handles it; the Worker sees them all.
	if (isPage && !target) return;
	// A response can arrive live and again from claim/responses: once per seq.
	if (r.seq != null) {
		if (S.seen.has(r.seq)) return;
		S.seen.add(r.seq);
	}
	const p = parsePayload(r.payload);
	const kind: NotificationEventKind = r.kind ?? (r.actionId ? 'action' : 'click');
	const url = kind === 'dismiss' ? undefined : (r.actionId && p.actions?.[r.actionId]) || p.url;
	let prevented = false;
	const event: NotificationEvent = {
		id: r.id ?? r.tag ?? '',
		kind,
		actionId: r.actionId ?? null,
		target,
		preventDefault() { prevented = true; },
		get defaultPrevented() { return prevented; },
	};
	if (r.input !== undefined) event.input = r.input;
	if (url) event.url = url;
	if (p.data !== undefined) event.data = p.data;
	const heard = emit([kind, 'response'], event);
	if (!isPage || !target || !url || opts.navigated) return;
	// Nobody listening yet (a click that launched the app): give the page's listeners, which
	// subscribe while it mounts, the chance to preventDefault before navigating.
	if (heard) {
		if (!prevented) void openNotificationUrl(url);
	} else void hydrated().then(() => setTimeout(() => !prevented && openNotificationUrl(url), 0));
}

function handleShown(d: { id: string; payload?: string; push?: boolean }) {
	const p = parsePayload(d.payload);
	const event: NotificationShownEvent = { id: d.id, push: !!d.push };
	if (p.url) event.url = p.url;
	if (p.data !== undefined) event.data = p.data;
	emitLocal(['shown'], event);
}

function toPushMessage(m: { id?: string; data?: Record<string, unknown>; payload?: string; notification?: { title: string; body: string }; foreground?: boolean }): PushMessage {
	const p = parsePayload(m.payload);
	const msg: PushMessage = { raw: m.data ?? {}, foreground: !!m.foreground };
	if (m.id) msg.id = m.id;
	if (p.data !== undefined) msg.data = p.data;
	if (p.url) msg.url = p.url;
	if (m.notification) msg.notification = m.notification;
	return msg;
}

/** Subscribe once per process, before any backend binds: a launch click flushed early isn't lost. */
function bind() {
	if (S.bound) return;
	S.bound = true;
	onPlatform<WireResponse>('notificationResponse', (r) => handleResponse(r));
	onPlatform<{ id: string; payload?: string; push?: boolean }>('notificationShown', handleShown);
	onPlatform<{ provider: string; token: string }>('pushToken', () => void push.token().then((t) => t && emitLocal(['token'], t)));
	onPlatform<Parameters<typeof toPushMessage>[0]>('pushMessage', (m) => emit(['message'], toPushMessage(m)));
	// Self-hosted push: the server process relays messages and new targets to the pages.
	if (isPage)
		onPlatform<{ channel: string; data: unknown }>('message', (m) => {
			if (m?.channel === CHANNEL.message) emit(['message'], toPushMessage(m.data as Parameters<typeof toPushMessage>[0]));
			if (m?.channel === CHANNEL.target) emitLocal(['token'], m.data);
		});
	onPlatformReady(() => {
		// Responses that happened before this context was listening (a click that launched the app).
		if (isPage) callPlatform<WireResponse[]>('notifications', 'claim').then((list) => list.forEach((r) => handleResponse(r, { target: true })), () => {});
		else callPlatform<WireResponse[]>('notifications', 'responses').then((list) => list.forEach((r) => handleResponse(r)), () => {});
	});
	// A plain browser tab (no native transport after startup): clicks come from the service worker.
	if (isPage) setTimeout(() => !native() && web.bind(), 0);
}

// ── browser fallback ────────────────────────────────────────────────

const SW_URL = '/__desktop/push-sw.js';
const SW_SCOPE = '/__desktop/push/';

const web = {
	supported: () => isPage && typeof Notification !== 'undefined',
	timers: new Map<string, ReturnType<typeof setTimeout>>(),
	pending: new Map<string, PendingNotification>(),
	plain: new Map<string, Notification>(),
	registration: null as Promise<ServiceWorkerRegistration | null> | null,

	sw(): Promise<ServiceWorkerRegistration | null> {
		if (!isPage || !('serviceWorker' in navigator) || !isSecureContext) return Promise.resolve(null);
		return (this.registration ??= navigator.serviceWorker
			.register(SW_URL, { scope: SW_SCOPE })
			.then(async (reg) => {
				const worker = reg.active ?? reg.installing ?? reg.waiting;
				if (worker && worker.state !== 'activated')
					await new Promise<void>((res) => worker.addEventListener('statechange', () => worker.state === 'activated' && res()));
				return reg;
			})
			.catch(() => null));
	},

	bind() {
		if (!isPage || !('serviceWorker' in navigator)) return;
		navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
			const m = e.data;
			if (m?.__sd === 'notificationResponse') handleResponse(m.response, { target: true, navigated: m.navigated });
			if (m?.__sd === 'pushMessage') emit(['message'], toPushMessage(m.message));
		});
		// A click that opened this tab: ask the worker for it.
		void navigator.serviceWorker.getRegistration(SW_SCOPE).then((reg) => reg?.active?.postMessage({ __sd: 'claim' }));
	},

	permission(): NotificationPermission {
		if (!web.supported()) return 'unavailable';
		return Notification.permission === 'default' ? 'notDetermined' : Notification.permission;
	},

	async request(): Promise<NotificationPermission> {
		if (!web.supported()) return 'unavailable';
		const r = await Notification.requestPermission();
		return r === 'default' ? 'notDetermined' : r;
	},

	async show(o: NotificationOptions, id: string, payload: string | undefined, at: number | null) {
		if (!web.supported()) throw new NativeApiError('unavailable', 'notifications.show: this browser has no Notification API');
		if (Notification.permission !== 'granted') throw new NativeApiError('denied', 'notifications.show: notifications are not allowed (requestPermission)');
		if (o.repeat) throw new NativeApiError('unsupported', 'notifications.show: browsers have no scheduler — `repeat` needs the app');
		web.cancel(id);
		if (at !== null && at > Date.now()) {
			// Only while the page stays open: browsers have no scheduler.
			web.pending.set(id, { id, title: o.title, body: o.body ?? '', at: new Date(at), url: o.url, data: o.data });
			web.timers.set(id, setTimeout(() => { web.pending.delete(id); web.timers.delete(id); void web.show(o, id, payload, null); }, at - Date.now()));
			return { id, scheduled: true };
		}
		const options: Record<string, unknown> = {
			tag: id,
			body: o.body,
			icon: o.icon,
			image: o.image,
			silent: o.silent,
			renotify: o.renotify ?? true,
			requireInteraction: o.requireInteraction,
			timestamp: o.timestamp ? +o.timestamp : undefined,
			data: { id, payload },
			title: o.title,
		};
		const reg = await web.sw();
		if (reg) {
			options.actions = o.actions?.map((a) => ({ action: a.id, title: a.title ?? a.label, ...(a.input && { type: 'text', placeholder: typeof a.input === 'object' ? a.input.placeholder : undefined }) }));
			await reg.showNotification(o.title, options as globalThis.NotificationOptions);
		} else {
			web.plain.get(id)?.close();
			const n = new Notification(o.title, options as globalThis.NotificationOptions);
			web.plain.set(id, n);
			n.onclick = () => { window.focus(); n.close(); handleResponse({ id, actionId: null, kind: 'click', payload }, { target: true }); };
			n.onclose = () => web.plain.get(id) === n && web.plain.delete(id);
		}
		return { id, scheduled: false };
	},

	async delivered(): Promise<WireInfo[]> {
		const reg = await web.sw();
		const list = reg ? await reg.getNotifications() : [...web.plain.values()];
		return list.map((n) => ({ id: n.tag, title: n.title, body: n.body, payload: (n.data as { payload?: string } | null)?.payload }));
	},

	cancel(id: string) {
		clearTimeout(web.timers.get(id));
		web.timers.delete(id);
		web.pending.delete(id);
	},

	async dismiss(id: string | null) {
		if (id === null) for (const k of [...web.timers.keys()]) web.cancel(k);
		else web.cancel(id);
		const reg = await web.sw();
		const list = reg ? await reg.getNotifications() : [...web.plain.values()];
		for (const n of list) if (id === null || n.tag === id) n.close();
	},

	async pushRegister(opts: { vapidPublicKey?: string }): Promise<PushTarget> {
		const reg = await web.sw();
		if (!reg || !('pushManager' in reg)) throw new NativeApiError('unavailable', 'push.register: this browser has no Push API (service workers need https or localhost)');
		if ((await web.request()) !== 'granted') throw new NativeApiError('denied', 'push.register: notifications are not allowed');
		let sub = await reg.pushManager.getSubscription();
		if (!sub) {
			if (!opts.vapidPublicKey) throw new NativeApiError('invalid_args', 'push.register: browsers need `vapidPublicKey` (generateVapidKeys() from @svelte-desktop/shell/push)');
			const key = Uint8Array.from(atob(opts.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
			sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		}
		const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null };
		return { provider: 'webpush', endpoint: json.endpoint, keys: json.keys, expirationTime: json.expirationTime ?? null };
	},

	async pushUnregister() {
		const reg = await web.sw();
		await (await reg?.pushManager.getSubscription())?.unsubscribe();
	},
};

bind();

// ── services ────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
	const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
	const tail = run.catch(() => {});
	locks.set(id, tail);
	void tail.then(() => locks.get(id) === tail && locks.delete(id));
	return run;
}

export const notifications = {
	/** Show (or schedule, with `at`/`delay`) a notification. Same `id` = replaced. */
	async show<D = unknown>(o: NotificationOptions<D>): Promise<{ id: string; scheduled: boolean; skipped?: boolean }> {
		if (!o || typeof o.title !== 'string') throw new NativeApiError('invalid_args', 'notifications.show: `title` must be a string');
		const id = o.id ?? o.tag ?? randomId();
		if (o.lines?.length && o.body === undefined) o = { ...o, body: o.lines.join('\n') };
		if (o.replace === false) {
			// One check-then-show at a time per id, so two callers can't both pass the check.
			return locked(id, async () => {
				const [shown, waiting] = await Promise.all([notifications.delivered(), notifications.pending()]);
				if (shown.some((n) => n.id === id) || waiting.some((n) => n.id === id)) return { id, scheduled: false, skipped: true };
				return notifications.show({ ...o, id, replace: true });
			});
		}
		const actionUrls = Object.fromEntries((o.actions ?? []).filter((a) => a.url).map((a) => [a.id, a.url!]));
		const p: Payload = {};
		if (o.url) p.url = o.url;
		if (o.data !== undefined) p.data = o.data;
		if (Object.keys(actionUrls).length) p.actions = actionUrls;
		const payload = Object.keys(p).length ? JSON.stringify(p) : undefined;
		const at = o.at != null ? toMillis(o.at) : o.delay != null ? Date.now() + o.delay : null;
		if (o.repeat && at === null) throw new NativeApiError('invalid_args', 'notifications.show: `repeat` needs `at` or `delay`');
		if (!native()) return web.show(o, id, payload, at);
		const [image, icon] = await Promise.all([resolveImage(o.image), resolveImage(o.icon)]);
		const args: Record<string, unknown> = {
			id, title: o.title, body: o.body, subtitle: o.subtitle, group: o.group, image, icon, sound: o.sound,
			silent: o.silent, renotify: o.renotify, badge: o.badge, urgency: o.urgency, requireInteraction: o.requireInteraction,
			timestamp: o.timestamp != null ? +o.timestamp : undefined, channel: o.channel, foreground: o.foreground,
			at: at ?? undefined, repeat: o.repeat, payload, lines: o.lines, summary: o.summary, ongoing: o.ongoing,
			autoCancel: o.autoCancel, color: o.color, visibility: o.visibility, closeButtonText: o.closeButtonText, toastXml: o.toastXml,
			actions: o.actions?.map(({ url: _url, label, ...a }) => ({ ...a, title: a.title ?? label })),
		};
		for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
		const r = await callPlatform<{ id?: string; tag?: string; scheduled?: boolean }>('notifications', 'show', args);
		return { id: r?.id ?? r?.tag ?? id, scheduled: !!r?.scheduled };
	},
	/** Alias of show() with a required date. */
	schedule<D = unknown>(o: NotificationOptions<D> & ({ at: Date | number | string } | { delay: number })) {
		return notifications.show(o);
	},
	/** Remove a delivered notification / cancel a pending one. */
	dismiss: (id: string) => (native() ? callPlatform<null>('notifications', 'dismiss', { id }) : web.dismiss(id).then(() => null)),
	/** Every delivered and pending notification of the app. */
	dismissAll: () => (native() ? callPlatform<null>('notifications', 'dismissAll') : web.dismiss(null).then(() => null)),
	/** Cancel a scheduled notification (same as dismiss). */
	cancel: (id: string) => notifications.dismiss(id),
	/** Notifications currently in the notification center. */
	async delivered<D = unknown>(): Promise<NotificationInfo<D>[]> {
		const list = native() ? await callPlatform<WireInfo[]>('notifications', 'delivered') : await web.delivered();
		return (list ?? []).map((w) => toInfo<D>(w));
	},
	/** Scheduled, not yet delivered. */
	async pending<D = unknown>(): Promise<PendingNotification<D>[]> {
		const list = native() ? await callPlatform<WireInfo[]>('notifications', 'pending') : [...web.pending.values()].map((p) => ({ ...p, at: p.at?.getTime(), payload: JSON.stringify({ url: p.url, data: p.data }) }));
		return (list ?? []).map((w) => ({ ...toInfo<D>(w as WireInfo), at: w.at ? new Date(w.at) : null, ...(w.repeat && { repeat: w.repeat }) }));
	},
	/** App icon badge (Dock, iOS icon, Linux docks, Windows taskbar). null/0 clears it. */
	setBadge: (count: number | null) => {
		if (native()) return callPlatform<null>('notifications', 'setBadge', { count });
		const nav = isPage ? (navigator as Navigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> }) : null;
		return (count ? nav?.setAppBadge?.(count) : nav?.clearAppBadge?.())?.then(() => null) ?? Promise.resolve(null);
	},
	/** Banners while the app is frontmost, for notifications without `foreground` and pushes. */
	setForeground: (show: boolean) => (native() ? callPlatform<null>('notifications', 'setForeground', { show }) : Promise.resolve(null)),
	/** Android channels. */
	createChannel: (channel: NotificationChannel) => callPlatform<null>('notifications', 'createChannel', channel as unknown as Record<string, unknown>),
	deleteChannel: (id: string) => callPlatform<null>('notifications', 'deleteChannel', { id }),
	channels: () => callPlatform<NotificationChannel[]>('notifications', 'channels'),
	/** Notifications can be shown here (a bundled app, a notification server, a browser with the API). */
	async isSupported(): Promise<boolean> {
		return (await notifications.getPermissionStatus().catch(() => ({ status: 'unavailable' as const }))).status !== 'unavailable';
	},
	async getPermissionStatus(): Promise<{ status: NotificationPermission }> {
		if (!native()) return { status: web.permission() };
		return callPlatform<{ status: NotificationPermission }>('notifications', 'getPermissionStatus');
	},
	async requestPermission(): Promise<{ status: NotificationPermission }> {
		if (!native()) return { status: await web.request() };
		return callPlatform<{ status: NotificationPermission }>('notifications', 'requestPermission');
	},
	/** click · action · reply · dismiss · response (all four) · shown. */
	on: onNotification,
	/** @deprecated on('response') — raw `{tag, actionId}`. */
	onResponse: (cb: (data: { tag: string; actionId: string | null }) => void) => onPlatform('notificationResponse', cb),
};

export interface NotificationEventMap {
	click: NotificationEvent;
	action: NotificationEvent;
	reply: NotificationEvent;
	dismiss: NotificationEvent;
	response: NotificationEvent;
	shown: NotificationShownEvent;
}

export function onNotification<E extends keyof NotificationEventMap>(event: E, fn: (e: NotificationEventMap[E]) => void): () => void {
	return onNotificationEvent(event, fn as (e: never) => void);
}

export const push = {
	/**
	 * Register for remote pushes (asks for the notification permission). Returns the target
	 * your server sends to — APNs on Apple, FCM on Android, Web Push in a browser
	 * (`vapidPublicKey` required there).
	 */
	async register(opts: { vapidPublicKey?: string } = {}): Promise<PushTarget> {
		if (selfHostedPush()) return desktopPush('register');
		return native() ? callPlatform<PushTarget>('push', 'register') : web.pushRegister(opts);
	},
	unregister: async () => {
		if (selfHostedPush()) await desktopPush('unregister');
		else if (native()) await callPlatform<null>('push', 'unregister');
		else await web.pushUnregister();
		return null;
	},
	/** The current target, or null when not registered. */
	async token(): Promise<PushTarget | null> {
		if (selfHostedPush()) return desktopPush('token');
		if (!native()) {
			const reg = await web.sw();
			const sub = await reg?.pushManager?.getSubscription();
			if (!sub) return null;
			const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
			return { provider: 'webpush', endpoint: json.endpoint, keys: json.keys };
		}
		return callPlatform<PushTarget | null>('push', 'token');
	},
	/** token: a new or rotated target (send it to your server again) · message: a push received while running. */
	on<E extends 'token' | 'message'>(event: E, fn: (e: E extends 'token' ? PushTarget : PushMessage) => void): () => void {
		return onNotificationEvent(event, fn as (e: never) => void);
	},
};
