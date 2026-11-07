//! Runtime permission checks and requests, plus LAContext authentication.
//!
//! Contract:
//!   `call`        — `system.checkPermission {name}` → `{status}`,
//!                   `system.requestPermission {name}` → `{status}` (plus a
//!                   `note` field where the grant requires follow-up in
//!                   System Settings),
//!                   `system.openSettings {pane}` → `{opened}`.
//!   `call_secure` — `secureStorage.authenticate {reason}` →
//!                   `{authenticated}` (+ `reason` when it fails).
//!
//! `status` ∈ `granted | denied | notDetermined | unsupported | unknown`.
//! `unknown` is only produced by `fullDiskAccess`, which macOS offers no
//! API to query — it is a heuristic, documented at the probe.
//!
//! Async grants (UNUserNotificationCenter, `requestAccessForMediaType:`,
//! `LAContext.evaluatePolicy:`) resolve on framework GCD queues. Each
//! kicks off inside the call and reports through a oneshot that a
//! foreground `cx.spawn` task turns into `platformResult` — the pending
//! lane, same shape as `secure_storage::call`.

use super::*;

pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
    #[cfg(target_os = "macos")]
    return imp::call(request, cx);
    #[cfg(not(target_os = "macos"))]
    reply(err(PlatformError::unsupported(format!(
        "system.{} is only implemented on macOS",
        request.op
    ))))
}

pub fn call_secure(request: &PlatformRequest, cx: &mut App) -> Outcome {
    #[cfg(target_os = "macos")]
    return imp::call_secure(request, cx);
    #[cfg(not(target_os = "macos"))]
    reply(err(PlatformError::unsupported(format!(
        "secureStorage.{} is only implemented on macOS",
        request.op
    ))))
}

/// `notifications.getPermissionStatus`/`requestPermission` are aliases for the
/// `notifications` permission name — the UNUserNotificationCenter path is the
/// same either way. Rewrites the op to the `system.*Permission` shape and
/// reuses `imp::call`.
pub fn call_notifications(request: &PlatformRequest, cx: &mut App) -> Outcome {
    #[cfg(target_os = "macos")]
    {
        let op = match request.op.as_str() {
            "getPermissionStatus" => "checkPermission",
            _ => "requestPermission",
        };
        let mut args = request.args.clone();
        if let Value::Object(ref mut map) = args {
            map.insert("name".to_string(), json!("notifications"));
        }
        let rewritten = PlatformRequest {
            id: request.id,
            service: request.service.clone(),
            op: op.to_string(),
            args,
        };
        return imp::call(&rewritten, cx);
    }
    #[cfg(not(target_os = "macos"))]
    reply(err(PlatformError::unsupported(format!(
        "notifications.{} is only implemented on macOS",
        request.op
    ))))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block::ConcreteBlock;
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{NSAutoreleasePool, NSInteger, NSString, NSUInteger, NSURL};
    use futures::channel::oneshot;
    use objc::runtime::Class;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_void;
    use std::sync::{Arc, Mutex};

    /// Opaque CoreFoundation reference — CFStringRef/CFDictionaryRef share
    /// the same pointer slot at the FFI boundary (power_ext convention).
    type CFRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// Boolean — cannot distinguish "not yet asked" from denied, so
        /// accessibility only ever reports granted|denied.
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFRef) -> bool;
        /// CFStringRef — toll-free bridged to NSString for NSDictionary.
        static kAXTrustedCheckOptionPrompt: CFRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        /// C99 bool returns; core-graphics 0.24 exposes neither symbol.
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        /// `NSString * const` media-type tokens.
        static AVMediaTypeVideo: id;
        static AVMediaTypeAudio: id;
    }

    // These frameworks are not loaded by a bare AppKit/gpui process. The
    // #[link] attribute emits a load command so dyld registers their ObjC
    // classes at launch — that is what makes `Class::get` below reliable.
    #[link(name = "UserNotifications", kind = "framework")]
    extern "C" {}
    #[link(name = "LocalAuthentication", kind = "framework")]
    extern "C" {}

    /// UNAuthorizationOptionBadge | Sound | Alert.
    const UN_AUTHORIZATION_OPTIONS: NSUInteger = 1 | 2 | 4;
    /// LAPolicyDeviceOwnerAuthenticationWithBiometrics.
    const LA_POLICY_BIOMETRICS: NSInteger = 1;

    /// Result channel handed to ObjC completion blocks. Blocks fire once
    /// on framework queues; `Mutex<Option>` makes the send once-only
    /// (blocks are `Fn`, not `FnOnce`) and keeps captures `Send`.
    type SharedSender = Arc<Mutex<Option<oneshot::Sender<OpResult>>>>;

    fn send_result(sender: &SharedSender, result: OpResult) {
        if let Ok(mut guard) = sender.lock() {
            if let Some(tx) = guard.take() {
                // A canceled receiver only means the requester went away.
                tx.send(result).ok();
            }
        }
    }

    /// Start an async grant flow: `kickoff` runs synchronously on the UI
    /// thread and must eventually call `send_result` from its completion
    /// block; the spawned task reports it as `platformResult` with `id`.
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
                        "permission op finished without a result",
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

    /// +1 from `init_str`, autoreleased into the pool that wraps `call`.
    /// NOT valid inside completion blocks (they run after the pool
    /// drains) — use `nsstring()` there.
    unsafe fn ns_string(value: &str) -> id {
        NSString::alloc(nil).init_str(value).autorelease()
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

    unsafe fn ns_error_message(error: id) -> String {
        if error.is_null() {
            return "unknown error".to_string();
        }
        let description: id = msg_send![error, localizedDescription];
        ns_to_string(description).unwrap_or_else(|| "unknown error".to_string())
    }

    // ── checkPermission ──────────────────────────────────────────────

    /// UNAuthorizationStatus → contract status. 0 notDetermined,
    /// 1 denied, 2 authorized, 3 provisional, 4 ephemeral (iOS; mapped
    /// with authorized — the OS is delivering notifications).
    /// True when the process runs from a `.app` bundle — `bundleIdentifier`
    /// is nil for ad-hoc binaries, and every UNUserNotificationCenter entry
    /// point raises an uncatchable ObjC exception in that state.
    unsafe fn has_bundle_identity() -> bool {
        let bundle: id = msg_send![class!(NSBundle), mainBundle];
        if bundle.is_null() {
            return false;
        }
        let identifier: id = msg_send![bundle, bundleIdentifier];
        !identifier.is_null()
    }

    fn un_status_name(status: NSInteger) -> &'static str {
        match status {
            0 => "notDetermined",
            2 | 3 | 4 => "granted",
            _ => "denied",
        }
    }

    /// AVAuthorizationStatus → contract status. 0 notDetermined,
    /// 1 restricted and 2 denied fold to denied, 3 authorized.
    fn av_status_name(status: NSInteger) -> &'static str {
        match status {
            0 => "notDetermined",
            3 => "granted",
            _ => "denied",
        }
    }

    /// TCC gives no FDA query. Probe whether we can read the system TCC
    /// database — the canonical heuristic (readable ⇒ Full Disk Access).
    /// Unreadable is reported `unknown`, not `denied`: it means *either*
    /// denied *or* never asked, and there is no notDetermined signal to
    /// split them.
    fn full_disk_access_status() -> OpResult {
        unsafe {
            let path = ns_string("/Library/Application Support/com.apple.TCC/TCC.db");
            let data: id = msg_send![class!(NSData), dataWithContentsOfFile: path];
            ok(json!({
                "status": if data.is_null() { "unknown" } else { "granted" },
            }))
        }
    }

    /// `authorizationStatusForMediaType:` is safe to call unbundled and
    /// without usage descriptions — unlike requestAccess, guarded below.
    fn av_authorization_status(media_type: id) -> OpResult {
        let Some(device_class) = Class::get("AVCaptureDevice") else {
            return err(PlatformError::unavailable(
                "system.checkPermission: AVCaptureDevice is not available",
            ));
        };
        unsafe {
            let status: NSInteger =
                msg_send![device_class, authorizationStatusForMediaType: media_type];
            ok(json!({ "status": av_status_name(status) }))
        }
    }

    fn check_permission(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let name = match request.str_arg("name") {
            Ok(name) => name,
            Err(e) => return reply(err(e)),
        };
        match name.as_str() {
            // AXIsProcessTrusted has no notDetermined — first call with the
            // prompt option is `requestPermission`; this reads state only.
            "accessibility" => reply(ok(json!({
                "status": if unsafe { AXIsProcessTrusted() } {
                    "granted"
                } else {
                    "denied"
                },
            }))),
            // Same split as accessibility: denied covers notDetermined.
            "screenRecording" => reply(ok(json!({
                "status": if unsafe { CGPreflightScreenCaptureAccess() } {
                    "granted"
                } else {
                    "denied"
                },
            }))),
            "notifications" => {
                let request_id = request.id;
                spawn_pending(cx, request_id, |sender| unsafe {
                    let Some(center_class) = Class::get("UNUserNotificationCenter") else {
                        send_result(
                            &sender,
                            err(PlatformError::unavailable(
                                "system.checkPermission notifications: UNUserNotificationCenter is not available",
                            )),
                        );
                        return;
                    };
                    // `currentNotificationCenter` raises NSInternalInconsistency
                    // on unbundled binaries — ObjC exceptions can't be caught
                    // from Rust, so gate on a bundle identity first.
                    if !has_bundle_identity() {
                        send_result(
                            &sender,
                            err(PlatformError::unavailable(
                                "system.checkPermission notifications: requires a bundled app (bundleIdentifier is nil)",
                            )),
                        );
                        return;
                    }
                    let center: id = msg_send![center_class, currentNotificationCenter];
                    if center.is_null() {
                        send_result(
                            &sender,
                            err(PlatformError::unavailable(
                                "system.checkPermission notifications: no current notification center",
                            )),
                        );
                        return;
                    }
                    let block = ConcreteBlock::new(move |settings: id| {
                        let result = if settings.is_null() {
                            err(PlatformError::unavailable(
                                "system.checkPermission notifications: no settings returned",
                            ))
                        } else {
                            let status: NSInteger =
                                msg_send![settings, authorizationStatus];
                            ok(json!({ "status": un_status_name(status) }))
                        };
                        send_result(&sender, result);
                    });
                    let block = block.copy();
                    let _: () = msg_send![
                        center,
                        getNotificationSettingsWithCompletionHandler: block
                    ];
                })
            }
            "fullDiskAccess" => reply(full_disk_access_status()),
            "camera" => reply(unsafe { av_authorization_status(AVMediaTypeVideo) }),
            "microphone" => reply(unsafe { av_authorization_status(AVMediaTypeAudio) }),
            other => reply(err(PlatformError::invalid(format!(
                "system.checkPermission: unknown name `{other}` — expected accessibility|screenRecording|notifications|fullDiskAccess|camera|microphone"
            )))),
        }
    }

    // ── requestPermission ────────────────────────────────────────────

    /// `AXIsProcessTrustedWithOptions` posts the "allow in Settings"
    /// prompt once, then returns the CURRENT trust value — the user still
    /// has to toggle the app in System Settings → Privacy → Accessibility
    /// (and often relaunch), so `denied` here does not mean refused.
    fn request_accessibility() -> OpResult {
        unsafe {
            let key = kAXTrustedCheckOptionPrompt as id;
            let value: id = msg_send![class!(NSNumber), numberWithBool: YES];
            if key.is_null() || value.is_null() {
                return err(PlatformError::internal(
                    "system.requestPermission accessibility: could not build options dictionary",
                ));
            }
            let options: id = msg_send![
                class!(NSDictionary),
                dictionaryWithObject: value
                                forKey: key
            ];
            let trusted = AXIsProcessTrustedWithOptions(options as CFRef);
            if trusted {
                ok(json!({ "status": "granted" }))
            } else {
                ok(json!({
                    "status": "denied",
                    "note": "grant the app in System Settings → Privacy & Security → Accessibility, then relaunch",
                }))
            }
        }
    }

    /// `requestAccessForMediaType:` aborts the process when the matching
    /// `NS*UsageDescription` key is missing from Info.plist (TCC's
    /// "attempted to access privacy-sensitive data" crash). Check the key
    /// first and degrade to `unavailable` instead.
    fn request_av_access(name: &str, media_type: id, sender: SharedSender) {
        let usage_key = match name {
            "camera" => "NSCameraUsageDescription",
            _ => "NSMicrophoneUsageDescription",
        };
        unsafe {
            let Some(device_class) = Class::get("AVCaptureDevice") else {
                send_result(
                    &sender,
                    err(PlatformError::unavailable(format!(
                        "system.requestPermission {name}: AVCaptureDevice is not available"
                    ))),
                );
                return;
            };
            let bundle: id = msg_send![class!(NSBundle), mainBundle];
            let description: id = if bundle.is_null() {
                nil
            } else {
                msg_send![bundle, objectForInfoDictionaryKey: ns_string(usage_key)]
            };
            if description.is_null() {
                send_result(
                    &sender,
                    err(PlatformError::unavailable(format!(
                        "system.requestPermission {name}: Info.plist is missing {usage_key} — the request would crash the process"
                    ))),
                );
                return;
            }
            let block = ConcreteBlock::new(move |granted: BOOL| {
                send_result(
                    &sender,
                    ok(json!({
                        "status": if yes(granted) { "granted" } else { "denied" },
                    })),
                );
            });
            let block = block.copy();
            let _: () = msg_send![
                device_class,
                requestAccessForMediaType: media_type
                       completionHandler: block
            ];
        }
    }

    fn request_notifications(request_id: u64, cx: &mut App) -> Outcome {
        spawn_pending(cx, request_id, |sender| unsafe {
            let Some(center_class) = Class::get("UNUserNotificationCenter") else {
                send_result(
                    &sender,
                    err(PlatformError::unavailable(
                        "system.requestPermission notifications: UNUserNotificationCenter is not available",
                    )),
                );
                return;
            };
            if !has_bundle_identity() {
                send_result(
                    &sender,
                    err(PlatformError::unavailable(
                        "system.requestPermission notifications: requires a bundled app (bundleIdentifier is nil)",
                    )),
                );
                return;
            }
            let center: id = msg_send![center_class, currentNotificationCenter];
            if center.is_null() {
                send_result(
                    &sender,
                    err(PlatformError::unavailable(
                        "system.requestPermission notifications: no current notification center",
                    )),
                );
                return;
            }
            let block = ConcreteBlock::new(move |granted: BOOL, error: id| {
                let result = if yes(granted) {
                    ok(json!({ "status": "granted" }))
                } else if error.is_null() {
                    ok(json!({ "status": "denied" }))
                } else {
                    // A real NSError (typically "no bundle identifier" in
                    // dev binaries) means the request never ran — that is
                    // unavailable, not denied.
                    err(PlatformError::unavailable(format!(
                        "system.requestPermission notifications: {}",
                        ns_error_message(error)
                    )))
                };
                send_result(&sender, result);
            });
            let block = block.copy();
            let _: () = msg_send![
                center,
                requestAuthorizationWithOptions: UN_AUTHORIZATION_OPTIONS
                               completionHandler: block
            ];
        })
    }

    fn request_permission(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let name = match request.str_arg("name") {
            Ok(name) => name,
            Err(e) => return reply(err(e)),
        };
        match name.as_str() {
            "accessibility" => reply(request_accessibility()),
            // Synchronous; shows the system prompt on first call only.
            // The grant applies to the *next* launch on some macOS
            // versions, so `denied` here does not mean refused.
            "screenRecording" => reply(ok(json!({
                "status": if unsafe { CGRequestScreenCaptureAccess() } {
                    "granted"
                } else {
                    "denied"
                },
            }))),
            "notifications" => request_notifications(request.id, cx),
            "camera" | "microphone" => {
                let media_type = unsafe {
                    if name == "camera" {
                        AVMediaTypeVideo
                    } else {
                        AVMediaTypeAudio
                    }
                };
                let id = request.id;
                spawn_pending(cx, id, move |sender| {
                    request_av_access(&name, media_type, sender)
                })
            }
            "fullDiskAccess" => reply(err(PlatformError::unsupported(
                "system.requestPermission fullDiskAccess cannot be requested programmatically — call system.openSettings {pane: \"privacy-fullDiskAccess\"} and relaunch the app",
            ))),
            other => reply(err(PlatformError::invalid(format!(
                "system.requestPermission: unknown name `{other}` — expected accessibility|screenRecording|notifications|fullDiskAccess|camera|microphone"
            )))),
        }
    }

    // ── openSettings ─────────────────────────────────────────────────

    fn open_settings(request: &PlatformRequest) -> OpResult {
        const PRIVACY_PANE: &str = "x-apple.systempreferences:com.apple.preference.security";
        let pane = request.str_arg("pane")?;
        let url = match pane.as_str() {
            "privacy-accessibility" => format!("{PRIVACY_PANE}?Privacy_Accessibility"),
            "privacy-screenCapture" => format!("{PRIVACY_PANE}?Privacy_ScreenCapture"),
            "privacy-fullDiskAccess" => format!("{PRIVACY_PANE}?Privacy_AllFiles"),
            "privacy-camera" => format!("{PRIVACY_PANE}?Privacy_Camera"),
            "privacy-microphone" => format!("{PRIVACY_PANE}?Privacy_Microphone"),
            "notifications" => {
                "x-apple.systempreferences:com.apple.preference.notifications".to_string()
            }
            other => {
                return err(PlatformError::invalid(format!(
                    "system.openSettings: unknown pane `{other}` — expected privacy-accessibility|privacy-screenCapture|privacy-fullDiskAccess|privacy-camera|privacy-microphone|notifications"
                )))
            }
        };
        unsafe {
            let url_obj = NSURL::URLWithString_(nil, ns_string(&url));
            if url_obj.is_null() {
                return err(PlatformError::internal(format!(
                    "system.openSettings: could not build NSURL for `{url}`"
                )));
            }
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return err(PlatformError::unavailable(
                    "system.openSettings: no shared workspace",
                ));
            }
            let opened: BOOL = msg_send![workspace, openURL: url_obj];
            ok(json!({ "opened": yes(opened) }))
        }
    }

    // ── secureStorage.authenticate ───────────────────────────────────

    fn authenticate(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let reason = request
            .opt_str("reason")
            .unwrap_or_else(|| "Authenticate to continue".to_string());
        spawn_pending(cx, request.id, move |sender| unsafe {
            let Some(context_class) = Class::get("LAContext") else {
                send_result(
                    &sender,
                    err(PlatformError::unavailable(
                        "secureStorage.authenticate: LAContext is not available",
                    )),
                );
                return;
            };
            // +1 — released inside the reply block so the context lives
            // for the whole evaluation without leaking; the synchronous
            // early-exit paths below release it directly.
            let context: id = msg_send![context_class, new];
            if context.is_null() {
                send_result(
                    &sender,
                    err(PlatformError::internal(
                        "secureStorage.authenticate: could not create LAContext",
                    )),
                );
                return;
            }
            let mut error: id = nil;
            let can: BOOL = msg_send![
                context,
                canEvaluatePolicy: LA_POLICY_BIOMETRICS
                             error: &mut error
            ];
            if !yes(can) {
                send_result(
                    &sender,
                    ok(json!({
                        "authenticated": false,
                        "reason": ns_error_message(error),
                    })),
                );
                let _: () = msg_send![context, release];
                return;
            }
            let reason_obj = nsstring(&reason); // +1 → released after the call
            if reason_obj.is_null() {
                send_result(
                    &sender,
                    err(PlatformError::internal(
                        "secureStorage.authenticate: could not build reason string",
                    )),
                );
                let _: () = msg_send![context, release];
                return;
            }
            let block = ConcreteBlock::new(move |success: BOOL, error: id| {
                let result = if yes(success) {
                    ok(json!({ "authenticated": true }))
                } else {
                    // Denials surface here too (user cancel, fallback
                    // password wrong) — `reason` carries the LA error.
                    ok(json!({
                        "authenticated": false,
                        "reason": ns_error_message(error),
                    }))
                };
                send_result(&sender, result);
                // Evaluation finished — our +1 goes back.
                let _: () = msg_send![context, release];
            });
            let block = block.copy();
            let _: () = msg_send![
                context,
                evaluatePolicy: LA_POLICY_BIOMETRICS
                localizedReason: reason_obj
                         reply: block
            ];
            if !reason_obj.is_null() {
                let _: () = msg_send![reason_obj, release];
            }
        })
    }

    // ── dispatch ─────────────────────────────────────────────────────

    /// Private pool around the call — every ObjC object vended above is
    /// autoreleased and drains here; block-side objects are +1 or leaked.
    pub fn call(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let outcome = match request.op.as_str() {
            "checkPermission" => check_permission(request, cx),
            "requestPermission" => request_permission(request, cx),
            "openSettings" => reply(open_settings(request)),
            op => reply(err(PlatformError {
                code: "unknown",
                message: format!("unknown system op `{op}`"),
            })),
        };
        unsafe { pool.drain() };
        outcome
    }

    pub fn call_secure(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let outcome = match request.op.as_str() {
            "authenticate" => authenticate(request, cx),
            op => reply(err(PlatformError {
                code: "unknown",
                message: format!("unknown secureStorage op `{op}`"),
            })),
        };
        unsafe { pool.drain() };
        outcome
    }
}
