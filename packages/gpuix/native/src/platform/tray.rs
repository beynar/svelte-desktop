//! Status-bar item — NSStatusBar/NSStatusItem via cocoa/objc.
//! Ops: tray.set {title?,imagePath?,tooltip?,menu?}, tray.remove.
//! Events: trayClick {} — tray menu actions emit `menuAction {id}`.
use super::*;

pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
    #[cfg(target_os = "macos")]
    {
        imp::call(request, cx)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        let _ = cx;
        err(PlatformError::unsupported(
            "tray is not implemented on this OS",
        ))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::platform::menu_ext;
    use cocoa::appkit::{
        NSImage, NSMenu, NSMenuItem, NSScreen, NSStatusBar, NSStatusItem,
        NSVariableStatusItemLength,
    };
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{
        NSArray, NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString,
    };
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Live NSStatusItem, retained by us while stored. ObjC pointers are
    /// !Sync, so the static keeps the pointer as usize; access is always on
    /// the UI thread.
    static STATUS_ITEM: Mutex<Option<usize>> = Mutex::new(None);

    /// Lazily-created GpuixTrayTarget instance — leaks for the app's
    /// lifetime; menu-item targets must outlive the items that point at them.
    static TARGET: AtomicUsize = AtomicUsize::new(0);

    fn null_sel() -> Sel {
        unsafe { Sel::from_ptr(std::ptr::null()) }
    }

    /// +1 NSString, autoreleased — safe inside `set`'s pool.
    fn ns_string(s: &str) -> id {
        unsafe { msg_send![NSString::alloc(nil).init_str(s), autorelease] }
    }

    extern "C" fn item_action(_this: &mut Object, _cmd: Sel, sender: id) {
        unsafe {
            let repr: id = msg_send![sender, representedObject];
            if repr == nil {
                return;
            }
            // representedObject could be a non-NSString from an OS-inserted
            // item — UTF8String would hit unrecognized-selector → abort.
            let is_string: BOOL = msg_send![repr, isKindOfClass: class!(NSString)];
            if is_string == NO {
                return;
            }
            let c_str = NSString::UTF8String(repr);
            if c_str.is_null() {
                return;
            }
            let id = CStr::from_ptr(c_str).to_string_lossy().into_owned();
            emit_event("menuAction", json!({ "id": id }));
        }
    }

    extern "C" fn tray_click(_this: &mut Object, _cmd: Sel, sender: id) {
        unsafe {
            let window: id = msg_send![sender, window];
            let rect = if window == nil {
                None
            } else {
                button_screen_rect(window)
            };
            match rect {
                Some([x, y, width, height]) => {
                    *LAST_BUTTON_RECT.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some([x, y, width, height]);
                    emit_event(
                        "trayClick",
                        json!({ "x": x, "y": y, "width": width, "height": height }),
                    );
                }
                None => emit_event("trayClick", json!({})),
            }
        }
    }

    /// The button's window frame flipped to top-left coordinates against the
    /// primary screen — the same convention `menu.popup` uses for its x/y, so
    /// a popup positioned at this rect lands under the tray icon.
    unsafe fn button_screen_rect(window: id) -> Option<[f64; 4]> {
        let frame: NSRect = msg_send![window, frame];
        let screens = NSScreen::screens(nil);
        if screens.count() == 0 {
            return None;
        }
        let height = NSScreen::frame(screens.objectAtIndex(0)).size.height;
        Some([
            frame.origin.x,
            height - frame.origin.y - frame.size.height,
            frame.size.width,
            frame.size.height,
        ])
    }

    /// Singleton target for all tray/menu actions. The class is declared
    /// once; `ClassDecl::new` returns None if another path already declared
    /// the name, in which case `class!` finds the existing registration.
    pub(crate) fn target() -> id {
        let existing = TARGET.load(Ordering::Acquire);
        if existing != 0 {
            return existing as id;
        }
        unsafe {
            let cls: &Class = match ClassDecl::new("GpuixTrayTarget", class!(NSObject)) {
                Some(mut decl) => {
                    decl.add_method(
                        sel!(itemAction:),
                        item_action as extern "C" fn(&mut Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(trayClick:),
                        tray_click as extern "C" fn(&mut Object, Sel, id),
                    );
                    decl.register()
                }
                None => class!(GpuixTrayTarget),
            };
            let instance: id = msg_send![cls, new];
            TARGET.store(instance as usize, Ordering::Release);
            instance
        }
    }

    /// The stored status item, creating it when `create` is set. Returns nil
    /// when nothing is stored and `create` is false.
    fn status_item(create: bool) -> id {
        let mut guard = STATUS_ITEM.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(item) = *guard {
            return item as id;
        }
        if !create {
            return nil;
        }
        unsafe {
            let item =
                NSStatusBar::systemStatusBar(nil).statusItemWithLength_(NSVariableStatusItemLength);
            if item == nil {
                return nil;
            }
            // statusItemWithLength: returns an object owned by the status
            // bar — retain so our reference survives removeStatusItem:.
            let item: id = msg_send![item, retain];
            *guard = Some(item as usize);
            item
        }
    }

    /// Item spec: {id?, label?, type?: 'normal'|'separator'|'checkbox',
    /// checked?, disabled?, submenu?, role?, icon?}. 'action'/'submenu'/
    /// 'divider' are accepted as aliases for the app-menu vocabulary, and
    /// `{role:"separator"}` also produces a separator. `role`/`icon` extras
    /// are applied through `menu_ext::apply_item_extras` — the shared
    /// vocabulary the other NSMenu builders use. Everything built here is
    /// autoreleased — `addItem:`/`setSubmenu:`/`setMenu:` retain what they
    /// need, so no explicit releases.
    unsafe fn build_menu_item(item: &Value) -> Result<id, PlatformError> {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("normal")
            .to_ascii_lowercase();
        let role_separator = item
            .get("role")
            .and_then(Value::as_str)
            .map(|role| role.eq_ignore_ascii_case("separator"))
            .unwrap_or(false);
        match kind.as_str() {
            "separator" | "divider" => Ok(NSMenuItem::separatorItem(nil)),
            _ if role_separator => Ok(NSMenuItem::separatorItem(nil)),
            _ => {
                let label = item
                    .get("label")
                    .or_else(|| item.get("title"))
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let menu_item: id = msg_send![
                    NSMenuItem::alloc(nil).initWithTitle_action_keyEquivalent_(
                        ns_string(label),
                        null_sel(),
                        ns_string(""),
                    ),
                    autorelease
                ];
                if menu_item == nil {
                    return err(PlatformError::internal(
                        "tray.set: NSMenuItem allocation failed",
                    ));
                }
                if let Some(children) = item.get("submenu").and_then(Value::as_array) {
                    let submenu = build_menu(children)?;
                    menu_item.setSubmenu_(submenu);
                } else if kind == "submenu" {
                    // Declared a submenu with no children — a dead item.
                    return err(PlatformError::invalid(
                        "tray.set: kind `submenu` needs a non-empty submenu array",
                    ));
                } else {
                    // representedObject carries the item id (label fallback).
                    let action_id = item.get("id").and_then(Value::as_str).unwrap_or(label);
                    let _: () = msg_send![menu_item, setTarget: target()];
                    let _: () = msg_send![menu_item, setAction: sel!(itemAction:)];
                    let repr = ns_string(action_id);
                    let _: () = msg_send![menu_item, setRepresentedObject: repr];
                }
                if item
                    .get("checked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let _: () = msg_send![menu_item, setState: 1_isize];
                }
                if item
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let _: () = msg_send![menu_item, setEnabled: NO];
                }
                // Shared spec extras: `{role}` wires a native AppKit action
                // (responder chain or NSApp), `{icon}` sets an NSImage —
                // errors propagate like any other bad spec.
                menu_ext::apply_item_extras(item, menu_item)?;
                Ok(menu_item)
            }
        }
    }

    /// Shared `items` → `NSMenu` builder — `menu.insert` builds bar menus
    /// through this so tray/popup/bar items behave identically (item ids
    /// ride `representedObject` and fire the same `menuAction` event).
    pub(crate) unsafe fn build_menu(items: &[Value]) -> Result<id, PlatformError> {
        let menu: id = msg_send![
            NSMenu::alloc(nil).initWithTitle_(ns_string("")),
            autorelease
        ];
        if menu == nil {
            return err(PlatformError::internal(
                "tray.set: NSMenu allocation failed",
            ));
        }
        menu.setAutoenablesItems(NO);
        for item in items {
            menu.addItem_(build_menu_item(item)?);
        }
        Ok(menu)
    }

    /// `badgeColor` bakes a dot into the icon's top-right corner — the status
    /// item API has no badge channel. The composite must not be a template
    /// image (AppKit would recolor the badge to match the bar), so the result
    /// always paints literal pixels. No icon → the dot stands alone on a
    /// transparent 22×22 base.
    unsafe fn badged_image(base: id, rgba: (f32, f32, f32, f32)) -> id {
        let size: NSSize = if base != nil {
            msg_send![base, size]
        } else {
            NSSize::new(22.0, 22.0)
        };
        let out: id = msg_send![NSImage::alloc(nil).initWithSize_(size), autorelease];
        if out == nil {
            return nil;
        }
        out.lockFocus();
        if base != nil {
            let _: () = msg_send![
                base,
                drawAtPoint: NSPoint::new(0.0, 0.0)
                fromRect: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))
                operation: cocoa::appkit::NSCompositingOperation::NSCompositeSourceOver
                fraction: 1.0f64
            ];
        }
        let color: id = msg_send![
            class!(NSColor),
            colorWithSRGBRed: rgba.0 as f64
            green: rgba.1 as f64
            blue: rgba.2 as f64
            alpha: rgba.3 as f64
        ];
        let _: () = msg_send![color, set];
        // Unflipped image space is bottom-left origin — "top right" is maxX/maxY.
        let d = (size.width.min(size.height) * 0.36).max(6.0);
        let dot = NSRect::new(
            NSPoint::new(size.width - d, size.height - d),
            NSSize::new(d, d),
        );
        let path: id = msg_send![class!(NSBezierPath), bezierPathWithOvalInRect: dot];
        let _: () = msg_send![path, fill];
        out.unlockFocus();
        out
    }

    fn set(request: &PlatformRequest) -> OpResult {
        unsafe {
            // Autoreleased NSStrings/NSMenu pieces land in this pool; drain it
            // even when apply fails partway through.
            let pool = NSAutoreleasePool::new(nil);
            let result = apply(request);
            pool.drain();
            result
        }
    }

    unsafe fn apply(request: &PlatformRequest) -> OpResult {
        let item = status_item(true);
        if item == nil {
            return err(PlatformError::unavailable(
                "tray.set: could not create an NSStatusItem",
            ));
        }
        let button: id = item.button();
        if button == nil {
            return err(PlatformError::unavailable(
                "tray.set: status item has no button",
            ));
        }

        // Presence means "set"; explicit null clears to empty.
        if let Some(value) = request.args.get("title") {
            let _: () = msg_send![button, setTitle: ns_string(value.as_str().unwrap_or(""))];
        }
        if let Some(value) = request.args.get("tooltip") {
            let _: () = msg_send![button, setToolTip: ns_string(value.as_str().unwrap_or(""))];
        }

        // Icon sources: `imageName` or `icon:{native}` → AppKit imageNamed
        // (same NSImageName* vocabulary as menu items); `imagePath`/`image`/
        // `icon:"/path"`/`icon:{path}` → file. Explicit null clears.
        let icon = request.args.get("icon");
        let image_name = request.opt_str("imageName").or_else(|| {
            icon.and_then(|v| v.get("native"))
                .and_then(Value::as_str)
                .map(String::from)
        });
        let image_path = request
            .opt_str("imagePath")
            .or_else(|| request.opt_str("image"))
            .or_else(|| {
                icon.and_then(|v| v.get("path"))
                    .and_then(Value::as_str)
                    .map(String::from)
            })
            .or_else(|| request.opt_str("icon"));
        if let Some(name) = image_name {
            let native = menu_ext::native_image_name(&name).ok_or_else(|| {
                PlatformError::invalid(format!("tray.set: unknown native icon `{name}`"))
            })?;
            let image: id = msg_send![class!(NSImage), imageNamed: native];
            if image == nil {
                return err(PlatformError::unavailable(format!(
                    "AppKit has no image for `{name}`"
                )));
            }
            let template = request.opt_bool("template").unwrap_or(true);
            let _: () = msg_send![image, setTemplate: if template { YES } else { NO }];
            let _: () = msg_send![button, setImage: image];
        } else {
            match image_path.as_deref() {
                Some(path) => {
                    let image: id = msg_send![
                        NSImage::alloc(nil).initWithContentsOfFile_(ns_string(path)),
                        autorelease
                    ];
                    if image == nil {
                        return err(PlatformError::unavailable(format!(
                            "tray.set: could not load image `{path}`"
                        )));
                    }
                    let template = request.opt_bool("template").unwrap_or(true);
                    let _: () = msg_send![image, setTemplate: if template { YES } else { NO }];
                    let _: () = msg_send![button, setImage: image];
                }
                None if request.args.get("imagePath").map_or(false, Value::is_null) => {
                    let _: () = msg_send![button, setImage: nil];
                }
                None => {}
            }
        }

        match request.args.get("badgeColor") {
            Some(v) if v.is_null() => {
                // Explicit null — restore the unbadged icon (reload from the
                // path when one was given, else clear).
                if let Some(path) = image_path.as_deref() {
                    let image: id = msg_send![
                        NSImage::alloc(nil).initWithContentsOfFile_(ns_string(path)),
                        autorelease
                    ];
                    let _: () = msg_send![button, setImage: image];
                } else {
                    let _: () = msg_send![button, setImage: nil];
                }
            }
            Some(v) => {
                let Some(text) = v.as_str() else {
                    return err(PlatformError::invalid(
                        "tray.set: `badgeColor` needs a color string",
                    ));
                };
                let Some(rgba) = crate::color::parse_color(text) else {
                    return err(PlatformError::invalid(format!(
                        "tray.set: unknown `badgeColor` `{text}`"
                    )));
                };
                let base: id = msg_send![button, image];
                let badged = badged_image(base, rgba);
                if badged == nil {
                    return err(PlatformError::internal(
                        "tray.set: badge image allocation failed",
                    ));
                }
                let _: () = msg_send![badged, setTemplate: NO];
                let _: () = msg_send![button, setImage: badged];
            }
            None => {}
        }

        match request.args.get("menu") {
            Some(spec) if spec.is_null() => {
                // Explicit null — detach the menu, wire the click.
                item.setMenu_(nil);
                let _: () = msg_send![button, setTarget: target()];
                let _: () = msg_send![button, setAction: sel!(trayClick:)];
            }
            Some(spec) => {
                let items = spec
                    .get("items")
                    .and_then(Value::as_array)
                    .or_else(|| spec.as_array())
                    .ok_or_else(|| {
                        PlatformError::invalid("tray.set: menu needs an `items` array")
                    })?;
                let menu = build_menu(items)?;
                item.setMenu_(menu);
                // With a menu attached, AppKit swallows the click — drop
                // the click wiring so the contract stays honest.
                let _: () = msg_send![button, setTarget: nil];
                let _: () = msg_send![button, setAction: null_sel()];
            }
            None => {
                // No menu argument — wire the click only when the item
                // has no menu attached.
                if item.menu() == nil {
                    let _: () = msg_send![button, setTarget: target()];
                    let _: () = msg_send![button, setAction: sel!(trayClick:)];
                }
            }
        }
        ok(json!({ "set": true }))
    }

    fn remove() -> OpResult {
        let mut guard = STATUS_ITEM.lock().unwrap_or_else(|p| p.into_inner());
        match guard.take() {
            Some(item) => unsafe {
                let item = item as id;
                NSStatusBar::systemStatusBar(nil).removeStatusItem_(item);
                let _: () = msg_send![item, release];
                ok(json!({ "removed": true }))
            },
            None => err(PlatformError::unavailable(
                "tray.remove: no status item is set",
            )),
        }
    }

    pub fn call(request: &PlatformRequest, _cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "set" | "create" => set(request),
            "remove" | "destroy" => remove(),
            "isSet" | "exists" => ok(json!(status_item(false) != nil)),
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown tray op `{op}`"),
            }),
        }
    }
}

/// `menu.insert` builds bar menus through the same builder so item ids and
/// `menuAction` events behave identically across tray, popup, and bar menus.
/// `action_target` is the shared `GpuixTrayTarget` whose `itemAction:` reads
/// `representedObject` and emits `menuAction`.
#[cfg(target_os = "macos")]
pub(crate) use imp::{build_menu, target as action_target};

/// Screen-space rect of the status item's button at the last `trayClick`,
/// `[x, y, width, height]` in top-left coordinates. Written by the
/// `trayClick:` handler inside `imp`; `None` before the first click —
/// `window.positionTo` presets answer `unavailable` then.
static LAST_BUTTON_RECT: Mutex<Option<[f64; 4]>> = Mutex::new(None);

pub fn last_button_rect() -> Option<[f64; 4]> {
    *LAST_BUTTON_RECT.lock().unwrap_or_else(|p| p.into_inner())
}
