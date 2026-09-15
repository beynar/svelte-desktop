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
