/**
 * Send remote pushes from your server (Bun) to what `host.push.register()` returned:
 * APNs (macOS, iOS), Firebase Cloud Messaging (Android) and Web Push (browsers).
 * No dependencies: WebCrypto for the JWTs and the Web Push encryption, node:http2 for APNs.
 *
 *   import { createPush } from '@svelte-desktop/shell/push';
 *   const push = createPush({
 *     apns: { teamId, keyId, key: await Bun.file('AuthKey.p8').text() },
 *     fcm: { serviceAccount: await Bun.file('service-account.json').json() },
 *     webpush: { publicKey, privateKey, subject: 'mailto:ops@example.com' },
 *   });
 *   await push.send(target, { id: 'msg-42', title: 'Alice', body: 'Lunch?', url: '/chat/42' });
 *
 * `id` dedupes on every channel (apns-collapse-id, FCM tag/collapse_key, Web Push tag/Topic):
 * the device shows one notification per id, and a local `host.notifications.show({ id })`
 * replaces it too. A target the service reports gone throws PushError with `expired: true`:
 * delete it.
 */
import http2 from 'node:http2';
import { b64url, fromB64url as decodeB64url, MAX_PLAINTEXT, type PushTarget } from './protocol.ts';

export type { PushTarget } from './protocol.ts';

export interface PushNotification {
	/** Dedupe/replace key, handed back as the notification id on the device. */
	id?: string;
	title?: string;
	body?: string;
	subtitle?: string;
	/** Opened on click (an app path, the app's scheme, or http(s)). */
	url?: string;
	/** JSON handed to the app (`event.data`, `message.data`). */
	data?: unknown;
	/** App icon badge (APNs; Web Push: badge image URL via `webpush.badge`). */
	badge?: number;
	/** 'default' or a sound name. */
	sound?: string;
	silent?: boolean;
	/** Thread / group. */
	group?: string;
	/** Image URL (FCM, Web Push; APNs needs a notification service extension). */
	image?: string;
	/** Android channel. */
	channel?: string;
	/** Seconds the service keeps it while the device is offline. Default 4 weeks. */
	ttl?: number;
	/** 'high' (default) wakes the device now; 'normal' may be delayed to save battery. */
	priority?: 'high' | 'normal';
	/** A data-only push: no notification, delivered to `host.push.on('message')` when running. */
	background?: boolean;
	/** Raw overrides merged into each provider's payload. */
	apns?: Record<string, unknown>;
	fcm?: Record<string, unknown>;
	webpush?: Record<string, unknown>;
}

export interface PushConfig {
	apns?: {
		/** Apple Developer team id. */
		teamId: string;
		/** Key id of the .p8 APNs auth key. */
		keyId: string;
		/** The .p8 contents (PEM). */
		key: string;
		/** Default topic (the bundle id) when the target has none. */
		topic?: string;
		/** Force an environment instead of the target's. */
		environment?: 'development' | 'production';
		/** Test seam: APNs origin. */
		origin?: string;
	};
	fcm?: {
		/** The Firebase service account JSON (object or string). */
		serviceAccount: { project_id: string; client_email: string; private_key: string; token_uri?: string } | string;
		/** Test seam: FCM API origin. */
		origin?: string;
	};
	webpush?: {
		/** VAPID keys (base64url) from generateVapidKeys(). */
		publicKey: string;
		privateKey: string;
		/** 'mailto:…' or an https URL the push service can reach you at. */
		subject: string;
	};
}

export class PushError extends Error {
	constructor(
		message: string,
		readonly provider: PushTarget['provider'],
		readonly status: number,
		/** The provider's reason (APNs `reason`, FCM error status…). */
		readonly reason: string,
		/** The target is gone (uninstalled, unsubscribed, token rotated): delete it. */
		readonly expired: boolean,
	) {
		super(message);
		this.name = 'PushError';
	}
}

// ── encoding helpers ────────────────────────────────────────────────

const enc = new TextEncoder();

/** Keys and secrets from configs and targets: base64url, or a clear error. */
function fromB64url(s: string): Uint8Array {
	const bytes = decodeB64url(s);
	if (!bytes) throw new Error(`push: not base64url: ${s.slice(0, 16)}…`);
	return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) (out.set(p, o), (o += p.length));
	return out;
}

function pemBody(pem: string): Uint8Array {
	return Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
}

async function jwt(header: object, claims: object, key: CryptoKey, alg: 'ES256' | 'RS256'): Promise<string> {
	const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
	const params = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
	// WebCrypto ECDSA signatures are already raw r||s (what JWS wants).
	const sig = await crypto.subtle.sign(params, key, enc.encode(input));
	return `${input}.${b64url(sig)}`;
}

const now = () => Math.floor(Date.now() / 1000);

function payloadOf(n: PushNotification): string | undefined {
	const p: Record<string, unknown> = {};
	if (n.url) p.url = n.url;
	if (n.data !== undefined) p.data = n.data;
	return Object.keys(p).length ? JSON.stringify(p) : undefined;
}

// ── VAPID / Web Push ────────────────────────────────────────────────

/** A VAPID key pair for Web Push: give `publicKey` to `host.push.register({ vapidPublicKey })`. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	return { publicKey: b64url(raw), privateKey: jwk.d! };
}

function p256Jwk(publicKey: Uint8Array, d?: string): JsonWebKey {
	return { kty: 'EC', crv: 'P-256', x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33, 65)), ...(d && { d }), ext: true };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/**
 * RFC 8291 (aes128gcm) message encryption. `salt` / `senderKeys` are test seams.
 * Returns the request body: salt ‖ rs ‖ idlen ‖ keyid ‖ ciphertext.
 */
export async function encryptWebPush(
	plaintext: Uint8Array,
	keys: { p256dh: string; auth: string },
	seams: { salt?: Uint8Array; senderPrivate?: string; senderPublic?: string } = {},
): Promise<Uint8Array> {
	if (plaintext.length > MAX_PLAINTEXT) throw new Error(`web push: message larger than ${MAX_PLAINTEXT} bytes (push services accept 4096-byte bodies)`);
	const uaPublic = fromB64url(keys.p256dh);
	const authSecret = fromB64url(keys.auth);
	let asPrivate: CryptoKey, asPublic: Uint8Array;
	if (seams.senderPrivate && seams.senderPublic) {
		asPublic = fromB64url(seams.senderPublic);
		asPrivate = await crypto.subtle.importKey('jwk', p256Jwk(asPublic, seams.senderPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
	} else {
		const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
		asPrivate = pair.privateKey;
		asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	}
	const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
	const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
	const salt = seams.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
	const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	// One record: plaintext ‖ 0x02 (last-record delimiter), no padding.
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
	// One record ≤ 4096 bytes (MAX_PLAINTEXT caps it), so rs = 4096 always covers it.
	const rs = 4096;
	const header = new Uint8Array(21 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, rs);
	header[20] = asPublic.length;
	header.set(asPublic, 21);
	return concat(header, ciphertext);
}

/**
 * The receiving side of RFC 8291: decrypt an aes128gcm body with the subscription's private
 * key (ECDH P-256) and auth secret. Used by the desktop client of the self-hosted push.
 */
export async function decryptWebPush(body: Uint8Array, privateKey: CryptoKey, publicKey: Uint8Array, authSecret: Uint8Array): Promise<Uint8Array> {
	if (body.length < 21) throw new Error('web push: body too short');
	const salt = body.subarray(0, 16);
	const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
	const idlen = body[20];
	if (rs < 18 || body.length - 21 - idlen > rs) throw new Error('web push: one record larger than its record size (rs)');
	const asPublic = body.subarray(21, 21 + idlen);
	const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, privateKey, 256));
	const ikm = await hkdf(authSecret, secret, concat(enc.encode('WebPush: info\0'), publicKey, asPublic), 32);
	const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
	const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.subarray(21 + idlen)));
	// Strip the padding: the last non-zero byte is the delimiter (2 = last record).
	let end = plain.length - 1;
	while (end >= 0 && plain[end] === 0) end--;
	if (end < 0 || plain[end] !== 2) throw new Error('web push: bad record delimiter');
	return plain.subarray(0, end);
}

/** Web Push Topic header: ≤32 URL-safe chars. */
async function topicFor(id: string): Promise<string> {
	if (/^[A-Za-z0-9_-]{1,32}$/.test(id)) return id;
	return b64url(await crypto.subtle.digest('SHA-256', enc.encode(id))).slice(0, 32);
}

// ── the sender ──────────────────────────────────────────────────────

export interface PushSender {
	/** Send one push. Resolves with the provider's message id when it gives one. */
	send(target: PushTarget, notification: PushNotification): Promise<{ id?: string }>;
	/** Send to many targets; never throws: one result per target, `expired` ones should be deleted. */
	sendMany(targets: PushTarget[], notification: PushNotification): Promise<({ ok: true; id?: string } | { ok: false; error: PushError | Error; expired: boolean })[]>;
	/** Close the APNs HTTP/2 connections. */
	close(): void;
}

export function createPush(config: PushConfig): PushSender {
	// APNs: one ES256 provider token (≤ 1 h, refreshed after 50 min), one HTTP/2 session per origin.
	let apnsKey: Promise<CryptoKey> | null = null;
	let apnsToken: { value: string; at: number } | null = null;
	const sessions = new Map<string, http2.ClientHttp2Session>();
	async function apnsJwt(): Promise<string> {
		const c = config.apns!;
		if (apnsToken && now() - apnsToken.at < 3000) return apnsToken.value;
		apnsKey ??= crypto.subtle.importKey('pkcs8', pemBody(c.key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
		const at = now();
		apnsToken = { value: await jwt({ alg: 'ES256', kid: c.keyId }, { iss: c.teamId, iat: at }, await apnsKey, 'ES256'), at };
		return apnsToken.value;
	}
	function session(origin: string): http2.ClientHttp2Session {
		let s = sessions.get(origin);
		if (!s || s.closed || s.destroyed) {
			s = http2.connect(origin);
			s.on('error', () => sessions.delete(origin));
			s.on('close', () => sessions.delete(origin));
			s.unref();
			sessions.set(origin, s);
		}
		return s;
	}

	async function sendApns(t: Extract<PushTarget, { provider: 'apns' }>, n: PushNotification) {
		const c = config.apns;
		if (!c) throw new PushError('push: no `apns` config', 'apns', 0, 'NotConfigured', false);
		const env = c.environment ?? t.environment ?? 'production';
		const origin = c.origin ?? (env === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
		const topic = t.topic || c.topic;
		if (!topic) throw new PushError('push: APNs needs a topic (the bundle id)', 'apns', 0, 'MissingTopic', false);
		const aps: Record<string, unknown> = {};
		if (n.background) aps['content-available'] = 1;
		else {
			aps.alert = { title: n.title, subtitle: n.subtitle, body: n.body };
			if (!n.silent) aps.sound = n.sound ?? 'default';
		}
		if (n.badge != null) aps.badge = n.badge;
		if (n.group) aps['thread-id'] = n.group;
		const body: Record<string, unknown> = { aps, ...n.apns };
		const payload = payloadOf(n);
		if (payload) body.sd = payload;
		if (n.id) body.sd_id = n.id;
		const headers: Record<string, string> = {
			':method': 'POST',
			':path': `/3/device/${t.token}`,
			authorization: `bearer ${await apnsJwt()}`,
			'apns-topic': topic,
			'apns-push-type': n.background ? 'background' : 'alert',
			'apns-priority': n.background || n.priority === 'normal' ? '5' : '10',
			'apns-expiration': String(now() + (n.ttl ?? 2419200)),
			'content-type': 'application/json',
		};
		if (n.id) headers['apns-collapse-id'] = n.id.slice(0, 64);
		const res = await new Promise<{ status: number; body: string; headers: http2.IncomingHttpHeaders }>((resolve, reject) => {
			const req = session(origin).request(headers);
			let data = '';
			let h: http2.IncomingHttpHeaders = {};
			req.setEncoding('utf8');
			req.on('response', (rh) => (h = rh));
			req.on('data', (d) => (data += d));
			req.on('end', () => resolve({ status: Number(h[':status'] ?? 0), body: data, headers: h }));
			req.on('error', reject);
			req.end(JSON.stringify(body));
		});
		if (res.status === 200) return { id: String(res.headers['apns-id'] ?? '') || undefined };
		const reason = (() => { try { return JSON.parse(res.body).reason as string; } catch { return res.body; } })() || `HTTP ${res.status}`;
		const expired = res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic';
		throw new PushError(`push: APNs ${res.status} ${reason}`, 'apns', res.status, reason, expired);
	}

	// FCM HTTP v1: an OAuth2 access token from the service account (RS256 assertion), cached.
	let fcmToken: { value: string; until: number } | null = null;
	const account = () => {
		const a = config.fcm!.serviceAccount;
		return typeof a === 'string' ? JSON.parse(a) as Exclude<typeof a, string> : a;
	};
	async function fcmAccess(): Promise<string> {
		if (fcmToken && fcmToken.until > now() + 60) return fcmToken.value;
		const a = account();
		const uri = a.token_uri ?? 'https://oauth2.googleapis.com/token';
		const key = await crypto.subtle.importKey('pkcs8', pemBody(a.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
		const iat = now();
		const assertion = await jwt({ alg: 'RS256', typ: 'JWT' }, { iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: uri, iat, exp: iat + 3600 }, key, 'RS256');
		const res = await fetch(uri, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
		});
		const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
		if (!res.ok || !json.access_token) throw new PushError(`push: FCM OAuth ${res.status} ${json.error ?? ''}`.trim(), 'fcm', res.status, json.error ?? 'OAuth', false);
		fcmToken = { value: json.access_token, until: iat + (json.expires_in ?? 3600) };
		return fcmToken.value;
	}

	async function sendFcm(t: Extract<PushTarget, { provider: 'fcm' }>, n: PushNotification) {
		if (!config.fcm) throw new PushError('push: no `fcm` config', 'fcm', 0, 'NotConfigured', false);
		const a = account();
		const data: Record<string, string> = {};
		const payload = payloadOf(n);
		if (payload) data.sd = payload;
		if (n.id) data.sd_id = n.id;
		const android: Record<string, unknown> = { priority: n.priority === 'normal' ? 'NORMAL' : 'HIGH', ttl: `${n.ttl ?? 2419200}s` };
		if (n.id) android.collapse_key = n.id;
		const message: Record<string, unknown> = { token: t.token, data, android };
		if (!n.background) {
			message.notification = { title: n.title, body: n.body, ...(n.image && { image: n.image }) };
			android.notification = {
				...(n.id && { tag: n.id }),
				...(n.channel && { channel_id: n.channel }),
				...(n.silent ? { default_sound: false, notification_priority: 'PRIORITY_LOW' } : { default_sound: !n.sound || n.sound === 'default', ...(n.sound && n.sound !== 'default' && { sound: n.sound }) }),
				...(n.badge != null && { notification_count: n.badge }),
			};
		}
		Object.assign(message, n.fcm);
		const origin = config.fcm.origin ?? 'https://fcm.googleapis.com';
		const res = await fetch(`${origin}/v1/projects/${a.project_id}/messages:send`, {
			method: 'POST',
			headers: { authorization: `Bearer ${await fcmAccess()}`, 'content-type': 'application/json' },
			body: JSON.stringify({ message }),
		});
		const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
		if (res.ok) return { id: json.name };
		const code = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status ?? `HTTP ${res.status}`;
		const expired = code === 'UNREGISTERED' || (res.status === 404 && code === 'NOT_FOUND') || (code === 'INVALID_ARGUMENT' && /registration token/i.test(json.error?.message ?? ''));
		throw new PushError(`push: FCM ${res.status} ${code}${json.error?.message ? `: ${json.error.message}` : ''}`, 'fcm', res.status, code, expired);
	}

	let vapidKey: Promise<CryptoKey> | null = null;
	async function sendWebPush(t: Extract<PushTarget, { provider: 'webpush' }>, n: PushNotification) {
		const c = config.webpush;
		if (!c) throw new PushError('push: no `webpush` config', 'webpush', 0, 'NotConfigured', false);
		vapidKey ??= crypto.subtle.importKey('jwk', p256Jwk(fromB64url(c.publicKey), c.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
		const audience = new URL(t.endpoint).origin;
		const token = await jwt({ typ: 'JWT', alg: 'ES256' }, { aud: audience, exp: now() + 12 * 3600, sub: c.subject }, await vapidKey, 'ES256');
		const message: Record<string, unknown> = n.background
			? { payload: payloadOf(n), id: n.id }
			: { id: n.id, title: n.title, body: n.body, subtitle: n.subtitle, image: n.image, silent: n.silent, payload: payloadOf(n) };
		Object.assign(message, n.webpush);
		const body = await encryptWebPush(enc.encode(JSON.stringify(message)), t.keys);
		const headers: Record<string, string> = {
			authorization: `vapid t=${token}, k=${c.publicKey}`,
			'content-encoding': 'aes128gcm',
			'content-type': 'application/octet-stream',
			ttl: String(n.ttl ?? 2419200),
			urgency: n.priority === 'normal' ? 'normal' : 'high',
		};
		if (n.id) headers.topic = await topicFor(n.id);
		const res = await fetch(t.endpoint, { method: 'POST', headers, body });
		if (res.ok) return { id: res.headers.get('location') ?? undefined };
		const text = await res.text().catch(() => '');
		throw new PushError(`push: Web Push ${res.status} ${text.slice(0, 200)}`.trim(), 'webpush', res.status, text.slice(0, 200) || `HTTP ${res.status}`, res.status === 404 || res.status === 410);
	}

	const sender: PushSender = {
		send(target, n) {
			switch (target?.provider) {
				case 'apns': return sendApns(target, n);
				case 'fcm': return sendFcm(target, n);
				case 'webpush': return sendWebPush(target, n);
				default: return Promise.reject(new Error(`push: unknown target ${JSON.stringify(target)}`));
			}
		},
		async sendMany(targets, n) {
			return Promise.all(targets.map((t) => sender.send(t, n).then(
				(r) => ({ ok: true as const, ...r }),
				(error: Error) => ({ ok: false as const, error, expired: error instanceof PushError && error.expired }),
			)));
		},
		close() {
			for (const s of sessions.values()) s.close();
			sessions.clear();
		},
	};
	return sender;
}
