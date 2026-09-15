# QuickGUI analysis — pinned source audit

Artifact: `@quickgui/native@0.1.4-next.1` (installed under
`gpuix-poc/node_modules`). Source-of-truth: `src/*.ts` in the package —
inspected directly, 2026-09-15. Homepage claims verified against code, not
repeated as facts.

## Loading & ABI

`ffi.ts` — `dlopen` of `lib/darwin-{arm64,x64}/libquickgui_host.dylib`
(`QUICKGUI_LIBRARY` env override; also checks `../Frameworks` next to the
executable — the packaged-app layout). **28 FFI symbols**, protocol-gated:
`quickgui_protocol_version()` must equal `PROTOCOL_VERSION = 31`
(`protocol.generated.ts`) at load, else abort — real ABI versioning.

## Process & threading model (runtime.ts)

- `runApplication(load, options)` spawns a **Bun Worker** for the app code;
  the main thread runs `library.symbols.quickgui_run_host()` — the native
  blocking host loop. JS app and native host are therefore on **different
  threads**, bridged by `postMessage` (`host-stopped`, `startup-error`,
  `stopped` message types).
- Shutdown: `run_host` returns → main posts `host-stopped` → worker calls
  `binding.finish(code)` → replies `stopped` → main exits. 5 s timeout →
  `process.exit(1)` (hard kill, documented).
- Failure paths: `uncaughtException`/`unhandledRejection` → `abort()` →
  `failureCode=1` propagates.

## Event delivery (ffi.ts:155-180)

- `quickgui_set_event_notifier(JSCallback)` — native notifies JS when the
  event queue is non-empty (edge-triggered wakeup, **no polling loop**).
- JS then calls `quickgui_drain_events(receiveCallback.ptr, null)` which
  synchronously invokes the callback per event until drained — batched drain,
  matching our gpuix `drainEvents()` shape.
- `NativeEvent`: `{kind, window, target, value?, extra?, data?: Uint8Array}`
  — string + optional binary payload.

## Window/tree model (binding.ts, native-tree.ts)

- `NativeNode` retained tree, `NativeNodeTag`/`PropertyCode` enums from
  `protocol.ts` — mutation protocol is property-coded, not structural diffing.
- `createHeadlessRoot` in our `qg-backend.ts` mirrors this tree in pure JS for
  conformance — real window path uses the same protocol over FFI.

## Service inventory (system.ts, integrations.ts, tray.ts, dialog.ts)

Frozen namespace objects binding the FFI syms — this is the reference
inventory used for `spec/native-api.yaml`:

- `Clipboard` — text/HTML/image/files/data/bookmark entries, item format
  enumeration. `Shell` — open/beep/trash. `SpellChecker`. `Notifications` —
  actions/attachments/inline-reply. `Menu` + `serializeNativeMenu` —
  action/role/separator/submenu/services/system items, accelerators.
  `GlobalShortcut`. `Screen` — displays, work areas, cursor. `Desktop` —
  wallpaper-ish/system queries. `Appearance`. `Keyboard` + `KeyboardLayout`.
  `PowerMonitor` + `PowerAssertion` (scoped sleep/display blockers).
  `SystemPreferences` + `SystemPreferencesSnapshot` (SystemColor set).
  `Permissions`. `Tray`/`TrayIcon` class. `CrashReporter`/`Metrics`
  (integrations.ts). `AutoStart`. `Protocol` (custom scheme) + `DeepLink` +
  `urlsFromArguments` (single-instance.ts). `SecureStorage`.
  Window services: `getNativeWindowState`, `WindowRestoreState`, quit
  interception (`setNativeQuitInterception`/`requestNativeQuit`), window
  actions, window menus (`setNativeWindowMenu`/`releaseNativeWindowMenu`),
  dock (`requestNativeDockAttention`/`cancel`/`setNativeDockVisible`),
  `setNativeActivationPolicy`, `setNativeSecureKeyboardEntry`,
  `moveNativeApplicationToApplicationsFolder`, `nativeApplicationPackaged`,
  `exitNativeAppWithCode`, `configureSystemContext` context resolver,
  `dispatchSystemEvent` fan-in, `rejectPendingSystemRequests` shutdown sweep.

## What this means for us

- Their model = **same process, two threads** (worker app / main-thread host),
  FFI transport, versioned ABI, event-notifier wakeup. Ours (gpuix) = **one
  thread**, NAPI transport, callback→setTimeout deferred apply. Both avoid
  polling; both batch mutations.
- Their service layer is the most complete inventory in-repo — we adopt it as
  the V1 spec reference and reuse the dylib where its protocol lets us
  (measured: dylib loads + version checks cleanly under Bun).
- Their `run_host` blocking model means the app thread is a worker — our
  in-process gpuix model keeps app code on the main thread, which is simpler
  for `$app/*` state but requires the no-reentrancy discipline we already
  implement (setTimeout flush).
- Packaging: they already solve dylib-beside-executable discovery
  (`../Frameworks` lookup) — the pattern to copy for our `.node`.
