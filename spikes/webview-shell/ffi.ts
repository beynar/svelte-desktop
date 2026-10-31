import { dlopen, FFIType } from "bun:ffi";

// One symbol table for both threads. dlopen is refcounted, so the main thread
// and the server Worker share the same loaded library and the same webview.
export const symbols = {
  webview_create: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  webview_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
  webview_run: { args: [FFIType.ptr], returns: FFIType.i32 },
  webview_terminate: { args: [FFIType.ptr], returns: FFIType.i32 },
  webview_set_title: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  webview_set_size: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  webview_set_html: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  webview_bind: { args: [FFIType.ptr, FFIType.cstring, FFIType.function, FFIType.ptr], returns: FFIType.i32 },
  webview_return: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  shell_eval_async: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  shell_set_title_async: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  shell_navigate_async: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
} as const;

export function open(path: string) {
  return dlopen(path, symbols).symbols;
}

export const cstr = (s: string) => Buffer.from(s + "\0");
