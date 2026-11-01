//! Native plugins in Rust for svelte-desktop apps.
//!
//! ```ignore
//! use serde::{Deserialize, Serialize};
//! use svelte_desktop::{plugin, Error, Plugin, TS};
//!
//! #[derive(Deserialize, TS)]
//! struct HashArgs { text: String }
//!
//! #[derive(Serialize, TS)]
//! struct Digest { hex: String }
//!
//! fn setup(p: &mut Plugin) {
//!     p.command("hasher.sha256", |a: HashArgs| -> Result<Digest, Error> { Ok(Digest { hex: sha256(&a.text) }) });
//! }
//!
//! plugin!(setup);
//! ```
//!
//! The app's `native/rust/` crate (`crate-type = ["cdylib"]`) is built by svelte-desktop and loaded
//! by the shell. Each command is a platform op: `nativeModule('hasher').sha256({ text })` from pages
//! and server code, typed from the Rust types (the build reads them with `sd_plugin_describe`).
//! Handlers run on a worker thread, never the UI thread; a panic rejects the call.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde::Serialize;
pub use serde_json::Value;
pub use ts_rs::TS;

// ---------------------------------------------------------------------------
// The C ABI (native/include/svelte_desktop.h)

const ABI_VERSION: c_int = 1;

#[repr(C)]
pub struct SdCall {
    _private: [u8; 0],
}

type OpFn = extern "C" fn(*mut SdCall, *const c_char, *mut c_void);

#[repr(C)]
pub struct SdHost {
    abi: c_int,
    register_op: extern "C" fn(*const c_char, *const c_char, OpFn, *mut c_void) -> c_int,
    resolve: extern "C" fn(*mut SdCall, *const c_char),
    reject: extern "C" fn(*mut SdCall, *const c_char, *const c_char),
    emit: extern "C" fn(*const c_char, *const c_char),
    window: extern "C" fn(c_int) -> *mut c_void,
    webview: extern "C" fn(c_int) -> *mut c_void,
    caller_window: extern "C" fn(*mut SdCall) -> c_int,
    log: extern "C" fn(*const c_char),
}

/// The shell's host table: static for the life of the process.
static HOST: OnceLock<&'static SdHost> = OnceLock::new();

fn cstring(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Errors

/// A rejected call: `code` is one of invalid_args, unsupported, unavailable, denied, internal.
#[derive(Debug, Clone)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error { code, message: message.into() }
    }
    pub fn invalid_args(message: impl Into<String>) -> Self {
        Self::new("invalid_args", message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new("unsupported", message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
    pub fn denied(message: impl Into<String>) -> Self {
        Self::new("denied", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// `?` on any std error rejects with `internal`.
impl<E: std::error::Error> From<E> for Error {
    fn from(e: E) -> Self {
        Error::internal(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Commands

type Handler = Box<dyn Fn(Value) -> Result<Value, Error> + Send + Sync>;

struct Command {
    service: String,
    op: String,
    /// TypeScript of the arguments (`None`: no arguments) and of the result.
    args: Option<String>,
    result: String,
    handler: Handler,
}

/// What `setup` registers commands on.
#[derive(Default)]
pub struct Plugin {
    commands: Vec<Command>,
}

impl Plugin {
    /// Register `service.op`. `A` is deserialized from the call's arguments (use `()` for none),
    /// `R` is the result; both derive `TS` for the generated TypeScript.
    pub fn command<A, R, F>(&mut self, name: &str, f: F) -> &mut Self
    where
        A: DeserializeOwned + TS + 'static,
        R: Serialize + TS + 'static,
        F: Fn(A) -> Result<R, Error> + Send + Sync + 'static,
    {
        let (service, op) = name.split_once('.').unwrap_or_else(|| panic!("svelte-desktop: command `{name}` must be named service.op"));
        let cfg = ts_rs::Config::new().with_large_int("number");
        let args = A::inline(&cfg);
        self.commands.push(Command {
            service: service.to_owned(),
            op: op.to_owned(),
            args: (args != "null").then_some(args),
            result: R::inline(&cfg),
            handler: Box::new(move |v| {
                let a = parse::<A>(v)?;
                let r = f(a)?;
                serde_json::to_value(r).map_err(|e| Error::internal(format!("result: {e}")))
            }),
        });
        self
    }
}

/// Arguments arrive as a JSON object; `()` takes `{}`.
fn parse<A: DeserializeOwned>(v: Value) -> Result<A, Error> {
    let empty = v.as_object().is_some_and(|o| o.is_empty());
    match serde_json::from_value::<A>(v) {
        Ok(a) => Ok(a),
        Err(_) if empty => serde_json::from_value::<A>(Value::Null).map_err(|e| Error::invalid_args(e.to_string())),
        Err(e) => Err(Error::invalid_args(e.to_string())),
    }
}

struct CallPtr(*mut SdCall);
unsafe impl Send for CallPtr {}

extern "C" fn dispatch(call: *mut SdCall, args: *const c_char, user: *mut c_void) {
    // Registered commands live as long as the process (leaked at init).
    let cmd: &'static Command = unsafe { &*(user as *const Command) };
    let json = if args.is_null() { "{}".to_owned() } else { unsafe { CStr::from_ptr(args) }.to_string_lossy().into_owned() };
    let call = CallPtr(call);
    // Off the UI thread: resolve/reject may be called from any thread.
    std::thread::spawn(move || {
        let call = call;
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let v: Value = serde_json::from_str(&json).map_err(|e| Error::invalid_args(e.to_string()))?;
            (cmd.handler)(v)
        }));
        let Some(host) = HOST.get() else { return };
        match outcome {
            Ok(Ok(v)) => (host.resolve)(call.0, cstring(&v.to_string()).as_ptr()),
            Ok(Err(e)) => (host.reject)(call.0, cstring(e.code).as_ptr(), cstring(&e.message).as_ptr()),
            Err(p) => {
                let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
                (host.reject)(call.0, cstring("internal").as_ptr(), cstring(&format!("{}.{} panicked: {msg}", cmd.service, cmd.op)).as_ptr());
            }
        }
    });
}

/// Broadcast an event to every page and to server code (`onPlatform(event)`). Any thread.
pub fn emit<T: Serialize>(event: &str, data: &T) {
    if let (Some(host), Ok(json)) = (HOST.get(), serde_json::to_string(data)) {
        (host.emit)(cstring(event).as_ptr(), cstring(&json).as_ptr());
    }
}

/// A line in the app's log.
pub fn log(message: &str) {
    if let Some(host) = HOST.get() {
        (host.log)(cstring(message).as_ptr());
    }
}

// ---------------------------------------------------------------------------
// Entry points, exported by `plugin!`

#[doc(hidden)]
pub fn __init(host: *const SdHost, setup: fn(&mut Plugin)) -> c_int {
    if host.is_null() || unsafe { (*host).abi } != ABI_VERSION {
        return -1;
    }
    let host: &'static SdHost = unsafe { &*host };
    let _ = HOST.set(host);
    let mut plugin = Plugin::default();
    setup(&mut plugin);
    for cmd in plugin.commands {
        let (service, op) = (cstring(&cmd.service), cstring(&cmd.op));
        let name = format!("{}.{}", cmd.service, cmd.op);
        let user = Box::into_raw(Box::new(cmd)) as *mut c_void;
        if (host.register_op)(service.as_ptr(), op.as_ptr(), dispatch, user) != 0 {
            log(&format!("command {name} not registered: the name is already taken (the shell or another plugin)"));
        }
    }
    0
}

#[doc(hidden)]
pub fn __describe(setup: fn(&mut Plugin)) -> *const c_char {
    static OUT: OnceLock<CString> = OnceLock::new();
    OUT.get_or_init(|| {
        let mut plugin = Plugin::default();
        setup(&mut plugin);
        let commands: Vec<Value> = plugin
            .commands
            .iter()
            .map(|c| serde_json::json!({ "service": c.service, "op": c.op, "args": c.args, "result": c.result }))
            .collect();
        cstring(&serde_json::json!({ "abi": ABI_VERSION, "language": "rust", "commands": commands }).to_string())
    })
    .as_ptr()
}

/// Export the plugin: `plugin!(setup)` with `fn setup(p: &mut Plugin)`.
#[macro_export]
macro_rules! plugin {
    ($setup:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn sd_plugin_init(host: *const $crate::SdHost) -> ::std::ffi::c_int {
            $crate::__init(host, $setup)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sd_plugin_describe() -> *const ::std::ffi::c_char {
            $crate::__describe($setup)
        }
    };
}
