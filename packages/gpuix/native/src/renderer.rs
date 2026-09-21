//! GPUIX retained renderer for napi desktop hosts and GPUI's browser platform.
//!
//! Mutation-based API: React's reconciler sends individual mutations
//! (createElement, appendChild, setStyle, etc.) instead of a full JSON tree.
//! Rust maintains a RetainedTree and rebuilds GPUI elements from it each frame.
//!
//! Desktop lifecycle:
//!   const renderer = new GpuixRenderer(eventCallback)
//!   renderer.init({ title: 'My App', width: 800, height: 600 })
//!   renderer.applyBatch(json)             // one atomic React commit
//!   setTimeout(function loop() {         // macOS pumps AppKit; Win/Linux polls UI thread
//!     if (!renderer.tick()) process.exit(0)
//!     setTimeout(loop, 8)
//!   })
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
use futures::{channel::mpsc, StreamExt as _};
use gpui::AppContext as _;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi::bindgen_prelude::*;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi_derive::napi;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
#[cfg(any(target_os = "macos", target_family = "wasm"))]
use std::rc::Rc;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use wasm_bindgen::JsCast as _;

use crate::accessibility::{apply_a11y_click, apply_accessibility};
use crate::custom_elements::{CustomElementRegistry, CustomRenderContext};
use crate::element_tree::EventPayload;
use crate::retained_tree::RetainedTree;
use crate::style::StyleDesc;
use crate::text::{selectable_text, selection_frame_reset, SharedSelection};
use crate::theme::Theme;

/// The Window menu items act on the focused window, and the root element is the
/// only place in GPUIX that has one. `crate::app_menu` owns everything else.
#[cfg(target_os = "macos")]
fn with_window_menu_actions(root: gpui::Div) -> gpui::Div {
    use crate::app_menu::{CloseWindow, MinimizeWindow, ToggleFullscreen, ZoomWindow};
    use gpui::prelude::*;

    root.on_action(|_: &MinimizeWindow, window, _cx| window.minimize_window())
        .on_action(|_: &ZoomWindow, window, _cx| window.zoom_window())
        .on_action(|_: &CloseWindow, window, _cx| window.remove_window())
        .on_action(|_: &ToggleFullscreen, window, _cx| window.toggle_fullscreen())
        .on_action(
            |action: &crate::platform::PlatformMenuAction, _window, _cx| {
                crate::platform::emit_event(
                    "menuAction",
                    serde_json::json!({"id": action.id.to_string()}),
                );
            },
        )
}

#[cfg(not(target_os = "macos"))]
fn with_window_menu_actions(root: gpui::Div) -> gpui::Div {
    use gpui::prelude::*;

    root.on_action(
        |action: &crate::platform::PlatformMenuAction, _window, _cx| {
            crate::platform::emit_event(
                "menuAction",
                serde_json::json!({"id": action.id.to_string()}),
            );
        },
    )
}

/// Parse a CSS font-weight value (string or number) into a GPUI FontWeight.
/// Accepts named keywords ("bold", "semibold"), numeric strings ("700"),
/// and raw numbers (700). Falls back to 400 (normal) for unrecognized values.
pub(crate) fn parse_font_weight(value: &crate::style::FontWeightValue) -> gpui::FontWeight {
    match value {
        crate::style::FontWeightValue::Num(n) => gpui::FontWeight((*n as f32).clamp(1.0, 1000.0)),
        crate::style::FontWeightValue::Str(s) => {
            let lower = s.trim().to_ascii_lowercase();
            match lower.as_str() {
                "100" | "thin" => gpui::FontWeight(100.0),
                "200" | "extralight" | "extra-light" => gpui::FontWeight(200.0),
                "300" | "light" => gpui::FontWeight(300.0),
                "400" | "normal" => gpui::FontWeight(400.0),
                "500" | "medium" => gpui::FontWeight(500.0),
                "600" | "semibold" | "semi-bold" => gpui::FontWeight(600.0),
                "700" | "bold" => gpui::FontWeight(700.0),
                "800" | "extrabold" | "extra-bold" => gpui::FontWeight(800.0),
                "900" | "black" => gpui::FontWeight(900.0),
                _ => lower
                    .parse::<f32>()
                    .map(|n| gpui::FontWeight(n.clamp(1.0, 1000.0)))
                    .unwrap_or(gpui::FontWeight(400.0)),
            }
        }
    }
}

/// Abstracted event callback shared by desktop, browser, and test renderers.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) type EventCallback = Arc<dyn Fn(EventPayload) + Send + Sync>;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub(crate) type EventCallback = Rc<dyn Fn(EventPayload)>;

/// Validate and convert a JS number (f64) to a u64 element ID.
/// JS numbers are f64 — lossless for integers up to 2^53.
fn raw_element_id(id: f64) -> std::result::Result<u64, String> {
    if !id.is_finite() || id < 0.0 || id.fract() != 0.0 || id > 9_007_199_254_740_991.0 {
        return Err(format!("Invalid element id: {id}"));
    }
    Ok(id as u64)
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) fn to_element_id(id: f64) -> Result<u64> {
    raw_element_id(id).map_err(Error::from_reason)
}

/// One open renderer window. The primary window (id 0) is created by
/// `GpuixRenderer.init`; further ids come from `window.create` platform ops.
#[cfg(target_os = "macos")]
pub(crate) struct WindowEntry {
    pub(crate) handle: gpui::WindowHandle<GpuixView>,
    pub(crate) label: String,
    /// `window.setCloseVeto` arms this entry — `on_window_should_close` reads
    /// it. Lives on the entry (not the view) because the should-close
    /// callback cannot borrow the view while `update` is open on it.
    pub(crate) close_veto: std::cell::Cell<bool>,
}

/// The shared pieces `windows.create` clones into each new view. Lives
/// apart from `WINDOWS` because a create must work when zero windows are
/// open — `GpuixRenderer.init` sets it once.
#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(crate) struct RendererState {
    pub(crate) tree: Arc<Mutex<RetainedTree>>,
    pub(crate) callback: Option<EventCallback>,
    /// One automation clock for the whole app — `clockPause` must freeze
    /// every window's animations, not just the one that took the call.
    pub(crate) clock: crate::automation::AutomationClock,
}

thread_local! {
    #[cfg(target_os = "macos")]
    static MAC_PLATFORM: RefCell<Option<Rc<gpui_macos::MacPlatform>>> = const { RefCell::new(None) };
    #[cfg(target_os = "macos")]
    static GPUI_APP: RefCell<Option<gpui::ApplicationHandle>> = const { RefCell::new(None) };
    /// Live windows keyed by windowId. Entries are removed by `GpuixView::drop`
    /// — the registry can never point at a dead window.
    #[cfg(target_os = "macos")]
    pub(crate) static WINDOWS: RefCell<std::collections::BTreeMap<u32, WindowEntry>> =
        RefCell::new(std::collections::BTreeMap::new());
    /// Window ids after the primary (0). `create` allocates from here —
    /// monotonic, never reused, so `emitTo`/`onWindow` ids stay unambiguous.
    #[cfg(target_os = "macos")]
    pub(crate) static NEXT_WINDOW_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
    /// Set once by `GpuixRenderer.init` — `windows.create` clones from it.
    #[cfg(target_os = "macos")]
    pub(crate) static RENDERER_STATE: RefCell<Option<RendererState>> =
        const { RefCell::new(None) };
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    static WEB_APP: RefCell<Option<gpui::ApplicationHandle>> = const { RefCell::new(None) };
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    static WEB_WINDOW: RefCell<Option<gpui::WindowHandle<GpuixView>>> = const { RefCell::new(None) };
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    static PENDING_DEBUG_OVERLAY: RefCell<Option<gpui::DebugFrameOverlayMode>> =
        const { RefCell::new(None) };
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    static PENDING_WINDOW_KEY_EVENTS: RefCell<Option<(bool, bool, u64)>> =
        const { RefCell::new(None) };
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    static PENDING_FOCUS_ELEMENT: RefCell<Option<u64>> = const { RefCell::new(None) };
    /// Shared scroll handles — GpuixView writes here during render(),
    /// platform-local handlers read from here for programmatic scroll control.
    /// ScrollHandle is Rc<RefCell<...>> so its methods (set_offset, offset,
    /// scroll_to_item) work without an App context.
    ///
    /// Element ids are globally unique, so the key stays the element id; the
    /// `u32` tag is the owning window's id — a view's per-frame sync clears
    /// only entries tagged with its own window, so windows rendering
    /// alternately never clobber each other's mirrors.
    static SCROLL_HANDLES: RefCell<HashMap<u64, (u32, gpui::ScrollHandle)>> =
        RefCell::new(HashMap::new());
    static VIRTUAL_LIST_STATES: RefCell<HashMap<u64, (u32, gpui::ListState)>> =
        RefCell::new(HashMap::new());
    /// Virtual-list scrolls queued for the next `GpuixView::render`, applied
    /// AFTER `VirtualListEntry::sync` splices that frame's child changes.
    ///
    /// Never applied eagerly: JS computes row indices against the child list it
    /// just committed, but that commit only reaches `gpui::ListState` when the
    /// next render splices it in. An eager `scroll_to` would be shifted a
    /// second time by `splice_focusable` and land on the wrong row.
    ///
    /// Window-tagged like the mirrors: a view consumes only its own entries;
    /// another window's queued scrolls survive until its own frame runs.
    static PENDING_VIRTUAL_LIST_SCROLLS: RefCell<HashMap<u64, (u32, gpui::ListOffset)>> =
        RefCell::new(HashMap::new());
    /// Scroll anchor each virtual list last reported through `visibleRange`:
    /// `(item_ix, offset_in_item bits, viewport height bits)`. gpui's
    /// `set_scroll_handler` only fires on the wheel path, so the mirror sweep
    /// below reports programmatic moves itself — this map is how the two
    /// emitters avoid double-reporting the same anchor. The key is wider than
    /// `item_ix` because the visible range can change while the anchor item
    /// holds: scrolling inside a tall row moves `offset_in_item`, a viewport
    /// resize moves the bottom edge.
    static REPORTED_VIRTUAL_LIST_TOPS: RefCell<HashMap<u64, (u32, (usize, u32, u32))>> =
        RefCell::new(HashMap::new());
    /// Lists whose last scroll gpui already reported through `scroll_handler`,
    /// keyed by the `visible_range.start` that handler emitted. The handler
    /// cannot read `ListState` (gpui holds the `borrow_mut` while calling it),
    /// so it queues the emitted anchor here; the mirror sweep consumes the
    /// mark by recording the current anchor without re-emitting `visibleRange`
    /// — unless a second scroll moved the anchor after the handler ran, in
    /// which case the queued emit was stale and the sweep reports the new one.
    static GPUI_REPORTED_SCROLLS: RefCell<HashMap<u64, usize>> =
        RefCell::new(HashMap::new());
}

const SELECTION_SCROLL_TICK_MS: u64 = 24;
const SELECTION_SCROLL_EDGE_PX: f32 = 36.0;
const SELECTION_SCROLL_MAX_STEP_PX: f32 = 24.0;

/// Signed list scroll step for a pointer near a viewport edge.
fn selection_scroll_step(
    bounds: gpui::Bounds<gpui::Pixels>,
    position: gpui::Point<gpui::Pixels>,
) -> f32 {
    let height = f32::from(bounds.size.height);
    if height <= 0.0 {
        return 0.0;
    }
    let edge = SELECTION_SCROLL_EDGE_PX.min(height / 6.0);
    if edge <= 0.0 {
        return 0.0;
    }
    let y = f32::from(position.y);
    let top = f32::from(bounds.top());
    let bottom = f32::from(bounds.bottom());
    let scaled = |penetration: f32| {
        let progress = (penetration / edge).clamp(0.0, 1.0);
        SELECTION_SCROLL_MAX_STEP_PX * progress * progress
    };
    if y < top + edge {
        -scaled(top + edge - y)
    } else if y > bottom - edge {
        scaled(y - (bottom - edge))
    } else {
        0.0
    }
}

/// Queue a virtual-list scroll for the next render. `offset_in_item` may be
/// negative: gpui then anchors the viewport top above the item, which is what
/// keeps a row pixel-stable while unmeasured rows are spliced in above it.
pub(crate) fn queue_virtual_list_scroll(
    id: u64,
    window_id: u32,
    index: usize,
    offset_in_item: f32,
) {
    PENDING_VIRTUAL_LIST_SCROLLS.with(|cell| {
        cell.borrow_mut().insert(
            id,
            (
                window_id,
                gpui::ListOffset {
                    item_ix: index,
                    offset_in_item: gpui::px(offset_in_item),
                },
            ),
        );
    });
}

fn parse_debug_frame_overlay_mode_str(
    mode: &str,
) -> std::result::Result<gpui::DebugFrameOverlayMode, String> {
    match mode {
        "hidden" => Ok(gpui::DebugFrameOverlayMode::Hidden),
        "minimal" => Ok(gpui::DebugFrameOverlayMode::Minimal),
        "full" => Ok(gpui::DebugFrameOverlayMode::Full),
        other => Err(format!(
            "Unknown debug frame overlay mode {other:?}. Use hidden, minimal, or full."
        )),
    }
}

#[cfg(test)]
mod selection_scroll_tests {
    use super::*;

    #[test]
    fn selection_scroll_ramps_at_viewport_edges() {
        let bounds = gpui::Bounds::new(
            gpui::point(gpui::px(10.0), gpui::px(20.0)),
            gpui::size(gpui::px(300.0), gpui::px(200.0)),
        );
        assert_eq!(
            selection_scroll_step(bounds, gpui::point(gpui::px(20.0), gpui::px(120.0))),
            0.0
        );
        assert!(selection_scroll_step(bounds, gpui::point(gpui::px(20.0), gpui::px(20.0))) < 0.0);
        assert!(selection_scroll_step(bounds, gpui::point(gpui::px(20.0), gpui::px(220.0))) > 0.0);
        assert!(
            selection_scroll_step(bounds, gpui::point(gpui::px(20.0), gpui::px(220.0)))
                > selection_scroll_step(bounds, gpui::point(gpui::px(20.0), gpui::px(200.0)))
        );
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) fn parse_debug_frame_overlay_mode(mode: &str) -> Result<gpui::DebugFrameOverlayMode> {
    parse_debug_frame_overlay_mode_str(mode).map_err(Error::from_reason)
}

pub(crate) fn debug_frame_overlay_mode_name(mode: gpui::DebugFrameOverlayMode) -> &'static str {
    match mode {
        gpui::DebugFrameOverlayMode::Hidden => "hidden",
        gpui::DebugFrameOverlayMode::Minimal => "minimal",
        gpui::DebugFrameOverlayMode::Full => "full",
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) fn debug_frame_overlay_stats_js(
    stats: gpui::DebugFrameOverlayStats,
) -> DebugFrameOverlayStats {
    DebugFrameOverlayStats {
        current_ms: stats.current_ms.map(|ms| ms as f64),
        p90_ms: stats.p90_ms.map(|ms| ms as f64),
        p99_ms: stats.p99_ms.map(|ms| ms as f64),
        max_ms: stats.max_ms.map(|ms| ms as f64),
        frames: stats.frames as f64,
        samples: stats.samples as f64,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn recv_ui_response<T>(receiver: std::sync::mpsc::Receiver<T>, operation: &str) -> Result<T> {
    match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(response) => Ok(response),
        Err(RecvTimeoutError::Timeout) => Err(Error::from_reason(format!(
            "Timed out after 2 seconds waiting for {operation}"
        ))),
        Err(RecvTimeoutError::Disconnected) => Err(Error::from_reason(format!(
            "The GPUI UI thread stopped during {operation}"
        ))),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn window_handle(window_id: u32) -> Option<gpui::WindowHandle<GpuixView>> {
    WINDOWS.with(|windows| windows.borrow().get(&window_id).map(|entry| entry.handle))
}

#[cfg(target_os = "macos")]
fn update_window_in<R>(
    window_id: u32,
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R,
) -> Result<R> {
    let window = window_handle(window_id)
        .ok_or_else(|| Error::from_reason(format!("window {window_id} is not open")))?;

    GPUI_APP.with(|app| {
        let app = app.borrow();
        let app = app
            .as_ref()
            .ok_or_else(|| Error::from_reason("GPUI application is not initialized"))?;
        app.update(|cx| {
            window
                .update(cx, update)
                .map_err(|error| Error::from_reason(error.to_string()))
        })
    })
}

#[cfg(target_os = "macos")]
fn update_window<R>(
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R,
) -> Result<R> {
    update_window_in(0, update)
}

/// Resolve the optional `windowId` a simulate_* call carries — explicit ids
/// are validated like platform-call routing; absent → the active window,
/// which is where real input would land.
#[cfg(target_os = "macos")]
fn simulate_window_id(window_id: Option<f64>) -> Result<u32> {
    match window_id {
        Some(raw) => {
            let id = raw_element_id(raw).map_err(Error::from_reason)?;
            u32::try_from(id)
                .map_err(|_| Error::from_reason(format!("windowId {id} exceeds u32::MAX")))
        }
        None => Ok(active_window_id()),
    }
}

// Input handlers can update GpuixView, so dispatch without leasing the root view.
#[cfg(target_os = "macos")]
fn update_window_without_view_in<R>(
    window_id: u32,
    update: impl FnOnce(&mut gpui::Window, &mut gpui::App) -> R,
) -> Result<R> {
    let window = window_handle(window_id)
        .ok_or_else(|| Error::from_reason(format!("window {window_id} is not open")))?;

    GPUI_APP.with(|app| {
        let app = app.borrow();
        let app = app
            .as_ref()
            .ok_or_else(|| Error::from_reason("GPUI application is not initialized"))?;
        app.update(|cx| {
            gpui::AnyWindowHandle::from(window)
                .update(cx, move |_view, window, cx| update(window, cx))
                .map_err(|error| Error::from_reason(error.to_string()))
        })
    })
}

#[cfg(target_os = "macos")]
fn invalidate_window() -> Result<()> {
    // `window.refresh()` would mark the whole next frame "refreshing", which
    // bypasses every cached-view replay in it. `notify()` alone schedules the
    // frame through the invalidator — dirty, woken platform, observers — and
    // leaves subtree caches eligible.
    update_window(|_view, _window, cx| cx.notify())
}

/// Repaint the window an element is mounted in. Element-scoped napi ops
/// (scroll, focus) resolve through root ancestry; a detached element falls
/// back to the primary window — the pre-multi-window behavior.
#[cfg(target_os = "macos")]
fn invalidate_element_window(tree: &Mutex<RetainedTree>, element_id: u64) -> Result<()> {
    let window_id = tree.lock().unwrap_or_else(|p| p.into_inner()).window_of(element_id).unwrap_or(0);
    update_window_in(window_id, |_view, _window, cx| cx.notify())
}

/// Run `update` inside the window that owns `element_id`. Focus and
/// element-scoped ops must land on the view that holds the element's
/// handles — window 0's view knows nothing about window 1's elements.
/// The tree lock is released before the window update re-enters view code.
#[cfg(target_os = "macos")]
fn update_element_window<R>(
    tree: &Mutex<RetainedTree>,
    element_id: u64,
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R,
) -> Result<R> {
    let window_id = tree.lock().unwrap_or_else(|p| p.into_inner()).window_of(element_id).unwrap_or(0);
    update_window_in(window_id, update)
}

/// Repaint every open window except `except` — for app-global state that
/// lives behind a shared handle (the automation clock) where one window's
/// update changed the value but every view must redraw to observe it.
/// Must run outside any window update: nested `update` re-borrows the App.
#[cfg(target_os = "macos")]
fn notify_other_windows(except: u32) {
    WINDOWS.with(|cell| {
        for id in cell.borrow().keys() {
            if *id != except {
                let _ = update_window_in(*id, |_view, _window, cx| cx.notify());
            }
        }
    });
}

/// The key window's id — where window-scoped ops without an explicit target
/// (focusNext, blur, an unadorned `window.setTitle`) belong. Falls back to
/// the lowest live window id (usually the primary) when nothing is active —
/// never a dead 0 while other windows are open.
#[cfg(target_os = "macos")]
fn active_window_id() -> u32 {
    GPUI_APP.with(|app| {
        let app = app.borrow();
        let Some(app) = app.as_ref() else {
            return WINDOWS.with(|w| w.borrow().keys().next().copied().unwrap_or(0));
        };
        app.update(|cx| {
            WINDOWS.with(|windows| {
                let windows = windows.borrow();
                for (id, entry) in windows.iter() {
                    if entry.handle.is_active(cx).unwrap_or(false) {
                        return *id;
                    }
                }
                windows.keys().next().copied().unwrap_or(0)
            })
        })
    })
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
enum MouseInput {
    Click {
        x: f64,
        y: f64,
        button: u32,
        modifiers: gpui::Modifiers,
    },
    Down {
        x: f64,
        y: f64,
        button: u32,
        modifiers: gpui::Modifiers,
    },
    Up {
        x: f64,
        y: f64,
        button: u32,
        modifiers: gpui::Modifiers,
    },
    Move {
        x: f64,
        y: f64,
        pressed_button: Option<u32>,
        modifiers: gpui::Modifiers,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: gpui::Modifiers,
    },
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
enum KeyInput {
    Keystrokes(String),
    Down { keystroke: String, is_held: bool },
    Up(String),
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
enum ClockControl {
    Pause,
    Set(f64),
    FastForward(f64),
    Resume,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
enum UiCommand {
    Invalidate,
    ActivateWindow,
    SetWindowTitle(String),
    SetDebugFrameOverlay(gpui::DebugFrameOverlayMode),
    CycleDebugFrameOverlay {
        response: SyncSender<String>,
    },
    GetDebugFrameOverlay {
        response: SyncSender<String>,
    },
    GetDebugFrameOverlayStats {
        response: SyncSender<DebugFrameOverlayStats>,
    },
    ResetDebugFrameOverlayStats,
    ScrollTo {
        id: u64,
        x: f32,
        y: f32,
    },
    ScrollToItem {
        id: u64,
        index: usize,
        offset: f32,
    },
    GetScrollOffset {
        id: u64,
        response: SyncSender<Option<[f64; 2]>>,
    },
    GetListScrollTop {
        id: u64,
        response: SyncSender<Option<[f64; 3]>>,
    },
    GetAutomationBounds {
        response: SyncSender<HashMap<u64, crate::automation::ElementBounds>>,
    },
    GetWindowSize {
        response: SyncSender<WindowSize>,
    },
    GetElementBounds {
        id: u64,
        response: SyncSender<Option<crate::automation::ElementBounds>>,
    },
    /// Paint one frame now so bounds listeners re-record — the renderer's
    /// forced-sync-layout primitive for synchronous rect reads after a
    /// mutation (Svelte's slide/crossfade/flip all measure that way).
    Measure {
        response: SyncSender<()>,
    },
    FocusElement(u64),
    FocusNext,
    FocusPrevious,
    GetFocusedElementId {
        response: SyncSender<Option<u64>>,
    },
    FocusNextWithin(u64),
    FocusPreviousWithin(u64),
    SetWindowKeyEvents {
        key_down: bool,
        key_up: bool,
        event_id: u64,
    },
    ControlClock {
        control: ClockControl,
        response: SyncSender<f64>,
    },
    PlatformCall {
        request: String,
        response: SyncSender<String>,
    },
    DispatchMouse {
        input: MouseInput,
        response: SyncSender<std::result::Result<(), String>>,
    },
    DispatchKey {
        input: KeyInput,
        response: SyncSender<std::result::Result<(), String>>,
    },
    #[cfg(all(target_os = "windows", feature = "test-support"))]
    CaptureScreenshot {
        path: String,
        response: SyncSender<std::result::Result<(), String>>,
    },
    Blur,
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn refresh_ui_window(
    window: gpui::WindowHandle<GpuixView>,
    cx: &mut gpui::AsyncApp,
) -> anyhow::Result<()> {
    window.update(cx, |_view, window, cx| {
        cx.notify();
        window.refresh();
    })
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
async fn run_ui_commands(
    mut commands: mpsc::UnboundedReceiver<UiCommand>,
    window: gpui::WindowHandle<GpuixView>,
    cx: &mut gpui::AsyncApp,
) {
    while let Some(command) = commands.next().await {
        let result = match command {
            UiCommand::Invalidate => refresh_ui_window(window, cx),
            UiCommand::ActivateWindow => window.update(cx, |_view, window, cx| {
                cx.activate(true);
                window.activate_window();
            }),
            UiCommand::SetWindowTitle(title) => window.update(cx, move |view, window, cx| {
                view.window_title = title;
                cx.notify();
                window.refresh();
            }),
            UiCommand::SetDebugFrameOverlay(mode) => {
                window.update(cx, move |_view, window, _cx| {
                    window.set_debug_frame_overlay_mode(mode);
                })
            }
            UiCommand::CycleDebugFrameOverlay { response } => {
                window.update(cx, move |_view, window, _cx| {
                    window.cycle_debug_frame_overlay_mode();
                    response
                        .send(
                            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).into(),
                        )
                        .ok();
                })
            }
            UiCommand::GetDebugFrameOverlay { response } => {
                window.update(cx, move |_view, window, _cx| {
                    response
                        .send(
                            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).into(),
                        )
                        .ok();
                })
            }
            UiCommand::GetDebugFrameOverlayStats { response } => {
                window.update(cx, move |_view, window, _cx| {
                    response
                        .send(debug_frame_overlay_stats_js(
                            window.debug_frame_overlay_stats(),
                        ))
                        .ok();
                })
            }
            UiCommand::ResetDebugFrameOverlayStats => window.update(cx, |_view, window, _cx| {
                window.reset_debug_frame_overlay_stats();
            }),
            UiCommand::ScrollTo { id, x, y } => {
                if !VIRTUAL_LIST_STATES.with(|cell| {
                    let states = cell.borrow();
                    let Some(state) = states.get(&id).map(|entry| &entry.1) else {
                        return false;
                    };
                    state.set_offset_from_scrollbar(gpui::point(gpui::px(x), gpui::px(y)));
                    true
                }) {
                    SCROLL_HANDLES.with(|cell| {
                        if let Some(handle) = cell.borrow().get(&id).map(|entry| &entry.1) {
                            handle.set_offset(gpui::point(gpui::px(x), gpui::px(y)));
                        }
                    });
                }
                refresh_ui_window(window, cx)
            }
            UiCommand::ScrollToItem { id, index, offset } => {
                if !VIRTUAL_LIST_STATES.with(|cell| {
                    let Some(w) = cell.borrow().get(&id).map(|entry| entry.0) else {
                        return false;
                    };
                    queue_virtual_list_scroll(id, w, index, offset);
                    true
                }) {
                    SCROLL_HANDLES.with(|cell| {
                        if let Some(handle) = cell.borrow().get(&id).map(|entry| &entry.1) {
                            handle.scroll_to_item(index);
                        }
                    });
                }
                refresh_ui_window(window, cx)
            }
            UiCommand::GetScrollOffset { id, response } => {
                let offset = VIRTUAL_LIST_STATES
                    .with(|cell| {
                        cell.borrow().get(&id).map(|entry| &entry.1).map(|state| {
                            let offset = state.scroll_px_offset_for_scrollbar();
                            [
                                f64::from(f32::from(offset.x)),
                                f64::from(f32::from(offset.y)),
                            ]
                        })
                    })
                    .or_else(|| {
                        SCROLL_HANDLES.with(|cell| {
                            cell.borrow().get(&id).map(|entry| &entry.1).map(|handle| {
                                let offset = handle.offset();
                                [
                                    f64::from(f32::from(offset.x)),
                                    f64::from(f32::from(offset.y)),
                                ]
                            })
                        })
                    });
                response.send(offset).ok();
                Ok(())
            }
            UiCommand::GetListScrollTop { id, response } => {
                let top = VIRTUAL_LIST_STATES.with(|cell| {
                    cell.borrow().get(&id).map(|entry| &entry.1).map(|state| {
                        let top = state.logical_scroll_top();
                        [
                            top.item_ix as f64,
                            f64::from(f32::from(top.offset_in_item)),
                            f64::from(f32::from(state.viewport_bounds().size.height)),
                        ]
                    })
                });
                response.send(top).ok();
                Ok(())
            }
            UiCommand::GetWindowSize { response } => {
                window.update(cx, move |_view, window, _cx| {
                    let size = window.viewport_size();
                    response
                        .send(WindowSize {
                            width: f32::from(size.width) as f64,
                            height: f32::from(size.height) as f64,
                        })
                        .ok();
                })
            }
            UiCommand::GetAutomationBounds { response } => {
                window.update(cx, move |_view, window, cx| {
                    cx.notify();
                    window.refresh();
                    window.on_next_frame(move |_window, _cx| {
                        response.send(crate::automation::all_bounds()).ok();
                    });
                })
            }
            UiCommand::GetElementBounds { id, response } => {
                window.update(cx, move |_view, window, cx| {
                    cx.notify();
                    window.refresh();
                    window.on_next_frame(move |_window, _cx| {
                        response.send(crate::automation::get_bounds(id)).ok();
                    });
                })
            }
            UiCommand::Measure { response } => {
                // Draw without holding the GpuixView lease — memoized
                // subtrees re-enter the root view during paint and a held
                // lease double-leases (see measure_layout_now).
                let drawn = gpui::AnyWindowHandle::from(window).update(
                    cx,
                    move |_view, window, cx| {
                        // Draw without presenting — refreshes recorded bounds
                        // without showing the un-animated snapshot. The hold
                        // covers the gap before the follow-up batch lands
                        // (Svelte's transition pin arrives one macrotask later);
                        // its invalidate clears the hold, 48ms bounds a
                        // read that produced none.
                        window.suppress_presents_until(
                            std::time::Instant::now() + Duration::from_millis(48),
                        );
                        window.draw(cx).clear(cx);
                    },
                );
                if drawn.is_ok() {
                    let _ = window.update(cx, |_view, _window, cx| cx.notify());
                    response.send(()).ok();
                }
                drawn
            }
            UiCommand::FocusElement(id) => window.update(cx, move |view, window, cx| {
                view.request_focus(id, window, cx);
                window.refresh();
            }),
            UiCommand::FocusNext => window.update(cx, |_view, window, cx| window.focus_next(cx)),
            UiCommand::FocusPrevious => {
                window.update(cx, |_view, window, cx| window.focus_prev(cx))
            }
            UiCommand::GetFocusedElementId { response } => {
                window.update(cx, |view, window, _cx| {
                    response.send(view.focused_element_id(window)).ok();
                })
            }
            UiCommand::FocusNextWithin(id) => window.update(cx, |view, window, cx| {
                view.focus_next_within(id, window, cx);
                cx.notify();
                window.refresh();
            }),
            UiCommand::FocusPreviousWithin(id) => window.update(cx, |view, window, cx| {
                view.focus_previous_within(id, window, cx);
                cx.notify();
                window.refresh();
            }),
            UiCommand::SetWindowKeyEvents {
                key_down,
                key_up,
                event_id,
            } => window.update(cx, move |view, window, cx| {
                view.window_key_down = key_down;
                view.window_key_up = key_up;
                view.window_key_event_id = event_id;
                cx.notify();
                window.refresh();
            }),
            UiCommand::PlatformCall { request, response } => {
                let reply = match crate::platform::PlatformRequest::parse(&request) {
                    Ok(parsed) => match window.update(cx, |view, window, cx| {
                        crate::platform::dispatch(&parsed, Some((view, window)), cx)
                    }) {
                        Ok(reply) => reply,
                        // The window is gone — app-level ops still answer.
                        Err(_) => cx.update(|cx| crate::platform::dispatch(&parsed, None, cx)),
                    },
                    Err(error) => serde_json::json!({"ok": false, "error": error}).to_string(),
                };
                response.send(reply).ok();
                Ok(())
            }
            UiCommand::ControlClock { control, response } => {
                window.update(cx, move |view, _window, cx| {
                    let now_ms = match control {
                        ClockControl::Pause => view.clock.pause(),
                        ClockControl::Set(now_ms) => view.clock.set_ms(now_ms),
                        ClockControl::FastForward(delta_ms) => view.clock.fast_forward_ms(delta_ms),
                        ClockControl::Resume => view.clock.resume(),
                    };
                    cx.notify();
                    response.send(now_ms).ok();
                })
            }
            UiCommand::DispatchMouse { input, response } => {
                let result =
                    gpui::AnyWindowHandle::from(window).update(cx, move |_view, window, cx| {
                        match input {
                            MouseInput::Click {
                                x,
                                y,
                                button,
                                modifiers,
                            } => {
                                crate::automation::dispatch_click(
                                    window, cx, x, y, button, modifiers,
                                );
                            }
                            MouseInput::Down {
                                x,
                                y,
                                button,
                                modifiers,
                            } => {
                                crate::automation::dispatch_mouse_down(
                                    window, cx, x, y, button, modifiers,
                                );
                            }
                            MouseInput::Up {
                                x,
                                y,
                                button,
                                modifiers,
                            } => {
                                crate::automation::dispatch_mouse_up(
                                    window, cx, x, y, button, modifiers,
                                );
                            }
                            MouseInput::Move {
                                x,
                                y,
                                pressed_button,
                                modifiers,
                            } => {
                                crate::automation::dispatch_mouse_move(
                                    window,
                                    cx,
                                    x,
                                    y,
                                    pressed_button,
                                    modifiers,
                                );
                            }
                            MouseInput::Wheel {
                                x,
                                y,
                                delta_x,
                                delta_y,
                                modifiers,
                            } => {
                                crate::automation::dispatch_scroll_wheel(
                                    window, cx, x, y, delta_x, delta_y, modifiers,
                                );
                            }
                        }
                    });
                response
                    .send(
                        result
                            .as_ref()
                            .map(|_| ())
                            .map_err(|error| format!("{error:#}")),
                    )
                    .ok();
                result
            }
            UiCommand::DispatchKey { input, response } => {
                let result = gpui::AnyWindowHandle::from(window)
                    .update(cx, move |_view, window, cx| match input {
                        KeyInput::Keystrokes(keystrokes) => {
                            crate::automation::dispatch_keystrokes(window, cx, &keystrokes)
                        }
                        KeyInput::Down { keystroke, is_held } => {
                            crate::automation::dispatch_key_down(window, cx, &keystroke, is_held)
                        }
                        KeyInput::Up(keystroke) => {
                            crate::automation::dispatch_key_up(window, cx, &keystroke)
                        }
                    })
                    .and_then(|result| result.map_err(anyhow::Error::msg));
                response
                    .send(
                        result
                            .as_ref()
                            .map(|_| ())
                            .map_err(|error| format!("{error:#}")),
                    )
                    .ok();
                result
            }
            #[cfg(all(target_os = "windows", feature = "test-support"))]
            UiCommand::CaptureScreenshot { path, response } => {
                let error_response = response.clone();
                let result = window.update(cx, move |_view, window, cx| {
                    cx.notify();
                    window.refresh();
                    window.on_next_frame(move |window, _cx| {
                        let result = window
                            .render_to_image()
                            .map_err(|error| format!("Screenshot capture failed: {error}"))
                            .and_then(|image| {
                                image
                                    .save(&path)
                                    .map_err(|error| format!("Failed to save screenshot: {error}"))
                            });
                        response.send(result).ok();
                    });
                });
                if let Err(error) = &result {
                    error_response.send(Err(format!("{error:#}"))).ok();
                }
                result
            }
            UiCommand::Blur => window.update(cx, |_view, window, _cx| window.blur()),
        };
        if let Err(error) = result {
            if cx.update(|cx| cx.windows().is_empty()) {
                break;
            }
            log::error!("Failed to handle GPUI UI command: {error:#}");
        }
    }
    cx.update(|cx| cx.quit());
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string())
}

/// The main GPUI renderer exposed to Node.js.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi]
pub struct GpuixRenderer {
    event_callback: Mutex<Option<Arc<ThreadsafeFunction<EventPayload>>>>,
    tree: Arc<Mutex<RetainedTree>>,
    initialized: Arc<Mutex<bool>>,
    /// Shared with GpuixView so napi methods can read the live selection
    /// without an App context. Paint and napi calls can use different threads.
    selection: SharedSelection,
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    ui_commands: Mutex<Option<mpsc::UnboundedSender<UiCommand>>>,
    /// False after `Platform::run` returns. `tick()` reports that so JS can
    /// `process.exit`, matching macOS where `pump_events` returning false is
    /// the last-window-closed signal. The UI thread owns the Win32/Linux loop,
    /// so `tick()` cannot pump it; it only observes this flag.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    ui_running: Arc<AtomicBool>,
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi]
impl GpuixRenderer {
    fn event_callback_for_view(&self) -> Option<EventCallback> {
        self.event_callback.lock().unwrap_or_else(|p| p.into_inner()).clone().map(|tsf| {
            Arc::new(move |payload: EventPayload| {
                tsf.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
                // The event queued onto Bun's loop — a sleeping pump slice
                // breaks early so tick() returns and the event delivers this
                // turn instead of up to a pump budget later (rAF-driven
                // animation would otherwise land a vsync late every cycle).
                #[cfg(target_os = "macos")]
                gpui_macos::signal_ts_event_pending();
            }) as EventCallback
        })
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    fn send_ui_command(&self, command: UiCommand) -> Result<()> {
        self.ui_commands
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| Error::from_reason("GPUI application is not initialized"))?
            .unbounded_send(command)
            .map_err(|_| Error::from_reason("The GPUI UI thread is not running"))
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    fn dispatch_mouse_input(&self, input: MouseInput) -> Result<()> {
        let (response_sender, response_receiver) = sync_channel(1);
        self.send_ui_command(UiCommand::DispatchMouse {
            input,
            response: response_sender,
        })?;
        recv_ui_response(response_receiver, "the GPUI UI command")?.map_err(Error::from_reason)
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    fn dispatch_key_input(&self, input: KeyInput) -> Result<()> {
        let (response_sender, response_receiver) = sync_channel(1);
        self.send_ui_command(UiCommand::DispatchKey {
            input,
            response: response_sender,
        })?;
        recv_ui_response(response_receiver, "the GPUI key command")?.map_err(Error::from_reason)
    }

    fn automation_bounds(&self) -> Result<HashMap<u64, crate::automation::ElementBounds>> {
        #[cfg(target_os = "macos")]
        return Ok(crate::automation::all_bounds());

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetAutomationBounds { response })?;
            return recv_ui_response(receiver, "the automation bounds query");
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    fn element_bounds(&self, id: u64) -> Result<Option<crate::automation::ElementBounds>> {
        #[cfg(target_os = "macos")]
        return Ok(crate::automation::get_bounds(id));

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetElementBounds { id, response })?;
            return recv_ui_response(receiver, "the element bounds query");
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = id;
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    /// Paint one frame now so every recorded bound reflects the latest
    /// mutation batch — the renderer's forced-sync-layout primitive. Svelte's
    /// slide/crossfade/flip constructors measure rects between the DOM
    /// mutation and the next paint; without this they capture stale or
    /// missing bounds. One draw refreshes all bounds, so the JS side batches
    /// reads behind a single dirty flag.
    fn measure_layout_now(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            // The draw must NOT hold the GpuixView lease: memoized subtrees
            // re-enter the root view during paint (GpuixSubtree::render →
            // root.update), and a lease held here turns that into a
            // double-lease panic once content is large enough to memoize.
            update_window_without_view_in(0, |window, cx| {
                // draw WITHOUT present — the browser's forced-sync-layout
                // semantics: prepaint+paint run so bounds listeners re-record,
                // but nothing is shown. The hold also covers the gap before
                // the follow-up batch (Svelte's transition pin lands one
                // macrotask later): without it, a display-link tick in that
                // gap presents the un-styled scene — the intro flicker. The
                // next batch's invalidate clears it; 48ms is the bound for a
                // read that produced no follow-up ops.
                window.suppress_presents_until(
                    std::time::Instant::now() + Duration::from_millis(48),
                );
                window.draw(cx).clear(cx);
            })?;
            // Dirty the view so the next tick redraws (and, once the pin
            // batch's invalidate clears the hold, presents the new scene).
            return update_window(|_view, _window, cx| cx.notify());
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::Measure { response })?;
            return recv_ui_response(receiver, "the layout measure");
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    fn control_clock(&self, control: ClockControl) -> Result<f64> {
        let (response, receiver) = sync_channel(1);
        self.send_ui_command(UiCommand::ControlClock { control, response })?;
        recv_ui_response(receiver, "the automation clock command")
    }

    /// Repaint exactly the windows a batch touched. macOS resolves each
    /// touched window through the registry; global ops (stylesheets, recipes)
    /// wake every open window. A batch touching nothing mounted is a no-op —
    /// detached creates repaint nothing. Other platforms keep the single-
    /// window invalidate path until their registry lands.
    fn invalidate_after_batch(&self, outcome: &BatchOutcome) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            let window_ids: Vec<u32> = if outcome.global {
                WINDOWS.with(|windows| windows.borrow().keys().copied().collect())
            } else {
                outcome.windows.iter().copied().collect()
            };
            for window_id in window_ids {
                if let Err(_error) = update_window_in(window_id, |_view, window, cx| {
                    // A follow-up batch ends a measure's present hold —
                    // the pin has landed; let its frame reach the screen.
                    window.clear_present_suppression();
                    cx.notify();
                }) {
                    // The window died between the batch and this notify — its
                    // Drop removes the registry entry; nothing left to wake.
                }
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = outcome;
            self.request_invalidate()
        }
    }

    fn request_invalidate(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return invalidate_window();

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::Invalidate);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason(
            "The production GPUIX renderer does not support this operating system",
        ))
    }

    #[napi(constructor)]
    pub fn new(event_callback: Option<ThreadsafeFunction<EventPayload>>) -> Self {
        let _ = env_logger::try_init();
        Self {
            event_callback: Mutex::new(event_callback.map(Arc::new)),
            tree: Arc::new(Mutex::new(RetainedTree::new())),
            initialized: Arc::new(Mutex::new(false)),
            selection: SharedSelection::default(),
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
            ui_commands: Mutex::new(None),
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
            ui_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Initialize GPUI using the native event-loop architecture for this OS.
    #[napi]
    pub fn init(&self, options: Option<WindowOptions>) -> Result<()> {
        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = options;
            return Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ));
        }

        #[cfg(target_os = "macos")]
        return self.init_macos(options);

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.init_threaded(options);
    }

    #[cfg(target_os = "macos")]
    fn init_macos(&self, options: Option<WindowOptions>) -> Result<()> {
        let options = options.unwrap_or_default();

        {
            let initialized = self.initialized.lock().unwrap_or_else(|p| p.into_inner());
            if *initialized {
                return Err(Error::from_reason("Renderer is already initialized"));
            }
        }
        if MAC_PLATFORM.with(|platform| platform.borrow().is_some()) {
            return Err(Error::from_reason(
                "A GPUI application already exists on this thread",
            ));
        }

        let width = options.width.unwrap_or(800.0);
        let height = options.height.unwrap_or(600.0);
        let title = options.title.clone().unwrap_or_else(|| "GPUIX".to_string());
        let app_name = options.app_name.clone().unwrap_or_else(|| title.clone());
        // `focus: false` must also skip `cx.activate`: the window flag only
        // decides key status inside the app, activation is what steals focus.
        let activate = options.focus.unwrap_or(true);
        let window_options = options.clone();

        let platform = Rc::new(gpui_macos::MacPlatform::new_embedded());

        let tree = self.tree.clone();
        let callback = self.event_callback_for_view();

        let selection = self.selection.clone();
        // One automation clock app-wide — cloned into every window's view so
        // a clockPause test hook freezes all of them.
        let clock = crate::automation::AutomationClock::new();
        let opened_window = Rc::new(RefCell::new(None));
        let startup_error = Rc::new(RefCell::new(None));
        let opened_window_for_app = opened_window.clone();
        let startup_error_for_app = startup_error.clone();
        // bun/node is not a .app. A Dock icon with no window cannot relaunch.
        // Last window close quits AppKit; tick() returns false and JS exits.
        let app = gpui::Application::with_platform(platform.clone())
            .with_quit_mode(gpui::QuitMode::LastWindowClosed);
        crate::platform::set_event_sink(callback.clone());
        crate::platform::register_launch_callbacks(&app);
        // `windows.create` clones these into each new view — stashed before
        // the move closure so it survives with zero windows open.
        RENDERER_STATE.with(|state| {
            *state.borrow_mut() = Some(RendererState {
                tree: tree.clone(),
                callback: callback.clone(),
                clock: clock.clone(),
            });
        });
        let app_handle = app.run_embedded(move |cx: &mut gpui::App| {
            crate::custom_elements::input::init(cx);
            crate::custom_elements::img::init(cx);
            // After the other bindings: `set_menus` reads key equivalents out of
            // the keymap, so every binding must exist before it runs.
            crate::app_menu::init(&app_name, cx);
            crate::platform::register_app_callbacks(cx);
            let bounds = gpui::Bounds::centered(
                None,
                gpui::size(gpui::px(width as f32), gpui::px(height as f32)),
                cx,
            );

            match cx.open_window(
                to_gpui_window_options(&window_options, bounds),
                |_window, cx| {
                    cx.new(|_| {
                        GpuixView::new(
                            0,
                            tree.clone(),
                            callback.clone(),
                            title,
                            selection.clone(),
                            clock.clone(),
                        )
                    })
                },
            ) {
                Ok(window_handle) => {
                    crate::platform::observe_window(&window_handle, cx);
                    *opened_window_for_app.borrow_mut() = Some(window_handle);
                    if activate {
                        cx.activate(true);
                    }
                }
                Err(error) => {
                    *startup_error_for_app.borrow_mut() = Some(error.to_string());
                }
            }
        });

        let startup_result = match startup_error.borrow_mut().take() {
            Some(error) => Err(Error::from_reason(format!(
                "Failed to open the GPUI window: {error}"
            ))),
            None => opened_window
                .borrow_mut()
                .take()
                .ok_or_else(|| Error::from_reason("GPUI did not open the application window")),
        };
        let window_handle = match startup_result {
            Ok(window_handle) => window_handle,
            Err(error) => {
                app_handle.update(|cx| cx.quit());
                if platform.pump_events(0.0) {
                    MAC_PLATFORM.with(|stored| {
                        *stored.borrow_mut() = Some(platform.clone());
                    });
                }
                return Err(error);
            }
        };

        MAC_PLATFORM.with(|stored| {
            *stored.borrow_mut() = Some(platform);
        });
        GPUI_APP.with(|a| {
            *a.borrow_mut() = Some(app_handle);
        });
        WINDOWS.with(|windows| {
            windows.borrow_mut().insert(
                0,
                WindowEntry {
                    handle: window_handle,
                    label: "main".to_string(),
                    close_veto: std::cell::Cell::new(false),
                },
            );
        });

        *self.initialized.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.event_callback.lock().unwrap_or_else(|p| p.into_inner()).take();
        Ok(())
    }

    // GPUI declares PerMonitorV2 only in the host exe manifest (zed#8936).
    // A napi .node is loaded by node.exe/bun.exe, so that manifest never applies.
    // Call on gpuix-ui only, before WindowsPlatform::new. Never on the Node thread:
    // the V2 fallback is SetThreadDpiAwarenessContext, which would change bun itself.
    #[cfg(target_os = "windows")]
    fn enable_per_monitor_dpi() {
        use windows::Win32::UI::HiDpi::{
            AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
            SetProcessDpiAwarenessContext, SetThreadDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };

        unsafe {
            let current = GetThreadDpiAwarenessContext();
            if AreDpiAwarenessContextsEqual(current, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
                .as_bool()
            {
                return;
            }
            if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_ok() {
                return;
            }
            if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE).is_ok() {
                return;
            }
            // Process awareness is already locked (node/bun manifest). This thread has no HWND yet.
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    fn init_threaded(&self, options: Option<WindowOptions>) -> Result<()> {
        let options = options.unwrap_or_default();
        if *self.initialized.lock().unwrap_or_else(|p| p.into_inner()) {
            return Err(Error::from_reason("Renderer is already initialized"));
        }

        let width = options.width.unwrap_or(800.0);
        let height = options.height.unwrap_or(600.0);
        let title = options.title.clone().unwrap_or_else(|| "GPUIX".to_string());
        // `focus: false` must also skip `cx.activate`: the window flag only
        // decides key status inside the app, activation is what steals focus.
        let activate = options.focus.unwrap_or(true);
        let window_options = options.clone();
        let tree = self.tree.clone();
        let selection = self.selection.clone();
        let callback = self.event_callback_for_view();
        crate::platform::set_event_sink(callback.clone());
        let (command_sender, command_receiver) = mpsc::unbounded();
        let (startup_sender, startup_receiver) = sync_channel(1);
        let exit_startup_sender = startup_sender.clone();
        let ui_running = self.ui_running.clone();
        let ui_running_for_run = ui_running.clone();

        std::thread::Builder::new()
            .name("gpuix-ui".to_string())
            .spawn(move || {
                #[cfg(target_os = "windows")]
                Self::enable_per_monitor_dpi();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Default is already LastWindowClosed on Windows/Linux.
                    // Set it anyway so a GPUI default change cannot leave bun
                    // running after the last window closes, as on macOS.
                    let application = gpui_platform::application()
                        .with_quit_mode(gpui::QuitMode::LastWindowClosed);
                    crate::platform::register_launch_callbacks(&application);
                    application.run(move |cx| {
                        crate::custom_elements::input::init(cx);
                        crate::custom_elements::img::init(cx);
                        crate::platform::register_app_callbacks(cx);
                        let size = gpui::size(gpui::px(width as f32), gpui::px(height as f32));
                        // A layer-shell surface is positioned by the compositor from its
                        // anchor, so it opens at the origin; a normal window is centered.
                        let bounds = if window_options.layer_shell.is_some() {
                            gpui::Bounds {
                                origin: gpui::point(gpui::px(0.0), gpui::px(0.0)),
                                size,
                            }
                        } else {
                            gpui::Bounds::centered(None, size, cx)
                        };
                        let window = match cx.open_window(
                            to_gpui_window_options(&window_options, bounds),
                            |_window, cx| {
                                cx.new(|_| {
                                    GpuixView::new(
                                        0,
                                        tree,
                                        callback,
                                        title,
                                        selection,
                                        crate::automation::AutomationClock::new(),
                                    )
                                })
                            },
                        ) {
                            Ok(window) => {
                                crate::platform::observe_window(&window, cx);
                                window
                            }
                            Err(error) => {
                                startup_sender
                                    .send(Err(format!("Failed to open the GPUI window: {error}")))
                                    .ok();
                                cx.quit();
                                return;
                            }
                        };

                        cx.spawn(async move |cx| {
                            run_ui_commands(command_receiver, window, cx).await;
                        })
                        .detach();
                        if activate {
                            cx.activate(true);
                        }
                        ui_running_for_run.store(true, Ordering::Release);
                        startup_sender.send(Ok(())).ok();
                    });
                }));
                ui_running.store(false, Ordering::Release);

                let error = match result {
                    Ok(()) => {
                        "The GPUI event loop exited before initialization completed".to_string()
                    }
                    Err(payload) => format!(
                        "The GPUI UI thread panicked during initialization: {}",
                        panic_message(payload)
                    ),
                };
                exit_startup_sender.try_send(Err(error)).ok();
            })
            .map_err(|error| {
                Error::from_reason(format!("Failed to spawn the GPUI UI thread: {error}"))
            })?;

        startup_receiver
            .recv()
            .map_err(|_| Error::from_reason("The GPUI UI thread stopped during initialization"))?
            .map_err(Error::from_reason)?;

        *self.ui_commands.lock().unwrap_or_else(|p| p.into_inner()) = Some(command_sender);
        *self.initialized.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.event_callback.lock().unwrap_or_else(|p| p.into_inner()).take();
        Ok(())
    }

    /// Apply a batch of mutations in a single FFI call.
    ///
    /// Accepts a JSON array of mutation tuples. Each tuple is an array where
    /// the first element is the operation name (string) and remaining elements
    /// are the arguments:
    ///
    ///   ["createElement",    id, "type"]
    ///   ["destroyElement",   id]
    ///   ["appendChild",      parentId, childId]
    ///   ["insertBefore",     parentId, childId, beforeId]
    ///   ["moveBefore",       parentId, childId, beforeId|null]
    ///   ["setStyle",         id, { ...style }]
    ///   ["setText",          id, "content"]
    ///   ["setEventListener", id, "eventType", true|false]
    ///   ["setRoot",          id]
    ///   ["setCustomProp",    id, "key", value]
    ///   ["setTheme",         declaration|null]
    ///   ["setClass",         id, "token token …"]
    ///   ["stylesheet.register",   "sheet-id", [{sel, decls, spec, order}]]
    ///   ["stylesheet.unregister", "sheet-id"]
    ///
    /// The stylesheet ops also accept the object form:
    ///   {"op":"stylesheet.register","sheet":"id","rules":[…]}
    ///
    /// Returns accumulated destroyed IDs from all destroyElement ops.
    /// Acquires the tree mutex ONCE for the entire batch.
    #[napi]
    pub fn apply_batch(&self, json: String) -> Result<Vec<f64>> {
        let mut tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        let outcome = apply_batch_to_tree(&mut tree, json.as_bytes()).map_err(Error::from_reason)?;
        drop(tree);
        self.invalidate_after_batch(&outcome)?;
        Ok(outcome.destroyed)
    }

    /// Brokered platform service call: `{"id","service","op","args"}` →
    /// `{"ok",value}` | `{"ok":false,"error":{code,message}}` | `{"pending",id}`.
    /// Pending results resolve through the `platformResult` platform event.
    /// Never throws for service-level failures — errors are in the envelope;
    /// napi errors are reserved for transport failures (no app, dead UI thread).
    #[napi]
    pub fn platform_call(&self, request: String) -> Result<String> {
        let parsed = match crate::platform::PlatformRequest::parse(&request) {
            Ok(parsed) => parsed,
            Err(error) => return Ok(serde_json::json!({"ok": false, "error": error}).to_string()),
        };

        #[cfg(target_os = "macos")]
        return Ok({
            // `args.windowId` routes the whole dispatch inside that window's
            // update — every `view_window` op (bounds, title, focus, close…)
            // then acts on the target without per-op plumbing. The window
            // service's app-scoped ops (create/list/get) ignore it.
            let window_id = match parsed.args.get("windowId") {
                Some(value) => match value.as_f64() {
                    // Fractional/negative ids must not silently truncate onto
                    // a different window — `1.9` is not window 1.
                    Some(id) if id >= 0.0 && id.fract() == 0.0 && id <= u32::MAX as f64 => {
                        Some(id as u32)
                    }
                    Some(_) => {
                        return Ok(serde_json::json!({
                            "ok": false,
                            "error": {
                                "code": "invalid_args",
                                "message": format!("windowId must be a non-negative integer, got {value}"),
                            }
                        })
                        .to_string());
                    }
                    None => {
                        return Ok(serde_json::json!({
                            "ok": false,
                            "error": {
                                "code": "invalid_args",
                                "message": format!("windowId must be a number, got {value}"),
                            }
                        })
                        .to_string());
                    }
                },
                None => None,
            };
            // `window.create`/`list`/`get` act on the registry, not a window —
            // a stray `windowId` is meaningless to them and must not route a
            // dead id into `unavailable` before the op can answer.
            let app_scoped_window_op = parsed.service == "window"
                && matches!(parsed.op.as_str(), "create" | "list" | "get");
            // An untargeted window op lands on the active window — the
            // caller's "current window" in Tauri terms — not always the
            // primary.
            let routed_window = if app_scoped_window_op {
                None
            } else {
                Some(window_id.unwrap_or_else(active_window_id))
            };
            let reply = match routed_window {
                Some(id) => update_window_in(id, |view, window, cx| {
                    crate::platform::dispatch(&parsed, Some((view, window)), cx)
                }),
                None => update_window(|view, window, cx| {
                    crate::platform::dispatch(&parsed, Some((view, window)), cx)
                }),
            };
            match reply {
                Ok(reply) => reply,
                Err(error) => match window_id {
                    // An explicitly named window that's gone is an op-level
                    // `unavailable`, not a transport failure. A defaulted
                    // route (no `windowId` given) falls through to the app
                    // context instead — an app-scoped service still answers
                    // with zero windows open.
                    Some(id) => serde_json::json!({
                        "ok": false,
                        "error": {
                            "code": "unavailable",
                            "message": format!("window {id} is not open: {error}"),
                        }
                    })
                    .to_string(),
                    // No window — app-level services still answer from the
                    // app context.
                    None => GPUI_APP.with(|app| {
                        app.borrow()
                            .as_ref()
                            .map(|app| {
                                app.update(|cx| crate::platform::dispatch(&parsed, None, cx))
                            })
                            .unwrap_or_else(|| {
                                serde_json::json!({
                                    "ok": false,
                                    "error": {
                                        "code": "unavailable",
                                        "message": "GPUI application is not initialized",
                                    }
                                })
                                .to_string()
                            })
                    }),
                },
            }
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::PlatformCall { request, response })?;
            return recv_ui_response(receiver, "the platform call");
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = parsed;
            Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ))
        }
    }

    // ── Frame loop ───────────────────────────────────────────────────

    /// Pump the native event loop. `wait_ms` budgets continuous runloop
    /// service inside the call — AX writes and runloop sources dispatch on
    /// arrival rather than waiting for the next poll. Returns false after
    /// the last window closes.
    #[napi]
    pub fn tick(&self, wait_ms: Option<f64>) -> Result<bool> {
        let initialized = *self.initialized.lock().unwrap_or_else(|p| p.into_inner());
        if !initialized {
            return Err(Error::from_reason(
                "Renderer not initialized. Call init() first.",
            ));
        }

        #[cfg(target_os = "macos")]
        {
            // An Infinity/NaN wait would park the runloop inside
            // CFRunLoopRunInMode — clamp to a finite frame-loop budget.
            let wait_seconds =
                wait_ms.filter(|v| v.is_finite()).unwrap_or(0.0).clamp(0.0, 1000.0) / 1000.0;
            let running = MAC_PLATFORM.with(|p| {
                p.borrow()
                    .as_ref()
                    .map(|platform| platform.pump_events(wait_seconds))
                    .unwrap_or(false)
            });
            return Ok(running);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let running = self.ui_running.load(Ordering::Acquire);
            if !running {
                self.ui_commands.lock().unwrap_or_else(|p| p.into_inner()).take();
            }
            return Ok(running);
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason(
            "The production GPUIX renderer does not support this operating system",
        ))
    }

    #[napi]
    pub fn is_initialized(&self) -> bool {
        *self.initialized.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether JavaScript must call tick() until it returns false.
    ///
    /// macOS: tick() pumps AppKit. Windows/Linux: tick() only reports whether
    /// the UI thread is still inside `Platform::run`. Both return false after
    /// the last window closes so the JS frame loop can exit the process.
    #[napi]
    pub fn requires_tick(&self) -> bool {
        cfg!(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        ))
    }

    /// The paintable size of the window in logical pixels, excluding any
    /// platform title bar. This used to answer a hardcoded 800x600, so anything
    /// that turned a mouse position into layout coordinates pointed at the
    /// wrong place on every window that was not exactly that size.
    #[napi]
    pub fn get_window_size(&self) -> Result<WindowSize> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, _cx| {
            let size = window.viewport_size();
            WindowSize {
                width: f32::from(size.width) as f64,
                height: f32::from(size.height) as f64,
            }
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetWindowSize { response })?;
            return recv_ui_response(receiver, "the window size query");
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason(
            "The production GPUIX renderer does not support this operating system",
        ))
    }

    #[napi]
    pub fn get_window_insets(&self) -> Result<WindowInsets> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, _cx| {
            WindowInsets::from_gpui(window.insets())
        });

        #[cfg(not(target_os = "macos"))]
        Ok(WindowInsets::default())
    }

    /// `"hidden"` | `"minimal"` | `"full"`. Paints into the scene after layout.
    #[napi]
    pub fn set_debug_frame_overlay(&self, mode: String) -> Result<String> {
        let mode = parse_debug_frame_overlay_mode(&mode)?;
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), move |_view, window, _cx| {
            window.set_debug_frame_overlay_mode(mode);
            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).to_string()
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            self.send_ui_command(UiCommand::SetDebugFrameOverlay(mode))?;
            return self.debug_frame_overlay_mode();
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Hidden → minimal → full → hidden.
    #[napi]
    pub fn cycle_debug_frame_overlay(&self) -> Result<String> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), move |_view, window, _cx| {
            window.cycle_debug_frame_overlay_mode();
            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).to_string()
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::CycleDebugFrameOverlay { response })?;
            return recv_ui_response(receiver, "the debug frame overlay query");
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    #[napi]
    pub fn get_debug_frame_overlay(&self) -> Result<String> {
        self.debug_frame_overlay_mode()
    }

    fn debug_frame_overlay_mode(&self) -> Result<String> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, _cx| {
            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).to_string()
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetDebugFrameOverlay { response })?;
            recv_ui_response(receiver, "the debug frame overlay query")
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Clears the last 1000 draw samples. Frame count stays.
    #[napi]
    pub fn reset_debug_frame_overlay_stats(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, _cx| {
            window.reset_debug_frame_overlay_stats();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::ResetDebugFrameOverlayStats);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Same numbers as the on-screen overlay: current, p90, p99, max, frames.
    #[napi]
    pub fn get_debug_frame_overlay_stats(&self) -> Result<DebugFrameOverlayStats> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, _cx| {
            debug_frame_overlay_stats_js(window.debug_frame_overlay_stats())
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetDebugFrameOverlayStats { response })?;
            match receiver.recv_timeout(Duration::from_secs(2)) {
                Ok(stats) => Ok(stats),
                Err(RecvTimeoutError::Timeout) => Err(Error::from_reason(
                    "Timed out after 2 seconds waiting for debug frame overlay stats",
                )),
                Err(RecvTimeoutError::Disconnected) => Err(Error::from_reason(
                    "The GPUI UI thread stopped during the debug frame overlay stats query",
                )),
            }
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Bring the window forward and give it focus. This is how a window opened
    /// with `show: false` or `focus: false` is revealed later.
    #[napi]
    pub fn activate_window(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window(|_view, window, cx| {
            cx.activate(true);
            window.activate_window();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::ActivateWindow);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason(
            "The production GPUIX renderer does not support this operating system",
        ))
    }

    #[napi]
    pub fn set_window_title(&self, title: String) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), move |view, window, cx| {
            view.window_title = title;
            cx.notify();
            window.refresh();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::SetWindowTitle(title));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason(
            "The production GPUIX renderer does not support this operating system",
        ))
    }

    #[napi]
    pub fn focus_element(&self, element_id: f64) -> Result<()> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return update_element_window(&self.tree, id, move |view, window, cx| {
            view.request_focus(id, window, cx);
            window.refresh();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::FocusElement(id));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Move focus to the next GPUI tab stop.
    #[napi]
    pub fn focus_next(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, cx| {
            window.focus_next(cx)
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::FocusNext);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Move focus to the previous GPUI tab stop.
    #[napi]
    pub fn focus_previous(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |_view, window, cx| {
            window.focus_prev(cx)
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::FocusPrevious);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Host id of the focused element, or null when nothing is focused.
    #[napi]
    pub fn get_focused_element_id(&self) -> Result<Option<f64>> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), |view, window, _cx| {
            view.focused_element_id(window).map(|id| id as f64)
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetFocusedElementId { response })?;
            return recv_ui_response(receiver, "the focused element id query")
                .map(|id| id.map(|id| id as f64));
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Move focus to the next tab stop inside `element_id`, wrapping in that subtree.
    #[napi]
    pub fn focus_next_within(&self, element_id: f64) -> Result<()> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return update_element_window(&self.tree, id, move |view, window, cx| {
            view.focus_next_within(id, window, cx);
            cx.notify();
            window.refresh();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::FocusNextWithin(id));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Move focus to the previous tab stop inside `element_id`, wrapping in that subtree.
    #[napi]
    pub fn focus_previous_within(&self, element_id: f64) -> Result<()> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return update_element_window(&self.tree, id, move |view, window, cx| {
            view.focus_previous_within(id, window, cx);
            cx.notify();
            window.refresh();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::FocusPreviousWithin(id));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Enable the window key events requested by the React renderer.
    #[napi]
    pub fn set_window_key_events(&self, key_down: bool, key_up: bool, event_id: f64) -> Result<()> {
        let event_id = to_element_id(event_id)?;
        #[cfg(target_os = "macos")]
        return update_element_window(&self.tree, event_id, move |view, window, cx| {
            view.window_key_down = key_down;
            view.window_key_up = key_up;
            view.window_key_event_id = event_id;
            cx.notify();
            window.refresh();
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::SetWindowKeyEvents {
            key_down,
            key_up,
            event_id,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    #[napi]
    pub fn blur(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        return update_window_in(active_window_id(), move |_view, window, _cx| {
            window.blur()
        });

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::Blur);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    // ── Selection API ────────────────────────────────────────────────

    /// The current text selection joined in document order, or null.
    #[napi]
    pub fn get_selected_text(&self) -> Option<String> {
        #[cfg(target_os = "macos")]
        {
            // Selections are per-window; the API is app-global, so the key
            // window's selection wins and any other window's is the fallback.
            let mut fallback = None;
            let mut found = None;
            WINDOWS.with(|cell| {
                for id in cell.borrow().keys() {
                    let hit = update_window_in(*id, |view, window, _cx| {
                        (window.is_window_active(), view.selection.lock().selected_text())
                    })
                    .ok();
                    match hit {
                        Some((true, Some(text))) => {
                            found = Some(text);
                            break;
                        }
                        Some((false, Some(text))) if fallback.is_none() => fallback = Some(text),
                        _ => {}
                    }
                }
            });
            return found.or(fallback);
        }
        #[cfg(not(target_os = "macos"))]
        self.selection.lock().selected_text()
    }

    /// Drop the current selection and request a repaint.
    #[napi]
    pub fn clear_selection(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            // Clearing is app-global: drop every window's selection, then
            // repaint each so the highlight wash disappears everywhere.
            WINDOWS.with(|cell| {
                for id in cell.borrow().keys() {
                    let _ = update_window_in(*id, |view, _window, cx| {
                        view.selection.lock().clear();
                        cx.notify();
                    });
                }
            });
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.selection.lock().clear();
            self.request_invalidate()
        }
    }

    // ── Scroll API ───────────────────────────────────────────────────
    // GpuixView syncs scroll handles and virtual list states to thread-local maps.

    /// Set the scroll offset of a scrollable element.
    /// x and y are negative pixel values (scroll down = more negative y).
    #[napi]
    pub fn scroll_to(&self, element_id: f64, x: f64, y: f64) -> Result<()> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        if !VIRTUAL_LIST_STATES.with(|cell| {
            let states = cell.borrow();
            let Some(state) = states.get(&id).map(|entry| &entry.1) else {
                return false;
            };
            state.set_offset_from_scrollbar(gpui::point(gpui::px(x as f32), gpui::px(y as f32)));
            true
        }) {
            SCROLL_HANDLES.with(|cell| {
                let handles = cell.borrow();
                if let Some(handle) = handles.get(&id).map(|entry| &entry.1) {
                    handle.set_offset(gpui::point(gpui::px(x as f32), gpui::px(y as f32)));
                }
            });
        }
        #[cfg(target_os = "macos")]
        return invalidate_element_window(&self.tree, id);

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::ScrollTo {
            id,
            x: x as f32,
            y: y as f32,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Scroll a child into view by its index in the children list.
    ///
    /// For a `<virtual-list>` the scroll is queued and applied on the next
    /// render, after that frame's child splice, so indices computed against a
    /// just-committed child list are never shifted twice. `offsetInItem` is in
    /// pixels and may be negative, which anchors the viewport top above the
    /// item and resolves against measured heights at layout time.
    #[napi]
    pub fn scroll_to_item(
        &self,
        element_id: f64,
        index: f64,
        offset_in_item: Option<f64>,
    ) -> Result<()> {
        let id = to_element_id(element_id)?;
        let index = index as usize;
        let offset = offset_in_item.unwrap_or(0.0) as f32;
        #[cfg(target_os = "macos")]
        if !VIRTUAL_LIST_STATES.with(|cell| {
            let Some(w) = cell.borrow().get(&id).map(|entry| entry.0) else {
                return false;
            };
            queue_virtual_list_scroll(id, w, index, offset);
            true
        }) {
            SCROLL_HANDLES.with(|cell| {
                let handles = cell.borrow();
                if let Some(handle) = handles.get(&id).map(|entry| &entry.1) {
                    handle.scroll_to_item(index);
                }
            });
        }
        #[cfg(target_os = "macos")]
        return invalidate_element_window(&self.tree, id);

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.send_ui_command(UiCommand::ScrollToItem { id, index, offset });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = offset;
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    /// The logical scroll anchor of a `<virtual-list>`:
    /// `[itemIndex, offsetInItemPx, viewportHeightPx]`, or null for anything
    /// else. `itemIndex == item count` is gpui's at-end sentinel.
    ///
    /// Unlike `getScrollOffset` this is exact even while row heights are still
    /// estimates, because it is the anchor gpui itself scrolls by.
    #[napi]
    pub fn get_list_scroll_top(&self, element_id: f64) -> Result<Option<Vec<f64>>> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return Ok(VIRTUAL_LIST_STATES.with(|cell| {
            cell.borrow().get(&id).map(|entry| &entry.1).map(|state| {
                let top = state.logical_scroll_top();
                vec![
                    top.item_ix as f64,
                    f64::from(f32::from(top.offset_in_item)),
                    f64::from(f32::from(state.viewport_bounds().size.height)),
                ]
            })
        }));

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetListScrollTop { id, response })?;
            return Ok(
                recv_ui_response(receiver, "the GPUI list scroll query")?.map(|top| top.to_vec())
            );
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    /// Get the current scroll offset of a scrollable element.
    /// Returns [x, y] or null if the element has no scroll handle.
    #[napi]
    pub fn get_scroll_offset(&self, element_id: f64) -> Result<Option<Vec<f64>>> {
        let id = to_element_id(element_id)?;
        #[cfg(target_os = "macos")]
        return Ok(VIRTUAL_LIST_STATES
            .with(|cell| {
                cell.borrow().get(&id).map(|entry| &entry.1).map(|state| {
                    let offset = state.scroll_px_offset_for_scrollbar();
                    vec![
                        f64::from(f32::from(offset.x)),
                        f64::from(f32::from(offset.y)),
                    ]
                })
            })
            .or_else(|| {
                SCROLL_HANDLES.with(|cell| {
                    let handles = cell.borrow();
                    handles.get(&id).map(|entry| &entry.1).map(|handle| {
                        let offset = handle.offset();
                        vec![
                            f64::from(f32::from(offset.x)),
                            f64::from(f32::from(offset.y)),
                        ]
                    })
                })
            }));

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::GetScrollOffset { id, response })?;
            return Ok(
                recv_ui_response(receiver, "the GPUI scroll query")?.map(|[x, y]| vec![x, y])
            );
        }

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    #[napi]
    pub fn get_automation_tree(&self) -> Result<String> {
        self.request_invalidate()?;
        let bounds = self.automation_bounds()?;
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        let json = tree.to_automation_json(&bounds);
        serde_json::to_string(&json)
            .map_err(|e| Error::from_reason(format!("JSON serialization failed: {}", e)))
    }

    #[napi]
    pub fn get_element_bounds(&self, id: f64) -> Result<Option<ElementBounds>> {
        let id = to_element_id(id)?;
        Ok(self.element_bounds(id)?.map(ElementBounds::from_painted))
    }

    /// Force a synchronous paint so the next bounds query sees post-mutation
    /// geometry — the equivalent of a browser's forced synchronous layout.
    /// JS calls this once per mutation batch (a dirty flag guards it), never
    /// per element read.
    #[napi]
    pub fn measure_layout(&self) -> Result<()> {
        self.measure_layout_now()
    }

    /// The element's resolved symbolic style as JSON — the same merge that
    /// feeds paint, so JS `getComputedStyle` reads the renderer's own
    /// cascade instead of a parallel implementation. Numbers are px for
    /// dimension fields; strings are keywords/percent/colors verbatim.
    #[napi]
    pub fn computed_style(&self, id: f64) -> Result<String> {
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        Ok(merged_symbolic_fields(&tree, id as u64).0.to_string())
    }

    #[napi]
    pub fn get_all_text(&self) -> Vec<String> {
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        let mut texts = Vec::new();
        if let Some(root_id) = tree.root_id() {
            collect_text(root_id, &tree, &mut texts);
        }
        texts
    }

    #[napi]
    pub fn get_painted_text(&self) -> Vec<String> {
        crate::text::painted_text()
    }

    /// Every highlight wash painted in the last frame, in paint order.
    ///
    /// A quad is invisible to `getPaintedText()`, so this is the only way to
    /// assert on `highlight` without a screenshot.
    #[napi]
    pub fn get_painted_highlights(&self) -> Vec<crate::element_tree::HighlightMatch> {
        crate::text::painted_highlights()
            .into_iter()
            .map(Into::into)
            .collect()
    }

    /// Simulate space-separated keystrokes through the focused element's input pipeline.
    #[napi]
    pub fn simulate_keystrokes(&self, keystrokes: String, window_id: Option<f64>) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_keystrokes(window, cx, &keystrokes)
            })?
            .map_err(Error::from_reason);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_key_input(KeyInput::Keystrokes(keystrokes));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = keystrokes;
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    #[napi]
    pub fn simulate_key_down(
        &self,
        keystroke: String,
        is_held: Option<bool>,
        window_id: Option<f64>,
    ) -> Result<()> {
        let is_held = is_held.unwrap_or(false);

        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_key_down(window, cx, &keystroke, is_held)
            })?
            .map_err(Error::from_reason);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_key_input(KeyInput::Down { keystroke, is_held });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = (keystroke, is_held);
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    #[napi]
    pub fn simulate_key_up(&self, keystroke: String, window_id: Option<f64>) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_key_up(window, cx, &keystroke)
            })?
            .map_err(Error::from_reason);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_key_input(KeyInput::Up(keystroke));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = keystroke;
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    /// `modifiers` uses the `press()` syntax: "cmd", "cmd-shift", "alt".
    #[napi]
    pub fn simulate_click(
        &self,
        x: f64,
        y: f64,
        button: Option<u32>,
        modifiers: Option<String>,
        window_id: Option<f64>,
    ) -> Result<()> {
        let button = button.unwrap_or(0);
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());

        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_click(window, cx, x, y, button, modifiers);
            });
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_mouse_input(MouseInput::Click {
            x,
            y,
            button,
            modifiers,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = (x, y, button);
            Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ))
        }
    }

    #[napi]
    pub fn simulate_mouse_down(
        &self,
        x: f64,
        y: f64,
        button: Option<u32>,
        modifiers: Option<String>,
        window_id: Option<f64>,
    ) -> Result<()> {
        let button = button.unwrap_or(0);
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());

        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_mouse_down(window, cx, x, y, button, modifiers);
            });
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_mouse_input(MouseInput::Down {
            x,
            y,
            button,
            modifiers,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = (x, y, button);
            Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ))
        }
    }

    #[napi]
    pub fn simulate_mouse_up(
        &self,
        x: f64,
        y: f64,
        button: Option<u32>,
        modifiers: Option<String>,
        window_id: Option<f64>,
    ) -> Result<()> {
        let button = button.unwrap_or(0);
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());

        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_mouse_up(window, cx, x, y, button, modifiers);
            });
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_mouse_input(MouseInput::Up {
            x,
            y,
            button,
            modifiers,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = (x, y, button);
            Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ))
        }
    }

    #[napi]
    pub fn simulate_mouse_move(
        &self,
        x: f64,
        y: f64,
        pressed_button: Option<u32>,
        modifiers: Option<String>,
        window_id: Option<f64>,
    ) -> Result<()> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());

        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_mouse_move(window, cx, x, y, pressed_button, modifiers);
            });
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_mouse_input(MouseInput::Move {
            x,
            y,
            pressed_button,
            modifiers,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = (x, y, pressed_button);
            Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ))
        }
    }

    /// Dispatch a wheel event through the same GPUI hit test the trackpad uses.
    /// Deltas are pixels: negative `delta_y` scrolls down, negative `delta_x`
    /// pans right, matching `TestGpuixRenderer::simulate_scroll_wheel`.
    #[napi]
    pub fn simulate_scroll_wheel(
        &self,
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: Option<String>,
        window_id: Option<f64>,
    ) -> Result<()> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());

        #[cfg(target_os = "macos")]
        {
            let window_id = simulate_window_id(window_id)?;
            return update_window_without_view_in(window_id, move |window, cx| {
                crate::automation::dispatch_scroll_wheel(
                    window, cx, x, y, delta_x, delta_y, modifiers,
                );
            });
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.dispatch_mouse_input(MouseInput::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            modifiers,
        });

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = (x, y, delta_x, delta_y, modifiers);
            Err(Error::from_reason(
                "The production GPUIX renderer does not support this operating system",
            ))
        }
    }

    #[napi]
    pub fn clock_pause(&self) -> Result<f64> {
        #[cfg(target_os = "macos")]
        {
            // The clock is app-global and lives in RENDERER_STATE — mutate it
            // directly (works with zero windows), then repaint every window
            // so each freezes its animations this frame.
            let now_ms = RENDERER_STATE.with(|state| {
                state
                    .borrow()
                    .as_ref()
                    .map(|st| st.clock.pause())
                    .ok_or_else(|| Error::from_reason("renderer is not initialized"))
            })?;
            notify_other_windows(u32::MAX);
            return Ok(now_ms);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.control_clock(ClockControl::Pause);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    #[napi]
    pub fn clock_set(&self, now_ms: f64) -> Result<f64> {
        #[cfg(target_os = "macos")]
        {
            let now_ms = RENDERER_STATE.with(|state| {
                state
                    .borrow()
                    .as_ref()
                    .map(|st| st.clock.set_ms(now_ms))
                    .ok_or_else(|| Error::from_reason("renderer is not initialized"))
            })?;
            notify_other_windows(u32::MAX);
            return Ok(now_ms);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.control_clock(ClockControl::Set(now_ms));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = now_ms;
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    #[napi]
    pub fn clock_fast_forward(&self, delta_ms: f64) -> Result<f64> {
        #[cfg(target_os = "macos")]
        {
            let now_ms = RENDERER_STATE.with(|state| {
                state
                    .borrow()
                    .as_ref()
                    .map(|st| st.clock.fast_forward_ms(delta_ms))
                    .ok_or_else(|| Error::from_reason("renderer is not initialized"))
            })?;
            notify_other_windows(u32::MAX);
            return Ok(now_ms);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.control_clock(ClockControl::FastForward(delta_ms));

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        {
            let _ = delta_ms;
            Err(Error::from_reason("Unsupported operating system"))
        }
    }

    #[napi]
    pub fn clock_resume(&self) -> Result<f64> {
        #[cfg(target_os = "macos")]
        {
            let now_ms = RENDERER_STATE.with(|state| {
                state
                    .borrow()
                    .as_ref()
                    .map(|st| st.clock.resume())
                    .ok_or_else(|| Error::from_reason("renderer is not initialized"))
            })?;
            notify_other_windows(u32::MAX);
            return Ok(now_ms);
        }

        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
        return self.control_clock(ClockControl::Resume);

        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )))]
        Err(Error::from_reason("Unsupported operating system"))
    }

    #[napi]
    pub fn capture_screenshot(&self, path: String) -> Result<()> {
        #[cfg(all(target_os = "macos", feature = "test-support"))]
        {
            let image = update_window_in(active_window_id(), move |_view, window, cx| {
                cx.notify();
                window.refresh();
                window.render_to_image()
            })?
            .map_err(|e| Error::from_reason(format!("Screenshot capture failed: {}", e)))?;
            image
                .save(&path)
                .map_err(|e| Error::from_reason(format!("Failed to save screenshot: {}", e)))?;
            Ok(())
        }

        #[cfg(all(target_os = "windows", feature = "test-support"))]
        {
            let (response, receiver) = sync_channel(1);
            self.send_ui_command(UiCommand::CaptureScreenshot { path, response })?;
            return recv_ui_response(receiver, "screenshot capture")?.map_err(Error::from_reason);
        }

        #[cfg(not(all(
            feature = "test-support",
            any(target_os = "macos", target_os = "windows")
        )))]
        {
            let _ = path;
            Err(Error::from_reason(
                "captureScreenshot needs a test-support build on macOS or Windows",
            ))
        }
    }
}

fn collect_text(id: u64, tree: &RetainedTree, texts: &mut Vec<String>) {
    if let Some(element) = tree.elements.get(&id) {
        if let Some(ref content) = element.content {
            texts.push(content.clone());
        }
        for &child_id in &element.children {
            collect_text(child_id, tree, texts);
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn start_web_app(
    tree: Arc<Mutex<RetainedTree>>,
    selection: SharedSelection,
    event_callback: EventCallback,
) -> Result<(), wasm_bindgen::JsValue> {
    if WEB_APP.with(|stored| stored.borrow().is_some()) {
        return Err(wasm_bindgen::JsValue::from_str(
            "GPUIX web is already running",
        ));
    }
    gpui_platform::web_init();
    let app = gpui_platform::single_threaded_web().run_embedded(move |cx| {
        crate::custom_elements::input::init(cx);
        let window = cx.open_window(Default::default(), |window, cx| {
            if let Some(mode) = PENDING_DEBUG_OVERLAY.with(|pending| pending.borrow_mut().take()) {
                window.set_debug_frame_overlay_mode(mode);
            }
            cx.new(|_| {
                let mut view = GpuixView::new(
                    0,
                    tree,
                    Some(event_callback),
                    "GPUIX Web".to_string(),
                    selection,
                    crate::automation::AutomationClock::new(),
                );
                if let Some((key_down, key_up, event_id)) =
                    PENDING_WINDOW_KEY_EVENTS.with(|pending| pending.borrow_mut().take())
                {
                    view.window_key_down = key_down;
                    view.window_key_up = key_up;
                    view.window_key_event_id = event_id;
                }
                view
            })
        });
        match window {
            Ok(window) => WEB_WINDOW.with(|stored| *stored.borrow_mut() = Some(window)),
            Err(error) => log::error!("Failed to open the GPUIX web window: {error:#}"),
        }
        cx.activate(true);
    });
    WEB_APP.with(|stored| *stored.borrow_mut() = Some(app));
    Ok(())
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn web_element_id(id: f64) -> Result<u64, wasm_bindgen::JsValue> {
    raw_element_id(id).map_err(|error| wasm_bindgen::JsValue::from_str(&error))
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn web_number_array(values: impl IntoIterator<Item = f64>) -> wasm_bindgen::JsValue {
    let result = js_sys::Array::new();
    for value in values {
        result.push(&value.into());
    }
    result.into()
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn web_string_array(values: impl IntoIterator<Item = String>) -> wasm_bindgen::JsValue {
    let result = js_sys::Array::new();
    for value in values {
        result.push(&value.into());
    }
    result.into()
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn update_web_window<R>(
    update: impl FnOnce(&mut GpuixView, &mut gpui::Window, &mut gpui::Context<GpuixView>) -> R,
) -> Result<R, wasm_bindgen::JsValue> {
    WEB_APP.with(|app| {
        let app = app.borrow();
        let app = app
            .as_ref()
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("GPUIX web is not initialized"))?;
        app.update(|cx| {
            WEB_WINDOW.with(|window| {
                let window = (*window.borrow()).ok_or_else(|| {
                    wasm_bindgen::JsValue::from_str("GPUIX web window is not ready")
                })?;
                window
                    .update(cx, update)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
        })
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn update_web_window_without_view<R>(
    update: impl FnOnce(&mut gpui::Window, &mut gpui::App) -> R,
) -> Result<R, wasm_bindgen::JsValue> {
    WEB_APP.with(|app| {
        let app = app.borrow();
        let app = app
            .as_ref()
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("GPUIX web is not initialized"))?;
        app.update(|cx| {
            WEB_WINDOW.with(|window| {
                let window = (*window.borrow()).ok_or_else(|| {
                    wasm_bindgen::JsValue::from_str("GPUIX web window is not ready")
                })?;
                gpui::AnyWindowHandle::from(window)
                    .update(cx, move |_view, window, cx| update(window, cx))
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
        })
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn notify_web() {
    if let Err(error) = update_web_window(|_view, _window, cx| cx.notify()) {
        if WEB_WINDOW.with(|window| window.borrow().is_some()) {
            log::error!("Failed to invalidate the GPUIX web window: {error:?}");
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn web_event_callback(callback: js_sys::Function) -> EventCallback {
    Rc::new(move |payload| {
        let Ok(json) = serde_json::to_string(&payload) else {
            log::error!("Failed to serialize GPUIX browser event");
            return;
        };
        let Ok(payload) = js_sys::JSON::parse(&json) else {
            log::error!("Failed to create GPUIX browser event object");
            return;
        };
        let callback = callback.clone();
        let task = wasm_bindgen::closure::Closure::once_into_js(move || {
            if let Err(error) = callback.call2(
                &wasm_bindgen::JsValue::UNDEFINED,
                &wasm_bindgen::JsValue::NULL,
                &payload,
            ) {
                log::error!("GPUIX browser event callback failed: {error:?}");
            }
        });
        let task: js_sys::Function = task.unchecked_into();
        if let Some(window) = web_sys::window() {
            window.queue_microtask(&task);
        }
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = GpuixRenderer)]
pub struct WebGpuixRenderer {
    tree: Arc<Mutex<RetainedTree>>,
    selection: SharedSelection,
    event_callback: EventCallback,
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[wasm_bindgen::prelude::wasm_bindgen(js_class = GpuixRenderer)]
impl WebGpuixRenderer {
    #[wasm_bindgen::prelude::wasm_bindgen(constructor)]
    pub fn new(event_callback: js_sys::Function) -> Self {
        Self {
            tree: Arc::new(Mutex::new(RetainedTree::new())),
            selection: SharedSelection::default(),
            event_callback: web_event_callback(event_callback),
        }
    }

    pub fn init(&self, _options: wasm_bindgen::JsValue) -> Result<(), wasm_bindgen::JsValue> {
        start_web_app(
            self.tree.clone(),
            self.selection.clone(),
            self.event_callback.clone(),
        )
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = applyBatch)]
    pub fn apply_batch(
        &self,
        json: String,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let outcome = apply_batch_to_tree(&mut self.tree.lock().unwrap_or_else(|p| p.into_inner()), json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error))?;
        notify_web();
        Ok(web_number_array(outcome.destroyed))
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = isInitialized)]
    pub fn is_initialized(&self) -> bool {
        WEB_APP.with(|app| app.borrow().is_some())
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = requiresTick)]
    pub fn requires_tick(&self) -> bool {
        false
    }

    pub fn tick(&self, _wait_ms: Option<f64>) {}

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getWindowSize)]
    pub fn get_window_size(&self) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let window = web_sys::window()
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("Browser window is unavailable"))?;
        let size = js_sys::Object::new();
        js_sys::Reflect::set(&size, &"width".into(), &window.inner_width()?)?;
        js_sys::Reflect::set(&size, &"height".into(), &window.inner_height()?)?;
        Ok(size.into())
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getWindowInsets)]
    pub fn get_window_insets(&self) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let insets = update_web_window(|_view, window, _cx| window.insets())?;
        window_insets_js(insets)
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = setWindowTitle)]
    pub fn set_window_title(&self, title: String) -> Result<(), wasm_bindgen::JsValue> {
        update_web_window(move |view, _window, cx| {
            view.window_title = title;
            cx.notify();
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = focusElement)]
    pub fn focus_element(&self, element_id: f64) -> Result<(), wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        PENDING_FOCUS_ELEMENT.with(|pending| *pending.borrow_mut() = Some(id));
        notify_web();
        Ok(())
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = focusNext)]
    pub fn focus_next(&self) -> Result<(), wasm_bindgen::JsValue> {
        update_web_window(|_view, window, cx| window.focus_next(cx))
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = focusPrevious)]
    pub fn focus_previous(&self) -> Result<(), wasm_bindgen::JsValue> {
        update_web_window(|_view, window, cx| window.focus_prev(cx))
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getFocusedElementId)]
    pub fn get_focused_element_id(&self) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let id = update_web_window(|view, window, _cx| view.focused_element_id(window))?;
        Ok(match id {
            Some(id) => wasm_bindgen::JsValue::from_f64(id as f64),
            None => wasm_bindgen::JsValue::NULL,
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = focusNextWithin)]
    pub fn focus_next_within(&self, element_id: f64) -> Result<(), wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        update_web_window(move |view, window, cx| {
            view.focus_next_within(id, window, cx);
            cx.notify();
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = focusPreviousWithin)]
    pub fn focus_previous_within(&self, element_id: f64) -> Result<(), wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        update_web_window(move |view, window, cx| {
            view.focus_previous_within(id, window, cx);
            cx.notify();
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = setWindowKeyEvents)]
    pub fn set_window_key_events(
        &self,
        key_down: bool,
        key_up: bool,
        event_id: f64,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let event_id = web_element_id(event_id)?;
        // Graphics init is async. createRoot() sets this before WEB_WINDOW exists.
        if WEB_WINDOW.with(|window| window.borrow().is_none()) {
            PENDING_WINDOW_KEY_EVENTS.with(|pending| {
                *pending.borrow_mut() = Some((key_down, key_up, event_id));
            });
            return Ok(());
        }
        update_web_window(move |view, _window, cx| {
            view.window_key_down = key_down;
            view.window_key_up = key_up;
            view.window_key_event_id = event_id;
            cx.notify();
        })
    }

    pub fn blur(&self) -> Result<(), wasm_bindgen::JsValue> {
        update_web_window(|_view, window, _cx| window.blur())
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getSelectedText)]
    pub fn get_selected_text(&self) -> wasm_bindgen::JsValue {
        self.selection
            .lock()
            .selected_text()
            .map_or(wasm_bindgen::JsValue::NULL, |value| {
                wasm_bindgen::JsValue::from_str(&value)
            })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = clearSelection)]
    pub fn clear_selection(&self) {
        self.selection.lock().clear();
        notify_web();
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = scrollTo)]
    pub fn scroll_to(&self, element_id: f64, x: f64, y: f64) -> Result<(), wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        if !VIRTUAL_LIST_STATES.with(|states| {
            let states = states.borrow();
            let Some(state) = states.get(&id).map(|entry| &entry.1) else {
                return false;
            };
            state.set_offset_from_scrollbar(gpui::point(gpui::px(x as f32), gpui::px(y as f32)));
            true
        }) {
            SCROLL_HANDLES.with(|handles| {
                if let Some(handle) = handles.borrow().get(&id).map(|entry| &entry.1) {
                    handle.set_offset(gpui::point(gpui::px(x as f32), gpui::px(y as f32)));
                }
            });
        }
        notify_web();
        Ok(())
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = scrollToItem)]
    pub fn scroll_to_item(
        &self,
        element_id: f64,
        index: f64,
        offset_in_item: Option<f64>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        let index = index as usize;
        let offset = offset_in_item.unwrap_or(0.0) as f32;
        if !VIRTUAL_LIST_STATES.with(|states| {
            let Some(w) = states.borrow().get(&id).map(|entry| entry.0) else {
                return false;
            };
            queue_virtual_list_scroll(id, w, index, offset);
            true
        }) {
            SCROLL_HANDLES.with(|handles| {
                if let Some(handle) = handles.borrow().get(&id).map(|entry| &entry.1) {
                    handle.scroll_to_item(index);
                }
            });
        }
        notify_web();
        Ok(())
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getListScrollTop)]
    pub fn get_list_scroll_top(
        &self,
        element_id: f64,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        let top = VIRTUAL_LIST_STATES.with(|states| {
            states.borrow().get(&id).map(|entry| &entry.1).map(|state| {
                let top = state.logical_scroll_top();
                [
                    top.item_ix as f64,
                    f64::from(f32::from(top.offset_in_item)),
                    f64::from(f32::from(state.viewport_bounds().size.height)),
                ]
            })
        });
        let Some(top) = top else {
            return Ok(wasm_bindgen::JsValue::NULL);
        };
        Ok(web_number_array(top))
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getScrollOffset)]
    pub fn get_scroll_offset(
        &self,
        element_id: f64,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let id = web_element_id(element_id)?;
        let offset = VIRTUAL_LIST_STATES
            .with(|states| {
                states.borrow().get(&id).map(|entry| &entry.1).map(|state| {
                    let offset = state.scroll_px_offset_for_scrollbar();
                    [
                        f64::from(f32::from(offset.x)),
                        f64::from(f32::from(offset.y)),
                    ]
                })
            })
            .or_else(|| {
                SCROLL_HANDLES.with(|handles| {
                    handles.borrow().get(&id).map(|entry| &entry.1).map(|handle| {
                        let offset = handle.offset();
                        [
                            f64::from(f32::from(offset.x)),
                            f64::from(f32::from(offset.y)),
                        ]
                    })
                })
            });
        let Some([x, y]) = offset else {
            return Ok(wasm_bindgen::JsValue::NULL);
        };
        Ok(web_number_array([x, y]))
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getAutomationTree)]
    pub fn get_automation_tree(&self) -> Result<String, wasm_bindgen::JsValue> {
        notify_web();
        let bounds = crate::automation::all_bounds();
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        serde_json::to_string(&tree.to_automation_json(&bounds)).map_err(|error| {
            wasm_bindgen::JsValue::from_str(&format!("JSON serialization failed: {error}"))
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getElementBounds)]
    pub fn get_element_bounds(
        &self,
        element_id: f64,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
        let Some(bounds) = crate::automation::get_bounds(web_element_id(element_id)?) else {
            return Ok(wasm_bindgen::JsValue::NULL);
        };
        element_bounds_js(bounds)
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getAllText)]
    pub fn get_all_text(&self) -> wasm_bindgen::JsValue {
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        let mut texts = Vec::new();
        if let Some(root_id) = tree.root_id() {
            collect_text(root_id, &tree, &mut texts);
        }
        web_string_array(texts)
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getPaintedText)]
    pub fn get_painted_text(&self) -> wasm_bindgen::JsValue {
        web_string_array(crate::text::painted_text())
    }

    /// The same array of objects the napi build returns.
    ///
    /// Through `serde_json` and `JSON.parse`, not `serde-wasm-bindgen`: this is
    /// a test-only API, and both crates here are already dependencies. Building
    /// the nested value by hand with `js_sys` is 20 lines of noise.
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getPaintedHighlights)]
    pub fn get_painted_highlights(&self) -> wasm_bindgen::JsValue {
        let matches: Vec<crate::element_tree::HighlightMatch> = crate::text::painted_highlights()
            .into_iter()
            .map(Into::into)
            .collect();
        serde_json::to_string(&matches)
            .ok()
            .and_then(|json| js_sys::JSON::parse(&json).ok())
            .unwrap_or(wasm_bindgen::JsValue::NULL)
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = simulateClick)]
    pub fn simulate_click(
        &self,
        x: f64,
        y: f64,
        button: Option<u32>,
        modifiers: Option<String>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());
        update_web_window_without_view(move |window, cx| {
            crate::automation::dispatch_click(window, cx, x, y, button.unwrap_or(0), modifiers);
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = simulateMouseDown)]
    pub fn simulate_mouse_down(
        &self,
        x: f64,
        y: f64,
        button: Option<u32>,
        modifiers: Option<String>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());
        update_web_window_without_view(move |window, cx| {
            crate::automation::dispatch_mouse_down(
                window,
                cx,
                x,
                y,
                button.unwrap_or(0),
                modifiers,
            );
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = simulateMouseUp)]
    pub fn simulate_mouse_up(
        &self,
        x: f64,
        y: f64,
        button: Option<u32>,
        modifiers: Option<String>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());
        update_web_window_without_view(move |window, cx| {
            crate::automation::dispatch_mouse_up(window, cx, x, y, button.unwrap_or(0), modifiers);
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = simulateMouseMove)]
    pub fn simulate_mouse_move(
        &self,
        x: f64,
        y: f64,
        pressed_button: Option<u32>,
        modifiers: Option<String>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());
        update_web_window_without_view(move |window, cx| {
            crate::automation::dispatch_mouse_move(window, cx, x, y, pressed_button, modifiers);
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = simulateScrollWheel)]
    pub fn simulate_scroll_wheel(
        &self,
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: Option<String>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let modifiers = crate::automation::parse_modifiers(modifiers.as_deref());
        update_web_window_without_view(move |window, cx| {
            crate::automation::dispatch_scroll_wheel(window, cx, x, y, delta_x, delta_y, modifiers);
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = clockPause)]
    pub fn clock_pause(&self) -> Result<f64, wasm_bindgen::JsValue> {
        update_web_window(|view, _window, cx| {
            let now_ms = view.clock.pause();
            cx.notify();
            now_ms
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = clockSet)]
    pub fn clock_set(&self, now_ms: f64) -> Result<f64, wasm_bindgen::JsValue> {
        update_web_window(move |view, _window, cx| {
            let now_ms = view.clock.set_ms(now_ms);
            cx.notify();
            now_ms
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = clockFastForward)]
    pub fn clock_fast_forward(&self, delta_ms: f64) -> Result<f64, wasm_bindgen::JsValue> {
        update_web_window(move |view, _window, cx| {
            let now_ms = view.clock.fast_forward_ms(delta_ms);
            cx.notify();
            now_ms
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = clockResume)]
    pub fn clock_resume(&self) -> Result<f64, wasm_bindgen::JsValue> {
        update_web_window(|view, _window, cx| {
            let now_ms = view.clock.resume();
            cx.notify();
            now_ms
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = setDebugFrameOverlay)]
    pub fn set_debug_frame_overlay(&self, mode: String) -> Result<String, wasm_bindgen::JsValue> {
        let mode = parse_debug_frame_overlay_mode_str(&mode)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error))?;
        // Graphics init is async. render() sets the overlay before WEB_WINDOW exists.
        if WEB_WINDOW.with(|window| window.borrow().is_none()) {
            PENDING_DEBUG_OVERLAY.with(|pending| *pending.borrow_mut() = Some(mode));
            return Ok(debug_frame_overlay_mode_name(mode).to_string());
        }
        update_web_window(move |_view, window, cx| {
            window.set_debug_frame_overlay_mode(mode);
            cx.notify();
            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).to_string()
        })
    }

    #[wasm_bindgen::prelude::wasm_bindgen(js_name = getDebugFrameOverlay)]
    pub fn get_debug_frame_overlay(&self) -> Result<String, wasm_bindgen::JsValue> {
        if WEB_WINDOW.with(|window| window.borrow().is_none()) {
            let pending = PENDING_DEBUG_OVERLAY.with(|pending| *pending.borrow());
            return Ok(debug_frame_overlay_mode_name(
                pending.unwrap_or(gpui::DebugFrameOverlayMode::Hidden),
            )
            .to_string());
        }
        update_web_window(|_view, window, _cx| {
            debug_frame_overlay_mode_name(window.debug_frame_overlay_mode()).to_string()
        })
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
impl Drop for GpuixRenderer {
    fn drop(&mut self) {
        self.ui_commands.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
}

// ── GPUI View ────────────────────────────────────────────────────────

pub(crate) struct GpuixView {
    /// Which renderer window this view is — 0 is the primary window opened by
    /// `GpuixRenderer.init`. Stamped onto every element event this view emits.
    pub(crate) window_id: u32,
    pub(crate) tree: Arc<Mutex<RetainedTree>>,
    pub(crate) event_callback: Option<EventCallback>,
    pub(crate) window_title: String,
    /// Last title sent to AppKit — cached so unchanged titles skip the
    /// `setTitle:` msg-send per rendered frame (~120/sec during resize).
    pub(crate) last_sent_title: String,
    /// Last element the OS file-drag hovered, for synthesized
    /// fileDragLeave — gpui reports drag-move per element, never a
    /// leave. Per-view: a window's hover state is its own.
    pub(crate) file_drag_target: std::rc::Rc<std::cell::Cell<Option<u64>>>,
    /// Armed by a `windowDrag` region's mouse-down, consumed by the first
    /// move that still holds the button → `Window::start_window_move`.
    /// One flag per window: a single pointer means one live drag gesture.
    pub(crate) window_drag_arm: std::rc::Rc<std::cell::Cell<bool>>,
    pub(crate) window_key_down: bool,
    pub(crate) window_key_up: bool,
    pub(crate) window_key_event_id: u64,
    /// Persistent FocusHandles keyed by element ID.
    /// Created lazily for elements with keyboard or focus/blur listeners.
    /// Handles persist across renders so GPUI maintains focus state.
    pub(crate) focus_handles: HashMap<u64, gpui::FocusHandle>,
    pending_focus_element: Option<u64>,
    /// Active focus/blur subscriptions keyed by element and event type.
    pub(crate) focus_subscriptions: HashMap<(u64, String), gpui::Subscription>,
    /// `tree.revision()` at the last sync — the two full-tree passes below
    /// only re-run when the tree actually mutated.
    last_focus_sync_revision: u64,
    /// Window-lifetime platform observers (appearance changes today). Kept so
    /// the subscriptions die with the window rather than outliving it.
    pub(crate) platform_subscriptions: Vec<gpui::Subscription>,
    /// Registry for custom element types (input, editor, diff, etc.).
    /// Stores factories (one per type) and live instances (one per element ID).
    pub(crate) custom_registry: CustomElementRegistry,
    /// Persistent ScrollHandles keyed by element ID.
    /// Created lazily for elements with overflow: "scroll" (or per-axis scroll).
    /// Handles persist across renders so GPUI maintains scroll offset state.
    pub(crate) scroll_handles: HashMap<u64, gpui::ScrollHandle>,
    /// Native animation clocks keyed by retained element ID.
    pub(crate) motion_states: HashMap<u64, crate::motion::MotionState>,
    /// Live text selection, shared with the paint closures and the napi methods.
    pub(crate) selection: SharedSelection,
    /// Persistent measurement and scroll state for React-backed virtual lists.
    virtual_lists: HashMap<u64, VirtualListEntry>,
    /// Latest pointer sample and list during selection edge scrolling.
    selection_drag_position: Option<gpui::Point<gpui::Pixels>>,
    selection_scroll_list: Option<u64>,
    selection_scroll_task: Option<gpui::Task<()>>,
    /// Motion / review clock. Live wall time unless automation freezes it.
    pub(crate) clock: crate::automation::AutomationClock,
    /// Resolved `highlight` state, keyed by the element that declared it.
    /// Empty in every app that does not use search.
    highlights: HashMap<u64, HighlightCacheEntry>,
    /// Entity-backed cached views standing in for unchanged subtrees. Keyed by
    /// the retained element id whose subtree they render.
    memo_views: HashMap<u64, MemoEntry>,
}

/// Two-level cache for one element's `highlight`.
///
/// The group list is keyed by `search_revision`, which a query change does NOT
/// move, so typing in a find bar never re-walks or re-folds text. The matches
/// are additionally keyed by the matcher hash, which excludes `activeIndex` and
/// the colours, so moving the find cursor only re-colours what it already found.
///
/// Do not key the group list on `subtree_revision`: `highlight` is a custom
/// prop, so every keystroke moves that revision and the cache would do nothing.
/// `highlight_cache_tests` at the bottom of this file compares `Arc` identity
/// and fails if either level regresses. A timing budget does not catch it: on
/// the 1000-turn chat the broken version is 2.7ms against 1.9ms.
struct HighlightCacheEntry {
    revision: u64,
    groups: Arc<crate::text::GroupList>,
    matcher_hash: u64,
    /// The spec plus the located matches. Ordinals and colours are decided at
    /// paint, so a colour or `activeIndex` change reuses this whole value.
    context: Arc<crate::text::HighlightContext>,
    /// Last identity delivered through `onHighlight`. Only written once an
    /// event is really queued, so adding the listener later still reports.
    reported: Option<u64>,
}

fn emit_highlight_events(callback: &Option<EventCallback>, events: &[(u64, usize)]) {
    for &(id, total) in events {
        emit_event_full(callback, id, "highlight", |payload| {
            payload.match_count = Some(total as f64);
        });
    }
}

fn window_key_events(
    callback: Option<EventCallback>,
    key_down: bool,
    key_up: bool,
    event_id: u64,
) -> impl gpui::IntoElement {
    use gpui::prelude::*;

    gpui::canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            if key_down || cfg!(all(target_arch = "wasm32", target_os = "unknown")) {
                let callback = callback.clone();
                window.on_root_key_event(move |event: &gpui::KeyDownEvent, phase, _window, _cx| {
                    if phase != gpui::DispatchPhase::Bubble {
                        return;
                    }
                    if key_down {
                        emit_event_full(&callback, event_id, "windowKeyDown", |payload| {
                            payload.key = Some(event.keystroke.key.clone());
                            payload.key_char = event.keystroke.key_char.clone();
                            payload.is_held = Some(event.is_held);
                            payload.modifiers = Some(event.keystroke.modifiers.into());
                        });
                    }
                    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
                    if event.keystroke.key == "tab" {
                        // Keep browser focus on GPUI's hidden keyboard element.
                        _cx.stop_propagation();
                    }
                });
            }
            if key_up {
                let callback = callback.clone();
                window.on_root_key_event(move |event: &gpui::KeyUpEvent, phase, _window, _cx| {
                    if phase != gpui::DispatchPhase::Bubble {
                        return;
                    }
                    emit_event_full(&callback, event_id, "windowKeyUp", |payload| {
                        payload.key = Some(event.keystroke.key.clone());
                        payload.key_char = event.keystroke.key_char.clone();
                        payload.modifiers = Some(event.keystroke.modifiers.into());
                    });
                });
            }
        },
    )
    .absolute()
    .w(gpui::px(0.0))
    .h(gpui::px(0.0))
}

/// Per-frame `FileDropEvent` listener. `on_drag_move` covers the hover trio
/// while the pointer is over a listener element, but gpui never fires a
/// per-element leave — `FileDropEvent::{Exited,Ended}` are the real session
/// boundaries (Exited: pointer left the window; Ended: drop happened
/// elsewhere or the drag was cancelled). Either one closes the hover
/// session: emit the pending `fileDragLeave` for the last-entered element
/// and clear the target cell so the next session re-enters cleanly.
fn file_drop_events(
    callback: Option<EventCallback>,
    drag_target: std::rc::Rc<std::cell::Cell<Option<u64>>>,
) -> impl gpui::IntoElement {
    use gpui::prelude::*;

    gpui::canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            let callback = callback.clone();
            let drag_target = drag_target.clone();
            window.on_mouse_event(
                move |event: &gpui::FileDropEvent, phase, _window, _cx| {
                    if phase != gpui::DispatchPhase::Bubble {
                        return;
                    }
                    match event {
                        gpui::FileDropEvent::Exited | gpui::FileDropEvent::Ended => {
                            if let Some(exited) = drag_target.take() {
                                emit_event_full(&callback, exited, "fileDragLeave", |_| {});
                            }
                        }
                        _ => {}
                    }
                },
            );
        },
    )
    .absolute()
    .w(gpui::px(0.0))
    .h(gpui::px(0.0))
}

/// Resolve one element's `highlight` prop, reusing both cache levels.
///
/// Returns the context, plus the match count when `has_listener` and the result
/// differs from the last one this element reported. Identity, not count:
/// swapping a query for a different one with the same number of hits is still a
/// new result.
fn resolve_highlight(
    cache: &mut HashMap<u64, HighlightCacheEntry>,
    tree: &RetainedTree,
    id: u64,
    value: &serde_json::Value,
    theme: &Theme,
    has_listener: bool,
) -> Option<(Arc<crate::text::HighlightContext>, Option<usize>)> {
    let set = crate::text::HighlightSet::parse(value, theme)?;
    // `search_revision`, NOT `subtree_revision`: `highlight` is a custom prop,
    // so the general revision moves on every keystroke and this cache would
    // never hit for the one case it exists for.
    let revision = tree.elements.get(&id)?.search_revision;
    let matcher_hash = set.matcher_hash();

    let cached = cache
        .get(&id)
        .filter(|entry| entry.revision == revision && entry.matcher_hash == matcher_hash);
    let context = match cached {
        // Nothing moved at all. Returning the same `Arc` keeps the whole
        // subtree's inherited value identical, which the cache tests assert.
        Some(entry) if entry.context.set == set => entry.context.clone(),
        // Same matches, different colours or find cursor: reuse the located
        // matches and swap only the spec. No text is scanned.
        Some(entry) => {
            let context = Arc::new(crate::text::HighlightContext {
                declaration: id,
                set,
                matches: entry.context.matches.clone(),
            });
            cache.get_mut(&id)?.context = context.clone();
            context
        }
        None => {
            let groups = match cache.get(&id) {
                Some(entry) if entry.revision == revision => entry.groups.clone(),
                _ => Arc::new(crate::text::GroupList::collect(tree, id)),
            };
            let context = Arc::new(crate::text::HighlightContext {
                declaration: id,
                matches: Arc::new(crate::text::search::resolve(&groups, &set)),
                set,
            });
            let reported = cache.get(&id).and_then(|entry| entry.reported);
            cache.insert(
                id,
                HighlightCacheEntry {
                    revision,
                    groups,
                    matcher_hash,
                    context: context.clone(),
                    reported,
                },
            );
            context
        }
    };

    if !has_listener {
        return Some((context, None));
    }
    let identity = context.matches.identity();
    let entry = cache.get_mut(&id)?;
    if entry.reported == Some(identity) {
        return Some((context, None));
    }
    entry.reported = Some(identity);
    let total = context.matches.total;
    Some((context, Some(total)))
}

impl GpuixView {
    pub(crate) fn new(
        window_id: u32,
        tree: Arc<Mutex<RetainedTree>>,
        event_callback: Option<EventCallback>,
        window_title: String,
        selection: SharedSelection,
        clock: crate::automation::AutomationClock,
    ) -> Self {
        // Stamp the emitting window onto every element event — individual
        // emit sites stay window-agnostic.
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        let event_callback = event_callback.map(|callback| {
            std::rc::Rc::new(move |mut payload: EventPayload| {
                payload.window_id = Some(window_id);
                callback(payload)
            }) as EventCallback
        });
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        let event_callback = event_callback.map(|callback| {
            std::sync::Arc::new(move |mut payload: EventPayload| {
                payload.window_id = Some(window_id);
                callback(payload)
            }) as EventCallback
        });
        Self {
            window_id,
            tree,
            event_callback,
            window_title: window_title.clone(),
            last_sent_title: window_title,
            file_drag_target: std::rc::Rc::new(std::cell::Cell::new(None)),
            window_drag_arm: std::rc::Rc::new(std::cell::Cell::new(false)),
            window_key_down: false,
            window_key_up: false,
            window_key_event_id: 0,
            focus_handles: HashMap::new(),
            pending_focus_element: None,
            focus_subscriptions: HashMap::new(),
            last_focus_sync_revision: 0,
            platform_subscriptions: Vec::new(),
            custom_registry: CustomElementRegistry::with_defaults(),
            scroll_handles: HashMap::new(),
            motion_states: HashMap::new(),
            selection,
            virtual_lists: HashMap::new(),
            selection_drag_position: None,
            selection_scroll_list: None,
            selection_scroll_task: None,
            clock,
            highlights: HashMap::new(),
            memo_views: HashMap::new(),
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
/// Drop every thread-local row a dead window owned — scroll/list mirrors,
/// pending scrolls, reported anchors, bounds. Element ids are never reused
/// so stale rows couldn't misroute, but they would leak a `ScrollHandle`/
/// `ListState` per open-close cycle. Every cell uses `try_with`: at process
/// teardown the thread-locals may already be gone.
#[cfg(target_os = "macos")]
fn drop_window_state(window_id: u32) {
    SCROLL_HANDLES
        .try_with(|cell| {
            cell.borrow_mut().retain(|_, (w, _)| *w != window_id)
        })
        .ok();
    VIRTUAL_LIST_STATES
        .try_with(|cell| {
            let mut states = cell.borrow_mut();
            // Collect this window's list ids before draining — the gpui
            // marks map is id-keyed with no window tag.
            let list_ids: Vec<u64> = states
                .iter()
                .filter(|(_, (w, _))| *w == window_id)
                .map(|(id, _)| *id)
                .collect();
            states.retain(|_, (w, _)| *w != window_id);
            GPUI_REPORTED_SCROLLS
                .try_with(|marked| {
                    let mut marked = marked.borrow_mut();
                    for id in &list_ids {
                        marked.remove(id);
                    }
                })
                .ok();
        })
        .ok();
    PENDING_VIRTUAL_LIST_SCROLLS
        .try_with(|cell| {
            cell.borrow_mut().retain(|_, (w, _)| *w != window_id)
        })
        .ok();
    REPORTED_VIRTUAL_LIST_TOPS
        .try_with(|cell| {
            cell.borrow_mut().retain(|_, (w, _)| *w != window_id)
        })
        .ok();
    crate::automation::drop_window_bounds(window_id);
    crate::text::paint::drop_window_registries(window_id);
}

impl Drop for GpuixView {
    fn drop(&mut self) {
        // Whatever the close path — `window.close`, OS red button, app quit —
        // the window's root binding and registry entry die with the view, and
        // JS hears `closed` so it can tear the subtree down through normal
        // destroy ops.
        if let Ok(mut tree) = self.tree.lock() {
            tree.roots.remove(&self.window_id);
        }
        #[cfg(target_os = "macos")]
        drop_window_state(self.window_id);
        // try_with: at process teardown the thread-locals may already be
        // gone — the window is dying anyway, nothing to deregister.
        #[cfg(target_os = "macos")]
        let _ = WINDOWS.try_with(|windows| {
            windows.borrow_mut().remove(&self.window_id);
        });
        if let Some(callback) = &self.event_callback {
            callback(EventPayload {
                element_id: crate::platform::PLATFORM_EVENT_ID,
                event_type: "platform:closed".to_string(),
                data: Some(serde_json::json!({ "windowId": self.window_id })),
                ..Default::default()
            });
        }
    }
}

impl GpuixView {

    /// Build one memoized subtree for its `GpuixSubtree` entity. This is the
    /// same walk as the root build, seeded with the context the subtree was
    /// emitted under; the boundary flag keeps the root element from emitting
    /// its own cached view inside itself.
    fn build_memo_subtree(
        &mut self,
        id: u64,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<GpuixView>,
    ) -> gpui::AnyElement {
        use gpui::IntoElement;

        let tree_arc = self.tree.clone();
        let tree = tree_arc.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = self.memo_views.get(&id) else {
            return gpui::Empty.into_any_element();
        };
        let inherited = entry.inherited.clone();
        let slot = entry.key.slot;
        // The leaf's style claims the outer box; the subtree root must fill
        // it rather than re-resolve its own sizing against itself.
        let boundary_style = tree
            .elements
            .get(&id)
            .and_then(|element| element.style.as_deref())
            .map(|style| {
                let mut normalized = style.clone();
                normalized.width = Some(crate::style::DimensionValue::Percentage(1.0));
                normalized.height = Some(crate::style::DimensionValue::Percentage(1.0));
                normalized.position = None;
                normalized.top = None;
                normalized.right = None;
                normalized.bottom = None;
                normalized.left = None;
                normalized.margin = None;
                normalized.margin_top = None;
                normalized.margin_right = None;
                normalized.margin_bottom = None;
                normalized.margin_left = None;
                Arc::new(normalized)
            });
        let callback = self.event_callback.clone();
        let now = self.clock.now();
        let mut motion_active = false;
        let mut highlight_events = Vec::new();
        let mut ctx = BuildCtx {
            tree: &tree,
            event_callback: &callback,
            focus_handles: &self.focus_handles,
            scroll_handles: &mut self.scroll_handles,
            custom_registry: &mut self.custom_registry,
            virtual_lists: &mut self.virtual_lists,
            motion_states: &mut self.motion_states,
            now,
            motion_active: &mut motion_active,
            selection: self.selection.clone(),
            inherited,
            highlights: &mut self.highlights,
            highlight_events: &mut highlight_events,
            memo_views: &mut self.memo_views,
            root_weak: cx.weak_entity(),
            tree_handle: tree_arc.clone(),
            file_drag_target: &self.file_drag_target,
            window_drag_arm: &self.window_drag_arm,
            slot,
            memo_boundary: Some(id),
            boundary_style,
        };
        let (built, _) = build_element(id, &mut ctx, window, cx);
        emit_highlight_events(&callback, &highlight_events);
        built
    }

    fn build_virtual_child(
        &mut self,
        list_id: u64,
        index: usize,
        expected_child_id: u64,
        inherited: Inherited,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> gpui::AnyElement {
        use gpui::prelude::*;

        let row_focus_handle = self.virtual_lists.get_mut(&list_id).and_then(|entry| {
            entry.seen_rows.insert(expected_child_id);
            (entry.child_at(index) == Some(expected_child_id))
                .then(|| {
                    index
                        .checked_sub(entry.window_start)
                        .and_then(|offset| entry.row_focus_handles.get(offset).cloned())
                })
                .flatten()
                .flatten()
        });

        let tree_arc = self.tree.clone();
        let tree = tree_arc.lock().unwrap_or_else(|p| p.into_inner());
        let window_start = self
            .virtual_lists
            .get(&list_id)
            .map(|entry| entry.window_start)
            .unwrap_or(0);
        let child_matches = tree.elements.get(&list_id).and_then(|list| {
            index
                .checked_sub(window_start)
                .and_then(|offset| list.children.get(offset))
        }) == Some(&expected_child_id);
        if !child_matches {
            let height = self
                .virtual_lists
                .get(&list_id)
                .and_then(|entry| entry.config.estimated_item_height)
                .unwrap_or(1.0);
            return unmounted_virtual_row(height);
        }

        let callback = self.event_callback.clone();
        let now = self.clock.now();
        let mut motion_active = false;
        let mut highlight_events = Vec::new();

        // Re-resolve against the tree as it is NOW. gpui calls this during
        // layout and prepaint, after the root render returned, and on Windows
        // and Linux the Node thread can commit new text in between. Reusing the
        // captured ranges would paint a wash over the wrong glyphs, or at a byte
        // offset that is no longer a character boundary.
        let mut inherited = inherited;
        if let Some(declaration) = inherited.highlight.as_ref().map(|ctx| ctx.declaration) {
            inherited.highlight = tree
                .elements
                .get(&declaration)
                .and_then(|element| element.custom_props.get("highlight"))
                .and_then(|value| {
                    resolve_highlight(
                        &mut self.highlights,
                        &tree,
                        declaration,
                        value,
                        &Theme::dark(),
                        false,
                    )
                })
                .map(|(context, _)| context);
        }

        let mut build_ctx = BuildCtx {
            tree: &tree,
            event_callback: &callback,
            focus_handles: &self.focus_handles,
            scroll_handles: &mut self.scroll_handles,
            custom_registry: &mut self.custom_registry,
            virtual_lists: &mut self.virtual_lists,
            motion_states: &mut self.motion_states,
            now,
            motion_active: &mut motion_active,
            selection: self.selection.clone(),
            inherited,
            highlights: &mut self.highlights,
            highlight_events: &mut highlight_events,
            memo_views: &mut self.memo_views,
            root_weak: cx.weak_entity(),
            tree_handle: tree_arc.clone(),
            file_drag_target: &self.file_drag_target,
            window_drag_arm: &self.window_drag_arm,
            slot: SlotCtx::virtual_row(),
            memo_boundary: None,
            boundary_style: None,
        };
        let (child, marker) = build_element(expected_child_id, &mut build_ctx, window, cx);
        emit_highlight_events(&callback, &highlight_events);
        if motion_active {
            window.request_animation_frame();
        }
        let Some(focus_handle) = row_focus_handle else {
            return match marker {
                // The marker must paint after the child; a bare sibling needs a
                // wrapper only on this otherwise wrapper-free path.
                Some(marker) => gpui::div().child(child).child(marker).into_any_element(),
                None => child,
            };
        };
        let row = gpui::div()
            .id(gpui::SharedString::from(format!(
                "__gpuix_virtual_row_{}_{}",
                list_id, expected_child_id
            )))
            .w_full()
            .track_focus(&focus_handle)
            .child(child);
        match marker {
            Some(marker) => row.child(marker).into_any_element(),
            None => row.into_any_element(),
        }
    }

    pub(crate) fn scroll_virtual_list_to_item(
        &self,
        id: u64,
        index: usize,
        offset_in_item: f32,
    ) -> bool {
        if !self.virtual_lists.contains_key(&id) {
            return false;
        }
        // The queued scroll applies on the next build; `visibleRange` reports
        // from the state mirror once the anchor has actually moved.
        queue_virtual_list_scroll(id, self.window_id, index, offset_in_item);
        true
    }

    /// The list's logical scroll anchor as
    /// `[item_ix, offset_in_item_px, viewport_height_px]`.
    ///
    /// `item_ix == item count` is gpui's at-end sentinel (a bottom-aligned
    /// list resting at its very end); the viewport height is what lets a
    /// caller convert that into a position relative to the trailing rows.
    pub(crate) fn virtual_list_scroll_top(&self, id: u64) -> Option<[f64; 3]> {
        let state = &self.virtual_lists.get(&id)?.state;
        let top = state.logical_scroll_top();
        Some([
            top.item_ix as f64,
            f64::from(f32::from(top.offset_in_item)),
            f64::from(f32::from(state.viewport_bounds().size.height)),
        ])
    }

    pub(crate) fn set_virtual_list_offset(&self, id: u64, x: f32, y: f32) -> bool {
        let Some(entry) = self.virtual_lists.get(&id) else {
            return false;
        };
        entry
            .state
            .set_offset_from_scrollbar(gpui::point(gpui::px(x), gpui::px(y)));
        true
    }

    pub(crate) fn virtual_list_offset(&self, id: u64) -> Option<[f64; 2]> {
        let offset = self
            .virtual_lists
            .get(&id)?
            .state
            .scroll_px_offset_for_scrollbar();
        Some([
            f64::from(f32::from(offset.x)),
            f64::from(f32::from(offset.y)),
        ])
    }

    pub(crate) fn reveal_virtual_list_ancestor(&self, id: u64) -> bool {
        let tree_arc = self.tree.clone();
        let tree = tree_arc.lock().unwrap_or_else(|p| p.into_inner());
        let mut current = id;
        let location = loop {
            let Some(parent_id) = tree
                .elements
                .get(&current)
                .and_then(|element| element.parent)
            else {
                break None;
            };
            if let Some(entry) = self.virtual_lists.get(&parent_id) {
                // A virtual list's children are the materialized window; the
                // logical row index comes from the entry's own window mapping,
                // not the retained-tree child order.
                break entry
                    .logical_index_of(current)
                    .map(|index| (parent_id, index));
            }
            current = parent_id;
        };
        drop(tree);

        let Some((list_id, index)) = location else {
            return false;
        };
        self.scroll_virtual_list_to_item(list_id, index, 0.0)
    }
}

/// Everything `build_element` threads through the tree.
///
/// Split into a struct because the recursion needs eight-plus shared references
/// and adding one more to every call site is how this file rots. `window` and
/// `cx` stay separate parameters: they are `&mut` and gpui reborrows them.
pub(crate) struct BuildCtx<'a> {
    pub tree: &'a RetainedTree,
    pub event_callback: &'a Option<EventCallback>,
    pub focus_handles: &'a HashMap<u64, gpui::FocusHandle>,
    pub scroll_handles: &'a mut HashMap<u64, gpui::ScrollHandle>,
    pub custom_registry: &'a mut CustomElementRegistry,
    virtual_lists: &'a mut HashMap<u64, VirtualListEntry>,
    pub motion_states: &'a mut HashMap<u64, crate::motion::MotionState>,
    pub now: web_time::Instant,
    pub motion_active: &'a mut bool,
    pub selection: SharedSelection,
    /// Inherited text state, resolved the way CSS inherits it. The renderer's
    /// own theme only seeds the root selection wash; custom elements resolve
    /// their own theme from their `theme` prop.
    pub inherited: Inherited,
    /// Persistent `highlight` caches, keyed by the declaring element.
    highlights: &'a mut HashMap<u64, HighlightCacheEntry>,
    /// `onHighlight` payloads queued during the build.
    ///
    /// Never emitted inline: a handler that calls `setState` repaints, which
    /// would re-enter the build and emit again. They are flushed once the root
    /// build has returned.
    highlight_events: &'a mut Vec<(u64, usize)>,
    /// Cached-subtree views, owned by `GpuixView` so they survive the walk.
    memo_views: &'a mut HashMap<u64, MemoEntry>,
    /// Weak self-handle for `GpuixSubtree` entities to re-enter the root view.
    root_weak: gpui::WeakEntity<GpuixView>,
    /// Shared tree handle for marker closures, which run at paint time after
    /// the build's lock has been released.
    tree_handle: Arc<Mutex<RetainedTree>>,
    /// What the parent container guarantees about this element's box. A
    /// memoized leaf must be definite on both axes — GPUI never measures a
    /// cached subtree by its content.
    slot: SlotCtx,
    /// Shared file-drag hover cell — the view's `file_drag_target`,
    /// threaded so element drag-move closures can diff enter/leave.
    file_drag_target: &'a std::rc::Rc<std::cell::Cell<Option<u64>>>,
    /// The view's `window_drag_arm` — shared into `windowDrag` closures.
    window_drag_arm: &'a std::rc::Rc<std::cell::Cell<bool>>,
    /// `Some(id)` while building inside `build_memo_subtree(id)`.
    memo_boundary: Option<u64>,
    /// Normalized style for the memo boundary's root element. The cached leaf
    /// already claims the outer box — position, margins and offsets live
    /// there — so the inner root just fills it (`100%×100%`) instead of
    /// re-resolving its own percentages against itself.
    boundary_style: Option<Arc<StyleDesc>>,
}

/// Style properties that cascade into descendants.
///
/// Not `Copy`: `highlight` holds an `Arc`. Every call site must clone
/// explicitly, including the deferred `build_virtual_child` callback, which gpui
/// may run more than once per frame.
#[derive(Clone)]
pub(crate) struct Inherited {
    /// False once an ancestor sets `userSelect: "none"`.
    pub selectable: bool,
    /// Selection wash colour for this subtree.
    pub selection_wash: gpui::Hsla,
    /// The nearest ancestor's `highlight`, resolved. `None` in every app that
    /// does not use search. It carries the declaring element id, which is what
    /// a virtual-list row re-resolves against: that row is built after the root
    /// render returns, and on Windows and Linux the Node thread can edit text
    /// in between, so a stale range would paint over the wrong glyphs.
    pub highlight: Option<Arc<crate::text::HighlightContext>>,
    /// Design tokens for this subtree. A `theme` custom prop on any element
    /// overrides it for that element and its descendants; recipes resolve
    /// token refs (`color-muted`, `control-md`, `primary/20`) against it.
    pub tokens: Arc<crate::tokens::TokenTheme>,
    /// The nearest `color` custom prop — svelai's `data-color` ctx. It
    /// cascades to descendants, so an ancestor's `color` restyles every
    /// ctx-aware element below it unless they pin their own.
    pub color: Option<String>,
    /// Nearest ancestor `textTransform` — the string is transformed before
    /// shaping, so glyphs, hit-testing, and copy all see the transformed
    /// text (which is also what CSS does to copied content).
    pub text_transform: Option<String>,
}

impl Inherited {
    fn root(theme: &Theme, tokens: Arc<crate::tokens::TokenTheme>) -> Self {
        let mut wash = theme.accent;
        wash.a = 0.35;
        Self {
            selectable: true,
            selection_wash: wash,
            highlight: None,
            tokens,
            color: None,
            text_transform: None,
        }
    }

    /// Apply the inheritable parts of `style` for the subtree below it.
    fn descend(mut self, style: Option<&StyleDesc>) -> Self {
        let Some(style) = style else { return self };
        match style.user_select.as_deref() {
            Some("none") => self.selectable = false,
            Some("text") | Some("auto") => self.selectable = true,
            _ => {}
        }
        if let Some(color) = style
            .selection_color
            .as_deref()
            .and_then(crate::color::parse_color_rgba)
        {
            self.selection_wash = color.into();
        }
        if let Some(transform) = &style.text_transform {
            self.text_transform = match transform.as_str() {
                "none" => None,
                _ => Some(transform.clone()),
            };
        }
        self
    }
}

fn json_usize(value: &serde_json::Value) -> Option<usize> {
    value
        .as_u64()
        .map(|n| n as usize)
        .or_else(|| {
            value
                .as_f64()
                .filter(|n| *n >= 0.0 && n.is_finite())
                .map(|n| n as usize)
        })
        .or_else(|| value.as_i64().filter(|n| *n >= 0).map(|n| n as usize))
}

fn window_start_from_element(element: &crate::retained_tree::RetainedElement) -> usize {
    element
        .custom_props
        .get("windowStart")
        .and_then(json_usize)
        .unwrap_or(0)
}

#[derive(Clone, Copy, PartialEq)]
struct VirtualListConfig {
    alignment: gpui::ListAlignment,
    follow_tail: bool,
    overdraw: f32,
    estimated_item_height: Option<f32>,
    item_count: Option<usize>,
}

impl VirtualListConfig {
    fn from_element(element: &crate::retained_tree::RetainedElement) -> Self {
        let prop = |key: &str| element.custom_props.get(key);
        let alignment = match prop("alignment").and_then(serde_json::Value::as_str) {
            Some("bottom") => gpui::ListAlignment::Bottom,
            _ => gpui::ListAlignment::Top,
        };
        let follow_tail = prop("followTail")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let overdraw = prop("overdraw")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(512.0)
            .max(0.0) as f32;
        let estimated_item_height = prop("estimatedItemHeight")
            .and_then(serde_json::Value::as_f64)
            .filter(|height| *height > 0.0)
            .map(|height| height as f32);
        let item_count = estimated_item_height.and_then(|_| prop("itemCount").and_then(json_usize));
        Self {
            alignment,
            follow_tail,
            overdraw,
            estimated_item_height,
            item_count,
        }
    }

    fn logical_count(self, child_len: usize) -> usize {
        self.item_count.unwrap_or(child_len)
    }

    fn make_state(
        self,
        item_count: usize,
        focus_handles: &[Option<gpui::FocusHandle>],
    ) -> gpui::ListState {
        let mut state = gpui::ListState::new(item_count, self.alignment, gpui::px(self.overdraw));
        if focus_handles.len() == item_count {
            state.splice_focusable(0..item_count, focus_handles.iter().cloned());
        } else {
            state.splice_focusable(0..item_count, (0..item_count).map(|_| None));
        }
        if let Some(height) = self.estimated_item_height {
            state = state.with_uniform_item_height(gpui::px(height));
        }
        if self.follow_tail {
            state.set_follow_mode(gpui::FollowMode::Tail);
        }
        state
    }
}

struct VirtualListEntry {
    state: gpui::ListState,
    config: VirtualListConfig,
    window_start: usize,
    child_ids: Vec<u64>,
    child_revisions: Vec<u64>,
    row_focus_handles: Vec<Option<gpui::FocusHandle>>,
    seen_rows: HashSet<u64>,
}

impl VirtualListEntry {
    fn new(
        config: VirtualListConfig,
        window_start: usize,
        child_ids: Vec<u64>,
        child_revisions: Vec<u64>,
        row_focus_handles: Vec<Option<gpui::FocusHandle>>,
    ) -> Self {
        let item_count = config.logical_count(child_ids.len());
        let state = config.make_state(item_count, &row_focus_handles);
        if row_focus_handles.len() != item_count {
            for (offset, handle) in row_focus_handles.iter().enumerate() {
                if handle.is_some() {
                    let logical = window_start + offset;
                    if logical < item_count {
                        state.splice_focusable(
                            logical..logical + 1,
                            std::iter::once(handle.clone()),
                        );
                    }
                }
            }
        }
        Self {
            state,
            config,
            window_start,
            child_ids,
            child_revisions,
            row_focus_handles,
            seen_rows: HashSet::new(),
        }
    }

    fn child_at(&self, logical_index: usize) -> Option<u64> {
        logical_index
            .checked_sub(self.window_start)
            .and_then(|offset| self.child_ids.get(offset).copied())
    }

    fn logical_index_of(&self, child_id: u64) -> Option<usize> {
        self.child_ids
            .iter()
            .position(|id| *id == child_id)
            .map(|offset| self.window_start + offset)
    }

    fn sync(
        &mut self,
        config: VirtualListConfig,
        window_start: usize,
        child_ids: Vec<u64>,
        child_revisions: Vec<u64>,
        focusable_rows: &HashSet<u64>,
        cx: &mut gpui::Context<GpuixView>,
    ) {
        let focus_unchanged = self.child_ids == child_ids
            && self.row_focus_handles.len() == child_ids.len()
            && self
                .child_ids
                .iter()
                .zip(&self.row_focus_handles)
                .all(|(id, handle)| handle.is_some() == focusable_rows.contains(id));
        if self.config == config
            && self.window_start == window_start
            && focus_unchanged
            && self.child_revisions == child_revisions
        {
            return;
        }

        let old_rows: HashMap<u64, (u64, Option<gpui::FocusHandle>)> = self
            .child_ids
            .iter()
            .copied()
            .zip(self.child_revisions.iter().copied())
            .zip(self.row_focus_handles.iter().cloned())
            .map(|((id, revision), focus_handle)| (id, (revision, focus_handle)))
            .collect();
        let row_focus_handles: Vec<Option<gpui::FocusHandle>> = child_ids
            .iter()
            .map(|id| {
                focusable_rows.contains(id).then(|| {
                    old_rows
                        .get(id)
                        .and_then(|(_, focus_handle)| focus_handle.clone())
                        .unwrap_or_else(|| cx.focus_handle())
                })
            })
            .collect();
        if self.config != config {
            let scroll_top = self.state.logical_scroll_top();
            let should_follow =
                config.follow_tail && (!self.config.follow_tail || self.state.is_following_tail());
            let mut replacement = Self::new(
                config,
                window_start,
                child_ids,
                child_revisions,
                row_focus_handles,
            );
            replacement.seen_rows = std::mem::take(&mut self.seen_rows);
            replacement
                .seen_rows
                .retain(|id| replacement.child_ids.contains(id));
            if !should_follow {
                replacement.state.scroll_to(scroll_top);
            }
            *self = replacement;
            return;
        }

        // gpui anchors a list on a logical item, so splicing rows in at the
        // front keeps the rows already on screen and pushes the new ones above
        // the viewport. A browser anchors too, but suppresses it at scrollTop 0,
        // so a prepend is visible. Match the browser: remember a list pinned to
        // the top and put it back after the splice.
        //
        // While the content is shorter than the viewport gpui re-anchors to
        // item 0 every layout, so the drift only appears once the list
        // overflows. That is why `example-app` looked stuck at two rows.
        //
        // The guard is `is_following_tail()`, not `config.follow_tail`: a
        // following list that does not fill its viewport also ends layout
        // anchored at {0, 0}, and `scroll_to` would call `stop_following` on it.
        // Once the user scrolls up to the top, following is already stopped, so
        // a top-aligned `followTail` list still gets the browser behaviour.
        let top = self.state.logical_scroll_top();
        let was_pinned_to_top = matches!(config.alignment, gpui::ListAlignment::Top)
            && !self.state.is_following_tail()
            && top.item_ix == 0
            && top.offset_in_item <= gpui::px(0.0);

        // A windowed list's children are a sliding viewport. Splicing by
        // child position would treat a scroll as a rewrite of items 0..N.
        if config.item_count.is_none() && self.child_ids != child_ids {
            let prefix = self
                .child_ids
                .iter()
                .zip(&child_ids)
                .take_while(|(old, new)| old == new)
                .count();
            let suffix = self.child_ids[prefix..]
                .iter()
                .rev()
                .zip(child_ids[prefix..].iter().rev())
                .take_while(|(old, new)| old == new)
                .count();
            self.state.splice_focusable(
                prefix..self.child_ids.len().saturating_sub(suffix),
                row_focus_handles[prefix..row_focus_handles.len().saturating_sub(suffix)]
                    .iter()
                    .cloned(),
            );
            if let Some(height) = config.estimated_item_height {
                self.state = self
                    .state
                    .clone()
                    .with_uniform_item_height(gpui::px(height));
            }
        }

        for (offset, (&id, focus_handle)) in child_ids.iter().zip(&row_focus_handles).enumerate() {
            let logical = window_start + offset;
            let focusability_changed = old_rows
                .get(&id)
                .is_some_and(|(_, old_handle)| old_handle.is_some() != focus_handle.is_some());
            if focusability_changed {
                self.state
                    .splice_focusable(logical..logical + 1, std::iter::once(focus_handle.clone()));
            }
        }

        let mut changed_start = None;
        for (offset, (&id, &revision)) in child_ids.iter().zip(&child_revisions).enumerate() {
            let logical = window_start + offset;
            let changed = old_rows
                .get(&id)
                .is_some_and(|(old_revision, _)| *old_revision != revision);
            match (changed_start, changed) {
                (None, true) => changed_start = Some(logical),
                (Some(start), false) => {
                    self.state.remeasure_items(start..logical);
                    changed_start = None;
                }
                _ => {}
            }
        }
        if let Some(start) = changed_start {
            self.state
                .remeasure_items(start..window_start + child_ids.len());
        }
        self.remeasure_unknown_rows(window_start, &child_ids, &old_rows);
        if was_pinned_to_top {
            self.state.scroll_to(gpui::ListOffset::default());
        }

        self.window_start = window_start;
        self.child_ids = child_ids;
        self.child_revisions = child_revisions;
        self.row_focus_handles = row_focus_handles;
    }

    fn remeasure_unknown_rows(
        &mut self,
        window_start: usize,
        child_ids: &[u64],
        known: &HashMap<u64, (u64, Option<gpui::FocusHandle>)>,
    ) {
        let mut range_start = None;
        for (offset, id) in child_ids.iter().enumerate() {
            let logical = window_start + offset;
            let is_new = !known.contains_key(id);
            match (range_start, is_new) {
                (None, true) => range_start = Some(logical),
                (Some(start), false) => {
                    self.state.remeasure_items(start..logical);
                    range_start = None;
                }
                _ => {}
            }
        }
        if let Some(start) = range_start {
            self.state
                .remeasure_items(start..window_start + child_ids.len());
        }
    }
}

impl GpuixView {
    fn request_focus(&mut self, id: u64, window: &mut gpui::Window, cx: &mut gpui::Context<Self>) {
        self.reveal_virtual_list_ancestor(id);
        if let Some(handle) = self.focus_handles.get(&id) {
            self.pending_focus_element = None;
            handle.focus(window, cx);
        } else {
            self.pending_focus_element = Some(id);
        }
        cx.notify();
    }

    pub(crate) fn focused_element_id(&self, window: &gpui::Window) -> Option<u64> {
        self.focus_handles
            .iter()
            .find_map(|(id, handle)| handle.is_focused(window).then_some(*id))
    }

    fn descendant_ids(&self, ancestor: u64) -> HashSet<u64> {
        let tree = self.tree.lock().unwrap_or_else(|p| p.into_inner());
        let mut ids = HashSet::new();
        fn walk(tree: &RetainedTree, id: u64, ids: &mut HashSet<u64>) {
            ids.insert(id);
            let Some(element) = tree.elements.get(&id) else {
                return;
            };
            for child in &element.children {
                walk(tree, *child, ids);
            }
        }
        walk(&tree, ancestor, &mut ids);
        ids
    }

    fn focus_among(
        &self,
        ancestor: u64,
        forward: bool,
        window: &mut gpui::Window,
        cx: &mut gpui::App,
    ) {
        let ids = self.descendant_ids(ancestor);
        let allowed: HashSet<gpui::FocusId> = self
            .focus_handles
            .iter()
            .filter_map(|(id, handle)| ids.contains(id).then_some(handle.id()))
            .collect();
        if forward {
            window.focus_next_among(|id| allowed.contains(id), cx);
        } else {
            window.focus_prev_among(|id| allowed.contains(id), cx);
        }
    }

    pub(crate) fn focus_next_within(
        &self,
        ancestor: u64,
        window: &mut gpui::Window,
        cx: &mut gpui::App,
    ) {
        self.focus_among(ancestor, true, window, cx);
    }

    pub(crate) fn focus_previous_within(
        &self,
        ancestor: u64,
        window: &mut gpui::Window,
        cx: &mut gpui::App,
    ) {
        self.focus_among(ancestor, false, window, cx);
    }

    fn on_selection_mouse_move(
        &mut self,
        position: gpui::Point<gpui::Pixels>,
        cx: &mut gpui::Context<Self>,
    ) {
        if !self.selection.lock().is_dragging() {
            self.stop_selection_scroll();
            return;
        }
        let list_id = self
            .selection_scroll_list
            .filter(|id| {
                self.virtual_lists.get(id).is_some_and(|entry| {
                    let bounds = entry.state.viewport_bounds();
                    position.x >= bounds.left() && position.x <= bounds.right()
                })
            })
            .or_else(|| {
                self.virtual_lists
                    .iter()
                    .find(|(_, entry)| entry.state.viewport_bounds().contains(&position))
                    .map(|(id, _)| *id)
            });
        let Some(list_id) = list_id else {
            self.stop_selection_scroll();
            return;
        };
        self.selection_drag_position = Some(position);
        self.selection_scroll_list = Some(list_id);
        self.schedule_selection_scroll(cx);
    }

    fn stop_selection_scroll(&mut self) {
        self.selection_drag_position = None;
        self.selection_scroll_list = None;
        self.selection_scroll_task = None;
    }

    fn schedule_selection_scroll(&mut self, cx: &mut gpui::Context<Self>) {
        if self.selection_scroll_task.is_some() || !self.selection.lock().is_dragging() {
            return;
        }
        let (Some(position), Some(list_id)) =
            (self.selection_drag_position, self.selection_scroll_list)
        else {
            return;
        };
        let Some(entry) = self.virtual_lists.get(&list_id) else {
            return;
        };
        if selection_scroll_step(entry.state.viewport_bounds(), position) == 0.0 {
            return;
        }
        self.selection_scroll_task = Some(cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(SELECTION_SCROLL_TICK_MS))
                .await;
            if let Err(error) = view.update(cx, |view, cx| {
                view.selection_scroll_task = None;
                view.step_selection_scroll(cx);
            }) {
                log::debug!("selection scroll stopped after view teardown: {error}");
            }
        }));
    }

    fn step_selection_scroll(&mut self, cx: &mut gpui::Context<Self>) {
        if !self.selection.lock().is_dragging() {
            self.stop_selection_scroll();
            return;
        }
        let (Some(position), Some(list_id)) =
            (self.selection_drag_position, self.selection_scroll_list)
        else {
            return;
        };
        let Some(entry) = self.virtual_lists.get(&list_id) else {
            self.stop_selection_scroll();
            return;
        };
        let step = selection_scroll_step(entry.state.viewport_bounds(), position);
        if step == 0.0 {
            return;
        }

        let before = entry.state.logical_scroll_top();
        let selection_moved =
            crate::text::paint::update_drag_at(&self.selection, position, self.window_id);
        entry.state.scroll_by(gpui::px(step));
        let after = entry.state.logical_scroll_top();
        let list_moved =
            after.item_ix != before.item_ix || after.offset_in_item != before.offset_in_item;
        if !selection_moved && !list_moved {
            self.stop_selection_scroll();
            return;
        }
        cx.notify();
        self.schedule_selection_scroll(cx);
    }

    /// Sync focus handles with the current element tree.
    /// Creates handles for new focusable elements, subscribes on_focus/on_blur,
    /// and cleans up handles for destroyed elements.
    fn sync_focus_handles(
        &mut self,
        tree: &RetainedTree,
        callback: &Option<EventCallback>,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        // Two full-tree passes per render — but every input they read
        // (events, styles, custom props, membership) is revision-tracked.
        // Skip when the tree hasn't moved; pending focus is view state,
        // not tree, so it still forces a pass.
        if tree.revision() == self.last_focus_sync_revision
            && self.pending_focus_element.is_none()
        {
            return;
        }
        self.last_focus_sync_revision = tree.revision();
        let tab_index = |element: &crate::retained_tree::RetainedElement| {
            element
                .custom_props
                .get("tabIndex")
                .and_then(|value| value.as_i64())
                .and_then(|index| isize::try_from(index).ok())
        };
        // A truthy `disabled`/`loading` custom prop makes an x-button inert:
        // HTML truthiness — anything but false/null/""/"false".
        let x_button_inert = |element: &crate::retained_tree::RetainedElement| {
            element.element_type == "x-button"
                && ["disabled", "loading"].iter().any(|key| {
                    element.custom_props.get(*key).is_some_and(|v| match v {
                        serde_json::Value::Null => false,
                        serde_json::Value::Bool(b) => *b,
                        serde_json::Value::String(s) => !s.is_empty() && s != "false",
                        serde_json::Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
                        _ => true,
                    })
                })
        };
        let needs_focus = |element: &crate::retained_tree::RetainedElement| {
            matches!(element.element_type.as_str(), "input" | "textarea" | "x-button")
                || tab_index(element).is_some()
                || element.events.contains("keyDown")
                || element.events.contains("keyUp")
                || element.events.contains("focus")
                || element.events.contains("blur")
                // `focus`/`focusWithin`/`focusVisible` buckets evaluate
                // against the tracked handle — without one the paint never
                // moves, and a plain `cx.focus_handle()` is not a tab stop,
                // so a styled element stays out of the tab cycle.
                || element
                    .style
                    .as_deref()
                    .is_some_and(StyleDesc::has_focus_bucket)
        };
        // Create handles for elements that need focus but don't have one yet.
        for (&id, element) in &tree.elements {
            let tab_index = if x_button_inert(element) {
                // svelai's `tabindex=-1` on a disabled anchor — the handle
                // exists (re-enabling restores the stop) but is untabbable.
                Some(-1)
            } else {
                tab_index(element).or_else(|| {
                    matches!(
                        element.element_type.as_str(),
                        "input" | "textarea" | "x-button"
                    )
                    .then_some(0)
                })
            };

            if needs_focus(element) && !self.focus_handles.contains_key(&id) {
                let handle = match tab_index {
                    Some(index) => cx.focus_handle().tab_index(index).tab_stop(index >= 0),
                    None => cx.focus_handle(),
                };
                // Focus once, at creation. Re-focusing every frame would
                // steal focus back from whatever the user clicked next.
                if element.auto_focus {
                    handle.focus(window, cx);
                }
                self.focus_handles.insert(id, handle);
            } else if let (Some(handle), Some(index)) =
                (self.focus_handles.get(&id).cloned(), tab_index)
            {
                self.focus_handles
                    .insert(id, handle.tab_index(index).tab_stop(index >= 0));
            } else if let Some(handle) = self.focus_handles.get(&id).cloned() {
                self.focus_handles.insert(id, handle.tab_stop(false));
            }
        }

        if let Some(id) = self.pending_focus_element.take() {
            if let Some(handle) = self.focus_handles.get(&id) {
                handle.focus(window, cx);
            }
        }

        self.focus_subscriptions.retain(|(id, event), _| {
            tree.elements
                .get(id)
                .is_some_and(|element| element.events.contains(event))
        });
        for (&id, element) in &tree.elements {
            let Some(handle) = self.focus_handles.get(&id).cloned() else {
                continue;
            };
            let focus_key = (id, "focus".to_string());
            if element.events.contains("focus")
                && !self.focus_subscriptions.contains_key(&focus_key)
            {
                let callback = callback.clone();
                let subscription = cx.on_focus(&handle, window, move |_this, _window, _cx| {
                    emit_event_full(&callback, id, "focus", |_| {});
                });
                self.focus_subscriptions.insert(focus_key, subscription);
            }
            let blur_key = (id, "blur".to_string());
            if element.events.contains("blur") && !self.focus_subscriptions.contains_key(&blur_key)
            {
                let callback = callback.clone();
                let subscription = cx.on_blur(&handle, window, move |_this, _window, _cx| {
                    emit_event_full(&callback, id, "blur", |_| {});
                });
                self.focus_subscriptions.insert(blur_key, subscription);
            }
        }

        // Clean up handles for elements that no longer exist.
        self.focus_handles
            .retain(|id, _| tree.elements.get(id).is_some_and(&needs_focus));
    }
}

impl gpui::Render for GpuixView {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::IntoElement;

        crate::automation::set_paint_window(self.window_id);
        // AppKit setTitle: is an ObjC msg-send per rendered frame — cache
        // the last-sent title so unchanged titles skip the call entirely.
        if self.window_title != self.last_sent_title {
            window.set_window_title(&self.window_title);
            self.last_sent_title = self.window_title.clone();
        }

        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        if let Some(id) = PENDING_FOCUS_ELEMENT.with(|pending| pending.borrow_mut().take()) {
            self.pending_focus_element = Some(id);
        }

        // Clone Arc so we don't borrow self.tree — frees self for focus_handles access.
        let tree_arc = self.tree.clone();
        let tree = tree_arc.lock().unwrap_or_else(|p| p.into_inner());
        let callback = self.event_callback.clone();

        // A render happened — this is the JS rAF tick. Emitted once per
        // painted frame (vsync-driven, pauses when the window stops drawing);
        // JS-side `requestAnimationFrame` wakes us via the `requestFrame` op.
        emit_event_full(&callback, WINDOW_EVENT_ID, "frame", |_| {});

        // Sync focus handles before building elements.
        self.sync_focus_handles(&tree, &callback, window, cx);

        // Ensure custom element instances are destroyed when their IDs disappear.
        self.custom_registry
            .prune_missing(|id| tree.elements.contains_key(&id));

        // Clean up scroll handles for destroyed elements (IDs removed from tree).
        // Scrollability-based cleanup (element still exists but style changed
        // from scroll to non-scroll) is handled inside build_host_container().
        self.scroll_handles
            .retain(|id, _| tree.elements.contains_key(id));
        self.virtual_lists
            .retain(|id, _| tree.elements.contains_key(id));
        self.motion_states
            .retain(|id, _| tree.elements.contains_key(id));
        self.memo_views
            .retain(|id, _| tree.elements.contains_key(id));

        // Build the element tree. custom_registry, focus_handles, and scroll_handles
        // are different fields of self, so Rust allows borrowing all simultaneously.
        let theme = Theme::dark();
        let now = self.clock.now();
        let mut motion_active = false;
        // Pruned by DECLARATION, not existence: an element that drops its
        // `highlight` prop keeps living, and its cached group list holds a copy
        // of every string in its subtree.
        self.highlights.retain(|id, _| {
            tree.elements
                .get(id)
                .is_some_and(|element| element.custom_props.contains_key("highlight"))
        });
        let mut highlight_events = Vec::new();
        // Each view renders its own window's root — `setRoot {windowId}`
        // binds the subtree, not the primary's.
        let result = match tree.root_id_in(self.window_id) {
            Some(root_id) => {
                let mut ctx = BuildCtx {
                    tree: &tree,
                    event_callback: &callback,
                    focus_handles: &self.focus_handles,
                    scroll_handles: &mut self.scroll_handles,
                    custom_registry: &mut self.custom_registry,
                    virtual_lists: &mut self.virtual_lists,
                    motion_states: &mut self.motion_states,
                    now,
                    motion_active: &mut motion_active,
                    selection: self.selection.clone(),
                    // The app-level `setTheme` declaration seeds the token
                    // cascade — same floor theme_for_element uses at resolve
                    // time, so custom elements paint what divs resolve to.
                    inherited: Inherited::root(&theme, root_tokens_for(&tree)),
                    highlights: &mut self.highlights,
                    highlight_events: &mut highlight_events,
                    memo_views: &mut self.memo_views,
                    root_weak: cx.weak_entity(),
                    tree_handle: tree_arc.clone(),
                    file_drag_target: &self.file_drag_target,
                    window_drag_arm: &self.window_drag_arm,
                    slot: SlotCtx::window(),
                    memo_boundary: None,
                    boundary_style: None,
                };
                build_element(root_id, &mut ctx, window, cx).0
            }
            None => gpui::Empty.into_any_element(),
        };
        // Flushed after the root build so a `setState` in the handler cannot
        // re-enter this build.
        emit_highlight_events(&callback, &highlight_events);

        // The frame reset must paint BEFORE any text, so it is the first child of
        // the root wrapper. Without it the selection registry accumulates stale
        // entries across frames and a drag resolves against elements that are no
        // longer on screen.
        let result = {
            use gpui::prelude::*;
            let drag_move_view = cx.weak_entity();
            let drag_end_view = drag_move_view.clone();
            let root = gpui::div().size_full();
            with_window_menu_actions(root)
                .when(
                    self.window_key_down
                        || self.window_key_up
                        || cfg!(all(target_arch = "wasm32", target_os = "unknown")),
                    |root| {
                        root.child(window_key_events(
                            callback.clone(),
                            self.window_key_down,
                            self.window_key_up,
                            self.window_key_event_id,
                        ))
                    },
                )
                .child(selection_frame_reset(
                    self.selection.clone(),
                    self.window_id,
                    move |position, app| {
                        drag_move_view
                            .update(app, |view, cx| view.on_selection_mouse_move(position, cx))
                            .ok();
                    },
                    move |app| {
                        drag_end_view
                            .update(app, |view, _cx| view.stop_selection_scroll())
                            .ok();
                    },
                ))
                .child(crate::automation::bounds_frame_reset(self.window_id))
                .child(file_drop_events(
                    callback.clone(),
                    self.file_drag_target.clone(),
                ))
                .child(result)
                .into_any_element()
        };

        // Sync scroll handles to thread_local so napi methods (scrollTo,
        // getScrollOffset) can access them without an App context. Entries are
        // window-tagged — the retain drops only this view's stale mirror rows;
        // another window's entries survive its neighbor's frame.
        SCROLL_HANDLES.with(|cell| {
            let mut handles = cell.borrow_mut();
            handles.retain(|_, (window, _)| *window != self.window_id);
            for (&id, handle) in &self.scroll_handles {
                handles.insert(id, (self.window_id, handle.clone()));
            }
        });
        VIRTUAL_LIST_STATES.with(|cell| {
            let mut states = cell.borrow_mut();
            states.retain(|_, (window, _)| *window != self.window_id);
            for (&id, entry) in &self.virtual_lists {
                states.insert(id, (self.window_id, entry.state.clone()));
            }
        });
        // gpui's scroll handler only fires on the wheel path, so anchors that
        // moved silently — queued scrollToItem applied during the build,
        // scrollbar offsets, gpui autoscroll — are reported from here, after
        // the mirror above already carries the new anchor for `listScrollTop`.
        let mut moved = Vec::new();
        // Marks are keyed by list id with no window tag — extract only this
        // view's lists, leaving another window's marks for its own sweep.
        let mut gpui_marked = GPUI_REPORTED_SCROLLS.with(|cell| {
            let mut marked = cell.borrow_mut();
            let mut mine = HashMap::new();
            for id in self.virtual_lists.keys() {
                if let Some(start) = marked.remove(id) {
                    mine.insert(*id, start);
                }
            }
            mine
        });
        REPORTED_VIRTUAL_LIST_TOPS.with(|cell| {
            let mut reported = cell.borrow_mut();
            // Dead rows of mine drop; other windows' rows are not mine to keep.
            reported.retain(|id, (window, _)| {
                *window != self.window_id || self.virtual_lists.contains_key(id)
            });
            for (&id, entry) in &self.virtual_lists {
                let key = virtual_list_reported_key(&entry.state);
                if let Some(gpui_start) = gpui_marked.remove(&id) {
                    // gpui's own scroll handler already emitted this move —
                    // record the anchor it produced, emit nothing. If the
                    // anchor moved again after that handler ran (a queued
                    // scrollToItem applied later in the same frame), gpui's
                    // payload is stale — fall through to a fresh report.
                    reported.insert(id, (self.window_id, key));
                    if gpui_start == entry.state.logical_scroll_top().item_ix {
                        continue;
                    }
                } else if reported.get(&id).map(|row| row.1) == Some(key) {
                    continue;
                }
                reported.insert(id, (self.window_id, key));
                if tree
                    .elements
                    .get(&id)
                    .is_some_and(|element| element.events.contains("visibleRange"))
                {
                    moved.push((id, entry.state.clone()));
                }
            }
        });
        for (id, state) in moved {
            emit_virtual_list_visible_range(&callback, id, &state);
        }
        // One-shot: a queued scroll for a list that did not build this frame
        // would otherwise fire on some later frame, against child indices that
        // no longer match what JS meant. Only this window's queue drains —
        // another window's pending scrolls wait for its own frame.
        PENDING_VIRTUAL_LIST_SCROLLS.with(|cell| {
            cell.borrow_mut()
                .retain(|_, (window, _)| *window != self.window_id)
        });

        if motion_active {
            window.request_animation_frame();
        }

        result
    }
}

// ── Subtree memoization ──────────────────────────────────────────────
//
// GPUI caches an entity-backed view's layout, prepaint and paint ranges and
// replays them while the entity stays clean (`.cached(style)` in view.rs).
// Retained elements are not entities, so each memoizable subtree gets a
// `GpuixSubtree` entity whose only job is to re-run `build_element` for that
// element id. The cache key is the subtree's mutation revision plus the
// context it was emitted under; on any mismatch the entry's entity is
// replaced outright — a fresh entity has no recorded state, so the next
// prepaint renders instead of replaying stale pixels.
//
// The paint replay skips the elements' paint closures, so a zero-size marker
// sibling painted right after the cached view re-registers the subtree's
// bounds, selection regions and match ordinals from last frame's snapshots.

/// Smallest subtree worth an entity + cached view + marker of its own.
const MIN_MEMO_LEN: u32 = 4;

/// What the parent container guarantees about a child's box, threaded down
/// the build so a candidate knows whether its own size is definite.
#[derive(Clone, Copy, PartialEq)]
struct SlotCtx {
    /// Parent offers a definite inline size (window, `px`, or a definite `%`).
    w_def: bool,
    /// Parent offers a definite block size.
    h_def: bool,
    /// The parent's layout container — decides which auto behaviours are
    /// content-driven (grid) versus fill-driven (block, stretch, grow).
    container: SlotKind,
    /// `align-items` stretch or unset — a definite cross axis reaches the
    /// child only when the parent actually stretches it.
    cross_stretch: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum SlotKind {
    Block,
    RowFlex,
    ColFlex,
    Grid,
}

impl SlotCtx {
    /// The root element's slot: the window always offers a definite box.
    fn window() -> Self {
        Self {
            w_def: true,
            h_def: true,
            container: SlotKind::Block,
            cross_stretch: true,
        }
    }

    /// A virtual-list row: `w_full` wrapper, content-driven height.
    fn virtual_row() -> Self {
        Self {
            w_def: true,
            h_def: false,
            container: SlotKind::Block,
            cross_stretch: true,
        }
    }
}

fn is_absolute(style: &StyleDesc) -> bool {
    matches!(style.position.as_deref(), Some("absolute") | Some("fixed"))
}

fn align_self_overrides_stretch(style: &StyleDesc) -> bool {
    matches!(
        style.align_self.as_deref(),
        Some("start" | "end" | "center" | "flex-start" | "flex-end" | "baseline")
    )
}

/// Whether this element's inline size is known without measuring content.
fn w_definite(slot: SlotCtx, style: &StyleDesc) -> bool {
    match style.width {
        Some(crate::style::DimensionValue::Pixels(_)) => return true,
        // An absolutely positioned element's containing block is not its
        // parent, so a percentage there resolves against an unknown box.
        Some(crate::style::DimensionValue::Percentage(_)) => {
            return !is_absolute(style) && slot.w_def;
        }
        _ => {}
    }
    if style.aspect_ratio.is_some() && h_definite(slot, style) {
        return true;
    }
    if is_absolute(style) {
        return false;
    }
    match slot.container {
        SlotKind::Block => slot.w_def,
        SlotKind::RowFlex => style.flex_grow.unwrap_or(0.0) > 0.0 && slot.w_def,
        SlotKind::ColFlex => {
            slot.cross_stretch && !align_self_overrides_stretch(style) && slot.w_def
        }
        SlotKind::Grid => false,
    }
}

/// Whether this element's block size is known without measuring content.
fn h_definite(slot: SlotCtx, style: &StyleDesc) -> bool {
    match style.height {
        Some(crate::style::DimensionValue::Pixels(_)) => return true,
        Some(crate::style::DimensionValue::Percentage(_)) => {
            return !is_absolute(style) && slot.h_def;
        }
        _ => {}
    }
    if style.aspect_ratio.is_some() && w_definite(slot, style) {
        return true;
    }
    if is_absolute(style) {
        return false;
    }
    match slot.container {
        SlotKind::Block => false,
        SlotKind::ColFlex => style.flex_grow.unwrap_or(0.0) > 0.0 && slot.h_def,
        SlotKind::RowFlex => {
            slot.cross_stretch && !align_self_overrides_stretch(style) && slot.h_def
        }
        SlotKind::Grid => false,
    }
}

/// The slot an element offers its children: the container kind comes from its
/// display, and the offered sizes from its own definiteness.
fn child_slot(slot: SlotCtx, style: Option<&StyleDesc>) -> SlotCtx {
    let Some(style) = style else {
        return SlotCtx {
            w_def: false,
            h_def: false,
            container: SlotKind::Block,
            cross_stretch: true,
        };
    };
    let container = match style.display.as_deref() {
        Some("flex") => match style.flex_direction.as_deref() {
            Some("column" | "column-reverse") => SlotKind::ColFlex,
            _ => SlotKind::RowFlex,
        },
        Some("grid") => SlotKind::Grid,
        _ => SlotKind::Block,
    };
    SlotCtx {
        w_def: w_definite(slot, style),
        h_def: h_definite(slot, style),
        container,
        cross_stretch: matches!(
            style.align_items.as_deref(),
            None | Some("stretch" | "normal")
        ),
    }
}

/// The inherited context a memoized subtree was emitted under. `Arc`s compare
/// by pointer: `TokenTheme::themed` memoizes, so an unchanged theme keeps the
/// same allocation.
#[derive(Clone, PartialEq)]
struct InheritedKey {
    selectable: bool,
    wash: [u32; 4],
    highlight: Option<usize>,
    tokens: usize,
    color: Option<String>,
}

impl InheritedKey {
    fn of(inherited: &Inherited) -> Self {
        Self {
            selectable: inherited.selectable,
            wash: [
                inherited.selection_wash.h.to_bits(),
                inherited.selection_wash.s.to_bits(),
                inherited.selection_wash.l.to_bits(),
                inherited.selection_wash.a.to_bits(),
            ],
            highlight: inherited
                .highlight
                .as_ref()
                .map(|context| Arc::as_ptr(context) as usize),
            tokens: Arc::as_ptr(&inherited.tokens) as usize,
            color: inherited.color.clone(),
        }
    }
}

/// What a cached view's recorded state must still describe to be emittable.
#[derive(Clone, PartialEq)]
struct MemoKey {
    /// `subtree_revision` covers every mutation in the subtree: content,
    /// children, styles, props, listeners.
    revision: u64,
    /// Bumped when one of the parent's children moved, appeared, or vanished
    /// at paint — the observable signal that the box this subtree is offered
    /// changed shape. `parent_revision` would be wrong here: it bumps on every
    /// descendant mutation, including text that changed nothing's size.
    layout_epoch: u64,
    /// The parent's last painted box. Anything above the parent that relayouts
    /// it (window resize, grandparent style) shows up here.
    parent_bounds: Option<(f32, f32)>,
    slot: SlotCtx,
    inherited: InheritedKey,
}

impl MemoKey {
    /// Whether `other` differs only in fields that cannot change the pinned
    /// leaf box — an inherited-context change keeps the measured size valid.
    fn same_box(&self, other: &MemoKey) -> bool {
        self.revision == other.revision
            && self.layout_epoch == other.layout_epoch
            && self.parent_bounds == other.parent_bounds
            && self.slot == other.slot
    }
}

/// A subtree that may stand as a cached leaf this frame, plus the size the
/// leaf's non-definite axes are pinned to.
struct MemoCandidate {
    key: MemoKey,
    /// Measured border-box width/height for a content-sized axis. The leaf
    /// never measures content, so the pin is what its layout would have been.
    pin_w: Option<f32>,
    pin_h: Option<f32>,
}

/// One memoized subtree: the entity whose cached view stands in for it, the
/// key its recorded state was produced under, and the parent context its own
/// render must be seeded with.
struct MemoEntry {
    entity: gpui::Entity<GpuixSubtree>,
    key: MemoKey,
    inherited: Inherited,
}

/// Entity standing in for one retained subtree. Its render re-enters the root
/// view so the same builders, registries and locks apply.
struct GpuixSubtree {
    element_id: u64,
    root: gpui::WeakEntity<GpuixView>,
}

impl gpui::Render for GpuixSubtree {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::IntoElement as _;
        let id = self.element_id;
        let root = self.root.clone();
        root.update(cx, |root, cx| root.build_memo_subtree(id, window, cx))
            .unwrap_or_else(|_| gpui::Empty.into_any_element())
    }
}

/// The element's painted padding box plus its borders — what the leaf's
/// border box must be pinned to on a content-sized axis. `bounds_tracker`'s
/// canvas is `absolute().size_full()`, so it records the padding box; adding
/// padding again would grow the pin every round trip.
fn border_box_axis(recorded: f32, border: Option<f64>, a: Option<f64>, b: Option<f64>) -> f32 {
    let side = |edge: Option<f64>| edge.or(border).unwrap_or(0.0) as f32;
    recorded + side(a) + side(b)
}

/// `Some(candidate)` when the element may stand as a cached leaf: host
/// element, clean subtree (no custom elements, motion, virtual lists, or
/// pointer-capturing nodes), and big enough to pay for itself. GPUI never
/// measures a cached subtree by content, so a content-sized axis needs a pin
/// — the element's own border box as last painted, kept honest by a live
/// re-measure frame whenever the key's box-relevant fields move.
fn memo_key(
    element: &crate::retained_tree::RetainedElement,
    style: &StyleDesc,
    ctx: &BuildCtx,
) -> Option<MemoCandidate> {
    // Inside a subtree render, `window.refreshing` makes every nested cached
    // view miss anyway — emitting them would only buy entities and markers.
    if ctx.memo_boundary.is_some() {
        return None;
    }
    match element.element_type.as_str() {
        "div" | "text" => {}
        _ => return None,
    }
    let scan = ctx.tree.memo_scan(element.id);
    if scan.flags != 0 || scan.len < MIN_MEMO_LEN {
        return None;
    }
    // An absolutely positioned element's containing block is not its parent,
    // so the parent's bounds fingerprint cannot describe its offered box.
    // Hidden elements never paint, so nothing trustworthy to pin exists.
    if is_absolute(style) || style.visibility.as_deref() == Some("hidden") {
        return None;
    }
    let w_def = w_definite(ctx.slot, style);
    let h_def = h_definite(ctx.slot, style);
    let natural = if w_def && h_def {
        None
    } else {
        // bounds_tracker records the padding box; the leaf needs the border
        // box, so the element's own borders go back on. Read the live map,
        // not the previous-frame snapshot: at emit time it already holds
        // last frame's painted boxes, so a resize is seen one frame sooner.
        Some(crate::automation::get_bounds(element.id)?)
    };
    let pin_w = (!w_def).then(|| {
        border_box_axis(
            natural.unwrap().width as f32,
            style.border_width,
            style.border_left_width,
            style.border_right_width,
        )
    });
    let pin_h = (!h_def).then(|| {
        border_box_axis(
            natural.unwrap().height as f32,
            style.border_width,
            style.border_top_width,
            style.border_bottom_width,
        )
    });
    let parent = element.parent.and_then(|id| ctx.tree.elements.get(&id));
    // The parent's churn only matters when a pin exists to protect: a leaf
    // with both axes definite lays out the same box regardless of siblings.
    let (layout_epoch, parent_bounds) = if natural.is_some() {
        (
            element
                .parent
                .map(crate::automation::layout_epoch)
                .unwrap_or(0),
            parent
                .and_then(|p| crate::automation::get_bounds(p.id))
                .map(|b| (b.width as f32, b.height as f32)),
        )
    } else {
        (0, None)
    };
    Some(MemoCandidate {
        key: MemoKey {
            revision: element.subtree_revision,
            layout_epoch,
            parent_bounds,
            slot: ctx.slot,
            inherited: InheritedKey::of(&ctx.inherited),
        },
        pin_w,
        pin_h,
    })
}

/// Invisible sibling painted right after a cached subtree view. When the view
/// replayed its recorded paint, the subtree's elements never ran their paint
/// closures; this re-registers their bounds, selection regions, painted text
/// and match ordinals from the previous frame's snapshots. When the view
/// rendered fresh, the root's own `bounds_tracker` already recorded it and
/// this is a no-op.
fn memo_marker(id: u64, tree: Arc<Mutex<RetainedTree>>) -> gpui::AnyElement {
    use gpui::{canvas, px, IntoElement as _, Styled as _};
    canvas(
        |_, _, _| (),
        move |_, _, _, _| {
            if crate::automation::get_bounds(id).is_some() {
                return;
            }
            let Ok(tree) = tree.try_lock() else {
                return;
            };
            // `visibility: hidden` skips the subtree's paint callbacks, so no
            // member recorded bounds — replaying last frame's would register
            // phantom boxes for elements that are no longer painted.
            if tree
                .elements
                .get(&id)
                .and_then(|element| element.style.as_deref())
                .is_some_and(|style| style.visibility.as_deref() == Some("hidden"))
            {
                return;
            }
            let mut members: Vec<(u64, Option<u64>, Option<bool>)> = Vec::new();
            let mut stack = vec![id];
            while let Some(current) = stack.pop() {
                let Some(element) = tree.elements.get(&current) else {
                    continue;
                };
                members.push((
                    current,
                    element.parent,
                    selection_start_flag(element.style.as_deref()),
                ));
                // Reverse-push so the pop order is document order.
                stack.extend(element.children.iter().rev().copied());
            }
            drop(tree);
            crate::automation::replay_bounds(
                &members
                    .iter()
                    .map(|(id, parent, _)| (*id, *parent))
                    .collect::<Vec<_>>(),
            );
            crate::text::replay_frame_registries(
                &members
                    .iter()
                    .map(|(id, _, flag)| (*id, *flag))
                    .collect::<Vec<_>>(),
            );
        },
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
    .into_any_element()
}

// ── Element builders ─────────────────────────────────────────────────

/// Build the GPUI element for one retained element. Returns the element plus
/// an optional marker the caller must attach as the next sibling — memoized
/// subtrees use it to restore the frame bookkeeping their replayed paint
/// skipped.
pub(crate) fn build_element(
    id: u64,
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
) -> (gpui::AnyElement, Option<gpui::AnyElement>) {
    use gpui::IntoElement;

    let Some(element) = ctx.tree.elements.get(&id) else {
        return (gpui::Empty.into_any_element(), None);
    };

    let animated_style = if let Some(source) = element.custom_props.get("motion") {
        let state = match ctx.motion_states.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                match crate::motion::MotionState::new(source, ctx.now) {
                    Ok(state) => entry.insert(state),
                    Err(error) => {
                        log::warn!("Invalid motion description for element {id}: {error}");
                        entry.insert(crate::motion::MotionState::invalid(source, ctx.now))
                    }
                }
            }
        };
        if let Err(error) = state.sync(source, ctx.now) {
            log::warn!("Invalid motion update for element {id}: {error}");
        }
        state.is_valid().then(|| {
            let frame = state.frame(ctx.now);
            *ctx.motion_active |= frame.active;
            // `Arc<StyleDesc>` is shared, so the animated frame is applied to a
            // copy. Mutating through the pointer would restyle every element
            // that declared the same style.
            let mut resolved = element.style.as_deref().cloned().unwrap_or_default();
            frame.style.apply_to(&mut resolved);
            resolved
        })
    } else {
        ctx.motion_states.remove(&id);
        None
    };
    let boundary_style = if ctx.memo_boundary == Some(id) {
        ctx.boundary_style.clone()
    } else {
        None
    };
    let style = boundary_style
        .as_deref()
        .or(animated_style.as_ref())
        .or(element.style.as_deref());

    // Unchanged, self-contained subtree: hand GPUI a cached entity view
    // instead of rebuilding. A stale key swaps in a fresh entity — its absent
    // element state makes the next prepaint render rather than replay.
    let memo = if element.parent.is_some() {
        style.and_then(|style| memo_key(element, style, ctx).map(|cand| (style, cand)))
    } else {
        None
    };
    if let Some((style, cand)) = memo {
        let inherited = ctx.inherited.clone();
        let entry = ctx.memo_views.entry(id);
        let emit = match entry {
            std::collections::hash_map::Entry::Occupied(entry) if entry.get().key == cand.key => {
                Some(entry.get().entity.clone())
            }
            entry => {
                let entity = cx.new(|_| GpuixSubtree {
                    element_id: id,
                    root: ctx.root_weak.clone(),
                });
                let same_box = match &entry {
                    std::collections::hash_map::Entry::Occupied(entry) => {
                        entry.get().key.same_box(&cand.key)
                    }
                    _ => true,
                };
                let entry = match entry {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => entry.insert(MemoEntry {
                        entity: entity.clone(),
                        key: cand.key.clone(),
                        inherited: inherited.clone(),
                    }),
                };
                entry.entity = entity.clone();
                entry.key = cand.key;
                entry.inherited = inherited;
                // When the offered box or the subtree moved, the pin is stale:
                // emit live for one frame so bounds_tracker re-measures the
                // natural size. An inherited-only change keeps the pin, so the
                // fresh entity can go straight on stage.
                same_box.then_some(entity)
            }
        };
        if let Some(entity) = emit {
            use gpui::Styled as _;
            let mut leaf = apply_styles(gpui::StyleRefinement::default(), style);
            if let Some(w) = cand.pin_w {
                leaf = leaf.w(gpui::px(w));
            }
            if let Some(h) = cand.pin_h {
                leaf = leaf.h(gpui::px(h));
            }
            return (
                entity.cached(leaf).into_any_element(),
                Some(memo_marker(id, ctx.tree_handle.clone())),
            );
        }
    }

    // Inheritable style resolves once here so both built-ins and custom
    // elements see the same cascade.
    let parent_inherited = ctx.inherited.clone();
    ctx.inherited = parent_inherited.clone().descend(style);
    let parent_slot = ctx.slot;
    ctx.slot = child_slot(parent_slot, style);

    // A `highlight` here replaces any ancestor's: the nearest declaration wins,
    // and `GroupList::collect` skips nested declarations so an ancestor never
    // resolves or counts matches that will not paint.
    if let Some(value) = element.custom_props.get("highlight") {
        let has_listener = element.events.contains("highlight");
        let resolved = resolve_highlight(
            ctx.highlights,
            ctx.tree,
            id,
            value,
            &Theme::dark(),
            has_listener,
        );
        if let Some((_, Some(total))) = &resolved {
            ctx.highlight_events.push((id, *total));
        }
        ctx.inherited.highlight = resolved.map(|(context, _)| context);
    }

    // A `theme` prop overrides design tokens for this element and its subtree.
    // Same cascade slot as `highlight`: nearest declaration wins. Legacy
    // `theme` objects on `x-input`/`x-code` don't speak the vocabulary and
    // pass through untouched.
    if let Some(declaration) = element
        .custom_props
        .get("theme")
        .filter(|v| crate::tokens::TokenTheme::is_theme_declaration(v))
    {
        ctx.inherited.tokens = ctx.inherited.tokens.themed(declaration);
    }

    // A `color` prop is the `data-color` ctx — it cascades so an ancestor can
    // restyle a whole subtree; an element's own value wins for itself. An
    // empty string is falsy in svelai — it does not poison the cascade.
    if let Some(value) = element
        .custom_props
        .get("color")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
    {
        ctx.inherited.color = Some(value.to_string());
    }

    let built = match element.element_type.as_str() {
        // `<text>` is a `<div>` that happens to carry a string. Giving it its
        // own builder meant every interaction prop on the shared `Props` type
        // (onClick, hover, focus, tabIndex) type-checked, registered a JS
        // listener, and then silently did nothing.
        "div" | "text" => {
            ctx.custom_registry.destroy(id);
            build_host_container(element, style, ctx, window, cx)
        }
        "virtual-list" => {
            ctx.custom_registry.destroy(id);
            build_virtual_list(element, ctx, window, cx)
        }

        // Polymorphic dispatch for all custom elements.
        custom_type => {
            let mut custom_children: Vec<gpui::AnyElement> = Vec::new();
            for child_id in element.children.iter().copied() {
                if !ctx.tree.elements.contains_key(&child_id) {
                    continue;
                }
                let (child, marker) = build_element(child_id, ctx, window, cx);
                custom_children.push(child);
                if let Some(marker) = marker {
                    custom_children.push(marker);
                }
            }
            let inherited = ctx.inherited.clone();
            let render_ctx = CustomRenderContext {
                id,
                events: &element.events,
                delegated: &ctx.tree.delegated_events,
                event_callback: ctx.event_callback,
                focus_handle: ctx.focus_handles.get(&id),
                style,
                children: custom_children,
                selection: ctx.selection.clone(),
                selectable: inherited.selectable,
                selection_wash: inherited.selection_wash,
                highlight_set: inherited.highlight.clone(),
                props: &element.custom_props,
                ctx_color: inherited.color.as_deref(),
                tokens: &inherited.tokens,
            };
            ctx.custom_registry
                .render(custom_type, &element.custom_props, render_ctx, window, cx)
        }
    };

    ctx.inherited = parent_inherited;
    ctx.slot = parent_slot;
    // CSS transform is element-level: it wraps the finished subtree so every
    // primitive, hitbox and clip inside follows the same matrix — layout is
    // untouched. Unparseable declarations drop to identity, like CSS.
    let built = match style.and_then(|style| {
        crate::transform::Transform::parse(
            style.transform.as_deref()?,
            style.transform_origin.as_deref(),
        )
    }) {
        Some(transform) => crate::transform::Transformed::new(built, transform).into_any_element(),
        None => built,
    };
    (built, None)
}

fn build_virtual_list(
    element: &crate::retained_tree::RetainedElement,
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
) -> gpui::AnyElement {
    use gpui::prelude::*;

    let child_ids: Vec<u64> = element
        .children
        .iter()
        .copied()
        .filter(|child_id| ctx.tree.elements.contains_key(child_id))
        .collect();
    let child_revisions: Vec<u64> = child_ids
        .iter()
        .filter_map(|child_id| {
            ctx.tree
                .elements
                .get(child_id)
                .map(|child| child.subtree_revision)
        })
        .collect();
    let focusable_rows: HashSet<u64> = ctx
        .focus_handles
        .keys()
        .filter_map(|element_id| virtual_row_ancestor(ctx.tree, element.id, *element_id))
        .collect();
    let focused_row = ctx
        .focus_handles
        .iter()
        .find_map(|(element_id, handle)| {
            handle
                .is_focused(window)
                .then(|| virtual_row_ancestor(ctx.tree, element.id, *element_id))
                .flatten()
        })
        .or_else(|| {
            ctx.focus_handles.keys().find_map(|element_id| {
                ctx.tree
                    .elements
                    .get(element_id)
                    .is_some_and(|element| element.auto_focus)
                    .then(|| virtual_row_ancestor(ctx.tree, element.id, *element_id))
                    .flatten()
            })
        });
    let config = VirtualListConfig::from_element(element);
    let window_start = if config.item_count.is_some() {
        window_start_from_element(element)
    } else {
        0
    };
    let list_state = match ctx.virtual_lists.entry(element.id) {
        std::collections::hash_map::Entry::Occupied(mut entry) => {
            entry.get_mut().sync(
                config,
                window_start,
                child_ids.clone(),
                child_revisions,
                &focusable_rows,
                cx,
            );
            let entry = entry.into_mut();
            if let Some(row_id) = focused_row.filter(|row_id| !entry.seen_rows.contains(row_id)) {
                if let Some(index) = entry.logical_index_of(row_id) {
                    entry.state.scroll_to(gpui::ListOffset {
                        item_ix: index,
                        offset_in_item: gpui::px(0.0),
                    });
                }
            }
            entry.state.clone()
        }
        std::collections::hash_map::Entry::Vacant(entry) => {
            let row_focus_handles = child_ids
                .iter()
                .map(|id| focusable_rows.contains(id).then(|| cx.focus_handle()))
                .collect();
            let entry = entry.insert(VirtualListEntry::new(
                config,
                window_start,
                child_ids.clone(),
                child_revisions,
                row_focus_handles,
            ));
            if let Some(row_id) = focused_row {
                if let Some(index) = entry.logical_index_of(row_id) {
                    entry.state.scroll_to(gpui::ListOffset {
                        item_ix: index,
                        offset_in_item: gpui::px(0.0),
                    });
                }
            }
            entry.state.clone()
        }
    };

    // Queued scrolls apply here, after `sync` spliced this frame's child
    // changes, so the indices JS computed against its committed child list are
    // the indices the splice-adjusted ListState sees.
    if let Some((_, offset)) =
        PENDING_VIRTUAL_LIST_SCROLLS.with(|cell| cell.borrow_mut().remove(&element.id))
    {
        list_state.scroll_to(offset);
    }

    if element.events.contains("visibleRange") {
        let callback = ctx.event_callback.clone();
        let list_id = element.id;
        list_state.set_scroll_handler(move |event, _window, _cx| {
            // gpui invokes this handler while it holds `borrow_mut` on the
            // ListState — touching `logical_scroll_top`/`item_is_below_viewport`
            // here panics ("RefCell already mutably borrowed"). Queue the
            // emitted anchor instead: the mirror sweep consumes it by
            // recording the current anchor as reported, so a wheel move gpui
            // already emitted is not double-reported — and a second move in
            // the same frame is not swallowed.
            GPUI_REPORTED_SCROLLS.with(|cell| {
                cell.borrow_mut().insert(list_id, event.visible_range.start);
            });
            emit_event_full(&callback, list_id, "visibleRange", |payload| {
                payload.start_index = Some(event.visible_range.start as f64);
                payload.end_index = Some(event.visible_range.end as f64);
            });
        });
    }

    let list_id = element.id;
    // Cloned, not copied: gpui runs this processor once per requested row, so
    // the captured value must survive every call.
    let inherited = ctx.inherited.clone();
    let render_item = cx.processor(move |view, index: usize, window, cx| {
        let Some(entry) = view.virtual_lists.get(&list_id) else {
            return unmounted_virtual_row(1.0);
        };
        let Some(child_id) = entry.child_at(index) else {
            // Empty measures as 0 and poisons ListState. Keep the estimate.
            return unmounted_virtual_row(entry.config.estimated_item_height.unwrap_or(1.0));
        };
        view.build_virtual_child(list_id, index, child_id, inherited.clone(), window, cx)
    });
    let mut list = gpui::list(list_state, render_item)
        .with_sizing_behavior(gpui::ListSizingBehavior::Auto)
        .id(gpui::ElementId::Name(gpui::SharedString::from(format!(
            "__gpuix_virtual_list_{}",
            element.id
        ))));
    if let Some(style) = element.style.as_deref() {
        list = apply_styles(list, style);
    }
    apply_accessibility(list, &element.custom_props, None).into_any_element()
}

/// The REPORTED_VIRTUAL_LIST_TOPS key for a list's current anchor:
/// `(item_ix, offset_in_item bits, viewport height bits)`. All three feed the
/// JS-side window through `listScrollTop`, so a change to any of them is a
/// changed visible range.
fn virtual_list_reported_key(state: &gpui::ListState) -> (usize, u32, u32) {
    let top = state.logical_scroll_top();
    (
        top.item_ix,
        f32::from(top.offset_in_item).to_bits(),
        f32::from(state.viewport_bounds().size.height).to_bits(),
    )
}

/// Report the visible window after a programmatic scroll applied. gpui runs
/// `set_scroll_handler` only on the wheel path; queued `scrollToItem`s,
/// scrollbar offsets and autoscroll get their `visibleRange` from here.
fn emit_virtual_list_visible_range(
    callback: &Option<EventCallback>,
    list_id: u64,
    state: &gpui::ListState,
) {
    let top = state.logical_scroll_top();
    // Walk measured rows to the first one entirely below the viewport. An
    // unmeasured row ends the walk early so the range stays honest instead of
    // guessing at heights. gpui's own wheel-path range ends at `count + 1` —
    // one past this index — so the payload does too, keeping the end bound
    // consistent no matter which path emitted it.
    let mut end = top.item_ix;
    while state.item_is_below_viewport(end) == Some(false) {
        end += 1;
    }
    emit_event_full(callback, list_id, "visibleRange", |payload| {
        payload.start_index = Some(top.item_ix as f64);
        payload.end_index = Some((end + 1) as f64);
    });
}

fn unmounted_virtual_row(height: f32) -> gpui::AnyElement {
    use gpui::prelude::*;
    gpui::div().h(gpui::px(height.max(1.0))).w_full().into_any()
}

fn virtual_row_ancestor(tree: &RetainedTree, list_id: u64, element_id: u64) -> Option<u64> {
    let mut current = element_id;
    loop {
        let parent = tree.elements.get(&current)?.parent?;
        if parent == list_id {
            return Some(current);
        }
        current = parent;
    }
}

/// Presence semantics for custom props: any stored value except null/false
/// counts — `data-*` attrs arrive as strings and are "present" even empty.
fn custom_prop_present(props: &HashMap<String, serde_json::Value>, key: &str) -> bool {
    props
        .get(key)
        .is_some_and(|v| !matches!(v, serde_json::Value::Null | serde_json::Value::Bool(false)))
}

fn joined_text_content(
    tree: &RetainedTree,
    element: &crate::retained_tree::RetainedElement,
) -> Option<String> {
    if let Some(content) = element.content.as_deref().filter(|value| !value.is_empty()) {
        return Some(content.to_string());
    }
    let mut parts = Vec::new();
    for child_id in &element.children {
        let Some(child) = tree.elements.get(child_id) else {
            continue;
        };
        if child.element_type == "text" {
            if let Some(content) = child.content.as_deref() {
                parts.push(content);
            }
        }
    }
    let joined = parts.concat();
    (!joined.is_empty()).then_some(joined)
}

/// The one builder for `<div>` and `<text>`.
///
/// Both get the same stable GPUI id, so gpui keeps their interactive element
/// state (hover, active, pointer capture, scroll, accessibility node) across
/// frames, and both wire the whole shared `Props` surface.
pub(crate) fn build_host_container(
    element: &crate::retained_tree::RetainedElement,
    style: Option<&StyleDesc>,
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
) -> gpui::AnyElement {
    use gpui::prelude::*;

    // `ElementId::Integer` rather than a formatted name: host ids are already
    // unique per renderer, and every `<div>` and `<text>` builds one of these on
    // every frame, so the string allocation was pure overhead. Custom elements
    // use `ElementId::Name`, which is a different variant and cannot collide.
    let mut el = gpui::div().id(gpui::ElementId::Integer(element.id));

    if let Some(style) = style {
        el = apply_interactive_styles(el, style);

        // svelai's `data-highlighted` is virtual focus — the state-layer/hover
        // fill paints eagerly while keyboard navigation owns the attribute.
        let highlighted = custom_prop_present(&element.custom_props, "data-highlighted");
        if highlighted {
            if let Some(hover_style) = style.hover.as_deref() {
                el = apply_styles(el, hover_style);
            }
        }

        if crate::style::should_occlude(style) {
            // BlockMouse (occlude) stops the hit test, so the parent scroller
            // never sees the wheel. HTML does not work that way: a wheel over
            // an absolutely positioned card still scrolls the ancestor. Only
            // `pointerEvents: "auto"` opts into stealing it. Everything else
            // uses BlockMouseExceptScroll.
            //
            // Absolute used to steal it too. That made a pannable canvas
            // impossible: every absolutely placed item (a timeline clip, a
            // graph node) ended the hit test before the pan listener ran.
            // `<anchored>` still occludes through its own `occlude` prop, so
            // menus and tooltips are unaffected.
            el = if style.pointer_events.as_deref() == Some("auto") {
                el.occlude()
            } else {
                el.block_mouse_except_scroll()
            };
        }
    }

    // ── Overflow: scroll ─────────────────────────────────────────────
    // overflow_scroll() requires StatefulInteractiveElement (only on Stateful<Div>),
    // so we handle it here rather than in apply_styles (which takes E: Styled).
    //
    // CSS precedence: axis-specific props (overflowX/Y) override the shorthand
    // (overflow). E.g. { overflow: "scroll", overflowY: "hidden" } → scroll X only.
    //
    // overflow-x only works as a flex viewport. Default display is Block, so a
    // wide child fills the parent instead of overflowing. Zed's code-block path:
    // flex + min_w_0 on the scroller, flex_none on the child.
    let mut overflow_x_only = false;
    if let Some(style) = style {
        // Resolve each axis: axis-specific overrides shorthand.
        let resolved_x = style.overflow_x.as_deref().or(style.overflow.as_deref());
        let resolved_y = style.overflow_y.as_deref().or(style.overflow.as_deref());

        let needs_scroll_x = resolved_x == Some("scroll");
        let needs_scroll_y = resolved_y == Some("scroll");

        if needs_scroll_x && needs_scroll_y {
            el = el.overflow_scroll();
            // GPUI zeroes the smaller of the two deltas by default, so one
            // diagonal wheel moves one axis. A browser moves both, and a
            // two-axis container is exactly where a user expects that.
            el.style().allow_concurrent_scroll = Some(true);
        } else if needs_scroll_x {
            overflow_x_only = true;
            el = el
                .flex()
                .min_w_0()
                .overflow_x_scroll()
                .restrict_scroll_to_axis();
        } else if needs_scroll_y {
            el = el.overflow_y_scroll();
        }

        // Attach a persistent ScrollHandle when scrolling is enabled.
        // The handle persists across renders (stored in GpuixView::scroll_handles)
        // so GPUI maintains the scroll offset between frames.
        if needs_scroll_x || needs_scroll_y {
            let handle = ctx
                .scroll_handles
                .entry(element.id)
                .or_insert_with(gpui::ScrollHandle::new);
            el = el.track_scroll(handle);
        } else {
            // Element is no longer scrollable — remove stale handle.
            ctx.scroll_handles.remove(&element.id);
        }
    } else {
        // No style at all — remove stale handle if it existed.
        ctx.scroll_handles.remove(&element.id);
    }

    // If a FocusHandle was pre-created for this element (by sync_focus_handles),
    // attach it via track_focus. This makes the element focusable — clicking it
    // or tabbing to it gives it keyboard focus. The handle persists across renders
    // because it's stored in GpuixView::focus_handles.
    if style.and_then(|style| style.position.as_deref()).is_none() {
        el = el.relative();
    }
    el = el.child(crate::automation::bounds_tracker(
        element.id,
        element.parent,
        selection_start_flag(style),
    ));

    // ── Click targets consume the press inside drag regions ────────
    // Electron's `app-region: no-drag`, derived from interactivity: a
    // control inside a `windowDrag` region must not arm the window
    // drag or trigger the titlebar double-click. gdom marks real
    // activation targets with `pressTarget` — element.events can't be
    // used (delegated types are backfilled onto every element).
    //
    // Two constraints keep the guard from eating unrelated presses:
    // - It stops propagation only when a live ancestor walk finds a
    //   `windowDrag` region. Window-level Bubble listeners that must
    //   see every press (text selection, pointer capture) still run
    //   everywhere else, and a `data-window-drag` added after the
    //   child materialized still counts. The walk attaches first so
    //   it fires after the element's own listeners, before ancestors'.
    // - Focusable elements are excluded: their track_focus listener is
    //   registered before mouse_down_listeners, so it fires AFTER this
    //   guard in the reverse walk — stopping propagation here would
    //   suppress click-to-focus. They don't need it: track_focus calls
    //   prevent_default(), which the drag handler checks below.
    let is_window_drag = custom_prop_present(&element.custom_props, "windowDrag");
    if !is_window_drag
        && custom_prop_present(&element.custom_props, "pressTarget")
        && !ctx.focus_handles.contains_key(&element.id)
    {
        let tree = ctx.tree_handle.clone();
        let element_id = element.id;
        el = el.on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
            let in_drag_region = tree.try_lock().is_ok_and(|tree| {
                let mut ancestor = tree
                    .elements
                    .get(&element_id)
                    .and_then(|element| element.parent);
                while let Some(id) = ancestor {
                    let Some(element) = tree.elements.get(&id) else {
                        break;
                    };
                    if custom_prop_present(&element.custom_props, "windowDrag") {
                        return true;
                    }
                    ancestor = element.parent;
                }
                false
            });
            if in_drag_region {
                cx.stop_propagation();
            }
        });
    }

    if let Some(handle) = ctx.focus_handles.get(&element.id) {
        el = el.track_focus(handle);
    }
    if let Some(tab_index) = element
        .custom_props
        .get("tabIndex")
        .and_then(|value| value.as_i64())
        .and_then(|index| isize::try_from(index).ok())
    {
        el = el.tab_index(tab_index).tab_stop(tab_index >= 0);
    }

    // React text instances (`createTextInstance`) are also type `text` and
    // hold `content`. Only the host `<text>` (no content of its own) gets
    // Label. The inner nodes stay out of the AX tree so VoiceOver does not
    // hear the same string twice.
    let is_text_host = element.element_type == "text" && element.content.is_none();
    let default_role = is_text_host.then_some(gpui::Role::Label);
    el = apply_accessibility(el, &element.custom_props, default_role);
    if is_text_host && element.custom_props.get("aria-valuetext").is_none() {
        if let Some(content) = joined_text_content(ctx.tree, element) {
            el = el.aria_value(apply_text_transform(
                &content,
                ctx.inherited.text_transform.as_deref(),
            ));
        }
    }

    // ── Window drag region (`windowDrag` / `data-window-drag`) ────────
    // Zed's titlebar model: down only arms the gesture, the first move
    // that still holds the button performs the AppKit window drag, so a
    // plain click never enters the modal drag loop and still reaches the
    // DOM. `window_control_area` additionally marks the hitbox for
    // Windows/Linux client-decoration hit-testing (no-op on macOS).
    if is_window_drag {
        el = el.window_control_area(gpui::WindowControlArea::Drag);
        let arm = ctx.window_drag_arm.clone();
        el = el.on_mouse_down(gpui::MouseButton::Left, move |event, window, _cx| {
            // Interactive descendants already handled the press: click
            // targets inside a region stop propagation outright (never
            // reach here), and focusable controls mark default_prevented
            // via their track_focus listener — same ordering, deeper first.
            if window.default_prevented() {
                return;
            }
            if event.click_count == 2 {
                // Same gesture Zed's titlebar uses: honors the macOS
                // AppleActionOnDoubleClick setting (zoom / minimize / none)
                // instead of hardcoding zoom. The second press never arms a
                // drag.
                arm.set(false);
                window.titlebar_double_click();
            } else if event.click_count == 1 {
                arm.set(true);
            }
            // click_count >= 3 continues a multi-click sequence — neither
            // zoom nor arm.
        });
        let arm = ctx.window_drag_arm.clone();
        el = el.on_mouse_up(gpui::MouseButton::Left, move |_, _window, _cx| {
            arm.set(false);
        });
        let arm = ctx.window_drag_arm.clone();
        // A release outside the region never reaches `on_mouse_up` (it
        // requires the hitbox to be hovered) — without this the arm leaks
        // and the next left-drag crossing the region would hijack into a
        // window move.
        el = el.on_mouse_up_out(gpui::MouseButton::Left, move |_, _window, _cx| {
            arm.set(false);
        });
        let arm = ctx.window_drag_arm.clone();
        el = el.on_mouse_down_out(move |_, _window, _cx| {
            arm.set(false);
        });
        let arm = ctx.window_drag_arm.clone();
        el = el.on_mouse_move(move |mouse_event, window, _cx| {
            if arm.replace(false) && mouse_event.pressed_button == Some(gpui::MouseButton::Left) {
                window.start_window_move();
            }
        });
    }

    // Wire up events.
    // Some events (on_hover, on_aux_click) require a stateful element (.id()),
    // which we already set above. Others (on_mouse_down, on_key_down) work
    // on any InteractiveElement.
    if ctx.tree.dispatches(element, "click") {
        let id = element.id;
        let callback = ctx.event_callback.clone();
        // GPUI's higher-level on_click gesture is not finalized by the
        // embedded macOS pump. Bubble listeners run in reverse registration
        // order, so attach click first to keep onMouseUp ahead of onClick.
        el = el.on_mouse_up(gpui::MouseButton::Left, move |mouse_event, _window, _cx| {
            emit_event_full(&callback, id, "click", |p| {
                let (x, y) = point_to_xy(mouse_event.position);
                p.x = Some(x);
                p.y = Some(y);
                p.button = Some(0);
                p.modifiers = Some(mouse_event.modifiers.into());
                p.click_count = Some(mouse_event.click_count as u32);
                p.is_right_click = Some(false);
            });
        });
        el = apply_a11y_click(el, true, id, ctx.event_callback);
    }

    // ── File drag hover (Finder / OS paths) ─────────────────────
    // One gpui hook drives all three names, so the listener set needs
    // only contain one of them for the handler to install. gpui reports
    // drag-move per element but never a leave — enter/leave are derived
    // by diffing the pointer's last registered drop target on a per-view
    // cell. A drag exiting to an element with no drag listeners never
    // synthesizes a leave: there is no native hook for it.
    if element
        .events
        .iter()
        .any(|event| matches!(event.as_str(), "fileDragEnter" | "fileDragOver" | "fileDragLeave"))
    {
        let id = element.id;
        let callback = ctx.event_callback.clone();
        let leave_callback = ctx.event_callback.clone();
        let drag_target = ctx.file_drag_target.clone();
        el = el.on_drag_move(
            move |event: &gpui::DragMoveEvent<gpui::ExternalPaths>, _window, _cx| {
                // gpui fires on_drag_move for EVERY move during an active file
                // drag — it is not hit-tested like on_drop. Gate on the
                // element's own hitbox so enter/over only fire under the
                // pointer. Nested listeners both pass the gate; children paint
                // (and dispatch) after parents, so the deepest target wins the
                // cell — matching DOM's deepest-target + bubble shape.
                if !event.bounds.contains(&event.event.position) {
                    return;
                }
                let (x, y) = point_to_xy(event.event.position);
                let previous = drag_target.replace(Some(id));
                if previous != Some(id) {
                    if let Some(exited) = previous {
                        emit_event_full(&leave_callback, exited, "fileDragLeave", |p| {
                            p.x = Some(x);
                            p.y = Some(y);
                        });
                    }
                    emit_event_full(&callback, id, "fileDragEnter", |p| {
                        p.x = Some(x);
                        p.y = Some(y);
                    });
                }
                emit_event_full(&callback, id, "fileDragOver", |p| {
                    p.x = Some(x);
                    p.y = Some(y);
                });
            },
        );
    }

    // Delegated types wire the same as per-element listeners — the union
    // covers element.events ∪ tree.delegated_events, deduped, so a root
    // delegation attaches dispatch here without any per-element op. Text
    // elements sit out the delegated half: a press must emit from the
    // containing element, matching the DOM where text isn't a target.
    for event_type in element
        .events
        .iter()
        .chain(ctx.tree.delegated_events.iter().filter(|t| {
            element.element_type != "text" && !element.events.contains(*t)
        }))
    {
        let id = element.id;
        let callback = ctx.event_callback.clone();
        match event_type.as_str() {
            // ── Aux click (non-primary), like the DOM `auxclick` ──
            "auxClick" => {
                el = el.on_aux_click(move |click_event, _window, _cx| {
                    emit_event_full(&callback, id, "auxClick", |p| {
                        let (x, y) = point_to_xy(click_event.position());
                        p.x = Some(x);
                        p.y = Some(y);
                        p.modifiers = Some(click_event.modifiers().into());
                        p.click_count = Some(click_event.click_count() as u32);
                        p.is_right_click = Some(click_event.is_right_click());
                    });
                });
            }

            // ── Mouse down (all buttons) ─────────────────────────
            "mouseDown" => {
                // Wire all three buttons so JS gets right-click, middle-click, etc.
                for &button in &[
                    gpui::MouseButton::Left,
                    gpui::MouseButton::Middle,
                    gpui::MouseButton::Right,
                ] {
                    let callback = callback.clone();
                    el = el.on_mouse_down(button, move |mouse_event, _window, _cx| {
                        emit_event_full(&callback, id, "mouseDown", |p| {
                            let (x, y) = point_to_xy(mouse_event.position);
                            p.x = Some(x);
                            p.y = Some(y);
                            p.button = Some(mouse_button_to_u32(mouse_event.button));
                            p.click_count = Some(mouse_event.click_count as u32);
                            p.modifiers = Some(mouse_event.modifiers.into());
                        });
                    });
                }
            }

            // ── Mouse up (all buttons) ───────────────────────────
            "mouseUp" => {
                for &button in &[
                    gpui::MouseButton::Left,
                    gpui::MouseButton::Middle,
                    gpui::MouseButton::Right,
                ] {
                    let callback = callback.clone();
                    el = el.on_mouse_up(button, move |mouse_event, _window, _cx| {
                        emit_event_full(&callback, id, "mouseUp", |p| {
                            let (x, y) = point_to_xy(mouse_event.position);
                            p.x = Some(x);
                            p.y = Some(y);
                            p.button = Some(mouse_button_to_u32(mouse_event.button));
                            p.click_count = Some(mouse_event.click_count as u32);
                            p.modifiers = Some(mouse_event.modifiers.into());
                        });
                    });
                }
            }

            // ── Mouse move ───────────────────────────────────────
            "mouseMove" => {
                el = el.on_mouse_move(move |mouse_event, _window, _cx| {
                    emit_event_full(&callback, id, "mouseMove", |p| {
                        let (x, y) = point_to_xy(mouse_event.position);
                        p.x = Some(x);
                        p.y = Some(y);
                        p.modifiers = Some(mouse_event.modifiers.into());
                        p.pressed_button = mouse_event.pressed_button.map(mouse_button_to_u32);
                    });
                });
            }

            // ── Hover (mouseEnter + mouseLeave) ──────────────────
            // GPUI's on_hover fires with true on enter, false on leave.
            // We split into two distinct event types for the React side.
            "mouseEnter" | "mouseLeave" => {
                // Only wire once even if both mouseEnter and mouseLeave are registered.
                // Check if we already wired on_hover via the other event.
                let has_enter = element.events.contains("mouseEnter");
                let has_leave = element.events.contains("mouseLeave");
                // Wire on first encounter (mouseEnter sorts before mouseLeave).
                if event_type.as_str() == "mouseEnter" || !has_enter {
                    let callback_enter = if has_enter {
                        ctx.event_callback.clone()
                    } else {
                        None
                    };
                    let callback_leave = if has_leave {
                        ctx.event_callback.clone()
                    } else {
                        None
                    };
                    el = el.on_hover(move |&is_hovered, _window, _cx| {
                        if is_hovered {
                            emit_event_full(&callback_enter, id, "mouseEnter", |p| {
                                p.hovered = Some(true);
                            });
                        } else {
                            emit_event_full(&callback_leave, id, "mouseLeave", |p| {
                                p.hovered = Some(false);
                            });
                        }
                    });
                }
            }

            // ── Mouse down outside ───────────────────────────────
            // Fires when the user clicks OUTSIDE this element.
            // Critical for "click outside to close" pattern (dropdowns, modals).
            "mouseDownOutside" => {
                el = el.on_mouse_down_out(move |mouse_event, _window, _cx| {
                    emit_event_full(&callback, id, "mouseDownOutside", |p| {
                        let (x, y) = point_to_xy(mouse_event.position);
                        p.x = Some(x);
                        p.y = Some(y);
                        p.button = Some(mouse_button_to_u32(mouse_event.button));
                        p.modifiers = Some(mouse_event.modifiers.into());
                    });
                });
            }

            // ── File drop (Finder / OS paths) ────────────────────
            "fileDrop" => {
                let drag_target = ctx.file_drag_target.clone();
                let leave_callback = callback.clone();
                el = el.on_drop(move |dropped: &gpui::ExternalPaths, window, _cx| {
                    // Synthesized leave before the drop — the cell names the
                    // last hovered listener element, which is usually this
                    // one but may be another if no drag-move intervened.
                    let position = window.mouse_position();
                    if let Some(exited) = drag_target.replace(None) {
                        let (x, y) = point_to_xy(position);
                        emit_event_full(&leave_callback, exited, "fileDragLeave", |p| {
                            p.x = Some(x);
                            p.y = Some(y);
                        });
                    }
                    emit_file_drop(&callback, id, dropped, position);
                });
            }

            // ── Scroll wheel ─────────────────────────────────────
            "scroll" => {
                el = el.on_scroll_wheel(move |scroll_event, _window, _cx| {
                    emit_event_full(&callback, id, "scroll", |p| {
                        let (x, y) = point_to_xy(scroll_event.position);
                        p.x = Some(x);
                        p.y = Some(y);
                        p.modifiers = Some(scroll_event.modifiers.into());
                        p.precise = Some(scroll_event.delta.precise());

                        // Convert ScrollDelta to pixel values.
                        // For Lines delta, we use a default line height of 20px.
                        let line_height = gpui::px(20.0);
                        let pixel_delta = scroll_event.delta.pixel_delta(line_height);
                        p.delta_x = Some(f64::from(f32::from(pixel_delta.x)));
                        p.delta_y = Some(f64::from(f32::from(pixel_delta.y)));

                        p.touch_phase = Some(match scroll_event.touch_phase {
                            gpui::TouchPhase::Started => "started".to_string(),
                            gpui::TouchPhase::Moved => "moved".to_string(),
                            gpui::TouchPhase::Ended => "ended".to_string(),
                            gpui::TouchPhase::Cancelled => "cancelled".to_string(),
                        });
                    });
                });
            }

            // ── Key down ─────────────────────────────────────────
            // Requires .focusable() (set above). Element must be focused
            // (clicked or tabbed to) for these to fire.
            "keyDown" => {
                el = el.on_key_down(move |key_event, _window, _cx| {
                    emit_event_full(&callback, id, "keyDown", |p| {
                        p.key = Some(key_event.keystroke.key.clone());
                        p.key_char = key_event.keystroke.key_char.clone();
                        p.is_held = Some(key_event.is_held);
                        p.modifiers = Some(key_event.keystroke.modifiers.into());
                    });
                });
            }

            // ── Key up ───────────────────────────────────────────
            "keyUp" => {
                el = el.on_key_up(move |key_event, _window, _cx| {
                    emit_event_full(&callback, id, "keyUp", |p| {
                        p.key = Some(key_event.keystroke.key.clone());
                        p.key_char = key_event.keystroke.key_char.clone();
                        p.modifiers = Some(key_event.keystroke.modifiers.into());
                    });
                });
            }

            // ── Focus / Blur ─────────────────────────────────────
            // Event emission is handled by FocusHandle subscriptions
            // set up in GpuixView::sync_focus_handles(). The handle is
            // attached to this element via .track_focus() above.
            "focus" | "blur" => {}

            _ => {}
        }
    }

    if ctx.tree.dispatches(element, "mouseDown") && ctx.tree.dispatches(element, "mouseMove") {
        el = el.capture_pointer();
    }

    // Text content — selectable, same as a <text> leaf.
    if let Some(ref content) = element.content {
        el = el.child(text_content(element, content, ctx));
    }

    // Children
    let child_ids: Vec<u64> = element.children.clone();
    for child_id in child_ids {
        let (child, marker) = build_element(child_id, ctx, window, cx);
        el = if overflow_x_only {
            el.child(gpui::div().flex_none().child(child))
        } else {
            el.child(child)
        };
        if let Some(marker) = marker {
            el = el.child(marker);
        }
    }

    el.into_any_element()
}

/// A selectable text run owned by `element`. Runs are left to gpui so the
/// text keeps inheriting colour, weight and family from ancestor styles.
///
/// The run's group is its parent host element, because React makes a separate
/// host node for every interpolated string. `<text>Hello {name}!</text>` is one
/// logical line painted as three runs that all share the parent's id.
/// A `userSelect: "none"` run still paints highlight washes, because a browser
/// still finds that text with Ctrl+F. Element chrome that must never be found,
/// such as a code gutter, uses `chrome_text` instead.
/// Apply the inherited `textTransform` to literal text. The string is
/// transformed before shaping, so glyphs, hit-testing, copy, and the AX
/// label all see the transformed text — which is also what CSS does.
fn apply_text_transform(content: &str, transform: Option<&str>) -> String {
    match transform {
        Some("uppercase") => content.to_uppercase(),
        Some("lowercase") => content.to_lowercase(),
        Some("capitalize") => {
            let mut new_word = true;
            content
                .chars()
                .flat_map(|ch| {
                    if ch.is_alphanumeric() {
                        let out: Vec<char> = if new_word {
                            ch.to_uppercase().collect()
                        } else {
                            vec![ch]
                        };
                        new_word = false;
                        out
                    } else {
                        new_word = true;
                        vec![ch]
                    }
                })
                .collect()
        }
        _ => content.to_string(),
    }
}

fn text_content(
    element: &crate::retained_tree::RetainedElement,
    content: &str,
    ctx: &BuildCtx,
) -> gpui::AnyElement {
    let content = apply_text_transform(content, ctx.inherited.text_transform.as_deref());
    selectable_text(crate::text::SelectableText {
        group: crate::text::search::group_id(ctx.tree, element.id),
        selectable: ctx.inherited.selectable,
        highlight: ctx
            .inherited
            .highlight
            .clone()
            .map(crate::text::HighlightSource::Resolved),
        ..crate::text::SelectableText::new(
            element.id,
            0,
            gpui::SharedString::from(content),
            None,
            ctx.selection.clone(),
            ctx.inherited.selection_wash,
        )
    })
}

/// Explicit `userSelect` on this node. `None` means inherit; the ancestor
/// that set the value already owns the start region.
fn selection_start_flag(style: Option<&StyleDesc>) -> Option<bool> {
    match style.and_then(|style| style.user_select.as_deref()) {
        Some("none") => Some(false),
        Some("text") | Some("auto") => Some(true),
        _ => None,
    }
}

// ── Style application ────────────────────────────────────────────────

pub(crate) fn apply_width<E: gpui::Styled>(el: E, dim: &crate::style::DimensionValue) -> E {
    match dim {
        crate::style::DimensionValue::Pixels(v) => el.w(gpui::px(*v as f32)),
        crate::style::DimensionValue::Percentage(v) if *v >= 0.999 => el.w_full(),
        crate::style::DimensionValue::Percentage(v) => el.w(gpui::relative(*v as f32)),
        crate::style::DimensionValue::Auto => el,
    }
}

pub(crate) fn apply_height<E: gpui::Styled>(el: E, dim: &crate::style::DimensionValue) -> E {
    match dim {
        crate::style::DimensionValue::Pixels(v) => el.h(gpui::px(*v as f32)),
        crate::style::DimensionValue::Percentage(v) if *v >= 0.999 => el.h_full(),
        crate::style::DimensionValue::Percentage(v) => el.h(gpui::relative(*v as f32)),
        crate::style::DimensionValue::Auto => el,
    }
}

/// Base styles plus gpui's `hover` and `active` refinements.
///
/// Every stateful GPUI root must go through this, never `apply_styles` alone.
/// `StyleDesc` carries `hover` and `active` for every element type, so a custom
/// element that only applied the base styles accepted the prop, serialized it,
/// and dropped it. gpui reads both refinements from the element state behind the
/// element's `ElementId`, so the caller must have called `.id(..)` first.
pub(crate) fn apply_interactive_styles<E>(mut el: E, style: &StyleDesc) -> E
where
    E: gpui::Styled + gpui::StatefulInteractiveElement,
{
    el = apply_styles(el, style);
    if let Some(hover_style) = style.hover.as_deref() {
        el = el.hover(|refinement| apply_styles(refinement, hover_style));
    }
    if let Some(active_style) = style.active.as_deref() {
        el = el.active(|refinement| apply_styles(refinement, active_style));
    }
    // gpui's `in_focus` is "inside another focused element" — focus-within.
    if let Some(focus_style) = style.focus.as_deref() {
        el = el.focus(|refinement| apply_styles(refinement, focus_style));
    }
    if let Some(focus_within) = style.focus_within.as_deref() {
        el = el.in_focus(|refinement| apply_styles(refinement, focus_within));
    }
    if let Some(focus_visible) = style.focus_visible.as_deref() {
        el = el.focus_visible(|refinement| apply_styles(refinement, focus_visible));
    }
    el
}

pub(crate) fn apply_styles<E: gpui::Styled>(mut el: E, style: &StyleDesc) -> E {
    match style.display.as_deref() {
        Some("flex") => el = el.flex(),
        Some("grid") => el = el.grid(),
        _ => {}
    }
    if let Some(cols) = style.grid_template_columns {
        let count = cols.round().clamp(1.0, 64.0) as u16;
        el = match style.grid_column_min.as_deref() {
            Some("min-content") => el.grid_cols_min_content(count),
            Some("max-content") => el.grid_cols_max_content(count),
            _ => el.grid_cols(count),
        };
    }
    if let Some(rows) = style.grid_template_rows {
        let count = rows.round().clamp(1.0, 64.0) as u16;
        el = match style.grid_row_min.as_deref() {
            Some("min-content") => el.grid_rows_min_content(count),
            Some("max-content") => el.grid_rows_max_content(count),
            _ => el.grid_rows(count),
        };
    }
    if style.flex_direction.as_deref() == Some("column") {
        el = el.flex_col();
    }
    if style.flex_direction.as_deref() == Some("row") {
        el = el.flex_row();
    }
    match style.flex_wrap.as_deref() {
        Some("wrap") => el = el.flex_wrap(),
        Some("wrap-reverse") => el = el.flex_wrap_reverse(),
        Some("nowrap") => el = el.flex_nowrap(),
        _ => {}
    }
    if let Some(grow) = style.flex_grow {
        el.style().flex_grow = Some(grow as f32);
    }
    if let Some(shrink) = style.flex_shrink {
        el.style().flex_shrink = Some(shrink as f32);
    }
    match style.flex_basis {
        Some(crate::style::DimensionValue::Pixels(px)) => el = el.flex_basis(gpui::px(px as f32)),
        Some(crate::style::DimensionValue::Percentage(f)) => {
            el = el.flex_basis(gpui::Length::Definite(gpui::DefiniteLength::Fraction(
                f as f32,
            )))
        }
        Some(crate::style::DimensionValue::Auto) => el = el.flex_basis(gpui::Length::Auto),
        None => {}
    }
    match style.align_items.as_deref() {
        Some("center") => el = el.items_center(),
        Some("start") | Some("flex-start") => el = el.items_start(),
        Some("end") | Some("flex-end") => el = el.items_end(),
        _ => {}
    }
    match style.align_content.as_deref() {
        Some("center") => el = el.content_center(),
        Some("start") | Some("flex-start") => el = el.content_start(),
        Some("end") | Some("flex-end") => el = el.content_end(),
        Some("between") | Some("space-between") => el = el.content_between(),
        Some("around") | Some("space-around") => el = el.content_around(),
        Some("evenly") | Some("space-evenly") => el = el.content_evenly(),
        Some("stretch") => el = el.content_stretch(),
        Some("normal") => el = el.content_normal(),
        _ => {}
    }
    match style.justify_content.as_deref() {
        Some("center") => el = el.justify_center(),
        Some("start") | Some("flex-start") => el = el.justify_start(),
        Some("end") | Some("flex-end") => el = el.justify_end(),
        Some("between") | Some("space-between") => el = el.justify_between(),
        Some("around") | Some("space-around") => el = el.justify_around(),
        _ => {}
    }
    match style.align_self.as_deref() {
        Some("center") => {
            el.style().align_self = Some(gpui::AlignItems::Center);
        }
        Some("start") | Some("flex-start") => {
            el.style().align_self = Some(gpui::AlignItems::FlexStart);
        }
        Some("end") | Some("flex-end") => {
            el.style().align_self = Some(gpui::AlignItems::FlexEnd);
        }
        Some("stretch") => {
            el.style().align_self = Some(gpui::AlignItems::Stretch);
        }
        Some("baseline") => {
            el.style().align_self = Some(gpui::AlignItems::Baseline);
        }
        _ => {}
    }
    if let Some(gap) = style.gap {
        el = el.gap(gpui::px(gap as f32));
    }
    // Per-axis gaps were in the style type and implemented nowhere. They come
    // after `gap` so the axis value wins, matching CSS shorthand order.
    if let Some(gap) = style.row_gap {
        el = el.gap_y(gpui::px(gap as f32));
    }
    if let Some(gap) = style.column_gap {
        el = el.gap_x(gpui::px(gap as f32));
    }
    if let Some(ref w) = style.width {
        el = apply_width(el, w);
    }
    if let Some(ref h) = style.height {
        el = apply_height(el, h);
    }
    if let Some(ref min_w) = style.min_width {
        match min_w {
            crate::style::DimensionValue::Pixels(v) => el = el.min_w(gpui::px(*v as f32)),
            crate::style::DimensionValue::Percentage(v) => el = el.min_w(gpui::relative(*v as f32)),
            crate::style::DimensionValue::Auto => {}
        }
    }
    if let Some(ref min_h) = style.min_height {
        match min_h {
            crate::style::DimensionValue::Pixels(v) => el = el.min_h(gpui::px(*v as f32)),
            crate::style::DimensionValue::Percentage(v) => el = el.min_h(gpui::relative(*v as f32)),
            crate::style::DimensionValue::Auto => {}
        }
    }
    if let Some(ref max_w) = style.max_width {
        match max_w {
            crate::style::DimensionValue::Pixels(v) => el = el.max_w(gpui::px(*v as f32)),
            crate::style::DimensionValue::Percentage(v) => el = el.max_w(gpui::relative(*v as f32)),
            crate::style::DimensionValue::Auto => {}
        }
    }
    if let Some(ref max_h) = style.max_height {
        match max_h {
            crate::style::DimensionValue::Pixels(v) => el = el.max_h(gpui::px(*v as f32)),
            crate::style::DimensionValue::Percentage(v) => el = el.max_h(gpui::relative(*v as f32)),
            crate::style::DimensionValue::Auto => {}
        }
    }
    if let Some(ratio) = style.aspect_ratio {
        if ratio.is_finite() && ratio > 0.0 {
            el = el.aspect_ratio(ratio as f32);
        }
    }
    if let Some(p) = style.padding {
        el = el.p(gpui::px(p as f32));
    }
    if let Some(pt) = style.padding_top {
        el = el.pt(gpui::px(pt as f32));
    }
    if let Some(pr) = style.padding_right {
        el = el.pr(gpui::px(pr as f32));
    }
    if let Some(pb) = style.padding_bottom {
        el = el.pb(gpui::px(pb as f32));
    }
    if let Some(pl) = style.padding_left {
        el = el.pl(gpui::px(pl as f32));
    }
    if let Some(m) = style.margin {
        el = el.m(gpui::px(m as f32));
    }
    if let Some(mt) = style.margin_top {
        el = el.mt(gpui::px(mt as f32));
    }
    if let Some(mr) = style.margin_right {
        el = el.mr(gpui::px(mr as f32));
    }
    if let Some(mb) = style.margin_bottom {
        el = el.mb(gpui::px(mb as f32));
    }
    if let Some(ml) = style.margin_left {
        el = el.ml(gpui::px(ml as f32));
    }
    // Taffy has no viewport-fixed position, and GPUI has no scrolling document,
    // so "fixed" lays out exactly like "absolute". `should_occlude` already
    // treated the two the same; without this arm a "fixed" box stayed in flow.
    match style.position.as_deref() {
        Some("absolute") | Some("fixed") => el = el.absolute(),
        Some("relative") => el = el.relative(),
        _ => {}
    }
    if let Some(top) = style.top {
        el = el.top(gpui::px(top as f32));
    }
    if let Some(right) = style.right {
        el = el.right(gpui::px(right as f32));
    }
    if let Some(bottom) = style.bottom {
        el = el.bottom(gpui::px(bottom as f32));
    }
    if let Some(left) = style.left {
        el = el.left(gpui::px(left as f32));
    }
    if let Some(background) = style.resolved_background() {
        el = el.bg(background);
    }
    if let Some(ref color) = style.color {
        if let Some(color) = crate::color::parse_color_rgba(color) {
            el = el.text_color(color);
        }
    }
    if let Some(size) = style.font_size {
        el = el.text_size(gpui::px(size as f32));
    }
    if let Some(ref family) = style.font_family {
        el = el.font_family(family.clone());
    }
    if let Some(ref weight) = style.font_weight {
        el = el.font_weight(parse_font_weight(weight));
    }
    match style.font_style.as_deref() {
        Some("italic") | Some("oblique") => el = el.italic(),
        Some("normal") => el = el.not_italic(),
        _ => {}
    }
    // `textAlign` was in the style type but implemented nowhere.
    match style.text_align.as_deref() {
        Some("center") => el = el.text_center(),
        Some("right") => el = el.text_right(),
        Some("left") | Some("start") => el = el.text_left(),
        _ => {}
    }
    match style.white_space.as_deref() {
        Some("nowrap") => el = el.whitespace_nowrap(),
        Some("normal") => el = el.whitespace_normal(),
        _ => {}
    }
    match style.text_overflow.as_deref() {
        Some("ellipsis") => el = el.text_ellipsis(),
        Some("ellipsis-start") => el = el.text_ellipsis_start(),
        _ => {}
    }
    if let Some(clamp) = style.line_clamp {
        if clamp >= 1.0 {
            el = el.line_clamp(clamp as usize);
        }
    }
    match style.text_decoration.as_deref() {
        Some("underline") => el = el.underline(),
        Some("line-through") => el = el.line_through(),
        Some("none") => el = el.text_decoration_none(),
        _ => {}
    }
    if let Some(ref color) = style.text_decoration_color {
        if let Some(color) = crate::color::parse_color_rgba(color) {
            el = el.text_decoration_color(color);
        }
    }
    // `line_height` was accepted by the style type but never applied, so
    // multi-line text always used gpui's default leading.
    if let Some(line_height) = style.line_height {
        if line_height > 0.0 {
            el = el.line_height(gpui::px(line_height as f32));
        }
    }
    // Unitless `leading-*` multiplier — `relative` resolves × font size,
    // matching CSS `line-height: <number>` semantics.
    if let Some(scale) = style.line_height_scale {
        if scale > 0.0 {
            el = el.line_height(gpui::relative(scale as f32));
        }
    }
    if let Some(spacing) = style.letter_spacing {
        el = el.letter_spacing(gpui::px(spacing as f32));
    }
    if let Some(features) = &style.font_features {
        el = el.font_features(features.clone());
    }
    if let Some(radius) = style.border_radius {
        el = el.rounded(gpui::px(radius as f32));
    }
    // Apply corner longhands after the shorthand so the explicit corner wins.
    if let Some(radius) = style.border_top_left_radius {
        el = el.rounded_tl(gpui::px(radius as f32));
    }
    if let Some(radius) = style.border_top_right_radius {
        el = el.rounded_tr(gpui::px(radius as f32));
    }
    if let Some(radius) = style.border_bottom_left_radius {
        el = el.rounded_bl(gpui::px(radius as f32));
    }
    if let Some(radius) = style.border_bottom_right_radius {
        el = el.rounded_br(gpui::px(radius as f32));
    }
    // `borderWidth: 0` must clear a border, not be ignored: an element that
    // draws its own border needs a way for the caller to remove it.
    if let Some(width) = style.border_width {
        el = el.border(gpui::px(width.max(0.0) as f32));
    }
    if let Some(width) = style.border_top_width {
        el = el.border_t(gpui::px(width.max(0.0) as f32));
    }
    if let Some(width) = style.border_right_width {
        el = el.border_r(gpui::px(width.max(0.0) as f32));
    }
    if let Some(width) = style.border_bottom_width {
        el = el.border_b(gpui::px(width.max(0.0) as f32));
    }
    if let Some(width) = style.border_left_width {
        el = el.border_l(gpui::px(width.max(0.0) as f32));
    }
    if let Some(ref color) = style.border_color {
        if let Some(color) = crate::color::parse_color_rgba(color) {
            el = el.border_color(color);
        }
    }
    if let Some(ref shadows) = style.box_shadow {
        // Full shadow lists: svelai elevation is a stack, and raised/lift
        // compose an inset tint member ahead of it.
        let list: Vec<gpui::BoxShadow> = shadows
            .iter()
            .filter_map(|member| {
                let color = crate::color::parse_color_rgba(&member.color)?;
                let built = gpui::BoxShadow::new(
                    gpui::px(member.offset_x as f32),
                    gpui::px(member.offset_y as f32),
                    color.into(),
                )
                .blur_radius(gpui::px(member.blur_radius.max(0.0) as f32))
                .spread_radius(gpui::px(member.spread_radius as f32));
                Some(if member.inset == Some(true) {
                    built.inset()
                } else {
                    built
                })
            })
            .collect();
        if !list.is_empty() {
            el = el.shadow(list);
        }
    }
    if style.visibility.as_deref() == Some("hidden") {
        el = el.invisible();
    }
    if let Some(opacity) = style.opacity {
        el = el.opacity(opacity as f32);
    }
    if let Some(cursor) = style.cursor.as_deref().and_then(crate::style::parse_cursor) {
        el = el.cursor(cursor);
    }
    // Overflow: hidden is on the Styled trait, so we handle it here.
    // overflow: "scroll" requires StatefulInteractiveElement — handled in build_host_container().
    // CSS precedence: axis-specific (overflowX/Y) overrides the shorthand (overflow).
    {
        let resolved_x = style.overflow_x.as_deref().or(style.overflow.as_deref());
        let resolved_y = style.overflow_y.as_deref().or(style.overflow.as_deref());
        // Only apply hidden here — scroll is handled in build_host_container.
        if resolved_x == Some("hidden") && resolved_y == Some("hidden") {
            el = el.overflow_hidden();
        } else if resolved_x == Some("hidden") {
            el = el.overflow_x_hidden();
        } else if resolved_y == Some("hidden") {
            el = el.overflow_y_hidden();
        }
    }

    el
}

// ── Event emission ───────────────────────────────────────────────────

/// Helper to convert a GPUI Point<Pixels> to (f64, f64).
pub(crate) fn point_to_xy(p: gpui::Point<gpui::Pixels>) -> (f64, f64) {
    (f64::from(f32::from(p.x)), f64::from(f32::from(p.y)))
}

/// Paths that are valid UTF-8, or None when the drop is empty or not Unicode.
/// `to_string_lossy` would invent a path that does not exist on disk.
fn file_drop_paths(dropped: &gpui::ExternalPaths) -> Option<Vec<String>> {
    let paths = dropped.paths();
    if paths.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(path.to_str()?.to_string());
    }
    Some(out)
}

pub(crate) fn emit_file_drop(
    callback: &Option<EventCallback>,
    element_id: u64,
    dropped: &gpui::ExternalPaths,
    position: gpui::Point<gpui::Pixels>,
) {
    let Some(paths) = file_drop_paths(dropped) else {
        return;
    };
    emit_event_full(callback, element_id, "fileDrop", |payload| {
        let (x, y) = point_to_xy(position);
        payload.x = Some(x);
        payload.y = Some(y);
        payload.paths = Some(paths);
    });
}

/// Convert GPUI MouseButton to our u32 encoding: 0=left, 1=middle, 2=right.
pub(crate) fn mouse_button_to_u32(button: gpui::MouseButton) -> u32 {
    match button {
        gpui::MouseButton::Left => 0,
        gpui::MouseButton::Middle => 1,
        gpui::MouseButton::Right => 2,
        gpui::MouseButton::Navigate(_) => 3,
    }
}

/// Sentinel element id for window-scoped events that aren't about one
/// element — `frame` today. Mirrors `WINDOW_EVENT_ID` in gdom.ts; gdom
/// intercepts on eventType, so this just needs to never collide with a real
/// element id (ids climb from small integers).
const WINDOW_EVENT_ID: u64 = 0x7fff_ff01;

/// General-purpose event emitter. Builds a default EventPayload, lets the
/// caller customize it via a closure, then sends it through the callback.
/// Production: queues on Node.js event loop via ThreadsafeFunction.
/// Tests: pushes to a synchronous Vec for drainEvents().
pub(crate) fn emit_event_full(
    callback: &Option<EventCallback>,
    element_id: u64,
    event_type: &str,
    build: impl FnOnce(&mut EventPayload),
) {
    if let Some(cb) = callback {
        let mut payload = EventPayload {
            element_id: element_id as f64,
            event_type: event_type.to_string(),
            ..Default::default()
        };
        build(&mut payload);
        cb(payload);
    }
}

// ── Batch processing ─────────────────────────────────────────────

/// Parsed batch operation — typed enum for atomic validation.
/// All ops are parsed and validated BEFORE any tree mutation occurs.
/// This prevents partial application on malformed batches.
enum BatchOp<'a> {
    CreateElement {
        id: u64,
        element_type: String,
    },
    DestroyElement {
        id: u64,
    },
    AppendChild {
        parent_id: u64,
        child_id: u64,
    },
    InsertBefore {
        parent_id: u64,
        child_id: u64,
        before_id: u64,
    },
    /// Reparent/reorder of an already-live subtree — `insertBefore` with a
    /// `before_id` of 0 means move to the end. Emitted only when the child
    /// already has a native peer, so the subtree keeps its element id and
    /// everything keyed by it (state, listeners, FocusHandle).
    MoveBefore {
        parent_id: u64,
        child_id: u64,
        before_id: u64,
    },
    /// The payload stays as raw JSON until apply time.
    ///
    /// Two reasons. A parsed `StyleDesc` is ~1.4 KB, and a `Vec<BatchOp>` is as
    /// wide as its widest variant, so inlining one made a 220k-op mount reserve
    /// over 300 MB before it parsed a single op. And the tree hash-conses
    /// styles by content, so it needs the bytes: hashing ~110 bytes is far
    /// cheaper than building 80 `Option` fields and throwing 99.8% of them away.
    SetStyle {
        id: u64,
        style: &'a serde_json::value::RawValue,
    },
    /// Raw StyleProps payload — object, array of objects (ordered fragments),
    /// or null to clear the layer. Mapping to native fields happens in Rust
    /// (`style_props::resolve_style_props`) at compose time.
    SetStyleProps {
        id: u64,
        props: Option<&'a serde_json::value::RawValue>,
    },
    /// Bind a recipe by name (`null` unbinds) plus the variant tuple and an
    /// optional StyleProps escape fragment. The wire carries variant names —
    /// resolution is native.
    SetRecipe {
        id: u64,
        name: Option<String>,
        variants: Option<serde_json::Map<String, serde_json::Value>>,
        extra: Option<&'a serde_json::value::RawValue>,
    },
    /// Ship a recipe.js-shaped config. Fragments are StyleProps; they compile
    /// through `resolve_style_props` once at registration, then
    /// `Recipe::from_json` builds the native engine.
    RegisterRecipe {
        name: String,
        config: &'a serde_json::value::RawValue,
    },
    SetText {
        id: u64,
        content: String,
    },
    SetEventListener {
        id: u64,
        event_type: String,
        has_handler: bool,
    },
    /// The app's delegated event set (gpuix names) — dispatch for these
    /// attaches on every element at build, so the JS side never emits a
    /// per-element listener op for a delegated type. Absolute replacement.
    SetDelegatedEvents {
        events: Vec<String>,
    },
    SetRoot {
        id: u64,
        /// Window the subtree binds to. Absent on every pre-multi-window
        /// op stream — the primary window is the default.
        window_id: u32,
    },
    SetCustomProp {
        id: u64,
        key: String,
        value: serde_json::Value,
    },
    /// App-level theme declaration — tree state, not element state. It seeds
    /// every element's ancestor theme fold, so the JS side needs no element
    /// to carry the app theme. `null` retracts to the built-in dark theme.
    SetTheme {
        value: serde_json::Value,
    },
    /// Replace an element's class token list — the selector-match input for
    /// the native stylesheet engine.
    SetClass {
        id: u64,
        value: String,
    },
    /// JS `requestAnimationFrame` — wakes every window hosting a root so the
    /// next vsync render emits the `frame` event the JS rAF queue ticks on.
    /// No payload.
    RequestFrame,
    /// Register or replace a sheet's rules. They parse at decode so a
    /// malformed payload fails the batch before anything mutates.
    RegisterSheet {
        sheet: String,
        rules: Vec<crate::stylesheet::Rule>,
    },
    /// Remove a sheet's rules — affected elements re-resolve in phase 3b.
    UnregisterSheet {
        sheet: String,
    },
}

/// A batch failure. The message names the op index, so it survives the trip
/// back to JS as a plain `Error`.
pub type BatchResult<T> = std::result::Result<T, String>;

/// Decode the batch straight from its JSON bytes into `Vec<BatchOp>`.
///
/// There is deliberately no `Vec<serde_json::Value>` in between. That tree cost
/// a `String` per key and per value, every payload was then deep-cloned out of
/// it, and `from_value` parsed the clone a second time, so one style was
/// allocated three times. A 220k-op mount made 1.5M allocations that way.
///
/// Everything the `Value` version guaranteed still holds, and each one is
/// load-bearing:
///
/// * an unknown opcode is a hard error, not a skipped op. Silently ignoring one
///   would let a JS/Rust version skew desync the tree instead of throwing
/// * ids go through `raw_element_id`, so non-finite, negative, fractional and
///   out-of-safe-range values are still rejected
/// * `hasHandler` is accepted as a bool or a number
/// * errors still name the op index. `serde_json` reports a byte offset, which
///   is useless when you are chasing a desync
fn parse_batch_ops(bytes: &[u8]) -> BatchResult<Vec<BatchOp<'_>>> {
    serde_json::from_slice::<BatchOps>(bytes)
        .map(|batch| batch.0)
        .map_err(|error| format!("Failed to parse batch: {error}"))
}

struct BatchOps<'a>(Vec<BatchOp<'a>>);

impl<'de> serde::Deserialize<'de> for BatchOps<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct OpsVisitor;

        impl<'de> serde::de::Visitor<'de> for OpsVisitor {
            type Value = BatchOps<'de>;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an array of mutation tuples")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<BatchOps<'de>, A::Error> {
                let mut ops = Vec::with_capacity(seq.size_hint().unwrap_or(64));
                loop {
                    // The index is attached here because this is the only place
                    // that knows it.
                    let index = ops.len();
                    match seq.next_element::<BatchOp<'de>>() {
                        Ok(Some(op)) => ops.push(op),
                        Ok(None) => break,
                        Err(error) => {
                            return Err(serde::de::Error::custom(format!(
                                "Batch op {index}: {error}"
                            )))
                        }
                    }
                }
                Ok(BatchOps(ops))
            }
        }

        deserializer.deserialize_seq(OpsVisitor)
    }
}

/// A string argument, borrowed from the input when the JSON has no escapes.
///
/// The owned copy happens exactly once, on the way into the `BatchOp`. The
/// `Value` path allocated twice: into `Value::String`, then into the op.
struct StrArg<'a>(std::borrow::Cow<'a, str>);

impl<'de> serde::Deserialize<'de> for StrArg<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        use std::borrow::Cow;
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = StrArg<'de>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a string")
            }
            fn visit_borrowed_str<E: serde::de::Error>(
                self,
                v: &'de str,
            ) -> std::result::Result<StrArg<'de>, E> {
                Ok(StrArg(Cow::Borrowed(v)))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                v: &str,
            ) -> std::result::Result<StrArg<'de>, E> {
                Ok(StrArg(Cow::Owned(v.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<StrArg<'de>, E> {
                Ok(StrArg(Cow::Owned(v)))
            }
        }
        deserializer.deserialize_str(V)
    }
}

fn next_arg<'de, A, T>(seq: &mut A, what: &str) -> std::result::Result<T, A::Error>
where
    A: serde::de::SeqAccess<'de>,
    T: serde::Deserialize<'de>,
{
    seq.next_element()?
        .ok_or_else(|| serde::de::Error::custom(format!("missing {what}")))
}

/// Read an element id. Ids cross napi as JS numbers, so they are read as `f64`
/// and validated exactly as `batch_id` did.
fn next_id<'de, A: serde::de::SeqAccess<'de>>(
    seq: &mut A,
    what: &str,
) -> std::result::Result<u64, A::Error> {
    let raw: f64 = next_arg(seq, what)?;
    raw_element_id(raw).map_err(serde::de::Error::custom)
}

impl<'de> serde::Deserialize<'de> for BatchOp<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct V;

        impl<'de> serde::de::Visitor<'de> for V {
            type Value = BatchOp<'de>;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a [opcode, ...args] mutation tuple")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<BatchOp<'de>, A::Error> {
                let name: StrArg<'de> = next_arg(&mut seq, "op name")?;
                let op = match name.0.as_ref() {
                    "createElement" => BatchOp::CreateElement {
                        id: next_id(&mut seq, "id")?,
                        element_type: next_arg::<A, StrArg>(&mut seq, "element type")?
                            .0
                            .into_owned(),
                    },
                    "destroyElement" => BatchOp::DestroyElement {
                        id: next_id(&mut seq, "id")?,
                    },
                    "appendChild" => BatchOp::AppendChild {
                        parent_id: next_id(&mut seq, "parent id")?,
                        child_id: next_id(&mut seq, "child id")?,
                    },
                    "insertBefore" => BatchOp::InsertBefore {
                        parent_id: next_id(&mut seq, "parent id")?,
                        child_id: next_id(&mut seq, "child id")?,
                        before_id: next_id(&mut seq, "before id")?,
                    },
                    "moveBefore" => BatchOp::MoveBefore {
                        parent_id: next_id(&mut seq, "parent id")?,
                        child_id: next_id(&mut seq, "child id")?,
                        // The anchor is optional — `["moveBefore", p, c]` and
                        // a null/0 anchor both mean "move to the end".
                        before_id: seq
                            .next_element::<Option<f64>>()?
                            .flatten()
                            .map(|raw| {
                                raw_element_id(raw).map_err(serde::de::Error::custom)
                            })
                            .transpose()?
                            .unwrap_or(0),
                    },
                    "setStyle" => BatchOp::SetStyle {
                        id: next_id(&mut seq, "id")?,
                        style: next_arg(&mut seq, "style")?,
                    },
                    "setStyleProps" => BatchOp::SetStyleProps {
                        id: next_id(&mut seq, "id")?,
                        props: next_arg(&mut seq, "style props")?,
                    },
                    "setRecipe" => BatchOp::SetRecipe {
                        id: next_id(&mut seq, "id")?,
                        name: next_arg::<A, Option<StrArg>>(&mut seq, "recipe name")?
                            .map(|s| s.0.into_owned()),
                        variants: seq
                            .next_element::<Option<serde_json::Map<String, serde_json::Value>>>()?
                            .flatten(),
                        extra: seq
                            .next_element::<Option<&serde_json::value::RawValue>>()?
                            .flatten(),
                    },
                    "registerRecipe" => BatchOp::RegisterRecipe {
                        name: next_arg::<A, StrArg>(&mut seq, "recipe name")?
                            .0
                            .into_owned(),
                        config: next_arg(&mut seq, "recipe config")?,
                    },
                    "setText" => BatchOp::SetText {
                        id: next_id(&mut seq, "id")?,
                        content: next_arg::<A, StrArg>(&mut seq, "text")?.0.into_owned(),
                    },
                    "setEventListener" => BatchOp::SetEventListener {
                        id: next_id(&mut seq, "id")?,
                        event_type: next_arg::<A, StrArg>(&mut seq, "event type")?
                            .0
                            .into_owned(),
                        has_handler: next_arg(&mut seq, "hasHandler")?,
                    },
                    "setDelegatedEvents" => BatchOp::SetDelegatedEvents {
                        events: next_arg::<A, Vec<String>>(&mut seq, "event types")?,
                    },
                    "setRoot" => BatchOp::SetRoot {
                        id: next_id(&mut seq, "id")?,
                        window_id: seq
                            .next_element::<Option<f64>>()?
                            .flatten()
                            .map(|raw| {
                                raw_element_id(raw)
                                    .and_then(|id| {
                                        u32::try_from(id).map_err(|_| {
                                            format!("windowId {id} exceeds u32::MAX")
                                        })
                                    })
                                    .map_err(serde::de::Error::custom)
                            })
                            .transpose()?
                            .unwrap_or(0),
                    },
                    "setCustomProp" => BatchOp::SetCustomProp {
                        id: next_id(&mut seq, "id")?,
                        key: next_arg::<A, StrArg>(&mut seq, "prop key")?.0.into_owned(),
                        value: next_arg(&mut seq, "custom prop value")?,
                    },
                    "setTheme" => BatchOp::SetTheme {
                        // `emit('setTheme')` and `emit('setTheme', null)`
                        // both mean "retract the app-level declaration" —
                        // a missing arg must not fail the whole batch.
                        value: seq
                            .next_element::<Option<serde_json::Value>>()?
                            .flatten()
                            .unwrap_or(serde_json::Value::Null),
                    },
                    "setClass" => BatchOp::SetClass {
                        id: next_id(&mut seq, "id")?,
                        value: next_arg::<A, StrArg>(&mut seq, "class")?.0.into_owned(),
                    },
                    "requestFrame" => BatchOp::RequestFrame,
                    "stylesheet.register" => BatchOp::RegisterSheet {
                        sheet: next_arg::<A, StrArg>(&mut seq, "sheet")?.0.into_owned(),
                        rules: next_arg::<A, Vec<crate::stylesheet::RuleWire>>(&mut seq, "rules")?
                            .into_iter()
                            .filter_map(crate::stylesheet::Rule::from_wire)
                            .collect(),
                    },
                    "stylesheet.unregister" => BatchOp::UnregisterSheet {
                        sheet: next_arg::<A, StrArg>(&mut seq, "sheet")?.0.into_owned(),
                    },
                    other => {
                        return Err(serde::de::Error::custom(format!(
                            "unknown operation: {other:?}"
                        )))
                    }
                };
                // Trailing arguments are tolerated, as they were when the op was
                // an indexed array.
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(op)
            }

            /// Object-form ops — `{op:'stylesheet.register', sheet, rules}`.
            /// The three stylesheet ops accept it because that is the shape
            /// the contract specifies; legacy ops stay tuple-only.
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<BatchOp<'de>, A::Error> {
                let mut fields = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, serde_json::Value>()? {
                    fields.insert(key, value);
                }
                let name = fields
                    .remove("op")
                    .and_then(|value| value.as_str().map(str::to_string))
                    .ok_or_else(|| serde::de::Error::custom("object-form op missing \"op\""))?;
                fn field<E: serde::de::Error>(
                    fields: &mut serde_json::Map<String, serde_json::Value>,
                    key: &str,
                ) -> std::result::Result<serde_json::Value, E> {
                    fields
                        .remove(key)
                        .ok_or_else(|| E::custom(format!("missing field {key:?}")))
                }
                fn string_field<E: serde::de::Error>(
                    fields: &mut serde_json::Map<String, serde_json::Value>,
                    key: &str,
                ) -> std::result::Result<String, E> {
                    field(fields, key).and_then(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .ok_or_else(|| E::custom(format!("field {key:?} is not a string")))
                    })
                }
                match name.as_str() {
                    "setClass" => {
                        let raw = field(&mut fields, "id")?.as_f64().ok_or_else(|| {
                            serde::de::Error::custom("field \"id\" is not a number")
                        })?;
                        Ok(BatchOp::SetClass {
                            id: raw_element_id(raw).map_err(serde::de::Error::custom)?,
                            value: string_field(&mut fields, "value")?,
                        })
                    }
                    "stylesheet.register" => {
                        let wires: Vec<crate::stylesheet::RuleWire> =
                            serde_json::from_value(field(&mut fields, "rules")?)
                                .map_err(serde::de::Error::custom)?;
                        Ok(BatchOp::RegisterSheet {
                            sheet: string_field(&mut fields, "sheet")?,
                            rules: wires
                                .into_iter()
                                .filter_map(crate::stylesheet::Rule::from_wire)
                                .collect(),
                        })
                    }
                    "stylesheet.unregister" => Ok(BatchOp::UnregisterSheet {
                        sheet: string_field(&mut fields, "sheet")?,
                    }),
                    other => Err(serde::de::Error::custom(format!(
                        "operation {other:?} expects a [op, ...args] tuple"
                    ))),
                }
            }
        }

        deserializer.deserialize_any(V)
    }
}

/// Compile a recipe.js-shaped config: every fragment is authored in the
/// StyleProps vocabulary and gets mapped to native field names through
/// `resolve_style_props` before `Recipe::from_json` sees it. Null fragments
/// (axis-declaration entries) stay null — `merge` already skips them.
fn compile_recipe_config(config: &serde_json::Value) -> serde_json::Value {
    let mut config = config.clone();
    let compile = |fragment: &mut serde_json::Value| {
        if fragment.is_null() {
            return;
        }
        let (map, drops) = crate::style_props::resolve_style_props(fragment);
        if !drops.is_empty() {
            log::debug!("registerRecipe dropped fields {drops:?}");
        }
        *fragment = serde_json::Value::Object(map);
    };
    if let serde_json::Value::Object(map) = &mut config {
        if let Some(base) = map.get_mut("base") {
            compile(base);
        }
        if let Some(serde_json::Value::Object(variants)) = map.get_mut("variants") {
            for entries in variants.values_mut() {
                if let serde_json::Value::Object(entries) = entries {
                    for style in entries.values_mut() {
                        compile(style);
                    }
                }
            }
        }
        if let Some(serde_json::Value::Array(compounds)) = map.get_mut("compoundVariants") {
            for entry in compounds.iter_mut() {
                if let serde_json::Value::Object(entry) = entry {
                    if let Some(style) = entry.get_mut("style") {
                        compile(style);
                    }
                }
            }
        }
    }
    config
}

/// A `setStyleProps`/`setRecipe` extra payload is a single StyleProps object
/// or an ordered array of them. Anything else is malformed, not droppable.
fn check_props_shape(raw: &serde_json::value::RawValue, index: usize, op: &str) -> BatchResult<()> {
    let value: serde_json::Value = serde_json::from_str(raw.get().trim())
        .map_err(|error| format!("Batch op {index} {op} parse error: {error}"))?;
    let ok = match &value {
        serde_json::Value::Object(_) => true,
        serde_json::Value::Array(items) => items.iter().all(|item| item.is_object()),
        _ => false,
    };
    if !ok {
        return Err(format!(
            "Batch op {index}: {op} expects an object or an array of objects"
        ));
    }
    Ok(())
}

/// Validate every style-carrying payload in the batch, in op order.
///
/// This is the last fallible step, so it runs before the apply loop. The
/// borrow checker then proves no element was touched when it returns `Err`,
/// which is what makes a batch atomic. An earlier version interned inside the
/// apply loop, so a malformed style at the end of a batch left everything
/// before it applied and then threw.
///
/// `setStyle` validation is syntax + post-resolution shape: token refs are
/// resolved against the root theme here (any theme would do — resolution can
/// only turn a token into a literal or drop it, so the field shapes it
/// produces are theme-independent). `setStyleProps`/`registerRecipe`
/// payloads are *pre-mapping* — only the container shape can be wrong, since
/// unknown StyleProps keys drop rather than fail.
fn validate_style_payloads(ops: &[BatchOp<'_>]) -> BatchResult<()> {
    for (index, op) in ops.iter().enumerate() {
        match op {
            BatchOp::SetStyle { style, .. } => {
                let mut value: serde_json::Value = serde_json::from_str(style.get().trim())
                    .map_err(|error| format!("Batch op {index} setStyle parse error: {error}"))?;
                ROOT_THEME.with(|t| t.resolve_style(&mut value, None));
                serde_json::from_value::<StyleDesc>(value)
                    .map_err(|error| format!("Batch op {index} setStyle parse error: {error}"))?;
            }
            BatchOp::SetStyleProps {
                props: Some(props), ..
            } => {
                check_props_shape(props, index, "setStyleProps")?;
            }
            BatchOp::SetRecipe {
                extra: Some(extra), ..
            } => {
                check_props_shape(extra, index, "setRecipe")?;
            }
            BatchOp::RegisterRecipe { name, config } => {
                let raw: serde_json::Value =
                    serde_json::from_str(config.get().trim()).map_err(|error| {
                        format!("Batch op {index} registerRecipe parse error: {error}")
                    })?;
                crate::recipe::Recipe::from_json(&compile_recipe_config(&raw)).map_err(
                    |error| format!("Batch op {index} registerRecipe '{name}': {error}"),
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Compose an element's style layers — stylesheet → `setStyle` desc → bound
/// recipe → `setStyleProps` — into one symbolic field map, resolve token refs
/// against the ancestor theme chain, and intern. The stylesheet resolves
/// first so the inline `style` attr and every later layer override it
/// field-wise: inline always wins, which is CSS semantics. Shared by the
/// batch's pending pass and `retheme_subtree`, so a `theme`/`color` swap
/// re-resolves every layer.
/// The symbolic prop map an element's layers resolve to — sheet cascade,
/// `setStyle` payload, recipe, style-props, theme tokens, state buckets.
/// This is the single source for both paint (`resolve_element_layers`
/// interns it into a `StyleDesc`) and the `computedStyle` read path, so
/// introspection can never drift from what renders.
pub(crate) fn merged_symbolic_fields(tree: &RetainedTree, id: u64) -> (serde_json::Value, bool) {
    let Some(element) = tree.elements.get(&id) else {
        return (serde_json::Value::Object(serde_json::Map::new()), false);
    };
    let style_raw = element.style_raw.clone();
    let props_raw = element.props_raw.clone();
    let binding = element.recipe.clone();
    let element_type = element.element_type.clone();
    let is_custom = element_type.starts_with("x-");

    // The stylesheet layer: match registered rules against the live tree —
    // tag/id/classes/attrs on the element, ancestors and siblings for
    // combinator rules — and cascade them into one symbolic map. `state`
    // comps already routed their decls into bucket fields, so what comes
    // back looks like any other layer.
    let sheet_fields = tree.sheets.resolve_fields(tree, id);

    // `had_inputs` is the resolve contract: an element with style inputs
    // always interns a style, even when resolution drops every field —
    // the interned empty StyleDesc is how a cleared layer reads back.
    let had_inputs =
        style_raw.is_some() || props_raw.is_some() || binding.is_some() || !sheet_fields.is_empty();
    if !had_inputs {
        return (serde_json::Value::Object(serde_json::Map::new()), false);
    }

    let (theme, ctx_color) = theme_for_element(tree, id);
    let mut merged = serde_json::Map::new();
    let mut dropped: Vec<String> = Vec::new();

    crate::recipe::merge_fields(&mut merged, &sheet_fields);

    if let Some(raw) = style_raw.as_deref() {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) {
            crate::recipe::merge_fields(&mut merged, &map);
        }
    }
    if let Some(binding) = binding.as_ref() {
        match tree.recipes.get(&*binding.name) {
            Some(recipe) => {
                if let serde_json::Value::Object(map) = recipe
                    .merged_json(&binding.variants, &theme, ctx_color.as_deref())
                    .as_ref()
                {
                    crate::recipe::merge_fields(&mut merged, map);
                }
                if let Some(extra) = binding.extra.as_deref() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(extra) {
                        let (map, drops) = crate::style_props::resolve_style_props(&value);
                        dropped.extend(drops);
                        crate::recipe::merge_fields(&mut merged, &map);
                    }
                }
            }
            None => log::debug!("setRecipe on {id}: unknown recipe '{}'", binding.name),
        }
    }
    if let Some(raw) = props_raw.as_deref() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
            let (map, drops) = crate::style_props::resolve_style_props(&value);
            dropped.extend(drops);
            crate::recipe::merge_fields(&mut merged, &map);
        }
    }

    // s() parity — designTokens.raisedWithBorder: an elevated surface gets
    // the hairline. Authored border fields win (entry().or_insert in the JS
    // original; explicit contains check here reads the same).
    if theme.raised_with_border
        && merged.contains_key("boxShadow")
        && !merged.contains_key("borderWidth")
        && !merged.contains_key("borderColor")
        && ![
            "borderTopWidth",
            "borderRightWidth",
            "borderBottomWidth",
            "borderLeftWidth",
        ]
        .iter()
        .any(|f| merged.contains_key(*f))
    {
        merged.insert("borderWidth".to_string(), serde_json::json!(1));
        merged.insert("borderColor".to_string(), "neutral-muted".into());
    }

    let mut value = serde_json::Value::Object(merged);
    let outcome = theme.resolve_style(&mut value, ctx_color.as_deref());
    dropped.extend(outcome.dropped);
    if !dropped.is_empty() {
        // The audit trail — unresolvable tokens were dropped rather than
        // poisoning the StyleDesc. debug, not warn: bad tokens are a
        // component-authoring signal, not a runtime fault.
        log::debug!("style resolve on {id}: unresolvable fields {dropped:?}");
    }
    // Generic elements bake the state-layer overlay into their hover/active
    // background (svelai ::before → composite). `x-*` elements paint a real
    // overlay child via the recipe path — baking here too would double the
    // overlay's alpha.
    if outcome.state_layer && !is_custom {
        theme.bake_state_layer(&mut value);
    }
    (value, true)
}

fn resolve_element_layers(tree: &mut RetainedTree, id: u64) {
    let had_style = tree
        .elements
        .get(&id)
        .is_some_and(|element| element.style.is_some());
    let (value, had_inputs) = merged_symbolic_fields(tree, id);
    if !had_inputs && !had_style {
        return;
    }
    let resolved = serde_json::to_string(&value).expect("a serde_json::Value re-serializes");
    match tree.styles.intern(resolved.as_bytes()) {
        Ok(shared) => tree.set_style(id, shared),
        Err(error) => log::warn!("style resolve on {id} dropped after resolution: {error}"),
    }
}

// The (theme, ctx color) an element resolves `setStyle` token refs against:
// the root theme folded through every ancestor's `theme` prop from the top
// down, plus the nearest `color` prop (svelai's `data-color` cascade — the
// element's own prop counts like any ancestor's).
thread_local! {
    /// Shared root theme — one `TokenTheme::dark()` per thread instead of
    /// per element per batch. `themed()` memoization keys on `self.id`, so
    /// a fresh `dark()` each time would never hit THEME_MEMO.
    static ROOT_THEME: Arc<crate::tokens::TokenTheme> =
        Arc::new(crate::tokens::TokenTheme::dark());
}

/// The seed both theme cascades start from: ROOT_THEME folded through the
/// tree's `setTheme` declaration. `themed()` memoizes on (theme id, decl
/// hash), so a given decl always yields the same `Arc` — memo keys that
/// compare `Inherited.tokens` by pointer stay valid across frames.
fn root_tokens_for(tree: &RetainedTree) -> Arc<crate::tokens::TokenTheme> {
    let base = ROOT_THEME.with(|t| t.clone());
    match tree
        .theme_decl
        .as_ref()
        .filter(|v| crate::tokens::TokenTheme::is_theme_declaration(v))
    {
        Some(declaration) => base.themed(declaration),
        None => base,
    }
}

fn theme_for_element(
    tree: &RetainedTree,
    id: u64,
) -> (Arc<crate::tokens::TokenTheme>, Option<String>) {
    let mut chain = Vec::new();
    let mut cursor = Some(id);
    while let Some(current) = cursor {
        chain.push(current);
        cursor = tree
            .elements
            .get(&current)
            .and_then(|element| element.parent);
    }
    // The `setTheme` op's declaration is the app-level floor: element-level
    // `theme` props fold on top of it through the normal ancestor cascade.
    let mut theme = root_tokens_for(tree);
    let mut color = None;
    for &ancestor in chain.iter().rev() {
        let Some(element) = tree.elements.get(&ancestor) else {
            continue;
        };
        // Only objects in the designTokens vocabulary cascade — `x-input`/
        // `x-code` reuse `theme` for their own legacy `{caret:…}` shapes.
        if let Some(declaration) = element
            .custom_props
            .get("theme")
            .filter(|v| crate::tokens::TokenTheme::is_theme_declaration(v))
        {
            theme = theme.themed(declaration);
        }
        if let Some(value) = element
            .custom_props
            .get("color")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
        {
            color = Some(value.to_string());
        }
    }
    (theme, color)
}

/// Re-resolve every interned style in `root`'s subtree under the current
/// ancestor chain. Used when a `theme`/`color` custom prop changed or the
/// subtree was reparented. Elements listed in `fresh` already resolved
/// against the final ctx this batch and are skipped.
fn retheme_subtree(tree: &mut RetainedTree, root: u64, fresh: &std::collections::HashSet<u64>) {
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let Some(element) = tree.elements.get(&id) else {
            continue;
        };
        let children: Vec<u64> = element.children.clone();
        // `element.style.is_some()` matters as much as the live inputs: an
        // element whose selector match RETRACTED (ancestor attr removed,
        // reparented out) has no current match but still holds a resolved
        // style — it must re-resolve to drop the stale fields.
        let has_style_layers = element.style.is_some()
            || element.style_raw.is_some()
            || element.props_raw.is_some()
            || element.recipe.is_some()
            || tree.sheets.any_match(&*tree, id);
        stack.extend(children);
        if fresh.contains(&id) || !has_style_layers {
            continue;
        }
        resolve_element_layers(tree, id);
    }
}

/// Apply a batch of mutation tuples to a RetainedTree.
/// Shared between GpuixRenderer::apply_batch and TestGpuixRenderer::apply_batch.
/// Returns accumulated destroyed IDs (as f64) from all destroyElement ops.
///
/// ATOMIC: the batch is decoded and every style is resolved before a single
/// element is touched. If any op is malformed the tree is left unchanged and an
/// error is returned. Nothing after that point can fail, so JS and Rust cannot
/// desync when a batch is retried.
///
/// Batch format: JSON array of tuples [opcode, ...args].
/// See GpuixRenderer::apply_batch for opcode documentation.
///
/// Public so `examples/bench_serde.rs` times this exact function. A replica in
/// the bench would drift, and the numbers would then describe code nobody runs.
/// What a batch changed, beyond the destroyed-id list every caller already
/// consumed. `windows`/`global` drive repaint routing in the multi-window
/// model — a mutation only repaints the window whose root contains the
/// touched element; stylesheet/recipe ops repaint all of them.
pub struct BatchOutcome {
    pub destroyed: Vec<f64>,
    /// Windows whose roots contain a touched element, resolved through root
    /// ancestry (`RetainedTree::window_of`). Destroy/reparent resolutions
    /// happen *before* the op applies — ancestry disappears mid-apply.
    pub windows: std::collections::BTreeSet<u32>,
    /// True when the batch can change every window's paint — stylesheet and
    /// recipe ops resolve globally, not per-root.
    pub global: bool,
}

pub fn apply_batch_to_tree(tree: &mut RetainedTree, bytes: &[u8]) -> BatchResult<BatchOutcome> {
    // Phase 1: decode. No mutation.
    let parsed = parse_batch_ops(bytes)?;

    // Phase 2: validate styles. Syntax + post-resolution shape only; nothing
    // is interned yet because token refs resolve per-element in phase 3.
    validate_style_payloads(&parsed)?;

    // Phase 2b: preflight the structural contract (setRoot's window/element
    // checks) against a shadow of the live tree, so the apply loop below
    // keeps its cannot-fail contract.
    preflight_structural_ops(tree, &parsed)?;

    // Phase 3: apply. Cannot fail. setStyle payloads are only *recorded* —
    // resolution runs after the loop because token refs resolve against the
    // ancestor theme chain, and `create → setStyle → insert` ordering means a
    // fresh element's parent (and its own `theme`/`color` props) may not be
    // linked yet when the op lands.
    let mut outcome = BatchOutcome {
        destroyed: Vec::new(),
        windows: std::collections::BTreeSet::new(),
        global: false,
    };
    // Element ids to resolve post-apply — appended per mutating arm.
    let mut touched: Vec<u64> = Vec::new();
    // Elements whose style layers were touched this batch — resolved in
    // phase 3b once every link and custom prop is in place.
    let mut pending_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Subtrees whose resolved styles may be stale after this batch: a `theme`
    // or `color` prop changed their token ctx, or a reparent moved them under
    // a different ancestor chain. Re-resolved in phase 3c.
    let mut retheme_roots: Vec<u64> = Vec::new();
    for batch_op in parsed {
        match batch_op {
            BatchOp::CreateElement { id, element_type } => {
                tree.create_element(id, element_type);
                // A fresh element may already match stylesheet rules by tag —
                // the root in particular never gets an appendChild retheme.
                pending_ids.insert(id);
            }
            BatchOp::DestroyElement { id } => {
                // The subtree's window loses it — resolve before the
                // ancestry is gone.
                outcome.windows.extend(tree.window_of(id));
                // `+`/`~` selectors see the removed child disappear —
                // re-resolve the surviving siblings' subtree.
                let parent = tree.elements.get(&id).and_then(|element| element.parent);
                let destroyed = tree.destroy_element(id);
                outcome.destroyed.extend(destroyed.iter().map(|&id| id as f64));
                if tree.sheets.has_complex() {
                    if let Some(parent) = parent {
                        retheme_roots.push(parent);
                    }
                }
            }
            BatchOp::AppendChild {
                parent_id,
                child_id,
            } => {
                // Old window loses the subtree, new window gains it.
                outcome.windows.extend(tree.window_of(child_id));
                // With combinator selectors a reparent changes sibling and
                // ancestor matches on BOTH sides — scope the restyle to the
                // old and new parent subtrees instead of the moved subtree.
                let old_parent = tree
                    .elements
                    .get(&child_id)
                    .and_then(|element| element.parent);
                tree.append_child(parent_id, child_id);
                touched.push(parent_id);
                touched.push(child_id);
                if tree.sheets.has_complex() {
                    if let Some(old_parent) = old_parent {
                        retheme_roots.push(old_parent);
                    }
                    retheme_roots.push(parent_id);
                } else {
                    retheme_roots.push(child_id);
                }
            }
            BatchOp::InsertBefore {
                parent_id,
                child_id,
                before_id,
            } => {
                outcome.windows.extend(tree.window_of(child_id));
                let old_parent = tree
                    .elements
                    .get(&child_id)
                    .and_then(|element| element.parent);
                tree.insert_before(parent_id, child_id, before_id);
                touched.push(parent_id);
                touched.push(child_id);
                if tree.sheets.has_complex() {
                    if let Some(old_parent) = old_parent {
                        retheme_roots.push(old_parent);
                    }
                    retheme_roots.push(parent_id);
                } else {
                    retheme_roots.push(child_id);
                }
            }
            BatchOp::MoveBefore {
                parent_id,
                child_id,
                before_id,
            } => {
                // Same routing as the insert ops: the subtree's old window
                // loses it (pre-apply resolution), the new one is collected
                // from `touched` once the final links are in place, and the
                // moved subtree re-resolves its style layers under the new
                // ancestor chain in phase 3c.
                outcome.windows.extend(tree.window_of(child_id));
                let old_parent = tree
                    .elements
                    .get(&child_id)
                    .and_then(|element| element.parent);
                tree.move_before(parent_id, child_id, before_id);
                touched.push(parent_id);
                touched.push(child_id);
                if tree.sheets.has_complex() {
                    if let Some(old_parent) = old_parent {
                        retheme_roots.push(old_parent);
                    }
                    retheme_roots.push(parent_id);
                } else {
                    retheme_roots.push(child_id);
                }
            }
            BatchOp::SetStyle { id, style } => {
                // Byte-identical resends resolve to the same interned style —
                // same fields, no mark, no repaint — so skip the record and
                // the re-resolve entirely. Animation frames resend often.
                let trimmed = style.get().trim();
                let unchanged = tree
                    .elements
                    .get(&id)
                    .is_some_and(|element| element.style_raw.as_deref() == Some(trimmed));
                if !unchanged {
                    // Record the layer now; resolution waits for phase 3b so
                    // the ancestor theme chain is final.
                    tree.set_style_raw(id, trimmed.into());
                    pending_ids.insert(id);
                    touched.push(id);
                }
            }
            BatchOp::SetStyleProps { id, props } => {
                tree.set_props_raw(id, props.map(|raw| raw.get().trim().into()));
                pending_ids.insert(id);
                touched.push(id);
            }
            BatchOp::SetRecipe {
                id,
                name,
                variants,
                extra,
            } => {
                let binding = name.map(|name| crate::retained_tree::RecipeBinding {
                    name: name.into(),
                    variants: variants
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(key, value)| (key, crate::recipe::variant_token(&value)))
                        .collect(),
                    extra: extra.map(|raw| raw.get().trim().into()),
                });
                tree.set_recipe(id, binding);
                pending_ids.insert(id);
                touched.push(id);
            }
            BatchOp::RegisterRecipe { name, config } => {
                outcome.global = true;
                let raw = serde_json::from_str::<serde_json::Value>(config.get().trim())
                    .expect("registerRecipe payload validated in phase 2");
                let recipe = crate::recipe::Recipe::from_json(&compile_recipe_config(&raw))
                    .expect("registerRecipe config validated in phase 2");
                // Elements already bound to this name re-resolve against the
                // new registration in phase 3b.
                for bound in tree.register_recipe(&name, recipe) {
                    pending_ids.insert(bound);
                }
            }
            BatchOp::SetText { id, content } => {
                tree.set_text(id, content);
                touched.push(id);
            }
            BatchOp::SetEventListener {
                id,
                event_type,
                has_handler,
            } => {
                tree.set_event_listener(id, event_type, has_handler);
                touched.push(id);
            }
            BatchOp::SetDelegatedEvents { events } => {
                // Dispatch gates attach at build time — every mounted window
                // repaints so the new set takes effect immediately. Every
                // subtree_revision bumps too: memo scans and memoized views
                // are keyed on it, and a subtree recorded without delegated
                // listeners must never replay after this set lands.
                tree.delegated_events = events.into_iter().collect();
                tree.invalidate_render_caches();
                outcome.windows.extend(tree.roots.keys().copied());
            }
            BatchOp::SetRoot { id, window_id } => {
                // Preflighted in phase 2b — these checks cannot fire unless
                // the shadow diverged from the live tree. Warn + skip rather
                // than `Err`: a mid-apply failure would strand the ops that
                // already landed and the retry lane would double-apply them.
                if !set_root_window_open(window_id) {
                    log::warn!("setRoot: window {window_id} is not open — op skipped");
                    continue;
                }
                if !tree.elements.contains_key(&id) {
                    log::warn!("setRoot: element {id} does not exist — op skipped");
                    continue;
                }
                // Moving a root across windows: unbind the old window so the
                // element isn't rendered as the root of two views at once.
                if let Some((&old_window, _)) =
                    tree.roots.iter().find(|(_, root)| **root == id)
                {
                    if old_window != window_id {
                        tree.roots.remove(&old_window);
                        outcome.windows.insert(old_window);
                    }
                }
                // The replaced root's window repaints to empty; the new
                // root's window paints the fresh subtree. The old subtree is
                // now unreachable — destroy it so its elements don't leak in
                // `tree.elements` (they'd never render or be cleaned up).
                if let Some(old_root) = tree.roots.insert(window_id, id) {
                    let destroyed = tree.destroy_element(old_root);
                    outcome.destroyed.extend(destroyed.iter().map(|&d| d as f64));
                }
                outcome.windows.insert(window_id);
            }
            BatchOp::SetCustomProp { id, key, value } => {
                let changed = tree.set_custom_prop(id, key.clone(), value);
                if changed && matches!(key.as_str(), "theme" | "color") {
                    retheme_roots.push(id);
                }
                // `id` and any `[attr]`-tested prop are stylesheet selector
                // inputs — changing one re-runs matching. With combinators
                // the change also reaches descendants (`[x] .y`) and later
                // siblings, so the restyle scopes to the parent subtree.
                if changed && (key == "id" || tree.sheets.tests_attr(&key)) {
                    pending_ids.insert(id);
                    if tree.sheets.has_complex() {
                        retheme_roots.push(
                            tree.elements
                                .get(&id)
                                .and_then(|element| element.parent)
                                .unwrap_or(id),
                        );
                    }
                }
                touched.push(id);
            }
            BatchOp::SetTheme { value } => {
                let next = if crate::tokens::TokenTheme::is_theme_declaration(&value) {
                    Some(value)
                } else {
                    None
                };
                if tree.theme_decl != next {
                    tree.theme_decl = next;
                    // The declaration seeds every ancestor fold — retheme from
                    // each top-level element (parentless covers window roots
                    // too; `roots` is only the window binding). Elements
                    // created later pick the decl up at resolve time.
                    retheme_roots.extend(
                        tree.elements
                            .iter()
                            .filter(|(_, element)| element.parent.is_none())
                            .map(|(&id, _)| id),
                    );
                    outcome.windows.extend(tree.roots.keys().copied());
                }
            }
            BatchOp::SetClass { id, value } => {
                if tree.set_class(id, &value) {
                    pending_ids.insert(id);
                    // A class flip can change ANCESTOR and preceding-sibling
                    // compounds (`.a .b`, `.a ~ .b`) — scope the restyle to
                    // the parent subtree, which covers all three shapes.
                    if tree.sheets.has_complex() {
                        retheme_roots.push(
                            tree.elements
                                .get(&id)
                                .and_then(|element| element.parent)
                                .unwrap_or(id),
                        );
                    }
                }
                touched.push(id);
            }
            BatchOp::RegisterSheet { sheet, rules } => {
                outcome.global = true;
                // v1 invalidation: class selectors only re-resolve elements
                // carrying classes; a rule with no class comp can match
                // anything, so it re-resolves everything. The replaced rules
                // count too — the elements they styled must drop the stale
                // contribution.
                let mut broad = rules.iter().any(|rule| !rule.requires_class());
                let replaced = tree.sheets.register(&sheet, rules);
                broad |= replaced
                    .iter()
                    .flat_map(|rules| rules.iter())
                    .any(|rule| !rule.requires_class());
                for target in tree.sheet_restyle_targets(broad) {
                    pending_ids.insert(target);
                }
            }
            BatchOp::RequestFrame => {
                // Wake every window hosting a root — each wakes on its own
                // vsync, renders, and emits `frame`; the JS rAF queue ticks
                // on whichever lands first. An occluded window simply never
                // draws, so rAF pauses like a hidden tab's. No roots yet
                // (rAF before mount): the primary window still emits `frame`
                // on its next render, so wake it too.
                if tree.roots.is_empty() {
                    outcome.windows.insert(0);
                } else {
                    outcome.windows.extend(tree.roots.keys().copied());
                }
            }
            BatchOp::UnregisterSheet { sheet } => {
                outcome.global = true;
                if let Some(removed) = tree.sheets.unregister(&sheet) {
                    let broad = removed.iter().any(|rule| !rule.requires_class());
                    for target in tree.sheet_restyle_targets(broad) {
                        pending_ids.insert(target);
                    }
                }
            }
        }
    }

    // Phase 3b: compose and resolve the touched elements' style layers now
    // that every link and custom prop from this batch is in place. Phase 2
    // proved each payload parses, so the re-parses cannot fail; resolution
    // can only drop or literalize fields.
    for id in pending_ids.iter().copied() {
        if tree.elements.contains_key(&id) {
            resolve_element_layers(tree, id);
        }
    }

    // Phase 3c: scoped theme/color changes and reparents. Elements styled in
    // this same batch already resolved against their final ancestors, so they
    // are skipped; everything else in the subtree re-resolves its raw tokens.
    // Sibling appends push one root per child — dedup, then drop any root an
    // ancestor root already covers (its walk reaches the descendant anyway).
    retheme_roots.sort_unstable();
    retheme_roots.dedup();
    {
        let root_set: std::collections::HashSet<u64> = retheme_roots.iter().copied().collect();
        retheme_roots.retain(|&root| {
            let mut cur = tree.elements.get(&root).and_then(|e| e.parent);
            while let Some(id) = cur {
                if root_set.contains(&id) {
                    return false;
                }
                cur = tree.elements.get(&id).and_then(|e| e.parent);
            }
            true
        });
    }
    for root in retheme_roots {
        retheme_subtree(tree, root, &pending_ids);
    }

    // Release styles nothing references any more. Without this a dragged
    // element, which produces a distinct style every frame, would grow the
    // table for as long as the app runs. The element count is what catches the
    // opposite case, a batch that destroyed most of the tree.
    let live_elements = tree.elements.len();
    tree.styles.maybe_sweep(live_elements);

    // Phase 3d: every element-targeting op resolves its owning window *after*
    // the tree has its final shape — reparents within the same batch already
    // landed. Pre-apply resolutions (destroy/reparent-loss, replaced roots)
    // are already in `outcome.windows`.
    for id in touched {
        outcome.windows.extend(tree.window_of(id));
    }

    Ok(outcome)
}

/// Whether a `setRoot` may bind `window_id`. An empty registry means
/// headless/pre-init: only the primary id is legal then. Once any window
/// registers, the map is authoritative and a closed window's id is rejected.
fn set_root_window_open(window_id: u32) -> bool {
    #[cfg(target_os = "macos")]
    {
        WINDOWS.with(|w| {
            let w = w.borrow();
            w.contains_key(&window_id) || (w.is_empty() && window_id == 0)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        window_id == 0
    }
}

/// Phase 2b — preflight the only apply arm that can still reject.
///
/// `setRoot` requires its window open and its element alive *at apply time*:
/// an element created earlier in this batch counts, one destroyed earlier
/// does not. Judging that against `tree.elements` alone is wrong both ways,
/// so the check replays the batch's structural ops against a shadow of the
/// live tree (`live` ids plus `children`/`parent`/`roots` overlays that fall
/// back to the retained tree). Everything else in phase 3 is already total:
/// the tree methods no-op on unknown ids and phase 2 proved the parses.
fn preflight_structural_ops(tree: &RetainedTree, ops: &[BatchOp<'_>]) -> BatchResult<()> {
    // Nothing to check without a setRoot — style churn never builds a shadow.
    if !ops.iter().any(|op| matches!(op, BatchOp::SetRoot { .. })) {
        return Ok(());
    }
    let mut live: HashSet<u64> = tree.elements.keys().copied().collect();
    let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
    let mut parent: HashMap<u64, Option<u64>> = HashMap::new();
    let mut roots: HashMap<u32, u64> = tree.roots.iter().map(|(&w, &r)| (w, r)).collect();

    for (index, op) in ops.iter().enumerate() {
        match op {
            BatchOp::CreateElement { id, .. } => {
                // A re-create replaces the element wholesale — fresh children,
                // no parent. A stale entry in a former parent's child list
                // stays, exactly as the retained tree behaves.
                live.insert(*id);
                children.insert(*id, Vec::new());
                parent.insert(*id, None);
            }
            BatchOp::DestroyElement { id } => {
                shadow_destroy(tree, &mut live, &mut children, &mut parent, &mut roots, *id);
            }
            BatchOp::AppendChild { parent_id, child_id }
            | BatchOp::InsertBefore { parent_id, child_id, .. }
            | BatchOp::MoveBefore { parent_id, child_id, .. } => {
                // Sibling order is irrelevant to liveness — only the edge is.
                if live.contains(child_id) {
                    if let Some(old) = shadow_parent(tree, &parent, *child_id) {
                        let mut siblings = shadow_children(tree, &children, old);
                        siblings.retain(|c| c != child_id);
                        children.insert(old, siblings);
                    }
                    parent.insert(*child_id, Some(*parent_id));
                }
                if live.contains(parent_id) {
                    let mut kids = shadow_children(tree, &children, *parent_id);
                    kids.push(*child_id);
                    children.insert(*parent_id, kids);
                }
            }
            BatchOp::SetRoot { id, window_id } => {
                if !set_root_window_open(*window_id) {
                    return Err(format!("Batch op {index}: setRoot: window {window_id} is not open"));
                }
                if !live.contains(id) {
                    return Err(format!("Batch op {index}: setRoot: element {id} does not exist"));
                }
                // Mirror the apply arm: re-binding `id` unbinds its old
                // window, and the replaced root's subtree is destroyed.
                if let Some((&old_window, _)) = roots.iter().find(|(_, root)| **root == *id) {
                    if old_window != *window_id {
                        roots.remove(&old_window);
                    }
                }
                if let Some(old_root) = roots.insert(*window_id, *id) {
                    shadow_destroy(tree, &mut live, &mut children, &mut parent, &mut roots, old_root);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Shadow `children` lookup: the batch overlay wins, else the retained tree.
fn shadow_children(
    tree: &RetainedTree,
    children: &HashMap<u64, Vec<u64>>,
    id: u64,
) -> Vec<u64> {
    match children.get(&id) {
        Some(kids) => kids.clone(),
        None => tree
            .elements
            .get(&id)
            .map(|element| element.children.clone())
            .unwrap_or_default(),
    }
}

/// Shadow `parent` lookup: an explicit overlay entry wins even when it is
/// `None` (a batch create clears the link), else the retained tree answers.
fn shadow_parent(
    tree: &RetainedTree,
    parent: &HashMap<u64, Option<u64>>,
    id: u64,
) -> Option<u64> {
    match parent.get(&id) {
        Some(entry) => *entry,
        None => tree.elements.get(&id).and_then(|element| element.parent),
    }
}

/// Shadow-tree `destroy_element`: unlink from the parent, remove the whole
/// subtree from `live`, and unbind any roots the cascade takes down.
fn shadow_destroy(
    tree: &RetainedTree,
    live: &mut HashSet<u64>,
    children: &mut HashMap<u64, Vec<u64>>,
    parent: &mut HashMap<u64, Option<u64>>,
    roots: &mut HashMap<u32, u64>,
    id: u64,
) {
    if !live.remove(&id) {
        return; // destroying a dead id is a no-op, same as the real tree
    }
    if let Some(parent_id) = shadow_parent(tree, parent, id) {
        let mut siblings = shadow_children(tree, children, parent_id);
        siblings.retain(|c| *c != id);
        children.insert(parent_id, siblings);
    }
    let mut stack = vec![id];
    let mut destroyed = vec![id];
    while let Some(current) = stack.pop() {
        for child in shadow_children(tree, children, current) {
            if live.remove(&child) {
                stack.push(child);
                destroyed.push(child);
            }
        }
        children.remove(&current);
        parent.remove(&current);
    }
    roots.retain(|_, root| !destroyed.contains(root));
}

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Default)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct EdgeInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Debug, Clone, Default)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct WindowInsets {
    pub safe_area: EdgeInsets,
    pub ime: EdgeInsets,
    pub effective: EdgeInsets,
}

impl WindowInsets {
    fn from_gpui(insets: gpui::WindowInsets) -> Self {
        let effective = insets.effective();
        Self {
            safe_area: EdgeInsets::from_gpui(insets.safe_area),
            ime: EdgeInsets::from_gpui(insets.ime),
            effective: EdgeInsets::from_gpui(effective),
        }
    }
}

impl EdgeInsets {
    fn from_gpui(insets: gpui::Edges<gpui::Pixels>) -> Self {
        Self {
            top: f32::from(insets.top) as f64,
            right: f32::from(insets.right) as f64,
            bottom: f32::from(insets.bottom) as f64,
            left: f32::from(insets.left) as f64,
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn edge_insets_js(
    insets: gpui::Edges<gpui::Pixels>,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    let object = js_sys::Object::new();
    for (key, value) in [
        ("top", insets.top),
        ("right", insets.right),
        ("bottom", insets.bottom),
        ("left", insets.left),
    ] {
        js_sys::Reflect::set(
            &object,
            &wasm_bindgen::JsValue::from_str(key),
            &wasm_bindgen::JsValue::from_f64(f32::from(value) as f64),
        )?;
    }
    Ok(object.into())
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn window_insets_js(
    insets: gpui::WindowInsets,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    let effective = insets.effective();
    let object = js_sys::Object::new();
    for (key, value) in [
        ("safeArea", edge_insets_js(insets.safe_area)?),
        ("ime", edge_insets_js(insets.ime)?),
        ("effective", edge_insets_js(effective)?),
    ] {
        js_sys::Reflect::set(&object, &wasm_bindgen::JsValue::from_str(key), &value)?;
    }
    Ok(object.into())
}

/// Last painted box for a host element.
#[derive(Debug, Clone)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct ElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ElementBounds {
    pub(crate) fn from_painted(bounds: crate::automation::ElementBounds) -> Self {
        Self {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn element_bounds_js(
    bounds: crate::automation::ElementBounds,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    let object = js_sys::Object::new();
    for (key, value) in [
        ("x", bounds.x),
        ("y", bounds.y),
        ("width", bounds.width),
        ("height", bounds.height),
    ] {
        js_sys::Reflect::set(
            &object,
            &wasm_bindgen::JsValue::from_str(key),
            &wasm_bindgen::JsValue::from_f64(value),
        )?;
    }
    Ok(object.into())
}

/// Recorded draw times from the debug frame overlay.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[derive(Debug, Clone)]
#[napi(object)]
pub struct DebugFrameOverlayStats {
    pub current_ms: Option<f64>,
    pub p90_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub frames: f64,
    pub samples: f64,
}

/// Wayland `wlr-layer-shell` surface options. Linux/Wayland only; ignored on
/// every other platform. When present on `WindowOptions`, the window is opened
/// as a compositor-anchored surface (a bar, dock, notification overlay or
/// wallpaper) with no native titlebar instead of a normal floating window.
/// `width` / `height` then only constrain the axis the surface is not
/// stretched along by its `anchor`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct LayerShellOptions {
    /// Compositor surface namespace, used for window rules. Cannot be changed
    /// after the surface is created. Defaults to the empty string.
    pub namespace: Option<String>,
    /// `"background"` | `"bottom"` | `"top"` | `"overlay"`. Defaults to `"top"`.
    pub layer: Option<String>,
    /// Screen edges to anchor to: any combination of `"top"`, `"bottom"`,
    /// `"left"`, `"right"`. Anchoring two opposite edges stretches the surface
    /// across that axis. Defaults to `["top", "left", "right"]` (a top bar).
    pub anchor: Option<Vec<String>>,
    /// Logical pixels to reserve along the anchored edge so other windows do
    /// not overlap the surface. `0` lets the compositor decide, a negative
    /// value asks it not to reserve any space.
    pub exclusive_zone: Option<f64>,
    /// Which edge the exclusive zone applies to when it cannot be inferred from
    /// a single-edge `anchor`. Same values as one `anchor` entry.
    pub exclusive_edge: Option<String>,
    /// Gap between the surface and its anchor edge(s), in CSS order:
    /// `[top, right, bottom, left]`. Must have exactly four entries or it is
    /// ignored.
    pub margin: Option<Vec<f64>>,
    /// `"none"` | `"on-demand"` | `"exclusive"`. Defaults to `"none"`: a bar or
    /// overlay that never takes keyboard focus.
    pub keyboard_interactivity: Option<String>,
}

#[derive(Debug, Clone)]
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
pub struct WindowOptions {
    pub title: Option<String>,
    /// The name used inside the macOS "Hide" and "Quit" menu items. Defaults to
    /// `title`. It does NOT set the title of the application menu itself: macOS
    /// takes that from the executable, and only a `.app` bundle changes it.
    pub app_name: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub resizable: Option<bool>,
    pub fullscreen: Option<bool>,
    /// Plain alpha transparency. Prefer `window_background` when you need blur.
    pub transparent: Option<bool>,
    /// Hide the native titlebar so the app can draw chrome under the traffic lights.
    pub titlebar_transparent: Option<bool>,
    /// Claim the whole content view as app-owned titlebar content (macOS):
    /// AppKit neither auto-drags from the titlebar strip nor delays strip
    /// clicks disambiguating double-clicks. Elements opt into moving the
    /// window with the `windowDrag` prop (`data-window-drag` attribute).
    pub app_owns_titlebar_drag: Option<bool>,
    /// `"opaque"` | `"transparent"` | `"blurred"`. `transparent: true` is the
    /// same as `"transparent"` when this is unset.
    pub window_background: Option<String>,
    pub traffic_light_x: Option<f64>,
    pub traffic_light_y: Option<f64>,
    /// Give the window key focus when it opens. `false` opens it behind the
    /// active app, like `open -g`. Ignored on Linux.
    pub focus: Option<bool>,
    /// Show the window when it opens. `false` opens it hidden; call
    /// `activateWindow()` to reveal it. Ignored on Linux.
    pub show: Option<bool>,
    /// Application id: Wayland `app_id` / X11 `WM_CLASS`. Desktop environments
    /// use it to group windows and match window rules. Required in practice for
    /// a `layerShell` surface a compositor is meant to target by rule.
    pub app_id: Option<String>,
    /// Open the window as a Wayland `wlr-layer-shell` surface instead of a
    /// normal window. Linux/Wayland only; ignored elsewhere.
    pub layer_shell: Option<LayerShellOptions>,
}

impl Default for WindowOptions {
    fn default() -> Self {
        Self {
            title: Some("GPUIX".to_string()),
            app_name: None,
            width: Some(800.0),
            height: Some(600.0),
            min_width: None,
            min_height: None,
            resizable: Some(true),
            fullscreen: Some(false),
            transparent: Some(false),
            titlebar_transparent: Some(false),
            app_owns_titlebar_drag: Some(false),
            window_background: None,
            traffic_light_x: None,
            traffic_light_y: None,
            focus: Some(true),
            show: Some(true),
            app_id: None,
            layer_shell: None,
        }
    }
}

#[cfg(target_os = "linux")]
fn layer_shell_anchor_bit(name: &str) -> gpui::layer_shell::Anchor {
    use gpui::layer_shell::Anchor;
    match name.trim().to_ascii_lowercase().as_str() {
        "top" => Anchor::TOP,
        "bottom" => Anchor::BOTTOM,
        "left" => Anchor::LEFT,
        "right" => Anchor::RIGHT,
        _ => Anchor::empty(),
    }
}

#[cfg(target_os = "linux")]
fn to_layer_shell_options(options: &LayerShellOptions) -> gpui::layer_shell::LayerShellOptions {
    use gpui::layer_shell::{Anchor, KeyboardInteractivity, Layer};

    let layer = match options.layer.as_deref() {
        Some("background") => Layer::Background,
        Some("bottom") => Layer::Bottom,
        Some("overlay") => Layer::Overlay,
        _ => Layer::Top,
    };
    let anchor = match options.anchor.as_deref() {
        Some(names) if !names.is_empty() => names.iter().fold(Anchor::empty(), |acc, name| {
            acc | layer_shell_anchor_bit(name)
        }),
        _ => Anchor::TOP | Anchor::LEFT | Anchor::RIGHT,
    };
    let keyboard_interactivity = match options.keyboard_interactivity.as_deref() {
        Some("on-demand") => KeyboardInteractivity::OnDemand,
        Some("exclusive") => KeyboardInteractivity::Exclusive,
        _ => KeyboardInteractivity::None,
    };
    let margin = options.margin.as_ref().and_then(|m| match m.as_slice() {
        [top, right, bottom, left] => Some((
            gpui::px(*top as f32),
            gpui::px(*right as f32),
            gpui::px(*bottom as f32),
            gpui::px(*left as f32),
        )),
        _ => None,
    });

    gpui::layer_shell::LayerShellOptions {
        namespace: options.namespace.clone().unwrap_or_default(),
        layer,
        anchor,
        exclusive_zone: options.exclusive_zone.map(|z| gpui::px(z as f32)),
        exclusive_edge: options
            .exclusive_edge
            .as_deref()
            .map(layer_shell_anchor_bit),
        margin,
        keyboard_interactivity,
    }
}

fn to_gpui_window_options(
    options: &WindowOptions,
    bounds: gpui::Bounds<gpui::Pixels>,
) -> gpui::WindowOptions {
    let title = options.title.clone().unwrap_or_else(|| "GPUIX".to_string());
    let titlebar_transparent = options.titlebar_transparent.unwrap_or(false);
    let traffic_light_position = match (options.traffic_light_x, options.traffic_light_y) {
        (Some(x), Some(y)) => Some(gpui::point(gpui::px(x as f32), gpui::px(y as f32))),
        _ => None,
    };
    let window_background = match options.window_background.as_deref() {
        Some("transparent") => gpui::WindowBackgroundAppearance::Transparent,
        Some("blurred") => gpui::WindowBackgroundAppearance::Blurred,
        Some("opaque") => gpui::WindowBackgroundAppearance::Opaque,
        _ if options.transparent.unwrap_or(false) => gpui::WindowBackgroundAppearance::Transparent,
        _ => gpui::WindowBackgroundAppearance::Opaque,
    };
    let window_min_size = match (options.min_width, options.min_height) {
        (Some(width), Some(height)) => {
            Some(gpui::size(gpui::px(width as f32), gpui::px(height as f32)))
        }
        _ => None,
    };
    let window_bounds = if options.fullscreen.unwrap_or(false) {
        gpui::WindowBounds::Fullscreen(bounds)
    } else {
        gpui::WindowBounds::Windowed(bounds)
    };
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut gpui_options = gpui::WindowOptions {
        window_bounds: Some(window_bounds),
        titlebar: Some(gpui::TitlebarOptions {
            title: Some(title.into()),
            appears_transparent: titlebar_transparent,
            traffic_light_position,
        }),
        app_owns_titlebar_drag: options.app_owns_titlebar_drag.unwrap_or(false),
        is_resizable: options.resizable.unwrap_or(true),
        window_background,
        window_min_size,
        focus: options.focus.unwrap_or(true),
        show: options.show.unwrap_or(true),
        app_id: options.app_id.clone(),
        ..Default::default()
    };

    // A layer-shell surface has no titlebar and is placed by the compositor
    // from its anchor, not by `window_bounds.origin`. The `WindowKind` variant
    // only exists on a Wayland-enabled Linux gpui build.
    #[cfg(target_os = "linux")]
    if let Some(layer_shell) = &options.layer_shell {
        gpui_options.titlebar = None;
        gpui_options.kind = gpui::WindowKind::LayerShell(to_layer_shell_options(layer_shell));
    }

    gpui_options
}

#[cfg(test)]
mod highlight_cache_tests {
    use super::*;

    fn tree_with_text() -> RetainedTree {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".to_string());
        tree.create_element(2, "text".to_string());
        tree.append_child(1, 2);
        tree.set_text(2, "a fox and a fox".to_string());
        tree
    }

    fn query(text: &str) -> serde_json::Value {
        serde_json::json!({ "query": text })
    }

    fn declare(tree: &mut RetainedTree, value: &serde_json::Value) {
        tree.set_custom_prop(1, "highlight".to_string(), value.clone());
    }

    /// The whole reason `search_revision` exists. `highlight` is a custom prop,
    /// so keying the group list on `subtree_revision` means every keystroke
    /// re-walks and re-folds the subtree. The pointer comparison is the proof;
    /// a timing budget over a realistic app is far too coarse to catch it.
    #[test]
    fn a_query_change_reuses_the_group_list() {
        let theme = Theme::dark();
        let mut tree = tree_with_text();
        let mut cache = HashMap::new();

        declare(&mut tree, &query("f"));
        resolve_highlight(&mut cache, &tree, 1, &query("f"), &theme, false).expect("resolves");
        let first = Arc::as_ptr(&cache[&1].groups);

        declare(&mut tree, &query("fo"));
        resolve_highlight(&mut cache, &tree, 1, &query("fo"), &theme, false).expect("resolves");
        assert_eq!(
            Arc::as_ptr(&cache[&1].groups),
            first,
            "a query change must not rebuild the group list"
        );
    }

    /// Moving a find cursor changes no text and no matcher, so it must re-use
    /// the located matches. Colours and ordinals are decided at paint.
    #[test]
    fn a_cursor_move_reuses_the_located_matches() {
        let theme = Theme::dark();
        let mut tree = tree_with_text();
        let mut cache = HashMap::new();
        let spec = |active: u64| serde_json::json!({ "query": "fox", "activeIndex": active });

        declare(&mut tree, &spec(0));
        resolve_highlight(&mut cache, &tree, 1, &spec(0), &theme, true).expect("resolves");
        let matches = Arc::as_ptr(&cache[&1].context.matches);

        declare(&mut tree, &spec(1));
        let (context, changed) =
            resolve_highlight(&mut cache, &tree, 1, &spec(1), &theme, true).expect("resolves");
        assert_eq!(Arc::as_ptr(&context.matches), matches, "no rescan");
        assert_eq!(changed, None, "a cursor move is not a new result");
        assert_eq!(
            context.set.specs[0].active_index,
            Some(1),
            "spec still swapped"
        );
    }

    /// Editing the text must invalidate, or the wash paints over stale offsets.
    #[test]
    fn a_text_change_rebuilds_the_group_list() {
        let theme = Theme::dark();
        let mut tree = tree_with_text();
        let mut cache = HashMap::new();

        declare(&mut tree, &query("fox"));
        resolve_highlight(&mut cache, &tree, 1, &query("fox"), &theme, true).expect("resolves");
        let first = Arc::as_ptr(&cache[&1].groups);

        tree.set_text(2, "one fox only".to_string());
        let (_, changed) =
            resolve_highlight(&mut cache, &tree, 1, &query("fox"), &theme, true).expect("resolves");
        assert_ne!(Arc::as_ptr(&cache[&1].groups), first);
        assert_eq!(changed, Some(1), "two matches became one");
    }

    /// A review caught this: `reported` used to be written even with no
    /// listener, so mounting without `onHighlight` and adding it later reported
    /// nothing, forever.
    #[test]
    fn adding_the_listener_later_still_reports() {
        let theme = Theme::dark();
        let mut tree = tree_with_text();
        let mut cache = HashMap::new();

        declare(&mut tree, &query("fox"));
        let (_, changed) = resolve_highlight(&mut cache, &tree, 1, &query("fox"), &theme, false)
            .expect("resolves");
        assert_eq!(changed, None, "nothing to report without a listener");

        let (_, changed) =
            resolve_highlight(&mut cache, &tree, 1, &query("fox"), &theme, true).expect("resolves");
        assert_eq!(changed, Some(2), "the listener gets the current count");

        let (_, changed) =
            resolve_highlight(&mut cache, &tree, 1, &query("fox"), &theme, true).expect("resolves");
        assert_eq!(changed, None, "and only once");
    }
}

/// The `applyBatch` protocol. This is the surface JS talks to, so every rule it
/// relies on is asserted here against real JSON bytes rather than through a
/// hand-built `Vec<BatchOp>`.
#[cfg(test)]
mod batch_tests {
    use super::*;

    fn apply(tree: &mut RetainedTree, json: &str) -> BatchResult<Vec<f64>> {
        apply_batch_to_tree(tree, json.as_bytes()).map(|outcome| outcome.destroyed)
    }

    /// Everything a mutation can reach, so an unwanted partial apply shows up
    /// as a diff instead of hiding in a field the test forgot to read.
    fn describe(tree: &RetainedTree) -> String {
        let mut ids: Vec<_> = tree.elements.keys().copied().collect();
        ids.sort_unstable();
        let mut out = format!("root={:?} sheets={}\n", tree.root_id(), tree.sheets.len());
        for id in ids {
            let element = &tree.elements[&id];
            let mut events: Vec<_> = element.events.iter().cloned().collect();
            events.sort();
            let mut props: Vec<_> = element.custom_props.iter().collect();
            props.sort_by(|(a, _), (b, _)| a.cmp(b));
            out += &format!(
                "{id} type={} classes={:?} text={:?} style={:?} children={:?} parent={:?} events={events:?} props={props:?} rev={}/{}\n",
                element.element_type,
                element.classes,
                element.content,
                element.style.as_deref(),
                element.children,
                element.parent,
                element.subtree_revision,
                element.search_revision,
            );
        }
        out
    }

    /// The regression test for batch atomicity. `intern_style_payload` used to
    /// run inside the apply loop, so this batch created the element, set its
    /// text, and only then threw — leaving JS to retry against a tree that had
    /// already moved.
    #[test]
    fn a_malformed_style_applies_nothing_at_all() {
        let mut tree = RetainedTree::new();
        apply(&mut tree, r#"[["createElement",1,"div"],["setRoot",1]]"#).expect("valid batch");
        let before = describe(&tree);
        let styles_before = tree.styles.len();

        let error = apply(
            &mut tree,
            r#"[["createElement",2,"div"],["setText",2,"changed"],["setStyle",2,123]]"#,
        )
        .expect_err("a malformed style must reject the batch");

        assert_eq!(describe(&tree), before, "the tree must be untouched");
        assert_eq!(
            tree.styles.len(),
            styles_before,
            "the failed batch must not leave styles interned"
        );
        assert!(error.contains("setStyle"), "{error}");
    }

    /// A style that fails halfway through a long batch is unfindable without
    /// its index; serde reports a byte offset, which names nothing.
    #[test]
    fn a_style_error_names_its_op_index() {
        let mut tree = RetainedTree::new();
        let error = apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setStyle",1,{"color":"red"}],["setStyle",1,{"color":5}]]"#,
        )
        .expect_err("a bad style rejects the batch");
        assert!(
            error.starts_with("Batch op 2 setStyle parse error:"),
            "{error}"
        );
    }

    /// `null` is not "no style". Treating it as `{}` would silently clear every
    /// declared property instead of telling JS it sent something wrong.
    #[test]
    fn a_null_style_is_an_error() {
        let mut tree = RetainedTree::new();
        let error = apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setStyle",1,null]]"#,
        )
        .expect_err("null is not a style");
        assert!(
            error.contains("Batch op 1 setStyle parse error:"),
            "{error}"
        );
        assert!(tree.elements.is_empty(), "and the batch stays atomic");
    }

    /// Skipping an unknown opcode would let a JS/Rust version skew desync the
    /// tree quietly. It has to throw.
    #[test]
    fn an_unknown_opcode_is_an_error() {
        let mut tree = RetainedTree::new();
        let error = apply(&mut tree, r#"[["teleportElement",1]]"#).expect_err("unknown opcode");
        assert!(error.contains("unknown operation"), "{error}");
        assert!(tree.elements.is_empty());
    }

    /// Every op that takes an id must validate it. A fractional or oversized id
    /// would truncate into a *different* element, which is a silent desync.
    #[test]
    fn an_invalid_id_is_rejected_in_every_id_position() {
        let templates = [
            r#"[["createElement",ID,"div"]]"#,
            r#"[["destroyElement",ID]]"#,
            r#"[["appendChild",ID,2]]"#,
            r#"[["appendChild",1,ID]]"#,
            r#"[["insertBefore",ID,2,3]]"#,
            r#"[["insertBefore",1,ID,3]]"#,
            r#"[["insertBefore",1,2,ID]]"#,
            r#"[["setStyle",ID,{}]]"#,
            r#"[["setText",ID,"x"]]"#,
            r#"[["setEventListener",ID,"click",true]]"#,
            r#"[["setRoot",ID]]"#,
            r#"[["setCustomProp",ID,"k",1]]"#,
        ];
        // 1e999 overflows f64, 9007199254740992 is Number.MAX_SAFE_INTEGER + 1.
        let bad_ids = ["-1", "1.5", "9007199254740992", "1e999"];

        for template in templates {
            for bad in bad_ids {
                let json = template.replace("ID", bad);
                let mut tree = RetainedTree::new();
                let error = apply(&mut tree, &json).expect_err(&format!("{json} must be rejected"));
                assert!(error.contains("Batch op 0"), "{json}: {error}");
                assert!(tree.elements.is_empty(), "{json} mutated the tree");
                assert_eq!(tree.root_id(), None, "{json} mutated the root");
            }
        }
    }

    #[test]
    fn has_handler_requires_a_bool() {
        for (payload, expected) in [("true", true), ("false", false)] {
            let mut tree = RetainedTree::new();
            let json =
                format!(r#"[["createElement",1,"div"],["setEventListener",1,"click",{payload}]]"#);
            apply(&mut tree, &json).expect("boolean handler state");
            assert_eq!(
                tree.elements[&1].events.contains("click"),
                expected,
                "hasHandler {payload}"
            );
        }

        for payload in ["0", "1", "0.5", r#""true""#] {
            let mut tree = RetainedTree::new();
            let json =
                format!(r#"[["createElement",1,"div"],["setEventListener",1,"click",{payload}]]"#);
            apply(&mut tree, &json).expect_err(&format!("hasHandler {payload} is not a boolean"));
        }
    }

    #[test]
    fn a_malformed_op_tuple_is_an_error() {
        let cases = [
            (r#"[42]"#, "a non-array op"),
            (r#"[["createElement",1]]"#, "a missing argument"),
            (r#"[[7,1,"div"]]"#, "a non-string op name"),
        ];
        for (json, what) in cases {
            let mut tree = RetainedTree::new();
            let error = apply(&mut tree, json).expect_err(what);
            assert!(
                error.starts_with("Failed to parse batch:"),
                "{what}: {error}"
            );
            assert!(tree.elements.is_empty(), "{what} mutated the tree");
        }
    }

    /// Interning keys on raw bytes, so re-ordered keys are two `Arc`s. They are
    /// still the same style, and a repaint per key order would be a real cost
    /// on any app that builds style objects conditionally.
    #[test]
    fn a_reordered_style_does_not_repaint() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setStyle",1,{"color":"red","left":10}]]"#,
        )
        .expect("valid batch");
        let revision = tree.elements[&1].subtree_revision;

        apply(&mut tree, r#"[["setStyle",1,{"left":10,"color":"red"}]]"#).expect("valid batch");
        assert_eq!(
            tree.elements[&1].subtree_revision, revision,
            "the same style in another key order is not a change"
        );
    }

    /// Three ways an interned style loses its last element reference.
    #[test]
    fn a_style_is_released_when_nothing_references_it() {
        let mut tree = RetainedTree::new();
        apply(&mut tree, r#"[["createElement",1,"div"]]"#).expect("valid batch");

        // Set on an id that does not exist: nothing keeps the style alive.
        apply(&mut tree, r#"[["setStyle",99,{"color":"red"}]]"#).expect("missing ids are ignored");
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 0, "a style nobody took must be released");

        apply(&mut tree, r#"[["setStyle",1,{"color":"red"}]]"#).expect("valid batch");
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 1);

        // Replaced.
        apply(&mut tree, r#"[["setStyle",1,{"color":"blue"}]]"#).expect("valid batch");
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 1, "the replaced style must be released");

        // Destroyed.
        apply(&mut tree, r#"[["destroyElement",1]]"#).expect("valid batch");
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 0);
    }

    /// `setStyleProps` ships the raw StyleProps vocabulary — Rust maps it to
    /// fields and resolves the tokens. `md`/`xl` are spacing-scale names on
    /// the dark theme (8/16px), `primary` a palette color.
    #[test]
    fn style_props_map_and_resolve_natively() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setStyleProps",1,{"p":"md","bg":"primary"}]]"#,
        )
        .expect("valid batch");
        let style = tree.elements[&1]
            .style
            .as_deref()
            .expect("a style resolved");
        assert_eq!(style.padding_top, Some(8.0));
        assert_eq!(style.padding_left, Some(8.0));
        assert_eq!(style.background_color.as_deref(), Some("#5f62ef"));
        // The raw props survive for retheme, mapped fields are not stored.
        assert_eq!(
            tree.elements[&1].props_raw.as_deref(),
            Some(r#"{"p":"md","bg":"primary"}"#)
        );
    }

    /// The StyleX rule, natively: fragments apply in array order, so a later
    /// longhand beats an earlier shorthand — and a later shorthand beats an
    /// earlier longhand.
    #[test]
    fn style_props_fragments_apply_in_order() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setStyleProps",1,[{"p":"md"},{"pl":"xl"}]]]"#,
        )
        .expect("valid batch");
        let style = tree.elements[&1].style.as_deref().unwrap();
        assert_eq!(style.padding_top, Some(8.0));
        assert_eq!(style.padding_left, Some(16.0), "later longhand wins");

        apply(
            &mut tree,
            r#"[["setStyleProps",1,[{"pl":"xl"},{"p":"md"}]]]"#,
        )
        .expect("valid batch");
        let style = tree.elements[&1].style.as_deref().unwrap();
        assert_eq!(style.padding_left, Some(8.0), "later shorthand wins");
    }

    /// `registerRecipe` compiles the StyleProps fragments once; `setRecipe`
    /// then ships only the variant tuple and Rust resolves natively.
    #[test]
    fn recipe_resolves_from_variant_names() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["registerRecipe","btn",{
                    "base": {"p":"sm"},
                    "variants": {
                        "variant": {
                            "primary": {"bg":"primary"},
                            "danger": {"bg":"danger"}
                        }
                    },
                    "defaultVariants": {"variant":"primary"}
                }],
                ["createElement",1,"div"],
                ["setRecipe",1,"btn"]
            ]"#,
        )
        .expect("valid batch");
        let style = tree.elements[&1].style.as_deref().unwrap();
        assert_eq!(style.padding_top, Some(6.0));
        assert_eq!(
            style.background_color.as_deref(),
            Some("#5f62ef"),
            "default variant"
        );

        apply(&mut tree, r#"[["setRecipe",1,"btn",{"variant":"danger"}]]"#).expect("valid batch");
        let style = tree.elements[&1].style.as_deref().unwrap();
        assert_eq!(style.background_color.as_deref(), Some("#dc2626"));
        // The props layer composes over the recipe layer.
        apply(&mut tree, r#"[["setStyleProps",1,{"bg":"success"}]]"#).expect("valid batch");
        let style = tree.elements[&1].style.as_deref().unwrap();
        assert_eq!(
            style.background_color.as_deref(),
            Some("#15803d"),
            "the props layer wins over the recipe layer"
        );
        // Unbinding keeps the props layer.
        apply(&mut tree, r#"[["setRecipe",1,null]]"#).expect("valid batch");
        let style = tree.elements[&1].style.as_deref().unwrap();
        assert_eq!(style.background_color.as_deref(), Some("#15803d"));
        assert_eq!(style.padding_top, None, "the recipe base is gone");
    }

    /// A `theme` custom prop re-resolves every retained layer — props and
    /// recipe bindings included, not just `setStyle` payloads.
    #[test]
    fn retheme_resolves_props_and_recipe_layers() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["registerRecipe","btn",{"variants":{"v":{"a":{"bg":"primary"}}},"defaultVariants":{"v":"a"}}],
                ["createElement",1,"div"],
                ["createElement",2,"div"],["appendChild",1,2],
                ["setRecipe",2,"btn"],
                ["setStyleProps",2,{"fg":"neutral"}]
            ]"#,
        )
        .expect("valid batch");
        let style = tree.elements[&2].style.as_deref().unwrap();
        assert_eq!(
            style.background_color.as_deref(),
            Some("#5f62ef"),
            "dark primary"
        );

        apply(
            &mut tree,
            r##"[["setCustomProp",1,"theme",{"palette":{"primary":{"base":"#ff0000"}}}]]"##,
        )
        .expect("valid batch");
        let style = tree.elements[&2].style.as_deref().unwrap();
        assert_eq!(
            style.background_color.as_deref(),
            Some("#ff0000"),
            "the recipe layer re-resolved under the scoped theme"
        );
    }

    /// `setTheme` stores the declaration on the tree — elements resolve it
    /// without any element carrying a `theme` prop, including elements
    /// created before the op arrived. Element-level props still fold on top.
    #[test]
    fn set_theme_seeds_the_ancestor_fold() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["registerRecipe","btn",{"variants":{"v":{"a":{"bg":"primary"}}},"defaultVariants":{"v":"a"}}],
                ["createElement",1,"div"],
                ["createElement",2,"div"],["appendChild",1,2],
                ["setRecipe",2,"btn"]
            ]"#,
        )
        .expect("valid batch");
        assert_eq!(
            tree.elements[&2].style.as_deref().unwrap().background_color.as_deref(),
            Some("#5f62ef"),
            "dark primary baseline"
        );

        // The op lands after the elements exist — retheme covers them.
        apply(&mut tree, r##"[["setTheme",{"palette":{"primary":{"base":"#ff0000"}}}]]"##)
            .expect("valid batch");
        assert_eq!(
            tree.elements[&2].style.as_deref().unwrap().background_color.as_deref(),
            Some("#ff0000"),
            "retheme across the whole tree"
        );

        // Elements created later resolve against the stored declaration.
        apply(
            &mut tree,
            r#"[["createElement",3,"div"],["appendChild",1,3],["setRecipe",3,"btn"]]"#,
        )
        .expect("valid batch");
        assert_eq!(
            tree.elements[&3].style.as_deref().unwrap().background_color.as_deref(),
            Some("#ff0000"),
            "created after setTheme"
        );

        // An element-level `theme` prop still folds over the app decl — the
        // scoped <Theme> lane is unaffected.
        apply(
            &mut tree,
            r##"[["setCustomProp",1,"theme",{"palette":{"primary":{"base":"#0000ff"}}}]]"##,
        )
        .expect("valid batch");
        assert_eq!(
            tree.elements[&2].style.as_deref().unwrap().background_color.as_deref(),
            Some("#0000ff"),
            "scoped prop wins over the app decl"
        );

        // Clearing the prop falls back to the app declaration.
        apply(&mut tree, r#"[["setCustomProp",1,"theme",null]]"#).expect("valid batch");
        assert_eq!(
            tree.elements[&2].style.as_deref().unwrap().background_color.as_deref(),
            Some("#ff0000"),
            "back to the app decl"
        );
    }

    /// `moveBefore` reparents a live subtree: the element keeps its id, its
    /// children and its style layers — nothing is destroyed or recreated.
    #[test]
    fn move_before_reparents_a_live_subtree() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],
                ["createElement",3,"div"],["createElement",4,"text"],["setText",4,"x"],
                ["appendChild",3,4],
                ["appendChild",1,2],["appendChild",2,3],["setRoot",1]
            ]"#,
        )
        .expect("valid batch");
        let parent_revisions: Vec<u64> = [1, 2]
            .iter()
            .map(|id| tree.elements[id].subtree_revision)
            .collect();

        let outcome = apply_batch_to_tree(
            &mut tree,
            r#"[["moveBefore",1,3,null]]"#.as_bytes(),
        )
        .expect("a reparent applies");
        assert_eq!(outcome.destroyed, Vec::<f64>::new(), "no destroy ops");
        assert_eq!(tree.elements[&3].parent, Some(1), "reparented under 1");
        assert_eq!(tree.elements[&1].children, vec![2, 3], "moved to the end");
        assert_eq!(tree.elements[&2].children, Vec::<u64>::new());
        // The subtree moved with it — same element, same children.
        assert_eq!(tree.elements[&3].children, vec![4]);
        assert_eq!(tree.elements[&4].content.as_deref(), Some("x"));
        // Both parents' chains invalidate; the moved subtree's own revision
        // is untouched — its content didn't change, so memoized paint
        // survives the move.
        for (id, before) in [1, 2].iter().zip(parent_revisions) {
            assert!(
                tree.elements[id].subtree_revision > before,
                "parent {id} must repaint after losing/gaining a child"
            );
        }
    }

    /// A `moveBefore` whose anchor names a sibling reorders within the same
    /// parent; a missing/null anchor moves to the end.
    #[test]
    fn move_before_reorders_within_a_parent() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["appendChild",1,2],["appendChild",1,3],["setRoot",1]
            ]"#,
        )
        .expect("valid batch");

        apply(&mut tree, r#"[["moveBefore",1,3,2]]"#).expect("reorder");
        assert_eq!(tree.elements[&1].children, vec![3, 2]);

        // No anchor arg at all — the tuple can end at the child id.
        apply(&mut tree, r#"[["moveBefore",1,3]]"#).expect("reorder to end");
        assert_eq!(tree.elements[&1].children, vec![2, 3]);
    }

    /// The insert ops tolerate an unknown child by linking a dangling id; a
    /// move of a dead id is a protocol slip and must no-op instead.
    #[test]
    fn move_before_on_a_dead_child_links_nothing() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setRoot",1]]"#,
        )
        .expect("valid batch");
        apply(&mut tree, r#"[["moveBefore",1,99]]"#).expect("dead moves no-op");
        assert_eq!(tree.elements[&1].children, Vec::<u64>::new());
        assert!(!tree.elements.contains_key(&99));
    }

    /// A reparent across window roots repaints both: the old window loses
    /// the subtree, the new one gains it.
    #[test]
    fn move_before_repaints_both_windows() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["appendChild",1,3]
            ]"#,
        )
        .expect("valid batch");
        // Bound directly — `setRoot` only accepts window 0 headless.
        tree.roots.insert(0, 1);
        tree.roots.insert(7, 2);

        let outcome = apply_batch_to_tree(&mut tree, r#"[["moveBefore",2,3,null]]"#.as_bytes())
            .expect("cross-window reparent");
        assert!(
            outcome.windows.contains(&0) && outcome.windows.contains(&7),
            "both windows repaint: {:?}",
            outcome.windows
        );
        assert_eq!(tree.elements[&3].parent, Some(2));
        assert_eq!(tree.window_of(3), Some(7));
    }

    /// Phase 3c covers `moveBefore` too: a subtree reparented under a scoped
    /// `theme` prop re-resolves its retained style layers against the new
    /// ancestor chain.
    #[test]
    fn move_before_rethemes_under_the_new_ancestors() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r##"[
                ["createElement",1,"div"],["createElement",2,"div"],
                ["createElement",3,"div"],["setStyleProps",3,{"bg":"primary"}],
                ["appendChild",1,3],["setRoot",1],
                ["setCustomProp",2,"theme",{"palette":{"primary":{"base":"#ff0000"}}}],
                ["appendChild",1,2]
            ]"##,
        )
        .expect("valid batch");
        assert_eq!(
            tree.elements[&3].style.as_deref().unwrap().background_color.as_deref(),
            Some("#5f62ef"),
            "dark primary before the move"
        );

        apply(&mut tree, r#"[["moveBefore",2,3,null]]"#).expect("reparent under the themed host");
        assert_eq!(
            tree.elements[&3].style.as_deref().unwrap().background_color.as_deref(),
            Some("#ff0000"),
            "re-resolved under the new ancestor's scoped theme"
        );
    }

    /// `requestFrame` marks every root-hosting window for repaint — the next
    /// render emits the `frame` event the JS rAF queue ticks on.
    #[test]
    fn request_frame_wakes_every_root_window() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],
                ["appendChild",1,2],["setRoot",1]
            ]"#,
        )
        .expect("valid batch");
        tree.roots.insert(7, 9); // a second window binding, element-less is fine here

        let outcome = apply_batch_to_tree(&mut tree, r#"[["requestFrame"]]"#.as_bytes())
            .expect("requestFrame batch");
        assert_eq!(
            outcome.windows.iter().copied().collect::<Vec<_>>(),
            vec![0, 7],
            "every root-hosting window wakes: {:?}",
            outcome.windows
        );

        // No roots yet (rAF before mount): the primary window still wakes —
        // its next render emits `frame` and the queue ticks.
        let mut bare = RetainedTree::new();
        let outcome = apply_batch_to_tree(&mut bare, r#"[["requestFrame"]]"#.as_bytes())
            .expect("requestFrame on a rootless tree");
        assert_eq!(
            outcome.windows.iter().copied().collect::<Vec<_>>(),
            vec![0],
            "rootless tree wakes the primary window: {:?}",
            outcome.windows
        );
    }
}

#[cfg(test)]
mod window_options_tests {
    use super::*;

    fn mapped(options: WindowOptions) -> gpui::WindowOptions {
        let bounds = gpui::Bounds {
            origin: gpui::point(gpui::px(0.0), gpui::px(0.0)),
            size: gpui::size(gpui::px(800.0), gpui::px(600.0)),
        };
        to_gpui_window_options(&options, bounds)
    }

    #[test]
    fn defaults_open_a_focused_visible_window() {
        let gpui_options = mapped(WindowOptions::default());
        assert!(gpui_options.focus);
        assert!(gpui_options.show);
    }

    #[test]
    fn unset_focus_and_show_still_default_to_true() {
        let gpui_options = mapped(WindowOptions {
            focus: None,
            show: None,
            ..WindowOptions::default()
        });
        assert!(gpui_options.focus);
        assert!(gpui_options.show);
    }

    #[test]
    fn focus_false_leaves_the_window_visible() {
        let gpui_options = mapped(WindowOptions {
            focus: Some(false),
            ..WindowOptions::default()
        });
        assert!(!gpui_options.focus);
        assert!(gpui_options.show);
    }

    #[test]
    fn show_false_keeps_focus_independent() {
        let gpui_options = mapped(WindowOptions {
            show: Some(false),
            ..WindowOptions::default()
        });
        assert!(!gpui_options.show);
        assert!(gpui_options.focus);
    }

    #[test]
    fn existing_options_are_still_mapped() {
        let gpui_options = mapped(WindowOptions {
            title: Some("Background".to_string()),
            resizable: Some(false),
            window_background: Some("blurred".to_string()),
            min_width: Some(320.0),
            min_height: Some(240.0),
            focus: Some(false),
            ..WindowOptions::default()
        });
        let titlebar = gpui_options.titlebar.expect("titlebar options");
        assert_eq!(titlebar.title.as_deref(), Some("Background"));
        assert!(!gpui_options.is_resizable);
        assert_eq!(
            gpui_options.window_background,
            gpui::WindowBackgroundAppearance::Blurred
        );
        assert_eq!(
            gpui_options.window_min_size,
            Some(gpui::size(gpui::px(320.0), gpui::px(240.0)))
        );
    }

    #[test]
    fn app_id_is_forwarded() {
        let gpui_options = mapped(WindowOptions {
            app_id: Some("kite-panel".to_string()),
            ..WindowOptions::default()
        });
        assert_eq!(gpui_options.app_id.as_deref(), Some("kite-panel"));
    }

    #[test]
    fn without_layer_shell_the_window_is_normal_with_a_titlebar() {
        let gpui_options = mapped(WindowOptions::default());
        assert_eq!(gpui_options.kind, gpui::WindowKind::Normal);
        assert!(gpui_options.titlebar.is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn layer_shell_options_map_to_a_layer_shell_window_kind() {
        use gpui::layer_shell::{Anchor, KeyboardInteractivity, Layer};

        let gpui_options = mapped(WindowOptions {
            app_id: Some("kite-panel".to_string()),
            layer_shell: Some(LayerShellOptions {
                namespace: Some("kite-panel".to_string()),
                layer: Some("top".to_string()),
                anchor: Some(vec![
                    "top".to_string(),
                    "left".to_string(),
                    "right".to_string(),
                ]),
                exclusive_zone: Some(34.0),
                exclusive_edge: Some("top".to_string()),
                margin: Some(vec![0.0, 0.0, 0.0, 0.0]),
                keyboard_interactivity: Some("none".to_string()),
            }),
            ..WindowOptions::default()
        });

        assert!(gpui_options.titlebar.is_none());
        match gpui_options.kind {
            gpui::WindowKind::LayerShell(opts) => {
                assert_eq!(opts.namespace, "kite-panel");
                assert_eq!(opts.layer, Layer::Top);
                assert_eq!(opts.anchor, Anchor::TOP | Anchor::LEFT | Anchor::RIGHT);
                assert_eq!(opts.exclusive_zone, Some(gpui::px(34.0)));
                assert_eq!(opts.exclusive_edge, Some(Anchor::TOP));
                assert_eq!(
                    opts.margin,
                    Some((gpui::px(0.0), gpui::px(0.0), gpui::px(0.0), gpui::px(0.0)))
                );
                assert_eq!(opts.keyboard_interactivity, KeyboardInteractivity::None);
            }
            other => panic!("expected a layer-shell window kind, got {other:?}"),
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn layer_shell_anchor_defaults_to_a_top_bar() {
        use gpui::layer_shell::Anchor;

        let gpui_options = mapped(WindowOptions {
            layer_shell: Some(LayerShellOptions::default()),
            ..WindowOptions::default()
        });
        match gpui_options.kind {
            gpui::WindowKind::LayerShell(opts) => {
                assert_eq!(opts.anchor, Anchor::TOP | Anchor::LEFT | Anchor::RIGHT);
            }
            other => panic!("expected a layer-shell window kind, got {other:?}"),
        }
    }
}
