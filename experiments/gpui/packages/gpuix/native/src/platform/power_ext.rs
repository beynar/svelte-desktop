//! Power/session extensions (macOS).
//! Ops (routed via power::call): getBattery, blockSleep, unblockSleep.
//! Events emitted from register(): systemSleep, screenLocked,
//! screenUnlocked, displaysChanged.
use super::*;

pub fn call(request: &PlatformRequest, _cx: &mut App) -> OpResult {
    match request.op.as_str() {
        "getBattery" => get_battery(),
        "blockSleep" => block_sleep(request),
        "unblockSleep" => unblock_sleep(request),
        op => err(PlatformError {
            code: "unknown",
            message: format!("unknown power op `{op}`"),
        }),
    }
}

/// Install once at app-launch: sleep/lock/display observers → emit_event.
/// No-op on non-macOS — the events have no source there.
pub fn register() {
    #[cfg(target_os = "macos")]
    imp::register();
}

#[cfg(target_os = "macos")]
fn get_battery() -> OpResult {
    imp::get_battery()
}

#[cfg(not(target_os = "macos"))]
fn get_battery() -> OpResult {
    err(PlatformError::unsupported(
        "power.getBattery is not implemented on this OS yet",
    ))
}

#[cfg(target_os = "macos")]
fn block_sleep(request: &PlatformRequest) -> OpResult {
    imp::block_sleep(request)
}

#[cfg(not(target_os = "macos"))]
fn block_sleep(_request: &PlatformRequest) -> OpResult {
    err(PlatformError::unsupported(
        "power.blockSleep is not implemented on this OS yet",
    ))
}

#[cfg(target_os = "macos")]
fn unblock_sleep(request: &PlatformRequest) -> OpResult {
    imp::unblock_sleep(request)
}

#[cfg(not(target_os = "macos"))]
fn unblock_sleep(_request: &PlatformRequest) -> OpResult {
    err(PlatformError::unsupported(
        "power.unblockSleep is not implemented on this OS yet",
    ))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::CString;
    use std::os::raw::{c_char, c_void};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// Opaque CoreFoundation reference — CFStringRef, CFDictionaryRef,
    /// CFArrayRef and CFTypeRef are all the same pointer slot at the FFI
    /// boundary; each extern below knows its concrete type.
    type CFRef = *const c_void;

    /// typedef void (*CFNotificationCallback)(CFNotificationCenterRef,
    ///   void *observer, CFNotificationName, const void *object,
    ///   CFDictionaryRef userInfo)
    type CFNotificationCallback =
        extern "C" fn(*mut c_void, *mut c_void, CFRef, *const c_void, CFRef);

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_S_INT64_TYPE: isize = 4;
    const CF_NOTIFICATION_SUSPENSION_BEHAVIOR_DELIVER_IMMEDIATELY: isize = 4;
    const K_CG_DISPLAY_BEGIN_CONFIGURATION_FLAG: u32 = 1 << 0;
    const K_IO_RETURN_SUCCESS: i32 = 0;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: CFRef, s: *const c_char, encoding: u32) -> CFRef;
        fn CFStringCompare(a: CFRef, b: CFRef, options: u64) -> isize;
        fn CFGetTypeID(cf: CFRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFDictionaryGetValue(dict: CFRef, key: CFRef) -> CFRef;
        fn CFBooleanGetValue(b: CFRef) -> u8;
        fn CFNumberGetValue(num: CFRef, number_type: isize, out: *mut c_void) -> u8;
        fn CFArrayGetCount(a: CFRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CFRef, i: isize) -> CFRef;
        fn CFRelease(cf: CFRef);
        fn CFNotificationCenterGetDistributedCenter() -> *mut c_void;
        fn CFNotificationCenterAddObserver(
            center: *mut c_void,
            observer: *const c_void,
            callback: CFNotificationCallback,
            name: CFRef,
            object: *const c_void,
            suspension_behavior: isize,
        );
    }

    // IOPS/IOPM live in IOKit.framework (IOKit/ps + IOKit/pwr_mgt).
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CFRef;
        fn IOPSCopyPowerSourcesList(blob: CFRef) -> CFRef;
        fn IOPSGetPowerSourceDescription(blob: CFRef, ps: CFRef) -> CFRef;
        fn IOPSGetProvidingPowerSourceType(blob: CFRef) -> CFRef;
        fn IOPMAssertionCreateWithDescription(
            assertion_type: CFRef,
            name: CFRef,
            details: CFRef,
            human_readable_reason: CFRef,
            localization_bundle_path: CFRef,
            timeout: f64, // CFTimeInterval — 0 = never times out
            timeout_action: CFRef,
            assertion_id: *mut u32, // IOPMAssertionID
        ) -> i32; // IOReturn
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGDisplayRegisterReconfigurationCallback(
            callback: extern "C" fn(u32, u32, *mut c_void),
            user_info: *mut c_void,
        ) -> i32; // CGError
    }

    /// Build a CFString. `CString::new` fails on interior NUL — sanitize so
    /// a hostile `reason` arg degrades instead of panicking.
    fn cfstring(s: &str) -> CFRef {
        let c = CString::new(s)
            .unwrap_or_else(|_| CString::new(s.replace('\0', " ")).unwrap_or_default());
        unsafe { CFStringCreateWithCString(ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
    }

    unsafe fn cf_release(cf: CFRef) {
        if !cf.is_null() {
            CFRelease(cf);
        }
    }

    /// `cf` is a CFString equal to `lit` (itself a CFString).
    unsafe fn cf_string_eq(cf: CFRef, lit: CFRef) -> bool {
        !cf.is_null()
            && !lit.is_null()
            && CFGetTypeID(cf) == CFStringGetTypeID()
            && CFStringCompare(cf, lit, 0) == 0
    }

    unsafe fn cf_bool(cf: CFRef) -> Option<bool> {
        if cf.is_null() || CFGetTypeID(cf) != CFBooleanGetTypeID() {
            return None;
        }
        Some(CFBooleanGetValue(cf) != 0)
    }

    unsafe fn cf_i64(cf: CFRef) -> Option<i64> {
        if cf.is_null() || CFGetTypeID(cf) != CFNumberGetTypeID() {
            return None;
        }
        let mut out: i64 = 0;
        if CFNumberGetValue(
            cf,
            K_CF_NUMBER_S_INT64_TYPE,
            &mut out as *mut i64 as *mut c_void,
        ) != 0
        {
            Some(out)
        } else {
            None
        }
    }

    // ── power.getBattery ─────────────────────────────────────────────

    /// `IOPSCopyPowerSourcesInfo` hands back a "blob" the sibling IOPS calls
    /// read through; `IOPSCopyPowerSourcesList` + `IOPSGetPowerSourceDescription`
    /// describe each attached source. Desktops report no "InternalBattery"
    /// entry → percent:null, external:true per the platform contract.
    pub fn get_battery() -> OpResult {
        unsafe {
            let blob = IOPSCopyPowerSourcesInfo();
            if blob.is_null() {
                return err(PlatformError::unavailable(
                    "power.getBattery: IOPSCopyPowerSourcesInfo returned no data",
                ));
            }
            let result = battery_from_blob(blob);
            CFRelease(blob);
            result
        }
    }

    unsafe fn battery_from_blob(blob: CFRef) -> OpResult {
        let key_type = cfstring("Type");
        let key_is_charging = cfstring("Is Charging");
        let key_current = cfstring("Current Capacity");
        let key_max = cfstring("Max Capacity");
        let internal_battery = cfstring("InternalBattery");
        let ac_power = cfstring("AC Power");
        let battery_power = cfstring("Battery Power");

        // A null CFString key would crash CFDictionaryGetValue — only OOM
        // can produce one, but never let an alloc failure become UB.
        if [
            key_type,
            key_is_charging,
            key_current,
            key_max,
            internal_battery,
            ac_power,
            battery_power,
        ]
        .iter()
        .any(|s| s.is_null())
        {
            for s in [
                key_type,
                key_is_charging,
                key_current,
                key_max,
                internal_battery,
                ac_power,
                battery_power,
            ] {
                cf_release(s);
            }
            return err(PlatformError::internal(
                "power.getBattery: CFString allocation failed",
            ));
        }

        // Borrowed from `blob` — not ours to release.
        let providing = IOPSGetProvidingPowerSourceType(blob);
        let on_ac = cf_string_eq(providing, ac_power);
        let on_battery = cf_string_eq(providing, battery_power);

        let mut found_battery = false;
        let mut percent: Option<f64> = None;
        let mut is_charging = false;

        let list = IOPSCopyPowerSourcesList(blob);
        if !list.is_null() {
            for i in 0..CFArrayGetCount(list) {
                let ps = CFArrayGetValueAtIndex(list, i);
                // Borrowed — owned by `blob`, do not release.
                let desc = IOPSGetPowerSourceDescription(blob, ps);
                if desc.is_null() {
                    continue;
                }
                if !cf_string_eq(CFDictionaryGetValue(desc, key_type), internal_battery) {
                    continue;
                }
                found_battery = true;
                if let (Some(cur), Some(max)) = (
                    cf_i64(CFDictionaryGetValue(desc, key_current)),
                    cf_i64(CFDictionaryGetValue(desc, key_max)),
                ) {
                    if max > 0 {
                        percent = Some(cur as f64 * 100.0 / max as f64);
                    }
                }
                is_charging = cf_bool(CFDictionaryGetValue(desc, key_is_charging)).unwrap_or(false);
                break; // a Mac has exactly one internal battery
            }
            CFRelease(list);
        }

        for s in [
            key_type,
            key_is_charging,
            key_current,
            key_max,
            internal_battery,
            ac_power,
            battery_power,
        ] {
            cf_release(s);
        }

        ok(json!({
            "percent": percent,
            // Contract: charging = "Is Charging" OR providing source is AC.
            "charging": is_charging || on_ac,
            // On battery → false; AC/UPS or no battery at all → true.
            "external": !found_battery || !on_battery,
        }))
    }

    // ── power.blockSleep / unblockSleep ──────────────────────────────

    /// The returned IOPMAssertionID *is* the handle — nothing is stored
    /// locally; unblockSleep releases the assertion by id.
    pub fn block_sleep(request: &PlatformRequest) -> OpResult {
        let assertion = match request.str_arg("type")?.as_str() {
            "system" => "PreventSystemSleep",
            "display" => "PreventUserIdleDisplaySleep",
            "idle" => "PreventUserIdleSystemSleep",
            other => {
                return err(PlatformError::invalid(format!(
                    "power.blockSleep: unknown type `{other}` — expected system|display|idle"
                )))
            }
        };
        let reason = request
            .opt_str("reason")
            .unwrap_or_else(|| "gpuix sleep block".to_string());
        unsafe {
            let assert_type = cfstring(assertion);
            let name = cfstring(&reason); // kIOPMAssertionNameKey — `pmset -g assertions`
            let reason_cf = cfstring(&reason);
            if assert_type.is_null() || name.is_null() || reason_cf.is_null() {
                cf_release(assert_type);
                cf_release(name);
                cf_release(reason_cf);
                return err(PlatformError::internal(
                    "power.blockSleep: CFString allocation failed",
                ));
            }
            let mut id: u32 = 0;
            let rc = IOPMAssertionCreateWithDescription(
                assert_type,
                name,
                ptr::null(), // Details
                reason_cf,   // HumanReadableReason
                ptr::null(), // LocalizationBundlePath — reason shown as-is
                0.0,         // Timeout — 0 means the assertion never times out
                ptr::null(), // TimeoutAction
                &mut id,
            );
            cf_release(assert_type);
            cf_release(name);
            cf_release(reason_cf);
            if rc != K_IO_RETURN_SUCCESS {
                return err(PlatformError::internal(format!(
                    "power.blockSleep: IOPMAssertionCreateWithDescription failed (IOReturn {rc:#x})"
                )));
            }
            ok(json!({ "id": id }))
        }
    }

    pub fn unblock_sleep(request: &PlatformRequest) -> OpResult {
        let id = request.f64_arg("id")?;
        if !id.is_finite() || id.fract() != 0.0 || id < 0.0 || id > u32::MAX as f64 {
            return err(PlatformError::invalid(format!(
                "power.unblockSleep: `{id}` is not a valid assertion id"
            )));
        }
        let rc = unsafe { IOPMAssertionRelease(id as u32) };
        if rc != K_IO_RETURN_SUCCESS {
            // Almost always a bogus or already-released id → caller's fault.
            return err(PlatformError::invalid(format!(
                "power.unblockSleep: no live assertion with id {id:.0} (IOReturn {rc:#x})"
            )));
        }
        ok(Value::Null)
    }

    // ── register(): OS observers → platform events ───────────────────

    /// register() runs inside the GPUI app-launch closure — exactly once in
    /// practice, but the swap keeps a second call from double-subscribing.
    static REGISTERED: AtomicBool = AtomicBool::new(false);

    /// Collapses CoreGraphics' per-display callback burst into one event.
    static LAST_DISPLAY_EVENT: Mutex<Option<Instant>> = Mutex::new(None);

    extern "C" fn on_screen_locked(
        _center: *mut c_void,
        _observer: *mut c_void,
        _name: CFRef,
        _object: *const c_void,
        _user_info: CFRef,
    ) {
        emit_event("screenLocked", json!({}));
    }

    extern "C" fn on_screen_unlocked(
        _center: *mut c_void,
        _observer: *mut c_void,
        _name: CFRef,
        _object: *const c_void,
        _user_info: CFRef,
    ) {
        emit_event("screenUnlocked", json!({}));
    }

    /// Fires once per online display *before* a reconfiguration (begin flag
    /// set) and once per display *after*. Emit only on the "after" calls —
    /// CoreGraphics state is only accurate then — and debounce the burst
    /// into a single event.
    extern "C" fn on_display_reconfigured(_display: u32, flags: u32, _info: *mut c_void) {
        if flags & K_CG_DISPLAY_BEGIN_CONFIGURATION_FLAG != 0 {
            return;
        }
        let mut last = match LAST_DISPLAY_EVENT.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let fresh = last
            .map(|t| now.saturating_duration_since(t) > Duration::from_millis(150))
            .unwrap_or(true);
        if fresh {
            *last = Some(now);
            emit_event("displaysChanged", json!({}));
        }
    }

    /// NSWorkspaceWillSleepNotification handler — signature required by
    /// objc::runtime::MethodImplementation (receiver, _cmd, notification).
    extern "C" fn on_sleep(_this: &Object, _cmd: Sel, _note: *mut Object) {
        emit_event("systemSleep", json!({}));
    }

    pub fn register() {
        if REGISTERED.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            register_lock_notifications();
            register_sleep_observer();
            // Return is a CGError; a failure only loses displaysChanged —
            // degrade silently rather than fail app launch.
            CGDisplayRegisterReconfigurationCallback(on_display_reconfigured, ptr::null_mut());
        }
    }

    /// com.apple.screenIsLocked / com.apple.screenIsUnlocked arrive over the
    /// CF distributed notification center (CoreFoundation.framework). The
    /// name CFStrings are intentionally leaked — the registrations live for
    /// the app's lifetime.
    unsafe fn register_lock_notifications() {
        let center = CFNotificationCenterGetDistributedCenter();
        if center.is_null() {
            return;
        }
        for (name, cb) in [
            (
                "com.apple.screenIsLocked",
                on_screen_locked as CFNotificationCallback,
            ),
            (
                "com.apple.screenIsUnlocked",
                on_screen_unlocked as CFNotificationCallback,
            ),
        ] {
            CFNotificationCenterAddObserver(
                center,
                ptr::null(),
                cb,
                cfstring(name),
                ptr::null(),
                CF_NOTIFICATION_SUSPENSION_BEHAVIOR_DELIVER_IMMEDIATELY,
            );
        }
    }

    /// NSWorkspace notifications need a real NSObject observer — declare a
    /// one-method class at runtime and leak a single instance so the
    /// observation outlives this call.
    unsafe fn register_sleep_observer() {
        let nsobject = match Class::get("NSObject") {
            Some(cls) => cls,
            None => return,
        };
        let cls: &'static Class = match ClassDecl::new("GpuixPowerObserver", nsobject) {
            Some(mut decl) => {
                decl.add_method(
                    sel!(onSleep:),
                    on_sleep as extern "C" fn(&Object, Sel, *mut Object),
                );
                decl.register()
            }
            // Name already claimed (e.g. a second embedded gpui runtime in
            // the same process) — reuse the existing class.
            None => match Class::get("GpuixPowerObserver") {
                Some(cls) => cls,
                None => return,
            },
        };
        let observer: *mut Object = msg_send![cls, new];
        if observer.is_null() {
            return;
        }
        let workspace: *mut Object = match Class::get("NSWorkspace") {
            Some(ws) => msg_send![ws, sharedWorkspace],
            // No AppKit in this process — nothing to observe.
            None => return,
        };
        if workspace.is_null() {
            return;
        }
        let center: *mut Object = msg_send![workspace, notificationCenter];
        if center.is_null() {
            return;
        }
        // CFString is toll-free bridged to NSString; intentionally leaked.
        let name = cfstring("NSWorkspaceWillSleepNotification") as *mut Object;
        let _: () = msg_send![
            center,
            addObserver: observer
            selector: sel!(onSleep:)
            name: name
            object: ptr::null_mut::<Object>()
        ];
    }
}
