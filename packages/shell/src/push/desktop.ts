// Self-hosted push on macOS / Windows / Linux (desktop.config `push.server`): the push client
// lives in the app's server process, so the connection holds while the app runs. Pages reach it
// over the broadcast channel (desktop-channel.ts); a message is shown through the same
// notifications.show as a local one (images, payload, dedupe) and relayed as `pushMessage`.
import { join } from 'node:path';
import { callPlatform, deliverPlatformEvent, NativeApiError, onPlatform } from '../platform/bus';
import { notifications } from '../platform/notifications';
import { createPushClient } from './client.ts';
import {
	CHANNEL, isDesktopPushOp, PUSH_CLIENT, type DesktopPushClient, type DesktopPushOps, type DesktopPushReply, type RelayedPushMessage,
} from './desktop-channel.ts';
import type { WirePushMessage } from './protocol.ts';

const broadcast = (channel: string, data: unknown) => callPlatform('events', 'emit', { channel, data }).catch(() => {});

function payloadOf(m: WirePushMessage): { url?: string; data?: unknown } {
	try {
		const p = m.payload ? (JSON.parse(m.payload) as { url?: unknown; data?: unknown }) : {};
		return { ...(typeof p.url === 'string' && { url: p.url }), ...(p.data !== undefined && { data: p.data }) };
	} catch {
		return {};
	}
}

async function present(m: WirePushMessage) {
	if (m.title) {
		try {
			await notifications.show({ id: m.id, title: m.title, body: m.body, subtitle: m.subtitle, image: m.image, silent: m.silent, ...payloadOf(m) });
		} catch (err) {
			// The native layer refused it (no bundle, permission…): retrying won't help.
			if (!(err instanceof NativeApiError)) throw err;
			console.error(`[push] not shown (${err.code}): ${err.message}`);
		}
	}
	const msg: RelayedPushMessage = {
		data: m,
		foreground: await callPlatform<boolean>('window', 'isFocused').catch(() => false),
		...(m.id && { id: m.id }),
		...(m.payload && { payload: m.payload }),
		...(m.title && { notification: { title: m.title, body: m.body ?? '' } }),
	};
	deliverPlatformEvent('pushMessage', msg); // this process
	void broadcast(CHANNEL.message, msg); // the pages
}

export function startDesktopPush(server: string, dataDir: string): DesktopPushClient {
	const g = globalThis as Record<symbol, DesktopPushClient | undefined>;
	if (g[PUSH_CLIENT]) return g[PUSH_CLIENT]!;

	const client = createPushClient({
		server,
		file: join(dataDir, 'push.json'),
		onMessage: present,
		onTarget(t) {
			deliverPlatformEvent('pushToken', t);
			void broadcast(CHANNEL.target, t);
		},
	});
	const api: DesktopPushClient = {
		run: async (op) => {
			const result = op === 'register' ? await client.register() : op === 'unregister' ? (await client.unregister(), null) : client.target();
			return result as DesktopPushOps[typeof op];
		},
	};
	g[PUSH_CLIENT] = api;

	onPlatform<{ channel: string; data: unknown }>('message', async (m) => {
		if (m?.channel !== CHANNEL.request) return;
		const { op, nonce } = (m.data ?? {}) as { op?: unknown; nonce?: unknown };
		if (typeof nonce !== 'string') return;
		let reply: DesktopPushReply;
		if (!isDesktopPushOp(op)) reply = { nonce, ok: false, error: `unknown op ${String(op)}` };
		else {
			try {
				reply = { nonce, ok: true, value: await api.run(op) };
			} catch (err) {
				reply = { nonce, ok: false, error: (err as Error).message };
			}
		}
		void broadcast(CHANNEL.reply, reply);
	});
	client.start(); // registered before: reconnect now, without waiting for a page
	return api;
}
