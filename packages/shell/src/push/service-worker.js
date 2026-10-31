// Web Push + notification clicks for svelte-desktop apps opened in a browser.
// Served at /__desktop/push-sw.js, registered with scope /__desktop/push/ so it never
// competes with the app's own service worker (it controls no page; it only receives
// pushes and notification events). Talks to pages with postMessage (`__sd` messages).
/* eslint-env serviceworker */

const unclaimed = []; // responses for a tab we opened, until it asks (`claim`)

const parse = (text) => {
	try {
		return typeof text === 'string' && text ? JSON.parse(text) : {};
	} catch {
		return {};
	}
};

const windows = () => self.clients.matchAll({ type: 'window', includeUncontrolled: true });

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
	if (e.data?.__sd !== 'claim' || !e.source) return;
	for (const m of unclaimed.splice(0)) e.source.postMessage(m);
});

// Payload: { id, title, body, subtitle, icon, image, badge, silent, renotify, requireInteraction, payload }
self.addEventListener('push', (e) => {
	const m = e.data ? (() => { try { return e.data.json(); } catch { return { body: e.data.text() }; } })() : {};
	e.waitUntil(
		(async () => {
			const clients = await windows();
			const foreground = clients.some((c) => c.visibilityState === 'visible' && c.focused);
			const message = { id: m.id, data: m, payload: m.payload, foreground };
			if (m.title) message.notification = { title: m.title, body: m.body ?? '' };
			for (const c of clients) c.postMessage({ __sd: 'pushMessage', message });
			// userVisibleOnly: every push shows a notification.
			await self.registration.showNotification(m.title ?? self.registration.scope, {
				tag: m.id,
				body: m.subtitle ? `${m.subtitle}\n${m.body ?? ''}` : m.body,
				icon: m.icon,
				image: m.image,
				badge: m.badge,
				silent: !!m.silent,
				renotify: !!m.id && m.renotify !== false,
				requireInteraction: !!m.requireInteraction,
				data: { id: m.id, payload: m.payload },
			});
		})(),
	);
});

async function respond(notification, response) {
	const p = parse(notification.data?.payload);
	const url = response.kind === 'dismiss' ? null : (response.actionId && p.actions?.[response.actionId]) || p.url;
	const clients = await windows();
	const client = clients.find((c) => c.focused) ?? clients.find((c) => c.visibilityState === 'visible') ?? clients[0];
	if (client) {
		if (response.kind !== 'dismiss') await client.focus().catch(() => {});
		client.postMessage({ __sd: 'notificationResponse', response });
		return;
	}
	if (response.kind === 'dismiss') return;
	// No tab: open one at the url (already navigated) and keep the event for it.
	const opened = await self.clients.openWindow(url ? new URL(url, self.location.origin).href : '/');
	unclaimed.push({ __sd: 'notificationResponse', response, navigated: !!url });
	if (opened) {
		// Give the tab a moment to start and claim it.
		await new Promise((r) => setTimeout(r, 10000));
	}
}

self.addEventListener('notificationclick', (e) => {
	const n = e.notification;
	const actionId = e.action || null;
	const response = { id: n.tag || n.data?.id || '', kind: actionId ? (e.reply != null ? 'reply' : 'action') : 'click', actionId, payload: n.data?.payload };
	if (e.reply != null) response.input = e.reply;
	n.close();
	e.waitUntil(respond(n, response));
});

self.addEventListener('notificationclose', (e) => {
	const n = e.notification;
	e.waitUntil(respond(n, { id: n.tag || n.data?.id || '', kind: 'dismiss', actionId: null, payload: n.data?.payload }));
});
