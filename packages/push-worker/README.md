# @svelte-desktop/push-worker

Your own push service on Cloudflare — the FCM/APNs role for svelte-desktop apps on macOS,
Windows and Linux, with no Apple or Google account. Web Push compatible (RFC 8030 delivery,
RFC 8291 encryption, RFC 8292 VAPID): messages stay end-to-end encrypted for each device.

```sh
bunx wrangler deploy        # → https://svelte-desktop-push.<you>.workers.dev
```

```ts
// desktop.config.ts
push: { server: 'https://svelte-desktop-push.<you>.workers.dev' }

// in the app (page or server code)
const target = await host.push.register()   // { provider: 'webpush', endpoint, keys } → your backend

// your backend
import { createPush } from '@svelte-desktop/shell/push';
const push = createPush({ webpush: { publicKey, privateKey, subject: 'mailto:ops@example.com' } });
await push.send(target, { id: 'msg-42', title: 'Alice', body: 'Lunch?', url: '/chat/42' });
```

How it maps to Cloudflare:

- **Worker** (stateless): authenticates the device (bearer secret), validates Web Push
  requests (aes128gcm, size, TTL, Topic) and routes them.
- **`Device` Durable Object**, one per device (`getByName(sha256(secret))`): its
  subscriptions and queue in SQLite, its WebSocket accepted with the **Hibernation API** (an
  idle connected device costs no duration; keep-alive pings get an auto-response without waking
  it), and an **alarm** that drops TTL-expired messages.
- Same `Topic` → the queued message is replaced (one notification per `id`); `TTL: 0` →
  delivered only if the device is connected; VAPID-locked subscriptions reject other senders;
  unsubscribed endpoints answer 410 (`expired` for `createPush`).

The same contract is implemented by `@svelte-desktop/shell/push-server` (Bun + SQLite) for
self-hosting anywhere else; `test/worker.test.ts` runs the shell's client and sender against
this Worker in workerd (`bun run test`). Contract: `packages/shell/native/NOTIFICATIONS.md`.
