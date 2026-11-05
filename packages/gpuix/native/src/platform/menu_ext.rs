//! Menu depth: item mutation by id, inspection, OS-role items, native
//! icons, and the standard about panel.
//!
//! Contract:
//!   `menu.update {id, text?, enabled?, checked?, accelerator?}` → null
//!   `menu.get {id}` → item descriptor | null
//!   `menu.items` → app-menu tree
//!   item spec extensions consumed by menu.setApplicationMenu/setDockMenu/
//!   popup/tray menus: `{role}` (predefined items) and `{icon:{native}}`.
//!   `app.aboutPanel {name?, version?, copyright?, credits?}` → null
//!
//! Lookup model: an item's JS id is its `representedObject` when a builder
//! set one (tray menus, popup menus, anything routed through
//! [`apply_item_extras`]). GPUI-built menus (`menu.setApplicationMenu`, the
//! launch menu from `app_menu::init`) instead carry a `tag` index into
//! GPUI's private action table, so the live `NSMenu` tree is zipped against
//! `App::get_menus()` positionally — the spec's action downcasts to
//! `PlatformMenuAction` and yields the JS id. OS-inserted entries (AppKit
//! appends window-list/tiling items to the Window menu) match no spec shape
//! and are skipped by the zipper.
//!
//! Residual assumption: the pairing holds only while `get_menus()` stays in
//! lockstep with the live bar's top-level items — if a gpui change ever
//! prepends an app menu the owned list doesn't include, every positional
//! pairing shifts and `menu.update` mutates the wrong item.
//!
//! The dock menu has no spec snapshot — gpui holds it in private state and
//! only hands out the live `NSMenu` through `applicationDockMenu:`. Dock
//! items therefore match by `representedObject` alone, which the gpui
//! builder never sets: `menu.update`/`menu.get` reach dock items only when
//! they were built by a builder that stores the id there.

use super::*;

pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
    #[cfg(target_os = "macos")]
    return imp::call(request, cx);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cx;
        err(PlatformError::unsupported(format!(
            "{}.{} is only implemented on macOS",
            request.service, request.op
        )))
    }
}

/// Shared item-spec extras for every NSMenu builder: `{role}` wires an
/// AppKit-native action, `{icon:{native|path}}` sets the item image.
/// `separator` is a deliberate no-op here — the builder decides when a spec
/// becomes `+separatorItem`. macOS-only: `id` is an ObjC pointer, so every
/// caller necessarily lives in a `cfg(macos)` module.
#[cfg(target_os = "macos")]
pub(crate) use imp::{apply_item_extras, native_image_name};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::platform::menu::PlatformMenuAction;
    use cocoa::appkit::{
        NSClearLineFunctionKey, NSDeleteFunctionKey, NSDownArrowFunctionKey, NSEndFunctionKey,
        NSEventModifierFlags, NSF1FunctionKey, NSHelpFunctionKey, NSHomeFunctionKey, NSImage,
        NSLeftArrowFunctionKey, NSMenu, NSMenuItem, NSPageDownFunctionKey, NSPageUpFunctionKey,
        NSRightArrowFunctionKey, NSUpArrowFunctionKey,
    };
    use cocoa::base::{id, nil, BOOL, NO, YES};
    use cocoa::foundation::{NSAutoreleasePool, NSInteger, NSString};
    use gpui::{OsAction, OwnedMenu, OwnedMenuItem};
    use objc::runtime::{Class, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    /// NSControlStateValueOn — menu items take NSInteger state, not BOOL.
    const NS_CONTROL_STATE_ON: NSInteger = 1;
    /// Defensive recursion cap — AppKit menus can't cycle, but the walk is
    /// cheap to bound anyway.
    const MAX_DEPTH: usize = 16;

    fn yes(value: BOOL) -> bool {
        value != NO
    }

    /// +1 from `init_str`; autoreleased into the dispatch-scoped pool.
    fn ns_string(value: &str) -> id {
        unsafe {
            let string: id = NSString::alloc(nil).init_str(value);
            msg_send![string, autorelease]
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

    fn require_app(op: &str) -> Result<id, PlatformError> {
        let app: id = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        if app.is_null() {
            err(PlatformError::unavailable(format!(
                "{op}: NSApplication is not initialized"
            )))
        } else {
            Ok(app)
        }
    }

    // ── Spec correlation ────────────────────────────────────────────

    /// A spec counterpart for a live NSMenuItem: either a top-level
    /// `OwnedMenu` (the menu-title item sitting in the bar) or an
    /// `OwnedMenuItem` inside one.
    #[derive(Clone, Copy)]
    enum Spec<'a> {
        Menu(&'a OwnedMenu),
        Item(&'a OwnedMenuItem),
    }

    impl<'a> Spec<'a> {
        /// Spec items for the live item's submenu. `SystemMenu` has none —
        /// the OS owns its children.
        fn child_items(&self) -> Option<&'a [OwnedMenuItem]> {
            match self {
                Spec::Menu(menu) => Some(&menu.items),
                Spec::Item(OwnedMenuItem::Submenu(menu)) => Some(&menu.items),
                _ => None,
            }
        }

        /// The JS id bound to a gpui action item — the spec action is a
        /// `PlatformMenuAction` for `menu.setApplicationMenu` items. `None`
        /// for separators, submenus, OS menus and the launch menu's own
        /// actions (Quit/Hide/…), which are typed gpui actions, not ids.
        fn js_id(&self) -> Option<String> {
            match self {
                Spec::Item(OwnedMenuItem::Action { action, .. }) => action
                    .as_any()
                    .downcast_ref::<PlatformMenuAction>()
                    .map(|action| action.id.to_string()),
                _ => None,
            }
        }
    }

    unsafe fn is_separator(item: id) -> bool {
        yes(msg_send![item, isSeparatorItem])
    }

    unsafe fn has_submenu(item: id) -> bool {
        let submenu: id = msg_send![item, submenu];
        submenu != nil
    }

    /// Structural match between a live item and the next spec entry. Shape
    /// alone isn't enough for actions — AppKit injects leaf items (tiling
    /// entries, the window list) into the windows menu — so an action spec
    /// also requires the item's action selector to be the one gpui's builder
    /// would have wired: `handleGPUIMenuItem:`, or the responder-chain
    /// selector for an `os_action`. An OS-inserted leaf never matches.
    unsafe fn spec_matches(item: id, spec: &OwnedMenuItem) -> bool {
        match spec {
            OwnedMenuItem::Separator => is_separator(item),
            OwnedMenuItem::Action { os_action, .. } => {
                if is_separator(item) || has_submenu(item) {
                    return false;
                }
                let action: Sel = msg_send![item, action];
                match os_action {
                    Some(OsAction::Cut) => action == sel!(cut:),
                    Some(OsAction::Copy) => action == sel!(copy:),
                    Some(OsAction::Paste) => action == sel!(paste:),
                    Some(OsAction::SelectAll) => action == sel!(selectAll:),
                    // Undo/Redo and plain actions all dispatch through gpui's
                    // handleGPUIMenuItem:.
                    _ => action == sel!(handleGPUIMenuItem:),
                }
            }
            OwnedMenuItem::Submenu(_) | OwnedMenuItem::SystemMenu(_) => has_submenu(item),
        }
    }

    /// Pair `menu`'s live items with `specs` in order. A live item whose
    /// shape doesn't match the next spec entry is an OS insertion and pairs
    /// with `None`; the spec is never skipped — gpui's builder emits exactly
    /// one NSMenuItem per spec entry, in order.
    unsafe fn zip_items<'a>(
        menu: id,
        specs: Option<&'a [OwnedMenuItem]>,
    ) -> Vec<(id, Option<Spec<'a>>)> {
        let count: NSInteger = msg_send![menu, numberOfItems];
        let mut pairs = Vec::with_capacity(count.max(0) as usize);
        let mut specs = specs.map(|items| items.iter().peekable());
        for index in 0..count {
            let item = menu.itemAtIndex_(index);
            if item == nil {
                continue;
            }
            let spec = specs.as_mut().and_then(|iter| {
                let matches = matches!(iter.peek(), Some(spec) if spec_matches(item, *spec));
                if matches {
                    iter.next().map(Spec::Item)
                } else {
                    None
                }
            });
            pairs.push((item, spec));
        }
        pairs
    }

    /// An NSString `representedObject` marks a foreign bar item — gpui's
    /// builder never sets one; `menu.insert` does (the menu name). Foreign
    /// items pair with `None` and must not consume a spec.
    unsafe fn has_repr_string(item: id) -> bool {
        let repr: id = msg_send![item, representedObject];
        if repr == nil {
            return false;
        }
        yes(msg_send![repr, isKindOfClass: class!(NSString)])
    }

    /// The menu bar's top-level pairing: every `OwnedMenu` becomes exactly
    /// one submenu'd bar item in order, so a bar item without a submenu —
    /// or one carrying our `representedObject` marker (`menu.insert`) — is
    /// foreign and consumes no spec.
    unsafe fn top_pairs<'a>(bar: id, menus: &'a [OwnedMenu]) -> Vec<(id, Option<Spec<'a>>)> {
        let count: NSInteger = msg_send![bar, numberOfItems];
        let mut pairs = Vec::with_capacity(count.max(0) as usize);
        let mut specs = menus.iter();
        for index in 0..count {
            let item = bar.itemAtIndex_(index);
            if item == nil {
                continue;
            }
            let spec = if has_submenu(item) && !has_repr_string(item) {
                specs.next().map(Spec::Menu)
            } else {
                None
            };
            pairs.push((item, spec));
        }
        pairs
    }

    /// The JS id for a live item: `representedObject` wins (our builders
    /// store it there); gpui-built items recover it from the spec.
    /// `representedObject` is user-defined — guard the NSString cast before
    /// sending `UTF8String` to whatever an OS-inserted item carries.
    unsafe fn item_id(item: id, spec: Option<&Spec>) -> Option<String> {
        let represented: id = msg_send![item, representedObject];
        if represented != nil {
            let is_string: BOOL = msg_send![
                represented,
                isKindOfClass: class!(NSString)
            ];
            if yes(is_string) {
                if let Some(text) = ns_to_string(represented) {
                    if !text.is_empty() {
                        return Some(text);
                    }
                }
            }
        }
        spec.and_then(Spec::js_id)
    }

    /// Depth-first search through a menu's live items, tracking the spec so
    /// gpui-built items match by their `PlatformMenuAction` id.
    unsafe fn find_in_menu<'a>(
        menu: id,
        specs: Option<&'a [OwnedMenuItem]>,
        wanted: &str,
        depth: usize,
    ) -> Option<(id, Option<Spec<'a>>)> {
        if depth > MAX_DEPTH {
            return None;
        }
        for (item, spec) in zip_items(menu, specs) {
            if item_id(item, spec.as_ref()).as_deref() == Some(wanted) {
                return Some((item, spec));
            }
            if has_submenu(item) {
                let submenu: id = msg_send![item, submenu];
                let child_specs = spec.as_ref().and_then(Spec::child_items);
                if let Some(found) = find_in_menu(submenu, child_specs, wanted, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }

    unsafe fn find_in_bar<'a>(
        bar: id,
        menus: &'a [OwnedMenu],
        wanted: &str,
    ) -> Option<(id, Option<Spec<'a>>)> {
        for (item, spec) in top_pairs(bar, menus) {
            if item_id(item, spec.as_ref()).as_deref() == Some(wanted) {
                return Some((item, spec));
            }
            if has_submenu(item) {
                let submenu: id = msg_send![item, submenu];
                let child_specs = spec.as_ref().and_then(Spec::child_items);
                if let Some(found) = find_in_menu(submenu, child_specs, wanted, 1) {
                    return Some(found);
                }
            }
        }
        None
    }

    /// The gpui dock menu lives in private platform state; the app delegate
    /// hands out the live NSMenu through `applicationDockMenu:` — the same
    /// hook the Dock itself calls.
    unsafe fn dock_menu(app: id) -> Option<id> {
        let delegate: id = msg_send![app, delegate];
        if delegate == nil {
            return None;
        }
        let responds: BOOL = msg_send![delegate, respondsToSelector: sel!(applicationDockMenu:)];
        if !yes(responds) {
            return None;
        }
        let menu: id = msg_send![delegate, applicationDockMenu: app];
        (menu != nil).then_some(menu)
    }

    /// `representedObject`-then-spec lookup across the menu bar, then the
    /// dock menu (spec-less — gpui retains no owned copy of the dock spec).
    unsafe fn find_by_id<'a>(
        app: id,
        menus: &'a [OwnedMenu],
        wanted: &str,
    ) -> Option<(id, Option<Spec<'a>>)> {
        let bar: id = msg_send![app, mainMenu];
        if bar != nil {
            if let Some(found) = find_in_bar(bar, menus, wanted) {
                return Some(found);
            }
        }
        if let Some(dock) = dock_menu(app) {
            if let Some(found) = find_in_menu(dock, None, wanted, 0) {
                return Some(found);
            }
        }
        None
    }

    // ── Descriptors ─────────────────────────────────────────────────

    /// JSON descriptor for a live item. Separators report only
    /// `{"separator": true}` — they carry no label/state worth echoing.
    /// Everything else reports `text`/`enabled`/`checked`, plus `id` when
    /// one resolves and a recursive `submenu` for submenu'd items.
    unsafe fn item_json(item: id, spec: Option<Spec>, depth: usize) -> Value {
        if is_separator(item) {
            return json!({ "separator": true });
        }
        let title: id = msg_send![item, title];
        let enabled: BOOL = msg_send![item, isEnabled];
        let state: NSInteger = msg_send![item, state];
        let mut value = json!({
            "text": ns_to_string(title).unwrap_or_default(),
            "enabled": yes(enabled),
            "checked": state == NS_CONTROL_STATE_ON,
        });
        if let Some(item_id) = item_id(item, spec.as_ref()) {
            value["id"] = json!(item_id);
        }
        if depth < MAX_DEPTH && has_submenu(item) {
            let submenu: id = msg_send![item, submenu];
            let children = items_json(submenu, spec.and_then(|s| s.child_items()), depth + 1);
            value["submenu"] = json!(children);
        }
        value
    }

    unsafe fn items_json(menu: id, specs: Option<&[OwnedMenuItem]>, depth: usize) -> Vec<Value> {
        if depth > MAX_DEPTH {
            return Vec::new();
        }
        zip_items(menu, specs)
            .into_iter()
            .map(|(item, spec)| item_json(item, spec, depth))
            .collect()
    }

    // ── Accelerator → keyEquivalent ─────────────────────────────────
    // Same grammar as `hotkeys.rs::parse_accelerator` — which is private and
    // returns Carbon keycodes anyway, so the modifier vocabulary is copied
    // here and the key half maps to AppKit keyEquivalent strings instead.

    fn normalized(part: &str) -> String {
        part.trim().to_ascii_lowercase()
    }

    fn is_modifier(part: &str) -> bool {
        matches!(
            part,
            "cmdorctrl"
                | "commandorcontrol"
                | "cmd"
                | "command"
                | "super"
                | "meta"
                | "shift"
                | "alt"
                | "option"
                | "ctrl"
                | "control"
        )
    }

    fn modifier_flag(part: &str) -> Option<NSEventModifierFlags> {
        Some(match part {
            "cmdorctrl" | "commandorcontrol" | "cmd" | "command" | "super" | "meta" => {
                NSEventModifierFlags::NSCommandKeyMask
            }
            "shift" => NSEventModifierFlags::NSShiftKeyMask,
            "alt" | "option" => NSEventModifierFlags::NSAlternateKeyMask,
            "ctrl" | "control" => NSEventModifierFlags::NSControlKeyMask,
            _ => return None,
        })
    }

    /// Key name → `keyEquivalent` string: named keys map to the
    /// NS*FunctionKey code points (matching gpui's `key_to_native`), named
    /// characters and numpad keys to their characters, and any single
    /// character maps to itself — NSMenuItem equivalents are lowercase and
    /// Shift lives in the modifier mask.
    fn key_equivalent(name: &str) -> Option<String> {
        let name = normalized(name);
        let utf16 = |code: u16| String::from_utf16(&[code]).unwrap_or_default();
        let special = match name.as_str() {
            "up" | "uparrow" => NSUpArrowFunctionKey,
            "down" | "downarrow" => NSDownArrowFunctionKey,
            "left" | "leftarrow" => NSLeftArrowFunctionKey,
            "right" | "rightarrow" => NSRightArrowFunctionKey,
            "pageup" => NSPageUpFunctionKey,
            "pagedown" => NSPageDownFunctionKey,
            "home" => NSHomeFunctionKey,
            "end" => NSEndFunctionKey,
            "forwarddelete" | "del" => NSDeleteFunctionKey,
            "insert" => NSHelpFunctionKey,
            "numclear" | "numpadclear" => NSClearLineFunctionKey,
            _ => 0,
        };
        if special != 0 {
            return Some(utf16(special));
        }
        // f1..f35 are consecutive from NSF1FunctionKey.
        if let Some(number) = name
            .strip_prefix('f')
            .and_then(|rest| rest.parse::<u16>().ok())
        {
            if (1..=35).contains(&number) {
                return Some(utf16(NSF1FunctionKey + number - 1));
            }
        }
        // Numpad digits share the digit characters — key equivalents can't
        // distinguish numpad from row keys.
        if let Some(digit) = name
            .strip_prefix("num")
            .and_then(|rest| rest.parse::<u16>().ok())
        {
            if digit <= 9 {
                return Some(digit.to_string());
            }
        }
        Some(match name.as_str() {
            "space" | "spacebar" => " ".into(),
            // NSDeleteCharacter — the ⌫ key's character.
            "backspace" | "delete" => "\u{7f}".into(),
            "escape" | "esc" => "\u{1b}".into(),
            "return" | "enter" => "\r".into(),
            // NSEnterCharacter — the keypad ⌤.
            "numenter" | "numpadenter" => "\u{3}".into(),
            "tab" => "\t".into(),
            // NSBackTabCharacter — ⇧⇥.
            "backtab" => "\u{19}".into(),
            "equal" | "plus" => "=".into(),
            "minus" => "-".into(),
            "rightbracket" => "]".into(),
            "leftbracket" => "[".into(),
            "quote" | "apostrophe" => "'".into(),
            "semicolon" => ";".into(),
            "backslash" => "\\".into(),
            "comma" => ",".into(),
            "slash" => "/".into(),
            "period" => ".".into(),
            "grave" | "backquote" | "backtick" => "`".into(),
            "numdec" | "numpaddecimal" => ".".into(),
            "nummult" | "numpadmultiply" => "*".into(),
            "numadd" | "numpadadd" => "+".into(),
            "numsub" | "numpadsubtract" => "-".into(),
            "numdiv" | "numpaddivide" => "/".into(),
            "numeq" | "numpadequals" => "=".into(),
            single if single.chars().count() == 1 => single.into(),
            _ => return None,
        })
    }

    /// "CmdOrCtrl+Shift+K" → (`keyEquivalent`, `NSEventModifierFlags`). The
    /// key is the last `+` segment; a trailing `+` means the `+`/`=` key.
    fn parse_accelerator(
        accelerator: &str,
    ) -> Result<(String, NSEventModifierFlags), PlatformError> {
        if accelerator.trim().is_empty() {
            return err(PlatformError::invalid(
                "menu.update: accelerator must not be empty",
            ));
        }
        let (mods_str, key_str) = match accelerator.rfind('+') {
            Some(index) => (&accelerator[..index], &accelerator[index + 1..]),
            None => ("", accelerator),
        };
        let key_name = if key_str.is_empty() { "+" } else { key_str };

        let mut mask = NSEventModifierFlags::empty();
        if !mods_str.is_empty() {
            for part in mods_str.split('+') {
                let part = normalized(part);
                match modifier_flag(&part) {
                    Some(flag) => mask |= flag,
                    None => {
                        return err(PlatformError::invalid(format!(
                            "menu.update: unknown modifier `{part}` in `{accelerator}`"
                        )))
                    }
                }
            }
        }

        if is_modifier(&normalized(key_name)) {
            return err(PlatformError::invalid(format!(
                "menu.update: `{accelerator}` needs a non-modifier key"
            )));
        }
        let key = key_equivalent(key_name).ok_or_else(|| {
            PlatformError::invalid(format!(
                "menu.update: unknown key `{key_name}` in `{accelerator}`"
            ))
        })?;
        Ok((key, mask))
    }

    // ── Item-spec extras: {role}, {icon} ────────────────────────────

    /// `{role}` → predefined OS behavior. Responder-chain actions take a nil
    /// target (the chain ends at NSApp anyway); app-scoped roles target
    /// NSApp directly. `services` attaches the empty NSMenu the services
    /// system populates.
    unsafe fn apply_role(item: id, role: &str) -> Result<(), PlatformError> {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let (action, target): (Sel, id) = match role.trim().to_ascii_lowercase().as_str() {
            "copy" => (sel!(copy:), nil),
            "paste" => (sel!(paste:), nil),
            "cut" => (sel!(cut:), nil),
            "selectall" => (sel!(selectAll:), nil),
            "undo" => (sel!(undo:), nil),
            "redo" => (sel!(redo:), nil),
            "pasteandmatchstyle" | "pasteasplaintext" => (sel!(pasteAsPlainText:), nil),
            "delete" => (sel!(delete:), nil),
            "minimize" => (sel!(performMiniaturize:), nil),
            "zoom" | "maximize" => (sel!(performZoom:), nil),
            "close" | "closewindow" => (sel!(performClose:), nil),
            "togglefullscreen" | "fullscreen" => (sel!(toggleFullScreen:), nil),
            "startspeaking" => (sel!(startSpeaking:), nil),
            "stopspeaking" => (sel!(stopSpeaking:), nil),
            "about" => (sel!(orderFrontStandardAboutPanel:), nil),
            "quit" => (sel!(terminate:), app),
            "hide" => (sel!(hide:), app),
            "hideothers" | "hideotherapplications" => (sel!(hideOtherApplications:), app),
            "showall" | "unhideall" | "unhideallapplications" => {
                (sel!(unhideAllApplications:), app)
            }
            "services" => {
                if app == nil {
                    return err(PlatformError::unavailable(
                        "menu role `services`: NSApplication is not initialized",
                    ));
                }
                // Register the item's submenu — an explicit `submenu` spec
                // wins; otherwise attach the empty menu the services system
                // populates. `setServicesMenu:` takes the NSMenu itself.
                let mut submenu: id = msg_send![item, submenu];
                if submenu == nil {
                    submenu = msg_send![
                        NSMenu::alloc(nil).initWithTitle_(ns_string("Services")),
                        autorelease
                    ];
                    if submenu == nil {
                        return err(PlatformError::internal(
                            "menu role `services`: NSMenu allocation failed",
                        ));
                    }
                    item.setSubmenu_(submenu);
                }
                let _: () = msg_send![app, setServicesMenu: submenu];
                // A role item with no label needs some title to be clickable.
                let title: id = msg_send![item, title];
                if ns_to_string(title).unwrap_or_default().is_empty() {
                    let _: () = msg_send![item, setTitle: ns_string("Services")];
                }
                return Ok(());
            }
            // The builder turns it into +separatorItem — nothing to wire.
            "separator" => return Ok(()),
            other => {
                return err(PlatformError::invalid(format!(
                    "unknown menu item role `{other}`"
                )))
            }
        };
        let _: () = msg_send![item, setAction: action];
        let _: () = msg_send![item, setTarget: target];
        Ok(())
    }

    /// `{icon:{native}}` — Tauri's `NativeIcon` vocabulary over `NSImageName*`
    /// constants (matched case-insensitively), plus a few extras AppKit menus
    /// use often.
    pub(crate) unsafe fn native_image_name(name: &str) -> Option<id> {
        Some(match name.to_ascii_lowercase().as_str() {
            "add" => cocoa::appkit::NSImageNameAddTemplate,
            "advanced" => cocoa::appkit::NSImageNameAdvanced,
            "bluetooth" => cocoa::appkit::NSImageNameBluetoothTemplate,
            "bookmarks" => cocoa::appkit::NSImageNameBookmarksTemplate,
            "caution" => cocoa::appkit::NSImageNameCaution,
            "color" | "colorpanel" => cocoa::appkit::NSImageNameColorPanel,
            "columnview" => cocoa::appkit::NSImageNameColumnViewTemplate,
            "computer" => cocoa::appkit::NSImageNameComputer,
            "enterfullscreen" => cocoa::appkit::NSImageNameEnterFullScreenTemplate,
            "exitfullscreen" => cocoa::appkit::NSImageNameExitFullScreenTemplate,
            "folder" => cocoa::appkit::NSImageNameFolder,
            "folderburnable" => cocoa::appkit::NSImageNameFolderBurnable,
            "foldersmart" => cocoa::appkit::NSImageNameFolderSmart,
            "followlinkfreestandingtemplate" => cocoa::appkit::NSImageNameFollowLinkFreestandingTemplate,
            "fontpanel" => cocoa::appkit::NSImageNameFontPanel,
            "goleft" => cocoa::appkit::NSImageNameGoLeftTemplate,
            "goright" => cocoa::appkit::NSImageNameGoRightTemplate,
            "home" => cocoa::appkit::NSImageNameHomeTemplate,
            "ichattheater" => cocoa::appkit::NSImageNameIChatTheaterTemplate,
            "listview" => cocoa::appkit::NSImageNameListViewTemplate,
            "locklocked" => cocoa::appkit::NSImageNameLockLockedTemplate,
            "lockunlocked" => cocoa::appkit::NSImageNameLockUnlockedTemplate,
            "menumixedstate" => cocoa::appkit::NSImageNameMenuMixedStateTemplate,
            "me" => ns_string("NSMe"),
            "noaccounts" => ns_string("NSNoAccounts"),
            "openpanel" => ns_string("NSOpenPanel"),
            "preferencesgeneral" => cocoa::appkit::NSImageNamePreferencesGeneral,
            "quicklook" => cocoa::appkit::NSImageNameQuickLookTemplate,
            "refresh" => cocoa::appkit::NSImageNameRefreshTemplate,
            "refreshfreestanding" => cocoa::appkit::NSImageNameRefreshFreestandingTemplate,
            "remove" => cocoa::appkit::NSImageNameRemoveTemplate,
            "reveal" => ns_string("NSRevealTemplate"),
            "revealfreestanding" => cocoa::appkit::NSImageNameRevealFreestandingTemplate,
            "rightfacingtriangle" => cocoa::appkit::NSImageNameRightFacingTriangleTemplate,
            "share" => cocoa::appkit::NSImageNameShareTemplate,
            "slideshow" => cocoa::appkit::NSImageNameSlideshowTemplate,
            "smartbadge" => cocoa::appkit::NSImageNameSmartBadgeTemplate,
            "statusavailable" => cocoa::appkit::NSImageNameStatusAvailable,
            "statusnone" => cocoa::appkit::NSImageNameStatusNone,
            "statuspartiallyavailable" => cocoa::appkit::NSImageNameStatusPartiallyAvailable,
            "statusunavailable" => cocoa::appkit::NSImageNameStatusUnavailable,
            "stopprogress" => cocoa::appkit::NSImageNameStopProgressTemplate,
            "stopprogressfreestanding" => cocoa::appkit::NSImageNameStopProgressFreestandingTemplate,
            "trashempty" => cocoa::appkit::NSImageNameTrashEmpty,
            "trashfull" => cocoa::appkit::NSImageNameTrashFull,
            "user" => cocoa::appkit::NSImageNameUser,
            "useraccounts" => cocoa::appkit::NSImageNameUserAccounts,
            "usergroup" => cocoa::appkit::NSImageNameUserGroup,
            "userguest" => cocoa::appkit::NSImageNameUserGuest,
            // Useful extras beyond Tauri's enum.
            "actiontemplate" => cocoa::appkit::NSImageNameActionTemplate,
            "leftfacingtriangle" => cocoa::appkit::NSImageNameLeftFacingTriangleTemplate,
            "multipledocuments" => cocoa::appkit::NSImageNameMultipleDocuments,
            "network" => cocoa::appkit::NSImageNameNetwork,
            "bonjour" => cocoa::appkit::NSImageNameBonjour,
            "everyone" => cocoa::appkit::NSImageNameEveryone,
            "freestandingtemplate" => ns_string("NSFreestandingTemplate"),
            "invaliddatafreestanding" => cocoa::appkit::NSImageNameInvalidDataFreestandingTemplate,
            "mobileme" => cocoa::appkit::NSImageNameMobileMe,
            _ => return None,
        })
    }

    /// `{icon}` → `setImage:`. `icon:null` clears; `{native:name}` goes
    /// through `+imageNamed:` (autoreleased convenience constructor),
    /// `{path:p}` through `initWithContentsOfFile:`. Menu-item images draw at
    /// the image's natural size — native icons are pre-sized templates;
    /// `{path}` callers should supply ~16px artwork.
    unsafe fn apply_icon(spec: &Value, item: id) -> Result<(), PlatformError> {
        match spec.get("icon") {
            None => Ok(()),
            Some(Value::Null) => {
                let _: () = msg_send![item, setImage: nil];
                Ok(())
            }
            Some(icon) => {
                if let Some(native) = icon.get("native").and_then(Value::as_str) {
                    let name = native_image_name(native).ok_or_else(|| {
                        PlatformError::invalid(format!("unknown native icon `{native}`"))
                    })?;
                    // cocoa's NSImageName* statics are the runtime NSString
                    // objects — the string values differ from the constant
                    // names (NSImageNameAddTemplate → @"NSAddTemplate").
                    let image: id = msg_send![class!(NSImage), imageNamed: name];
                    if image == nil {
                        return err(PlatformError::unavailable(format!(
                            "AppKit has no image for `{native}`"
                        )));
                    }
                    let _: () = msg_send![item, setImage: image];
                    Ok(())
                } else if let Some(path) = icon
                    .get("path")
                    .or_else(|| icon.get("file"))
                    .and_then(Value::as_str)
                {
                    let image: id = msg_send![
                        NSImage::alloc(nil).initWithContentsOfFile_(ns_string(path)),
                        autorelease
                    ];
                    if image == nil {
                        return err(PlatformError::invalid(format!(
                            "could not load menu icon `{path}`"
                        )));
                    }
                    let _: () = msg_send![item, setImage: image];
                    Ok(())
                } else {
                    err(PlatformError::invalid(
                        "menu `icon` needs `native` (AppKit name) or `path` (file)",
                    ))
                }
            }
        }
    }

    /// `{role}`/`{icon}` extras for an already-built item — called by every
    /// NSMenu builder after its own spec handling. No-op when neither key is
    /// present; unknown roles/icons are `invalid_args`, ObjC allocation
    /// failures `internal`.
    pub(crate) fn apply_item_extras(spec: &Value, item: id) -> Result<(), PlatformError> {
        if item == nil {
            return err(PlatformError::internal("apply_item_extras: nil NSMenuItem"));
        }
        unsafe {
            match spec.get("role") {
                None | Some(Value::Null) => {}
                Some(role) => match role.as_str() {
                    Some(role) => apply_role(item, role)?,
                    None => return err(PlatformError::invalid("menu `role` must be a string")),
                },
            }
            apply_icon(spec, item)
        }
    }

    // ── Ops ─────────────────────────────────────────────────────────

    /// Index of the bar item whose title is `title` — `insert`'s default
    /// slot is before "Window" (the conventional trailing menu).
    unsafe fn bar_item_index(bar: id, title: &str) -> Option<NSInteger> {
        let count: NSInteger = msg_send![bar, numberOfItems];
        for index in 0..count {
            let item = bar.itemAtIndex_(index);
            if item == nil {
                continue;
            }
            if ns_to_string(msg_send![item, title]).as_deref() == Some(title) {
                return Some(index);
            }
        }
        None
    }

    /// Drop a bar item by `representedObject` name or title. Returns whether
    /// anything was removed.
    unsafe fn remove_bar_item(bar: id, name: &str) -> bool {
        let count: NSInteger = msg_send![bar, numberOfItems];
        for index in 0..count {
            let item = bar.itemAtIndex_(index);
            if item == nil {
                continue;
            }
            let hit = has_repr_string(item)
                && ns_to_string(msg_send![item, representedObject]).as_deref() == Some(name);
            let hit =
                hit || ns_to_string(msg_send![item, title]).as_deref() == Some(name);
            if hit {
                let _: () = msg_send![bar, removeItemAtIndex: index];
                return true;
            }
        }
        false
    }

    /// `menu.insert {name, icon?, items?, id?, index?}` — add one top-level
    /// bar entry without touching the gpui-owned menus (`setAppMenu` is a
    /// wholesale replace). With `items` the entry owns a submenu built by
    /// the shared NSMenu builder; without them it is a plain clickable bar
    /// item firing `menuAction` with `id` (falling back to the name).
    /// `representedObject` carries the name so `top_pairs`/`item_id` treat
    /// the entry as foreign-but-findable. Re-inserting a name replaces it.
    unsafe fn insert(request: &PlatformRequest) -> OpResult {
        let app = require_app("menu.insert")?;
        let bar: id = msg_send![app, mainMenu];
        if bar == nil {
            return err(PlatformError::unavailable("menu.insert: no main menu"));
        }
        let name = request
            .opt_str("name")
            .or_else(|| request.opt_str("label"))
            .ok_or_else(|| PlatformError::invalid("menu.insert needs a `name`"))?;
        let items = request.args.get("items").and_then(Value::as_array);

        remove_bar_item(bar, &name);

        let item: id = msg_send![NSMenuItem::new(nil), autorelease];
        if item == nil {
            return err(PlatformError::internal("menu.insert: NSMenuItem alloc failed"));
        }
        let _: () = msg_send![item, setTitle: ns_string(&name)];
        let repr = ns_string(&name);
        let _: () = msg_send![item, setRepresentedObject: repr];

        match items {
            Some(items) => {
                let submenu = crate::platform::tray::build_menu(items)?;
                let _: () = msg_send![submenu, setTitle: ns_string(&name)];
                item.setSubmenu_(submenu);
            }
            None => {
                let action_id = request
                    .opt_str("id")
                    .unwrap_or_else(|| name.clone());
                let _: () = msg_send![item, setTarget: crate::platform::tray::action_target()];
                let _: () = msg_send![item, setAction: sel!(itemAction:)];
                let repr = ns_string(&action_id);
                let _: () = msg_send![item, setRepresentedObject: repr];
            }
        }
        apply_item_extras(&request.args, item)?;

        let count: NSInteger = msg_send![bar, numberOfItems];
        let index = match request.opt_f64("index")? {
            Some(i) => (i.max(0.0) as NSInteger).min(count),
            None => bar_item_index(bar, "Window").unwrap_or(count),
        };
        let _: () = msg_send![bar, insertItem: item atIndex: index];
        ok(json!({ "inserted": true, "name": name }))
    }

    /// `menu.remove {name}` — drop a top-level bar entry by name.
    unsafe fn remove(request: &PlatformRequest) -> OpResult {
        let app = require_app("menu.remove")?;
        let bar: id = msg_send![app, mainMenu];
        if bar == nil {
            return err(PlatformError::unavailable("menu.remove: no main menu"));
        }
        let name = request
            .opt_str("name")
            .or_else(|| request.opt_str("label"))
            .ok_or_else(|| PlatformError::invalid("menu.remove needs a `name`"))?;
        if !remove_bar_item(bar, &name) {
            return err(PlatformError::unavailable(format!(
                "menu.remove: no menu named `{name}`"
            )));
        }
        ok(json!({ "removed": true, "name": name }))
    }

    fn update(request: &PlatformRequest, cx: &mut App) -> OpResult {
        let id = request.str_arg("id")?;
        let app = require_app("menu.update")?;
        let menus = cx.get_menus().unwrap_or_default();
        let found = unsafe { find_by_id(app, &menus, &id) };
        let Some((item, _spec)) = found else {
            return err(PlatformError::unavailable(format!(
                "menu.update: no menu item with id `{id}`"
            )));
        };
        unsafe {
            if let Some(text) = request
                .opt_str("text")
                .or_else(|| request.opt_str("label"))
                .or_else(|| request.opt_str("title"))
            {
                // +1 NSString handed to setTitle:, which retains — release
                // our reference so the string belongs to the item alone.
                let title = nsstring(&text);
                let _: () = msg_send![item, setTitle: title];
                let _: () = msg_send![title, release];
            }
            if let Some(enabled) = request.opt_bool("enabled") {
                // gpui menus keep autoenablesItems on; the delegate's
                // validateMenuItem: (is_action_available) then overrides
                // isEnabled on every open. Take the parent menu out of
                // auto-enable so this explicit state survives — the same
                // choice the tray/popup builders make up front.
                let parent: id = msg_send![item, menu];
                if parent != nil {
                    let _: () = msg_send![parent, setAutoenablesItems: NO];
                }
                let _: () = msg_send![item, setEnabled: if enabled { YES } else { NO }];
            }
            if let Some(checked) = request.opt_bool("checked") {
                let _: () = msg_send![
                    item,
                    setState: if checked { NS_CONTROL_STATE_ON } else { 0 }
                ];
            }
            if let Some(accelerator) = request
                .args
                .get("accelerator")
                .or_else(|| request.args.get("accel"))
            {
                if accelerator.is_null() || accelerator.as_str().map_or(false, |a| a.is_empty()) {
                    // null/"" clears the key equivalent.
                    let _: () = msg_send![item, setKeyEquivalent: ns_string("")];
                    item.setKeyEquivalentModifierMask_(NSEventModifierFlags::empty());
                } else if let Some(accelerator) = accelerator.as_str() {
                    let (key, mask) = parse_accelerator(accelerator)?;
                    let equivalent = nsstring(&key);
                    let _: () = msg_send![item, setKeyEquivalent: equivalent];
                    let _: () = msg_send![equivalent, release];
                    item.setKeyEquivalentModifierMask_(mask);
                    // macOS 12+ would otherwise rewrite e.g. ⌘Q on layouts
                    // where Q isn't where AppKit expects — same guard gpui's
                    // builder applies.
                    let responds: BOOL = msg_send![
                        item,
                        respondsToSelector: sel!(setAllowsAutomaticKeyEquivalentLocalization:)
                    ];
                    if yes(responds) {
                        let _: () = msg_send![
                            item,
                            setAllowsAutomaticKeyEquivalentLocalization: NO
                        ];
                    }
                } else {
                    return err(PlatformError::invalid(
                        "menu.update: `accelerator` must be a string or null",
                    ));
                }
            }
        }
        ok(Value::Null)
    }

    fn get(request: &PlatformRequest, cx: &mut App) -> OpResult {
        let id = request.str_arg("id")?;
        let app = require_app("menu.get")?;
        let menus = cx.get_menus().unwrap_or_default();
        unsafe {
            match find_by_id(app, &menus, &id) {
                Some((item, spec)) => {
                    let mut value = item_json(item, spec, 0);
                    // The descriptor always echoes the looked-up id.
                    value["id"] = json!(id);
                    ok(value)
                }
                None => ok(Value::Null),
            }
        }
    }

    fn items(cx: &mut App) -> OpResult {
        let app = require_app("menu.items")?;
        let menus = cx.get_menus().unwrap_or_default();
        unsafe {
            let bar: id = msg_send![app, mainMenu];
            if bar == nil {
                return ok(json!([]));
            }
            let tree = top_pairs(bar, &menus)
                .into_iter()
                .map(|(item, spec)| item_json(item, spec, 0))
                .collect::<Vec<_>>();
            ok(json!(tree))
        }
    }

    /// Autoreleased NSAttributedString, or None when the class can't be
    /// resolved — the about panel also renders a plain NSString for credits.
    unsafe fn attributed_string(text: &str) -> Option<id> {
        let class = Class::get("NSAttributedString")?;
        let string: id = msg_send![class, alloc];
        if string == nil {
            return None;
        }
        let string: id = msg_send![string, initWithString: ns_string(text)];
        if string == nil {
            return None;
        }
        Some(msg_send![string, autorelease])
    }

    fn about_panel(request: &PlatformRequest) -> OpResult {
        let app = require_app("app.aboutPanel")?;
        unsafe {
            let options: id = msg_send![class!(NSMutableDictionary), dictionary];
            if options == nil {
                return err(PlatformError::internal(
                    "app.aboutPanel: NSMutableDictionary allocation failed",
                ));
            }
            // `version` fills NSAboutPanelOptionApplicationVersion — the
            // string the panel renders as "Version <v>". The separate
            // `Version` key is the build number, which the contract doesn't
            // expose.
            for (key, value) in [
                ("ApplicationName", request.opt_str("name")),
                ("ApplicationVersion", request.opt_str("version")),
                ("Copyright", request.opt_str("copyright")),
            ] {
                if let Some(value) = value {
                    let _: () = msg_send![
                        options,
                        setObject: ns_string(&value)
                        forKey: ns_string(key)
                    ];
                }
            }
            if let Some(credits) = request.opt_str("credits") {
                let value = attributed_string(&credits).unwrap_or_else(|| ns_string(&credits));
                let _: () = msg_send![
                    options,
                    setObject: value
                    forKey: ns_string("Credits")
                ];
            }
            let _: () = msg_send![app, orderFrontStandardAboutPanelWithOptions: options];
        }
        ok(Value::Null)
    }

    // ── Dispatch ────────────────────────────────────────────────────

    pub fn call(request: &PlatformRequest, cx: &mut App) -> OpResult {
        // Dispatch-scoped autorelease pool — every ns_string()/NSMenu built
        // above drains here; AppKit retains what it needs.
        let pool = unsafe { NSAutoreleasePool::new(nil) };
        let result = dispatch(request, cx);
        unsafe { pool.drain() };
        result
    }

    fn dispatch(request: &PlatformRequest, cx: &mut App) -> OpResult {
        match (request.service.as_str(), request.op.as_str()) {
            ("menu", "update") | ("menu", "updateItem") => update(request, cx),
            ("menu", "get") | ("menu", "getItem") => get(request, cx),
            ("menu", "insert") | ("menu", "insertMenu") | ("menu", "addMenu") => unsafe {
                insert(request)
            },
            ("menu", "remove") | ("menu", "removeMenu") => unsafe { remove(request) },
            ("menu", "items") | ("menu", "getItems") | ("menu", "tree") => items(cx),
            ("app", "aboutPanel") | ("app", "about") | ("menu", "aboutPanel") => {
                about_panel(request)
            }
            (service, op) => err(PlatformError {
                code: "unknown",
                message: format!("menu_ext does not implement {service}.{op}"),
            }),
        }
    }
}
