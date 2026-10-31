# @svelte-desktop/shell

Turn an **unmodified SvelteKit app** into a native desktop app (macOS; Linux via
GTK/WebKitGTK; Windows via WebView2 — see Platforms): one Vite plugin,
one config file. SSR, remote functions, form actions, endpoints and `bun:sqlite`
run in-process on Bun; the UI is the system WebKit; the result is a signed,
notarizable `.app` containing a single compiled executable.

```
bunx --bun vite dev     → the real native window on the Vite server (HMR, Web Inspector, native APIs live)
bunx --bun vite build   → .desktop/dist/App.app + .zip + .dmg (+ release/ for the auto-updater)
bun test                → drive the real window from tests
```

## Setup

```ts
// vite.config.ts — the only plugin you need (it is SvelteKit's plugin, wired for desktop)
import { desktop } from '@svelte-desktop/shell/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [desktop({ experimental: { remoteFunctions: true } })] });
```

```ts
// desktop.config.ts
import { defineConfig } from '@svelte-desktop/shell/config';
export default defineConfig({
  appName: 'Notes',
  identifier: 'com.example.notes',
  window: { width: 960, height: 680, autosaveName: 'main' },
});
```

New project: `bunx svelte-desktop create my-app` (SvelteKit app, config, Swift plugin sample, tests).
Existing project: `bunx svelte-desktop init` writes both files, rewrites
`sveltekit(` → `desktop(`, adds scripts and `.gitignore`. `bunx svelte-desktop doctor`
checks Bun, Xcode tools, the config, signing identities and the notary profile.
Requirements: macOS 12+, Bun ≥ 1.4, Xcode command line tools, `@sveltejs/adapter-bun`.

## What you get

| | |
|---|---|
| **Your app, unchanged** | SvelteKit SSR + remote functions + `bun:sqlite`, served on a random loopback port behind a session-cookie gate (Host check, one-time secret, HttpOnly cookie) |
| **Dev mode** | `vite dev` opens the native window on the Vite server: HMR in the window, Web Inspector, server code reaches native APIs through an RPC bridge, native plugin rebuilt and window restarted on change, `desktop.config.ts` edits restart. Closing the window ends `vite dev`. |
| **Native API** | 245 ops in 22 services (incl. aliases), typed, from pages **and** server code, plus reactive stores (`import { theme, window, tray } from '@svelte-desktop/shell/stores'`). [Platform API](#platform-api) |
| **Your own native code** | `native/*.swift` / `*.m` / `*.c` → a plugin dylib, ops callable from pages and server (`nativeModule<T>('svc')`); `native/addons/*.c` → Node-API addons (`loadAddon`); `sidecars` for executables. [Native code](#native-code) |
| **Web view features** | alert/confirm/prompt, file drop with real paths, downloads, print/PDF, find, zoom, context menu control, camera/mic permissions, open-file/file associations, capturePage, executeJavaScript. [WEBVIEW.md](WEBVIEW.md) |
| **Menu-bar apps & popovers** | `<StatusItem popover="/route">`, `<Popover anchor={el}>`, Spotlight-style panels on a global hotkey, content sized to fit. [POPOVERS.md](POPOVERS.md) |
| **Distribution** | Info.plist from config (URL schemes, document types, usage strings, LSUIElement), icon from one PNG, hardened runtime + entitlements, Developer ID signing, notarization + stapling, universal arm64+x64, zip, DMG with Applications link |
| **Auto-update** | ed25519-signed manifest + sha256-pinned artifacts from any static host; `vite build` writes `release/` including a **delta patch** from the previous release (14 KB instead of 39 MB for a typical change); download → verify every file → swap after quit → relaunch, rollback if the new version doesn't start. [updater README](src/updater/README.md) |
| **Testing** | `launch()` drives the built app or `vite dev` in its real window: `click`, `fill`, `press`, `waitFor`, `eval`, `platform`, `screenshot`, `nextEvent` |
| **Production hygiene** | logs to `~/Library/Logs/<id>/app.log` when launched from Finder, graceful quit (signals, ⌘Q, Dock) with `onBeforeQuit`, crash recovery of the web process, single-instance lock, no `.env`/`bunfig.toml` pickup at runtime |

## Configuration (`desktop.config.ts`)

| key | |
|---|---|
| `appName`, `identifier`, `version` (package.json), `icon` (static/icon.png), `copyright` | identity |
| `window` | `{ width, height, minWidth, minHeight, title, autosaveName, visible, hiddenUntilReady, debug, titleBarStyle }` or `false` (menu-bar app) |
| `schemes` | deep-link URL schemes → `openUrls` event |
| `fileTypes` | `[{ name, extensions, role, rank, utis, mimeTypes }]` → `openFiles` event (macOS document types; Linux `.desktop` MimeType + shared-mime-info; Windows installer associations) |
| `singleInstance` | default `true`: launching again (a document, a link) hands the arguments to the running app (`openUrls` / `openFiles`, `secondInstance`) — Linux/Windows; macOS does it natively |
| `permissions` | OS permissions with the reason shown to the user: `{ camera: 'Scan documents', screenRecording: 'Share your screen' }` → Info.plist usage strings, entitlements, Android manifest, iOS keys; checked/requested/guided by `host.permissions` (`usageDescriptions` still accepted) |
| `notifications` | `{ channels: [{ id, name, importance, sound, vibrate, … }], foreground }` — Android channels; banners while frontmost (default true) |
| `push` | `{ apns: true \| { environment }, fcm: { googleServices: './google-services.json' } }` — APNs entitlement (+ `sign.provisioningProfile`), Firebase Messaging in the APK |
| `trayOnly` | no Dock icon / app menu |
| `native` | native plugin folder (default `native/`), `false` to disable |
| `addons` | prebuilt `.node` files to ship |
| `sidecars` | `{ name: 'bin/tool' }` or per platform `{ name: { macos, linux, windows, android } }` → `sidecar(name, args)` |
| `bridge.allow` | ops pages may call (`'window.*'`, `'clipboard.readText'`); enforced natively; server code unrestricted (`permissions.pages` still accepted) |
| `update` | `{ manifestUrl, publicKey, channel, privateKey, baseUrl }` |
| `build` | `{ target, targetArch, androidArch, aab, aot, trim, bun, universal, dmg, zip, outDir, minimumSystemVersion }` — `aot`/`trim` need Bun canary today |
| `ios` | `{ serverUrl, offline, device, deploymentTarget, debug, plist }` (MOBILE.md) |
| `sign` | `{ identity, entitlements, hardenedRuntime, notaryProfile, provisioningProfile }` — or `$CODESIGN_IDENTITY`, `$NOTARY_PROFILE` |
| `plist` | extra Info.plist keys |

### No title bar

```ts
window: { titleBarStyle: 'hiddenInset' } // or 'hidden' (traffic lights at the corner), 'transparent' (keeps the title)
```
```css
/* your header takes the title bar's place */
header {
  --app-region: drag;                                   /* or the data-desktop-drag attribute */
  min-height: max(var(--desktop-titlebar-height, 0px), 2.5rem);
  padding-left: max(var(--desktop-controls-width, 0px), 1rem); /* clear the traffic lights */
}
.search { --app-region: no-drag; }                     /* carve out a region; links, buttons and inputs are clickable anyway */
```
The page extends under the title bar; the shell sets `--desktop-titlebar-height`,
`--desktop-controls-width` and `html[data-desktop-titlebar]` (`fullscreen` while in
full screen, where both drop to 0). A double-click on a drag region follows the
system setting (zoom / minimize). `window.setTitleBarStyle(style)` switches at
runtime. Scrolling over the title bar strip doesn't scroll the page (macOS): it
behaves like a title bar, and title-bar gesture tools (Swish…) work. A gesture is
routed as a whole by where it began, so one started in the page keeps scrolling.

No elastic overscroll (rubber band) on desktop: the bridge sets
`:where(html, body) { overscroll-behavior: none }`, with zero specificity — bring it
back with `html { overscroll-behavior: auto }`, or set it per scroll container.

On Linux and Windows a hidden title bar is a frameless window: there are no native
buttons to keep, so `html[data-desktop-controls="none"]` tells the page to draw its
own (`host.window.minimize()`, `toggleMaximize()`, `close()`); drag regions and
double-click-to-maximize work the same (macOS sets `data-desktop-controls="native"`).

```css
.window-buttons { display: none; }
:root[data-desktop-controls="none"] .window-buttons { display: flex; }
```

## The `host` global

Everything the app gets beyond the web is on one global, `host` — no import, the
same in page and server code (like `Bun`), typed through a one-line `src/host.d.ts`
the Vite plugin writes once. The name works on desktop and mobile.

```svelte
<p>{host.app.name} · {host.theme.dark ? 'dark' : 'light'}</p>          <!-- reactive -->
<button onclick={() => host.clipboard.writeText(text)}>Copy</button>
<button onclick={() => host.notifications.show({ title: 'Done' })}>Notify</button>
```
```ts
// server code (load, remote functions, endpoints, hooks)
const db = new Database(join(host.paths.data, 'app.db'));
const job = host.jobs.start('thumbnails', { files });
const math = host.loadAddon<{ fib(n: number): number }>('fastmath');
```

| | |
|---|---|
| reactive stores (+ their methods) | `app` · `window` · `windowState` · `screen` · `clipboard` · `theme` · `system` · `power` · `deepLink` · `menu` · `notifications` · `push` · `capture` · `diagnostics` · `capabilities` · `update` · `tray` · `shortcuts` · `store` · `events` · `jobs` |
| services | `windows` (multi-window) · `dialog` · `shell` · `secureStorage` · `popover` · `webview` · `view` |
| functions | `on(event, fn)` · `broadcast` / `onBroadcast` · `nativeModule<T>(name)` · `currentPopover` / `closePopover` · `available` |
| server code only | `paths` · `crashInfo()` · `sidecar()` · `loadAddon()` · `onBeforeQuit()` · `ready()` · `jobs.start()` / `jobs.wait()` |

`host.available` is false in a plain browser tab or outside the app. The modules
(`@svelte-desktop/shell/platform`, `/stores`, `/server`, `/client`) still exist for
those who prefer imports.

Services: app · window (81 ops, multi-window, close veto, titlebar styles) · screen ·
clipboard · shell · dialog · theme · menu (app/Dock/context, live updates) · system
(+ permissions) · power · secureStorage (Keychain, Touch ID) · notifications · deepLink ·
tray · shortcuts (global hotkeys) · popover · webview · diagnostics/capabilities ·
updater. `host.capabilities.describe()` lists every op of the running build.
Calls from pages go straight to native (an origin-checked WebKit message handler);
calls from server code go over FFI (or RPC in dev) to the same dispatcher.

## Permissions

Declare what the app uses, with the reason the user will read:

```ts
// desktop.config.ts
permissions: {
  camera: 'Scan documents',
  screenRecording: 'Share your screen in calls',
  accessibility: 'Move windows with keyboard shortcuts',
}
```

The build turns it into the Info.plist usage strings and entitlements (macOS), the
Android manifest and the iOS keys. Some permissions must be declared (camera,
microphone, location, contacts…): the OS kills an app that asks without a reason, so
asking for an undeclared one rejects with `undeclared` and says what to add.

```svelte
<p>Camera: {host.permissions.camera}</p>            <!-- 'granted' | 'denied' | 'notDetermined', reactive -->
<button onclick={() => host.permissions.request('camera')}>Allow camera</button>
<button onclick={() => host.permissions.request('screenRecording')}>Allow screen recording</button>
```

`request()` shows the system prompt when there is one. Screen Recording,
Accessibility, Input Monitoring and Full Disk Access have none — only System Settings
can grant them — so `request()` runs the guided flow (also `host.permissions.guide(name)`):
the right Settings pane opens and a small panel floats next to it with the app's icon
to drag into the list, the reason from the config and a live status; it closes by
itself once granted (with a Relaunch button where macOS applies the grant at the next
launch). Statuses refresh when the app comes back to the front;
`host.permissions.on('change', (name, status) => …)` follows them. On Windows the
privacy settings page opens; on Android and iOS the system prompts and the app's
settings page; Linux has no per-app gates.

## Notifications and push

```ts
await host.notifications.show({
  id: 'msg-42',                 // dedupe: same id = replaced, never duplicated
  title: 'Alice', subtitle: '#general', body: 'Lunch?',
  url: '/chat/42',              // a click opens it in the window that showed it
  data: { chat: 42 },           // handed back in events and lists
  group: 'chat', image: '/avatars/alice.png', urgency: 'critical',
  actions: [
    { id: 'reply', title: 'Reply', input: { placeholder: 'Message' } },
    { id: 'mute', title: 'Mute', foreground: false, destructive: true },
  ],
});
await host.notifications.show({ id: 'standup', title: 'Stand-up', at: tomorrow9am, repeat: 'day' });

host.notifications.on('click', (e) => { /* e.id, e.data, e.url — e.preventDefault() skips the navigation */ });
host.notifications.on('reply', (e) => send(e.data.chat, e.input));
host.notifications.permission                       // reactive: 'granted' | 'denied' | 'notDetermined'
await host.notifications.delivered() / .pending() / .dismiss(id) / .dismissAll() / .setBadge(3)
```

- **Dedupe**: `id` replaces a delivered or pending notification on every platform
  (`replace: false` keeps the existing one). Pushes use the same ids, so a push and a
  local notification for the same message show once.
- **Deep links**: `url` (or an action's `url`) navigates with the SvelteKit router; the
  app's scheme goes through `host.deepLink`, http(s) opens in the browser.
- **Cold start**: a click that launched the app (or happened with no window loaded)
  is kept until the page starts, then navigates; listeners added later still get it.
  Server code gets every response too (`host.notifications.on('response')` in a
  `+server.ts`), replayed at start.
- **Several windows**: listeners and navigation run in one page only — the window
  that showed it, else the focused one — and that window comes to the front.
- **Scheduling** (`at`, `delay`, `repeat`) survives the app quitting on macOS, iOS,
  Android and Windows; Linux keeps the queue on disk and catches up at the next start.

Remote push — `host.push.register()` gives the target to send to your server: APNs on
macOS/iOS (`push.apns` + a provisioning profile with Push Notifications; the iOS
simulator registers without one), FCM on Android (`push.fcm.googleServices`), Web Push
in a browser (`register({ vapidPublicKey })`). `host.push.on('message')` gets pushes
received while the app runs, `on('token')` rotations; taps on pushes are ordinary
notification clicks (same `url`/`data`). Send from Bun, no dependencies:

```ts
import { createPush, generateVapidKeys } from '@svelte-desktop/shell/push';
const push = createPush({
  apns: { teamId, keyId, key: await Bun.file('AuthKey.p8').text() },
  fcm: { serviceAccount: await Bun.file('firebase-service-account.json').json() },
  webpush: { publicKey, privateKey, subject: 'mailto:ops@example.com' },
});
const results = await push.sendMany(targets, { id: 'msg-42', title: 'Alice', body: 'Lunch?', url: '/chat/42' });
// results[i].expired → the target is gone (uninstalled, unsubscribed): delete it
```

No Apple or Google account on desktop: set `push.server` to your own push service — deploy
`packages/push-worker` on Cloudflare (`bunx wrangler deploy`: Workers + one Durable Object per
device, hibernatable WebSockets) or run `servePush()` from `@svelte-desktop/shell/push-server`
anywhere. The app holds one connection while it runs; `register()` then returns a Web Push
target and the same `push.send()` delivers to it, end-to-end encrypted. Android can use
UnifiedPush (a distributor app such as ntfy); iOS has no alternative to APNs.

In a plain browser tab, `host.notifications` uses the Notification API and a small
service worker (`/__desktop/push-sw.js`, its own scope: it never competes with the
app's). Per-platform details: [native/NOTIFICATIONS.md](native/NOTIFICATIONS.md).

## Background jobs

Long or CPU-heavy work runs in its own process, so the app stays responsive and a
crashing job can't take it down. One file per job:

```ts
// src/jobs/thumbnails.ts — no import: HostJob is a global type
const thumbnails: HostJob<{ files: string[] }, { made: number }> = async ({ files }, ctx) => {
  for (const [i, file] of files.entries()) {
    if (ctx.signal.aborted) throw new Error('canceled');
    await makeThumbnail(file);
    ctx.progress((i + 1) / files.length, file);
  }
  return { made: files.length };
};
export default thumbnails;
```

```ts
// server code (remote function, endpoint, hook)
const job = host.jobs.start('thumbnails', { files }, { concurrency: 2 }); // → { id, state: 'queued' | 'running', … }
host.jobs.get(job.id); host.jobs.list(); await host.jobs.wait(job.id); host.jobs.cancel(job.id);
host.jobs.on('done', (job) => {}); host.jobs.onEvent(({ id, data }) => {}); // transitions, ctx.emit() events
```

```svelte
<script>host.jobs.on('done', (job) => toast(`${job.name} finished`));</script>
{#each host.jobs.active() as job (job.id)}
  <progress value={job.progress}></progress> {job.message} <button onclick={() => host.jobs.cancel(job.id)}>✕</button>
{/each}
```

`host.jobs` is the same in both places — `list()`, `active()`, `running()`, `get(id)`,
`on(state, fn)`, `onEvent(fn)`, `cancel(id)` — and server code also has `start` and `wait`.

The job context has `progress(fraction, message)`, `log(...)`, `emit(data)` and an
abort `signal` (cancel, app quit). In the packaged app each job is the app's own
executable acting as Bun (`BUN_BE_BUN=1`) running the job's bundle, embedded at
build time; under `vite dev` the `.ts` file runs directly. Jobs are killed when the
app quits; ended jobs (state, result, error, last log lines) are kept in
`<data>/jobs.json` and come back after a restart (`restored: true`). Verified on
macOS (built and `vite dev`), Linux (Docker) and Android (the phone runs the job in
its own process too).

## Native code

```swift
// native/Greeter.swift — compiled by the plugin, loaded on the UI thread
func desktopSetup() {
  Desktop.command("greeter.hello") { args in "Hello \(args["name"] as? String ?? "?")" }
  Desktop.command("greeter.title") { _ in Desktop.window()?.title }      // MainActor: AppKit is fine
  Desktop.command("greeter.add") { args in
    guard let a = args["a"] as? Double, let b = args["b"] as? Double else { throw DesktopError.invalidArgs("numbers") }
    return a + b                                                           // async/await allowed
  }
}
```

```ts
const greeter = nativeModule<{ hello(a: { name: string }): string }>('greeter');
await greeter.hello({ name: 'Ada' });            // from a page or from server code
```

Objective-C/C: `SDCommand(@"svc.op", ^(NSDictionary *args, SDReply reply) { … })` in
`void SDSetup(void)`; raw C ABI in [`native/include/svelte_desktop.h`](native/include/svelte_desktop.h).
Frameworks autolink from `import`/`@import`. Node-API addons: `native/addons/fastmath.c` →
`loadAddon<{ fib(n: number): number }>('fastmath')` in server code (dev and build).

## Testing

```ts
import { launch } from '@svelte-desktop/shell/test';
const app = await launch();                       // built app; launch({ dev: true }) for vite dev
await app.fill('input[name=q]', 'hello'); await app.press('input[name=q]', 'Enter');
await app.waitFor(() => document.body.innerText.includes('hello'));
expect(await app.platform('window', 'getTitle')).toBe('Notes');
await app.close();
```

Run with `bun test --timeout 30000` (app startup exceeds bun's 5 s default). The test
channel exists only when `launch()` sets `SVELTE_DESKTOP_TEST`.

## Distribution

```sh
CODESIGN_IDENTITY="Developer ID Application: You (TEAMID)" NOTARY_PROFILE=notary bunx --bun vite build
```

Signs nested code then the bundle with the hardened runtime and the entitlements Bun's
JIT needs (plus device entitlements derived from `usageDescriptions`), notarizes and
staples the app and the DMG, after a local pre-flight of Apple's requirements
(`bunx svelte-desktop preflight App.app` runs it on any bundle). Without an identity builds are ad-hoc signed (runs
locally, Gatekeeper blocks downloads). `build.universal` lipos arm64 + x64 (Bun cross-
compiles the x64 slice; `aot` stays on the host slice).

## Architecture

```
App.app/Contents/MacOS/App                one bun --compile executable (UI thread + Worker)
App.app/Contents/Frameworks/libshell.dylib  ~570 KB: webview/webview + native services
                           /libapp-native.dylib, addons/*.node   your native code
main thread: Cocoa run loop (WKWebView)   ←→   Worker: Bun.serve (SvelteKit) + desktop API
             one native dispatcher (platform_*.mm) for page bridge, FFI and plugins
```

## Measured (macOS 26.5, M4 Pro — see [bench/RESULTS.md](bench/RESULTS.md))

| hello world | .app | zip | ready | memory (all processes) |
|---|---|---|---|---|
| Electron 45 | 258 MB | 115 MB | 303 ms | 88–149 MB |
| Tauri 2.12 | 4 MB | 1.8 MB | 313 ms | 75–170 MB |
| Electrobun 2.0 | 31 MB (187 installed) | 31 MB | 396 ms | 86 MB |
| **this, Bun stable** | 86 MB | 39 MB | 378 ms | 87 MB |
| **this, `--aot --trim`** | 45 MB | 19 MB | 334 ms | 85 MB |

## Tests in this repo

- `examples/kit-conformance`: a SvelteKit 3 feature matrix in the real shell (18 tests, built app and `vite dev`): static assets, hooks (`handle`, `handleError`, `transformPageChunk`), `+layout.server` / `+page.server` / `+page.ts` with `fetch`, streaming, `setHeaders`, `$lib/server`, `$app/env` (`src/env.ts`), client navigation and history, params (optional, rest, matchers, groups), 404 / `error()` / `redirect()`, form actions (enhanced and plain POST, `fail`, cookies), `+server.ts` (JSON, status, cookies, streamed bodies), 20 MB uploads, requests over 10 s, remote functions (`query`, `query.batch`, `command` + refresh, `form`, `getRequestEvent` cookies, `prerender`), `invalidate`, shallow routing, prerendered pages, and the gate.
  The gate makes SvelteKit's production cookies work on the http loopback origin (they default to `Secure`, which WebKit drops there) and disables Bun's 10 s idle timeout.

- `test/run-platform.sh` — native suites against a real window (476 checks).
- `bun test src/updater` — updater + delta engine (53 tests). `examples/notes`: `bun run test`,
  `bun run test:dev`, `scripts/test-update.sh` (real 0.1.0 → 0.2.0 update through a delta patch).

## Platforms

| | native backend | packaging | verified |
|---|---|---|---|
| macOS 12+ | `native/*.mm` (Cocoa, WKWebView) | .app, zip, DMG, notarization, universal | full suites on this Mac |
| Linux | `native/linux` (GTK3, WebKitGTK 4.1) on `native/portable` | app dir, tar.gz, AppImage | Docker under Xvfb (`test/docker/run.sh platform|notes`) |
| Windows | `native/windows` (Win32, WebView2) on `native/portable` | folder, zip, NSIS installer, Authenticode | cross-compiled + Wine smoke of the native layer; **not yet run on real Windows** (AUDIT.md) |
| iOS 17+ (thin client) | `native/ios` (Swift, WKWebView on `ios.serverUrl`) | simulator .app; device .app with a provisioning profile; offline mode | iPhone 17 Pro simulator, `tests/ios.test.ts` 11/11, offline 4/4 (MOBILE.md) |
| Android 8+ | `native/android` (Java host, android.webkit.WebView, ~60 ops) | signed APK (aapt2/d8/zipalign/apksigner, no Gradle; NDK for addons and C plugins) | Pixel 9 emulator, `tests/android.test.ts` 14/14, APK and AAB (MOBILE.md) |

Platform-specific native code goes in `native/<platform>/` (`macos`, `linux`, `windows`, `android`, `ios`); the rest of `native/` is built everywhere it can be.

`build: { target: 'linux' | 'windows' | 'android' | 'ios' }` selects the target, or
`SVELTE_DESKTOP_TARGET=android vite build` without editing the config. The portable core
(`native/portable`) carries the dispatcher, bridge, permissions and plugin host
shared by Linux and Windows.

## Limits
 `aot`/`trim` need Bun canary. Notarization needs your Developer ID
(the pipeline is implemented, not exercised here). See [AUDIT.md](AUDIT.md).
