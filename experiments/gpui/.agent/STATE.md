# STATE — svelte-desktop mission

## Mission
Validate Svelte + Bun + GPUI + native Rust as a desktop framework. Decide Bun
integration architecture, define V1 native API contract, report what is
production-ready. Fixed: Svelte+TS authoring, Bun runtime, GPUI renderer, no
Chromium/WebView.

## Environment (pinned 2026-09-15)
- macOS 26.5.1 (25F80), Apple M4 Pro, 14 cores, 48 GiB RAM, arm64
- Bun 1.4.0, Rust 1.94.0, cargo 1.94.0
- Disk: 29 GiB free (vendor-GPUI build previously blocked at 1.7 GiB — now possible)
- Repo: /Users/arnaud/code/svelte-desktop — NOT a git repository (no checkpoints possible)
- gpuix-poc: svelte 5.57, @gpuix/native 0.7.0 (NAPI), @quickgui/native 0.1.4-next.1 (bun:ffi)
- app/: SvelteKit 3.0-next app, adapter-bun 1.0.0-next.2, vite 8.1.5

## Key architecture facts (verified this session)
- @gpuix/native = NAPI-RS addon (`@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node`)
  → Bun host + in-process Rust renderer = mission architecture B, already working.
- @quickgui/native = `bun:ffi` + `dlopen` of `libquickgui_host.dylib`, events via
  `quickgui_set_event_notifier`/`drain_events` callbacks = FFI transport, also live.
- gpuix-poc/src/gdom.ts = fake DOM; svelte compiles to DOM ops → op-stream → NAPI batch.
- native/ = owned renderer: gpuix Rust sources on pinned zed fork (git deps), builds sgfx.darwin-arm64.node (23MB); passes all suites when swapped for @gpuix/native; x_button.rs = first native single-element component. Rust 1.97.1 via rust-toolchain.toml.
- app/vite.config.binary.ts = bun build --compile single-binary SvelteKit build.

## Prior session results (all green — re-verified post-fix)
- nkit conformance 30/30, svelte conformance 47/47, qg 45/45, showcase 25/25 pages
- kit conformance 49/49, cargo test --lib 301/301, reliability 11/11
- probe-theme 4/4, probe-adversarial 27/27 (new — see ADVERSARIAL-THEME.md)
- nkit: ~45 components, Theme system, motion/transitions, CVA-style recipes
- Overlay system on real native anchored/mouseDownOutside path

## Mission 2 status (2026-09-15)
- git init done, initial commit 854d535
- 20-launch startup sample: median 293ms, p95 367ms (results/run-20260915-b/)
- QuickGUI live services: 28 inventory entries runtime-tested
- .app packaging: scripts/package-app.ts, embedded .node (external unresolved — known limit)
- $native v2: handles, status/out-param contract, async+cancel — green
- Multi-window: PASS functionally; segfault-on-exit blocker documented
- Reliability: 11/11 (malformed batches, 100k ops, 1k mount cycles, event storm)
- a11y: implicit-role + typed-aria layer in gdom; transport verified, native AX
  materialization still missing (custom props land in retained tree only)

## Mission 3 — brokered platform API (2026-09-16, LIVE)
- `native/src/platform.rs` (~1.6k lines): single JSON dispatcher for 16
  service namespaces; envelopes {ok,value}|{ok:false,error:{code,message}}|
  {pending,id}; pending ops resolve via `platformResult` platform event.
- `renderer.rs`: `UiCommand::PlatformCall` + `#[napi] platform_call` (macOS:
  direct update_window/GPUI_APP; win/linux: ui-channel + SyncSender 2s),
  launch-callback registration both init paths, GpuixView appearance
  observer + PlatformMenuAction seam.
- `element_tree.rs`: `EventPayload.data` (serde_json::Value → JS object).
- `gdom.ts`: PLATFORM_EVENT_ID 0x7fffff02 sentinel → `setPlatformEventSink`.
- `gpuix-poc/src/native-api/`: bus.ts (transport+events+NativeApiError),
  index.ts (typed services), windowState.ts (pure-JS persistence),
  native-api.test.ts (16/16 fake-transport tests).
- `mission-platform.ts` live probe: **52/53 ok, 0 unexpected fails, 1 skip**
  (modal dialogs). Evidence: results/run-2026-09-16-platform/platform.jsonl.
  appearanceChanged events observed ×2; Keychain roundtrip via pending path.
- Honest negatives verified: javascript:→denied, bogus path→invalid_args,
  deepLink.register→unavailable (needs bundled .app), capture→unavailable
  (gpui screen-capture feature off).
- Docs: documentation/platform-api.mdx; spec/native-api.yaml updated (gpuix_platform
  backend, per-op evidence).
- IMPORTANT: pending ops need tick() pumping — executor starves otherwise.
  setSize/fullscreen apply next frame (reads stale until then); fullscreen
  exit animates ~1s — state reads can lag the toggle.
- Reactive API (NORMALIZED, public surface `svelte-desktop/stores`):
  `src/native-api/stores.svelte.ts` → gen/native-api/stores.js (+.d.ts→
  .svelte.ts source); resolved via tsconfig `paths` AND package `#stores`.
  ONE object per domain = $state fields (nullary value-getters) + action
  methods on the same object. Namespaces: app, window, windowState, screen,
  clipboard, theme, system, power, deepLink, menu, notifications, capture,
  diagnostics, capabilities, update — `import {app,theme,secureStorage}
  from 'svelte-desktop/stores'`. secureStorage/shell/dialog re-exported
  verbatim (methods only — no secrets in $state). `initStores()` inits all
  in parallel — failures land on ns.error. Event-fed: appearanceChanged→
  theme, keyboardLayoutChanged→system, thermalStateChanged/systemWake→
  power, openUrls→deepLink, menuAction→menu, notificationResponse→
  notifications, reopened/willQuit/willRestart→app. ZERO-CEREMONY INIT:
  importing the module registers initStores on bus onPlatformReady —
  initPlatform(renderer) flush self-initializes all namespaces (concurrent
  initStores calls share the in-flight boot; post-boot calls re-run).
  Event namespaces expose typed
  `on(event,cb)` (platform-name vocabulary, payload-checked, returns
  unsub): app/theme/system/power/deepLink/menu/notifications. build.ts rewrites `./x`→
  `../../native-api/x.ts` (shared bus singleton). Docs tab "Platform API"
  in blume.config.ts (navigation.actions) + sidebar order 10.5.
  Unit 22/22; Svelte 45/45. Renderer binary regression A/B-confirmed:
  published .node → kit 49/49 + nkit 30/30; our 23:17 build (in-flight
  memoization in renderer.rs) → kit 45/49 (4 form-submit cases) + nkit
  29/30 (c-resizable rz stuck at 50). User-side, surfaced not touched.
  NOTE: `bun install` reverts the .node swap — re-copy
  native/sgfx.darwin-arm64.node over
  node_modules/@gpuix/native-darwin-arm64/ after installs.

## Mission 4 — Electron-parity gap work (2026-09-18, LIVE 73/75)

5 parallel agents → merged. New modules under `native/src/platform/`:
- `power_ext.rs` — getBattery (IOPS {percent|null,charging,external}),
  blockSleep/unblockSleep (IOPMAssertionCreateWithDescription), observers:
  screenLocked/screenUnlocked (CFNotificationCenter distributed),
  systemSleep (NSWorkspace), displaysChanged (CGDisplayReconfigCallback,
  150ms debounce).
- `tray.rs` — NSStatusItem set/create/remove/destroy/isSet/exists; menu
  items → menuAction{id}; trayClick only when no menu (AppKit swallows it).
- `hotkeys.rs` — Carbon RegisterEventHotKey: shortcuts.register/unregister/
  unregisterAll/isRegistered; accelerator parser (CmdOrCtrl/Shift/Alt/Ctrl +
  key table); shortcutPressed+shortcutReleased events; dup/collision→invalid/
  denied.
- `macos_ext.rs` — app.setDockBadge/bounceDock/setActivationPolicy/
  setLoginItem(SMAppService, unavailable unbundled)/requestSingleInstanceLock
  (NSRunningApplication count; dev→{acquired:true}); system.getAccentColor
  (0..1 sRGB)/getAccessibility (NSWorkspace flags); shell.trashItem
  (NSFileManager sync)/beep; menu.popup (NSMenu popUpMenuPositioningItem,
  screen coords, items→menuAction{id}).
- `platform.rs` — window_svc: getPosition/setPosition/setCloseVeto (armed
  flag → on_window_should_close returns false + willClose event; programmatic
  close() bypasses); clipboard: readHtml/writeHtml/readRtf/writeRtf
  (NSPasteboard public.html/public.rtf); observe_window: boundsChanged event
  (full bounds, one event for move+resize) via patched gpui
  `observe_window_bounds`; capabilities matrix updated (macos-only rows).
- GPUI CHECKOUT PATCH (needs upstreaming to remorses/zed):
  gpui platform.rs `PlatformWindow::set_position` (default no-op);
  gpui window.rs `Window::set_position` + `observe_window_bounds` (public,
  mirrors observe_window_appearance into bounds_observers);
  gpui_macos/src/window.rs `set_position` impl — setFrameTopLeftPoint,
  y-flipped vs own screen. `cargo clean -p gpui -p gpui_macos
  -p gpui_platform` REQUIRED after checkout edits (cargo ignores mtimes).
- JS (index.ts/stores.svelte.ts): all new ops + tray/shortcuts namespaces
  (in ALL → 17 namespaces); window.position/setPosition/setCloseVeto +
  boundsChanged/willClose events; screen.on('displaysChanged') auto-refresh;
  system.accentColor/accessibility; power.battery + sleep events; app dock/
  policy/login/lock methods + dockBadge/secondInstanceCount state;
  clipboard.html/rtf; menu.popup. secondInstance typed but NOT emitted
  (needs app-delegate hook). 41/41 tests (was 22).
- Verified live 73/75 (0 fails, 2 skips: dialogs+menu.popup modal):
  battery 100% charging, assertion id roundtrip, position move+restore
  {768,465}→{808,505}→{768,465}, boundsChanged ×11 streamed, tray set/remove,
  hotkey register/unregister, dock badge/bounce, accent {0,.478,1,1}, a11y
  flags, html/rtf roundtrip, trashItem, lock {acquired:true}.
  Conformance re-verified on the patched binary: svelte 45/45, nkit 30/30,
  kit 49/49 (earlier memoization regressions GONE — user's renderer fix
  landed).
- GOTCHAS learned: (1) never `cp` over a .node — kernel rejects the stale
  signature → SIGKILL Code Signature Invalid; deploy via temp+mv (new
  inode). (2) MacWindowState mutex is non-reentrant: set_position must not
  hold self.0 across setFrameTopLeftPoint (windowDidMove delegate re-locks
  → same-thread deadlock). (3) boundsChanged emitted inside a synchronous
  platform op can be dropped — gpui on_moved's re-entrant handle.update
  hits RefCell-already-borrowed (logged, swallowed). (4) clipboard
  formats/has only see gpui-modeled types — readHtml/readRtf work but
  custom UTIs never appear in formats.

## Virtual-list glitch — RESOLVED (2026-09-18)

The 5000-row demo's intermittent one-frame jump had two compounding
causes, both fixed:

1. **live↔leaf width flip** — interactive row subtrees (mouseover/mouseout/
   mousedown/click listeners) were memoizable → the cached leaf pinned to
   parent-allocated bounds (full width) while the live path measured the
   same subtree as a shrink-wrapped layout root (content width). Every
   hover/click flipped 153↔1254px → "translate -x + width change".
   Fix: `MEMO_HAS_EVENTS` (flag 16) in `memo_scan` — any subtree containing
   a listener is excluded from memoization. Memo exists for static
   content only; interactive nodes get nothing from the cache anyway.
2. **pitch clamp** — `gpui::list` measures item *border-box* height via
   `layout_as_root`; **root margins are excluded**. Row was
   `height:40 + margin:3px` → measured pitch 40, but
   `estimatedItemHeight:46` assumed the margin-box. On `remeasure_items`
   (fired by any subtree_revision bump = every hover/click),
   `pending_scroll.offset_in_item` clamped to measured height →
   whole-list snap ≤6px for one frame. Fix: `estimatedItemHeight` must
   equal the measured border-box height; don't rely on item margins for
   row pitch inside `gpui::list`.

Supporting fix: `ListState` default overdraw = 512px > JS `OVERDRAW=8`
rows → rows requested outside the materialized window rendered as blank
`unmounted_virtual_row` placeholders. Demo now sets `overdraw`
explicitly to stay inside the JS window.

Durable invariants:
- Taffy `layout_as_root` shrink-wraps a root `width:auto` (max-content) —
  a bare virtual row is content-width by design; full-width needs an
  explicit `width` or the `.w_full()` focus-handle wrapper.
- `unmounted_virtual_row` placeholders are invisible to the automation
  bounds watcher — a one-frame blank row produces no bounds diff.
- Bounds watcher must run inside the renderer tick loop to see
  frame-transient changes; serialized fields are `x,y,width,height`.
- GPUI `entity.cached` replays only when `cache_key.bounds == bounds` —
  no stale-position replay; `same_box` includes `revision`, so any style
  write forces a live→leaf→replay cycle.

Known remaining hazards (council findings, not yet fixed):
- `reveal_virtual_list_ancestor`/`scrollIntoView` pass an offset array
  instead of a logical index → jump to list top.
- `scroll_virtual_list_to_item` emits `visibleRange` before the queued
  scroll applies; silent scrolls (autoscroll, scrollTo napi) emit none →
  JS window can go stale → placeholder rows possible.

## Mission 5 — Tauri-depth platform API (2026-09-18, LIVE 124/127)
7 parallel implementation agents + orchestrated integration; all landed,
crate green, probe extended and green.

**New native modules** (`native/src/platform/`):
- `window_ext.rs` (~1200 lines) — ~45 NSWindow ops via
  `RawWindowHandle::AppKit → ns_view → [view window]` (zero fork):
  center/hide/show/setBounds (setFrame:display:)/innerSize/innerPosition/
  outerSize/outerPosition/positionTo(8 presets incl tray+cursor anchors)/
  restore/unminimize/isMinimized/setSimpleFullscreen/setAlwaysOnTop(Bottom)/
  blur/isHovered/isActive/chrome flags (resizable/closable/minimizable/
  maximizable via styleMask + zoom-button enable)/setTitleBarStyle(4)/
  setDecorations/setHasShadow+invalidateShadow/setOpacity(0..1 validated)/
  setMovable(ByWindowBackground)/setIgnoresMouseEvents/
  setContentProtected(sharingType)/setVisibleOnAllWorkspaces/
  setDocumentEdited+isDocumentEdited/setTheme(NSAppearance)/
  setMinSize/setMaxSize({0,0} clears)/setCursorHidden/setCursorPosition
  (CGDisplay warp). setFocusable → `unsupported` (no per-window setter).
  App-level: setDockProgress (dock-tile progress overlay), getBundleType,
  defaultWindowIcon (icon TIFF→PNG→b64).
- `events_ext.rs` — GpuixEventsObserver runtime class; appActivated/
  appDeactivated (dual notification-center + AtomicU8 dedup), focusChanged
  {focused} (NSWindow key-status — gpui's on_active_status_change is
  pub(crate), unreachable), scaleFactorChanged {scaleFactor} (backing-
  properties, deduped), secondInstance {argv,cwd} via
  NSDistributedNotificationCenter 'svelte-desktop-second-instance';
  second_instance_post() wired into the lock-denied path.
- `permissions.rs` — system.checkPermission/requestPermission/openSettings
  for accessibility/screenRecording/notifications/fullDiskAccess/camera/
  microphone; secureStorage.authenticate (LAContext biometrics, pending).
  `has_bundle_identity()` guards UNUserNotificationCenter (ObjC exception
  on unbundled binaries is uncatchable — gate, never call).
- `capture_ext.rs` — direct dlopen-gated ScreenCaptureKit (no scap dep):
  isSupported/getSources (SCShareableContent, pending)/captureSource
  (SCScreenshotManager macOS 14+ → pngBase64); stream → unsupported.
- `menu_ext.rs` — menu.update({id,text,enabled,checked,accelerator})/get/
  items (walks NSApp.mainMenu+dock, spec-correlated zip); role→selector
  map (~20 roles); ~55 NSImageName* icon whitelist; app.aboutPanel
  (options dict); apply_item_extras shared with tray.rs + macos_ext
  popup builder; trayClick now carries {x,y,w,h} button rect.
- `app_menu.rs` — added ToggleFullscreen + AboutPanel action types
  (window-level + app-level handlers); `role_menu_item` in platform.rs
  maps menu-item `{role}` → gpui OsAction (edit roles) or app_menu
  actions (quit/hide/…/fullscreen/about/services).
- `permissions::call_notifications` — notifications.getPermissionStatus/
  requestPermission alias the 'notifications' permission name.

**gpui fork** (checkout patched, `native/patches/gpui-fork.patch` —
24.7KB, 23 files, apply --check clean):
- NEW: PathPromptOptions.filters [{name,extensions}] on all 6 platform
  impls; macOS consumes via setAllowedFileTypes (raw-extension union —
  UTType drops unregistered UTIs); prompt_for_new_path gained filters param.
- PRIOR: set_position + observe_window_bounds + div-hover (Mission 4).
- File-drop: NO fork needed — gpui already emits ExternalPaths drops;
  needs a view-level on_drop wire in renderer.rs (not yet done).

**Worker-exit segfault — ROOT-CAUSED + FIXED (quickgui side)**:
FFI notifier outlived worker VM → dead-context deref on next host event.
Fix: process.once('exit') → app.destroy() + clear notifier + postMessage
('stopped'), landed via `bun patch --commit` on @quickgui/native
(patches/ committed). gpuix-side multiwin blockers mapped: thread-local
single window handle, UiCommand/EventPayload lack window_id, global
module singletons in native.ts/gdom.ts.

**TS layer** (75/75 tests, was 41): all new ops typed; store namespace
(JSON KV, 250ms debounce); events namespace (on/once/emit/emitTo);
dpi.ts (Logical/Physical×Position/Size); oncePlatform; Channel<T>
('__channel__:<id>'); initPlatform({allow}) allowlist → denied;
PlatformTransport+mockPlatform; ShortcutRegistration/SleepBlocker/
TrayHandle with Symbol.asyncDispose; window.onCloseRequested
(arms veto + willClose, async disarm); windowState flags.

**Honest errors probed**: setFocusable→unsupported, notifications
perm→unavailable (unbundled), menu.update(missing)→unavailable,
capture→unavailable (screenRecording TCC denied on probe host),
requestPermission(fullDiskAccess)→unsupported→openSettings.

**Crash fixed**: checkPermission(notifications) C++ exception abort on
unbundled binary — UNUserNotificationCenter raises NSException; gated
on bundleIdentifier presence.

**Review pass (TS reviewer bddbd3f2 — FIX-FIRST verdict, all fixed)**:
- P0 envelope lies corrected: windows.isActive→bare bool (window_svc
  shadows window_ext — dead arm removed), ignoresMouseEvents→{ignored},
  isContentProtected→{contentProtected}, capture.isSupported→{supported}
  + CaptureNamespace unwrap (was storing a truthy object → permanent
  error state on macOS<12.3). Test mocks corrected to wire shapes.
- P1: onCloseRequested now subscribe→arm (rollback on fail), disarm→unsub
  — 'veto armed ⇒ handler present' holds at every instant; dispose
  memoized in SleepBlocker/TrayHandle/ShortcutRegistration (double-
  dispose no longer rejects); dialog options → `type` (Record assignability).
- P2: bus malformed-reply guard (rejects not throws), listener isolation
  (throwing cb can't starve siblings), resetForRebind rejects in-flight
  pendings + clears channels; initPlatformForTests flushes readyCallbacks
  (symmetric — mock previews auto-init); stores: simpleFullscreen $state
  (was lying into fullscreen), setSize no longer writes content dims into
  frame bounds, boundsChanged→#syncLater (OS-zoom state staleness), theme.set
  assigns after await, focus() drops optimistic write, tray.remove clears
  fields, thermal/layout/display handler rejections caught, actionLog/urls
  capped at 100, events.emit isolated, store.load()→{} on corrupt JSON,
  store.set(undefined)→delete, windowState validates all 4 bounds fields.
- P3 surface: window.maximize/unmaximize, shortcuts.isRegistered/onReleased,
  tray.isSet wrapped; MenuItemRole context-split documented; updater.check
  catches import failure; menu.popup dismissed-always-true documented.
- wakeCount test made relative (auto-init now subscribes at first mock).

**gpui fork — re-entrant callback fix (new)**: gpui's on_resize/on_moved/
on_button_layout_changed/on_active_status_change/on_hover_status_change
did `handle.update` synchronously → RefCell-already-borrowed when an
AppKit callback fires inside App::update (e.g. setFrame: during a
platformCall) → notification silently dropped. New update_or_defer
helper in window.rs retries via foreground executor on borrow failure
(same pattern upstream uses for on_appearance_changed). boundsChanged
now streams during programmatic ops (~100 events vs ~11 before; zero
RefCell logs). Patch re-exported.

Probe: 124/127 ok, 0 fails, 3 modal skips (dialogs, authenticate
Touch ID, menu.popup). Conformance unchanged: 45/45, 30/30, 49/49.

**Rust FFI review — crash-class fixes (latest)**:
- F1 `menu.popup` nested-runloop abort: popUpMenuPositioningItem: ran
  synchronously inside the platformCall AppCell borrow; its tracking
  loop pumps common-mode sources → any deferred gpui callback re-entered
  → RefCell panic → abort. Now hoisted to the service router as an
  Outcome::Pending op: menu+target retained +1 across the dispatch pool
  drain, tracking runs in cx.spawn on the next executor turn (borrow
  free — menuAction events and boundsChanged pump live during the
  popup), resolves {dismissed:true} via platformResult.
- F2 non-finite geometry: f64_arg now rejects NaN/±inf at the trust
  boundary (JSON 1e999 parses to inf); new opt_f64 for optional args
  (popup x/y, dock total/completed, setMin/MaxSize). Probed: 1e999 →
  invalid_args on setBounds/setPosition/setOpacity.
- F3 SMAppService dead-op: ServiceManagement dlopen'd before
  Class::get (same pattern as capture_ext's ScreenCaptureKit gate) —
  the op now reaches the real bundle-identity guard instead of
  reporting unavailable for a missing class.

Probe after fixes: 130/133 ok, 0 fails, 3 modal skips. Tests 75/75.
Conformance: 45/45, 30/30, 49/49. Release build + deploy (temp+mv)
clean — zero RefCell/crash signatures in the event stream.

## Stylesheet pipeline + /app native boot — LIVE (2026-09-18)

`<style>` blocks in `.svelte` now compile to native rules end-to-end:
lightningcss (`native-css/parse.ts`) → `stylesheet.register` ops →
`native/src/stylesheet.rs` registry matches tag/id/class compound sels,
cascades (spec then order; inline style wins field-wise), and routes
`:hover/:active/:focus/:focus-within/:focus-visible` into StyleDesc
pseudo buckets evaluated by GPUI — **zero JS listeners for CSS states**.
Elements carry `classes` via the `setClass` op (gdom `pushClass`,
deduped). v1 limits: no combinators, no attr-sels/pseudo-elements, no
at-rules (compile-time warnings); `.css` file imports still stripped.

/app boots in the native window: `app/native.ts` →
`gpuix-poc/src/main-app.ts` → `build-app.ts` (compiles app/src →
src/gen-app/) → `app-boot.ts` (kit-app.ts pattern). Remote fns run
in-process through hooks.handle ($app/server → app-compat shim).
`packages/svelte-native/` holds the Vite plugin + adapter + dev CLI
productizing the pipeline (18/18 tests).

Verified: conformance 45/45, kit 49/49, cargo test 299, plugin e2e
18/18, probe-styled + test-app green. remote.svelte.js fixed: firstRun
guard + settled-counter sync read (await-propagation bug).

Hit-test ownership rule (hover-ancestor fix, 2026-09-18): in-flow
elements NEVER carry blocking hitbox behavior — `should_occlude` is
now pointerEvents:auto → occlude, absolute/fixed →
block_mouse_except_scroll, in-flow → nothing. Blocking on a child
truncates `hover_hitbox_count`, cutting ancestors out of the hover
set (and suppressing their mouse listeners). CSS `:hover` covers the
whole ancestor chain, so painted children must stay transparent
backward. Trade: covered in-flow siblings (rare) stay hoverable —
the flat hit test can't tell ancestors from covered elements.
`probe-hover-ancestor.ts` guards the regression; simulate* input
needs `await sleep()` between moves for TSFN event delivery.

## Running processes
- none owned by this session

## Next action
M1+M2+M3 LANDED (2026-09-19): scroll/virtual-list fixes + QG pseudo-state
mirror; fileDrag* end-to-end + event-driven Theme; real multi-window
(registry + windowId dispatch + windows.* API + emitTo/onWindow + probe
green). Remaining for parity: upstream gpui-fork.patch (set_position +
observe_window_bounds + filters + div-hover) to remorses/zed; AX
materialization for generic elements (the big product gap); updater needs
a real feed; Windows/Linux seams; signed/.app packaging gap; `bun install`
restores published .node (re-deploy + re-sign after installs — `cp`
invalidates the Mach-O signature → codesign ad-hoc, see AGENTS.md).
Known multi-window edges: `window not found` ERROR noise on close (gpui
pending-notify .log_err() — benign); reduced-motion frozen after first
appearance event (no a11y-changed event); no-drop drags leave last element
logically inside (no gpui leave callback); secondary-window
getWindowSize/setViewport still primary-scoped in native.ts.

Previous: adversarial fix pass COMPLETE — all 46 findings in .agent/ADVERSARIAL-THEME.md
resolved (fixed, svelai-faithful contract calls, or documented fork/API
limits). Key landed items: color ctx bridge (`data-color`→`color` prop +
`ctxColor` style stamp), full csscolorparser inputs, `with_override`→Result
validation, raised/lift merge guards + full stacks, `style_raw` +
`retheme_subtree` (scoped theme/color + reparent re-resolve), focus buckets,
aspectRatio/fontStyle/textDecoration fields, x-button keyboard+link+spinner+
occlusion+data-highlighted, retry wedge → drop-after-one-retry, setText
string coercion. Documented limits: haspopup/controls/disabled/busy +
letterSpacing (gpui fork), attr-conditional class variants, per-side border
colors, transitions, --current-border, nested-Theme global PALETTE.

Open follow-ups: signed/.app packaging gap remains; multiwin exit segfault;
native AX materialization for generic elements; `bun install` would restore
the published @gpuix/native .node (re-copy native/sgfx.darwin-arm64.node
after installs).

## Monorepo restructure (2026-09-18, COMPLETE — all suites green from new layout)
- gpuix-poc/ dissolved into a bun-workspaces monorepo:
  - packages/gpuix  — Rust crate (native/) + runtime src (gdom/native/native-css/nkit)
  - packages/platform — platform API (src/) + spec/native-api.yaml; @svelte-desktop/platform
  - packages/svelte — kit/, app-compat/, params/, remote.svelte.js, svelte-client.js,
    build.ts + build-app.ts (monorepo compile orchestrators), svelte-native/ plugin
  - packages/tests — cases/, routes/, dashboard/, shadcn/, conformance*, mission-*, probe-*
  - experiments/ — abandoned: shell/ (Electrobun), native-core/ (bun:ffi), native-codegen/
  - app/ stays at root — live SvelteKit demo; app-boot.ts + main-app.ts moved here
- Import model: package specifiers (@svelte-desktop/{gpuix,platform,svelte}) via
  bun workspaces symlinks + exports maps ('./*' → './src/*' probes .ts). #kit/#remote/
  #stores resolved per-package through imports maps; svelte-desktop/stores via root
  tsconfig paths → packages/platform/gen/stores.js.
- gen/ trees are PER-PACKAGE siblings of src/ (gpuix/gen/nkit, svelte/gen/kit+remote,
  platform/gen/stores.js, tests/gen/{cases,routes,dashboard,shadcn,vendor}, app/gen-app).
  build.ts emits package specifiers for cross-package reach (no depth math).
- bun isolated linker: deps live in node_modules/.bun store; root node_modules is
  sparse — deep svelte paths resolve through each package's OWN node_modules
  (svelte-client.js → './node_modules/svelte/src/index-client.js').
- .node binding: single canonical location node_modules/.bun/@gpuix+native@0.8.0/.../
  gpuix-native.darwin-arm64.node (+ sgfx.darwin-arm64.node alias) — all consumers
  symlink to it. Re-deploy libsgfx.dylib after cargo rebuild AND after bun install.
- qg-backend.ts learned stylesheet.register/setClass — JS mirror of the Rust
  StyleSheetRegistry (compound match, spec+order cascade, inline-wins, no state
  buckets, no un-apply) — stylecss passes on the JS backend again.
- Verified post-move: 75/75 platform tests, 45/45 svelte, 30/30 nkit, 49/49 kit,
  45/45 qg, 25/25 pages, 130/133 live probe (0 fails), app boots + paints.
- Circular edge is honest: gpuix nkit components compile → import svelte shim;
  svelte runtime renders through gpuix. gpuix deps include @svelte-desktop/svelte.

## Multi-window adversarial round 2 (COMPLETE — probe 26/26, all suites green)
- Strengthened probe-multiwindow.ts to 26 assertions: `created` event payload,
  real simulated clicks in both windows (explicit windowId + active-window
  default), secondary-element bounds + focus, dup-label rejection,
  non-positive dims, fractional/dead windowId errors, emitTo(0)/onWindow(0),
  post-close element-op death, monotonic id re-allocation, clean exit.
- Bugs the stronger probe caught and fixed:
  - `windows.create` allocated NEXT_WINDOW_ID before validating dims —
    rejected creates burned ids (probe saw 4 instead of 2). Allocation now
    runs after all validation.
  - `GpuixView::new` accepted a `clock` param but the struct body still
    hardcoded `AutomationClock::new()` — the shared app-global clock never
    landed. Now stores the passed instance; every window shares one Arc.
  - `materializeRoot` never replayed the root's own attrs/_customProps/
    listeners — `setAttribute('tabindex')` before mount vanished (nativeId
    didn't exist for the direct emit). New `emitElementProps` shared between
    materialize/materializeRoot — root tabindex/role/aria/listeners land.
  - `simulate_*` (click/mouse/key/wheel) hardcoded window 0 — new optional
    trailing `windowId` (validated like platform routing; default = active
    window, matching real input semantics).
- Focus semantics verified: getFocusedElementId reports the KEY window's
  focused element — element focus follows `windows.focus(id)` making the
  window key. gpui keeps window.focus through resign (no auto-blur).
- filedrop.test updated: materialize now (correctly) emits delegated-type
  listeners for roots — test isolates addEventListener emits via drainOps.
- Suites: svelte 45/45, nkit 30/30, kit 49/49, qg 45/45, pages 25/25,
  bun 212/0, multiwindow probe 26/26 PASS, clean last-window-close exit.

## Council review pass (COMPLETE — all findings fixed, verified green)
- 4-agent adversarial review of titlebar/pressTarget/resize/runloop work.
  ~30 findings; all Critical/High/Medium landed + most nits swept.
- renderer.rs: press guard = `pressTarget && has windowDrag ancestor`
  (live ancestor walk — no collateral outside drag regions); focus fixed
  via prevent_default ordering; window_drag_arm cleared on up-outside,
  dblclick, and >=3 clicks; tick() clamps waits to [0,1000]ms;
  custom_prop_present helper dedups Null|Bool(false) truthiness checks.
- gdom.ts: refreshPressTarget lifecycle (recompute+retract on listener
  add/remove, role/contenteditable/type/href, backfill, lazy dispatch);
  pointer/touch press types; removeEventListener emits gpuixEvent name +
  listenerFeedClaimed guards implicit feeds; pointerdown/up→mouseDown/Up,
  touchstart/end→mouseDown/Up, dblclick→click feed mappings (fixes dead
  setEventListener ops AND makes those DOM listeners actually fire);
  NATIVE_FANOUT mousedown→pointerdown, mouseup→pointerup.
- gpui fork: display-link armed only when not running (was a full
  CVDisplayLink teardown per AX write); non-live displayLayer defers
  render to step; take_pending_resize keeps flag without callback;
  scale-factor delivery clears pending; update_or_defer bounded (8);
  pump_events re-entry logs+returns (no panic across NAPI).
- Probe: cge.swift vendored to packages/tests/bin/, `raise <pid>`
  activates the app so CGEvents land (NSRunningApplication.activate —
  no TCC needed); titlebar probe uses user-select:none like the app;
  covers tabindex focus inside+outside drag region + delegated handler.
  13/13 PASS.
- Discovery: dblclick on selectable text calls window.blur()+word-select
  (paint.rs, intentional — the probe's "still focused" check needs the
  user-select:none bar).
- Suites: 84/48/30/49/45/25 + 63 bun:test all green; dylib deployed+signed.

## Delegated events rework (LANDED — regression found + fixed, all green)
- Svelte's delegated types no longer backfill `setEventListener` onto every
  element: `document.addEventListener(type)` → one `setDelegatedEvents` op;
  `tree.delegated_events` + `RetainedTree::dispatches` is the shared gate
  (build-time union `element.events ∪ delegated`, custom elements read
  `ctx.delegated`, AX pressability consults it). Focus/key stays
  element-scoped; fileDrop/visibleRange/highlight stay element-only;
  native.ts replays the set on rebind; qg-backend mirrors it.
- Regression 1 — memoization engaged for the first time (backfill had kept
  every element MEMO_HAS_EVENTS). A subtree memoized before the delegated
  set landed replayed a listenerless view. Fixed: memo_scan flags
  MEMO_HAS_EVENTS while delegated_events is non-empty; the apply arm runs
  new `invalidate_render_caches()` (bumps all subtree_revisions → kills
  stale scans + memo entries) + repaints roots.
- Regression 2 — delegated listeners wired onto `text` elements (gdom
  never emitted listeners for nodeType 3, so the deepest emit used to be
  the real element). Text became the click target → `instanceof GElement`
  activation walks bailed → all `<a>`/submit navigation died (49→34).
  Fixed: `dispatches` + the wiring loop exclude delegated types on
  `element_type == "text"` — text is never a DOM event target.
- Verified: cargo 314/314, platform 84, svelte 51, nkit 30, kit 49/49,
  qg 45, pages 25, unit 243. Dylib rebuilt/deployed/signed.
- Gotcha: run kit-conformance FROM packages/tests — `read('hooks.ts')`
  resolves against process cwd; running from root fails 4 cases fake.

## Svelte in:/out: transitions → real native motion (LANDED, probe-verified)
- Svelte 5 transitions: `css(t)` → pre-eased keyframes → `element.animate()`.
  gdom needed two honest fixes: `getComputedStyle` now merges class props +
  inline props over DOM defaults (opacity:1, position:static) with painted
  bounds winning for width/height (was inline-only → opacity ''→0, height
  NaN → slide silently collapsed to no-op); `GElement.animate()` samples
  piecewise across ALL keyframes honoring `offset` (was first→last —
  flattened svelte's baked easing to linear). currentTime/playState/
  cancel/effect-setting cover svelte's bidirectional + abort paths.
- probe-slide-transition.ts + cases/slide.svelte: samples REAL native
  bounds mid-transition via TestGpuixRenderer — vertical slide eases
  60→43→30→…→0 (cubic_out shape preserved), horizontal collapseX eases
  199→143→99→…→0 (cubicOut). 10/10 pass. Fixture not in conformance list.
- app/+layout.svelte: sidebar collapses via `in:collapseX`/`out:collapseX`
  — custom transition animating width (svelte `slide` is vertical-only).
  `style="width:200px"` inline seeds the pre-paint computed measure;
  `.sidebar-in` owns the padding so collapse clips to 0 cleanly. Toggle
  lives in the titlebar (`‹/› sidebar`) so it survives the collapse.
- vite-plugin fix: `native-css/parse.ts` import used extensionless
  `../native-attr` — fine under Bun, broken under node's type-stripping
  (vite dev runs node) → plugin's raw `import()` threw → ALL <style> rules
  silently dropped in dev. Fixed to `../native-attr.ts` (sanctioned exact-ts).
- Bounds quirks: automation bounds are border-box (200px rail + 1px border
  reports 199); probe asserts >=199.

## rAF rides native vsync — `requestFrame` op + `frame` event (LANDED)
- gdom rAF was `setTimeout(16)` — ~62fps ceiling, not vsync-aligned, kept
  ticking on occluded windows. Now: `requestAnimationFrame` queues into a
  Map and emits a `["requestFrame"]` batch op; the op marks every
  root-hosting window in `outcome.windows` (window 0 when roots is empty)
  → `invalidate_after_batch` notifies → next vsync render →
  `GpuixView::render` emits a `frame` EventPayload (element_id =
  WINDOW_EVENT_ID 0x7fff_ff01) → `dispatchPayload` intercepts it before
  document dispatch and drains the queue. Cadence follows the display,
  bounded by the host pump — emit.js polls the runloop at ~16ms so
  ~60Hz effective today; the mechanism itself has no ceiling. Occlusion
  IS real: gpui stops the display link when the window is fully occluded
  → no renders → no frames → watchdog-only ticking.
- Browser semantics kept: callbacks queued during a drain run next frame
  (queue swap), cancel deletes by id, per-cb try/catch (a throw reports
  and continues, never loses same-frame siblings), one op per pending
  queue (emit() also coalesces duplicate requestFrame ops — an unbound
  renderer would otherwise pile them up forever).
- Multi-window: every root window wakes + emits `frame`; a second
  window's same-cycle event (<4ms after the last tick, different
  windowId) is suppressed — rAF can't run at N× vsync.
- Fallbacks: TestRenderer ignores outcome.windows — every `flush()`
  renders and emits `frame` (consecutive undrained frame payloads
  coalesce in the event Vec), tests tick at pump cadence; qg mirror
  ignores the op; a one-shot `applyBatch('[["requestFrame"]]')` probe at
  first rAF proves dylib support — old bindings take the 16ms timer lane
  permanently instead of poisoning every animation batch (decode fails
  atomically → probe is side-effect free); 250ms watchdog ticks when no
  frame lands.
- HMR realm safety: `__svelteNativeHost.rafGen` is claimed at gdom module
  eval — a stale realm's watchdog/queue/rAF registrations die with the
  realm instead of leaking adopted callbacks at full rate.
- animate() pause()/play() now real: pause freezes currentTime + stops
  the step chain; play shifts the start clock by the paused span.
- probe-raf.ts: 14/14 — op reaches native (Proxy-spied), tick on frame
  event, ordering, nested-next-frame, cancel, no-render-no-tick,
  watchdog (400ms margin), throw-sibling survival, cross-window
  coalescing, requeue chain.
- Rebuilt dylib + redeployed + re-signed (all 4 .node copies).

## Animation effect layers + CSSOM '' semantics — rapid-toggle fix (LANDED)
- Bug: rapid sidebar open/close left the rail stuck at a mid-flight size
  (e.g. width:48px, opacity mid-state, `overflow:"undefined"` literal).
- Root causes found via probe-rapid-toggle.ts + anim lifecycle tracing:
  1. `in:`/`out:` compile to TWO separate `$.transition` managers — on
     reopen the intro manager's `in()` runs FIRST while the outro anim
     is still live → `getComputedStyle` captures the mid-flight width →
     `collapseX` bakes `w=48` into its keyframes → intro animates to the
     wrong target. Browser-faithful quirk; self-heals IF cancel works.
  2. `animate()` wrote keyframes straight into `style.props` and
     `cancel()` left them → the animation's last frame persisted forever
     (WAAPI: cancel drops the effect → authored style resurfaces).
     Worse: `in:`/`out:` non-reversal means the intro keeps running
     CONCURRENTLY with the outro — two anims clobbering one props map.
  3. `style.overflow` returned `undefined` for unset props — svelte's
     capture/restore wrote the literal string "undefined" to the wire.
- Fix — cascade model: `GElement.animFrames: Map<animKey, Map<prop,val>>`
  — each animate() writes its own layer; `mergedStyleProps()` overlays
  class ∪ author props ∪ live anim frames in creation order (later wins
  = WAAPI stacking). `cancel()` just deletes the layer — underlying
  values resurface, no restore bookkeeping, no chained snapshots.
  `finish()` honors fill (forwards/both keep last frame; none drops).
  `finished` now rejects AbortError on cancel (internal catch — svelte
  never awaits it). `finish()` early-returns when cancelled so a queued
  zero-duration settle can't resurrect styles.
- CSSOM parity in the GStyle proxy: unset props read `''` (not
  undefined); assigning `''`/`null`/`undefined` deletes the declaration
  — `el.style.x` reads the AUTHOR layer (animations never appear in the
  inline declaration — browser behavior); `getComputedStyle` sees the
  merged+animated state (also browser behavior).
- Second fix in the same pass — qg/mirror rAF starvation: the 250ms
  watchdog lane (occluded-window case) only engages after a frame event
  has actually arrived (`framesSeen`). Backends that never emit frames
  (qg JS mirror accepts requestFrame as a no-op) stay on the 16ms lane —
  was starving fade-out's outro (pump window < watchdog).
- Verified: probe-rapid-toggle 9/9 (end state = pure authored
  {width:200,border:1}), slide 12/12, raf 14/14, qg 45/45, conformance
  51/51, nkit 30/30, unit 244/244.
- Note: `in:`/`out:` are non-reversible BY SVELTE DESIGN — a mid-outro
  reopen briefly animates toward a stale target then snaps to authored
  at introend-cancel (same as a browser). Smooth reversal needs
  `transition:collapseX` (one manager, shares options + picks up t()).

## Native CSS transforms — fly/scale transitions LANDED (gpui-fork + renderer)
- `StyleDesc.transform`/`transformOrigin` (camelCase serde) — the JS side
  already passed both through `styleObject` verbatim; they were silently
  dropped on a nonexistent field. Svelte `fly`/`scale`/`crossfade` emit
  `transform:` strings + `opacity:` — opacity worked, transform didn't.
- `native/src/transform.rs`: CSS 2D transform parser (translate[/X/Y/3d
  with z=0], scale[/X/Y], rotate, skewX/Y, matrix) + transform-origin
  (px/%/keywords, default 50% 50%) → `gpui::TransformationMatrix`. Whole
  declaration rejects on any unparseable function (CSS all-or-nothing).
- `Transformed` element wraps the built subtree in `build_element`'s common
  tail — layout untouched, matrix resolves against painted bounds at
  prepaint+paint (origin % + % lengths need real bounds). Memoization safe:
  transform rides `StyleDesc` → subtree_revision invalidates as usual.
- gpui-fork patch grew: `Window::element_transform_stack` composed
  child-then-parent (CSS nesting), `transformation` field on Quad/
  Underline/Strikethrough/Shadow/PolychromeSprite (monochrome/subpixel
  sprites already had it), hitboxes + content masks transformed to AABB
  (conservative under rotation — exact would need polygon clips),
  defer_draw captures+restores the active transform, Primitive culling
  uses transformed bounds. `scale_translation` converts the Pixels-space
  stack matrix to ScaledPixels at scene-primitive attach.
- shaders.metal: quads/shadows/underlines/polychrome sprites use
  `to_device_position_transformed` + `distance_from_clip_rect_transformed`
  (existed for sprites); fragments inverse-transform position for
  local-space SDF so corner radii/borders stay exact under scale+rotate.
- `bounds_tracker` + `track_own_bounds` apply `element_transformation()
  .apply_bounds` → `getBoundingClientRect`/automation bounds report the
  painted (transformed) rect — matches CSS where transforms are visual.
- probe-transform.ts + cases/fly.svelte: 15/15 — mid-flight bounds
  displaced (fly) / shrunk (scale), getComputedStyle exposes the
  transform string (svelte composes onto it), exact rest convergence,
  no residue on the author layer, clean unmount/remount.
- `blur` keeps only its opacity half — `filter`/`backdropFilter` have no
  StyleDesc field (documented in limitations). `draw` still needs
  getTotalLength.
- cargo --lib 324/324 (9 new parser tests), bun:test 257/257, all suites
  green. gpui-fork.patch re-exported; dylib deployed+signed (4 copies).

## Sparse-keyframe interpolation + /animations showcase page (LANDED)
- Bug found while building the page: `animate()`'s `interp` used
  `parseFloat` — `'scale(1)'`/`'translate(10px)'` → NaN → snapped to
  keyframe A until t=1. Svelte transitions only looked right because they
  bake ~60 dense keyframes (staircase). Sparse WAAPI keyframes never
  interpolated transforms.
- Fix: same-skeleton interpolation — split on numbers, compare the
  non-numeric skeleton, interpolate each numeric slot
  (`scale(1)`→`scale(1.4)` tweens; works for `rgba()`, shadows, any
  same-shape string). Mismatched skeletons stay discrete (WAAPI
  incompatible-shape behavior).
- app/src/routes/animations/+page.svelte + /animations nav item —
  three-lane showcase: svelte transitions (fade/fly/scale/scale-origin/
  slide/blur-honest/custom spinIn rotate+scale), crossfade send/receive
  lanes, animate:flip reorder, imperative element.animate() (burst,
  infinite-alternate pulse+cancel, pause/play marquee, .finished chain),
  and an honest CSS-animation gap card (@keyframes parser-dropped, dead
  declaration vs same keyframes via animate()).
- cases/motion.svelte + probe-motion.ts: 13/13 — rotate mid-flight,
  blur opacity path, crossfade hop, flip transform mid-reorder,
  interpolated burst, infinite pulse+cancel.
- animate:flip works — bounds deltas → translate keyframes (was
  "untested" in limitations).

## Animation freshness + CSS animation — LANDED (2026-09-19)
Second animation pass — the user's "everything is broken" report traced to
three real bugs, all fixed and probe-verified:

- **Stale layout reads** — `getBoundingClientRect`/computed size read
  painted bounds which lag DOM mutations; svelte `slide`/`crossfade`/`flip`
  capture rects at transition-creation → stale/zero → slide stopped at the
  text boundary, crossfade landed wrong, flip did nothing. Fix:
  `boundsDirty` flag on every `emit()`; `measureBounds()` (flush +
  `renderer.measureLayout()`) runs before any bounds read. Native side:
  `UiCommand::Measure` + `#[napi] measure_layout` — macOS does
  `window.draw(cx)` **without `present()`** + `cx.notify()` (draw/present
  are separate calls in this fork — draw runs prepaint+paint+bounds
  listeners without showing the frame; notify guarantees a fresh draw
  preempts the pending present). Same for the non-macOS UiCommand path.
  TestGpuixRenderer.measureLayout = flush.
- **Microtask-before-paint ordering** — svelte defers transition setup one
  microtask ("all measure the DOM first... before the next paint"). The
  probe harness drew synchronously after dispatch → caught the un-pinned
  mount frame = artificial intro flash. `pumpOnce` now `await sleep(0)`
  before flushing — matches compositor semantics (paint only after the
  task's microtasks drain). In production `emit()` schedules flush via
  setTimeout so microtasks always drain first — mount+pin land in one
  batch, the pinned frame is what presents. probes: slide 12/12 with
  intro `0 → 10 → … → 60`, no flash.
- **Unit-aware interpolation** — `translateX(0)` vs `translateX(-160px)`
  produced different skeletons (`px` stayed literal) → discrete snap →
  marquee/chain dead. `interp` now tokenizes number+unit slots; a bare 0
  adopts the counterpart's unit; incompatible units stay discrete.
- **Missing keyframe endpoints (WAAPI)** — `animate([{transform:'rotate(360deg)'}])`
  and `@keyframes x { to {...} }` interpolate from the element's
  *underlying* computed value (captured before first apply, so the layer
  can't feed back). `'none'`/`'auto'`/`''` opposite a function list means
  identity — expanded to the other side's shape (scale→1, others→0,
  units preserved).
- **animate() options** — added `easing` (CSS keywords + cubic-bezier
  subset via CSS_EASINGS map) and full `direction` support
  (reverse/alternate/alternate-reverse incl. final-iteration rest state).
- **Declared CSS animation** — `@keyframes` + `animation:`/`animation-*`
  extracted by native-css/parse (selector-matched animation rules), ride
  `registerSheet` (id, rules, keyframes, animations) → gdom
  `registerCssAnimations`/`reconcileCssAnimation` lowers matching
  declarations onto `el.animate()` — the same CSS→WAAPI lowering browsers
  do. Cascade picks the winning rule by specificity → sheet order →
  source order; spec change restarts, no match cancels. `iterations:
  'infinite'` is a string in the wire payload (JSON.stringify(Infinity)
  → null). Parser 74/74; probe-motion 17/17 incl. `to`-only keyframes
  rotate() mid-flight, marquee px interpolation, .finished chain→done.
- **Still honest**: `filter: blur()` remains opacity-only — no element-level
  filter primitive in GPUI (would need offscreen subtree + blur pass).
  `transition:` shorthand still has no channel.
- Battery: slide 12/12, motion 17/17, transform 15/15, rapid-toggle 9/9,
  raf 14/14, qg 45/45, conformance 51/51, nkit 31/31, kit 49/49,
  pages 25/25, bun:test 271/271, cargo --lib 324/324.
- **Present suppression (in-flight flicker fix)** — the mount batch's
  `invalidate_after_batch → cx.notify()` could let a display-link tick
  draw+present the un-pinned scene before Svelte's microtask pin lands
  via `setTimeout` flush. gpui fork gained `Window::suppress_presents_until`
  / `clear_present_suppression` + a `present()` gate (early-return keeps
  `needs_present` → retry, not drop). `measure_layout_now` holds presents
  48ms around its forced draw; the next batch's invalidate releases the
  hold so the pinned frame presents on the first tick. Single-thread
  runloop ⇒ ticks only fire at event-loop boundaries → deterministic.
- **Double-lease panic fixed** — `window.draw` inside `update_window`'s
  GpuixView lease crashed once the tree memoized (`GpuixSubtree::render`
  re-leases the root view → `double_lease_panic`). Measure now draws via
  `update_window_without_view_in` (AnyWindowHandle) + notifies separately;
  same split in the non-macOS `UiCommand::Measure` arm. App survives
  startup + 95s idle (was crash-looping at ~24s).

- **gdom getComputedStyle longhands** — slide residual-padding stall and
  flip NaN transforms both traced to shorthand-only computed style:
  Svelte reads longhands (paddingTop…) + transformOrigin/zoom. Now
  expands box shorthands, resolves transformOrigin to px (center
  default), zoom '1', transform 'none'. Chip collapses 35.5→0, flip
  emits real translate deltas. blur remains honest opacity-fade.

- **Reversal freeze fix** — `Animation.currentTime` is now a live getter
  (was stored-per-step → stale pin on `counterpart.t()`); `apply()`
  flushes synchronously so animation writes never ride the setTimeout(0)
  hop past a vsync boundary. NonBlocking tsfn ⇒ JS never inside a native
  update, so sync applyBatch is safe anywhere. probe-anim-timing 2/2.
