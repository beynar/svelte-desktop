# gpui-fork.patch

Complete diff of all local modifications to the vendored gpui checkout
(`remorses/zed` @ `81c99f816b4a5f69d3c014774068034c24d1d7af`), exported for
upstreaming. Apply with `git apply` inside the zed checkout root.

The patch contains several logical changes, grouped below by change — the
diff itself is ordered alphabetically by path, so the sections interleave.

## 1. Window positioning + bounds observation (pre-existing)

Upstream context: `PlatformWindow` exposes `resize()` for content size but no
way to move a window programmatically, and no way to observe window-bounds
changes from user code (e.g. to forward `boundsChanged` to a JS layer).

- `crates/gpui/src/platform.rs` — `PlatformWindow::set_position(&self, _position: Point<Pixels>)`
  added as a **default no-op** trait method (next to `resize`), so other
  platform backends are not broken. Extends `PlatformWindow`.
- `crates/gpui/src/window.rs` —
  - `Window::set_position(&mut self, position: Point<Pixels>)` — public
    forwarding API. Extends `Window`.
  - `Window::observe_window_bounds(callback) -> Subscription` — registers a
    `FnMut(&mut Window, &mut App)` invoked whenever window bounds change
    (move *and* resize; inspect `window.bounds()` to distinguish). Built on
    the existing `pub(crate) bounds_observers: SubscriberSet<(), AnyObserver>`
    field (window.rs:1184) that `Window::changed()` already notifies.
- `crates/gpui_macos/src/window.rs` — `MacWindow::set_position` impl: converts
  the top-left-anchored `Point<Pixels>` into AppKit's bottom-left-origin screen
  coordinates (`setFrameTopLeftPoint:`), mirroring how `bounds` is computed.
  Releases the state lock before calling AppKit because `windowDidMove` fires
  synchronously and re-locks `self.0`.
- `crates/gpui/src/elements/div.rs` — hover re-check fix in
  `Interactivity::paint`: the deferred `update_hover` callback re-evaluates
  `hitbox.is_hovered(window)` at execution time instead of trusting the value
  captured during prepaint, which could resurrect a hover that a leave
  transition already suppressed.
- `crates/gpui/src/window.rs` — re-entrant platform-callback fix (new): the
  `on_resize`/`on_moved`/`on_button_layout_changed`/`on_active_status_change`/
  `on_hover_status_change` registrations now retry through the foreground
  executor when the AppCell is already mutably borrowed (a local
  `update_or_defer` helper). Previously a synchronous AppKit callback fired
  during `App::update` (e.g. `windowDidMove` inside a platform-driven
  `setFrame:` call) failed `handle.update` and silently dropped the
  `bounds_changed`/`active`/`hovered` notification via `.log_err()`.
  `on_appearance_changed` already deferred unconditionally upstream; the new
  helper keeps the direct update for the common case and only defers on
  borrow failure.
  - Retries discriminate on `BorrowMutError`: contention re-queues unbounded
    (every App borrow is a synchronous scope that must release; under
    re-entrant AppKit runloop pumping every queued drain can land inside a
    borrow for as long as outer calls continue, so no fixed bound is safe),
    while any terminal error — closed window, quitting/released app — stops
    the retry instead of spinning.
  - The `on_request_frame` callback path (`step`) treats a contended
    `handle.update` as a missed vsync rather than an error — the invalidator
    stays dirty and `wake_platform` re-arms the frame source — via a shared
    `or_log_unless_borrowed` helper that still logs non-borrow failures.
    `next_frame_callbacks` are now `take()`n *inside* the update so a
    contended borrow no longer drops queued rAF callbacks.

## 2. File-type filters for path prompts (new)

Upstream context: `prompt_for_paths` (open dialog) took `PathPromptOptions`
with `files`/`directories`/`multiple`/`prompt` but no way to restrict
selectable file types, and `prompt_for_new_path` (save dialog) took no
options at all. This adds an Electron-style `filters: [{ name, extensions }]`
capability to both.

### gpui API (`crates/gpui`)

- `platform.rs`
  - `PathPromptOptions` gains `pub filters: Vec<PathPromptFilter>` and now
    derives `Default` (all existing fields default cleanly: `bool -> false`,
    `Option -> None`, `Vec -> empty`), so struct literals can use
    `..Default::default()`.
  - New `PathPromptFilter { name: SharedString, extensions: Vec<SharedString> }`
    — mirrors Electron's `FileFilter`; `name` is the display label, extensions
    have no leading dot.
  - `Platform::prompt_for_new_path` gains a `filters: Vec<PathPromptFilter>`
    parameter (the save-panel prompt previously took no options struct, so the
    filter list is threaded as an explicit argument).
- `app.rs` — `App::prompt_for_new_path` forwards the new `filters` argument.
- `platform/test/platform.rs`, `platform/visual_test.rs` — test/visual
  `Platform` impls accept (and ignore) the new parameter.
- `app/test_context.rs` — two `PathPromptOptions` literals updated with
  `..Default::default()`.

### macOS implementation (`crates/gpui_macos/src/platform.rs`)

- New helper `set_panel_file_type_filters(panel, filters)` unions the
  extensions of all filters into a single `NSArray<NSString*>` and applies it
  via `setAllowedFileTypes:` on both `NSOpenPanel` (`prompt_for_paths`) and
  `NSSavePanel` (`prompt_for_new_path`).
- `allowedFileTypes` (soft-deprecated since macOS 12, still functional) is used
  instead of `allowedContentTypes`/`UTType` because it accepts **raw extension
  strings**: `UTType typeWithFilenameExtension:` returns nil for extensions
  without a registered UTI (e.g. `"rs"`), which would silently drop such
  filters. Chromium/Electron make the same choice for arbitrary extensions.

### Other platforms (`gpui_windows`, `gpui_linux`, `gpui_web`)

`prompt_for_new_path` signatures accept the new `filters` parameter but do not
consume it (`_filters`), so the trait stays uniform while the implementation
is macOS-only for now — matching `PathPromptOptions::filters`' doc note
("currently only implemented on macOS"). Windows could wire
`IFileOpenDialog::SetFileTypes`/`IFileSaveDialog::SetFileTypes` and Linux
`ashpd::desktop::file_chooser::*Request::filters` later.

### Caller updates

- `prompt_for_new_path` callers pass `Vec::new()` (no filters):
  `workspace.rs` (~3191), `collab_ui/src/call_stats_modal.rs`,
  `miniprofiler_ui.rs`, `etw_tracing.rs`.
- All 15 `PathPromptOptions` struct literals gain `..Default::default()`:
  `zed.rs` (×3), `workspace.rs` (×3), `recent_projects.rs` (×2),
  `project_panel.rs`, `git_ui/src/clone.rs`, `extensions_ui.rs`,
  `agent_ui/threads_archive_view.rs`, `agent_ui/message_editor.rs`,
  `gpui/app/test_context.rs` (×2).

## 3. Coalesce accessibility-driven resize storms (new)

Upstream context: `displayLayer:` renders synchronously for every
`setFrame:display:` — correct for user edge-drags (AppKit paces live-resize
notifications to vsync) but pathological for window managers
(Rectangle, Swish, AX scripts), which call
`AXUIElementSetAttributeValue` on position/size far faster than vsync.
Each call blocked the AX client on a full synchronous render +
transaction-present, so AX calls queued on the main thread and the
window kept resizing seconds after the gesture ended.

- `crates/gpui_macos/src/window.rs` — in `display_layer`, a
  non-live-resize delivery consumes any pending resize and then defers
  the *render* to the display-link `step` (vsync), so a write storm gets
  at most one draw per frame at the latest size. If the link cannot run
  (occluded window, no screen) it falls back to a synchronous render
  rather than dropping the frame. Live-resize keeps the synchronous
  path.
- `crates/gpui_macos/src/display_link.rs` — `WindowFrameSource` gains
  `is_running()` (registration alive). `set_frame_size` and
  `display_layer` arm the link only when not running — previously every
  AX write ran `stop → unsubscribe → CVDisplayLinkStop → subscribe →
  CVDisplayLinkStart` plus two registry mutex trips under the
  `window_state` lock.

## 4. Continuous runloop service + deferred programmatic resizes (new)

Upstream context: `MacPlatform::pump_events` (embedded mode) drained the
NSEvent queue and ran `CFRunLoopRunInMode(mode, 0, true)` once per call —
~µs of runloop service per host tick. Mach-port sources (AX MIG attribute
writes, timers, wakes) only dispatched inside that sliver, so every
`AXUIElementSetAttributeValue` from a window manager blocked ~one tick
(~16ms) waiting for service, and each `set_frame_size` ran the resize
callback — which draws synchronously — inline. A 40-write Swish gesture
took ~7s to settle on the host app while the same storm cost Zed ~2.9s.

- `crates/gpui_macos/src/platform.rs` — `pump_events(wait_seconds: f64)`:
  after draining the NSEvent queue it runs
  `CFRunLoopRunInMode(mode, wait_seconds, false)`, so each host tick is a
  bounded `NSApp.run` slice and sources dispatch on arrival. `0.0`
  preserves the old pump-only behavior. `pump_app_nonblocking` renamed to
  `pump_app` for accuracy.
- `crates/gpui_macos/src/window.rs` — `MacWindowState` gains
  `resize_pending: bool`. `set_frame_size` outside `inLiveResize` now only
  calls `super.setFrameSize`, sets the flag, and arms the display link;
  `take_pending_resize` applies `update_drawable_size` at the *current*
  size and returns the callback, consumed by `step` (every vsync) and by
  `display_layer`. The flag survives a missing `resize_callback` (checked
  out or not yet registered) so `bounds_changed` is delivered once the
  callback exists, and `update_window_scale_factor` clears it when it
  delivers — no duplicate notification. Live-resize is untouched — user
  edge-drags still update drawable + callback synchronously per vsync
  notification.
- `crates/gpui_macos/src/platform.rs` — a nested `pump_events` (re-entry
  through a dispatched source reaching back into the host) logs and
  returns instead of panicking — a panic across the NAPI boundary aborts
  the host.
- `crates/gpui/src/window.rs` — the `update_or_defer` retry (§1) no longer
  uses a fixed attempt bound: contention retries until the borrow clears,
  and terminal failures (window dropped mid-deferral, app quitting) stop
  rescheduling because they don't match `BorrowMutError`.

Measured effect (host app, 40 rapid `AXSize` writes): writes 649ms → 28ms
total, post-write settle 6.4s → ~0ms. Zed on the same storm: 16ms writes,
2.8s settle.

## 5. Letter-spacing (`tracking`) at shape time (new)

CSS `letter-spacing` support, threaded through the text pipeline so
hit-testing, wrapping, and cache keys stay consistent:

- `crates/gpui/src/text_system/line_layout.rs` — `FontRun.letter_spacing:
  Pixels`. `FontRun` is `Eq + Hash` and rides inside every layout-cache key,
  so tracked and untracked runs can never collide in the cache.
- `crates/gpui/src/text_system.rs` — `TextRun.letter_spacing: Pixels`
  (defaults `px(0.)`); `shape_text`/`layout_line` carry it into `FontRun`s,
  and the run-merge conditions compare it so a tracking change mid-text
  splits the run (same "don't merge" lane as decoration changes).
- `crates/gpui/src/style.rs` — `TextStyle.letter_spacing: Option<Pixels>`
  (Refineable — inherits/cascades like the rest of `TextStyle`), `to_run`
  sets it on produced `TextRun`s.
- `crates/gpui/src/styled.rs` — `Styled::letter_spacing(impl Into<Pixels>)`
  builder.
- `crates/gpui_macos/src/text_system.rs` — applies it natively via
  `kCTKernAttributeName` (CoreText kern adjustment, points added to every
  glyph advance in the run) — shaping, hit-testing, and wrapping all see
  the spacing for free. Linux/Windows shapers ignore the field for now.

## 6. Extended ARIA properties (new)

`AriaProperties` + `StatefulInteractiveElement` builders +
`Interactivity::write_a11y_info` coverage for the aria attrs that had no
gpui hook (accesskit 0.24 already exposes all the setters):

- builders: `aria_disabled`, `aria_busy`, `aria_hidden`, `aria_modal`,
  `aria_read_only`, `aria_required`, `aria_role_description`, `aria_live`,
  `aria_invalid`, `aria_has_popup` (`accesskit::Live`/`Invalid`/`HasPopup`)
- `write_a11y_info` maps them to `set_disabled`/`set_busy`/`set_hidden`/
  `set_modal`/`set_read_only`/`set_required`/`set_role_description`/
  `set_live`/`set_invalid`/`set_has_popup`. accesskit flag props are
  set/clear pairs — `aria-*="false"` calls `clear_*`.
- Still unwired: the reference attrs (`aria-controls`, `aria-owns`,
  `aria-describedby`, `aria-details`) — accesskit takes `Vec<NodeId>` and
  doesn't resolve author-id strings at node-build time.

## 7. Position/bounds fallback for not-yet-ordered windows (new)

`NSWindow.screen` is `nil` until a window is ordered in (`orderFront`/
`makeKeyAndOrderFront`). Hidden or alpha-staged windows therefore had no
screen, which broke two ops:

- `crates/gpui_macos/src/window.rs` — `MacWindow::set_position` silently
  returned when `screen == nil`, so positioning a hidden window did nothing.
  Now falls back to `screens[0]` (the primary display), matching the
  `window_screen()` policy used by the platform ops.
- `crates/gpui_macos/src/window.rs` — `MacWindowState::bounds` returned a
  `(0,0, DEFAULT_WINDOW_SIZE)` placeholder for unordered windows, losing the
  real frame. With the same primary-screen fallback it reports the true
  frame relative to the primary display, so `getPosition`/`getBounds`/
  `positionTo`'s internal size read stay correct for hidden windows.

## 8. Borderless window for `titlebar: None` (new)

`WindowOptions { titlebar: None }` previously still produced
`NSTitledWindowMask | NSFullSizeContentViewWindowMask` — a titled window
with the full AppKit theme frame (white fill, 1px border, rounded corners,
drop shadow) painted *behind* the content view. A transparent Metal layer
can't remove chrome the window server composites on top, so
`decorations:false` surfaces (status-item popovers) showed a white card
around the declared content.

- `crates/gpui_macos/src/window.rs` — `MacWindow::open` style-mask branch:
  `titlebar.is_none()` now selects `NSBorderlessWindowMask` instead of
  `NSTitled | NSFullSizeContentView`. Borderless windows paint no theme
  frame at all — no background fill, border, or corner mask — so only the
  rendered content (plus its shadow, which hugs the painted alpha shape) is
  visible. `NSPanel`-class windows (kind Floating/PopUp) stay keyable via
  the existing `canBecomeKeyWindow`/`canBecomeMainWindow` overrides, so
  borderless popovers keep full input. `traffic_light_position` is `None`
  on this path so `move_traffic_light` early-returns on the absent buttons.
  `titlebar: Some(...)` (every normal window) is unchanged.

## Regenerate

```sh
cd <zed checkout>
git diff > native/patches/gpui-fork.patch
```

Note: after editing the vendored checkout, downstream crates won't rebuild
automatically — cargo treats git checkouts as immutable and does not track
checkout mtimes, and `cargo clean -p <name>` removes 0 files for them.
Delete the artifacts instead:

```sh
rm -rf target/release/deps/*gpui_macos* target/release/.fingerprint/gpui_macos-*
cargo build --release
```

## Not patched (recon result)

External file drops (files dragged from Finder onto the window) already reach
view-level handlers without a fork change: `gpui_macos` registers
`NSFilenamesPboardType` and forwards `NSDraggingDestination` callbacks as
`PlatformInput::FileDrop` events; `Window::dispatch_event` translates them
into an `active_drag` carrying an `ExternalPaths` payload, delivered to
`.on_drop::<gpui::ExternalPaths>` / `.on_drag_move::<ExternalPaths>` /
`.can_drop` element listeners (`InteractiveElement`, div.rs). No
`PlatformWindow` callback is needed — a root `div().size_full()` can attach
the handlers in userland.
