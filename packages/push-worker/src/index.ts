/**
 * Self-hosted push for svelte-desktop apps on Cloudflare: a Web Push service (RFC 8030 delivery,
 * RFC 8292 VAPID) on Workers + Durable Objects — the FCM/APNs role for macOS, Windows and Linux,
 * with no Apple or Google account. The wire rules come from @svelte-desktop/shell/push-protocol,
 * shared with the Bun implementation (push-server.ts); this file is routing, storage and sockets.
 *
 * - The Worker is stateless: it authenticates, validates and routes.
 * - One `Device` Durable Object per device (named by sha256(device secret)): its subscriptions,
 *   its queue (SQLite), its WebSocket — accepted with the Hibernation API, so an idle connected
 *   device costs nothing — and an alarm that drops expired messages.
 * - Messages are end-to-end encrypted (aes128gcm) for the device's key: never readable here.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	checkVapid, deviceName, deviceSecret, expiresAt, isRefusal, MAX_QUEUE, messageFrame, now, parseDeviceFrame, parsePush,
	parseSubscribe, PING, PONG, randomId, refuse, respond, type PushRequest, type Refusal,
} from '@svelte-desktop/shell/push-protocol';

export interface Env {
	DEVICE: DurableObjectNamespace<Device>;
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
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	subscribe(vapid: string | null): string {
		const id = randomId();
		this.ctx.storage.sql.exec('INSERT INTO subscriptions (id, vapid, created) VALUES (?, ?, ?)', id, vapid, now());
		return id;
	}

	has(id: string): boolean {
		return this.ctx.storage.sql.exec('SELECT id FROM subscriptions WHERE id = ?', id).toArray().length > 0;
	}

	unsubscribe(id: string): boolean {
		if (!this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE id = ?', id).rowsWritten) return false;
		this.ctx.storage.sql.exec('INSERT OR REPLACE INTO removed (id, at) VALUES (?, ?)', id, now());
		this.ctx.storage.sql.exec('DELETE FROM messages WHERE subscription = ?', id);
		return true;
	}

	/** The subscription's VAPID key, or a refusal (404 unknown, 410 removed). */
	lookup(id: string): { vapid: string | null } | Refusal {
		const sub = this.ctx.storage.sql.exec<{ vapid: string | null }>('SELECT vapid FROM subscriptions WHERE id = ?', id).toArray()[0];
		if (sub) return sub;
		const gone = this.ctx.storage.sql.exec('SELECT id FROM removed WHERE id = ?', id).toArray().length > 0;
		return refuse(gone ? 410 : 404, 'subscription not found');
	}

	async push(subscription: string, msg: PushRequest): Promise<string> {
		const sql = this.ctx.storage.sql;
		const id = randomId();
		// Same Topic replaces the queued one: one notification per id.
		if (msg.topic) sql.exec('DELETE FROM messages WHERE subscription = ? AND topic = ?', subscription, msg.topic);
		// TTL 0: delivered now to a connected device, never stored (RFC 8030 §5.2).
		if (msg.ttl > 0) {
			sql.exec('INSERT INTO messages (id, subscription, topic, urgency, body, expires) VALUES (?, ?, ?, ?, ?, ?)',
				id, subscription, msg.topic, msg.urgency, msg.body, expiresAt(msg.ttl));
			sql.exec('DELETE FROM messages WHERE subscription = ?1 AND seq NOT IN (SELECT seq FROM messages WHERE subscription = ?1 ORDER BY seq DESC LIMIT ?2)',
				subscription, MAX_QUEUE);
			await this.scheduleExpiry();
		}
		const frame = messageFrame({ id, subscription, topic: msg.topic, body: msg.body });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(frame);
			} catch {}
		}
		return id;
	}

	/** The device connects (the Worker forwards the upgrade request here). */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return respond(refuse(426, 'WebSocket upgrade expected'));
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		this.ctx.storage.sql.exec('DELETE FROM messages WHERE expires < ?', now());
		for (const m of this.ctx.storage.sql.exec<Row>('SELECT id, subscription, topic, body FROM messages ORDER BY seq').toArray()) pair[1].send(messageFrame(m));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const m = parseDeviceFrame(message);
		if (m?.type === 'ack') this.ctx.storage.sql.exec('DELETE FROM messages WHERE id = ?', m.id);
		else if (m?.type === 'ping') ws.send(PONG);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
	}

	async alarm() {
		this.ctx.storage.sql.exec('DELETE FROM messages WHERE expires < ?', now());
		await this.scheduleExpiry();
	}

	private async scheduleExpiry() {
		const next = this.ctx.storage.sql.exec<{ e: number | null }>('SELECT MIN(expires) AS e FROM messages').one().e;
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm((next + 1) * 1000);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const json = (body: unknown, status = 200) => Response.json(body, { status });
		const device = async () => {
			const secret = deviceSecret(request);
			return isRefusal(secret) ? secret : { name: await deviceName(secret) };
		};

		if (path === '/v1/health') return json({ ok: true });

		if (path === '/v1/connect') {
			const d = await device();
			return isRefusal(d) ? respond(d) : env.DEVICE.getByName(d.name).fetch(request);
		}

		if (path === '/v1/subscribe' && request.method === 'POST') {
			const d = await device();
			if (isRefusal(d)) return respond(d);
			const body = await parseSubscribe(request);
			if (isRefusal(body)) return respond(body);
			const id = await env.DEVICE.getByName(d.name).subscribe(body.vapid);
			return json({ id, endpoint: `${url.origin}/v1/push/${d.name}/${id}` }, 201);
		}

		const sub = /^\/v1\/subscriptions\/([\w-]+)$/.exec(path);
		if (sub && (request.method === 'GET' || request.method === 'DELETE')) {
			const d = await device();
			if (isRefusal(d)) return respond(d);
			const stub = env.DEVICE.getByName(d.name);
			if (request.method === 'GET') return (await stub.has(sub[1])) ? json({ id: sub[1] }) : respond(refuse(404, 'no such subscription'));
			return (await stub.unsubscribe(sub[1])) ? new Response(null, { status: 204 }) : respond(refuse(404, 'no such subscription'));
		}

		const push = /^\/v1\/push\/([\w-]{43})\/([\w-]+)$/.exec(path);
		if (push && request.method === 'POST') {
			const stub = env.DEVICE.getByName(push[1]);
			// Subscription and authorization before the body is read.
			const found = await stub.lookup(push[2]);
			if (isRefusal(found)) return respond(found);
			const denied = found.vapid ? await checkVapid(request.headers.get('authorization'), found.vapid, url.origin) : null;
			if (denied) return respond(denied);
			const msg = await parsePush(request);
			if (isRefusal(msg)) return respond(msg);
			const id = await stub.push(push[2], msg);
			return new Response(null, { status: 201, headers: { location: `/v1/messages/${id}`, ttl: String(msg.ttl) } });
		}

		return respond(refuse(404, 'not found'));
	},
} satisfies ExportedHandler<Env>;
