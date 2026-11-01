# Notifications and push: the native contract

Every backend (macOS, Linux, Windows) implements the same ops and
events, so that `host.notifications` / `host.push` (src/platform) behave the same
everywhere. The TypeScript layer does the rest: id generation, deep-link
navigation, `replace: false`, image download, browser fallback.

Error codes are the usual ones: `invalid_args`, `unsupported` (the platform has no
such thing), `unavailable` (missing at run time: no bundle id, no libnotify…), `denied` (permission), `internal`.

## Conformance

`native/notifications.fixtures.json` lists valid and invalid `show` arguments with the expected
outcome. Every backend's e2e suite replays it through the platform op (macOS `tests/app.test.ts`,
Windows `tests/windows.test.ts`, Linux `test/platform/linux-notifications-fake.ts`): a backend that drifts from the contract fails there.
Add a case there when the contract changes.

## The payload

TypeScript passes `payload`, an opaque JSON **string** (`{url, data, actions}`), on
`show`. A backend never parses it: it stores it with the notification
(userInfo, toast arguments, a map) and hands it back verbatim in
responses and in `delivered` / `pending`. Push messages carry it too (key `sd`,
see below).

## Ops — service `notifications`

### `show` (alias `notify`)

```jsonc
{
  "id": "msg-42",          // always present (TS generates one). Dedupe key: a delivered OR pending
                           // notification with this id is replaced, never duplicated.
  "title": "Alice",        // required
  "body": "Lunch?",
  "subtitle": "#general",  // Apple subtitle · Windows/Linux: second line or ignored
  "group": "chat-general", // thread / group: Apple threadIdentifier · Windows toast Group
  "image": "/abs/path.png",// a local path, a file:// URL or a data: URL (base64; TS turns http(s) and app-relative
                           // URLs into data: URLs). Backends decode data: URLs into a cache file. Apple attachment ·
                           // Windows hero image · Linux "image-path" hint
  "icon": "/abs/icon.png", // same forms; large icon / app logo override (Windows, Linux); Apple ignores it
  "sound": "default",      // "default" | a sound name/file; ignored when silent
  "silent": false,         // no sound
  "renotify": true,        // replacing an existing id alerts again (false: Linux transient update,
                           // Windows SuppressPopup)
  "badge": 3,              // Apple content.badge · else ignored
  "urgency": "normal",     // "low" | "normal" | "critical": Apple interruptionLevel passive/active/timeSensitive ·
                           // Linux urgency hint · Windows scenario (critical = urgent)
  "requireInteraction": false, // stays until the user acts: Linux expire 0 · Windows scenario reminder ·
                               // Apple: ignored (user setting)
  "timestamp": 1730000000000,  // shown time (Windows displayTimestamp)
  "actions": [
    { "id": "reply", "title": "Reply", "input": { "placeholder": "Message", "button": "Send" } },
    { "id": "done", "title": "Done", "destructive": true, "foreground": false }
  ],                       // input: text field (Apple UNTextInputNotificationAction ·
                           // Windows toast input · Linux: unsupported → plain action). foreground (default
                           // true): activating it brings the app to front.
  "foreground": true,      // show it as a banner while the app is frontmost (Apple willPresent)
  "at": 1730000000000,     // epoch ms: schedule it. Absent = now.
  "repeat": "day",         // with `at`: "minute"|"hour"|"day"|"week"|"month"|"year"
  "payload": "{\"url\":\"/chat/general\"}",
  "ongoing": false,        // stays put (Linux "resident" hint · Windows scenario reminder · Apple: ignored)
  "autoCancel": true,      // removed when clicked (default true; false: Linux "resident" ·
                           // Windows: kept in Action Center · Apple: ignored)
  "closeButtonText": "Later", // a dismiss button with this label (Windows toast action activationType=system ·
                              // Linux: an action that closes it · Apple: ignored)
  "toastXml": "<toast>…</toast>" // Windows only: the raw toast XML, used as is (like Electron's toastXml)
}
```
→ `{ "id": "msg-42", "scheduled": false }`

Limits, by platform (refused or documented rather than silently wrong):
- Apple: a calendar repeat has no start date — a repeating schedule whose next calendar match
  comes before `at` is refused (`invalid_args`); start it within one period of `at`.
- Windows: the OS can't repeat a toast, so a series hands it its next 30 days of occurrences (at
  most 128: a minute repeat covers ~2 h, an hour repeat ~5 days, day and longer 30 days) and tops
  them up while the app runs and at startup.
- Scheduling an id that is shown replaces the shown one (every backend).

Scheduling must survive the app quitting where the OS can (Apple UN triggers,
Windows ScheduledToastNotification). Linux
has no OS scheduler: keep a timer while the app runs and persist the queue
(`<data dir>/scheduled-notifications.json`), re-arming it at startup and
delivering missed ones (`at` in the past) immediately.

### `dismiss` (alias `close`) `{ id }` → `null`
Removes the delivered notification and cancels the pending one with that id. Also
accepts `{ tag }` (legacy).

### `dismissAll` `{}` → `null`
Every delivered and pending notification of the app.

### `delivered` `{}` → `[{ id, title, body, subtitle?, group?, payload?, date? }]`
Notifications currently shown (in the notification center). `date` epoch ms.
Platforms that can't enumerate the shade return the ones this process showed
and that weren't closed.

### `pending` `{}` → `[{ id, title, body, at, repeat?, payload? }]`
Scheduled, not yet delivered.

### `claim` `{}` → `[response…]`
Responses (see the event) that no page has handled yet — a click that launched
the app, a click while no window was loaded. Returns them once, then forgets
them. Called by a page when it starts.

### `responses` `{}` → `[response…]`
Every response since launch (bounded ring, 64). The Worker replays them at start
so a click that launched the app also reaches server code.

### `setBadge` `{ count: number | null }` → `null`
App icon badge: macOS Dock tile · Linux Unity LauncherEntry
(D-Bus `com.canonical.Unity.LauncherEntry`, KDE/Ubuntu docks) · Windows taskbar
overlay icon.
`null` or `0` clears it.

### `setForeground` `{ show: boolean }` → `null`
Default for notifications without `foreground` and for pushes: banner or nothing
while the app is frontmost (Apple). Others: no-op ok.

### `getPermissionStatus` / `requestPermission` → `{ status }`
`granted` | `denied` | `notDetermined` | `unavailable`. Same as
`system.checkPermission('notifications')`.

## Event `notificationResponse`

```jsonc
{
  "seq": 7,            // monotonic per launch
  "id": "msg-42",
  "tag": "msg-42",     // = id (legacy)
  "kind": "click",     // "click" (body) | "action" | "reply" (action with input) | "dismiss"
  "actionId": null,    // the action id, null for click/dismiss
  "input": "On my way",// reply text
  "payload": "…",      // as given to show / carried by the push
  "target": true       // pages only: THIS window should run the default action (navigate)
}
```

Targeting (desktop, several windows): the response goes to every page and the
Worker, but `target: true` only in one page — the window that showed the
notification if it is still open and loaded, else the key/main window. A click
also brings that window to front (and unminimizes it). When no page is loaded
(cold start), nobody gets `target`; the response waits in the claim queue.

`dismiss` is delivered where the OS reports it (Apple customDismissAction,
Linux `closed` reason 2, Windows Dismissed/UserCanceled).

## Event `notificationShown`
`{ id, payload, push: boolean }`: delivered while the app is running (a scheduled
one firing, a push arriving in the foreground). Best effort (Apple willPresent).

## Ops — service `push`

### `register` `{}` → `{ provider, token, topic?, environment? }`
- Apple: `registerForRemoteNotifications`; `provider: "apns"`, `token` = device
  token hex, `topic` = bundle id, `environment` from the `aps-environment`
  entitlement. Missing entitlement / profile → `unavailable` with the reason.
- Linux / Windows: `unsupported` natively; with `push.server` the desktop client
  (below) answers instead, as it does on macOS.
Asks for the notification permission first when needed.

### `unregister` `{}` → `null` · `token` `{}` → `{ provider, token } | null`

### Events
- `pushToken` `{ provider, token }` — a new or rotated token.
- `pushMessage` `{ id?, data, notification?: { title, body }, payload?, foreground }`
  — a push received while the app runs (data messages always; notification
  messages when in the foreground).

Taps on push notifications are ordinary `notificationResponse`s, with `payload`
taken from the push.

## Push wire format (what `@svelte-desktop/shell/push` sends)

- APNs: `{"aps": {"alert": {"title","subtitle","body"}, "sound", "badge", "thread-id",
  "mutable-content"}, "sd": "<payload JSON string>"}`, header
  `apns-collapse-id: <id>` (it becomes the request identifier: same id = replaced).
- Web Push: encrypted JSON `{id, title, body, icon, image, badge, payload}`; the
  service worker shows it with `tag = id`.

## Parity with Electron and Tauri

What each one offers, and where it lives here.

| | Electron (`Notification`, `pushNotifications`) | Tauri (`notification` plugin) | svelte-desktop |
|---|---|---|---|
| title / body / subtitle | ✓ | ✓ | ✓ |
| icon / image / attachment | icon | icon, largeIcon, attachments | `icon`, `image` (path, file:, data:, http(s), app URL) |
| sound / silent | ✓ | ✓ | `sound`, `silent` |
| urgency | ✓ (Linux) | — | `urgency` (Apple interruption level, Linux, Windows scenario) |
| stays until acted on | `timeoutType: 'never'` | `ongoing` | `requireInteraction`, `ongoing` |
| actions | ✓ (macOS, Windows) | `registerActionTypes` | `actions` inline (`destructive`, `foreground`, per-action `url`) |
| inline reply | `hasReply` (macOS) | input action | `actions[].input` (Apple, Windows) |
| close button label | `closeButtonText` | — | `closeButtonText` (Windows, Linux) |
| raw Windows XML | `toastXml` | — | `toastXml` |
| replace / dedupe by id | — (new object each time) | `id` | `id` everywhere, `replace: false`, `renotify` |
| group / thread | — | `group`, `groupSummary` | `group` |
| badge | `app.setBadgeCount` | `number` | `badge`, `setBadge()` (Dock, Unity launchers, Windows overlay) |
| auto-cancel | — | `autoCancel` | `autoCancel` (Linux, Windows) |
| schedule | — | `schedule` (at, interval, every) | `at` / `delay` + `repeat` (survives quitting: macOS, Windows; Linux catches up) |
| delivered / pending lists | — | `active`, `pending` | `delivered()`, `pending()` |
| remove one / all | `close()` | `removeActive`, `cancel`, `cancelAll` | `dismiss(id)`, `dismissAll()` |
| events | show, click, close, reply, action, failed | `onAction`, `onNotificationReceived` | `click`, `action`, `reply`, `dismiss`, `response`, `shown`; `show()` rejects on failure |
| click that launched the app | Windows COM activator | — | everywhere: kept until the page claims it, then delivered + navigated |
| deep link on click | app code | app code | `url` → SvelteKit router / app scheme / browser |
| multi-window routing | app code | app code | the window that showed it (else the focused one), brought to front |
| foreground presentation | always | — | `foreground` per notification, `setForeground()`, config default |
| permission | `isSupported()` | `isPermissionGranted`, `requestPermission` | `isSupported()`, `permission` (reactive), `requestPermission()` |
| remote push: register | APNs (macOS) | — (community plugins) | `host.push.register()`: APNs (macOS), your own push server (macOS, Windows, Linux), Web Push (browsers) |
| remote push: receive | `received-apns-notification` | — | `push.on('message')`, taps = notification clicks, `push.on('token')` |
| remote push: send | — | — | `@svelte-desktop/shell/push`: APNs (HTTP/2, JWT), Web Push (VAPID, aes128gcm), expired targets reported |
| browser fallback | — | — | Notification API + service worker (`/__desktop/push-sw.js`) |

Verified end to end: macOS (packaged app), Linux (Xvfb), Chrome (a real Web Push
through Google's push service). Needs your credentials to run: a real APNs send
(`APNS_KEY` e2e).
Windows compiles; it has not run on Windows.

## Self-hosted push (no Apple account)

Web Push (RFC 8030 delivery, RFC 8291 encryption, RFC 8292 VAPID) is an open
protocol, so the same target and the same sender work against your own server.

- **Server** — the wire rules (request validation, VAPID, limits, frames) live in one
  runtime-free module, `@svelte-desktop/shell/push-protocol` (src/push/protocol.ts), and one
  contract test suite (src/push/contract.testkit.ts) runs against both implementations:
  `@svelte-desktop/shell/push-server`
  (Bun, bun:sqlite, anywhere) and `packages/push-worker` (Cloudflare Workers: one Durable
  Object per device with SQLite storage, hibernatable WebSocket, TTL alarm — `wrangler deploy`).
  - `POST /v1/subscribe` (`Authorization: Bearer <device secret>`, body
    `{ applicationServerKey? }`) → `{ id, endpoint }`. `GET /v1/subscriptions/:id` checks it still exists (the
    client re-subscribes on 404 and reports the new target), `DELETE` unsubscribes.
  - The device secret is ≥ 16 characters. Endpoints are opaque URLs (their shape differs
    between the two servers).
  - `POST /v1/push/…` — the Web Push endpoint: body ≤ 4096 bytes, `Content-Encoding: aes128gcm`,
    `TTL` (exact; 0 = delivered to a connected device or dropped, never stored),
    `Topic` (replaces a queued message with the same topic = dedupe), `Urgency`; VAPID
    checked when the subscription has an applicationServerKey. 201 + Location; 404/410
    for unknown/removed subscriptions (senders see `expired`).
  - `GET /v1/connect` (WebSocket, `?secret=` or bearer) — the device's one connection:
    queued messages first, then live ones `{ type: 'message', id, subscription, topic, body }`
    (body base64), acked with `{ type: 'ack', id }`; TTL-expired ones are dropped. The client
    pings (`{ type: 'ping' }` → `pong`) every 30 s.
- **Desktop client** (macOS, Windows, Linux, when `push.server` is set): runs in the
  app's server process, keeps the connection (backoff reconnect) while the app runs,
  window closed included. Keys (P-256 + auth secret) and the device secret live in
  `<data>/push.json`. A message is decrypted, shown with `notifications.show` (its `id`
  dedupes, its payload deep-links) and emitted as `pushMessage`.
