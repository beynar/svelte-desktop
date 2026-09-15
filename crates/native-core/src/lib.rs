// native-core: mission spike for the $native generated-bindings contract.
// C ABI only — no napi; consumed via bun:ffi. Panics must not cross the ABI:
// every entry funnels through catch_unwind and reports through status codes.
use std::panic::catch_unwind;
use std::slice;

/// scalar round-trip
#[no_mangle]
pub extern "C" fn nc_add(a: i64, b: i64) -> i64 { a.wrapping_add(b) }

/// bytes-in → count-out: UTF-8 word count over an owned caller buffer
/// (caller keeps the buffer; we only read it for the call duration)
#[no_mangle]
pub extern "C" fn nc_word_count(ptr: *const u8, len: usize) -> i64 {
    catch_unwind(|| {
        if ptr.is_null() { return -1; }
        let bytes = unsafe { slice::from_raw_parts(ptr, len) };
        match std::str::from_utf8(bytes) {
            Ok(s) => s.split_whitespace().count() as i64,
            Err(_) => -2, // typed error: not utf8
        }
    }).unwrap_or(-99) // panic containment
}

/// allocation-returning string op: JSON in, JSON out.
/// Returns a heap pointer; `nc_free` releases it. Length written to out_len.
/// This is the "structured results" pattern: caller passes a buffer we fill
/// or we allocate — here we allocate and hand ownership across the boundary.
#[no_mangle]
pub extern "C" fn nc_json_transform(ptr: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    catch_unwind(|| {
        if ptr.is_null() || out_len.is_null() { return std::ptr::null_mut(); }
        let input = unsafe { slice::from_raw_parts(ptr, len) };
        // real impl would serde_json; spike does a deterministic transform:
        // uppercase all ascii inside the payload
        let mut v = input.to_vec();
        for b in v.iter_mut() { b.make_ascii_uppercase(); }
        unsafe { *out_len = v.len() };
        let mut boxed = v.into_boxed_slice();
        let p = boxed.as_mut_ptr();
        std::mem::forget(boxed);
        p
    }).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn nc_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() { return; }
    unsafe { drop(Box::from_raw(slice::from_raw_parts_mut(ptr, len))) };
}

// ── v2: async completion, opaque handles, cancellation ──────────────────
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;

// Opaque handle registry — JS sees u64 ids, never pointers.
struct Hasher { state: u64 }
static HANDLES: OnceLock<Mutex<HashMap<u64, Hasher>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
fn handles() -> &'static Mutex<HashMap<u64, Hasher>> {
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[no_mangle]
pub extern "C" fn nc_hasher_new() -> u64 {
    let id = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    handles().lock().unwrap().insert(id, Hasher { state: 0xcbf29ce484222325 });
    id
}

/// FNV-1a over caller-owned buffer. Status-only return: a full-range u64
/// value must never ride the i64 error channel — values come out via
/// out-params (see nc_hasher_finish).
#[no_mangle]
pub extern "C" fn nc_hasher_update(h: u64, ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() { return -1; }
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    let mut map = handles().lock().unwrap();
    match map.get_mut(&h) {
        Some(hh) => {
            for &b in bytes {
                hh.state ^= b as u64;
                hh.state = hh.state.wrapping_mul(0x100000001b3);
            }
            0
        }
        None => -2, // unknown handle
    }
}

/// Status 0 + hash written to *out_hash. Full u64 range preserved.
#[no_mangle]
pub extern "C" fn nc_hasher_finish(h: u64, out_hash: *mut u64) -> i32 {
    if out_hash.is_null() { return -1; }
    match handles().lock().unwrap().remove(&h) {
        Some(hh) => { unsafe { *out_hash = hh.state }; 0 }
        None => -2,
    }
}

// Async: spawn a thread; invoke the JSCallback when done.
// The callback type must outlive the call — caller keeps it alive until fired.
// status: 0 = completed, 1 = cancelled.
type DoneCb = extern "C" fn(u64, i32);
static CANCEL_FLAGS: OnceLock<Mutex<HashMap<u64, AtomicBool>>> = OnceLock::new();
fn cancels() -> &'static Mutex<HashMap<u64, AtomicBool>> {
    CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// count to n in ~1ms per step on a worker thread; cb(task_id, status).
/// Returns the task id (for cancel) or 0 on failure.
#[no_mangle]
pub extern "C" fn nc_count_async(n: u64, cb: DoneCb) -> u64 {
    let id = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    let flag = AtomicBool::new(false);
    cancels().lock().unwrap().insert(id, flag);
    thread::spawn(move || {
        let cancelled = cancels().lock().unwrap().get(&id).map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
        let mut i = 0u64;
        while i < n {
            // check cancel every iteration (1ms steps — responsive)
            let cancel = cancels().lock().unwrap().get(&id).map(|f| f.load(Ordering::Relaxed)).unwrap_or(true);
            if cancel { break; }
            i += 1;
            thread::sleep(std::time::Duration::from_millis(1));
        }
        cancels().lock().unwrap().remove(&id);
        let status = if cancelled || i < n { 1 } else { 0 };
        cb(id, status);
    });
    id
}

/// Signal cancellation for a task. Does not join the thread — stops awaiting.
#[no_mangle]
pub extern "C" fn nc_cancel(task_id: u64) -> i32 {
    match cancels().lock().unwrap().get(&task_id) {
        Some(f) => { f.store(true, Ordering::Relaxed); 0 }
        None => -1,
    }
}
