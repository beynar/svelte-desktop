//! Global keyboard shortcuts — Carbon RegisterEventHotKey on macOS (still the
//! reliable global-hotkey path; it needs no accessibility permission).
//! Ops: register {accelerator,id?} → {id}, unregister {id}, unregisterAll,
//!      isRegistered {id} → bool.
//! Events: shortcutPressed {id}, shortcutReleased {id}.
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
            "global shortcuts are not implemented on this OS",
        ))
    }
}

/// Install the Carbon event handler once at app-launch.
pub fn register() {
    #[cfg(target_os = "macos")]
    imp::install();
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    // ── Carbon FFI (HIToolbox CarbonEvents.h / Events.h) ────────────────

    type OSStatus = i32;
    type EventRef = *mut c_void;
    type EventTargetRef = *mut c_void;
    type EventHandlerCallRef = *mut c_void;
    type EventHandlerRef = *mut c_void;
    type EventHotKeyRef = *mut c_void;
    type EventHandlerUPP =
        unsafe extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

    #[repr(C)]
    struct EventHotKeyID {
        signature: u32,
        id: u32,
    }

    #[repr(C)]
    struct EventTypeSpec {
        event_class: u32,
        event_kind: u32,
    }

    /// Our EventHotKeyID signature: OSType 'sgfx'.
    const HOTKEY_SIGNATURE: u32 = u32::from_be_bytes(*b"sgfx");
    /// OSType 'keyb'.
    const EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    /// OSType '----' — kEventParamDirectObject.
    const PARAM_DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
    /// OSType 'hkid' — typeEventHotKeyID.
    const TYPE_EVENT_HOTKEY_ID: u32 = u32::from_be_bytes(*b"hkid");

    const EVENT_HOTKEY_PRESSED: u32 = 5;
    const EVENT_HOTKEY_RELEASED: u32 = 6;

    /// CarbonErrors.h — returning this lets the event reach other handlers
    /// (e.g. hotkeys registered by another library in the same process).
    const EVENT_NOT_HANDLED_ERR: OSStatus = -9874;

    // Carbon modifier masks (HIToolbox Events.h).
    const CMD_KEY: u32 = 0x0100;
    const SHIFT_KEY: u32 = 0x0200;
    const OPTION_KEY: u32 = 0x0800;
    const CONTROL_KEY: u32 = 0x1000;

    #[allow(non_snake_case)]
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn GetApplicationEventTarget() -> EventTargetRef;
        fn InstallEventHandler(
            target: EventTargetRef,
            handler: EventHandlerUPP,
            num_types: usize, // ItemCount
            list: *const EventTypeSpec,
            user_data: *mut c_void,
            out_ref: *mut EventHandlerRef,
        ) -> OSStatus;
        fn RegisterEventHotKey(
            code: u32,
            modifiers: u32,
            hotkey_id: EventHotKeyID,
            target: EventTargetRef,
            options: u32, // OptionBits
            out_ref: *mut EventHotKeyRef,
        ) -> OSStatus;
        fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> OSStatus;
        fn GetEventParameter(
            event: EventRef,
            name: u32,
            desired_type: u32,
            actual_type: *mut u32,
            buffer_size: usize, // ByteCount
            actual_size: *mut usize,
            out_data: *mut c_void,
        ) -> OSStatus;
        fn GetEventKind(event: EventRef) -> u32;
    }

    struct Registration {
        /// Packed (keycode << 32 | modifiers) for duplicate detection.
        combo: u64,
        /// EventHotKeyID.id for the pressed/released lookup.
        numeric: u32,
        /// EventHotKeyRef as usize — ObjC/Carbon pointers are !Sync.
        hotkey_ref: usize,
    }

    /// String id → live registration.
    static REGISTRATIONS: OnceLock<Mutex<HashMap<String, Registration>>> = OnceLock::new();
    /// Numeric EventHotKeyID.id → string id for the Carbon handler.
    static ID_MAP: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();
    static NEXT_ID: AtomicU32 = AtomicU32::new(1);
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    fn registrations() -> &'static Mutex<HashMap<String, Registration>> {
        REGISTRATIONS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn id_map() -> &'static Mutex<HashMap<u32, String>> {
        ID_MAP.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// The Carbon hot-key handler. Runs on the main thread's event loop;
    /// the EventHotKeyID arrives as the direct-object parameter.
    unsafe extern "C" fn hotkey_handler(
        _next: EventHandlerCallRef,
        event: EventRef,
        _user_data: *mut c_void,
    ) -> OSStatus {
        let mut hotkey_id = EventHotKeyID {
            signature: 0,
            id: 0,
        };
        let status = GetEventParameter(
            event,
            PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<EventHotKeyID>(),
            std::ptr::null_mut(),
            &mut hotkey_id as *mut EventHotKeyID as *mut c_void,
        );
        if status != 0 {
            return status;
        }
        if hotkey_id.signature != HOTKEY_SIGNATURE {
            return EVENT_NOT_HANDLED_ERR;
        }
        let name = id_map()
            .lock()
            .ok()
            .and_then(|map| map.get(&hotkey_id.id).cloned());
        if let Some(id) = name {
            match GetEventKind(event) {
                EVENT_HOTKEY_PRESSED => emit_event("shortcutPressed", json!({ "id": id })),
                EVENT_HOTKEY_RELEASED => emit_event("shortcutReleased", json!({ "id": id })),
                _ => {}
            }
        }
        0 // noErr
    }

    /// Install the app-target event handler once. Also called lazily from
    /// `shortcuts.register` in case launch callbacks were skipped.
    pub fn install() {
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return;
        }
        let types = [
            EventTypeSpec {
                event_class: EVENT_CLASS_KEYBOARD,
                event_kind: EVENT_HOTKEY_PRESSED,
            },
            EventTypeSpec {
                event_class: EVENT_CLASS_KEYBOARD,
                event_kind: EVENT_HOTKEY_RELEASED,
            },
        ];
        let status = unsafe {
            InstallEventHandler(
                GetApplicationEventTarget(),
                hotkey_handler,
                types.len(),
                types.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            INSTALLED.store(false, Ordering::Release);
            log::warn!("shortcuts: InstallEventHandler failed with OSStatus {status}");
        }
    }

    // ── Accelerator parsing ───────────────────────────────────────────

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

    fn modifier_mask(part: &str) -> Option<u32> {
        Some(match part {
            "cmdorctrl" | "commandorcontrol" | "cmd" | "command" | "super" | "meta" => CMD_KEY,
            "shift" => SHIFT_KEY,
            "alt" | "option" => OPTION_KEY,
            "ctrl" | "control" => CONTROL_KEY,
            _ => return None,
        })
    }

    /// Key name → Carbon virtual keycode (ANSI layout codes; Carbon resolves
    /// them against the active keyboard layout at registration).
    fn key_code(name: &str) -> Option<u32> {
        Some(match normalized(name).as_str() {
            "a" => 0x00,
            "s" => 0x01,
            "d" => 0x02,
            "f" => 0x03,
            "h" => 0x04,
            "g" => 0x05,
            "z" => 0x06,
            "x" => 0x07,
            "c" => 0x08,
            "v" => 0x09,
            "b" => 0x0B,
            "q" => 0x0C,
            "w" => 0x0D,
            "e" => 0x0E,
            "r" => 0x0F,
            "y" => 0x10,
            "t" => 0x11,
            "1" => 0x12,
            "2" => 0x13,
            "3" => 0x14,
            "4" => 0x15,
            "6" => 0x16,
            "5" => 0x17,
            "=" | "equal" | "plus" | "+" => 0x18,
            "9" => 0x19,
            "7" => 0x1A,
            "-" | "minus" => 0x1B,
            "8" => 0x1C,
            "0" => 0x1D,
            "]" | "rightbracket" => 0x1E,
            "o" => 0x1F,
            "u" => 0x20,
            "[" | "leftbracket" => 0x21,
            "i" => 0x22,
            "p" => 0x23,
            "l" => 0x25,
            "j" => 0x26,
            "'" | "quote" | "apostrophe" => 0x27,
            "k" => 0x28,
            ";" | "semicolon" => 0x29,
            "\\" | "backslash" => 0x2A,
            "," | "comma" => 0x2B,
            "/" | "slash" => 0x2C,
            "n" => 0x2D,
            "m" => 0x2E,
            "." | "period" => 0x2F,
            "`" | "grave" | "backquote" | "backtick" => 0x32,
            "return" | "enter" => 0x24,
            "tab" => 0x30,
            "space" | "spacebar" => 0x31,
            "backspace" | "delete" => 0x33,
            "escape" | "esc" => 0x35,
            "home" => 0x73,
            "pageup" => 0x74,
            "forwarddelete" | "del" => 0x75,
            "end" => 0x77,
            "pagedown" => 0x79,
            "left" | "leftarrow" => 0x7B,
            "right" | "rightarrow" => 0x7C,
            "down" | "downarrow" => 0x7D,
            "up" | "uparrow" => 0x7E,
            "f1" => 0x7A,
            "f2" => 0x78,
            "f3" => 0x63,
            "f4" => 0x76,
            "f5" => 0x60,
            "f6" => 0x61,
            "f7" => 0x62,
            "f8" => 0x64,
            "f9" => 0x65,
            "f10" => 0x6D,
            "f11" => 0x67,
            "f12" => 0x6F,
            "f13" => 0x69,
            "f14" => 0x6B,
            "f15" => 0x71,
            "f16" => 0x6A,
            "f17" => 0x40,
            "f18" => 0x4F,
            "f19" => 0x50,
            "f20" => 0x5A,
            "num0" => 0x52,
            "num1" => 0x53,
            "num2" => 0x54,
            "num3" => 0x55,
            "num4" => 0x56,
            "num5" => 0x57,
            "num6" => 0x58,
            "num7" => 0x59,
            "num8" => 0x5B,
            "num9" => 0x5C,
            "numdec" | "numpaddecimal" => 0x41,
            "nummult" | "numpadmultiply" => 0x43,
            "numadd" | "numpadadd" => 0x45,
            "numclear" | "numpadclear" => 0x47,
            "numdiv" | "numpaddivide" => 0x4B,
            "numenter" | "numpadenter" => 0x4C,
            "numsub" | "numpadsubtract" => 0x4E,
            "numeq" | "numpadequals" => 0x51,
            _ => return None,
        })
    }

    /// "CmdOrCtrl+Shift+K" → (keycode, modifier mask). The key is the last
    /// `+` segment; everything before it must be modifier names. A trailing
    /// `+` means the `+`/`=` key itself.
    fn parse_accelerator(accelerator: &str) -> Result<(u32, u32), PlatformError> {
        if accelerator.trim().is_empty() {
            return err(PlatformError::invalid(
                "shortcuts.register: accelerator must not be empty",
            ));
        }
        let (mods_str, key_str) = match accelerator.rfind('+') {
            Some(index) => (&accelerator[..index], &accelerator[index + 1..]),
            None => ("", accelerator),
        };
        let key_name = if key_str.is_empty() { "+" } else { key_str };

        let mut modifiers = 0u32;
        if !mods_str.is_empty() {
            for part in mods_str.split('+') {
                let part = normalized(part);
                match modifier_mask(&part) {
                    Some(mask) => modifiers |= mask,
                    None => {
                        return err(PlatformError::invalid(format!(
                            "shortcuts.register: unknown modifier `{part}` in `{accelerator}`"
                        )))
                    }
                }
            }
        }

        if is_modifier(&normalized(key_name)) {
            return err(PlatformError::invalid(format!(
                "shortcuts.register: `{accelerator}` needs a non-modifier key"
            )));
        }
        let code = key_code(key_name).ok_or_else(|| {
            PlatformError::invalid(format!(
                "shortcuts.register: unknown key `{key_name}` in `{accelerator}`"
            ))
        })?;
        Ok((code, modifiers))
    }

    // ── Ops ───────────────────────────────────────────────────────────

    fn register_shortcut(request: &PlatformRequest) -> OpResult {
        let accelerator = request
            .str_arg("accelerator")
            .or_else(|_| request.str_arg("accel"))?;
        let id = request.opt_str("id").unwrap_or_else(|| accelerator.clone());
        let (code, modifiers) = parse_accelerator(&accelerator)?;
        let combo = ((code as u64) << 32) | modifiers as u64;

        install();

        let mut regs = registrations()
            .lock()
            .map_err(|_| PlatformError::internal("shortcuts: registration state poisoned"))?;
        if regs.contains_key(&id) {
            return err(PlatformError::invalid(format!(
                "shortcuts.register: id `{id}` is already registered"
            )));
        }
        if regs.values().any(|reg| reg.combo == combo) {
            return err(PlatformError::invalid(format!(
                "shortcuts.register: `{accelerator}` is already registered"
            )));
        }

        let numeric = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let mut hotkey_ref: EventHotKeyRef = std::ptr::null_mut();
        let status = unsafe {
            RegisterEventHotKey(
                code,
                modifiers,
                EventHotKeyID {
                    signature: HOTKEY_SIGNATURE,
                    id: numeric,
                },
                GetApplicationEventTarget(),
                0,
                &mut hotkey_ref,
            )
        };
        if status != 0 || hotkey_ref.is_null() {
            return err(PlatformError {
				code: "denied",
				message: format!(
					"shortcuts.register: `{accelerator}` could not be registered (OSStatus {status}) — it may collide with another app or a system shortcut"
				),
			});
        }

        regs.insert(
            id.clone(),
            Registration {
                combo,
                numeric,
                hotkey_ref: hotkey_ref as usize,
            },
        );
        if let Ok(mut map) = id_map().lock() {
            map.insert(numeric, id.clone());
        }
        ok(json!({ "id": id }))
    }

    fn unregister(request: &PlatformRequest) -> OpResult {
        let id = request.str_arg("id")?;
        let mut regs = registrations()
            .lock()
            .map_err(|_| PlatformError::internal("shortcuts: registration state poisoned"))?;
        match regs.remove(&id) {
            Some(reg) => {
                unsafe {
                    UnregisterEventHotKey(reg.hotkey_ref as EventHotKeyRef);
                }
                if let Ok(mut map) = id_map().lock() {
                    map.remove(&reg.numeric);
                }
                ok(json!({ "unregistered": true }))
            }
            None => err(PlatformError::invalid(format!(
                "shortcuts.unregister: `{id}` is not registered"
            ))),
        }
    }

    fn unregister_all() -> OpResult {
        let mut regs = registrations()
            .lock()
            .map_err(|_| PlatformError::internal("shortcuts: registration state poisoned"))?;
        let drained: Vec<Registration> = regs.drain().map(|(_, reg)| reg).collect();
        let count = drained.len();
        for reg in drained {
            unsafe {
                UnregisterEventHotKey(reg.hotkey_ref as EventHotKeyRef);
            }
        }
        if let Ok(mut map) = id_map().lock() {
            map.clear();
        }
        ok(json!({ "unregistered": count }))
    }

    pub fn call(request: &PlatformRequest, _cx: &mut App) -> OpResult {
        match request.op.as_str() {
            "register" => register_shortcut(request),
            "unregister" => unregister(request),
            "unregisterAll" | "unregister_all" => unregister_all(),
            "isRegistered" => match request.opt_str("id") {
                Some(id) => match registrations().lock() {
                    Ok(regs) => ok(json!(regs.contains_key(&id))),
                    Err(_) => err(PlatformError::internal(
                        "shortcuts: registration state poisoned",
                    )),
                },
                None => err(PlatformError::invalid(
                    "shortcuts.isRegistered: missing argument `id`",
                )),
            },
            op => err(PlatformError {
                code: "unknown",
                message: format!("unknown shortcuts op `{op}`"),
            }),
        }
    }
}
