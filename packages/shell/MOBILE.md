# Mobile

Status (2026-10-31): **Android works** — the notes example runs as an APK on the
Pixel 9 emulator (Android 17, 16 KB pages) with SSR, `bun:sqlite`, remote
functions, a C Node-API addon, a C plugin, a sidecar and native services; 14/14 e2e tests pass, installed from the APK or from the AAB.
**iOS works** as a thin client (WKWebView on the deployed server, same bridge and services): 11/11 e2e on the simulator. This note is about how mobile reuses the same app, the same
API and the same `desktop.config.ts`.

## Android

```sh
SVELTE_DESKTOP_TARGET=android bunx --bun vite build   # or build: { target: 'android' }
# → .desktop/dist/<App>-<version>.apk   (notes: 46.8 MB, ~10 s)
ANDROID_E2E=1 bun test tests/android.test.ts          # launch({ android: true }) over adb
```

| piece | file | what it does |
|---|---|---|
| server entry | `src/android/server.ts` (+ `desktop-android.js` written by the adapter) | the unmodified SvelteKit handler behind the shared loopback gate (`src/gate.ts`: Host check, one-time secret → HttpOnly cookie); injects the page bridge into every HTML response; binds the platform bus and the `desktop` API to the host over stdin/stdout |
| host | `native/android/src/dev/sveltedesktop/{MainActivity,Services}.java`, `AndroidManifest.xml` | spawns `libappserver.so` from `nativeLibraryDir` with a fresh secret, loads the auth URL in an `android.webkit.WebView`, answers platform calls from the page (WebMessagePort) and from server code (stdio) with the desktop wire format and error codes |
| packager | `src/build/package-android.ts` | `bun build --compile --target=bun-linux-<arm64\|x64>-android`; Node-API addons with the NDK → `lib/<abi>/libaddon_<name>.so`; the C/C++ plugin (`native/*.c\|cc\|cpp` + `native/android/`) → `libapp-native.so` + the JNI plugin host `libsdhost.so` (`native/android/jni/sd_host_android.c`); javac → d8; aapt2 (manifest from config: label, package, icon, `schemes`, runtime permissions from `usageDescriptions`, `permissions.pages`, versionCode); `zipalign -P 16`; apksigner (`sign.android` / `$ANDROID_KEYSTORE`, else the debug key, which also makes the build debuggable) |
| tests | `src/build/package-android.test.ts`, `examples/notes/tests/android.test.ts` | manifest/packaging units; e2e on a device or emulator |

**Bridges.**
- Page → host: after each load of an app-origin document the host posts a
  `MessagePort` with `WebView.postWebMessage(…, targetOrigin = app origin)`. Only
  that origin's main frame receives it; the injected bridge accepts a port only
  from a message without a source window, so a frame can't plant its own (tested).
  No `@JavascriptInterface`, no androidx.
- Server → host: `SVELTE_DESKTOP_RPC {…}` lines on the server's stdout, replies and
  events on its stdin: a pipe only the host holds, no socket, no extra secret.
  Server code is not permission-checked, as on desktop.

**Services** (op names, arguments and replies match the desktop backends):
`app` (getInfo, getName, getVersion, getPath, quit, whenReady, getBundleType),
`clipboard` (readText, writeText, clear), `theme` (get, getAppearance,
shouldUseDarkColors; `appearanceChanged`), `shell` (openExternal, `share` —
the system share sheet), `system` (info, checkPermission, requestPermission),
`dialog` (showMessageBox, showConfirm, showOpenDialog — documents copied into the
cache so server code reads a path, showSaveDialog — a cache path mirrored into the
chosen document on every write), `notifications` (show/notify with actions,
dismiss/close, getPermissionStatus, requestPermission; `notificationResponse`),
`secureStorage` (setPassword, getPassword, deletePassword — AES-GCM with an
Android Keystore key; authenticate — device credential), `haptics.impact`
(Android-only), `webview` (executeJavaScript, capturePage, reload, getURL),
`deepLink.getInitialUrls` + `openUrls`, `events.emit`, `window.getTitle/setTitle`,
`diagnostics.info`, `capabilities.describe`. The WebView itself: JS dialogs,
`getUserMedia` for the app origin after the runtime permission, `<input type=file>`.
Desktop-shaped services (menu, tray, popover, dock, shortcuts, view, capture,
screen, power, windows, plugins) answer `unsupported`; unknown services answer `unknown`.

**Native code.** Node-API addons (`native/addons/*.c`) are compiled with the NDK
and loaded by server code with `loadAddon()`, as on desktop. C/C++ plugins use the
same `sd_host` ABI as Linux and Windows (`native/include/svelte_desktop.h`): the
JNI host loads `libapp-native.so`, calls `sd_plugin_init`, and its ops become
platform ops (`nativeModule()` from pages, `callPlatform` from server code) with
`resolve`/`reject`/`emit` from any thread. Code for one platform goes in
`native/<platform>/` (`macos`, `linux`, `windows`, `android`, `ios`); the notes
example keeps its Swift plugin in `native/` and an Android C plugin in
`native/android/counter.c`.

**Sidecars.** `sidecars` entries take one path or one per platform
(`{ ffmpeg: { android: 'bin/ffmpeg-android' } }`; prebuilt Android binaries are
checked to be ELF for the ABI), and C/C++ sources in `native/sidecars/` or
`native/android/sidecars/` are compiled with the NDK. They ship as
`lib/<abi>/libsidecar_<name>.so` (extracted, exec-allowed) and start from server
code with `sidecar(name, args)`, as on desktop.

**Play: Android App Bundle.** `build: { aab: true }` (or `SVELTE_DESKTOP_AAB=1`)
also writes `<App>-<version>.aab`: the same module in bundle form (proto
resources, `dex/`, `lib/`, native libraries kept compressed so the server can be
extracted), built with bundletool (pinned 1.18.3, sha256-checked, or
`$BUNDLETOOL_JAR`), signed with jarsigner, and validated. Verified by installing
the notes AAB on the emulator through `bundletool build-apks --connected-device`
(split APKs `base-master` + `base-arm64_v8a`, as Play delivers them) and running
the e2e against it: 14/14.

**ABIs.** `build: { androidArch: ['arm64', 'x64'] }` (or
`SVELTE_DESKTOP_ANDROID_ARCH=arm64,x64`) builds every native piece per ABI: a
universal APK (95.6 MB for notes) and an AAB that Play splits per device
(`base-arm64_v8a`, `base-x86_64`, checked with `bundletool build-apks`).

**Verified on the emulator** (`tests/android.test.ts`, 14/14, stable over
repeated runs): SSR reports the native layer and the sandboxed data dir; remote
command + `bun:sqlite`; remote form; page bridge (platform stores render); frame
port-planting rejected; app / system / theme; clipboard round trip; secure
storage; error codes; events reach server code; a native dialog (also answered
by tapping its button in the Device panel: `{response: 1, canceled: true}`);
the C plugin (ops, typed errors, events); a sidecar compiled from
`native/android/sidecars/hello.c` run by server code; screenshot.

**Test transport.** On Android the runner connects to the app: a token-protected
`/__desktop/test` route on the app's gate (debuggable builds only), reached
through `adb forward`, so it works the same on emulators and devices. Lesson
learned while building it: in `bun test`, `await expect(app.platform(…)).rejects`
corrupted the runner's WebSocket mid-frame (close 1006, then every call timed
out); the tests use `expect(await p.catch((e) => e))` instead (see `src/test.ts`). Also `aapt2 dump badging`,
`apksigner verify` (v2 + v3), `zipalign -c -P 16`.

**Not yet:** `--trim` for the target (needs canary), in-app updates of
side-loaded APKs (Play handles updates).

Size: 46.8 MB download, ~110 MB installed per ABI.

## Android: the original plan (full parity)

```
App.apk
  lib/arm64-v8a/libappserver.so   ← the bun --compile server, renamed lib*.so so the
                                     installer extracts it into nativeLibraryDir (an
                                     exec-allowed location since Android 10's W^X rule)
  lib/arm64-v8a/libshell.so       ← portable core (native/portable) + an Android backend
  classes.dex                     ← tiny Kotlin host: Activity + android.webkit.WebView
```

1. **Host (Kotlin, ~600 lines).** `MainActivity` spawns `libappserver.so` with
   `ProcessBuilder`, passing a one-time secret. It reads the port the server
   prints, then loads `http://127.0.0.1:<port>/__desktop/auth?t=…`: the same
   loopback gate as desktop, Host check and HttpOnly cookie included.
2. **Bridge.** `WebView.addWebMessageListener("__shell__", allowedOriginRules = {app origin})`
   is origin-scoped by design. It's the Android equivalent of the WKScriptMessageHandler
   check. The page-side `window.__shell` is identical. `kBridgeScript` already branches
   per transport; it needs a `__shell__.postMessage` branch.
3. **Server ↔ native.** The server process can't load JNI. Platform calls from
   server code travel over a loopback socket to the host (as the desktop dev
   bridge does today: `src/dev/bridge.ts` is that exact pattern). Page calls go
   straight to the host.
4. **Services.** App, clipboard, share, dialogs (Storage Access Framework),
   notifications, secure storage (Android Keystore), theme, haptics,
   deep links (intent filters from `schemes`), file associations (`fileTypes`).
   Window-, tray- and menu-shaped ops answer `unsupported`, as Linux does for
   macOS-only ops.
5. **Packaging.** `build: { target: 'android' }`: Gradle-less APK assembly is
   possible (aapt2 + d8 + apksigner from the SDK command-line tools), or ship a
   Gradle template. Signing with a keystore from `sign.android`; AAB for Play.
6. **Updates.** Play Store, or the existing signed updater for side-loaded APKs
   (install intent).

Risks: 114 MB per ABI (`--trim` needs the canary runtime for the target); OEM
battery killers stop background server processes, so the server must be
foreground-bound to the Activity; WebView versions vary per device; cold start
(spawn + JIT) needs measuring on mid-range phones.
Estimate: 2–3 weeks to a working prototype on an emulator, through the T3 device
panel (Android Emulator).

## iOS (thin client)

iOS can't run Bun (no build for the platform, no spawning executables, no JIT
outside WebKit), so the SvelteKit server runs where you deploy it — any adapter,
or `vite dev` on your Mac — and the iOS app is a native WKWebView on that origin
with the same bridge and services.

```ts
// desktop.config.ts
ios: { serverUrl: 'https://notes.example.com' }   // http only for localhost dev servers (ATS)
```
```sh
SVELTE_DESKTOP_TARGET=ios bunx --bun vite build    # → .desktop/dist/ios-simulator/<App>.app (0.3 MB)
IOS_E2E=1 bun test tests/ios.test.ts               # launch({ ios: { serverUrl } }) on a booted simulator
```

| piece | file | what it does |
|---|---|---|
| host | `native/ios/SvelteDesktopHost.swift` | UIKit app (scene lifecycle) with a WKWebView on `ios.serverUrl`; the macOS bridge script verbatim (`window.__shell` → `WKScriptMessageHandler __shell__`, injected at document start in the main frame); calls accepted only from the main frame of the server's origin; `permissions.pages`; other origins open outside the app |
| packager | `src/build/package-ios.ts` | `swiftc` for the simulator (default) or a device (with `sign.ios.provisioningProfile`); Info.plist from config (identifier, version, `schemes`, usage strings, `permissions.pages`, ATS); app icon via actool; simulator entitlements (Keychain access group) in `__TEXT,__entitlements` as Xcode does; codesign |
| tests | `examples/notes/tests/ios.test.ts` | e2e on the simulator against a `vite dev` it starts |

Services (same names and replies as desktop): `app`, `clipboard`, `theme`
(+ `appearanceChanged`), `shell` (openExternal, `share`), `system.info`,
`dialog` (showMessageBox, showConfirm), `notifications` (show with actions,
dismiss, permission status/request; `notificationResponse`), `secureStorage`
(Keychain + device-owner authentication), `haptics.impact`, `webview`
(executeJavaScript, capturePage, reload, getURL), `deepLink` + `openUrls`,
`events.emit`, `diagnostics.info`, `capabilities.describe`. JS alerts/confirms
are native; `getUserMedia` prompts for the app origin only; `<input type=file>`
is WebKit's. Desktop-shaped services answer `unsupported`.

**Swift plugins.** The iOS host exposes the macOS plugin API (`Desktop.command`,
`Desktop.emit`, `DesktopError`, plus `Desktop.window()` / `viewController()` for
UIKit). `native/*.swift` and `native/ios/*.swift` are compiled into the app;
files importing AppKit/Cocoa are skipped with a notice. The notes example has
`native/ios/Device.swift` (`device.info`, an async `device.multiply` with typed
errors, `device.ping` emitting an event).

**Clipboard and the paste prompt.** Reading the pasteboard raises iOS's paste
prompt and blocks the reading thread until the user answers. The host never reads
it on the main thread, `availableFormats`/`has` use the prompt-free checks, and
the `clipboard` store starts from the formats only on iOS (found by the e2e:
`/platform` froze the app behind the prompt).

**Verified on the iPhone 17 Pro simulator (iOS 26.5)** (`tests/ios.test.ts`,
11/11): the app loads from the server and a remote command runs; the page bridge
renders the platform stores; a frame's `webkit.messageHandlers` call is ignored;
app / system / theme; clipboard; Keychain round trip; error codes; events and
haptics; notification status; the Swift plugin (sync, async, typed error, event);
screenshot.

**Differences from Android/desktop, by design:** server code runs on your server,
not on the phone, so it has no `desktop` API, no `bun:sqlite` on the device and no
addons; native work happens in the page through `@svelte-desktop/shell/platform`.

**Offline mode.** `ios: { offline: true }` (or `SVELTE_DESKTOP_IOS_OFFLINE=1`)
bundles the client build, the prerendered pages and an SPA fallback (`200.html`)
into the app and serves them from `app://localhost` through a
`WKURLSchemeHandler` (static-host resolution: file, `.html`, `index.html`,
fallback). For apps that work without a server: prerendered or `ssr = false`
pages, no server `load` or remote functions. The bridge, services and Swift
plugins work the same (`tests/ios-offline.test.ts`, 4/4: origin and no server,
a prerendered page, the client router, a page → host → page round trip and the
Swift plugin).

**Device builds.** With `sign.ios: { provisioningProfile, identity }` the app is
built for `iphoneos`, the profile embedded and its entitlements applied. Without a
profile, `ios: { device: true }` (or `SVELTE_DESKTOP_IOS_DEVICE=1`) writes an
unsigned device `.app` to sign later — checked here: arm64 Mach-O, platform iOS
(not the simulator), minimum iOS 17.0, release flags.

**Not yet:** a run on a physical device (needs a provisioning profile).

## What carries over unchanged

- The page-facing API: `@svelte-desktop/shell/platform`, `/stores`, `/client`, `nativeModule()`.
- `desktop.config.ts` (`appName`, `identifier`, `schemes`, `fileTypes`, `usageDescriptions`, `permissions`).
- The bridge protocol and error codes (`native/portable/core.*`).
- Swift plugins on iOS; C/C++ plugins on Android via the NDK (same `sd_host` ABI).

## Suggested order

1. Android prototype (full parity is possible): host, bridge, 5 core services, emulator e2e with `launch()`-style driving over adb.
2. iOS thin client.
3. iOS offline mode if needed.
