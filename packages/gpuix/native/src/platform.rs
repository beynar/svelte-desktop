//! Brokered platform services: one `platformCall` napi entry point that
//! dispatches `{service, op, args}` requests to the GPUI platform layer.
//!
//! Contract (JSON over napi, see gpuix-poc/src/native-api):
//!   request:  {"id": <u64>, "service": "clipboard", "op": "writeText", "args": {...}}
//!   reply:    {"ok": true, "value": <any>}
//!          |  {"ok": false, "error": {"code": <str>, "message": <str>}}
//!          |  {"pending": true, "id": <u64>}   — async op; the real result is
//!             emitted later as a `platformResult` event carrying `id`.
//!
//! Error codes: invalid_args | unknown | unsupported | unavailable | denied |
//! internal. `unsupported` means the op is not implementable on this OS through
//! the current backend; `unavailable` means it exists but the runtime pre-
//! condition failed (no window, app not initialized, empty clipboard).
//!
//! Dispatch runs on the GPUI UI thread. On macOS the renderer is embedded so
//! the napi thread *is* the UI thread; on Windows/Linux `platform_call` hops
//! through `UiCommand::PlatformCall` into `run_ui_commands`. Async results are
//! spawned on the foreground executor and reported through the EventCallback
//! (`platformResult`), never by blocking the UI loop.

use std::cell::RefCell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;

use gpui::{
    Action, App, ClipboardItem, Menu, MenuItem, PromptButton, PromptLevel, SharedString,
    SystemNotification, SystemNotificationAction, Window, WindowAppearance, WindowBounds,
};
use serde_json::{json, Value};

use crate::element_tree::EventPayload;
use crate::renderer::{EventCallback, GpuixView};
#[cfg(target_os = "macos")]
use crate::renderer::{NEXT_WINDOW_ID, RENDERER_STATE, WINDOWS};
#[cfg(target_os = "macos")]
use crate::text::SharedSelection;

mod capture_ext;
mod events_ext;
mod hotkeys;
mod macos_ext;
mod menu_ext;
mod permissions;
mod power_ext;
mod tray;
mod window_ext;

/// element_id sentinel for platform events/results. Well above any element id
/// JS will allocate; `dispatchPayload` routes it to the platform bus.
pub const PLATFORM_EVENT_ID: f64 = 0x7fff_ff02 as f64;

/// App-lifetime baseline for diagnostics uptime.
static STARTED_AT: OnceLock<Instant> = OnceLock::new();


/// EventCallback captured at init so app-level events (openUrls, reopen, …)
/// can reach JS even when no window update is in flight.
static EVENT_SINK: Mutex<Option<EventCallback>> = Mutex::new(None);

pub fn set_event_sink(callback: Option<EventCallback>) {
    *EVENT_SINK.lock().unwrap_or_else(|p| p.into_inner()) = callback;
}

fn sink() -> Option<EventCallback> {
    EVENT_SINK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Push a platform event to JS. `data` rides the EventPayload `data` field.
pub fn emit_event(event: &str, data: Value) {
    if let Some(callback) = sink() {
        callback(EventPayload {
            element_id: PLATFORM_EVENT_ID,
            event_type: format!("platform:{event}"),
            data: Some(data),
            ..Default::default()
        });
    }
}

/// Stream a message to a `Channel` the caller attached as
/// `args.channel` (serialized `__channel__:<id>`). No-op without one —
/// ops use it for progress/incremental events without a bespoke name.
pub(crate) fn emit_channel(request: &PlatformRequest, value: Value) {
    if let Some(channel) = request
        .args
        .get("channel")
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix("__channel__:").map(str::to_string))
    {
        emit_event(
            "channelMessage",
            json!({ "channel": channel, "value": value }),
        );
    }
}

/// Finish an async op: emit `platformResult` carrying the call id.
fn resolve_pending(id: u64, result: Result<Value, PlatformError>) {
    emit_event(
        "platformResult",
        match result {
            Ok(value) => json!({"id": id, "ok": true, "value": value}),
            Err(error) => json!({"id": id, "ok": false, "error": error}),
        },
    );
}

#[derive(Debug)]
pub struct PlatformError {
    pub code: &'static str,
    pub message: String,
}

impl PlatformError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_args",
            message: message.into(),
        }
    }
    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "unsupported",
            message: message.into(),
        }
    }
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "unavailable",
            message: message.into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal",
            message: message.into(),
        }
    }
}

impl serde::Serialize for PlatformError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = s.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code)?;
        map.serialize_entry("message", &self.message)?;
        map.end()
    }
}

type OpResult = Result<Value, PlatformError>;

fn ok(value: Value) -> OpResult {
    Ok(value)
}

fn err<T>(error: PlatformError) -> Result<T, PlatformError> {
    Err(error)
}

/// What dispatch decided for this call.
pub enum Outcome {
    /// Immediate JSON reply for `platform_call`.
    Now(String),
    /// Reply `{pending:true,id}` now; the real result lands on `platformResult`.
    Pending,
}

impl Outcome {
    fn json(self, id: u64) -> String {
        match self {
            Outcome::Now(s) => s,
            Outcome::Pending => json!({"pending": true, "id": id}).to_string(),
        }
    }
}

fn reply(result: OpResult) -> Outcome {
    Outcome::Now(match result {
        Ok(value) => json!({"ok": true, "value": value}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    })
}

// ── Shared helpers for extension modules ─────────────────────────────

/// Run `f` with the live view + window, or answer `unavailable` when no
/// window is open. Shared by every window-scoped extension module.
pub(crate) fn with_window<R>(
    view_window: Option<(&mut GpuixView, &mut Window)>,
    op: &str,
    f: impl FnOnce(&mut GpuixView, &mut Window) -> R,
) -> Result<R, PlatformError> {
    match view_window {
        Some((view, window)) => Ok(f(view, window)),
        None => err(PlatformError::unavailable(format!(
            "window.{op}: no window is open"
        ))),
    }
}

/// The backing `NSWindow` for a gpui `Window`. raw-window-handle exposes
/// the NSView; the window comes back from `[view window]`. `None` on
/// non-AppKit backends — callers translate it to `unsupported`.
#[cfg(target_os = "macos")]
pub(crate) fn nswindow(window: &Window) -> Option<cocoa::base::id> {
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    // The inherent `Window::window_handle` returns gpui's AnyWindowHandle —
    // call the trait impl explicitly.
    let raw = HasWindowHandle::window_handle(window).ok()?.as_raw();
    match raw {
        RawWindowHandle::AppKit(handle) => {
            let ns_view = handle.ns_view.as_ptr() as cocoa::base::id;
            let ns_window: cocoa::base::id = unsafe { msg_send![ns_view, window] };
            (ns_window != cocoa::base::nil).then_some(ns_window)
        }
        _ => None,
    }
}

/// Retained `NSString` (+1) — convenience for extension modules. Callers
/// either send `release` after use or send `autorelease` immediately when
/// the string must outlive the call site in AppKit's hands.
fn prompt_filters(request: &PlatformRequest) -> Vec<gpui::PathPromptFilter> {
    request
        .args
        .get("filters")
        .and_then(Value::as_array)
        .map(|filters| {
            filters
                .iter()
                .filter_map(|f| {
                    let extensions = f
                        .get("extensions")
                        .and_then(Value::as_array)?
                        .iter()
                        .filter_map(|e| e.as_str().map(SharedString::from))
                        .collect::<Vec<_>>();
                    if extensions.is_empty() {
                        return None;
                    }
                    Some(gpui::PathPromptFilter {
                        name: f
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Files")
                            .into(),
                        extensions,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
pub(crate) fn nsstring(value: &str) -> cocoa::base::id {
    use cocoa::foundation::NSString;
    unsafe { NSString::alloc(cocoa::base::nil).init_str(value) }
}

// ── Request shape ───────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct PlatformRequest {
    pub id: u64,
    pub service: String,
    pub op: String,
    #[serde(default)]
    pub args: Value,
}

impl PlatformRequest {
    pub fn parse(json: &str) -> Result<Self, PlatformError> {
        serde_json::from_str(json)
            .map_err(|e| PlatformError::invalid(format!("malformed platform request: {e}")))
    }

    fn arg(&self, key: &str) -> Result<&Value, PlatformError> {
        self.args.get(key).ok_or_else(|| {
            PlatformError::invalid(format!(
                "{}.{}: missing argument `{key}`",
                self.service, self.op
            ))
        })
    }

    fn str_arg(&self, key: &str) -> Result<String, PlatformError> {
        self.arg(key)?.as_str().map(str::to_string).ok_or_else(|| {
            PlatformError::invalid(format!(
                "{}.{}: `{key}` must be a string",
                self.service, self.op
            ))
        })
    }

    fn opt_str(&self, key: &str) -> Option<String> {
        self.args
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn bool_arg(&self, key: &str) -> Result<bool, PlatformError> {
        self.arg(key)?.as_bool().ok_or_else(|| {
            PlatformError::invalid(format!(
                "{}.{}: `{key}` must be a boolean",
                self.service, self.op
            ))
        })
    }

    fn opt_bool(&self, key: &str) -> Option<bool> {
        self.args.get(key).and_then(Value::as_bool)
    }

    /// Finite f64 — NaN/±∞ must never reach AppKit frame/size/cursor APIs
    /// (they can throw uncatchable Objective-C exceptions). JSON can carry
    /// infinity (`1e999` parses to `inf`), so the check lives at the trust
    /// boundary here.
    fn f64_arg(&self, key: &str) -> Result<f64, PlatformError> {
        let value = self.arg(key)?.as_f64().ok_or_else(|| {
            PlatformError::invalid(format!(
                "{}.{}: `{key}` must be a number",
                self.service, self.op
            ))
        })?;
        if !value.is_finite() {
            return Err(PlatformError::invalid(format!(
                "{}.{}: `{key}` must be a finite number",
                self.service, self.op
            )));
        }
        Ok(value)
    }

    /// Optional number — absent/non-numeric → `Ok(None)`, present but
    /// non-finite → `invalid_args` (same AppKit safety rule as f64_arg).
    fn opt_f64(&self, key: &str) -> Result<Option<f64>, PlatformError> {
        match self.args.get(key).and_then(Value::as_f64) {
            Some(v) if !v.is_finite() => Err(PlatformError::invalid(format!(
                "{}.{}: `{key}` must be a finite number",
                self.service, self.op
            ))),
            other => Ok(other),
        }
    }
}

// ── App-level callback registration ─────────────────────────────────
// Called once inside the GPUI `run`/`run_embedded` closure on both OS
// architectures. Subscriptions must outlive the app: they are stashed in a
// thread-local that lives as long as the UI thread itself.

thread_local! {
    static APP_SUBSCRIPTIONS: RefCell<Vec<gpui::Subscription>> = const { RefCell::new(Vec::new()) };
}

fn keep(subscription: gpui::Subscription) {
    APP_SUBSCRIPTIONS.with(|subs| subs.borrow_mut().push(subscription));
}

/// Launch-level callbacks live on `Application` (they can fire before the
/// app finishes launching). Call on the `Application` before `run`/`run_embedded`.
pub fn register_launch_callbacks(app: &gpui::Application) {
    app.on_open_urls(|urls| emit_event("openUrls", json!({"urls": urls})));
    app.on_reopen(|_cx| emit_event("reopened", json!({})));
}

/// Wire every app-level platform callback we surface to JS. Call while `cx`
/// is `&mut App` inside the platform run closure.
pub fn register_app_callbacks(cx: &mut App) {
    keep(cx.on_system_wake(|_cx| emit_event("systemWake", json!({}))));
    keep(cx.on_thermal_state_change(|_cx| emit_event("thermalStateChanged", json!({}))));
    keep(cx.on_keyboard_layout_change(|_cx| emit_event("keyboardLayoutChanged", json!({}))));
    cx.on_system_notification_response(|response, _cx| {
        emit_event(
            "notificationResponse",
            json!({
                "tag": response.tag.to_string(),
                "actionId": response.action_id.map(|id| id.to_string()),
            }),
        );
    });
    keep(cx.on_app_quit(|_cx| async {
        emit_event("willQuit", json!({}));
    }));
    keep(cx.on_app_restart(|_cx| emit_event("willRestart", json!({}))));
    // OS-level observers that need no App handle (notifications, Carbon
    // hotkey handler, display reconfiguration).
    power_ext::register();
    hotkeys::register();
    events_ext::register(cx);
}

/// Attach window-lifetime observers to a freshly opened window. The
/// subscription lives on the view so it dies with the window.
pub fn observe_window(handle: &gpui::WindowHandle<GpuixView>, cx: &mut App) {
    let _ = handle.update(cx, |view, window, _cx| {
        let window_id = view.window_id;
        view.platform_subscriptions
            .push(window.observe_window_appearance(move |window, _cx| {
                let mut data = theme::appearance_json(window.appearance());
                data["windowId"] = json!(window_id);
                emit_event("appearanceChanged", data);
            }));
        // One event for both moves and resizes — JS diffs the full bounds.
        view.platform_subscriptions
            .push(window.observe_window_bounds(move |window, _cx| {
                let bounds = window.bounds();
                emit_event(
                    "boundsChanged",
                    json!({
                        "windowId": window_id,
                        "x": f64::from(bounds.origin.x),
                        "y": f64::from(bounds.origin.y),
                        "width": f64::from(bounds.size.width),
                        "height": f64::from(bounds.size.height),
                    }),
                );
            }));
        window.on_window_should_close(_cx, move |_window, _cx| {
            // Armed via window.setCloseVeto — suppresses OS-initiated closes
            // (red button, ⌘W) and asks JS to decide. Programmatic
            // window.close() calls remove_window() directly and bypasses this.
            let veto = WINDOWS.with(|windows| {
                windows
                    .borrow()
                    .get(&window_id)
                    .map(|entry| entry.close_veto.get())
                    .unwrap_or(false)
            });
            if veto {
                emit_event("willClose", json!({ "windowId": window_id }));
                false
            } else {
                true
            }
        });
        events_ext::observe_window(view, window);
    });
}

// ── Dispatch ────────────────────────────────────────────────────────

/// Entry point used by both OS paths. Callers hold an open `Window::update`
/// when a window exists — `view_window` carries those live refs so dispatch
/// never re-enters `update` (a nested borrow would panic). It is `None` when
/// no window is open; window-scoped ops then report `unavailable`.
pub fn dispatch(
    request: &PlatformRequest,
    view_window: Option<(&mut GpuixView, &mut Window)>,
    cx: &mut App,
) -> String {
    let id = request.id;
    let outcome = match request.service.as_str() {
        "app" => reply(app::call(request, cx)),
        "window" => match request.op.as_str() {
            // App-scoped ops — act through the window registry, so they
            // work with zero windows open and never need `view_window`.
            "create" | "list" | "get" => {
                reply(window_svc::call_app(request, view_window, cx))
            }
            _ => reply(window_svc::call(request, view_window)),
        },
        "screen" => reply(screen::call(request, view_window, cx)),
        "clipboard" => reply(clipboard::call(request, cx)),
        "shell" => reply(shell::call(request, cx)),
        "dialog" => dialog::call(request, view_window, cx),
        "theme" => reply(theme::call(request, cx)),
        "system" => match request.op.as_str() {
            "checkPermission" | "requestPermission" | "openSettings" => {
                permissions::call(request, cx)
            }
            _ => reply(system::call(request, cx)),
        },
        "power" => reply(power::call(request, cx)),
        "secureStorage" => match request.op.as_str() {
            "authenticate" => permissions::call_secure(request, cx),
            _ => secure_storage::call(request, cx),
        },
        "notifications" => notifications::call(request, cx),
        "deepLink" => deep_link::call(request, cx),
        "menu" => match request.op.as_str() {
            // Nested AppKit tracking loop — resolves on the pending lane,
            // outside the AppCell borrow (see macos_ext::popup).
            "popup" => macos_ext::call_popup(request, cx),
            _ => reply(menu::call(request, cx)),
        },
        "capture" => capture_ext::call(request, cx),
        "diagnostics" => reply(diagnostics::call(request)),
        "capabilities" => reply(capabilities::call(request)),
        "tray" => reply(tray::call(request, cx)),
        "shortcuts" => reply(hotkeys::call(request, cx)),
        // Known-but-not-yet surfaces: answer typed `unsupported`, never panic.
        "singleInstance" | "autostart" | "permissions" | "resources" | "protocol"
        | "windowState" | "dock" | "accessibility" => {
            reply(err(PlatformError::unsupported(format!(
                "{}.{} is not implemented in this build",
                request.service, request.op
            ))))
        }
        other => reply(err(PlatformError {
            code: "unknown",
            message: format!("unknown platform service `{other}`"),
        })),
    };
    outcome.json(id)
}

// ── app ─────────────────────────────────────────────────────────────

mod app {
    use super::*;

    /// App identity: env-var seed at first read, `setIdentity`/`setName`
    /// override afterwards. Packaged apps should set these from the bundle
    /// manifest instead of env.
    fn identity() -> std::sync::MutexGuard<'static, (String, String, String)> {
        static IDENTITY: OnceLock<Mutex<(String, String, String)>> = OnceLock::new();
        IDENTITY
            .get_or_init(|| {
                Mutex::new((
                    std::env::var("GPUIX_BUNDLE_ID").unwrap_or_else(|_| "ai.gpuix.app".into()),
                    std::env::var("GPUIX_APP_NAME").unwrap_or_else(|_| "gpuix-app".into()),
                    std::env::var("GPUIX_APP_VERSION")
                        .unwrap_or_else(|_| env!("CARGO_PKG_VERSION").into()),
                ))
            })
            .lock()
            .unwrap()
    }

    fn bundle_id() -> String {
        identity().0.clone()
    }

    fn app_name() -> String {
        identity().1.clone()
    }

    fn app_version() -> String {
        identity().2.clone()
    }

    /// Named-path table. userData/appData scope to the bundle id so a renamed
    /// app cannot scribble over another app's directory.
    fn get_path(name: &str, cx: &App) -> OpResult {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let under_home =
            |suffix: &str| -> Option<PathBuf> { home.as_ref().map(|h| h.join(suffix)) };
        let id = bundle_id();
        let path: Option<PathBuf> = match name {
            "home" => home,
            "appPath" => Some(
                cx.app_path()
                    .map_err(|e| PlatformError::internal(e.to_string()))?,
            ),
            "exe" | "module" => std::env::current_exe().ok(),
            "temp" => Some(std::env::temp_dir()),
            "appData" => under_home(&format!("Library/Application Support/{id}")),
            "userData" => under_home(&format!("Library/Application Support/{id}")),
            "logs" => under_home(&format!("Library/Logs/{id}")),
            "caches" => under_home(&format!("Library/Caches/{id}")),
            "documents" => under_home("Documents"),
            "downloads" => under_home("Downloads"),
            "desktop" => under_home("Desktop"),
            "music" => under_home("Music"),
            "pictures" => under_home("Pictures"),
            "videos" => under_home("Movies"),
            _ => {
                return err(PlatformError::invalid(format!(
                    "unknown app path `{name}` — expected home|appPath|exe|temp|appData|userData|logs|caches|documents|downloads|desktop|music|pictures|videos"
                )))
            }
        };
        match path {
            Some(path) => ok(json!(path.to_string_lossy())),
            None => err(PlatformError::unavailable(format!(
                "could not resolve path `{name}`"
            ))),
        }
    }

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "getInfo" => ok(json!({
                "name": app_name(),
                "version": app_version(),
                "identifier": bundle_id(),
                "appPath": cx.app_path().ok().map(|p| p.to_string_lossy().to_string()),
                "packaged": cx
                    .app_path()
                    .map(|p| p.extension().map(|e| e == "app").unwrap_or(false))
                    .unwrap_or(false),
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            })),
            "getName" => ok(json!(app_name())),
            "getVersion" => ok(json!(app_version())),
            "getPath" => get_path(&request.str_arg("name")?, cx),
            "quit" => {
                cx.quit();
                ok(Value::Null)
            }
            "relaunch" => {
                cx.restart();
                ok(Value::Null)
            }
            "exit" => {
                let code = request
                    .args
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                std::process::exit(code as i32);
            }
            "hide" => {
                cx.hide();
                ok(Value::Null)
            }
            "show" | "activate" => {
                cx.activate(request.opt_bool("ignoringOtherApps").unwrap_or(true));
                ok(Value::Null)
            }
            "hideOthers" => {
                cx.hide_other_apps();
                ok(Value::Null)
            }
            "showAll" => {
                cx.unhide_other_apps();
                ok(Value::Null)
            }
            "setName" => {
                let name = request.str_arg("name")?;
                identity().1 = name.clone();
                cx.set_app_identity(&bundle_id(), &name);
                ok(Value::Null)
            }
            "setIdentity" => {
                let identifier = request.str_arg("identifier")?;
                let name = request.opt_str("name").unwrap_or_else(app_name);
                {
                    let mut id = identity();
                    id.0 = identifier.clone();
                    id.1 = name.clone();
                }
                cx.set_app_identity(&identifier, &name);
                ok(Value::Null)
            }
            "addRecentDocument" => {
                let path = request.str_arg("path")?;
                cx.add_recent_document(Path::new(&path));
                ok(Value::Null)
            }
            "clearRecentDocuments" => err(PlatformError::unsupported(
                "clearing the recent-documents list is not exposed by the GPUI platform layer",
            )),
            "setDockBadge"
            | "bounceDock"
            | "setLoginItem"
            | "setActivationPolicy"
            | "requestSingleInstanceLock" => macos_ext::call(request, cx),
            "setDockProgress" | "getBundleType" | "defaultWindowIcon" => {
                window_ext::call_app(request, cx)
            }
            "aboutPanel" => menu_ext::call(request, cx),
            "whenReady" => ok(json!(true)),
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown app op `{op}`"),
            }),
        }
    }
}

// ── window ──────────────────────────────────────────────────────────

mod window_svc {
    use super::*;
    use gpui::AppContext as _;

    fn window_bounds_json(bounds: WindowBounds) -> (Value, &'static str) {
        match bounds {
            WindowBounds::Windowed(b) => (bounds_json(&b), "normal"),
            WindowBounds::Maximized(b) => (bounds_json(&b), "maximized"),
            WindowBounds::Fullscreen(b) => (bounds_json(&b), "fullscreen"),
        }
    }

    fn bounds_json(b: &gpui::Bounds<gpui::Pixels>) -> Value {
        json!({
            "x": f32::from(b.origin.x),
            "y": f32::from(b.origin.y),
            "width": f32::from(b.size.width),
            "height": f32::from(b.size.height),
        })
    }

    fn with_window<R>(
        view_window: Option<(&mut GpuixView, &mut Window)>,
        op: &str,
        f: impl FnOnce(&mut GpuixView, &mut Window) -> R,
    ) -> Result<R, PlatformError> {
        match view_window {
            Some((view, window)) => Ok(f(view, window)),
            None => err(PlatformError::unavailable(format!(
                "window.{op}: no window is open"
            ))),
        }
    }

    pub fn call(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
    ) -> OpResult {
        let op = request.op.as_str();
        match op {
            "getBounds" => with_window(view_window, op, |_v, window| {
                let (bounds, state) = window_bounds_json(window.window_bounds());
                ok(json!({"bounds": bounds, "state": state}))
            })?,
            "getSize" | "getContentSize" => with_window(view_window, op, |_v, window| {
                let size = window.viewport_size();
                ok(json!({"width": f32::from(size.width), "height": f32::from(size.height)}))
            })?,
            "setSize" => with_window(view_window, op, |_v, window| {
                let width = request.f64_arg("width")?;
                let height = request.f64_arg("height")?;
                #[cfg(target_os = "macos")]
                {
                    // `window.resize` spawns setContentSize: on the executor —
                    // the op would return before it lands, and a follow-on
                    // positionTo/setPosition would read the stale frame.
                    // Apply it synchronously like set_bounds does.
                    #[allow(unused_imports)]
                    use objc::{sel, sel_impl};
                    let ns_window = crate::platform::window_ext::require_nswindow(
                        window, "setSize",
                    )?;
                    unsafe {
                        let _: () = objc::msg_send![ns_window, setContentSize:
                            cocoa::foundation::NSSize::new(width, height)];
                    }
                }
                #[cfg(not(target_os = "macos"))]
                window.resize(gpui::size(
                    gpui::px(width as f32),
                    gpui::px(height as f32),
                ));
                ok(Value::Null)
            })?,
            "getPosition" => with_window(view_window, op, |_v, window| {
                let origin = window.bounds().origin;
                ok(json!({"x": f32::from(origin.x), "y": f32::from(origin.y)}))
            })?,
            "setPosition" => with_window(view_window, op, |_v, window| {
                window.set_position(gpui::Point {
                    x: gpui::px(request.f64_arg("x")? as f32),
                    y: gpui::px(request.f64_arg("y")? as f32),
                });
                ok(Value::Null)
            })?,
            "setCloseVeto" => {
                let armed = request.opt_bool("enabled").unwrap_or(false);
                with_window(view_window, op, |view, _window| {
                    WINDOWS.with(|windows| {
                        if let Some(entry) = windows.borrow().get(&view.window_id) {
                            entry.close_veto.set(armed);
                        }
                    });
                    ok(json!({"armed": armed}))
                })?
            }
            "getTitle" => with_window(view_window, op, |view, _window| {
                ok(json!(view.window_title.clone()))
            })?,
            "isOccluded" => with_window(view_window, op, |_v, window| {
                ok(json!(window.is_occluded()))
            })?,
            "setTitle" => with_window(view_window, op, |view, window| {
                let title = request.str_arg("title")?;
                view.window_title = title.clone();
                window.set_window_title(&title);
                // The view paints its own titlebar text — refresh to redraw.
                window.refresh();
                ok(Value::Null)
            })?,
            "minimize" => with_window(view_window, op, |_v, window| {
                window.minimize_window();
                ok(Value::Null)
            })?,
            "maximize" | "unmaximize" | "toggleMaximize" => {
                with_window(view_window, op, |_v, window| {
                    // gpui's `zoom` is the platform maximize toggle; honor the
                    // requested direction when it is knowable.
                    let maximized = window.is_maximized();
                    let want = match op {
                        "maximize" => true,
                        "unmaximize" => false,
                        _ => !maximized,
                    };
                    if want != maximized {
                        window.zoom_window();
                    }
                    ok(json!({"maximized": want}))
                })?
            }
            "isMaximized" => with_window(view_window, op, |_v, window| {
                ok(json!(window.is_maximized()))
            })?,
            "isFullscreen" => with_window(view_window, op, |_v, window| {
                ok(json!(window.is_fullscreen()))
            })?,
            "setFullscreen" | "toggleFullscreen" => with_window(view_window, op, |_v, window| {
                let current = window.is_fullscreen();
                let want = if op == "toggleFullscreen" {
                    !current
                } else {
                    request.bool_arg("fullscreen")?
                };
                if want != current {
                    window.toggle_fullscreen();
                }
                ok(json!({"fullscreen": want}))
            })?,
            "isActive" | "isFocused" => with_window(view_window, op, |_v, window| {
                ok(json!(window.is_window_active()))
            })?,
            "focus" => with_window(view_window, op, |_v, window| {
                window.activate_window();
                ok(Value::Null)
            })?,
            "requestAttention" | "flashFrame" => with_window(view_window, op, |_v, window| {
                window.request_attention();
                ok(Value::Null)
            })?,
            "setRepresentedFilename" => with_window(view_window, op, |_v, window| {
                let path = request.opt_str("path");
                window.set_document_path(path.as_deref().map(Path::new));
                ok(Value::Null)
            })?,
            "close" => with_window(view_window, op, |_v, window| {
                window.remove_window();
                ok(Value::Null)
            })?,
            "showCharacterPalette" => with_window(view_window, op, |_v, window| {
                window.show_character_palette();
                ok(Value::Null)
            })?,
            "getScaleFactor" => with_window(view_window, op, |_v, window| {
                ok(json!(window.scale_factor()))
            })?,
            "getCursorPoint" => with_window(view_window, op, |_v, window| {
                let point = window.mouse_position();
                ok(json!({"x": f32::from(point.x), "y": f32::from(point.y)}))
            })?,
            _ => window_ext::call(request, view_window),
        }
    }

    /// App-scoped window ops — they act through the `WINDOWS` registry, so
    /// they work with zero windows open and inside any window's update.
    /// `create` opens a fresh `GpuixView` on the shared retained tree; each
    /// window's root is what `setRoot` assigns to its windowId.
    #[cfg(target_os = "macos")]
    pub fn call_app(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
        cx: &mut App,
    ) -> OpResult {
        match request.op.as_str() {
            "create" => create(request, cx),
            "list" => list(view_window, cx),
            "get" => get(request, view_window, cx),
            other => err(PlatformError {
                code: "unknown",
                message: format!("unknown window op `{other}`"),
            }),
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn call_app(
        request: &PlatformRequest,
        _view_window: Option<(&mut GpuixView, &mut Window)>,
        _cx: &mut App,
    ) -> OpResult {
        err(PlatformError::unsupported(format!(
            "window.{} is not implemented on this OS",
            request.op
        )))
    }

    /// Registry rows as `(id, label, handle)` — the borrow is released before
    /// any `handle.update` so nothing nests.
    #[cfg(target_os = "macos")]
    fn entries() -> Vec<(u32, String, gpui::WindowHandle<GpuixView>)> {
        WINDOWS.with(|windows| {
            windows
                .borrow()
                .iter()
                .map(|(id, entry)| (*id, entry.label.clone(), entry.handle))
                .collect()
        })
    }

    /// `{windowId,label,focused,bounds}` — the `WindowInfo` the TS side
    /// declares. The window the dispatch is running inside cannot take a
    /// second `update` — it arrives as the borrowed pair instead. Other
    /// windows go through their handle; one mid-close fails `update` —
    /// `list` skips it, `get` reports it missing.
    #[cfg(target_os = "macos")]
    fn describe_json(id: u32, label: &str, view: &GpuixView, window: &Window) -> Value {
        let (bounds, state) = window_bounds_json(window.window_bounds());
        json!({
            "windowId": id,
            "label": label,
            "title": view.window_title.clone(),
            "focused": window.is_window_active(),
            "bounds": bounds,
            "state": state,
        })
    }

    #[cfg(target_os = "macos")]
    fn describe(
        id: u32,
        label: String,
        handle: gpui::WindowHandle<GpuixView>,
        view_window: &mut Option<(&mut GpuixView, &mut Window)>,
        cx: &mut App,
    ) -> Option<Value> {
        if let Some((view, window)) = view_window.as_mut() {
            if view.window_id == id {
                return Some(describe_json(id, &label, view, window));
            }
        }
        handle
            .update(cx, |view, window, _cx| describe_json(id, &label, view, window))
            .ok()
    }

    #[cfg(target_os = "macos")]
    fn create(request: &PlatformRequest, cx: &mut App) -> OpResult {
        let label = request.opt_str("label").unwrap_or_default();
        // Labels are the JS-side lookup key (`windows.get(label)` /
        // `emitTo(label, …)`) — a duplicate would make them ambiguous.
        if !label.is_empty()
            && WINDOWS.with(|windows| {
                windows.borrow().values().any(|entry| entry.label == label)
            })
        {
            return err(PlatformError::invalid(format!(
                "window.create: label `{label}` is already in use"
            )));
        }
        let Some(state) = RENDERER_STATE.with(|state| state.borrow().clone()) else {
            return err(PlatformError::unavailable(
                "window.create: renderer is not initialized",
            ));
        };
        // Sizes must be positive — a zero or negative extent would reach
        // AppKit and either trap or open a degenerate window. (`opt_f64`
        // already rejects NaN/inf.) Validation runs BEFORE the id is
        // allocated: a rejected create must not burn a windowId.
        for key in ["width", "height", "minWidth", "minHeight"] {
            if let Some(value) = request.opt_f64(key)? {
                if value <= 0.0 {
                    return err(PlatformError::invalid(format!(
                        "window.create: `{key}` must be positive"
                    )));
                }
            }
        }
        let window_id = NEXT_WINDOW_ID.with(|next| {
            let id = next.get();
            next.set(id + 1);
            id
        });
        let width = request.opt_f64("width")?.unwrap_or(800.0) as f32;
        let height = request.opt_f64("height")?.unwrap_or(600.0) as f32;
        let title = request
            .opt_str("title")
            .unwrap_or_else(|| "GPUIX".to_string());
        let size = gpui::size(gpui::px(width), gpui::px(height));
        let bounds = match (request.opt_f64("x")?, request.opt_f64("y")?) {
            (Some(x), Some(y)) => gpui::Bounds {
                origin: gpui::point(gpui::px(x as f32), gpui::px(y as f32)),
                size,
            },
            _ => gpui::Bounds::centered(None, size, cx),
        };
        // `decorations:false` → client-decorated → borderless on macOS (the
        // fork maps WindowDecorations::Client to NSBorderlessWindowMask — no
        // theme frame, so only the painted content shows). `titlebar` still
        // wins for transparency when both are given.
        let titlebar = match request.opt_bool("decorations") {
            Some(false) => None,
            _ => Some(gpui::TitlebarOptions {
                title: Some(title.clone().into()),
                appears_transparent: request
                    .opt_bool("titlebarTransparent")
                    .unwrap_or(false),
                traffic_light_position: None,
            }),
        };
        // `visible` is the Tauri-facing name; `show` stays accepted.
        let show = request
            .opt_bool("visible")
            .or_else(|| request.opt_bool("show"))
            .unwrap_or(true);
        let window_min_size = match (request.opt_f64("minWidth")?, request.opt_f64("minHeight")?) {
            (Some(w), Some(h)) => Some(gpui::size(gpui::px(w as f32), gpui::px(h as f32))),
            (Some(w), None) => Some(gpui::size(gpui::px(w as f32), gpui::px(0.0))),
            (None, Some(h)) => Some(gpui::size(gpui::px(0.0), gpui::px(h as f32))),
            (None, None) => None,
        };
        let options = gpui::WindowOptions {
            window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
            titlebar,
            kind: if request.opt_bool("alwaysOnTop").unwrap_or(false) {
                gpui::WindowKind::Floating
            } else {
                gpui::WindowKind::Normal
            },
            window_background: if request.opt_bool("transparent").unwrap_or(false) {
                gpui::WindowBackgroundAppearance::Transparent
            } else {
                gpui::WindowBackgroundAppearance::Opaque
            },
            is_resizable: request.opt_bool("resizable").unwrap_or(true),
            is_movable: request.opt_bool("movable").unwrap_or(true),
            is_minimizable: request.opt_bool("minimizable").unwrap_or(true),
            window_min_size,
            tabbing_identifier: request.opt_str("tabbingIdentifier"),
            focus: request.opt_bool("focus").unwrap_or(true),
            show,
            ..Default::default()
        };
        let tree = state.tree.clone();
        let callback = state.callback.clone();
        // Every window owns a selection — a shared state would let a press
        // armed in one window promote on a drag in another, and `clear`
        // would erase both windows' selections at once.
        let selection = SharedSelection::default();
        // The automation clock is app-global — every window's view shares
        // the stashed handle so a freeze hits all animations at once.
        let clock = state.clock.clone();
        match cx.open_window(options, move |_window, cx| {
            cx.new(|_| {
                GpuixView::new(
                    window_id,
                    tree.clone(),
                    callback.clone(),
                    title.clone(),
                    selection.clone(),
                    clock.clone(),
                )
            })
        }) {
            Ok(handle) => {
                observe_window(&handle, cx);
                // `opacity` stages a window invisible while keeping it on a
                // screen — `visible:false` applies too late to suppress the
                // first presented frame, and an offscreen frame breaks the
                // screen-relative positioning ops. setAlphaValue lands before
                // the first presentation so nothing ever flashes.
                #[cfg(target_os = "macos")]
                if let Some(opacity) = request.opt_f64("opacity")? {
                    #[allow(unused_imports)]
                    use objc::{sel, sel_impl};
                    let _ = handle.update(cx, |_view, window, _cx| {
                        if let Ok(ns_window) =
                            crate::platform::window_ext::require_nswindow(window, "create")
                        {
                            unsafe {
                                let _: () = objc::msg_send![ns_window, setAlphaValue: opacity];
                            }
                        }
                    });
                }
                WINDOWS.with(|windows| {
                    windows.borrow_mut().insert(
                        window_id,
                        crate::renderer::WindowEntry {
                            handle,
                            label: label.clone(),
                            close_veto: std::cell::Cell::new(false),
                        },
                    );
                });
                // `windows.onCreated` subscribers — after the registry insert
                // so a `list` fired from inside the callback sees the row.
                emit_event("created", json!({"windowId": window_id, "label": label}));
                ok(json!({"windowId": window_id, "label": label}))
            }
            Err(error) => err(PlatformError::internal(format!("window.create: {error}"))),
        }
    }

    #[cfg(target_os = "macos")]
    fn list(
        mut view_window: Option<(&mut GpuixView, &mut Window)>,
        cx: &mut App,
    ) -> OpResult {
        let mut windows = Vec::new();
        for (id, label, handle) in entries() {
            if let Some(info) = describe(id, label, handle, &mut view_window, cx) {
                windows.push(info);
            }
        }
        ok(json!(windows))
    }

    #[cfg(target_os = "macos")]
    fn get(
        request: &PlatformRequest,
        mut view_window: Option<(&mut GpuixView, &mut Window)>,
        cx: &mut App,
    ) -> OpResult {
        // `{windowId}` or `{label}` — both resolve to a registry entry.
        let target_id = request.opt_f64("windowId")?.map(|id| id as u32);
        let found = WINDOWS.with(|windows| {
            let windows = windows.borrow();
            if let Some(id) = target_id {
                windows
                    .get(&id)
                    .map(|entry| (id, entry.label.clone(), entry.handle))
            } else {
                request
                    .opt_str("label")
                    .and_then(|label| windows.iter().find(|(_, entry)| entry.label == label))
                    .map(|(id, entry)| (*id, entry.label.clone(), entry.handle))
            }
        });
        // No match (or one mid-close) resolves null — `get` is a lookup,
        // not an assertion; unknown labels are a normal result, not an error.
        let Some((id, label, handle)) = found else {
            return ok(Value::Null);
        };
        match describe(id, label, handle, &mut view_window, cx) {
            Some(info) => ok(info),
            None => ok(Value::Null),
        }
    }
}


// ── screen ──────────────────────────────────────────────────────────

mod screen {
    use super::*;

    fn display_json(display: &dyn gpui::PlatformDisplay, primary_id: Option<u64>) -> Value {
        let bounds = display.bounds();
        let visible = display.visible_bounds();
        let id = u64::from(display.id());
        json!({
            "id": id,
            "uuid": display.uuid().ok().map(|u| u.to_string()),
            "bounds": {
                "x": f32::from(bounds.origin.x), "y": f32::from(bounds.origin.y),
                "width": f32::from(bounds.size.width), "height": f32::from(bounds.size.height),
            },
            "workArea": {
                "x": f32::from(visible.origin.x), "y": f32::from(visible.origin.y),
                "width": f32::from(visible.size.width), "height": f32::from(visible.size.height),
            },
            "isPrimary": primary_id == Some(id),
        })
    }

    fn display_id_u64(id: gpui::DisplayId) -> u64 {
        u64::from(id)
    }

    pub fn call(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
        cx: &mut App,
    ) -> OpResult {
        match request.op.as_str() {
            "getAllDisplays" => {
                let primary = cx.primary_display().map(|d| display_id_u64(d.id()));
                let displays: Vec<Value> = cx
                    .displays()
                    .iter()
                    .map(|d| display_json(d.as_ref(), primary))
                    .collect();
                ok(json!(displays))
            }
            "getPrimaryDisplay" => match cx.primary_display() {
                Some(d) => {
                    let id = display_id_u64(d.id());
                    ok(display_json(d.as_ref(), Some(id)))
                }
                None => err(PlatformError::unavailable("no primary display")),
            },
            "getDisplayNearestWindow" => match view_window {
                Some((_view, window)) => match window.display(cx) {
                    Some(d) => ok(display_json(d.as_ref(), None)),
                    None => err(PlatformError::unavailable("window is not on a display")),
                },
                None => err(PlatformError::unavailable(
                    "screen.getDisplayNearestWindow: no window is open",
                )),
            },
            "getCursorScreenPoint" => cursor_screen_point(),
            "scaleFactor" => match view_window {
                Some((_view, window)) => ok(json!(window.scale_factor())),
                None => err(PlatformError::unavailable(
                    "screen.scaleFactor: no window is open",
                )),
            },
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown screen op `{op}`"),
            }),
        }
    }

    #[cfg(target_os = "macos")]
    fn cursor_screen_point() -> OpResult {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        use core_graphics::geometry::CGPoint;
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| PlatformError::unavailable("no CGEventSource"))?;
        let event = CGEvent::new(source).map_err(|_| PlatformError::unavailable("no CGEvent"))?;
        let CGPoint { x, y } = event.location();
        ok(json!({"x": x, "y": y}))
    }

    #[cfg(not(target_os = "macos"))]
    fn cursor_screen_point() -> OpResult {
        err(PlatformError::unsupported(
            "global cursor position is not implemented on this OS yet",
        ))
    }
}

// ── clipboard ───────────────────────────────────────────────────────

mod clipboard {
    use super::*;
    use gpui::ClipboardEntry;

    fn formats(item: &ClipboardItem) -> Vec<&'static str> {
        item.entries
            .iter()
            .map(|entry| match entry {
                ClipboardEntry::String(_) => "text/plain",
                ClipboardEntry::Image(_) => "image/png",
                ClipboardEntry::ExternalPaths(_) => "files",
            })
            .collect()
    }

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "readText" => {
                let text = cx.read_from_clipboard().and_then(|item| {
                    item.entries.iter().find_map(|entry| match entry {
                        ClipboardEntry::String(s) => Some(s.text().to_string()),
                        _ => None,
                    })
                });
                ok(json!(text))
            }
            "writeText" => {
                let text = request.str_arg("text")?;
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                ok(Value::Null)
            }
            "clear" => {
                cx.write_to_clipboard(ClipboardItem { entries: vec![] });
                ok(Value::Null)
            }
            "availableFormats" => {
                let formats = cx
                    .read_from_clipboard()
                    .map(|item| formats(&item))
                    .unwrap_or_default();
                ok(json!(formats))
            }
            "has" => {
                let format = request.str_arg("format")?;
                let has = cx
                    .read_from_clipboard()
                    .map(|item| formats(&item).contains(&format.as_str()))
                    .unwrap_or(false);
                ok(json!(has))
            }
            "readImage" => {
                let image = cx.read_from_clipboard().and_then(|item| {
                    item.entries.into_iter().find_map(|entry| match entry {
                        ClipboardEntry::Image(image) => Some(image),
                        _ => None,
                    })
                });
                match image {
                    Some(image) => ok(json!({
                        "bytes": base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            image.bytes()
                        ),
                        "format": format!("{:?}", image.format).to_lowercase(),
                    })),
                    None => ok(Value::Null),
                }
            }
            "writeImage" => {
                let b64 = request.str_arg("bytes")?;
                let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
                    .map_err(|e| PlatformError::invalid(format!("clipboard.writeImage: {e}")))?;
                let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes);
                cx.write_to_clipboard(ClipboardItem::new_image(&image));
                ok(Value::Null)
            }
            "readPaths" => {
                let paths = cx.read_from_clipboard().and_then(|item| {
                    item.entries.into_iter().find_map(|entry| match entry {
                        ClipboardEntry::ExternalPaths(paths) => Some(
                            paths
                                .paths()
                                .iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect::<Vec<_>>(),
                        ),
                        _ => None,
                    })
                });
                ok(json!(paths))
            }
            "readHtml" => read_rich("public.html"),
            "writeHtml" => {
                let html = request
                    .opt_str("html")
                    .or_else(|| request.opt_str("text"))
                    .ok_or_else(|| {
                        PlatformError::invalid("clipboard.writeHtml: missing argument `html`")
                    })?;
                write_rich("public.html", &html)
            }
            "readRtf" => read_rich("public.rtf"),
            "writeRtf" => {
                let rtf = request
                    .opt_str("rtf")
                    .or_else(|| request.opt_str("text"))
                    .ok_or_else(|| {
                        PlatformError::invalid("clipboard.writeRtf: missing argument `rtf`")
                    })?;
                write_rich("public.rtf", &rtf)
            }
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown clipboard op `{op}`"),
            }),
        }
    }

    // Rich formats (HTML/RTF) bypass `ClipboardItem` — gpui's clipboard model
    // has no slot for them, so they go through NSPasteboard directly under
    // their UTI names.
    #[cfg(target_os = "macos")]
    unsafe fn ns_string(string: &str) -> cocoa::base::id {
        use cocoa::base::nil;
        use cocoa::foundation::{NSAutoreleasePool, NSString};
        unsafe { NSString::alloc(nil).init_str(string).autorelease() }
    }

    #[cfg(target_os = "macos")]
    fn read_rich(uti: &str) -> OpResult {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::nil;
        use cocoa::foundation::NSString;
        use std::ffi::CStr;

        unsafe {
            let pasteboard = NSPasteboard::generalPasteboard(nil);
            let value = NSPasteboard::stringForType(pasteboard, ns_string(uti));
            if value == nil {
                return ok(Value::Null);
            }
            let text = CStr::from_ptr(NSString::UTF8String(value))
                .to_string_lossy()
                .into_owned();
            ok(json!(text))
        }
    }

    #[cfg(target_os = "macos")]
    fn write_rich(uti: &str, text: &str) -> OpResult {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::nil;
        use objc::runtime::NO;

        unsafe {
            let pasteboard = NSPasteboard::generalPasteboard(nil);
            NSPasteboard::clearContents(pasteboard);
            let written =
                NSPasteboard::setString_forType(pasteboard, ns_string(text), ns_string(uti));
            if written == NO {
                return err(PlatformError::unavailable("NSPasteboard refused the write"));
            }
            ok(Value::Null)
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn read_rich(_uti: &str) -> OpResult {
        err(PlatformError::unsupported(
            "rich clipboard formats are not implemented on this OS",
        ))
    }

    #[cfg(not(target_os = "macos"))]
    fn write_rich(_uti: &str, _text: &str) -> OpResult {
        err(PlatformError::unsupported(
            "rich clipboard formats are not implemented on this OS",
        ))
    }
}

// ── shell ───────────────────────────────────────────────────────────

mod shell {
    use super::*;

    /// Schemes we hand to the OS without asking questions. `file:` goes through
    /// openPath instead; scriptable schemes never leave the process.
    const ALLOWED_SCHEMES: &[&str] = &["http", "https", "mailto", "tel", "sms", "facetime", "maps"];

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "openExternal" => {
                let url = request.str_arg("url")?;
                let parsed = url::Url::parse(&url).map_err(|e| {
                    PlatformError::invalid(format!("shell.openExternal: `{url}` is not a URL: {e}"))
                })?;
                let scheme = parsed.scheme().to_ascii_lowercase();
                if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
                    return err(PlatformError {
                        code: "denied",
                        message: format!(
                            "shell.openExternal refuses scheme `{scheme}` — use openPath for files"
                        ),
                    });
                }
                cx.open_url(&url);
                ok(Value::Null)
            }
            "openPath" => {
                let path = request.str_arg("path")?;
                let path = PathBuf::from(&path);
                if !path.exists() {
                    return err(PlatformError::unavailable(format!(
                        "shell.openPath: `{}` does not exist",
                        path.display()
                    )));
                }
                cx.open_with_system(&path);
                ok(Value::Null)
            }
            "showItemInFolder" => {
                let path = request.str_arg("path")?;
                let path = PathBuf::from(&path);
                if !path.exists() {
                    return err(PlatformError::unavailable(format!(
                        "shell.showItemInFolder: `{}` does not exist",
                        path.display()
                    )));
                }
                cx.reveal_path(&path);
                ok(Value::Null)
            }
            "trashItem" | "beep" => macos_ext::call(request, cx),
            "openShortcut" | "readShortcutLink" | "writeShortcutLink" => {
                err(PlatformError::unsupported(format!(
                    "shell.{} is not implemented in this build",
                    request.op
                )))
            }
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown shell op `{op}`"),
            }),
        }
    }
}

// ── dialog ──────────────────────────────────────────────────────────
// All three dialogs resolve through `platformResult` — they are genuinely
// async (the oneshot completes when the user answers).

mod dialog {
    use super::*;

    fn spawn_reply(
        cx: &mut App,
        id: u64,
        future: impl Future<Output = OpResult> + 'static,
    ) -> Outcome {
        cx.spawn(async move |_cx| {
            resolve_pending(id, future.await);
        })
        .detach();
        Outcome::Pending
    }

    fn prompt_level(name: &str) -> PromptLevel {
        match name {
            "warning" => PromptLevel::Warning,
            "critical" | "error" => PromptLevel::Critical,
            _ => PromptLevel::Info,
        }
    }

    pub fn call(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
        cx: &mut App,
    ) -> Outcome {
        let id = request.id;
        match request.op.as_str() {
            "showMessageBox" => {
                let Some((_view, window)) = view_window else {
                    return reply(err(PlatformError::unavailable(
                        "dialog.showMessageBox: no window is open",
                    )));
                };
                let title = request
                    .opt_str("title")
                    .or_else(|| request.opt_str("message"));
                let message = match title.clone().or_else(|| request.opt_str("detail")) {
                    Some(_) => title.unwrap_or_default(),
                    None => request.str_arg("message").unwrap_or_default(),
                };
                let detail = request.opt_str("detail");
                let level = prompt_level(request.opt_str("type").as_deref().unwrap_or("info"));
                let labels: Vec<String> =
                    match request.args.get("buttons").and_then(Value::as_array) {
                        Some(buttons) if !buttons.is_empty() => buttons
                            .iter()
                            .filter_map(|b| b.as_str().map(str::to_string))
                            .collect(),
                        _ => vec!["OK".to_string()],
                    };
                let cancel_id = request
                    .args
                    .get("cancelId")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(|| labels.len().saturating_sub(1) as u64)
                    as usize;
                let answers: Vec<PromptButton> = labels
                    .iter()
                    .enumerate()
                    .map(|(index, label)| {
                        if index == cancel_id {
                            PromptButton::cancel(label.clone())
                        } else if index == 0 {
                            PromptButton::ok(label.clone())
                        } else {
                            PromptButton::new(label.clone())
                        }
                    })
                    .collect();
                let receiver = window.prompt(level, &message, detail.as_deref(), &answers, cx);
                spawn_reply(cx, id, async move {
                    match receiver.await {
                        Ok(index) => ok(json!({
                            "response": index,
                            "canceled": index == cancel_id,
                        })),
                        Err(_) => err(PlatformError::unavailable(
                            "message box was dismissed without an answer",
                        )),
                    }
                })
            }
            "showOpenDialog" => {
                let options = gpui::PathPromptOptions {
                    files: request.opt_bool("files").unwrap_or(true),
                    directories: request.opt_bool("directories").unwrap_or(false),
                    multiple: request.opt_bool("multiple").unwrap_or(false),
                    prompt: request.opt_str("prompt").map(SharedString::from),
                    filters: prompt_filters(request),
                };
                if !options.files && !options.directories {
                    return reply(err(PlatformError::invalid(
                        "dialog.showOpenDialog: at least one of files/directories must be true",
                    )));
                }
                let receiver = cx.prompt_for_paths(options);
                spawn_reply(cx, id, async move {
                    match receiver.await {
                        Ok(Ok(Some(paths))) => ok(json!({
                            "canceled": false,
                            "paths": paths.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
                        })),
                        Ok(Ok(None)) => ok(json!({"canceled": true, "paths": []})),
                        Ok(Err(e)) => err(PlatformError::unavailable(format!("{e}"))),
                        Err(_) => err(PlatformError::unavailable("open dialog was dropped")),
                    }
                })
            }
            "showSaveDialog" => {
                let directory = request
                    .opt_str("defaultPath")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("/"));
                let suggested = request
                    .opt_str("suggestedName")
                    .or_else(|| request.opt_str("name"));
                let receiver = cx.prompt_for_new_path(
                    &directory,
                    suggested.as_deref(),
                    prompt_filters(request),
                );
                spawn_reply(cx, id, async move {
                    match receiver.await {
                        Ok(Ok(Some(path))) => ok(json!({
                            "canceled": false,
                            "path": path.to_string_lossy(),
                        })),
                        Ok(Ok(None)) => ok(json!({"canceled": true, "path": null})),
                        Ok(Err(e)) => err(PlatformError::unavailable(format!("{e}"))),
                        Err(_) => err(PlatformError::unavailable("save dialog was dropped")),
                    }
                })
            }
            "showConfirm" => err_to_outcome(PlatformError::unsupported(
                "use showMessageBox — confirmation is a message box with OK/Cancel buttons",
            )),
            op => err_to_outcome(PlatformError {
                code: "unknown",
                message: format!("unknown dialog op `{op}`"),
            }),
        }
    }

    fn err_to_outcome(error: PlatformError) -> Outcome {
        reply(err(error))
    }
}

// ── theme ───────────────────────────────────────────────────────────

mod theme {
    use super::*;

    fn appearance_name(appearance: WindowAppearance) -> &'static str {
        match appearance {
            WindowAppearance::Light => "light",
            WindowAppearance::VibrantLight => "vibrantLight",
            WindowAppearance::Dark => "dark",
            WindowAppearance::VibrantDark => "vibrantDark",
        }
    }

    pub fn appearance_json(appearance: WindowAppearance) -> Value {
        let name = appearance_name(appearance);
        json!({
            "appearance": name,
            "dark": matches!(appearance, WindowAppearance::Dark | WindowAppearance::VibrantDark),
        })
    }

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "get" | "getAppearance" => ok(appearance_json(cx.window_appearance())),
            "set" | "setAppearance" => {
                let value = request
                    .args
                    .get("appearance")
                    .cloned()
                    .unwrap_or(Value::Null);
                let appearance = match value.as_str() {
                    Some("light") => Some(WindowAppearance::Light),
                    Some("dark") => Some(WindowAppearance::Dark),
                    Some("vibrantLight") => Some(WindowAppearance::VibrantLight),
                    Some("vibrantDark") => Some(WindowAppearance::VibrantDark),
                    Some("system") | None => None,
                    Some(other) => {
                        return err(PlatformError::invalid(format!(
                            "theme.set: unknown appearance `{other}`"
                        )))
                    }
                };
                cx.set_window_appearance(appearance);
                ok(appearance_json(cx.window_appearance()))
            }
            "shouldUseDarkColors" => ok(json!(matches!(
                cx.window_appearance(),
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            ))),
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown theme op `{op}`"),
            }),
        }
    }
}

// ── system ──────────────────────────────────────────────────────────

mod system {
    use super::*;

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "info" => ok(json!({
                "os": std::env::consts::OS,
                "family": std::env::consts::FAMILY,
                "arch": std::env::consts::ARCH,
                "keyboardLayout": cx.keyboard_layout().name(),
            })),
            "getKeyboardLayout" => ok(json!({"name": cx.keyboard_layout().name()})),
            "getAccentColor" | "getAccessibility" => macos_ext::call(request, cx),
            "getOSVersion" | "machineId" | "getHostName" => err(PlatformError::unsupported(
                format!("system.{} is not implemented in this build", request.op),
            )),
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown system op `{op}`"),
            }),
        }
    }
}

// ── power ───────────────────────────────────────────────────────────

mod power {
    use super::*;

    fn thermal_name(state: gpui::ThermalState) -> &'static str {
        match state {
            gpui::ThermalState::Nominal => "nominal",
            gpui::ThermalState::Fair => "fair",
            gpui::ThermalState::Serious => "serious",
            gpui::ThermalState::Critical => "critical",
        }
    }

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "getThermalState" | "thermalState" => ok(json!({
                "state": thermal_name(cx.thermal_state()),
            })),
            "getSystemIdleTime" => system_idle_time(),
            "getBattery" | "blockSleep" | "unblockSleep" => power_ext::call(request, cx),
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown power op `{op}`"),
            }),
        }
    }

    #[cfg(target_os = "macos")]
    fn system_idle_time() -> OpResult {
        // CGEventSourceSecondsSinceLastEventType is the global input idle
        // timer — keyboard and mouse both reset it. core-graphics 0.24 ships
        // no safe wrapper, so the FFI is declared here; stateID 0 is
        // kCGEventSourceStateCombinedSessionState. The wildcard is
        // kCGAnyInputEventType = ~0 — eventType 0 is kCGEventNull, which
        // does NOT track user input and would return a wrong (near-zero)
        // idle time.
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
        }
        let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        ok(json!(seconds))
    }

    #[cfg(not(target_os = "macos"))]
    fn system_idle_time() -> OpResult {
        err(PlatformError::unsupported(
            "system idle time is not implemented on this OS yet",
        ))
    }
}

// ── secureStorage ───────────────────────────────────────────────────
// macOS Keychain via GPUI's credential APIs. All three are Tasks → pending.

mod secure_storage {
    use super::*;

    /// The credential APIs key on a "url" string. We map service→url and
    /// account→username so entries group under the app's service name.
    fn credential_url(service: &str) -> String {
        format!("gpuix://{service}")
    }

    pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let id = request.id;
        match request.op.as_str() {
            "setPassword" => {
                let (service, account, password) = match (
                    request.str_arg("service"),
                    request.str_arg("account"),
                    request.str_arg("password"),
                ) {
                    (Ok(a), Ok(b), Ok(c)) => (a, b, c),
                    (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
                        return reply(err(e));
                    }
                };
                let task =
                    cx.write_credentials(&credential_url(&service), &account, password.as_bytes());
                cx.spawn(async move |_cx| {
                    resolve_pending(
                        id,
                        match task.await {
                            Ok(()) => ok(Value::Null),
                            Err(e) => err(PlatformError::internal(format!(
                                "secureStorage.setPassword: {e}"
                            ))),
                        },
                    );
                })
                .detach();
                Outcome::Pending
            }
            "getPassword" => {
                let (service, account) =
                    match (request.str_arg("service"), request.str_arg("account")) {
                        (Ok(a), Ok(b)) => (a, b),
                        (Err(e), _) | (_, Err(e)) => return reply(err(e)),
                    };
                let task = cx.read_credentials(&credential_url(&service));
                cx.spawn(async move |_cx| {
                    resolve_pending(
                        id,
                        match task.await {
                            Ok(Some((username, password))) => {
                                if username == account {
                                    match String::from_utf8(password) {
                                        Ok(password) => ok(json!(password)),
                                        Err(_) => err(PlatformError::internal(
                                            "secureStorage.getPassword: stored value is not UTF-8",
                                        )),
                                    }
                                } else {
                                    ok(Value::Null) // keychain entry for another account
                                }
                            }
                            Ok(None) => ok(Value::Null),
                            Err(e) => err(PlatformError::internal(format!(
                                "secureStorage.getPassword: {e}"
                            ))),
                        },
                    );
                })
                .detach();
                Outcome::Pending
            }
            "deletePassword" => {
                let service = match request.str_arg("service") {
                    Ok(s) => s,
                    Err(e) => return reply(err(e)),
                };
                let task = cx.delete_credentials(&credential_url(&service));
                cx.spawn(async move |_cx| {
                    resolve_pending(
                        id,
                        match task.await {
                            Ok(()) => ok(Value::Null),
                            Err(e) => err(PlatformError::internal(format!(
                                "secureStorage.deletePassword: {e}"
                            ))),
                        },
                    );
                })
                .detach();
                Outcome::Pending
            }
            "usePlainText" | "isEncryptionAvailable" => reply(err(PlatformError::unsupported(
                "secureStorage always uses the OS keychain; no plaintext fallback",
            ))),
            op => reply(err(PlatformError {
                code: "unknown",
                message: format!("unknown secureStorage op `{op}`"),
            })),
        }
    }
}

// ── notifications ───────────────────────────────────────────────────

mod notifications {
    use super::*;

    pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
        // Permission ops take the pending lane — delegate before the
        // sync-only match below.
        if matches!(
            request.op.as_str(),
            "getPermissionStatus" | "requestPermission"
        ) {
            return permissions::call_notifications(request, cx);
        }
        reply(call_sync(request, cx))
    }

    fn call_sync(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "show" | "notify" => {
                let title = request.str_arg("title")?;
                let body = request.opt_str("body").unwrap_or_default();
                let tag = request
                    .opt_str("tag")
                    .unwrap_or_else(|| "default".to_string());
                let actions = request
                    .args
                    .get("actions")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|a| {
                                Some(SystemNotificationAction {
                                    id: a.get("id")?.as_str()?.into(),
                                    label: a.get("label")?.as_str()?.into(),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                cx.show_system_notification(SystemNotification {
                    tag: tag.clone().into(),
                    title: title.into(),
                    body: body.into(),
                    actions,
                });
                ok(json!({"tag": tag}))
            }
            "dismiss" | "close" => {
                let tag = request.str_arg("tag")?;
                cx.dismiss_system_notification(&tag);
                ok(Value::Null)
            }
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown notifications op `{op}`"),
            }),
        }
    }
}

// ── deepLink ────────────────────────────────────────────────────────

mod deep_link {
    use super::*;

    pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let id = request.id;
        match request.op.as_str() {
            "register" | "registerScheme" => {
                let scheme = match request.str_arg("scheme") {
                    Ok(s) => s,
                    Err(e) => return reply(err(e)),
                };
                let task = cx.register_url_scheme(&scheme);
                cx.spawn(async move |_cx| {
                    resolve_pending(
                        id,
                        match task.await {
                            Ok(()) => ok(json!({"scheme": scheme})),
                            Err(e) => err(PlatformError::unavailable(format!(
                                "deepLink.register `{scheme}` failed: {e}"
                            ))),
                        },
                    );
                })
                .detach();
                Outcome::Pending
            }
            op => reply(err(PlatformError {
                code: "unknown",
                message: format!("unknown deepLink op `{op}`"),
            })),
        }
    }
}

// ── menu ────────────────────────────────────────────────────────────
// JS sends [{name, items:[{type:"action"|"separator"|"submenu", id?, label,
// submenu?, checked?, disabled?}]}]. Action items carry a string `id`; clicks
// dispatch a PlatformMenuAction that the view's on_action turns into a
// `menuAction` event.

mod menu {
    use super::*;

    /// Dynamic menu action — one concrete Action type whose payload is the
    /// item id. The view's `.on_action` downcasts it and emits `menuAction`.
    #[derive(Clone, PartialEq)]
    pub struct PlatformMenuAction {
        pub id: SharedString,
    }

    impl Action for PlatformMenuAction {
        fn name(&self) -> &'static str {
            "gpuix::PlatformMenuAction"
        }
        fn name_for_type() -> &'static str {
            "gpuix::PlatformMenuAction"
        }
        fn boxed_clone(&self) -> Box<dyn Action> {
            Box::new(self.clone())
        }
        fn partial_eq(&self, action: &dyn Action) -> bool {
            action.as_any().downcast_ref::<Self>() == Some(self)
        }
        fn build(_value: Value) -> anyhow::Result<Box<dyn Action>> {
            Err(anyhow::anyhow!(
                "PlatformMenuAction is built by menu.setAppMenu, not the keymap"
            ))
        }
    }

    fn item_from_json(item: &Value) -> Result<MenuItem, PlatformError> {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("action");
        // `{type:"role"}` or an action item carrying `role` maps to a
        // predefined item: edit roles wire gpui's `OsAction` (responder-chain
        // selectors), app/window roles reuse the `app_menu` action types that
        // already have bound handlers. `role` wins over `type:"action"`.
        if let Some(role) = item.get("role").and_then(Value::as_str) {
            if kind == "role" || kind == "action" {
                let label = item
                    .get("label")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                return role_menu_item(&role, label, item);
            }
        }
        match kind {
            "separator" => Ok(MenuItem::separator()),
            "submenu" => {
                let label = item
                    .get("label")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| PlatformError::invalid("submenu item needs a label"))?;
                let submenu = item
                    .get("submenu")
                    .and_then(Value::as_array)
                    .ok_or_else(|| PlatformError::invalid("submenu item needs a submenu array"))?;
                let mut menu = Menu::new(label.to_string());
                for child in submenu {
                    menu.items.push(item_from_json(child)?);
                }
                Ok(MenuItem::submenu(menu))
            }
            "action" => {
                let label = item
                    .get("label")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| PlatformError::invalid("action item needs a label"))?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| PlatformError::invalid("action item needs an id"))?;
                let mut entry = MenuItem::action(
                    label.to_string(),
                    PlatformMenuAction {
                        id: SharedString::from(id.to_string()),
                    },
                );
                if let MenuItem::Action {
                    ref mut checked,
                    ref mut disabled,
                    ..
                } = entry
                {
                    *checked = item
                        .get("checked")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    *disabled = item
                        .get("disabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                }
                Ok(entry)
            }
            other => err(PlatformError::invalid(format!(
                "unknown menu item type `{other}`"
            ))),
        }
    }

    /// `{role}` on a menu item → the predefined item gpui can express
    /// natively. Edit roles become `MenuItem::os_action` (AppKit wires the
    /// responder-chain selector — copy:/paste:/…); app/window roles reuse the
    /// `app_menu` action types whose handlers are already bound. `id` still
    /// emits `menuAction` through `PlatformMenuAction` where a role needs a
    /// payload action. NSMenuItem-built menus (tray, popup) cover more roles
    /// through `menu_ext::apply_item_extras`.
    #[cfg(target_os = "macos")]
    fn role_menu_item(
        role: &str,
        label: Option<String>,
        item: &Value,
    ) -> Result<MenuItem, PlatformError> {
        use crate::app_menu::{
            AboutPanel, CloseWindow, Hide, HideOthers, MinimizeWindow, Quit, ShowAll,
            ToggleFullscreen, ZoomWindow,
        };
        use gpui::{OsAction, SystemMenuType};

        let normalized = role.trim().to_ascii_lowercase();
        let default_label = |fallback: &str| label.clone().unwrap_or_else(|| fallback.to_string());

        let os = match normalized.as_str() {
            "copy" => Some(OsAction::Copy),
            "cut" => Some(OsAction::Cut),
            "paste" => Some(OsAction::Paste),
            "selectall" => Some(OsAction::SelectAll),
            "undo" => Some(OsAction::Undo),
            "redo" => Some(OsAction::Redo),
            _ => None,
        };
        if let Some(os_action) = os {
            let name = default_label(match os_action {
                OsAction::Copy => "Copy",
                OsAction::Cut => "Cut",
                OsAction::Paste => "Paste",
                OsAction::SelectAll => "Select All",
                OsAction::Undo => "Undo",
                OsAction::Redo => "Redo",
            });
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("role:{normalized}"));
            return Ok(MenuItem::os_action(
                name,
                PlatformMenuAction { id: id.into() },
                os_action,
            ));
        }

        match normalized.as_str() {
            "quit" => Ok(MenuItem::action(default_label("Quit"), Quit)),
            "hide" => Ok(MenuItem::action(default_label("Hide"), Hide)),
            "hideothers" | "hideotherapplications" => {
                Ok(MenuItem::action(default_label("Hide Others"), HideOthers))
            }
            "showall" | "unhideall" | "unhideallapplications" => {
                Ok(MenuItem::action(default_label("Show All"), ShowAll))
            }
            "minimize" => Ok(MenuItem::action(default_label("Minimize"), MinimizeWindow)),
            "zoom" | "maximize" => Ok(MenuItem::action(default_label("Zoom"), ZoomWindow)),
            "close" | "closewindow" => {
                Ok(MenuItem::action(default_label("Close Window"), CloseWindow))
            }
            "togglefullscreen" | "fullscreen" => Ok(MenuItem::action(
                default_label("Toggle Full Screen"),
                ToggleFullscreen,
            )),
            "about" => Ok(MenuItem::action(default_label("About"), AboutPanel)),
            "services" => Ok(MenuItem::os_submenu(
                default_label("Services"),
                SystemMenuType::Services,
            )),
            "separator" => Ok(MenuItem::separator()),
            other => err(PlatformError::invalid(format!(
                "menu role `{other}`: no gpui-native mapping — tray/popup menus accept more roles via menu.update",
            ))),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn role_menu_item(
        _role: &str,
        _label: Option<String>,
        _item: &Value,
    ) -> Result<MenuItem, PlatformError> {
        err(PlatformError::unsupported(
            "menu roles are not implemented on this platform",
        ))
    }

    fn menus_from_json(items: &[Value]) -> Result<Vec<Menu>, PlatformError> {
        items
            .iter()
            .map(|menu| {
                let name = menu
                    .get("name")
                    .or_else(|| menu.get("label"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| PlatformError::invalid("menu needs a name"))?;
                let mut built = Menu::new(name.to_string());
                for item in menu
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                {
                    built.items.push(item_from_json(item)?);
                }
                Ok(built)
            })
            .collect()
    }

    fn dock_items_from_json(items: &[Value]) -> Result<Vec<MenuItem>, PlatformError> {
        items.iter().map(item_from_json).collect()
    }

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "setAppMenu" | "setApplicationMenu" => {
                let items = request
                    .args
                    .get("menus")
                    .and_then(Value::as_array)
                    .ok_or_else(|| PlatformError::invalid("menu.setAppMenu needs a menus array"))?;
                let menus = menus_from_json(items)?;
                cx.set_menus(menus);
                ok(Value::Null)
            }
            "setDockMenu" => {
                let items = request
                    .args
                    .get("items")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        PlatformError::invalid("menu.setDockMenu needs an items array")
                    })?;
                cx.set_dock_menu(dock_items_from_json(items)?);
                ok(Value::Null)
            }
            "addRecentDocument" => {
                let path = request.str_arg("path")?;
                cx.add_recent_document(Path::new(&path));
                ok(Value::Null)
            }
            // "popup" is intercepted in the service router — it resolves via
            // the pending lane, not a synchronous OpResult.
            _ => menu_ext::call(request, cx),
        }
    }
}

// ── diagnostics ─────────────────────────────────────────────────────

mod diagnostics {
    use super::*;

    pub fn call(request: &PlatformRequest) -> OpResult {
        match request.op.as_str() {
            "info" => {
                let started = STARTED_AT.get_or_init(Instant::now);
                ok(json!({
                    "pid": std::process::id(),
                    "uptimeSeconds": started.elapsed().as_secs_f64(),
                    "os": std::env::consts::OS,
                    "family": std::env::consts::FAMILY,
                    "arch": std::env::consts::ARCH,
                    "renderer": "gpuix",
                    "rendererVersion": env!("CARGO_PKG_VERSION"),
                }))
            }
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown diagnostics op `{op}`"),
            }),
        }
    }
}

// ── capabilities ────────────────────────────────────────────────────
// The machine-readable truth table the JS `capabilities` service returns.
// Entries move to "implemented" only when the op above actually performs OS
// work — not because a symbol exists somewhere.

mod capabilities {
    use super::*;

    const MATRIX: &[(&str, &str, &[&str])] = &[
        (
            "app",
            "implemented",
            &[
                "getInfo",
                "getName",
                "getVersion",
                "getPath",
                "quit",
                "relaunch",
                "exit",
                "hide",
                "show",
                "activate",
                "hideOthers",
                "showAll",
                "setName",
                "setIdentity",
                "addRecentDocument",
                "whenReady",
            ],
        ),
        (
            "app",
            "macos-only",
            &[
                "setDockBadge",
                "bounceDock",
                "setLoginItem",
                "setActivationPolicy",
                "requestSingleInstanceLock",
                "setDockProgress",
                "getBundleType",
                "defaultWindowIcon",
                "aboutPanel",
            ],
        ),
        (
            "window",
            "implemented",
            &[
                "getBounds",
                "getSize",
                "setSize",
                "getTitle",
                "setTitle",
                "minimize",
                "maximize",
                "unmaximize",
                "toggleMaximize",
                "isMaximized",
                "isFullscreen",
                "setFullscreen",
                "toggleFullscreen",
                "isActive",
                "isOccluded",
                "focus",
                "requestAttention",
                "setRepresentedFilename",
                "close",
                "showCharacterPalette",
                "getScaleFactor",
                "getCursorPoint",
                "getPosition",
                "setPosition",
                "setCloseVeto",
            ],
        ),
        (
            "window",
            "macos-only",
            &[
                "center",
                "hide",
                "show",
                "setBounds",
                "innerSize",
                "innerPosition",
                "outerSize",
                "outerPosition",
                "positionTo",
                "restore",
                "unminimize",
                "isMinimized",
                "setSimpleFullscreen",
                "isSimpleFullscreen",
                "setAlwaysOnTop",
                "setAlwaysOnBottom",
                "blur",
                "isHovered",
                "setResizable",
                "isResizable",
                "setClosable",
                "isClosable",
                "setMinimizable",
                "isMinimizable",
                "setMaximizable",
                "isMaximizable",
                "setTitleBarStyle",
                "setDecorations",
                "setHasShadow",
                "invalidateShadow",
                "setOpacity",
                "getOpacity",
                "setMovable",
                "setMovableByWindowBackground",
                "setIgnoresMouseEvents",
                "ignoresMouseEvents",
                "setContentProtected",
                "isContentProtected",
                "setVisibleOnAllWorkspaces",
                "setDocumentEdited",
                "setEdited",
                "isDocumentEdited",
                "setTheme",
                "setCursorHidden",
                "setCursorPosition",
                "setMinSize",
                "setMaxSize",
            ],
        ),
        ("window", "unsupported", &["setFocusable"]),
        (
            "screen",
            "implemented",
            &[
                "getAllDisplays",
                "getPrimaryDisplay",
                "getDisplayNearestWindow",
                "scaleFactor",
            ],
        ),
        ("screen", "macos-only", &["getCursorScreenPoint"]),
        (
            "clipboard",
            "implemented",
            &[
                "readText",
                "writeText",
                "clear",
                "availableFormats",
                "has",
                "readImage",
                "writeImage",
                "readPaths",
            ],
        ),
        (
            "clipboard",
            "macos-only",
            &["readHtml", "writeHtml", "readRtf", "writeRtf"],
        ),
        (
            "shell",
            "implemented",
            &["openExternal", "openPath", "showItemInFolder"],
        ),
        ("shell", "macos-only", &["beep", "trashItem"]),
        (
            "dialog",
            "implemented",
            &["showMessageBox", "showOpenDialog", "showSaveDialog"],
        ),
        (
            "theme",
            "implemented",
            &["get", "set", "shouldUseDarkColors"],
        ),
        ("system", "implemented", &["info", "getKeyboardLayout"]),
        (
            "system",
            "macos-only",
            &[
                "getAccentColor",
                "getAccessibility",
                "checkPermission",
                "requestPermission",
                "openSettings",
            ],
        ),
        ("power", "implemented", &["getThermalState"]),
        (
            "power",
            "macos-only",
            &[
                "getSystemIdleTime",
                "getBattery",
                "blockSleep",
                "unblockSleep",
            ],
        ),
        (
            "secureStorage",
            "implemented",
            &["setPassword", "getPassword", "deletePassword"],
        ),
        ("secureStorage", "macos-only", &["authenticate"]),
        ("notifications", "implemented", &["show", "dismiss"]),
        (
            "notifications",
            "macos-only",
            &["getPermissionStatus", "requestPermission"],
        ),
        ("deepLink", "implemented", &["register"]),
        (
            "menu",
            "implemented",
            &["setAppMenu", "setDockMenu", "addRecentDocument"],
        ),
        (
            "menu",
            "macos-only",
            &[
                "popup",
                "update",
                "get",
                "items",
                "aboutPanel",
                "insert",
                "remove",
            ],
        ),
        (
            "capture",
            "macos-only",
            &["isSupported", "getSources", "captureSource"],
        ),
        ("capture", "unsupported", &["stream", "captureWindow"]),
        ("diagnostics", "implemented", &["info"]),
        ("capabilities", "implemented", &["describe"]),
        ("events", "implemented", &["on", "off", "once"]),
        (
            "tray",
            "macos-only",
            &["set", "create", "remove", "destroy", "isSet", "exists"],
        ),
        (
            "shortcuts",
            "macos-only",
            &["register", "unregister", "unregisterAll", "isRegistered"],
        ),
        // Surfaces that exist in the spec but have no backend yet.
        // singleInstance/autostart/dock/permissions are covered by
        // app.requestSingleInstanceLock, app.setLoginItem, app.*Dock*, and
        // system.*Permission ops above; windowState is a JS-side module.
        ("resources", "unsupported", &["*"]),
        ("protocol", "unsupported", &["*"]),
    ];

    pub fn call(request: &PlatformRequest) -> OpResult {
        match request.op.as_str() {
            "describe" => {
                let mut services = serde_json::Map::new();
                for (service, status, ops) in MATRIX {
                    let entry = services
                        .entry((*service).to_string())
                        .or_insert_with(|| json!({}));
                    for op in *ops {
                        entry[*op] = json!(status);
                    }
                }
                ok(json!({
                    "platform": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                    "services": Value::Object(services),
                }))
            }
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown capabilities op `{op}`"),
            }),
        }
    }
}

// Re-exported for the view: downcast helper for the dynamic menu action.
pub use menu::PlatformMenuAction;
