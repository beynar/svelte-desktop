/**
 * The self-hosted push protocol (native/NOTIFICATIONS.md, "Self-hosted push"), shared by its
 * two servers — push-server.ts (Bun) and packages/push-worker (Cloudflare) — and the device
 * client. Runtime-free (WebCrypto + fetch types only): no Node or Bun import, so the Worker can
 * import it. Storage and sockets stay in each server; every rule about the wire lives here.
 */

// ── the targets and the message (what host.push.register() returns, what createPush sends) ──

/** What `host.push.register()` returns: send it to your server, give it to `createPush().send()`. */
export type PushTarget =
	| { provider: 'apns'; token: string; topic: string; environment: 'development' | 'production' }
	| WebPushTarget;

export interface WebPushTarget {
	provider: 'webpush';
	endpoint: string;
	keys: { p256dh: string; auth: string };
	expirationTime?: number | null;
}

/** The JSON a Web Push message carries (encrypted), written by createPush, read by the clients. */
export interface WirePushMessage {
	id?: string;
	title?: string;
	body?: string;
	subtitle?: string;
	image?: string;
	silent?: boolean;
	/** JSON `{ url, data }` (the notification payload). */
	payload?: string;
}

// ── limits ──

export const MAX_TTL = 2419200; // 4 weeks
/** Largest encrypted body (what push services accept, RFC 8030 §7.2). */
export const MAX_BODY = 4096;
/** aes128gcm overhead of one record: salt 16 + rs 4 + idlen 1 + P-256 key 65 + delimiter 1 + tag 16. */
export const MAX_PLAINTEXT = MAX_BODY - 103;
export const MAX_QUEUE = 100; // queued messages kept per subscription
export const MIN_SECRET = 16;

// ── encoding ──

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** null for anything that isn't base64url. */
export function fromB64url(s: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
		return Uint8Array.from(b, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

export function b64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export function randomId(bytes = 16): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A device is named by the hash of its secret: the secret never needs storing. */
export async function deviceName(secret: string): Promise<string> {
	return b64url(await crypto.subtle.digest('SHA-256', enc.encode(secret)));
}

export const now = () => Math.floor(Date.now() / 1000);

// ── requests (validated at the door) ──

export type Refusal = { status: number; error: string };
export const refuse = (status: number, error: string): Refusal => ({ status, error });
export const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && 'status' in v && 'error' in v;
export const respond = (r: Refusal) => Response.json({ error: r.error }, { status: r.status });

/** The device secret: `Authorization: Bearer …` (or `?secret=` where headers can't be set). */
export function deviceSecret(req: Request): string | Refusal {
	const h = req.headers.get('authorization');
	const secret = h?.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : new URL(req.url).searchParams.get('secret');
	return secret && secret.length >= MIN_SECRET ? secret : refuse(401, `device secret required (≥ ${MIN_SECRET} chars)`);
}

/** POST /v1/subscribe body: `{}` or `{ applicationServerKey }` (an uncompressed P-256 point). */
export async function parseSubscribe(req: Request): Promise<{ vapid: string | null } | Refusal> {
	const text = await req.text();
	if (!text.trim()) return { vapid: null };
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return refuse(400, 'body must be JSON');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'body must be an object');
	const key = (body as { applicationServerKey?: unknown }).applicationServerKey;
	if (key === undefined) return { vapid: null };
	if (typeof key !== 'string' || fromB64url(key)?.length !== 65 || fromB64url(key)![0] !== 4)
		return refuse(400, 'applicationServerKey must be an uncompressed P-256 point (base64url)');
	return { vapid: key };
}

export interface PushRequest {
	ttl: number;
	topic: string | null;
	urgency: string | null;
	body: Uint8Array;
	authorization: string | null;
}

/** POST /v1/push/…: headers checked first, then the body read with a hard cap (never buffered past it). */
export async function parsePush(req: Request): Promise<PushRequest | Refusal> {
	const length = Number(req.headers.get('content-length') ?? 0);
	if (length > MAX_BODY) return refuse(413, `body larger than ${MAX_BODY} bytes`);
	const topic = req.headers.get('topic');
	if (topic && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) return refuse(400, 'Topic must be ≤ 32 base64url characters');
	const ttlHeader = req.headers.get('ttl');
	const ttl = ttlHeader === null ? 0 : Number(ttlHeader);
	if (!Number.isInteger(ttl) || ttl < 0) return refuse(400, 'TTL must be a non-negative integer');
	const urgency = req.headers.get('urgency');
	if (urgency && !['very-low', 'low', 'normal', 'high'].includes(urgency)) return refuse(400, 'Urgency must be very-low | low | normal | high');
	const body = await readCapped(req, MAX_BODY);
	if (!body) return refuse(413, `body larger than ${MAX_BODY} bytes`);
	if (body.length && req.headers.get('content-encoding') !== 'aes128gcm') return refuse(415, 'Content-Encoding must be aes128gcm');
	return { ttl: Math.min(ttl, MAX_TTL), topic, urgency, body, authorization: req.headers.get('authorization') };
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
	if (!req.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = req.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let o = 0;
	for (const c of chunks) (out.set(c, o), (o += c.length));
	return out;
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<key>`, the key locked to the subscription. null = valid. */
export async function checkVapid(header: string | null, expectedKey: string, audience: string): Promise<Refusal | null> {
	const m = /^vapid\s+(.+)$/i.exec(header ?? '');
	if (!m) return refuse(401, 'missing VAPID authorization');
	const params: Record<string, string> = {};
	for (const part of m[1].split(',')) {
		const [k, ...v] = part.trim().split('=');
		params[k.trim()] = v.join('=').trim();
	}
	const key = fromB64url(params.k ?? '');
	const expected = fromB64url(expectedKey);
	if (!params.t || !key || !expected) return refuse(401, 'malformed VAPID authorization');
	if (b64url(key) !== b64url(expected)) return refuse(401, 'VAPID key does not match the subscription');
	const [h64, c64, s64] = params.t.split('.');
	const sig = fromB64url(s64 ?? '');
	const claimsBytes = fromB64url(c64 ?? '');
	if (!h64 || !sig || !claimsBytes) return refuse(401, 'malformed VAPID token');
	try {
		const k = await crypto.subtle.importKey('raw', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, enc.encode(`${h64}.${c64}`)))) return refuse(401, 'bad VAPID signature');
		const claims = JSON.parse(new TextDecoder().decode(claimsBytes)) as { aud?: unknown; exp?: unknown };
		if (claims.aud !== audience) return refuse(401, `VAPID audience must be ${audience}`);
		if (typeof claims.exp !== 'number' || claims.exp < now() || claims.exp > now() + 24 * 3600) return refuse(401, 'VAPID token expired or too long-lived');
	} catch {
		return refuse(401, 'invalid VAPID token');
	}
	return null;
}

// ── the device WebSocket ──

/** Server → device. */
export interface MessageFrame {
	type: 'message';
	id: string;
	subscription: string;
	topic: string | null;
	/** base64 of the aes128gcm body. */
	body: string;
}

/** Device → server. */
export type DeviceFrame = { type: 'ack'; id: string } | { type: 'ping' };

export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

export function messageFrame(m: { id: string; subscription: string; topic: string | null; body: Uint8Array | ArrayBuffer }): string {
	const body = m.body instanceof Uint8Array ? m.body : new Uint8Array(m.body);
	return JSON.stringify({ type: 'message', id: m.id, subscription: m.subscription, topic: m.topic, body: b64(body) } satisfies MessageFrame);
}

export function parseDeviceFrame(raw: string | ArrayBuffer | Uint8Array): DeviceFrame | null {
	try {
		const m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as Partial<{ type: unknown; id: unknown }>;
		if (m.type === 'ping') return { type: 'ping' };
		if (m.type === 'ack' && typeof m.id === 'string') return { type: 'ack', id: m.id };
	} catch {}
	return null;
}

export function parseMessageFrame(raw: unknown): MessageFrame | null {
	try {
		const m = JSON.parse(String(raw)) as Partial<MessageFrame>;
		if (m.type === 'message' && typeof m.id === 'string' && typeof m.body === 'string') return m as MessageFrame;
	} catch {}
	return null;
}

/** When a message stops being deliverable. TTL 0 is never stored (delivered now or dropped). */
export const expiresAt = (ttl: number) => now() + ttl;
