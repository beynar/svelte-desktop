/**
 * The device side of the self-hosted push (desktop.config `push.server`): one WebSocket to
 * your push server (push-server.ts), held by the app's server process while the app runs,
 * window closed included. Messages arrive aes128gcm-encrypted (RFC 8291) for this device's
 * key; they're decrypted here, shown as notifications (`id` dedupes, payload deep-links) and
 * emitted as `pushMessage`. Keys and the device secret persist in `<data>/push.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { b64url, decryptWebPush, fromB64url } from './server.ts';

export interface WebPushTarget {
	provider: 'webpush';
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** What `createPush().send()` puts in a Web Push message. */
export interface PushPayload {
	id?: string;
	title?: string;
	body?: string;
	subtitle?: string;
	image?: string;
	silent?: boolean;
	payload?: string;
	[key: string]: unknown;
}

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
	/** A decrypted message. Resolve when it's handled (then it's acked and removed from the server). */
	onMessage(message: PushPayload): void | Promise<void>;
	/** The target changed (first registration, re-subscription). */
	onTarget?(target: WebPushTarget): void;
	/** Connection state, for diagnostics. */
	onState?(state: 'connecting' | 'open' | 'closed'): void;
	/** Test seam: the VAPID public key subscriptions are locked to. */
	applicationServerKey?: string;
}

export function createPushClient(opts: PushClientOptions) {
	const base = opts.server.replace(/\/+$/, '');
	let state: Stored | null = null;
	let key: CryptoKey | null = null;
	let ws: WebSocket | null = null;
	let stopped = true;
	let retry = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function load(): Stored | null {
		if (state) return state;
		try {
			const s = JSON.parse(readFileSync(opts.file, 'utf8')) as Stored;
			if (s.server === base) state = s;
		} catch {}
		return state;
	}

	function save() {
		mkdirSync(dirname(opts.file), { recursive: true });
		writeFileSync(opts.file, JSON.stringify(state, null, 2), { mode: 0o600 });
	}

	async function ensureKeys(): Promise<Stored> {
		const s = load();
		if (s) return s;
		const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
		state = {
			server: base,
			secret: b64url(crypto.getRandomValues(new Uint8Array(32))),
			jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
			publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
			auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
		};
		save();
		return state;
	}

	async function privateKey(): Promise<CryptoKey> {
		return (key ??= await crypto.subtle.importKey('jwk', (await ensureKeys()).jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']));
	}

	/** Drop the stored subscription if the server no longer knows it (404). Network errors keep it. */
	async function validate(s: Stored) {
		if (!s.subscription) return;
		const res = await fetch(`${base}/v1/subscriptions/${s.subscription.id}`, { headers: { authorization: `Bearer ${s.secret}` } }).catch(() => null);
		if (res?.status === 404) {
			delete s.subscription;
			save();
		}
	}

	const target = (s: Stored): WebPushTarget => ({ provider: 'webpush', endpoint: s.subscription!.endpoint, keys: { p256dh: s.publicKey, auth: s.auth } });

	async function handle(frame: { id: string; body: string }) {
		const s = state!;
		try {
			const plain = await decryptWebPush(Uint8Array.from(Buffer.from(frame.body, 'base64')), await privateKey(), fromB64url(s.publicKey), fromB64url(s.auth));
			const text = new TextDecoder().decode(plain);
			let message: PushPayload;
			try {
				message = JSON.parse(text);
			} catch {
				message = { body: text };
			}
			await opts.onMessage(message);
		} catch (err) {
			console.error(`[push] dropped a message: ${(err as Error).message}`);
		}
		ws?.send(JSON.stringify({ type: 'ack', id: frame.id }));
	}

	function connect() {
		if (stopped || !state) return;
		opts.onState?.('connecting');
		const url = `${base.replace(/^http/, 'ws')}/v1/connect`;
		const socket = new WebSocket(url, { headers: { authorization: `Bearer ${state.secret}` } } as unknown as string[]);
		ws = socket;
		let ping: ReturnType<typeof setInterval> | null = null;
		socket.onopen = () => {
			retry = 0;
			opts.onState?.('open');
			// Keep-alive through proxies / idle timeouts (answered without waking a Durable Object).
			ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('{"type":"ping"}'), 30_000);
		};
		socket.onmessage = (e) => {
			try {
				const m = JSON.parse(String(e.data));
				if (m.type === 'message') void handle(m);
			} catch {}
		};
		socket.onclose = () => {
			if (ping) clearInterval(ping);
			if (ws === socket) ws = null;
			opts.onState?.('closed');
			if (stopped) return;
			// Backoff: 1 s, 2 s, 4 s … 60 s, with jitter.
			const delay = Math.min(60_000, 1000 * 2 ** retry++) * (0.75 + Math.random() / 2);
			timer = setTimeout(connect, delay);
		};
		socket.onerror = () => {};
	}

	return {
		/** Subscribe (once; persisted) and connect. Returns the target your server sends to. */
		async register(): Promise<WebPushTarget> {
			const s = await ensureKeys();
			await validate(s);
			if (!s.subscription) {
				const res = await fetch(`${base}/v1/subscribe`, {
					method: 'POST',
					headers: { authorization: `Bearer ${s.secret}`, 'content-type': 'application/json' },
					body: JSON.stringify(opts.applicationServerKey ? { applicationServerKey: opts.applicationServerKey } : {}),
				});
				if (!res.ok) throw new Error(`push server ${base}: subscribe failed (HTTP ${res.status} ${await res.text().catch(() => '')})`);
				s.subscription = (await res.json()) as { id: string; endpoint: string };
				save();
				opts.onTarget?.(target(s));
			}
			this.start();
			// Waiting in backoff (the server was down)? Reconnect now.
			if (!stopped && ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) {
				if (timer) clearTimeout(timer);
				retry = 0;
				connect();
			}
			return target(s);
		},
		/** Reconnect with the stored subscription (at startup); no-op when never registered. */
		start() {
			const s = load();
			if (!s?.subscription || !stopped) return;
			stopped = false;
			connect();
			// The server may have lost it (database reset, another server at this URL): re-subscribe
			// and announce the new target (onTarget → push.on('token')).
			void validate(s).then(() => { if (!s.subscription && !stopped) return this.register(); }).catch(() => {});
		},
		/** The stored target, or null. */
		target(): WebPushTarget | null {
			const s = load();
			return s?.subscription ? target(s) : null;
		},
		async unregister() {
			const s = load();
			this.stop();
			if (s?.subscription) {
				await fetch(`${base}/v1/subscriptions/${s.subscription.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${s.secret}` } }).catch(() => {});
				delete s.subscription;
				save();
			}
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			ws?.close();
			ws = null;
		},
		get connected() {
			return ws?.readyState === WebSocket.OPEN;
		},
		/** Exists for tests. */
		get file() {
			return existsSync(opts.file) ? opts.file : null;
		},
	};
}
