/**
 * Self-hosted push for svelte-desktop apps on Cloudflare: a Web Push service (RFC 8030
 * delivery, RFC 8292 VAPID) built on Workers + Durable Objects — the FCM/APNs role for
 * macOS, Windows and Linux, with no Apple or Google account. Same HTTP contract as
 * `@svelte-desktop/shell/push-server` (native/NOTIFICATIONS.md), so the desktop client and
 * `createPush({ webpush })` work against it unchanged.
 *
 * - The Worker is stateless: it authenticates, validates and routes.
 * - One `Device` Durable Object per device (named by sha256(device secret)): its
 *   subscriptions, its queue (SQLite), its WebSocket — accepted with the Hibernation API, so
 *   an idle connected device costs nothing — and an alarm that drops expired messages.
 * - Messages are end-to-end encrypted (aes128gcm) for the device's key: never readable here.
 *
 * Routes: POST /v1/subscribe · GET|DELETE /v1/subscriptions/:id · POST /v1/push/:device/:id ·
 * GET /v1/connect (WebSocket) · GET /v1/health
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
	DEVICE: DurableObjectNamespace<Device>;
}

const MAX_TTL = 2419200; // 4 weeks
const MAX_BODY = 8192;
const MAX_QUEUE = 100;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

// ── encoding ────────────────────────────────────────────────────────

function b64url(bytes: ArrayBuffer | Uint8Array): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = '';
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
	const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
	return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function b64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

async function deviceName(secret: string): Promise<string> {
	return b64url(await crypto.subtle.digest('SHA-256', enc.encode(secret)));
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function secretOf(req: Request, url: URL): string | null {
	const h = req.headers.get('authorization');
	if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
	return url.searchParams.get('secret');
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<key>`, the key locked to the subscription. */
async function checkVapid(header: string | null, expectedKey: string, audience: string): Promise<string | null> {
	const m = /^vapid\s+(.+)$/i.exec(header ?? '');
	if (!m) return 'missing VAPID authorization';
	const params: Record<string, string> = {};
	for (const part of m[1].split(',')) {
		const [k, ...v] = part.trim().split('=');
		params[k.trim()] = v.join('=').trim();
	}
	const { t, k } = params;
	if (!t || !k) return 'malformed VAPID authorization';
	if (b64url(fromB64url(k)) !== b64url(fromB64url(expectedKey))) return 'VAPID key does not match the subscription';
	const [h64, c64, s64] = t.split('.');
	if (!s64) return 'malformed VAPID token';
	try {
		const key = await crypto.subtle.importKey('raw', fromB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(s64), enc.encode(`${h64}.${c64}`)))) return 'bad VAPID signature';
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(c64))) as { aud?: string; exp?: number };
		if (claims.aud !== audience) return `VAPID audience must be ${audience}`;
		if (!claims.exp || claims.exp < now() || claims.exp > now() + 24 * 3600) return 'VAPID token expired or too long-lived';
	} catch {
		return 'invalid VAPID token';
	}
	return null;
}

// ── the device ──────────────────────────────────────────────────────

interface PushInput {
	subscription: string;
	topic: string | null;
	ttl: number;
	urgency: string | null;
	body: ArrayBuffer;
	authorization: string | null;
	audience: string;
}

type Row = { id: string; subscription: string; topic: string | null; body: ArrayBuffer };

export class Device extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, vapid TEXT, created INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS removed (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
					subscription TEXT NOT NULL, topic TEXT, urgency TEXT, body BLOB NOT NULL, expires INTEGER NOT NULL);`);
		});
		// Keep-alive pings are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
	}

	subscribe(vapid: string | null): string {
		const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
		this.ctx.storage.sql.exec('INSERT INTO subscriptions (id, vapid, created) VALUES (?, ?, ?)', id, vapid, now());
		return id;
	}

	has(id: string): boolean {
		return this.ctx.storage.sql.exec('SELECT id FROM subscriptions WHERE id = ?', id).toArray().length > 0;
	}

	unsubscribe(id: string): boolean {
		const removed = this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE id = ?', id).rowsWritten;
		if (!removed) return false;
		this.ctx.storage.sql.exec('INSERT OR REPLACE INTO removed (id, at) VALUES (?, ?)', id, now());
		this.ctx.storage.sql.exec('DELETE FROM messages WHERE subscription = ?', id);
		return true;
	}

	async push(input: PushInput): Promise<{ status: number; id?: string; error?: string }> {
		const sql = this.ctx.storage.sql;
		const sub = sql.exec<{ vapid: string | null }>('SELECT vapid FROM subscriptions WHERE id = ?', input.subscription).toArray()[0];
		if (!sub) {
			const gone = sql.exec('SELECT id FROM removed WHERE id = ?', input.subscription).toArray().length > 0;
			return { status: gone ? 410 : 404, error: 'subscription not found' };
		}
		if (sub.vapid) {
			const err = await checkVapid(input.authorization, sub.vapid, input.audience);
			if (err) return { status: 401, error: err };
		}
		const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
		const sockets = this.ctx.getWebSockets();
		// Same Topic = replaces the queued one: one notification per id.
		if (input.topic) sql.exec('DELETE FROM messages WHERE subscription = ? AND topic = ?', input.subscription, input.topic);
		// TTL 0: now or never (RFC 8030).
		if (input.ttl === 0 && sockets.length === 0) return { status: 201, id };
		const expires = now() + Math.max(input.ttl, 30);
		sql.exec(
			'INSERT INTO messages (id, subscription, topic, urgency, body, expires) VALUES (?, ?, ?, ?, ?, ?)',
			id, input.subscription, input.topic, input.urgency, input.body, expires,
		);
		sql.exec(
			'DELETE FROM messages WHERE subscription = ?1 AND seq NOT IN (SELECT seq FROM messages WHERE subscription = ?1 ORDER BY seq DESC LIMIT ?2)',
			input.subscription, MAX_QUEUE,
		);
		const frame = this.frame({ id, subscription: input.subscription, topic: input.topic, body: input.body });
		for (const ws of sockets) {
			try {
				ws.send(frame);
			} catch {}
		}
		await this.scheduleExpiry();
		return { status: 201, id };
	}

	/** The device connects (the Worker forwards the upgrade request here). */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade expected' }, 426);
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		this.drop();
		for (const m of this.ctx.storage.sql.exec<Row>('SELECT id, subscription, topic, body FROM messages ORDER BY seq').toArray()) pair[1].send(this.frame(m));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const m = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as { type?: string; id?: string };
			if (m.type === 'ack' && m.id) this.ctx.storage.sql.exec('DELETE FROM messages WHERE id = ?', m.id);
			else if (m.type === 'ping') ws.send('{"type":"pong"}');
		} catch {}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
	}

	async alarm() {
		this.drop();
		await this.scheduleExpiry();
	}

	/** Connected sockets, for the health route and tests. */
	connected(): number {
		return this.ctx.getWebSockets().length;
	}

	private frame(m: Row): string {
		return JSON.stringify({ type: 'message', id: m.id, subscription: m.subscription, topic: m.topic, body: b64(new Uint8Array(m.body)) });
	}

	private drop() {
		this.ctx.storage.sql.exec('DELETE FROM messages WHERE expires < ?', now());
	}

	private async scheduleExpiry() {
		const next = this.ctx.storage.sql.exec<{ e: number | null }>('SELECT MIN(expires) AS e FROM messages').one().e;
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm((next + 1) * 1000);
	}
}

// ── the Worker ──────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const device = async () => {
			const secret = secretOf(request, url);
			return secret && secret.length >= 16 ? env.DEVICE.getByName(await deviceName(secret)) : null;
		};

		if (path === '/v1/health') return json({ ok: true });

		if (path === '/v1/connect') {
			const stub = await device();
			if (!stub) return json({ error: 'device secret required' }, 401);
			return stub.fetch(request);
		}

		if (path === '/v1/subscribe' && request.method === 'POST') {
			const secret = secretOf(request, url);
			if (!secret || secret.length < 16) return json({ error: 'device secret required (≥ 16 chars)' }, 401);
			const body = (await request.json().catch(() => ({}))) as { applicationServerKey?: string };
			if (body.applicationServerKey && fromB64url(body.applicationServerKey).length !== 65)
				return json({ error: 'applicationServerKey must be an uncompressed P-256 point (base64url)' }, 400);
			const name = await deviceName(secret);
			const id = await env.DEVICE.getByName(name).subscribe(body.applicationServerKey ?? null);
			return json({ id, endpoint: `${url.origin}/v1/push/${name}/${id}` }, 201);
		}

		const unsub = /^\/v1\/subscriptions\/([\w-]+)$/.exec(path);
		if (unsub && request.method === 'GET') {
			const stub = await device();
			if (!stub) return json({ error: 'device secret required' }, 401);
			return (await stub.has(unsub[1])) ? json({ id: unsub[1] }) : json({ error: 'no such subscription' }, 404);
		}
		if (unsub && request.method === 'DELETE') {
			const stub = await device();
			if (!stub) return json({ error: 'device secret required' }, 401);
			return (await stub.unsubscribe(unsub[1])) ? new Response(null, { status: 204 }) : json({ error: 'no such subscription' }, 404);
		}

		const push = /^\/v1\/push\/([\w-]{43})\/([\w-]+)$/.exec(path);
		if (push && request.method === 'POST') {
			const body = await request.arrayBuffer();
			if (body.byteLength && request.headers.get('content-encoding') !== 'aes128gcm') return json({ error: 'Content-Encoding must be aes128gcm' }, 415);
			if (body.byteLength > MAX_BODY) return json({ error: `body larger than ${MAX_BODY} bytes` }, 413);
			const topic = request.headers.get('topic');
			if (topic && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) return json({ error: 'Topic must be ≤ 32 base64url characters' }, 400);
			const ttl = Math.min(Math.max(Number(request.headers.get('ttl') ?? 0) || 0, 0), MAX_TTL);
			const r = await env.DEVICE.getByName(push[1]).push({
				subscription: push[2], topic, ttl, urgency: request.headers.get('urgency'), body,
				authorization: request.headers.get('authorization'), audience: url.origin,
			});
			if (r.status !== 201) return json({ error: r.error }, r.status);
			return new Response(null, { status: 201, headers: { location: `/v1/messages/${r.id}`, ttl: String(ttl) } });
		}

		return json({ error: 'not found' }, 404);
	},
} satisfies ExportedHandler<Env>;
