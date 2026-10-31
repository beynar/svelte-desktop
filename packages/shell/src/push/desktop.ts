// Self-hosted push on macOS / Windows / Linux (desktop.config `push.server`): the push client
// lives in the app's server process, so the connection holds while the app runs (window
// closed included). Pages reach it through the `push:*` broadcast channel (host.push in
// notifications.ts); a message becomes a native notification + `pushMessage` everywhere.
import { join } from 'node:path';
import { callPlatform, deliverPlatformEvent, onPlatform } from '../platform/bus';
import { createPushClient, type PushPayload, type WebPushTarget } from './client.ts';

export const PUSH_CLIENT = Symbol.for('svelte-desktop.push.client');

export interface DesktopPushClient {
	register(): Promise<WebPushTarget>;
	target(): WebPushTarget | null;
	unregister(): Promise<void>;
}

const broadcast = (channel: string, data: unknown) => callPlatform('events', 'emit', { channel, data }).catch(() => {});

export function startDesktopPush(server: string, dataDir: string): DesktopPushClient {
	const g = globalThis as Record<symbol, DesktopPushClient | undefined>;
	if (g[PUSH_CLIENT]) return g[PUSH_CLIENT]!;

	const toMessage = (m: PushPayload) => {
		const msg: Record<string, unknown> = { data: m, foreground: false };
		if (m.id) msg.id = m.id;
		if (m.payload) msg.payload = m.payload;
		if (m.title) msg.notification = { title: m.title, body: m.body ?? '' };
		return msg;
	};

	const client = createPushClient({
		server,
		file: join(dataDir, 'push.json'),
		async onMessage(m) {
			if (m.title) {
				const args: Record<string, unknown> = { id: m.id ?? crypto.randomUUID(), title: m.title };
				for (const k of ['body', 'subtitle', 'image', 'silent', 'payload'] as const) if (m[k] !== undefined) args[k] = m[k];
				await callPlatform('notifications', 'show', args).catch((err) => console.error(`[push] could not show ${m.id}: ${(err as Error).message}`));
			}
			const msg = toMessage(m);
			deliverPlatformEvent('pushMessage', msg); // this process
			void broadcast('push:message', msg); // the pages
		},
		onTarget(t) {
			deliverPlatformEvent('pushToken', { provider: 'webpush', token: t.endpoint });
			void broadcast('push:token', t);
		},
	});

	const api: DesktopPushClient = {
		register: () => client.register(),
		target: () => client.target(),
		unregister: () => client.unregister(),
	};
	g[PUSH_CLIENT] = api;

	// Page requests: { op, nonce } → push:reply { nonce, ok, value | error }.
	onPlatform<{ channel: string; data: { op: string; nonce: string } }>('message', async (m) => {
		if (m?.channel !== 'push:request') return;
		const { op, nonce } = m.data ?? ({} as { op: string; nonce: string });
		try {
			const value = op === 'register' ? await api.register() : op === 'unregister' ? (await api.unregister(), null) : api.target();
			void broadcast('push:reply', { nonce, ok: true, value });
		} catch (err) {
			void broadcast('push:reply', { nonce, ok: false, error: (err as Error).message });
		}
	});
	// Registered before: reconnect now, without waiting for a page.
	client.start();
	return api;
}
