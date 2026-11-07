//! Screen capture — `capture.*` service. `requestPermission` under
//! `system.*` (permissions.rs) is the gate; ScreenCaptureKit needs the
//! screen-recording TCC grant on macOS 12.3+.
//!
//! Contract:
//!   `capture.isSupported` → `{supported}`
//!   `capture.getSources {types?}` →
//!       `[{id, type, label, isMain, resolution:{width,height}}]`
//!       (pending lane — async `SCShareableContent` query).
//!       `types` ⊂ `["display","window","application"]`, defaults to all
//!       three. `type`/`bundleIdentifier` are extra fields the original
//!       gpui-backed contract did not emit — gpui's source metadata has no
//!       kind field, but SCShareableContent splits the arrays itself so
//!       the kind is free information.
//!   `capture.captureSource {id, type?}` → `{width, height, pngBase64}`
//!       (pending lane; `unavailable` on macOS < 14 without
//!       `SCScreenshotManager`). `type` narrows the id namespace —
//!       displayID/windowID/pid can collide, so pass it when known.
//!   `capture.stream` / `capture.captureWindow` → `unsupported`
//!       (frame streaming needs SCStream — not this pass).
//!
//! Implementation note: the gpui build has `screen-capture` compiled OUT
//! (native/Cargo.toml enables `font-kit`+`profiler` only, and
//! `gpui/src/platform.rs` gates every capture impl behind that feature),
//! so `cx.is_screen_capture_supported()` would always report false and
//! `cx.screen_capture_sources()` resolves to
//! "compiled without the screen-capture feature". The platform hook is
//! dead code here — `SCShareableContent` is driven directly instead. The
//! stale `mod capture` in platform.rs should be deleted once dispatch
//! is confirmed to route `capture` here only.

use super::*;

pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
    #[cfg(target_os = "macos")]
    return imp::call(request, cx);
    #[cfg(not(target_os = "macos"))]
    reply(err(PlatformError::unsupported(format!(
        "capture.{} is only implemented on macOS",
        request.op
    ))))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use base64::Engine as _;
    use block::ConcreteBlock;
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSInteger, NSRect, NSString, NSUInteger};
    use core_graphics::display::CGMainDisplayID;
    use futures::channel::oneshot;
    use objc::runtime::Class;
    use objc::{class, msg_send, sel, sel_impl};
    use std::collections::HashMap;
    use std::ffi::CStr;
    use std::os::raw::{c_char, c_void};
    use std::sync::{Arc, Mutex, OnceLock};

    /// NSBitmapImageFileTypePNG.
    const NS_BITMAP_FILE_TYPE_PNG: NSUInteger = 4;
    const RTLD_NOW: i32 = 2;
    const SCREEN_CAPTURE_KIT_PATH: &[u8] =
        b"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit\0";

    // CGImageGetWidth/Height — core-graphics 0.24 keeps them behind the
    // CGImage wrapper; the raw FFI takes the same pointer slot.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
    }

    extern "C" {
        fn dlopen(path: *const c_char, mode: i32) -> *mut c_void;
    }

    /// Result channel handed to ObjC completion blocks (permissions.rs
    /// carries the same pattern). Blocks fire once on framework queues;
    /// `Mutex<Option>` makes the send once-only.
    type SharedSender = Arc<Mutex<Option<oneshot::Sender<OpResult>>>>;

    fn send_result(sender: &SharedSender, result: OpResult) {
        if let Ok(mut guard) = sender.lock() {
            if let Some(tx) = guard.take() {
                tx.send(result).ok();
            }
        }
    }

    /// Kick off an async capture flow: `kickoff` must eventually call
    /// `send_result` from a completion block; the spawned task reports it
    /// as `platformResult` carrying `id`.
    fn spawn_pending(
        cx: &mut App,
        id: u64,
        kickoff: impl FnOnce(SharedSender) + 'static,
    ) -> Outcome {
        let (tx, rx) = oneshot::channel();
        kickoff(Arc::new(Mutex::new(Some(tx))));
        cx.spawn(async move |_cx| {
            resolve_pending(
                id,
                match rx.await {
                    Ok(result) => result,
                    Err(_) => err(PlatformError::internal(
                        "capture op finished without a result",
                    )),
                },
            );
        })
        .detach();
        Outcome::Pending
    }

    fn yes(value: BOOL) -> bool {
        value != NO
    }

    unsafe fn ns_to_string(string: id) -> Option<String> {
        if string.is_null() {
            return None;
        }
        let utf8: *const c_char = msg_send![string, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    unsafe fn ns_error_message(error: id) -> String {
        if error.is_null() {
            return "unknown error".to_string();
        }
        let description: id = msg_send![error, localizedDescription];
        ns_to_string(description).unwrap_or_else(|| "unknown error".to_string())
    }

    // ── availability ─────────────────────────────────────────────────

    /// ScreenCaptureKit is 12.3+; the deployment target is lower, so the
    /// framework is dlopen'd rather than `#[link]`ed — a strong link would
    /// abort the process at launch on older systems. Once loaded,
    /// `Class::get` finds the classes; a missing SCShareableContent means
    /// the OS predates the API.
    fn ensure_screen_capture_kit() -> bool {
        static LOADED: OnceLock<bool> = OnceLock::new();
        *LOADED.get_or_init(|| unsafe {
            !dlopen(SCREEN_CAPTURE_KIT_PATH.as_ptr() as *const c_char, RTLD_NOW).is_null()
        })
    }

    fn shareable_content_class() -> Option<&'static Class> {
        if !ensure_screen_capture_kit() {
            return None;
        }
        Class::get("SCShareableContent")
    }

    fn is_supported() -> bool {
        shareable_content_class().is_some()
    }

    fn screenshot_manager_available() -> bool {
        ensure_screen_capture_kit()
            && Class::get("SCScreenshotManager").is_some()
            && Class::get("SCScreenshotConfiguration").is_some()
    }

    // ── source labels ────────────────────────────────────────────────

    /// displayID → NSScreen.localizedName ("Built-in Retina Display",
    /// "DELL U2720Q", …). NSScreen is main-thread-only AppKit, so this
    /// map is built inside `call` — which runs on the UI thread — and
    /// moved into the completion block.
    unsafe fn display_labels() -> HashMap<u32, String> {
        let mut labels = HashMap::new();
        let screens = NSScreen::screens(nil);
        if screens.is_null() {
            return labels;
        }
        let key = NSString::alloc(nil).init_str("NSScreenNumber");
        if key.is_null() {
            return labels;
        }
        for i in 0..screens.count() {
            let screen = screens.objectAtIndex(i);
            if screen.is_null() {
                continue;
            }
            let description: id = msg_send![screen, deviceDescription];
            if description.is_null() {
                continue;
            }
            let number: id = msg_send![description, objectForKey: key];
            if number.is_null() {
                continue;
            }
            let display_id: u32 = msg_send![number, unsignedIntValue];
            let name: id = msg_send![screen, localizedName];
            if let Some(name) = ns_to_string(name) {
                labels.insert(display_id, name);
            }
        }
        let _: () = msg_send![key, release];
        labels
    }

    // ── getSources ───────────────────────────────────────────────────

    #[derive(Clone, Copy)]
    struct SourceKinds {
        displays: bool,
        windows: bool,
        applications: bool,
    }

    fn parse_types(request: &PlatformRequest) -> Result<SourceKinds, PlatformError> {
        let all = SourceKinds {
            displays: true,
            windows: true,
            applications: true,
        };
        let Some(types) = request.args.get("types") else {
            return Ok(all);
        };
        let Some(items) = types.as_array() else {
            return err(PlatformError::invalid(
                "capture.getSources: `types` must be an array of \"display\"|\"window\"|\"application\"",
            ));
        };
        let mut kinds = SourceKinds {
            displays: false,
            windows: false,
            applications: false,
        };
        for item in items {
            match item.as_str() {
                Some("display") => kinds.displays = true,
                Some("window") => kinds.windows = true,
                Some("application") => kinds.applications = true,
                Some(other) => {
                    return err(PlatformError::invalid(format!(
                        "capture.getSources: unknown source type `{other}`"
                    )))
                }
                None => {
                    return err(PlatformError::invalid(
                        "capture.getSources: `types` entries must be strings",
                    ))
                }
            }
        }
        Ok(kinds)
    }

    /// Reads the SCShareableContent snapshot inside the completion block.
    /// The SC* objects are immutable snapshots — property reads from a
    /// GCD queue are safe; NSScreen/AppKit lookups are not, which is why
    /// `labels` was prefetched on the UI thread.
    unsafe fn collect_sources(
        content: id,
        kinds: SourceKinds,
        labels: &HashMap<u32, String>,
    ) -> OpResult {
        let mut sources = Vec::new();
        if kinds.displays {
            let displays: id = msg_send![content, displays];
            let count: NSUInteger = msg_send![displays, count];
            for i in 0..count {
                let display: id = msg_send![displays, objectAtIndex: i];
                if display.is_null() {
                    continue;
                }
                let display_id: u32 = msg_send![display, displayID];
                // SCDisplay.width/height are the display's pixel dims.
                let width: NSInteger = msg_send![display, width];
                let height: NSInteger = msg_send![display, height];
                let label = labels
                    .get(&display_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Display {display_id}"));
                sources.push(json!({
                    "id": display_id,
                    "type": "display",
                    "label": label,
                    "isMain": display_id == CGMainDisplayID(),
                    "resolution": { "width": width, "height": height },
                }));
            }
        }
        if kinds.windows {
            let windows: id = msg_send![content, windows];
            let count: NSUInteger = msg_send![windows, count];
            for i in 0..count {
                let window: id = msg_send![windows, objectAtIndex: i];
                if window.is_null() {
                    continue;
                }
                let window_id: u32 = msg_send![window, windowID];
                let title: id = msg_send![window, title];
                // Untitled windows are common — fall back to the owner's
                // name so the source is still identifiable.
                let mut label = ns_to_string(title).filter(|t| !t.is_empty());
                if label.is_none() {
                    let owner: id = msg_send![window, owningApplication];
                    if !owner.is_null() {
                        let name: id = msg_send![owner, applicationName];
                        label = ns_to_string(name);
                    }
                }
                // SCWindow.frame is in screen points — pixels need the
                // display's backing factor, which the snapshot doesn't
                // carry; points are the honest value.
                let frame: NSRect = msg_send![window, frame];
                let label = label.unwrap_or_else(|| format!("Window {window_id}"));
                sources.push(json!({
                    "id": window_id,
                    "type": "window",
                    "label": label,
                    "isMain": false,
                    "resolution": {
                        "width": frame.size.width,
                        "height": frame.size.height,
                    },
                }));
            }
        }
        if kinds.applications {
            let applications: id = msg_send![content, applications];
            let count: NSUInteger = msg_send![applications, count];
            for i in 0..count {
                let application: id = msg_send![applications, objectAtIndex: i];
                if application.is_null() {
                    continue;
                }
                let pid: i32 = msg_send![application, processID];
                let name: id = msg_send![application, applicationName];
                let bundle: id = msg_send![application, bundleIdentifier];
                let label = ns_to_string(name)
                    .or_else(|| ns_to_string(bundle))
                    .unwrap_or_else(|| format!("Process {pid}"));
                sources.push(json!({
                    "id": pid,
                    "type": "application",
                    "label": label,
                    "bundleIdentifier": ns_to_string(bundle),
                    "isMain": false,
                    // An app has no single resolution — the capture would
                    // be of the display filtered to its windows.
                    "resolution": { "width": 0, "height": 0 },
                }));
            }
        }
        ok(json!(sources))
    }

    fn get_sources(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let kinds = match parse_types(request) {
            Ok(kinds) => kinds,
            Err(e) => return reply(err(e)),
        };
        let Some(content_class) = shareable_content_class() else {
            return reply(err(PlatformError::unavailable(
                "capture.getSources requires macOS 12.3+ (SCShareableContent)",
            )));
        };
        let labels = unsafe { display_labels() };
        spawn_pending(cx, request.id, move |sender| unsafe {
            let block = ConcreteBlock::new(move |content: id, error: id| {
                let pool = NSAutoreleasePool::new(nil);
                let result = if content.is_null() || !error.is_null() {
                    err(PlatformError::unavailable(format!(
                        "capture.getSources: {}",
                        ns_error_message(error)
                    )))
                } else {
                    collect_sources(content, kinds, &labels)
                };
                pool.drain();
                send_result(&sender, result);
            });
            let block = block.copy();
            let _: () = msg_send![
                content_class,
                getShareableContentExcludingDesktopWindows: YES
                               onScreenWindowsOnly: YES
                                 completionHandler: block
            ];
        })
    }

    // ── captureSource ────────────────────────────────────────────────

    #[derive(Clone, Copy)]
    enum SourceKind {
        Display,
        Window,
        Application,
    }

    fn parse_kind(request: &PlatformRequest) -> Result<Option<SourceKind>, PlatformError> {
        match request.opt_str("type").as_deref() {
            None => Ok(None),
            Some("display") => Ok(Some(SourceKind::Display)),
            Some("window") => Ok(Some(SourceKind::Window)),
            Some("application") => Ok(Some(SourceKind::Application)),
            Some(other) => err(PlatformError::invalid(format!(
                "capture.captureSource: unknown type `{other}` — expected display|window|application"
            ))),
        }
    }

    /// First display wins when no display matches CGMainDisplayID —
    /// SCShareableContent only returns capturable (online) displays.
    unsafe fn pick_display(content: id) -> id {
        let displays: id = msg_send![content, displays];
        let count: NSUInteger = msg_send![displays, count];
        let mut first: id = nil;
        let main = CGMainDisplayID();
        for i in 0..count {
            let display: id = msg_send![displays, objectAtIndex: i];
            if display.is_null() {
                continue;
            }
            if first.is_null() {
                first = display;
            }
            let display_id: u32 = msg_send![display, displayID];
            if display_id == main {
                return display;
            }
        }
        first
    }

    /// Builds a +1 SCContentFilter around the matching shareable object.
    /// Callers release it inside the capture completion block.
    unsafe fn build_filter(
        content: id,
        target: u32,
        kind: Option<SourceKind>,
        filter_class: &Class,
    ) -> Result<id, PlatformError> {
        let empty: id = msg_send![class!(NSArray), array];
        if matches!(kind, None | Some(SourceKind::Display)) {
            let displays: id = msg_send![content, displays];
            let count: NSUInteger = msg_send![displays, count];
            for i in 0..count {
                let display: id = msg_send![displays, objectAtIndex: i];
                if display.is_null() {
                    continue;
                }
                let display_id: u32 = msg_send![display, displayID];
                if display_id != target {
                    continue;
                }
                let filter: id = msg_send![filter_class, alloc];
                if filter.is_null() {
                    return err(PlatformError::internal(
                        "capture.captureSource: SCContentFilter alloc failed",
                    ));
                }
                let filter: id = msg_send![
                    filter,
                    initWithDisplay: display
                    excludingWindows: empty
                ];
                return if filter.is_null() {
                    err(PlatformError::internal(
                        "capture.captureSource: SCContentFilter init failed",
                    ))
                } else {
                    Ok(filter)
                };
            }
        }
        if matches!(kind, None | Some(SourceKind::Window)) {
            let windows: id = msg_send![content, windows];
            let count: NSUInteger = msg_send![windows, count];
            for i in 0..count {
                let window: id = msg_send![windows, objectAtIndex: i];
                if window.is_null() {
                    continue;
                }
                let window_id: u32 = msg_send![window, windowID];
                if window_id != target {
                    continue;
                }
                let filter: id = msg_send![filter_class, alloc];
                if filter.is_null() {
                    return err(PlatformError::internal(
                        "capture.captureSource: SCContentFilter alloc failed",
                    ));
                }
                let filter: id = msg_send![filter, initWithDesktopIndependentWindow: window];
                return if filter.is_null() {
                    err(PlatformError::internal(
                        "capture.captureSource: SCContentFilter init failed",
                    ))
                } else {
                    Ok(filter)
                };
            }
        }
        if matches!(kind, None | Some(SourceKind::Application)) {
            let applications: id = msg_send![content, applications];
            let count: NSUInteger = msg_send![applications, count];
            for i in 0..count {
                let application: id = msg_send![applications, objectAtIndex: i];
                if application.is_null() {
                    continue;
                }
                let pid: i32 = msg_send![application, processID];
                if pid as u32 != target {
                    continue;
                }
                let display = pick_display(content);
                if display.is_null() {
                    return err(PlatformError::unavailable(
                        "capture.captureSource: no display to host the application filter",
                    ));
                }
                let apps: id = msg_send![class!(NSArray), arrayWithObject: application];
                if apps.is_null() {
                    return err(PlatformError::internal(
                        "capture.captureSource: could not build applications array",
                    ));
                }
                let filter: id = msg_send![filter_class, alloc];
                if filter.is_null() {
                    return err(PlatformError::internal(
                        "capture.captureSource: SCContentFilter alloc failed",
                    ));
                }
                // Application filters are macOS 14+ — same floor as
                // SCScreenshotManager, but guard anyway: init on an
                // unrecognized selector crashes.
                let responds: BOOL = msg_send![
                    filter,
                    respondsToSelector:
                        sel!(initWithDisplay:includingApplications:exceptingWindows:)
                ];
                if !yes(responds) {
                    let _: () = msg_send![filter, release];
                    return err(PlatformError::unavailable(
                        "capture.captureSource: application filters require macOS 14+",
                    ));
                }
                let filter: id = msg_send![
                        filter,
                        initWithDisplay: display
                includingApplications: apps
                     exceptingWindows: empty
                    ];
                return if filter.is_null() {
                    err(PlatformError::internal(
                        "capture.captureSource: SCContentFilter init failed",
                    ))
                } else {
                    Ok(filter)
                };
            }
        }
        let kind_name = match kind {
            Some(SourceKind::Display) => "display ",
            Some(SourceKind::Window) => "window ",
            Some(SourceKind::Application) => "application ",
            None => "",
        };
        err(PlatformError::invalid(format!(
            "capture.captureSource: no {kind_name}source with id {target} — refresh capture.getSources"
        )))
    }

    /// CGImage → PNG bytes → base64. Runs inside the screenshot block.
    unsafe fn png_base64(image: *const c_void) -> Result<String, PlatformError> {
        let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
        let rep: id = if rep.is_null() {
            nil
        } else {
            msg_send![rep, initWithCGImage: image]
        };
        if rep.is_null() {
            return err(PlatformError::internal(
                "capture.captureSource: NSBitmapImageRep init failed",
            ));
        }
        let properties: id = msg_send![class!(NSDictionary), dictionary];
        let data: id = msg_send![
            rep,
            representationUsingType: NS_BITMAP_FILE_TYPE_PNG
                         properties: properties
        ];
        let encoded = if data.is_null() {
            err(PlatformError::internal(
                "capture.captureSource: PNG encoding failed",
            ))
        } else {
            let bytes: *const c_void = msg_send![data, bytes];
            let length: NSUInteger = msg_send![data, length];
            if bytes.is_null() || length == 0 {
                err(PlatformError::internal(
                    "capture.captureSource: PNG data was empty",
                ))
            } else {
                let bytes = std::slice::from_raw_parts(bytes as *const u8, length as usize);
                Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
            }
        };
        let _: () = msg_send![rep, release];
        encoded
    }

    unsafe fn screenshot_result(image: *mut c_void, error: id) -> OpResult {
        if !error.is_null() {
            return err(PlatformError::unavailable(format!(
                "capture.captureSource: {}",
                ns_error_message(error)
            )));
        }
        if image.is_null() {
            return err(PlatformError::unavailable(
                "capture.captureSource: ScreenCaptureKit returned no image",
            ));
        }
        let width = CGImageGetWidth(image);
        let height = CGImageGetHeight(image);
        match png_base64(image) {
            Ok(png_base64) => ok(json!({
                "width": width,
                "height": height,
                "pngBase64": png_base64,
            })),
            Err(e) => err(e),
        }
    }

    fn capture_source(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let raw_id = match request.f64_arg("id") {
            Ok(value) => value,
            Err(e) => return reply(err(e)),
        };
        if !raw_id.is_finite() || raw_id < 0.0 || raw_id.fract() != 0.0 || raw_id > u32::MAX as f64
        {
            return reply(err(PlatformError::invalid(format!(
                "capture.captureSource: `{raw_id}` is not a valid source id"
            ))));
        }
        let target = raw_id as u32;
        let kind = match parse_kind(request) {
            Ok(kind) => kind,
            Err(e) => return reply(err(e)),
        };
        let Some(content_class) = shareable_content_class() else {
            return reply(err(PlatformError::unavailable(
                "capture.captureSource requires macOS 12.3+ (SCShareableContent)",
            )));
        };
        if !screenshot_manager_available() {
            return reply(err(PlatformError::unavailable(
                "capture.captureSource requires macOS 14+ (SCScreenshotManager)",
            )));
        }
        let Some(filter_class) = Class::get("SCContentFilter") else {
            return reply(err(PlatformError::unavailable(
                "capture.captureSource: SCContentFilter is not available",
            )));
        };
        spawn_pending(cx, request.id, move |sender| unsafe {
            // Two-hop chain: the shareable-content block finds the source
            // and builds the filter, then fires the screenshot block.
            let find_block = ConcreteBlock::new(move |content: id, error: id| {
                let pool = NSAutoreleasePool::new(nil);
                if content.is_null() || !error.is_null() {
                    send_result(
                        &sender,
                        err(PlatformError::unavailable(format!(
                            "capture.captureSource: {}",
                            ns_error_message(error)
                        ))),
                    );
                    pool.drain();
                    return;
                }
                let filter = match build_filter(content, target, kind, filter_class) {
                    Ok(filter) => filter,
                    Err(e) => {
                        send_result(&sender, err(e));
                        pool.drain();
                        return;
                    }
                };
                let Some(config_class) = Class::get("SCScreenshotConfiguration") else {
                    send_result(
                        &sender,
                        err(PlatformError::unavailable(
                            "capture.captureSource: SCScreenshotConfiguration is not available",
                        )),
                    );
                    pool.drain();
                    return;
                };
                let config: id = msg_send![config_class, new];
                if config.is_null() {
                    let _: () = msg_send![filter, release];
                    send_result(
                        &sender,
                        err(PlatformError::internal(
                            "capture.captureSource: SCScreenshotConfiguration alloc failed",
                        )),
                    );
                    pool.drain();
                    return;
                }
                let Some(manager_class) = Class::get("SCScreenshotManager") else {
                    let _: () = msg_send![filter, release];
                    let _: () = msg_send![config, release];
                    send_result(
                        &sender,
                        err(PlatformError::unavailable(
                            "capture.captureSource: SCScreenshotManager is not available",
                        )),
                    );
                    pool.drain();
                    return;
                };
                // `filter` moves into the shot block: released there once
                // captureImageWithFilter has consumed it, so the +1 lives
                // exactly as long as the in-flight capture needs.
                let sender_inner = sender.clone();
                let shot_block = ConcreteBlock::new(move |image: *mut c_void, error: id| {
                    let pool = NSAutoreleasePool::new(nil);
                    let result = screenshot_result(image, error);
                    let _: () = msg_send![filter, release];
                    let _: () = msg_send![config, release];
                    pool.drain();
                    send_result(&sender_inner, result);
                });
                let shot_block = shot_block.copy();
                let _: () = msg_send![
                    manager_class,
                    captureImageWithFilter: filter
                              configuration: config
                           completionHandler: shot_block
                ];
                pool.drain();
            });
            let find_block = find_block.copy();
            let _: () = msg_send![
                content_class,
                getShareableContentExcludingDesktopWindows: YES
                               onScreenWindowsOnly: YES
                                 completionHandler: find_block
            ];
        })
    }

    // ── dispatch ─────────────────────────────────────────────────────

    /// Private pool around the call; completion blocks open their own
    /// (GCD queues do carry one, but an explicit pool makes the bound
    /// obvious and frees ObjC temps before the reply goes out).
    pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let outcome = match request.op.as_str() {
            "isSupported" => reply(ok(json!({ "supported": is_supported() }))),
            "getSources" => get_sources(request, cx),
            "captureSource" => capture_source(request, cx),
            "stream" | "captureWindow" => reply(err(PlatformError::unsupported(format!(
                "capture.{}: frame streaming needs SCStream — not exposed in this build; use renderer.captureScreenshot for our own window",
                request.op
            )))),
            op => reply(err(PlatformError {
                code: "unknown",
                message: format!("unknown capture op `{op}`"),
            })),
        };
        unsafe { pool.drain() };
        outcome
    }
}
