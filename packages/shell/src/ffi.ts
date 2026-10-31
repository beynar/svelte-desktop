import { dlopen, FFIType, CString, type Pointer } from "bun:ffi";

// Mirror of native/shell.h. dlopen is refcounted: the UI thread and the Worker
// each open the library and share one copy of its state.
const { ptr, i32, cstring, function: fn, void: v } = FFIType;
export const symbols = {
  shell_abi_version: { args: [], returns: i32 },
  shell_set_event_sink: { args: [fn], returns: v },
  shell_free: { args: [ptr], returns: v },
  shell_window_create: { args: [cstring], returns: i32 },
  shell_run: { args: [], returns: i32 },
  shell_quit: { args: [], returns: i32 },
  shell_window_navigate: { args: [i32, cstring], returns: i32 },
  shell_window_eval: { args: [i32, cstring], returns: i32 },
  shell_window_set_title: { args: [i32, cstring], returns: i32 },
  shell_window_set_size: { args: [i32, i32, i32], returns: i32 },
  shell_window_show: { args: [i32], returns: i32 },
  shell_window_hide: { args: [i32], returns: i32 },
  shell_window_focus: { args: [i32], returns: i32 },
  shell_window_close: { args: [i32], returns: i32 },
  shell_set_app_origin: { args: [cstring], returns: i32 },
  shell_menu_set: { args: [cstring], returns: i32 },
  shell_dialog: { args: [i32, cstring], returns: i32 },
  shell_platform_call: { args: [cstring], returns: i32 },
  shell_load_plugin: { args: [cstring], returns: i32 },
  shell_set_page_permissions: { args: [cstring], returns: i32 },
} as const;

export const ABI_VERSION = 2;

export type Native = ReturnType<typeof dlopen<typeof symbols>>["symbols"];

export function openNative(path: string): Native {
  const lib = dlopen(path, symbols).symbols;
  const abi = lib.shell_abi_version();
  if (abi !== ABI_VERSION) throw new Error(`libshell ABI ${abi}, expected ${ABI_VERSION} (${path})`);
  return lib;
}

/** NUL-terminated UTF-8 for `cstring` arguments. */
export const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

/** Reads and frees a string the native side allocated for us. */
export function takeString(lib: Native, p: Pointer): string {
  const s = new CString(p).toString();
  lib.shell_free(p);
  return s;
}
