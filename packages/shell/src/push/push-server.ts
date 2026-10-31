/**
 * A self-hosted Web Push service (RFC 8030 delivery, RFC 8292 VAPID) for svelte-desktop apps
 * on macOS, Windows and Linux: no Apple or Google account. Each device holds one WebSocket
 * to it; your app server sends with `createPush({ webpush })` to the endpoints it hands out,
 * exactly as to a browser's push service. Messages stay end-to-end encrypted (aes128gcm):
 * this server never sees their content. The wire rules live in protocol.ts, shared with the
 * Cloudflare implementation (packages/push-worker); this file is storage + sockets.
 *
 *   import { servePush } from '@svelte-desktop/shell/push-server';
 *   servePush({ port: 8080, publicUrl: 'https://push.example.com', db: 'push.sqlite' });
 *
 * Or mount it in your own Bun.serve: `const push = createPushServer(opts)` then
 * `Bun.serve({ fetch: push.fetch, websocket: push.websocket })`.
 */
import { Database } from 'bun:sqlite';
import type { Server, ServerWebSocket } from 'bun';
import {
	checkVapid, deviceName, deviceSecret, expiresAt, isRefusal, MAX_QUEUE, messageFrame, now, parseDeviceFrame,
	parsePush, parseSubscribe, PONG, randomId, refuse, respond,
} from './protocol.ts';

export interface PushServerOptions {
	/** Public origin of this server (used in endpoints and as the VAPID audience). Default: the request's. */
	publicUrl?: string;
	/** SQLite file. Default ':memory:' (queued messages are lost on restart). */
	db?: string;
}

interface Socket { device: string }
type Queued = { id: string; subscription: string; topic: string | null; body: Uint8Array };

export function createPushServer(opts: PushServerOptions = {}) {
	const db = new Database(opts.db ?? ':memory:', { create: true });
	db.exec(`PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, device TEXT NOT NULL, vapid TEXT, created INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS removed (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, subscription TEXT NOT NULL,
			device TEXT NOT NULL, topic TEXT, urgency TEXT, body BLOB NOT NULL, expires INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS messages_device ON messages (device, seq);`);
	const sockets = new Map<string, Set<ServerWebSocket<Socket>>>();

	const q = {
		sub: db.query<{ id: string; device: string; vapid: string | null }, [string]>('SELECT id, device, vapid FROM subscriptions WHERE id = ?'),
		insertSub: db.query('INSERT INTO subscriptions (id, device, vapid, created) VALUES (?, ?, ?, ?)'),
		deleteSub: db.query('DELETE FROM subscriptions WHERE id = ? AND device = ?'),
		removed: db.query<{ id: string }, [string]>('SELECT id FROM removed WHERE id = ?'),
		markRemoved: db.query('INSERT OR REPLACE INTO removed (id, at) VALUES (?, ?)'),
		replaceTopic: db.query('DELETE FROM messages WHERE subscription = ? AND topic = ?'),
		insertMsg: db.query('INSERT INTO messages (id, subscription, device, topic, urgency, body, expires) VALUES (?, ?, ?, ?, ?, ?, ?)'),
		trim: db.query('DELETE FROM messages WHERE subscription = ?1 AND seq NOT IN (SELECT seq FROM messages WHERE subscription = ?1 ORDER BY seq DESC LIMIT ?2)'),
		queued: db.query<Queued, [string, number]>('SELECT id, subscription, topic, body FROM messages WHERE device = ? AND expires >= ? ORDER BY seq'),
		ack: db.query('DELETE FROM messages WHERE id = ? AND device = ?'),
		expire: db.query('DELETE FROM messages WHERE expires < ?'),
		deleteSubMsgs: db.query('DELETE FROM messages WHERE subscription = ?'),
	};

	const origin = (url: URL) => (opts.publicUrl ? new URL(opts.publicUrl).origin : url.origin);
	const json = (body: unknown, status = 200) => Response.json(body, { status });

	async function fetch(req: Request, server?: Server<Socket>): Promise<Response | undefined> {
		const url = new URL(req.url);
		const path = url.pathname;
		if (path === '/v1/health') return json({ ok: true });

		if (path === '/v1/connect') {
			const secret = deviceSecret(req);
			if (isRefusal(secret)) return respond(secret);
			if (server?.upgrade(req, { data: { device: await deviceName(secret) } })) return undefined;
			return respond(refuse(426, 'WebSocket upgrade expected'));
		}

		if (path === '/v1/subscribe' && req.method === 'POST') {
			const secret = deviceSecret(req);
			if (isRefusal(secret)) return respond(secret);
			const body = await parseSubscribe(req);
			if (isRefusal(body)) return respond(body);
			const id = randomId();
			q.insertSub.run(id, await deviceName(secret), body.vapid, now());
			return json({ id, endpoint: `${origin(url)}/v1/push/${id}` }, 201);
		}

		const sub = /^\/v1\/subscriptions\/([\w-]+)$/.exec(path);
		if (sub && (req.method === 'GET' || req.method === 'DELETE')) {
			const secret = deviceSecret(req);
			if (isRefusal(secret)) return respond(secret);
			const device = await deviceName(secret);
			if (q.sub.get(sub[1])?.device !== device) return respond(refuse(404, 'no such subscription'));
			if (req.method === 'GET') return json({ id: sub[1] });
			q.deleteSub.run(sub[1], device);
			q.markRemoved.run(sub[1], now());
			q.deleteSubMsgs.run(sub[1]);
			return new Response(null, { status: 204 });
		}

		const push = /^\/v1\/push\/([\w-]+)$/.exec(path);
		if (push && req.method === 'POST') {
			const s = q.sub.get(push[1]);
			if (!s) return respond(refuse(q.removed.get(push[1]) ? 410 : 404, 'subscription not found'));
			// Authorization before the body is read.
			const denied = s.vapid ? await checkVapid(req.headers.get('authorization'), s.vapid, origin(url)) : null;
			if (denied) return respond(denied);
			const msg = await parsePush(req);
			if (isRefusal(msg)) return respond(msg);
			const id = randomId();
			const live = sockets.get(s.device) ?? new Set();
			// Same Topic replaces the queued one: one notification per id.
			if (msg.topic) q.replaceTopic.run(s.id, msg.topic);
			const frame = messageFrame({ id, subscription: s.id, topic: msg.topic, body: msg.body });
			// TTL 0: delivered now to a connected device, never stored (RFC 8030 §5.2).
			if (msg.ttl > 0) {
				q.insertMsg.run(id, s.id, s.device, msg.topic, msg.urgency, msg.body, expiresAt(msg.ttl));
				q.trim.run(s.id, MAX_QUEUE);
			}
			for (const ws of live) ws.send(frame);
			return new Response(null, { status: 201, headers: { location: `/v1/messages/${id}`, ttl: String(msg.ttl) } });
		}
		return respond(refuse(404, 'not found'));
	}

	const websocket = {
		idleTimeout: 120,
		sendPings: true,
		open(ws: ServerWebSocket<Socket>) {
			let set = sockets.get(ws.data.device);
			if (!set) sockets.set(ws.data.device, (set = new Set()));
			set.add(ws);
			q.expire.run(now());
			for (const m of q.queued.all(ws.data.device, now())) ws.send(messageFrame(m));
		},
		message(ws: ServerWebSocket<Socket>, raw: string | Buffer) {
			const m = parseDeviceFrame(typeof raw === 'string' ? raw : new Uint8Array(raw));
			if (m?.type === 'ack') q.ack.run(m.id, ws.data.device);
			else if (m?.type === 'ping') ws.send(PONG);
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
