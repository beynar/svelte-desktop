//! App- and window-scoped event observers: application activation state,
//! second-instance signaling, and window focus/backing changes.
//!
//! Contract:
//!   `register`             — called once from `register_app_callbacks`;
//!                            subscribes app-level observers (app
//!                            activation, distributed second-instance
//!                            notifications). The ObjC observer target is
//!                            intentionally leaked, so there are no gpui
//!                            `Subscription`s to stash via `super::keep`.
//!   `observe_window`       — called from `observe_window` with the live
//!                            view + window; wires window-scoped NSWindow
//!                            notifications (key status → `focusChanged`,
//!                            backing change → `scaleFactorChanged`).
//!                            `view.platform_subscriptions` is deliberately
//!                            untouched: gpui's `Window` exposes no public
//!                            activation observer (`observe_window_activation`
//!                            lives on `Context<T>`, unreachable from this
//!                            signature), so these are NSNotificationCenter
//!                            registrations scoped `object:`-wise to the
//!                            NSWindow — they go silent when it dies.
//!   `second_instance_post` — invoked from the single-instance lock-denied
//!                            path (`app.requestSingleInstanceLock` in
//!                            macos_ext); broadcasts this process's argv+cwd
//!                            on a distributed notification so the primary
//!                            instance emits `secondInstance`. Self-
//!                            contained: callable with no `App` handle and
//!                            on a thread with no autorelease pool.
//!
//! `secondInstance` is emitted ONLY by the distributed-notification
//! observer — never from `app.on_reopen` (dock-icon reopen already
//! surfaces as the separate `reopened` event in platform.rs; the two must
//! not be conflated).
//!
//! Non-macOS: silent no-ops. These are events, not ops — there is no
//! caller waiting on a reply, so `unsupported` would have no consumer.

use gpui::{App, Window};

use super::GpuixView;

pub fn register(_cx: &mut App) {
    #[cfg(target_os = "macos")]
    imp::register();
}

pub fn observe_window(_view: &mut GpuixView, _window: &mut Window) {
    #[cfg(target_os = "macos")]
    imp::observe_window(_view.window_id, _window);
}

pub fn second_instance_post() {
    #[cfg(target_os = "macos")]
    imp::second_instance_post();
}

#[cfg(target_os = "macos")]
mod imp {
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{NSAutoreleasePool, NSString};
    use gpui::Window;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use serde_json::json;
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::OnceLock;

    use crate::platform::{emit_event, nsstring, nswindow};

    /// Distributed-notification channel shared by the secondary process
    /// (`second_instance_post`) and the primary (`register`).
    const SECOND_INSTANCE_NOTIFICATION: &str = "svelte-desktop-second-instance";

    /// register() runs inside the GPUI app-launch closure — exactly once in
    /// practice, but the swap keeps a second call from double-subscribing.
    static REGISTERED: AtomicBool = AtomicBool::new(false);

    /// Activation dedup: 0 = unknown, 1 = active, 2 = inactive. The same
    /// logical transition can arrive twice (the names are registered on two
    /// notification centers) — only state changes emit.
    static APP_ACTIVE_STATE: AtomicU8 = AtomicU8::new(0);

    /// One NSObject subclass serves every observer in this module: one
    /// leaked instance for app-level notifications, one per window for
    /// `object:`-scoped NSWindow notifications. `last_scale` is the
    /// per-window backing-factor dedup slot (unused on the app instance).
    fn events_observer_class() -> Option<&'static Class> {
        static CLASS: OnceLock<Option<&'static Class>> = OnceLock::new();
        *CLASS.get_or_init(|| {
            // A second embedded runtime may already own the name — but only
            // reuse it if it's OUR class: a foreign class lacking the
            // last_scale ivar would make set_ivar/get_ivar panic inside
            // objc-rs → abort from an ObjC callback.
            if let Some(class) = Class::get("GpuixEventsObserver") {
                if class.instance_variable("last_scale").is_some()
                    && class.instance_variable("window_id").is_some()
                    && class.instance_method(sel!(gpuixBackingChanged:)).is_some()
                {
                    return Some(class);
                }
                // Name collision with a foreign class — register under a
                // unique name instead of reusing a class we can't trust.
                let name = format!("GpuixEventsObserver_{:x}", std::process::id());
                return ClassDecl::new(&name, class!(NSObject)).map(|mut decl| {
                    decl.add_ivar::<f64>("last_scale");
                    decl.add_ivar::<u32>("window_id");
                    add_observer_methods(&mut decl);
                    decl.register()
                });
            }
            let mut decl = ClassDecl::new("GpuixEventsObserver", class!(NSObject))?;
            decl.add_ivar::<f64>("last_scale");
            decl.add_ivar::<u32>("window_id");
            add_observer_methods(&mut decl);
            Some(decl.register())
        })
    }

    fn add_observer_methods(decl: &mut ClassDecl) {
        unsafe {
            decl.add_method(
                sel!(gpuixAppActivated:),
                app_activated as extern "C" fn(&Object, Sel, id),
            );
            decl.add_method(
                sel!(gpuixAppDeactivated:),
                app_deactivated as extern "C" fn(&Object, Sel, id),
            );
            decl.add_method(
                sel!(gpuixSecondInstance:),
                second_instance_received as extern "C" fn(&Object, Sel, id),
            );
            decl.add_method(
                sel!(gpuixKeyStatus:),
                key_status_changed as extern "C" fn(&Object, Sel, id),
            );
            decl.add_method(
                sel!(gpuixBackingChanged:),
                backing_changed as extern "C" fn(&mut Object, Sel, id),
            );
        }
    }

    fn yes(value: BOOL) -> bool {
        value != NO
    }

    unsafe fn add_observer(center: id, observer: id, selector: Sel, name: &str, object: id) {
        if center.is_null() {
            return;
        }
        let name_obj = nsstring(name);
        if name_obj.is_null() {
            return;
        }
        let _: () = msg_send![
            center,
            addObserver: observer
            selector: selector
            name: name_obj
            object: object
        ];
        // addObserver: retains the name — our +1 goes back.
        let _: () = msg_send![name_obj, release];
    }

    // ── appActivated / appDeactivated ────────────────────────────────

    fn emit_activation(active: bool) {
        let new = if active { 1u8 } else { 2u8 };
        if APP_ACTIVE_STATE.swap(new, Ordering::SeqCst) == new {
            return; // same-state duplicate — nothing changed for JS
        }
        emit_event(
            if active {
                "appActivated"
            } else {
                "appDeactivated"
            },
            json!({}),
        );
    }

    extern "C" fn app_activated(_this: &Object, _cmd: Sel, _note: id) {
        emit_activation(true);
    }

    extern "C" fn app_deactivated(_this: &Object, _cmd: Sel, _note: id) {
        emit_activation(false);
    }

    /// NSApplication posts DidBecomeActive/DidResignActive to the process's
    /// *default* notification center; the NSWorkspace center only carries
    /// NSWorkspace* notifications. The names are registered on both: the
    /// contract calls for the workspace center and the registration is
    /// harmless there, while the default-center registration is what
    /// actually delivers. Tri-state dedup absorbs any double delivery.
    unsafe fn register_activation(observer: id) {
        let workspace: id = match Class::get("NSWorkspace") {
            Some(ws) => msg_send![ws, sharedWorkspace],
            None => nil,
        };
        let workspace_center: id = if workspace.is_null() {
            nil
        } else {
            msg_send![workspace, notificationCenter]
        };
        let default_center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        for (name, selector) in [
            (
                "NSApplicationDidBecomeActiveNotification",
                sel!(gpuixAppActivated:),
            ),
            (
                "NSApplicationDidResignActiveNotification",
                sel!(gpuixAppDeactivated:),
            ),
        ] {
            add_observer(workspace_center, observer, selector, name, nil);
            add_observer(default_center, observer, selector, name, nil);
        }
    }

    // ── secondInstance ───────────────────────────────────────────────

    /// `userInfo` is an NSDictionary {argv: NSArray<NSString>, cwd: NSString}
    /// posted by `second_instance_post` in the secondary process. Any
    /// deviation (foreign sender, wrong types) degrades to empty fields
    /// rather than dropping the event.
    unsafe fn read_second_instance_info(note: id) -> (Vec<String>, String) {
        let mut argv = Vec::new();
        let mut cwd = String::new();
        if note.is_null() {
            return (argv, cwd);
        }
        let info: id = msg_send![note, userInfo];
        if info.is_null() {
            return (argv, cwd);
        }
        // `nsstring()` is +1 — released after the lookups.
        let key_argv = nsstring("argv");
        let key_cwd = nsstring("cwd");
        let argv_obj: id = msg_send![info, objectForKey: key_argv];
        let cwd_obj: id = msg_send![info, objectForKey: key_cwd];
        if !key_argv.is_null() {
            let _: () = msg_send![key_argv, release];
        }
        if !key_cwd.is_null() {
            let _: () = msg_send![key_cwd, release];
        }

        if !argv_obj.is_null() && yes(msg_send![argv_obj, isKindOfClass: class!(NSArray)]) {
            let count: usize = msg_send![argv_obj, count];
            for i in 0..count {
                let item: id = msg_send![argv_obj, objectAtIndex: i];
                if item.is_null() || !yes(msg_send![item, isKindOfClass: class!(NSString)]) {
                    continue;
                }
                if let Some(arg) = ns_to_string(item) {
                    argv.push(arg);
                }
            }
        }
        if !cwd_obj.is_null() && yes(msg_send![cwd_obj, isKindOfClass: class!(NSString)]) {
            cwd = ns_to_string(cwd_obj).unwrap_or_default();
        }
        (argv, cwd)
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

    /// Runs on whatever thread/runloop NSDistributedNotificationCenter
    /// delivers on — `emit_event` is a Mutex'd sink, safe from here.
    extern "C" fn second_instance_received(_this: &Object, _cmd: Sel, note: id) {
        let (argv, cwd) = unsafe { read_second_instance_info(note) };
        emit_event("secondInstance", json!({ "argv": argv, "cwd": cwd }));
    }

    unsafe fn register_second_instance(observer: id) {
        let center: id = msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
        add_observer(
            center,
            observer,
            sel!(gpuixSecondInstance:),
            SECOND_INSTANCE_NOTIFICATION,
            nil, // sender name — nil accepts posts from any process
        );
    }

    /// Called by the lock-denied path; may run on a thread without an
    /// autorelease pool (or before NSApplication exists) — provide one.
    pub fn second_instance_post() {
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            post();
            pool.drain();
        }
    }

    /// +1 from `init_str`, autoreleased — only valid under the private pool
    /// in `second_instance_post`.
    unsafe fn ns_string(value: &str) -> id {
        let string: id = msg_send![NSString::alloc(nil).init_str(value), autorelease];
        string
    }

    unsafe fn post() {
        let center: id = msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
        if center.is_null() {
            return;
        }
        // args_os + lossy: std::env::args() panics on non-UTF-8 argv.
        let argv: Vec<String> = std::env::args_os()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();

        let array: id = msg_send![class!(NSMutableArray), array];
        let info: id = msg_send![class!(NSMutableDictionary), dictionary];
        let key_argv = ns_string("argv");
        let key_cwd = ns_string("cwd");
        let cwd_obj = ns_string(&cwd);
        let name = ns_string(SECOND_INSTANCE_NOTIFICATION);
        if array.is_null()
            || info.is_null()
            || key_argv.is_null()
            || key_cwd.is_null()
            || cwd_obj.is_null()
            || name.is_null()
        {
            return;
        }
        for arg in &argv {
            let item = ns_string(arg);
            if item.is_null() {
                continue;
            }
            let _: () = msg_send![array, addObject: item];
        }
        let _: () = msg_send![info, setObject: array forKey: key_argv];
        let _: () = msg_send![info, setObject: cwd_obj forKey: key_cwd];
        // deliverImmediately: the secondary process typically exits right
        // after posting; a suspended primary must still get it.
        let _: () = msg_send![
            center,
            postNotificationName: name
            object: nil
            userInfo: info
            deliverImmediately: YES
        ];
    }

    // ── focusChanged / scaleFactorChanged (window-scoped) ────────────

    /// Both NSWindowDidBecomeKey and NSWindowDidResignKey land here; reading
    /// `isKeyWindow` live (rather than trusting which notification fired)
    /// mirrors what gpui_macos does in `window_did_change_key_status` and
    /// stays correct if AppKit ever posts them out of order.
    extern "C" fn key_status_changed(this: &Object, _cmd: Sel, note: id) {
        unsafe {
            if note.is_null() {
                return;
            }
            let window: id = msg_send![note, object];
            if window.is_null() {
                return;
            }
            let window_id = *this.get_ivar::<u32>("window_id");
            let focused: BOOL = msg_send![window, isKeyWindow];
            emit_event(
                "focusChanged",
                json!({ "windowId": window_id, "focused": yes(focused) }),
            );
        }
    }

    /// `last_scale` ivar dedups repeats: NSWindowDidChangeBackingProperties
    /// also fires for changes that don't move the scale factor.
    extern "C" fn backing_changed(this: &mut Object, _cmd: Sel, note: id) {
        unsafe {
            if note.is_null() {
                return;
            }
            let window: id = msg_send![note, object];
            if window.is_null() {
                return;
            }
            let factor: f64 = msg_send![window, backingScaleFactor];
            if *this.get_ivar::<f64>("last_scale") == factor {
                return;
            }
            this.set_ivar("last_scale", factor);
            let window_id = *this.get_ivar::<u32>("window_id");
            emit_event(
                "scaleFactorChanged",
                json!({ "windowId": window_id, "scaleFactor": factor }),
            );
        }
    }

    /// `object: ns_window` scopes every registration to this window, so a
    /// single leaked observer per window needs no teardown — once the
    /// NSWindow is gone nothing posts with it as object. `window_id` rides an
    /// ivar so the emitted events name their window.
    pub fn observe_window(window_id: u32, window: &mut Window) {
        unsafe {
            let Some(ns_window) = nswindow(window) else {
                return; // non-AppKit backend — nothing to observe
            };
            let Some(class) = events_observer_class() else {
                return;
            };
            // Intentionally leaked for the app's lifetime.
            let observer: id = msg_send![class, new];
            if observer.is_null() {
                return;
            }
            (*observer).set_ivar("window_id", window_id);
            let factor: f64 = msg_send![ns_window, backingScaleFactor];
            (*observer).set_ivar("last_scale", factor);

            let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
            for (name, selector) in [
                ("NSWindowDidBecomeKeyNotification", sel!(gpuixKeyStatus:)),
                ("NSWindowDidResignKeyNotification", sel!(gpuixKeyStatus:)),
                (
                    "NSWindowDidChangeBackingPropertiesNotification",
                    sel!(gpuixBackingChanged:),
                ),
            ] {
                add_observer(center, observer, selector, name, ns_window);
            }
        }
    }

    pub fn register() {
        if REGISTERED.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            let Some(class) = events_observer_class() else {
                return;
            };
            // Intentionally leaked — the observations are app-lifetime.
            let observer: id = msg_send![class, new];
            if observer.is_null() {
                return;
            }
            register_activation(observer);
            register_second_instance(observer);
        }
    }
}
