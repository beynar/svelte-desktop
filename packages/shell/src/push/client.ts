/**
 * The device side of the self-hosted push (desktop.config `push.server`): one WebSocket to
 * your push server (push-server.ts or packages/push-worker), held by the app's server process
 * while the app runs. Messages arrive aes128gcm-encrypted (RFC 8291) for this device's key.
 *
 * - One lifecycle, serialized: create keys → check the stored subscription → subscribe if the
 *   server doesn't know it → connect. Runs on register(), at startup and on every reconnection,
 *   so a server that lost the subscription gets a new one (reported through onTarget).
 * - One delivery pipeline, in order: decrypt → parse → onMessage → ack. A message that can't be
 *   decrypted or parsed is acked and dropped; one whose handler fails stays on the server and
 *   comes back at the next connection.
 * Keys and the device secret persist in `<data>/push.json`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { b64url, fromB64url, parseMessageFrame, PING, type MessageFrame, type WebPushTarget, type WirePushMessage } from './protocol.ts';
import { decryptWebPush } from './server.ts';

interface Stored {
	server: string;
	secret: string;
	jwk: JsonWebKey;
	publicKey: string;
	auth: string;
	subscription?: { id: string; endpoint: string };
}

export interface PushClientOptions {
	/** The push server's URL (https://push.example.com). */
	server: string;
	/** Where keys and the subscription persist. */
	file: string;
	/** A decrypted message. Throw to have it redelivered at the next connection. */
	onMessage(message: WirePushMessage): void | Promise<void>;
	/** A new target (first registration, or re-subscription after the server lost it). */
	onTarget?(target: WebPushTarget): void;
	onState?(state: 'connecting' | 'open' | 'closed'): void;
	/** Lock the subscription to your app server's VAPID key (base64url). */
	applicationServerKey?: string;
}

function parseStored(text: string, server: string): Stored | null {
	try {
		const s = JSON.parse(text) as Partial<Stored>;
		if (s.server !== server || typeof s.secret !== 'string' || typeof s.publicKey !== 'string' || typeof s.auth !== 'string' || !s.jwk) return null;
		const sub = s.subscription;
		if (sub && (typeof sub.id !== 'string' || typeof sub.endpoint !== 'string')) delete s.subscription;
		return s as Stored;
	} catch {
		return null;
	}
}

export function createPushClient(opts: PushClientOptions) {
	const base = opts.server.replace(/\/+$/, '');
	let state: Stored | null = null;
	let key: CryptoKey | null = null;
	let ws: WebSocket | null = null;
	let running = false;
	let retry = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lifecycle: Promise<unknown> = Promise.resolve();
	let delivery: Promise<unknown> = Promise.resolve();

	/** Lifecycle steps run one at a time, in call order. */
	function serial<T>(step: () => Promise<T>): Promise<T> {
		const run = lifecycle.then(step);
		lifecycle = run.catch(() => {});
		return run;
	}

	function load(): Stored | null {
		if (state) return state;
		try {
			state = parseStored(readFileSync(opts.file, 'utf8'), base);
		} catch {}
		return state;
	}

	function save(s: Stored) {
		mkdirSync(dirname(opts.file), { recursive: true });
		writeFileSync(opts.file, JSON.stringify(s, null, 2), { mode: 0o600 });
	}

	const target = (s: Stored & { subscription: { endpoint: string } }): WebPushTarget => ({
		provider: 'webpush', endpoint: s.subscription.endpoint, keys: { p256dh: s.publicKey, auth: s.auth },
	});

	const authed = (s: Stored, init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, authorization: `Bearer ${s.secret}` } });

	/** Keys, a subscription the server knows, persisted. The one place a target is created. */
	async function ensure(): Promise<WebPushTarget> {
		let s = load();
		if (!s) {
			const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
			s = state = {
				server: base,
				secret: b64url(crypto.getRandomValues(new Uint8Array(32))),
				jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
				publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
				auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
			};
			save(s);
		}
		if (s.subscription) {
			const res = await fetch(`${base}/v1/subscriptions/${s.subscription.id}`, authed(s));
			if (res.status === 404) {
				delete s.subscription;
				save(s);
			} else if (!res.ok) throw new Error(`push server ${base}: HTTP ${res.status}`);
		}
		if (!s.subscription) {
			const res = await fetch(`${base}/v1/subscribe`, authed(s, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(opts.applicationServerKey ? { applicationServerKey: opts.applicationServerKey } : {}),
			}));
			if (!res.ok) throw new Error(`push server ${base}: subscribe failed (HTTP ${res.status} ${await res.text().catch(() => '')})`);
			const sub = (await res.json()) as { id?: unknown; endpoint?: unknown };
			if (typeof sub.id !== 'string' || typeof sub.endpoint !== 'string') throw new Error(`push server ${base}: bad subscribe answer`);
			s.subscription = { id: sub.id, endpoint: sub.endpoint };
			save(s);
			opts.onTarget?.(target(s as Stored & { subscription: { endpoint: string } }));
		}
		return target(s as Stored & { subscription: { endpoint: string } });
	}

	async function handle(frame: MessageFrame, socket: WebSocket) {
		const s = state!;
		let message: WirePushMessage;
		try {
			key ??= await crypto.subtle.importKey('jwk', s.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
			const plain = await decryptWebPush(Uint8Array.from(Buffer.from(frame.body, 'base64')), key, fromB64url(s.publicKey)!, fromB64url(s.auth)!);
			const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
			if (typeof parsed !== 'object' || parsed === null) throw new Error('not a JSON object');
			message = parsed as WirePushMessage;
		} catch (err) {
			console.error(`[push] dropped an unreadable message: ${(err as Error).message}`);
			socket.send(JSON.stringify({ type: 'ack', id: frame.id }));
			return;
		}
		try {
			await opts.onMessage(message);
			socket.send(JSON.stringify({ type: 'ack', id: frame.id }));
		} catch (err) {
			console.error(`[push] will retry ${message.id ?? frame.id}: ${(err as Error).message}`);
		}
	}

	function connect() {
		if (!running || !state) return;
		if (timer) clearTimeout(timer);
		timer = null;
		opts.onState?.('connecting');
		const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/connect`, { headers: { authorization: `Bearer ${state.secret}` } } as unknown as string[]);
		ws = socket;
		let ping: ReturnType<typeof setInterval> | null = null;
		socket.onopen = () => {
			retry = 0;
			opts.onState?.('open');
			// Keep-alive through proxies / idle timeouts (answered without waking a Durable Object).
			ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(PING), 30_000);
			// Every (re)connection: the subscription must still exist on the server.
			void serial(ensure).catch((err) => console.error(`[push] ${(err as Error).message}`));
		};
		socket.onmessage = (e) => {
			const frame = parseMessageFrame(e.data);
			if (frame) delivery = delivery.then(() => handle(frame, socket));
		};
		socket.onclose = () => {
			if (ping) clearInterval(ping);
			if (ws === socket) ws = null;
			opts.onState?.('closed');
			if (!running) return;
			// Backoff: 1 s, 2 s, 4 s … 60 s, with jitter.
			const delay = Math.min(60_000, 1000 * 2 ** retry++) * (0.75 + Math.random() / 2);
			timer = setTimeout(connect, delay);
		};
	}

	function run() {
		running = true;
		if (!ws) connect(); // waiting in backoff (server was down) → now
	}

	function stop() {
		running = false;
		if (timer) clearTimeout(timer);
		timer = null;
		ws?.close();
		ws = null;
	}

	return {
		/** Subscribe (once; persisted) and connect. Returns the target your server sends to. */
		async register(): Promise<WebPushTarget> {
			const t = await serial(ensure);
			run();
			return t;
		},
		/** At startup: reconnect if registered before (no-op otherwise). */
		start() {
			if (load()?.subscription) run();
		},
		/** The stored target, or null. */
		target(): WebPushTarget | null {
			const s = load();
			return s?.subscription ? target(s as Stored & { subscription: { endpoint: string } }) : null;
		},
		/** Forgets the subscription only once the server confirmed (or never had it). */
		unregister(): Promise<void> {
			return serial(async () => {
				const s = load();
				stop();
				if (!s?.subscription) return;
				const res = await fetch(`${base}/v1/subscriptions/${s.subscription.id}`, authed(s, { method: 'DELETE' }));
				if (!res.ok && res.status !== 404) throw new Error(`push server ${base}: unsubscribe failed (HTTP ${res.status})`);
				delete s.subscription;
				save(s);
			});
		},
		stop,
		get connected() {
			return ws?.readyState === WebSocket.OPEN;
		},
	};
}
