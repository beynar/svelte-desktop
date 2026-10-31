/**
 * A self-hosted Web Push service (RFC 8030 delivery, RFC 8292 VAPID) for svelte-desktop apps
 * on macOS, Windows and Linux: no Apple or Google account. Each device holds one WebSocket
 * to it; your app server sends with `createPush({ webpush })` to the endpoints it hands out,
 * exactly as to a browser's push service. Messages stay end-to-end encrypted (aes128gcm):
 * this server never sees their content.
 *
 *   import { servePush } from '@svelte-desktop/shell/push-server';
 *   servePush({ port: 8080, publicUrl: 'https://push.example.com', db: 'push.sqlite' });
 *
 * Or mount it in your own Bun.serve: `const push = createPushServer(opts)` then
 * `Bun.serve({ fetch: push.fetch, websocket: push.websocket })`.
 *
 * Routes: POST /v1/subscribe · GET|DELETE /v1/subscriptions/:id · POST /v1/push/:id ·
 * GET /v1/connect (WebSocket) · GET /v1/health. See native/NOTIFICATIONS.md.
 */
import { Database } from 'bun:sqlite';
import type { Server, ServerWebSocket } from 'bun';
import { b64url, fromB64url } from './server.ts';

export interface PushServerOptions {
	/** Public origin of this server (used in endpoints and as the VAPID audience). Default: the request's. */
	publicUrl?: string;
	/** SQLite file. Default ':memory:' (queued messages are lost on restart). */
	db?: string;
	/** Longest TTL honoured, seconds. Default 4 weeks. */
	maxTtl?: number;
	/** Largest message body, bytes (RFC 8030 asks for ≥ 4096). Default 8192. */
	maxBody?: number;
	/** Queued messages kept per subscription. Default 100 (oldest dropped). */
	maxQueue?: number;
}

interface Socket { device: string }

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

async function sha256(text: string): Promise<string> {
	return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function randomId(bytes = 16): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function bearer(req: Request, url: URL): string | null {
	const h = req.headers.get('authorization');
	if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
	return url.searchParams.get('secret');
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<public key>`, the key matching the subscription's. */
async function checkVapid(req: Request, expectedKey: string, audience: string): Promise<string | null> {
	const h = req.headers.get('authorization') ?? '';
	const m = /^vapid\s+(.+)$/i.exec(h);
	if (!m) return 'missing VAPID authorization';
	const params = Object.fromEntries(m[1].split(',').map((p) => p.trim().split('=').map((x) => x.trim())).map(([k, ...v]) => [k, v.join('=')]));
	const { t, k } = params as { t?: string; k?: string };
	if (!t || !k) return 'malformed VAPID authorization';
	if (b64url(fromB64url(k)) !== b64url(fromB64url(expectedKey))) return 'VAPID key does not match the subscription';
	const [h64, c64, s64] = t.split('.');
	if (!s64) return 'malformed VAPID token';
	try {
		const key = await crypto.subtle.importKey('raw', fromB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(s64), enc.encode(`${h64}.${c64}`));
		if (!ok) return 'bad VAPID signature';
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(c64))) as { aud?: string; exp?: number };
		if (claims.aud !== audience) return `VAPID audience must be ${audience}`;
		if (!claims.exp || claims.exp < now() || claims.exp > now() + 24 * 3600) return 'VAPID token expired or too long-lived';
	} catch {
		return 'invalid VAPID token';
	}
	return null;
}

export function createPushServer(opts: PushServerOptions = {}) {
	const db = new Database(opts.db ?? ':memory:', { create: true });
	db.exec(`PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, device TEXT NOT NULL, vapid TEXT, created INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS removed (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, subscription TEXT NOT NULL, device TEXT NOT NULL, topic TEXT,
			urgency TEXT, body BLOB NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS messages_device ON messages (device, created);`);
	const maxTtl = opts.maxTtl ?? 2419200;
	const maxBody = opts.maxBody ?? 8192;
	const maxQueue = opts.maxQueue ?? 100;
	const sockets = new Map<string, Set<ServerWebSocket<Socket>>>();

	const q = {
		sub: db.query<{ id: string; device: string; vapid: string | null }, [string]>('SELECT id, device, vapid FROM subscriptions WHERE id = ?'),
		insertSub: db.query('INSERT INTO subscriptions (id, device, vapid, created) VALUES (?, ?, ?, ?)'),
		deleteSub: db.query('DELETE FROM subscriptions WHERE id = ? AND device = ?'),
		removed: db.query<{ id: string }, [string]>('SELECT id FROM removed WHERE id = ?'),
		markRemoved: db.query('INSERT OR REPLACE INTO removed (id, at) VALUES (?, ?)'),
		replaceTopic: db.query('DELETE FROM messages WHERE subscription = ? AND topic = ?'),
		insertMsg: db.query('INSERT INTO messages (id, subscription, device, topic, urgency, body, expires, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
		trim: db.query('DELETE FROM messages WHERE subscription = ?1 AND id NOT IN (SELECT id FROM messages WHERE subscription = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)'),
		queued: db.query<{ id: string; subscription: string; topic: string | null; body: Uint8Array }, [string, number]>(
			'SELECT id, subscription, topic, body FROM messages WHERE device = ? AND expires >= ? ORDER BY created, rowid'),
		ack: db.query('DELETE FROM messages WHERE id = ? AND device = ?'),
		deleteMsg: db.query('DELETE FROM messages WHERE id = ?'),
		expire: db.query('DELETE FROM messages WHERE expires < ?'),
		deleteSubMsgs: db.query('DELETE FROM messages WHERE subscription = ?'),
	};

	const frame = (m: { id: string; subscription: string; topic: string | null; body: Uint8Array }) =>
		JSON.stringify({ type: 'message', id: m.id, subscription: m.subscription, topic: m.topic, body: Buffer.from(m.body).toString('base64') });

	const origin = (url: URL) => (opts.publicUrl ? new URL(opts.publicUrl).origin : url.origin);
	const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

	async function fetch(req: Request, server?: Server<Socket>): Promise<Response | undefined> {
		const url = new URL(req.url);
		const path = url.pathname;
		if (path === '/v1/health') return json({ ok: true });

		if (path === '/v1/connect') {
			const secret = bearer(req, url);
			if (!secret) return json({ error: 'device secret required' }, 401);
			const device = await sha256(secret);
			if (server?.upgrade(req, { data: { device } })) return undefined;
			return json({ error: 'WebSocket upgrade expected' }, 426);
		}

		if (path === '/v1/subscribe' && req.method === 'POST') {
			const secret = bearer(req, url);
			if (!secret || secret.length < 16) return json({ error: 'device secret required (≥ 16 chars)' }, 401);
			const body = (await req.json().catch(() => ({}))) as { applicationServerKey?: string };
			if (body.applicationServerKey && fromB64url(body.applicationServerKey).length !== 65)
				return json({ error: 'applicationServerKey must be an uncompressed P-256 point (base64url)' }, 400);
			const id = randomId();
			q.insertSub.run(id, await sha256(secret), body.applicationServerKey ?? null, now());
			return json({ id, endpoint: `${origin(url)}/v1/push/${id}` }, 201);
		}

		const unsub = /^\/v1\/subscriptions\/([\w-]+)$/.exec(path);
		if (unsub && req.method === 'GET') {
			const secret = bearer(req, url);
			if (!secret) return json({ error: 'device secret required' }, 401);
			const sub = q.sub.get(unsub[1]);
			return sub && sub.device === (await sha256(secret)) ? json({ id: sub.id }) : json({ error: 'no such subscription' }, 404);
		}
		if (unsub && req.method === 'DELETE') {
			const secret = bearer(req, url);
			if (!secret) return json({ error: 'device secret required' }, 401);
			const removed = q.deleteSub.run(unsub[1], await sha256(secret)).changes;
			if (!removed) return json({ error: 'no such subscription' }, 404);
			q.markRemoved.run(unsub[1], now());
			q.deleteSubMsgs.run(unsub[1]);
			return new Response(null, { status: 204 });
		}

		const push = /^\/v1\/push\/([\w-]+)$/.exec(path);
		if (push && req.method === 'POST') {
			const sub = q.sub.get(push[1]);
			if (!sub) return json({ error: 'subscription not found' }, q.removed.get(push[1]) ? 410 : 404);
			if (sub.vapid) {
				const err = await checkVapid(req, sub.vapid, origin(url));
				if (err) return json({ error: err }, 401);
			}
			const encoding = req.headers.get('content-encoding');
			const body = new Uint8Array(await req.arrayBuffer());
			if (body.length && encoding !== 'aes128gcm') return json({ error: 'Content-Encoding must be aes128gcm' }, 415);
			if (body.length > maxBody) return json({ error: `body larger than ${maxBody} bytes` }, 413);
			const ttl = Math.min(Math.max(Number(req.headers.get('ttl') ?? 0) || 0, 0), maxTtl);
			const topic = req.headers.get('topic');
			if (topic && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) return json({ error: 'Topic must be ≤ 32 base64url characters' }, 400);
			const id = randomId();
			const msg = { id, subscription: sub.id, topic, body };
			const live = sockets.get(sub.device);
			// A queued message with the same Topic is replaced: one notification per id.
			if (topic) q.replaceTopic.run(sub.id, topic);
			if (ttl === 0 && !live?.size) return new Response(null, { status: 201, headers: { location: `/v1/messages/${id}`, ttl: '0' } });
			q.insertMsg.run(id, sub.id, sub.device, topic, req.headers.get('urgency'), body, now() + Math.max(ttl, 30), now());
			q.trim.run(sub.id, maxQueue);
			for (const ws of live ?? []) ws.send(frame(msg));
			return new Response(null, { status: 201, headers: { location: `/v1/messages/${id}`, ttl: String(ttl) } });
		}
		if (/^\/v1\/messages\/[\w-]+$/.test(path) && req.method === 'DELETE') {
			q.deleteMsg.run(path.split('/').pop()!);
			return new Response(null, { status: 204 });
		}
		return json({ error: 'not found' }, 404);
	}

	const websocket = {
		idleTimeout: 120,
		sendPings: true,
		open(ws: ServerWebSocket<Socket>) {
			let set = sockets.get(ws.data.device);
			if (!set) sockets.set(ws.data.device, (set = new Set()));
			set.add(ws);
			q.expire.run(now());
			for (const m of q.queued.all(ws.data.device, now())) ws.send(frame(m));
		},
		message(ws: ServerWebSocket<Socket>, raw: string | Buffer) {
			try {
				const m = JSON.parse(String(raw)) as { type?: string; id?: string };
				if (m.type === 'ack' && m.id) q.ack.run(m.id, ws.data.device);
				if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
			} catch {}
		},
		close(ws: ServerWebSocket<Socket>) {
			sockets.get(ws.data.device)?.delete(ws);
		},
	};

	return {
		fetch: fetch as (req: Request, server: Server<Socket>) => Promise<Response | undefined>,
		websocket,
		/** Devices connected right now. */
		connected: () => [...sockets.values()].reduce((n, s) => n + s.size, 0),
		close: () => db.close(),
	};
}

/** Run the push service on its own port. */
export function servePush(opts: PushServerOptions & { port?: number; hostname?: string } = {}) {
	const push = createPushServer(opts);
	const server = Bun.serve<Socket>({
		port: opts.port ?? 8080,
		hostname: opts.hostname,
		fetch: (req, srv) => push.fetch(req, srv),
		websocket: push.websocket,
	});
	return Object.assign(server, { push });
}
