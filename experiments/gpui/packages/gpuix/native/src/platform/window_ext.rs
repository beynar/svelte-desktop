//! Extended window ops — NSWindow-level chrome control reached through the
//! raw-window-handle `nswindow()` helper plus `PlatformWindow` trait methods
//! that don't need AppKit access.
//!
//! Contract:
//!   `call`     — delegated tail for `window.*` ops not handled by
//!                window_svc (positioning, chrome flags, cursor, ...).
//!   `call_app` — app-domain ops that need AppKit (`setDockProgress`,
//!                `getBundleType`, `defaultWindowIcon`).
//!
//! Any op not implemented here answers `unknown` — the dispatcher's
//! `unsupported` contract stays honest.
//!
//! Coordinates: gpui reports window bounds and accepts positions in a
//! screen-relative, top-left-origin space — `(x - screen.x, screen.y +
//! screen.h - top)` inside the window's own screen (see `MacWindow::bounds` /
//! `set_position` in gpui_macos). All position ops below work in that space;
//! global top-left inputs (tray rect, cursor) are re-anchored through the
//! primary screen's height, the same convention `screen.getCursorScreenPoint`
//! and `tray::last_button_rect` already use.

use gpui::{App, Window};
use serde_json::Value;

use super::*;

pub fn call(
    request: &PlatformRequest,
    view_window: Option<(&mut GpuixView, &mut Window)>,
) -> OpResult {
    #[cfg(target_os = "macos")]
    return imp::call(request, view_window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = view_window;
        err(PlatformError::unsupported(format!(
            "window.{} is only implemented on macOS",
            request.op
        )))
    }
}

pub fn call_app(request: &PlatformRequest, _cx: &mut App) -> OpResult {
    #[cfg(target_os = "macos")]
    return imp::call_app(request);
    #[cfg(not(target_os = "macos"))]
    err(PlatformError::unsupported(format!(
        "app.{} is only implemented on macOS",
        request.op
    )))
}

#[cfg(target_os = "macos")]
pub(crate) use imp::require_nswindow;

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use cocoa::appkit::{NSEvent, NSScreen};
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{
        NSArray, NSAutoreleasePool, NSInteger, NSPoint, NSRect, NSSize, NSUInteger,
    };
    use core_graphics::display::{CGDisplay, CGPoint};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    // NSWindow.level is a plain NSInteger; CGWindowLevelForKey resolves the
    // real window-server levels that AppKit's symbolic constants alias
    // (kCGNormalWindowLevel → 0, kCGFloatingWindowLevel → 3). Declared by hand
    // because core-graphics 0.24 doesn't expose it.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowLevelForKey(key: i32) -> i32;
    }
    const K_CG_NORMAL_WINDOW_LEVEL_KEY: i32 = 4;
    const K_CG_FLOATING_WINDOW_LEVEL_KEY: i32 = 5;

    // NSWindowStyleMask bits (NSUInteger under the bitflags).
    const NS_TITLED: NSUInteger = 1 << 0;
    const NS_CLOSABLE: NSUInteger = 1 << 1;
    const NS_MINIATURIZABLE: NSUInteger = 1 << 2;
    const NS_RESIZABLE: NSUInteger = 1 << 3;
    const NS_TEXTURED_BACKGROUND: NSUInteger = 1 << 8;
    const NS_FULL_SIZE_CONTENT_VIEW: NSUInteger = 1 << 15;
    const NS_FULL_SCREEN: NSUInteger = 1 << 14;

    // NSWindowTitleVisibility.
    const NS_TITLE_VISIBLE: NSUInteger = 0;
    const NS_TITLE_HIDDEN: NSUInteger = 1;

    // NSWindowButton for standardWindowButton:.
    const NS_WINDOW_ZOOM_BUTTON: NSUInteger = 2;

    // NSWindowSharingType — None opts the window out of screenshots/sharing.
    const NS_SHARING_NONE: NSUInteger = 0;
    const NS_SHARING_READ_ONLY: NSUInteger = 1;

    const NS_COLLECTION_BEHAVIOR_CAN_JOIN_ALL_SPACES: NSUInteger = 1 << 0;

    // NSProgressIndicatorStyleBar — the determinate/indeterminate bar.
    const NS_PROGRESS_INDICATOR_BAR: NSUInteger = 1;

    // NSBitmapImageFileTypePNG for representationUsingType:.
    const NS_BITMAP_FILE_TYPE_PNG: NSUInteger = 4;

    /// Set when WE hid the cursor. NSCursor's hidden count is app-global and
    /// hide/unhide must balance, so we only message AppKit when our own flag
    /// actually flips — repeat calls in either direction are no-ops.
    static CURSOR_HIDDEN_BY_US: AtomicBool = AtomicBool::new(false);

    /// (container, indicator) installed on the dock tile for setDockProgress.
    /// Retained by us for the app's lifetime — same deliberate leak-on-purpose
    /// pattern as tray.rs's status item.
    static DOCK_PROGRESS_VIEWS: Mutex<Option<(usize, usize)>> = Mutex::new(None);

    fn yes(value: BOOL) -> bool {
        value != NO
    }

    fn bool_obj(value: bool) -> BOOL {
        if value {
            YES
        } else {
            NO
        }
    }

    unsafe fn ns_to_string(string: id) -> Option<String> {
        if string.is_null() {
            return None;
        }
        let utf8: *const std::os::raw::c_char = msg_send![string, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    /// +1 NSString autoreleased into the dispatch-scoped pool.
    unsafe fn ns_string(value: &str) -> id {
        msg_send![nsstring(value), autorelease]
    }

    unsafe fn shared_app() -> id {
        msg_send![class!(NSApplication), sharedApplication]
    }

    fn require_app(op: &str) -> Result<id, PlatformError> {
        let app = unsafe { shared_app() };
        if app.is_null() {
            err(PlatformError::unavailable(format!(
                "{op}: NSApplication is not initialized"
            )))
        } else {
            Ok(app)
        }
    }

    /// The backing NSWindow. `None` means the backend isn't AppKit-backed
    /// (headless/test) — `unsupported`, not `unavailable`: no runtime
    /// precondition failed, the op can't be implemented here.
    pub(crate) fn require_nswindow(window: &Window, op: &str) -> Result<id, PlatformError> {
        match nswindow(window) {
            Some(ns_window) => Ok(ns_window),
            None => err(PlatformError::unsupported(format!(
                "window.{op}: no AppKit NSWindow backing this window"
            ))),
        }
    }

    /// The window's screen, else the primary screen. `mainScreen` is avoided
    /// on purpose — it tracks the key window and can lie about "primary".
    unsafe fn window_screen(ns_window: id) -> id {
        let screen: id = msg_send![ns_window, screen];
        if screen != nil {
            return screen;
        }
        let screens = NSScreen::screens(nil);
        if screens.count() > 0 {
            screens.objectAtIndex(0)
        } else {
            nil
        }
    }

    /// screens[0]'s height — the baseline for flipping global Cocoa y into
    /// the global top-left space JS lives in.
    fn primary_screen_height() -> Option<f64> {
        unsafe {
            let screens = NSScreen::screens(nil);
            if screens.count() == 0 {
                return None;
            }
            Some(NSScreen::frame(screens.objectAtIndex(0)).size.height)
        }
    }

    /// A Cocoa rect's top edge in gpui's position space — screen-relative,
    /// y down from the screen's top. Mirrors `MacWindow::bounds`.
    unsafe fn cocoa_rect_top_left(frame: NSRect, screen: id) -> (f64, f64) {
        let screen_frame = NSScreen::frame(screen);
        (
            frame.origin.x - screen_frame.origin.x,
            screen_frame.origin.y + screen_frame.size.height - (frame.origin.y + frame.size.height),
        )
    }

    /// `contentLayoutRect` (10.10+) — the unobscured content area inside the
    /// window's own coordinate space (origin at the frame's bottom-left).
    /// Falls back to the content view's bounds on older systems; the two are
    /// equivalent for titled windows since the content view sits at the
    /// window's origin.
    unsafe fn content_layout_rect(ns_window: id) -> NSRect {
        let supported: BOOL = msg_send![ns_window, respondsToSelector: sel!(contentLayoutRect)];
        if yes(supported) {
            return msg_send![ns_window, contentLayoutRect];
        }
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        }
        msg_send![content_view, bounds]
    }

    /// The standard window-controls cluster (macOS traffic lights) reported
    /// in **window-frame coordinates** — origin at the window's top-left
    /// corner, y down — so callers get the buttons' literal position inside
    /// the window regardless of where the drawable starts. `contentTop`
    /// carries the drawable's inset from the frame top (the titlebar's
    /// height; `0` when content underlaps it, e.g. fullSizeContentView), so
    /// content-space math is `y - contentTop`. `Null` when the window has
    /// no standard buttons (borderless popovers, hidden titlebars).
    unsafe fn controls_area(ns_window: id) -> OpResult {
        const NS_WINDOW_CLOSE_BUTTON: NSUInteger = 0;
        const NS_WINDOW_MINIATURIZE_BUTTON: NSUInteger = 1;
        // `-[NSWindow frame]` is screen-space but its height is the window's
        // own frame height — the extent of window-base coordinates.
        let win_frame: NSRect = msg_send![ns_window, frame];
        let frame_h = win_frame.size.height;
        // Distance from the frame's top edge to the drawable's top edge —
        // measured off the content view (the thing the renderer paints
        // into), NOT contentLayoutRect: the layout rect is AppKit's safe-
        // area guide and keeps excluding the titlebar even when content
        // underlaps it (fullSizeContentView → contentView spans the frame).
        let content_view: id = msg_send![ns_window, contentView];
        let content_top_inset = if content_view == nil {
            0.0
        } else {
            let cv: NSRect = msg_send![content_view, bounds];
            frame_h - (cv.origin.y + cv.size.height)
        };
        let mut buttons = serde_json::Map::new();
        let mut union: Option<NSRect> = None;
        for (name, kind) in [
            ("close", NS_WINDOW_CLOSE_BUTTON),
            ("minimize", NS_WINDOW_MINIATURIZE_BUTTON),
            ("zoom", NS_WINDOW_ZOOM_BUTTON),
        ] {
            let button: id = msg_send![ns_window, standardWindowButton: kind];
            if button == nil {
                continue;
            }
            let bounds: NSRect = msg_send![button, bounds];
            let frame: NSRect = msg_send![button, convertRect: bounds toView: nil];
            let hidden: BOOL = msg_send![button, isHiddenOrHasHiddenAncestor];
            buttons.insert(
                name.to_string(),
                json!({
                    "x": frame.origin.x,
                    "y": frame_h - (frame.origin.y + frame.size.height),
                    "width": frame.size.width,
                    "height": frame.size.height,
                    "visible": !yes(hidden),
                }),
            );
            union = Some(match union {
                None => frame,
                Some(u) => {
                    let x0 = u.origin.x.min(frame.origin.x);
                    let y0 = u.origin.y.min(frame.origin.y);
                    let x1 = (u.origin.x + u.size.width).max(frame.origin.x + frame.size.width);
                    let y1 =
                        (u.origin.y + u.size.height).max(frame.origin.y + frame.size.height);
                    NSRect::new(
                        NSPoint::new(x0, y0),
                        NSSize::new(x1 - x0, y1 - y0),
                    )
                }
            });
        }
        let Some(u) = union else {
            return ok(Value::Null);
        };
        ok(json!({
            "x": u.origin.x,
            "y": frame_h - (u.origin.y + u.size.height),
            "width": u.size.width,
            "height": u.size.height,
            "contentTop": content_top_inset,
            // Caption buttons sit on the right on Windows/Linux — `side`
            // publishes the platform convention so layouts can mirror.
            "side": "left",
            "buttons": Value::Object(buttons),
        }))
    }

    unsafe fn style_mask(ns_window: id) -> NSUInteger {
        msg_send![ns_window, styleMask]
    }

    /// `-[NSWindow setStyleMask:]` on a fullscreen window raises an
    /// uncatchable ObjC exception (AppKit assertion; Chromium/Electron
    /// guard the same way) — callers must check this first and return
    /// `unavailable` rather than aborting the process.
    unsafe fn nswindow_is_fullscreen(ns_window: id) -> bool {
        style_mask(ns_window) & NS_FULL_SCREEN != 0
    }

    unsafe fn set_mask_bit(ns_window: id, bit: NSUInteger, enabled: bool) {
        let mask = style_mask(ns_window);
        let next = if enabled { mask | bit } else { mask & !bit };
        let _: () = msg_send![ns_window, setStyleMask: next];
    }

    unsafe fn mask_has(ns_window: id, bit: NSUInteger) -> bool {
        style_mask(ns_window) & bit != 0
    }

    // ── positioning / frame ─────────────────────────────────────────

    fn set_bounds(request: &PlatformRequest, window: &mut Window) -> OpResult {
        let x = request.f64_arg("x")?;
        let y = request.f64_arg("y")?;
        let width = request.f64_arg("width")?;
        let height = request.f64_arg("height")?;
        let ns_window = require_nswindow(window, "setBounds")?;
        unsafe {
            let screen = window_screen(ns_window);
            if screen == nil {
                return err(PlatformError::unavailable(
                    "window.setBounds: window is not on a screen",
                ));
            }
            let screen_frame = NSScreen::frame(screen);
            // One atomic NSWindow frame update rather than gpui's
            // resize+set_position pair: `resize` maps to setContentSize:
            // (content area), while getBounds/outerSize report the frame —
            // setFrame:display: keeps set/getBounds talking about the same
            // rect and lands the move+resize in a single AppKit call.
            let frame = NSRect::new(
                NSPoint::new(
                    screen_frame.origin.x + x,
                    screen_frame.origin.y + screen_frame.size.height - (y + height),
                ),
                NSSize::new(width, height),
            );
            let _: () = msg_send![ns_window, setFrame: frame display: YES];
        }
        ok(Value::Null)
    }

    fn position_to(request: &PlatformRequest, window: &mut Window) -> OpResult {
        let preset = request.str_arg("preset")?;
        if !matches!(
            preset.as_str(),
            "center"
                | "trayCenter"
                | "trayLeft"
                | "trayRight"
                | "trayTop"
                | "trayBottom"
                | "cursorTopLeft"
                | "cursorBottomLeft"
        ) {
            return err(PlatformError::invalid(format!(
                "window.positionTo: unknown preset `{preset}` — expected center|trayCenter|trayLeft|trayRight|trayTop|trayBottom|cursorTopLeft|cursorBottomLeft"
            )));
        }
        let ns_window = require_nswindow(window, "positionTo")?;
        let bounds = window.bounds();
        let width = f64::from(f32::from(bounds.size.width));
        let height = f64::from(f32::from(bounds.size.height));
        unsafe {
            let screen = window_screen(ns_window);
            if screen == nil {
                return err(PlatformError::unavailable(
                    "window.positionTo: window is not on a screen",
                ));
            }
            let screen_frame = NSScreen::frame(screen);
            // Cocoa-space anchor → gpui's screen-relative top-left space.
            let to_x = |cocoa_x: f64| cocoa_x - screen_frame.origin.x;
            let to_y = |cocoa_y: f64| screen_frame.origin.y + screen_frame.size.height - cocoa_y;
            let (x, y) = match preset.as_str() {
                // Centered inside the screen's visible frame (menu bar and
                // dock excluded).
                "center" => {
                    let visible = NSScreen::visibleFrame(screen);
                    (
                        to_x(visible.origin.x + (visible.size.width - width) / 2.),
                        to_y(visible.origin.y + visible.size.height)
                            + (visible.size.height - height) / 2.,
                    )
                }
                "cursorTopLeft" | "cursorBottomLeft" => {
                    // mouseLocation is global Cocoa space — to_y/to_x converts.
                    let mouse = NSEvent::mouseLocation(nil);
                    if preset == "cursorTopLeft" {
                        (to_x(mouse.x), to_y(mouse.y))
                    } else {
                        (to_x(mouse.x), to_y(mouse.y) - height)
                    }
                }
                tray_preset => {
                    let [bx, by, bw, bh] = tray::last_button_rect().ok_or_else(|| {
                        PlatformError::unavailable(
                            "window.positionTo: tray button rect is unknown until the first tray click",
                        )
                    })?;
                    // last_button_rect is global top-left space (primary-
                    // anchored, same as CGEvent coords); re-anchor it to the
                    // window's screen before applying the preset.
                    let primary_height = primary_screen_height().ok_or_else(|| {
                        PlatformError::unavailable("window.positionTo: no screens")
                    })?;
                    let gy = |global_y: f64| {
                        global_y
                            - (primary_height - screen_frame.origin.y - screen_frame.size.height)
                    };
                    // Compass semantics on the button rect: "center" centers
                    // the window on it; the rest park the matching window
                    // edge against that side of the button.
                    match tray_preset {
                        "trayCenter" => (
                            to_x(bx + bw / 2. - width / 2.),
                            gy(by + bh / 2. - height / 2.),
                        ),
                        "trayLeft" => (to_x(bx - width), gy(by + bh / 2. - height / 2.)),
                        "trayRight" => (to_x(bx + bw), gy(by + bh / 2. - height / 2.)),
                        "trayTop" => (to_x(bx + bw / 2. - width / 2.), gy(by - height)),
                        _ => (to_x(bx + bw / 2. - width / 2.), gy(by + bh)),
                    }
                }
            };
            window.set_position(gpui::Point {
                x: gpui::px(x as f32),
                y: gpui::px(y as f32),
            });
            ok(Value::Null)
        }
    }

    // ── window-state helpers ────────────────────────────────────────

    fn set_style_flag(request: &PlatformRequest, window: &mut Window, bit: NSUInteger) -> OpResult {
        let enabled = request.bool_arg("enabled")?;
        let ns_window = require_nswindow(window, request.op.as_str())?;
        unsafe {
            if nswindow_is_fullscreen(ns_window) {
                return err(PlatformError::unavailable(format!(
                    "window.{}: styleMask cannot change while the window is fullscreen",
                    request.op
                )));
            }
            set_mask_bit(ns_window, bit, enabled);
        }
        ok(Value::Null)
    }

    fn style_flag_state(
        window: &mut Window,
        op: &str,
        bit: NSUInteger,
    ) -> Result<bool, PlatformError> {
        let ns_window = require_nswindow(window, op)?;
        Ok(unsafe { mask_has(ns_window, bit) })
    }

    // ── app ops ─────────────────────────────────────────────────────

    /// The dock-tile progress overlay, built once and kept alive in
    /// DOCK_PROGRESS_VIEWS. Mirrors Electron: app-icon image view plus an
    /// NSProgressIndicator bar inside a plain container NSView.
    unsafe fn dock_progress_indicator(dock_tile: id) -> Result<id, PlatformError> {
        let mut guard = DOCK_PROGRESS_VIEWS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(&(container, indicator)) = guard.as_ref() {
            // A prior `none` call may have detached the content view.
            let _: () = msg_send![dock_tile, setContentView: container as id];
            return Ok(indicator as id);
        }
        let tile_size: NSSize = msg_send![dock_tile, size];
        let container: id = msg_send![class!(NSView), alloc];
        let container: id = msg_send![
            container,
            initWithFrame: NSRect::new(NSPoint::new(0., 0.), tile_size)
        ];
        if container == nil {
            return err(PlatformError::internal(
                "app.setDockProgress: NSView allocation failed",
            ));
        }
        let app_icon: id = msg_send![shared_app(), applicationIconImage];
        if app_icon != nil {
            let image_view: id = msg_send![class!(NSImageView), alloc];
            let image_view: id = msg_send![
                image_view,
                initWithFrame: NSRect::new(NSPoint::new(0., 0.), tile_size)
            ];
            if image_view != nil {
                let _: () = msg_send![image_view, setImage: app_icon];
                let _: () = msg_send![container, addSubview: image_view];
                // addSubview: retains — balance our alloc's +1.
                let _: () = msg_send![image_view, release];
            }
        }
        let indicator: id = msg_send![class!(NSProgressIndicator), alloc];
        let indicator: id = msg_send![
            indicator,
            initWithFrame: NSRect::new(
                NSPoint::new(0., 0.),
                NSSize::new(tile_size.width, 15.),
            )
        ];
        if indicator == nil {
            let _: () = msg_send![container, release];
            return err(PlatformError::internal(
                "app.setDockProgress: NSProgressIndicator allocation failed",
            ));
        }
        let _: () = msg_send![indicator, setStyle: NS_PROGRESS_INDICATOR_BAR];
        let _: () = msg_send![indicator, setMinValue: 0f64];
        let _: () = msg_send![indicator, setMaxValue: 1f64];
        let _: () = msg_send![indicator, setIndeterminate: NO];
        let _: () = msg_send![indicator, setBezeled: YES];
        let _: () = msg_send![indicator, setHidden: NO];
        let _: () = msg_send![container, addSubview: indicator];
        // container/indicator are +1 and parked in the static for the app's
        // lifetime — see the DOCK_PROGRESS_VIEWS doc.
        *guard = Some((container as usize, indicator as usize));
        let _: () = msg_send![dock_tile, setContentView: container];
        Ok(indicator)
    }

    fn set_dock_progress(request: &PlatformRequest) -> OpResult {
        let status = request.str_arg("status")?;
        if !matches!(
            status.as_str(),
            "none" | "normal" | "indeterminate" | "paused" | "error"
        ) {
            return err(PlatformError::invalid(format!(
                "app.setDockProgress: unknown status `{status}` — expected none|normal|indeterminate|paused|error"
            )));
        }
        let app = require_app("app.setDockProgress")?;
        unsafe {
            let dock_tile: id = msg_send![app, dockTile];
            if dock_tile == nil {
                return err(PlatformError::unavailable(
                    "app.setDockProgress: no dock tile",
                ));
            }
            if status == "none" {
                // Removing the content view restores the plain app icon.
                let _: () = msg_send![dock_tile, setContentView: nil];
                let _: () = msg_send![dock_tile, display];
                return ok(Value::Null);
            }
            let indicator = dock_progress_indicator(dock_tile)?;
            if status == "indeterminate" {
                let _: () = msg_send![indicator, setIndeterminate: YES];
                let _: () = msg_send![indicator, startAnimation: nil];
            } else {
                // `normal`/`paused`/`error` share the determinate bar:
                // AppKit's deprecated controlTint no longer recolors progress
                // indicators, so there is no honest per-status styling —
                // `error`/`paused` just show the current value. completed/
                // total are applied only when present so a bare status change
                // doesn't blank the bar.
                let _: () = msg_send![indicator, setIndeterminate: NO];
                let _: () = msg_send![indicator, stopAnimation: nil];
                if let Some(total) = request.opt_f64("total")? {
                    let _: () = msg_send![indicator, setMaxValue: total];
                }
                if let Some(completed) = request.opt_f64("completed")? {
                    let _: () = msg_send![indicator, setDoubleValue: completed];
                }
            }
            let _: () = msg_send![dock_tile, display];
            ok(Value::Null)
        }
    }

    fn bundle_type() -> OpResult {
        unsafe {
            let bundle: id = msg_send![class!(NSBundle), mainBundle];
            let path: id = msg_send![bundle, bundlePath];
            let bundled = ns_to_string(path)
                .map(|path| path.trim_end_matches('/').ends_with(".app"))
                .unwrap_or(false);
            let bundle_type = if bundled { "app" } else { "binary" };
            ok(json!({ "type": bundle_type }))
        }
    }

    fn default_window_icon() -> OpResult {
        let app = require_app("app.defaultWindowIcon")?;
        unsafe {
            let icon: id = msg_send![app, applicationIconImage];
            if icon == nil {
                return ok(Value::Null);
            }
            let tiff: id = msg_send![icon, TIFFRepresentation];
            if tiff == nil {
                return ok(Value::Null);
            }
            let rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            if rep == nil {
                return ok(Value::Null);
            }
            let empty: id = msg_send![class!(NSDictionary), dictionary];
            let png: id = msg_send![
                rep,
                representationUsingType: NS_BITMAP_FILE_TYPE_PNG
                properties: empty
            ];
            if png == nil {
                return ok(Value::Null);
            }
            let bytes: *const u8 = msg_send![png, bytes];
            let length: NSUInteger = msg_send![png, length];
            if bytes.is_null() || length == 0 {
                return ok(Value::Null);
            }
            let data = std::slice::from_raw_parts(bytes, length as usize);
            ok(json!({
                "pngBase64": base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    data,
                )
            }))
        }
    }

    // ── dispatch ────────────────────────────────────────────────────

    pub fn call(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
    ) -> OpResult {
        // Every ObjC object touched below is either autoreleased or retained
        // on purpose — the pool drains the autoreleased side on the way out.
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let result = dispatch(request, view_window);
        unsafe { pool.drain() };
        result
    }

    pub fn call_app(request: &PlatformRequest) -> OpResult {
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let result = dispatch_app(request);
        unsafe { pool.drain() };
        result
    }

    fn dispatch_app(request: &PlatformRequest) -> OpResult {
        match request.op.as_str() {
            "setDockProgress" => set_dock_progress(request),
            "getBundleType" => bundle_type(),
            "defaultWindowIcon" => default_window_icon(),
            op => err(PlatformError {
                code: "unknown",
                message: format!("window_ext does not implement app.{op}"),
            }),
        }
    }

    fn dispatch(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
    ) -> OpResult {
        match request.op.as_str() {
            // macOS has no public per-window canBecomeKeyWindow setter —
            // focusability is fixed by the window class and styleMask at
            // creation. Answered before the window check on purpose.
            "setFocusable" => err(PlatformError::unsupported(
                "window.setFocusable: no per-window focusable setter on macOS",
            )),
            // App-global cursor ops don't need an open window.
            "setCursorHidden" => {
                let hidden = request.bool_arg("hidden")?;
                // Only message NSCursor when OUR flag flips — its hidden
                // count is app-global and unbalanced calls skew it.
                if hidden != CURSOR_HIDDEN_BY_US.swap(hidden, Ordering::SeqCst) {
                    unsafe {
                        if hidden {
                            let _: () = msg_send![class!(NSCursor), hide];
                        } else {
                            let _: () = msg_send![class!(NSCursor), unhide];
                        }
                    }
                }
                ok(Value::Null)
            }
            "setCursorPosition" => {
                let x = request.f64_arg("x")?;
                let y = request.f64_arg("y")?;
                CGDisplay::warp_mouse_cursor_position(CGPoint::new(x, y)).map_err(|code| {
                    PlatformError::internal(format!(
                        "window.setCursorPosition: CGWarpMouseCursorPosition failed ({code})"
                    ))
                })?;
                ok(Value::Null)
            }
            op => dispatch_window(request, view_window, op),
        }
    }

    fn dispatch_window(
        request: &PlatformRequest,
        view_window: Option<(&mut GpuixView, &mut Window)>,
        op: &str,
    ) -> OpResult {
        match op {
            // ── positioning / frame ─────────────────────────────────
            "center" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "center")?;
                unsafe {
                    let _: () = msg_send![ns_window, center];
                }
                ok(Value::Null)
            })?,
            "hide" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "hide")?;
                unsafe {
                    let _: () = msg_send![ns_window, orderOut: nil];
                }
                ok(Value::Null)
            })?,
            "show" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "show")?;
                unsafe {
                    let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
                }
                ok(Value::Null)
            })?,
            "setBounds" => {
                with_window(view_window, op, |_view, window| set_bounds(request, window))?
            }
            "innerSize" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "innerSize")?;
                let layout = unsafe { content_layout_rect(ns_window) };
                ok(json!({
                    "width": layout.size.width,
                    "height": layout.size.height,
                }))
            })?,
            "innerPosition" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "innerPosition")?;
                unsafe {
                    let screen = window_screen(ns_window);
                    if screen == nil {
                        return err(PlatformError::unavailable(
                            "window.innerPosition: window is not on a screen",
                        ));
                    }
                    let frame: NSRect = msg_send![ns_window, frame];
                    // contentLayoutRect is in the window's own coordinate
                    // space — offset it into screen space by the frame.
                    let layout = content_layout_rect(ns_window);
                    let content = NSRect::new(
                        NSPoint::new(
                            frame.origin.x + layout.origin.x,
                            frame.origin.y + layout.origin.y,
                        ),
                        layout.size,
                    );
                    let (x, y) = cocoa_rect_top_left(content, screen);
                    ok(json!({ "x": x, "y": y }))
                }
            })?,
            "outerSize" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "outerSize")?;
                let frame: NSRect = unsafe { msg_send![ns_window, frame] };
                ok(json!({
                    "width": frame.size.width,
                    "height": frame.size.height,
                }))
            })?,
            "outerPosition" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "outerPosition")?;
                unsafe {
                    let screen = window_screen(ns_window);
                    if screen == nil {
                        return err(PlatformError::unavailable(
                            "window.outerPosition: window is not on a screen",
                        ));
                    }
                    let frame: NSRect = msg_send![ns_window, frame];
                    let (x, y) = cocoa_rect_top_left(frame, screen);
                    ok(json!({ "x": x, "y": y }))
                }
            })?,
            "controlsArea" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "controlsArea")?;
                unsafe { controls_area(ns_window) }
            })?,
            "positionTo" => with_window(view_window, op, |_view, window| {
                position_to(request, window)
            })?,
            // Electron semantics: deminiaturize if miniaturized, else unzoom
            // if zoomed.
            "restore" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "restore")?;
                unsafe {
                    let miniaturized: BOOL = msg_send![ns_window, isMiniaturized];
                    if yes(miniaturized) {
                        let _: () = msg_send![ns_window, deminiaturize: nil];
                    } else {
                        let zoomed: BOOL = msg_send![ns_window, isZoomed];
                        if yes(zoomed) {
                            let _: () = msg_send![ns_window, zoom: nil];
                        }
                    }
                }
                ok(Value::Null)
            })?,

            // ── state ───────────────────────────────────────────────
            // minimize/toggleMaximize/isMaximized/toggleFullscreen/isActive
            // are shadowed by window_svc's earlier arms — implemented here
            // anyway so this module stays correct if routing ever changes.
            "minimize" => with_window(view_window, op, |_view, window| {
                window.minimize_window();
                ok(Value::Null)
            })?,
            "unminimize" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "unminimize")?;
                unsafe {
                    let _: () = msg_send![ns_window, deminiaturize: nil];
                }
                ok(Value::Null)
            })?,
            "isMinimized" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "isMinimized")?;
                let minimized: BOOL = unsafe { msg_send![ns_window, isMiniaturized] };
                ok(json!({ "minimized": yes(minimized) }))
            })?,
            "toggleMaximize" => with_window(view_window, op, |_view, window| {
                let maximized = window.is_maximized();
                window.zoom_window();
                ok(json!({ "maximized": !maximized }))
            })?,
            "isMaximized" => with_window(view_window, op, |_view, window| {
                ok(json!({ "maximized": window.is_maximized() }))
            })?,
            "toggleFullscreen" => with_window(view_window, op, |_view, window| {
                let fullscreen = window.is_fullscreen();
                window.toggle_fullscreen();
                ok(json!({ "fullscreen": !fullscreen }))
            })?,
            "setSimpleFullscreen" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    if window.is_simple_fullscreen() != enabled {
                        window.toggle_simple_fullscreen();
                    }
                    ok(Value::Null)
                })?
            }
            "isSimpleFullscreen" => with_window(view_window, op, |_view, window| {
                ok(json!({ "simpleFullscreen": window.is_simple_fullscreen() }))
            })?,
            "setAlwaysOnTop" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setAlwaysOnTop")?;
                    let level = unsafe {
                        CGWindowLevelForKey(if enabled {
                            K_CG_FLOATING_WINDOW_LEVEL_KEY
                        } else {
                            K_CG_NORMAL_WINDOW_LEVEL_KEY
                        }) as NSInteger
                    };
                    unsafe {
                        let _: () = msg_send![ns_window, setLevel: level];
                    }
                    ok(Value::Null)
                })?
            }
            "setAlwaysOnBottom" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setAlwaysOnBottom")?;
                    // One step below normal — under ordinary windows but still
                    // clickable. A true desktop level (kCGDesktopWindowLevel)
                    // would sink it behind desktop icons where it can't be
                    // focused again; that's a launcher, not a window state.
                    let normal =
                        unsafe { CGWindowLevelForKey(K_CG_NORMAL_WINDOW_LEVEL_KEY) as NSInteger };
                    let level = if enabled { normal - 1 } else { normal };
                    unsafe {
                        let _: () = msg_send![ns_window, setLevel: level];
                    }
                    ok(Value::Null)
                })?
            }
            "blur" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "blur")?;
                unsafe {
                    let _: () = msg_send![ns_window, resignKeyWindow];
                }
                ok(Value::Null)
            })?,
            // On macOS gpui defines "hovered" as the window owning the cursor,
            // which it equates to active — see Window::is_window_hovered.
            "isHovered" => with_window(view_window, op, |_view, window| {
                ok(json!({ "hovered": window.is_window_hovered() }))
            })?,
            // `isActive` is answered earlier in `window_svc` (bare bool, shared
            // with isFocused) — no arm here or it would be dead code.

            // ── chrome flags (styleMask) ────────────────────────────
            "setResizable" => with_window(view_window, op, |_view, window| {
                set_style_flag(request, window, NS_RESIZABLE)
            })?,
            "isResizable" => with_window(view_window, op, |_view, window| {
                let resizable = style_flag_state(window, "isResizable", NS_RESIZABLE)?;
                ok(json!({ "resizable": resizable }))
            })?,
            "setClosable" => with_window(view_window, op, |_view, window| {
                set_style_flag(request, window, NS_CLOSABLE)
            })?,
            "isClosable" => with_window(view_window, op, |_view, window| {
                let closable = style_flag_state(window, "isClosable", NS_CLOSABLE)?;
                ok(json!({ "closable": closable }))
            })?,
            "setMinimizable" => with_window(view_window, op, |_view, window| {
                set_style_flag(request, window, NS_MINIATURIZABLE)
            })?,
            "isMinimizable" => with_window(view_window, op, |_view, window| {
                let minimizable = style_flag_state(window, "isMinimizable", NS_MINIATURIZABLE)?;
                ok(json!({ "minimizable": minimizable }))
            })?,
            // styleMask has no zoom bit — the zoom BUTTON is toggled instead.
            "setMaximizable" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setMaximizable")?;
                    unsafe {
                        let button: id = msg_send![
                            ns_window,
                            standardWindowButton: NS_WINDOW_ZOOM_BUTTON
                        ];
                        if button == nil {
                            return err(PlatformError::unavailable(
                                "window.setMaximizable: window has no zoom button",
                            ));
                        }
                        let _: () = msg_send![button, setEnabled: bool_obj(enabled)];
                    }
                    ok(Value::Null)
                })?
            }
            "isMaximizable" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "isMaximizable")?;
                unsafe {
                    let button: id = msg_send![
                        ns_window,
                        standardWindowButton: NS_WINDOW_ZOOM_BUTTON
                    ];
                    let enabled: BOOL = if button == nil {
                        NO
                    } else {
                        msg_send![button, isEnabled]
                    };
                    ok(json!({ "maximizable": yes(enabled) }))
                }
            })?,
            "setTitleBarStyle" => {
                let style = request.str_arg("style")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setTitleBarStyle")?;
                    unsafe {
                        if nswindow_is_fullscreen(ns_window) {
                            return err(PlatformError::unavailable(
                                "window.setTitleBarStyle: styleMask cannot change while the window is fullscreen",
                            ));
                        }
                        match style.as_str() {
                            "default" => {
                                let _: () = msg_send![
                                    ns_window,
                                    setTitlebarAppearsTransparent: NO
                                ];
                                let _: () = msg_send![
                                    ns_window,
                                    setTitleVisibility: NS_TITLE_VISIBLE
                                ];
                                set_mask_bit(ns_window, NS_FULL_SIZE_CONTENT_VIEW, false);
                            }
                            "transparent" => {
                                let _: () = msg_send![
                                    ns_window,
                                    setTitlebarAppearsTransparent: YES
                                ];
                                let _: () = msg_send![
                                    ns_window,
                                    setTitleVisibility: NS_TITLE_VISIBLE
                                ];
                            }
                            // `hidden` and `hiddenInset` share the same flags
                            // — the inset's traffic-light offset needs a
                            // position this contract doesn't carry, so it's
                            // documented rather than guessed. FullSizeContent-
                            // View lets content extend under the titlebar.
                            "hidden" | "hiddenInset" => {
                                let _: () = msg_send![
                                    ns_window,
                                    setTitleVisibility: NS_TITLE_HIDDEN
                                ];
                                let _: () = msg_send![
                                    ns_window,
                                    setTitlebarAppearsTransparent: YES
                                ];
                                set_mask_bit(ns_window, NS_FULL_SIZE_CONTENT_VIEW, true);
                            }
                            other => {
                                return err(PlatformError::invalid(format!(
                                    "window.setTitleBarStyle: unknown style `{other}` — expected default|transparent|hidden|hiddenInset"
                                )))
                            }
                        }
                    }
                    ok(Value::Null)
                })?
            }
            "setDecorations" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setDecorations")?;
                    unsafe {
                        if nswindow_is_fullscreen(ns_window) {
                            return err(PlatformError::unavailable(
                                "window.setDecorations: styleMask cannot change while the window is fullscreen",
                            ));
                        }
                        let mask = style_mask(ns_window);
                        let next = if enabled {
                            // Restore the standard decorated set. Unrelated
                            // bits (Unified, FullScreen, a panel's Nonactivat-
                            // ing) are preserved.
                            mask | NS_TITLED
                                | NS_CLOSABLE
                                | NS_MINIATURIZABLE
                                | NS_RESIZABLE
                                | NS_FULL_SIZE_CONTENT_VIEW
                                | NS_TEXTURED_BACKGROUND
                        } else {
                            // Borderless — strip only the decoration bits.
                            mask & !(NS_TITLED
                                | NS_CLOSABLE
                                | NS_MINIATURIZABLE
                                | NS_RESIZABLE
                                | NS_FULL_SIZE_CONTENT_VIEW)
                        };
                        let _: () = msg_send![ns_window, setStyleMask: next];
                    }
                    ok(Value::Null)
                })?
            }
            "setHasShadow" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setHasShadow")?;
                    unsafe {
                        let _: () = msg_send![ns_window, setHasShadow: bool_obj(enabled)];
                        // AppKit caches shadows — invalidate so the change
                        // shows on the next display pass.
                        let _: () = msg_send![ns_window, invalidateShadow];
                    }
                    ok(Value::Null)
                })?
            }
            "invalidateShadow" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "invalidateShadow")?;
                unsafe {
                    let _: () = msg_send![ns_window, invalidateShadow];
                }
                ok(Value::Null)
            })?,
            "setOpacity" => {
                let opacity = request.f64_arg("opacity")?;
                if !(0.0..=1.0).contains(&opacity) {
                    return err(PlatformError::invalid(
                        "window.setOpacity: `opacity` must be between 0 and 1",
                    ));
                }
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setOpacity")?;
                    unsafe {
                        let _: () = msg_send![ns_window, setAlphaValue: opacity];
                    }
                    ok(Value::Null)
                })?
            }
            "getOpacity" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "getOpacity")?;
                let opacity: f64 = unsafe { msg_send![ns_window, alphaValue] };
                ok(json!({ "opacity": opacity }))
            })?,
            "setMovable" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setMovable")?;
                    unsafe {
                        let _: () = msg_send![ns_window, setMovable: bool_obj(enabled)];
                    }
                    ok(Value::Null)
                })?
            }
            "setMovableByWindowBackground" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setMovableByWindowBackground")?;
                    unsafe {
                        let _: () = msg_send![
                            ns_window,
                            setMovableByWindowBackground: bool_obj(enabled)
                        ];
                    }
                    ok(Value::Null)
                })?
            }
            "setIgnoresMouseEvents" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setIgnoresMouseEvents")?;
                    unsafe {
                        let _: () = msg_send![
                            ns_window,
                            setIgnoresMouseEvents: bool_obj(enabled)
                        ];
                    }
                    ok(Value::Null)
                })?
            }
            "ignoresMouseEvents" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "ignoresMouseEvents")?;
                let ignored: BOOL = unsafe { msg_send![ns_window, ignoresMouseEvents] };
                ok(json!({ "ignored": yes(ignored) }))
            })?,
            // NSWindowSharingNone opts the window out of screenshots and
            // screen sharing entirely.
            "setContentProtected" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setContentProtected")?;
                    let sharing = if enabled {
                        NS_SHARING_NONE
                    } else {
                        NS_SHARING_READ_ONLY
                    };
                    unsafe {
                        let _: () = msg_send![ns_window, setSharingType: sharing];
                    }
                    ok(Value::Null)
                })?
            }
            "isContentProtected" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "isContentProtected")?;
                let sharing: NSUInteger = unsafe { msg_send![ns_window, sharingType] };
                ok(json!({ "contentProtected": sharing == NS_SHARING_NONE }))
            })?,
            "setVisibleOnAllWorkspaces" => {
                let enabled = request.bool_arg("enabled")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setVisibleOnAllWorkspaces")?;
                    unsafe {
                        let behavior: NSUInteger = msg_send![ns_window, collectionBehavior];
                        let next = if enabled {
                            behavior | NS_COLLECTION_BEHAVIOR_CAN_JOIN_ALL_SPACES
                        } else {
                            behavior & !NS_COLLECTION_BEHAVIOR_CAN_JOIN_ALL_SPACES
                        };
                        let _: () = msg_send![ns_window, setCollectionBehavior: next];
                    }
                    ok(Value::Null)
                })?
            }
            // Size constraints — `setMinSize:`/`setMaxSize:` take outer-frame
            // dimensions matching the rest of the window API. `{0,0}` clears
            // (NSSize{0,0} = no constraint, AppKit convention).
            "setMinSize" | "setMaxSize" => {
                let width = request
                    .args
                    .get("width")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let height = request
                    .args
                    .get("height")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if width < 0.0 || height < 0.0 {
                    return err(PlatformError::invalid(format!(
                        "window.{op}: width/height must be >= 0 (0 clears the constraint)"
                    )));
                }
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, op)?;
                    unsafe {
                        let size = NSSize::new(width, height);
                        if op == "setMinSize" {
                            let _: () = msg_send![ns_window, setMinSize: size];
                        } else {
                            let _: () = msg_send![ns_window, setMaxSize: size];
                        }
                    }
                    ok(Value::Null)
                })?
            }
            // `setEdited` is a contract alias for `setDocumentEdited`.
            "setDocumentEdited" | "setEdited" => {
                let edited = request.bool_arg("edited")?;
                with_window(view_window, op, |_view, window| {
                    // gpui's setter also restores the traffic-light inset
                    // that setDocumentEdited: resets.
                    window.set_window_edited(edited);
                    ok(Value::Null)
                })?
            }
            "isDocumentEdited" => with_window(view_window, op, |_view, window| {
                let ns_window = require_nswindow(window, "isDocumentEdited")?;
                let edited: BOOL = unsafe { msg_send![ns_window, isDocumentEdited] };
                ok(json!({ "edited": yes(edited) }))
            })?,

            // ── theme ───────────────────────────────────────────────
            "setTheme" => {
                let theme = request.str_arg("theme")?;
                with_window(view_window, op, |_view, window| {
                    let ns_window = require_nswindow(window, "setTheme")?;
                    unsafe {
                        let appearance = match theme.as_str() {
                            // nil → the window follows the app's appearance.
                            "system" => nil,
                            "light" | "dark" => {
                                let name = if theme == "dark" {
                                    "NSAppearanceNameDarkAqua"
                                } else {
                                    "NSAppearanceNameAqua"
                                };
                                let appearance: id = msg_send![
                                    class!(NSAppearance),
                                    appearanceNamed: ns_string(name)
                                ];
                                if appearance == nil {
                                    return err(PlatformError::unavailable(format!(
                                        "window.setTheme: NSAppearance `{name}` is unavailable"
                                    )));
                                }
                                appearance
                            }
                            other => {
                                return err(PlatformError::invalid(format!(
                                    "window.setTheme: unknown theme `{other}` — expected light|dark|system"
                                )))
                            }
                        };
                        let _: () = msg_send![ns_window, setAppearance: appearance];
                    }
                    ok(Value::Null)
                })?
            }

            other => err(PlatformError {
                code: "unknown",
                message: format!("window_ext does not implement window.{other}"),
            }),
        }
    }
}
