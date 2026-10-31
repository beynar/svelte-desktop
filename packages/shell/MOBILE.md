# Mobile: feasibility plan

Status: plan only (2026-10-31). Desktop is macOS / Linux / Windows; this note is
about how iOS and Android could reuse the same app, the same API and the same
`desktop.config.ts`.

## What decides it: where can Bun run?

| | Bun runtime | verified |
|---|---|---|
| Android arm64 / x64 | ✅ official builds (`bun-linux-aarch64-android`, `bun-linux-x64-android`) | `bun build --compile --target=bun-linux-arm64-android` from this Mac → a 114 MB ARM64 executable for the Android linker (`/system/bin/linker64`) |
| iOS | ❌ no build | iOS bans spawning executables, and JIT outside Apple's engine; JavaScriptCore without JIT lacks Bun's APIs (`Bun.serve`, `bun:sqlite`, `Bun.file`) |

So the two platforms need different shapes.

## Android: the desktop architecture, on a phone (full parity)

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

## iOS: two shapes, same app code

**A. Thin client (recommended first).** Deploy the SvelteKit server like a normal
web app (any adapter). The iOS app is a Swift host with a WKWebView pointing at
it, plus the same page bridge (`WKScriptMessageHandler` with origin check,
reusing `platform_core.mm` logic), so `@svelte-desktop/shell/platform` and the
stores work. Remote functions run on your server; native services (camera,
share, haptics, Keychain, notifications) run in the app. Swift plugins
(`native/*.swift`) port directly: the `Desktop.command` API is plain Swift.

**B. Offline mode.** `adapter-static` / prerendered pages bundled in the app
(served through a `WKURLSchemeHandler`), with app logic in the page and
persistence through native services (SQLite via a native plugin). No Bun on
device, so no SSR or `bun:sqlite` in server code.

Estimate: A is about 1–2 weeks (host + bridge + core services, reusing the
macOS Objective-C/Swift); B adds the scheme handler and an offline data story.

## What carries over unchanged

- The page-facing API: `@svelte-desktop/shell/platform`, `/stores`, `/client`, `nativeModule()`.
- `desktop.config.ts` (`appName`, `identifier`, `schemes`, `fileTypes`, `usageDescriptions`, `permissions`).
- The bridge protocol and error codes (`native/portable/core.*`).
- Swift plugins on iOS; C/C++ plugins on Android via the NDK (same `sd_host` ABI).

## Suggested order

1. Android prototype (full parity is possible): host, bridge, 5 core services, emulator e2e with `launch()`-style driving over adb.
2. iOS thin client.
3. iOS offline mode if needed.
