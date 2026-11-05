//! Small AppKit extras — Agent C fills this in.
//! Routed ops:
//!   app.setDockBadge {text}, app.bounceDock {type}, app.setLoginItem {enabled},
//!   app.setActivationPolicy {policy}, app.requestSingleInstanceLock → {acquired}
//!   system.getAccentColor → {r,g,b,a}|null, system.getAccessibility → {...}
//!   shell.trashItem {path} (sync NSFileManager call → ok(null)), shell.beep
//!   menu.popup {items,x?,y?} — actions emit `menuAction {id}`
//! Events: secondInstance {} — declared in the contract but NOT emitted yet:
//! delivering it needs an app-delegate reopen/openFiles hook we don't own;
//! requestSingleInstanceLock only reports contention.
use super::*;

pub fn call(request: &PlatformRequest, _cx: &mut App) -> OpResult {
    #[cfg(target_os = "macos")]
    return imp::call(request);
    #[cfg(not(target_os = "macos"))]
    err(PlatformError::unsupported(format!(
        "{}.{} is only implemented on macOS",
        request.service, request.op
    )))
}

/// Outcome-typed entry for `menu.popup` — the AppKit tracking loop must run
/// outside the AppCell borrow, so the op resolves via the pending lane.
pub fn call_popup(request: &PlatformRequest, cx: &mut App) -> Outcome {
    #[cfg(target_os = "macos")]
    return imp::popup(request, cx);
    #[cfg(not(target_os = "macos"))]
    reply(err(PlatformError::unsupported(
        "menu.popup is only implemented on macOS",
    )))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use cocoa::appkit::{
        NSApplicationActivationPolicy, NSColorSpace, NSEvent, NSMenu, NSMenuItem,
        NSRequestUserAttentionType, NSScreen,
    };
    use cocoa::base::{id, nil, BOOL, NO};
    use cocoa::foundation::{
        NSArray, NSAutoreleasePool, NSInteger, NSPoint, NSString, NSUInteger, NSURL,
    };
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::sync::OnceLock;

    const RTLD_NOW: i32 = 2;
    const SERVICE_MANAGEMENT_PATH: &[u8] =
        b"/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement\0";

    extern "C" {
        fn dlopen(path: *const std::ffi::c_char, mode: i32) -> *mut std::ffi::c_void;
    }

    /// ServiceManagement isn't `#[link]`ed — nothing else pulls it in, so
    /// `Class::get("SMAppService")` can return None even on macOS 13+.
    /// dlopen loads the framework into the ObjC runtime; a missing class
    /// afterwards means the OS predates the API.
    fn ensure_service_management() -> bool {
        static LOADED: OnceLock<bool> = OnceLock::new();
        *LOADED.get_or_init(|| unsafe {
            !dlopen(
                SERVICE_MANAGEMENT_PATH.as_ptr() as *const std::ffi::c_char,
                RTLD_NOW,
            )
            .is_null()
        })
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        fn NSBeep();
    }

    /// NSControlStateValueOn — menu items take NSInteger state, not BOOL.
    const NS_CONTROL_STATE_ON: NSInteger = 1;

    fn yes(value: BOOL) -> bool {
        value != NO
    }

    /// +1 from `init_str`; autoreleased into the dispatch-scoped pool.
    fn ns_string(value: &str) -> id {
        unsafe { NSString::alloc(nil).init_str(value).autorelease() }
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

    /// `bundleIdentifier` is nil for unbundled binaries (cargo/bun dev runs) —
    /// several ops distinguish "real app" from "dev binary" on it.
    unsafe fn main_bundle_id() -> id {
        let bundle: id = msg_send![class!(NSBundle), mainBundle];
        msg_send![bundle, bundleIdentifier]
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

    // ── app ─────────────────────────────────────────────────────────

    fn set_dock_badge(request: &PlatformRequest) -> OpResult {
        // `text` absent or JSON null clears the badge; a non-string non-null
        // value is a caller bug worth flagging.
        let text = match request.args.get("text") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => {
                return err(PlatformError::invalid(
                    "app.setDockBadge: `text` must be a string or null",
                ))
            }
        };
        let app = require_app("app.setDockBadge")?;
        unsafe {
            let dock_tile: id = msg_send![app, dockTile];
            if dock_tile.is_null() {
                return err(PlatformError::unavailable("app.setDockBadge: no dock tile"));
            }
            match text {
                Some(text) => {
                    let _: () = msg_send![dock_tile, setBadgeLabel: ns_string(&text)];
                }
                None => {
                    let _: () = msg_send![dock_tile, setBadgeLabel: nil];
                }
            }
        }
        ok(json!(true))
    }

    fn bounce_dock(request: &PlatformRequest) -> OpResult {
        let kind = request.str_arg("type")?;
        let request_type = match kind.as_str() {
            "critical" => NSRequestUserAttentionType::NSCriticalRequest,
            "informational" => NSRequestUserAttentionType::NSInformationalRequest,
            other => {
                return err(PlatformError::invalid(format!(
                    "app.bounceDock: unknown type `{other}` — expected critical|informational"
                )))
            }
        };
        let app = require_app("app.bounceDock")?;
        unsafe {
            let _: () = msg_send![app, requestUserAttention: request_type];
        }
        ok(json!(true))
    }

    fn set_activation_policy(request: &PlatformRequest) -> OpResult {
        let policy = request.str_arg("policy")?;
        let policy = match policy.as_str() {
            "regular" => NSApplicationActivationPolicy::NSApplicationActivationPolicyRegular,
            "accessory" => NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
            "prohibited" => NSApplicationActivationPolicy::NSApplicationActivationPolicyProhibited,
            other => {
                return err(PlatformError::invalid(format!(
					"app.setActivationPolicy: unknown policy `{other}` — expected regular|accessory|prohibited"
				)))
            }
        };
        let app = require_app("app.setActivationPolicy")?;
        unsafe {
            let applied: BOOL = msg_send![app, setActivationPolicy: policy as NSInteger];
            if !yes(applied) {
                return err(PlatformError::internal(
                    "app.setActivationPolicy: NSApplication refused the policy change",
                ));
            }
        }
        ok(json!(true))
    }

    fn set_login_item(request: &PlatformRequest) -> OpResult {
        let enabled = request.bool_arg("enabled")?;
        // SMAppService is macOS 13+; the framework isn't linked, so dlopen it
        // before Class::get — and resolve dynamically since class!() would
        // panic on older systems.
        if !ensure_service_management() {
            return err(PlatformError::unavailable(
                "app.setLoginItem: ServiceManagement.framework could not be loaded",
            ));
        }
        let Some(service_class) = Class::get("SMAppService") else {
            return err(PlatformError::unavailable(
                "app.setLoginItem requires macOS 13+ (SMAppService)",
            ));
        };
        unsafe {
            if main_bundle_id().is_null() {
                return err(PlatformError::unavailable(
                    "app.setLoginItem needs a bundled .app — this binary has no bundle identifier",
                ));
            }
            let service: id = msg_send![service_class, mainAppService];
            if service.is_null() {
                return err(PlatformError::unavailable(
                    "app.setLoginItem: SMAppService.mainAppService is unavailable",
                ));
            }
            let mut error: id = nil;
            let applied: BOOL = if enabled {
                msg_send![service, registerAndReturnError: &mut error]
            } else {
                msg_send![service, unregisterAndReturnError: &mut error]
            };
            if !yes(applied) {
                return err(PlatformError::internal(format!(
                    "app.setLoginItem: {}",
                    ns_error_message(error)
                )));
            }
            ok(json!({ "enabled": enabled }))
        }
    }

    fn request_single_instance_lock() -> OpResult {
        unsafe {
            let bundle_id = main_bundle_id();
            if bundle_id.is_null() {
                // A dev binary owns no bundle identity, so no second instance
                // can contend for it — the lock is trivially held. Documented
                // contract, not a silent success: bundled builds get the real
                // check below.
                return ok(json!({ "acquired": true }));
            }
            let running: id = msg_send![
                class!(NSRunningApplication),
                runningApplicationsWithBundleIdentifier: bundle_id
            ];
            let count: NSUInteger = msg_send![running, count];
            let acquired = count <= 1;
            if !acquired {
                // We're the second instance — hand argv+cwd to the primary
                // so it can emit `secondInstance` (Electron parity).
                crate::platform::events_ext::second_instance_post();
            }
            ok(json!({ "acquired": acquired }))
        }
    }

    // ── system ──────────────────────────────────────────────────────

    fn accent_color() -> OpResult {
        unsafe {
            let accent: id = msg_send![class!(NSColor), controlAccentColor];
            if accent.is_null() {
                return err(PlatformError::unavailable(
                    "system.getAccentColor: no control accent color",
                ));
            }
            let space = NSColorSpace::sRGBColorSpace(nil);
            let rgb: id = msg_send![accent, colorUsingColorSpace: space];
            if rgb.is_null() {
                return err(PlatformError::unavailable(
                    "system.getAccentColor: accent color cannot convert to sRGB",
                ));
            }
            // CGFloat is f64 on every supported macOS target.
            let r: f64 = msg_send![rgb, redComponent];
            let g: f64 = msg_send![rgb, greenComponent];
            let b: f64 = msg_send![rgb, blueComponent];
            let a: f64 = msg_send![rgb, alphaComponent];
            ok(json!({ "r": r, "g": g, "b": b, "a": a }))
        }
    }

    fn accessibility() -> OpResult {
        unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return err(PlatformError::unavailable(
                    "system.getAccessibility: no shared workspace",
                ));
            }
            // The accessibilityDisplayShould* selectors arrived in macOS 14 —
            // check before messaging or older systems die on the unrecognized
            // selector.
            let supported: BOOL = msg_send![
                workspace,
                respondsToSelector: sel!(accessibilityDisplayShouldReduceTransparency)
            ];
            if !yes(supported) {
                return err(PlatformError::unavailable(
                    "system.getAccessibility requires macOS 14+",
                ));
            }
            let reduce_motion: BOOL = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
            let high_contrast: BOOL =
                msg_send![workspace, accessibilityDisplayShouldIncreaseContrast];
            let differentiate: BOOL = msg_send![
                workspace,
                accessibilityDisplayShouldDifferentiateWithoutColor
            ];
            let reduce_transparency: BOOL =
                msg_send![workspace, accessibilityDisplayShouldReduceTransparency];
            ok(json!({
                "reduceMotion": yes(reduce_motion),
                "highContrast": yes(high_contrast),
                "differentiateWithoutColor": yes(differentiate),
                "reduceTransparency": yes(reduce_transparency),
            }))
        }
    }

    // ── shell ───────────────────────────────────────────────────────

    fn trash_item(request: &PlatformRequest) -> OpResult {
        let path = request.str_arg("path")?;
        unsafe {
            let url = NSURL::fileURLWithPath_(nil, ns_string(&path));
            let file_manager: id = msg_send![class!(NSFileManager), defaultManager];
            let mut trashed: id = nil;
            let mut error: id = nil;
            let done: BOOL = msg_send![
                file_manager,
                trashItemAtURL: url
                resultingItemURL: &mut trashed
                error: &mut error
            ];
            if !yes(done) {
                return err(PlatformError::internal(format!(
                    "shell.trashItem `{path}`: {}",
                    ns_error_message(error)
                )));
            }
            ok(Value::Null)
        }
    }

    fn beep() -> OpResult {
        unsafe { NSBeep() }
        ok(Value::Null)
    }

    // ── menu.popup ──────────────────────────────────────────────────
    // NSMenuItems dispatch through target/action. One NSObject subclass with a
    // single `gpuixMenuItemAction:` method serves every popup item; the item id
    // rides along in `representedObject` and is emitted as `menuAction {id}` —
    // the same event shape the app/dock menus produce via PlatformMenuAction.

    extern "C" fn menu_item_action(_this: &mut Object, _cmd: Sel, item: id) {
        let item_id = unsafe {
            let represented: id = msg_send![item, representedObject];
            // representedObject could be a non-NSString from an OS-inserted
            // item — UTF8String would hit unrecognized-selector → abort.
            if represented != nil {
                let is_string: BOOL =
                    msg_send![represented, isKindOfClass: class!(NSString)];
                if is_string == NO {
                    return;
                }
            }
            ns_to_string(represented)
        }
        .unwrap_or_default();
        emit_event("menuAction", json!({ "id": item_id }));
    }

    /// Lazily registers the target class. ClassDecl::new returns None when the
    /// name is already registered — fall back to the existing class rather
    /// than panic.
    fn menu_target_class() -> Option<&'static Class> {
        static TARGET_CLASS: OnceLock<Option<&'static Class>> = OnceLock::new();
        *TARGET_CLASS.get_or_init(|| unsafe {
            if let Some(class) = Class::get("GpuixPopupMenuTarget") {
                return Some(class);
            }
            let mut decl = ClassDecl::new("GpuixPopupMenuTarget", class!(NSObject))?;
            decl.add_method(
                sel!(gpuixMenuItemAction:),
                menu_item_action as extern "C" fn(&mut Object, Sel, id),
            );
            Some(decl.register())
        })
    }

    fn item_label(item: &Value) -> Option<&str> {
        item.get("label")
            .or_else(|| item.get("name"))
            .or_else(|| item.get("title"))
            .and_then(Value::as_str)
    }

    fn item_disabled(item: &Value) -> bool {
        item.get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    unsafe fn build_menu(items: &[Value], target: id) -> Result<id, PlatformError> {
        let menu = NSMenu::alloc(nil)
            .initWithTitle_(ns_string(""))
            .autorelease();
        menu.setAutoenablesItems(NO);
        for item in items {
            menu.addItem_(build_item(item, target)?);
        }
        Ok(menu)
    }

    unsafe fn build_item(item: &Value, target: id) -> Result<id, PlatformError> {
        // Accept both vocabularies: the popup contract's "normal"/"checkbox"
        // and the shared MenuItemSpec's "action"/"submenu" (checked is a flag,
        // not a type, in the shared spec).
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("normal");
        match kind {
            // +separatorItem is already autoreleased (non-owning per MRC
            // naming); adding another would over-release at pool drain.
            "separator" => Ok(NSMenuItem::separatorItem(nil)),
            "submenu" => {
                let label = item_label(item).ok_or_else(|| {
                    PlatformError::invalid("menu.popup: submenu item needs a label")
                })?;
                let children = item
                    .get("submenu")
                    .or_else(|| item.get("items"))
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        PlatformError::invalid("menu.popup: submenu item needs a submenu array")
                    })?;
                let entry = NSMenuItem::new(nil).autorelease();
                let _: () = msg_send![entry, setTitle: ns_string(label)];
                entry.setSubmenu_(build_menu(children, target)?);
                if item_disabled(item) {
                    let _: () = msg_send![entry, setEnabled: NO];
                }
                crate::platform::menu_ext::apply_item_extras(item, entry)?;
                Ok(entry)
            }
            "normal" | "action" | "checkbox" | "role" => {
                let label = item_label(item).unwrap_or("");
                let entry = NSMenuItem::alloc(nil)
                    .initWithTitle_action_keyEquivalent_(
                        ns_string(label),
                        sel!(gpuixMenuItemAction:),
                        ns_string(""),
                    )
                    .autorelease();
                entry.setTarget_(target);
                // The emitted id: explicit `id` wins, else the label (matches
                // the contract's id??label fallback).
                let action_id = item.get("id").and_then(Value::as_str).unwrap_or(label);
                let _: () = msg_send![entry, setRepresentedObject: ns_string(action_id)];
                if item
                    .get("checked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let _: () = msg_send![entry, setState: NS_CONTROL_STATE_ON];
                }
                if item_disabled(item) {
                    let _: () = msg_send![entry, setEnabled: NO];
                }
                crate::platform::menu_ext::apply_item_extras(item, entry)?;
                Ok(entry)
            }
            other => err(PlatformError::invalid(format!(
                "menu.popup: unknown item type `{other}`"
            ))),
        }
    }

    /// JS passes top-left-origin screen pixels; Cocoa screen space is
    /// bottom-left-origin measured from the primary display (screens[0]).
    /// Without coordinates we pop at the current mouse location, which is
    /// already in Cocoa screen coordinates.
    unsafe fn popup_location(x: Option<f64>, y: Option<f64>) -> NSPoint {
        if let (Some(x), Some(y)) = (x, y) {
            let screens = NSScreen::screens(nil);
            if screens.count() > 0 {
                let primary = screens.objectAtIndex(0);
                let height = NSScreen::frame(primary).size.height;
                return NSPoint::new(x, height - y);
            }
        }
        NSEvent::mouseLocation(nil)
    }

    /// `popUpMenuPositioningItem:` runs a nested NSEventTrackingRunLoopMode
    /// loop — and the GCD main queue drains in common modes inside it, so
    /// anything deferred there (gpui's platform callbacks, update_or_defer
    /// retries, pending-lane tasks) would execute while the AppCell borrow
    /// this dispatch still holds is alive → RefCell panic → abort. The
    /// tracking call therefore runs on the next executor turn via cx.spawn,
    /// outside the borrow, and resolves through the pending lane. Menu and
    /// target are retained (+1) to survive the dispatch pool drain.
    pub fn popup(request: &PlatformRequest, cx: &mut App) -> Outcome {
        let id = request.id;
        let result = (|| -> Result<(id, id, NSPoint), PlatformError> {
            let items = request
                .args
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| PlatformError::invalid("menu.popup needs an items array"))?;
            let x = request.opt_f64("x")?;
            let y = request.opt_f64("y")?;
            let _app = require_app("menu.popup")?;
            let Some(class) = menu_target_class() else {
                return Err(PlatformError::internal(
                    "menu.popup: could not register the menu target class",
                ));
            };
            unsafe {
                let target: id = msg_send![class, new]; // +1 — released in the block
                if target.is_null() {
                    return Err(PlatformError::internal(
                        "menu.popup: target allocation failed",
                    ));
                }
                let menu = match build_menu(items, target) {
                    Ok(menu) => menu,
                    Err(e) => {
                        let _: () = msg_send![target, release];
                        return Err(e);
                    }
                };
                let menu: id = msg_send![menu, retain]; // +1 — survives pool drain
                let location = popup_location(x, y);
                Ok((target, menu, location))
            }
        })();
        match result {
            Err(e) => reply(err(e)),
            Ok((target, menu, location)) => {
                cx.spawn(async move |_cx| {
                    unsafe {
                        let pool = NSAutoreleasePool::new(nil);
                        let _: BOOL = msg_send![
                            menu,
                            popUpMenuPositioningItem: nil
                            atLocation: location
                            inView: nil
                        ];
                        let _: () = msg_send![menu, release];
                        let _: () = msg_send![target, release];
                        pool.drain();
                    }
                    // AppKit can't distinguish a pick from a dismissal —
                    // menuAction is the real selection signal.
                    resolve_pending(id, ok(json!({ "dismissed": true })));
                })
                .detach();
                Outcome::Pending
            }
        }
    }

    // ── dispatch ────────────────────────────────────────────────────

    pub fn call(request: &PlatformRequest) -> OpResult {
        // A private autorelease pool around the whole dispatch: every ObjC
        // object created below is autoreleased and drained on the way out —
        // nothing leaks, and the menu tree stays alive for the duration of the
        // popup's nested tracking loop.
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let result = dispatch(request);
        unsafe { pool.drain() };
        result
    }

    fn dispatch(request: &PlatformRequest) -> OpResult {
        match (request.service.as_str(), request.op.as_str()) {
            ("app", "setDockBadge") => set_dock_badge(request),
            ("app", "bounceDock") => bounce_dock(request),
            ("app", "setLoginItem") => set_login_item(request),
            ("app", "setActivationPolicy") => set_activation_policy(request),
            ("app", "requestSingleInstanceLock") => request_single_instance_lock(),
            ("system", "getAccentColor") => accent_color(),
            ("system", "getAccessibility") => accessibility(),
            ("shell", "trashItem") => trash_item(request),
            ("shell", "beep") => beep(),
            // ("menu","popup") routes through call_popup — it resolves via
            // the pending lane, not a synchronous OpResult.
            (service, op) => err(PlatformError {
                code: "unknown",
                message: format!("macos_ext does not implement {service}.{op}"),
            }),
        }
    }
}
