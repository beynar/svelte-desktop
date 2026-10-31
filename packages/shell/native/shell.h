// C ABI of the desktop shell, loaded from Bun with bun:ffi.
//
// Thread contract (borrowed from Electrobun, minus its polling):
//  - The process main thread is the UI thread. shell_window_create and shell_run
//    must be called on it; shell_run blocks inside the native run loop.
//  - Every other function is safe from ANY thread (in practice the Bun Worker that
//    runs the app). It copies its arguments, hops to the UI thread asynchronously
//    and returns immediately. Nothing ever calls back into JS synchronously.
//  - Native -> JS traffic is a single event sink: a function pointer (a Bun
//    `JSCallback` created with `threadsafe: true` in the Worker) that receives a
//    malloc'd UTF-8 JSON string. The receiver owns it and must call shell_free.
//  - JS never holds native pointers: windows are small integer ids.
#ifndef SVELTE_DESKTOP_SHELL_H
#define SVELTE_DESKTOP_SHELL_H

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define SHELL_API __declspec(dllexport)
#else
#define SHELL_API __attribute__((visibility("default")))
#endif

typedef void (*shell_event_fn)(const char *json);

SHELL_API int shell_abi_version(void);
SHELL_API void shell_set_event_sink(shell_event_fn fn);
SHELL_API void shell_free(void *p);

// UI thread only.
// opts: {"title","width","height","minWidth","minHeight","debug","url","html",
//        "autosaveName","hiddenUntilReady","appName"}
// Returns a window id > 0, or a negative error code.
SHELL_API int shell_window_create(const char *opts_json);
SHELL_API int shell_run(void);

// Any thread. Return 0 when queued, negative on bad arguments.
SHELL_API int shell_quit(void);
SHELL_API int shell_window_navigate(int id, const char *url);
SHELL_API int shell_window_eval(int id, const char *js);
SHELL_API int shell_window_set_title(int id, const char *title);
SHELL_API int shell_window_set_size(int id, int width, int height);
SHELL_API int shell_window_show(int id);
SHELL_API int shell_window_hide(int id);
SHELL_API int shell_window_focus(int id);
SHELL_API int shell_window_close(int id);

// Navigation policy: top-level navigations inside this origin stay in the window;
// anything else (other origins, target=_blank, window.open) opens in the default
// browser and emits {"type":"external-navigation","url"}.
SHELL_API int shell_set_app_origin(const char *origin);

// Menu spec: [{"label","submenu":[{"label","id","role","accelerator","enabled","type":"separator"}]}]
// Custom items emit {"type":"menu","id"}; roles map to native selectors.
SHELL_API int shell_menu_set(const char *spec_json);

// Platform API (GPUI-era wire format, see platform_internal.h). Result arrives
// on the event sink as {"type":"platformResult","id",ok,value|error}; platform
// events as {"type":"platform","name","data"}.
SHELL_API int shell_platform_call(const char *request_json);

// UI thread, after the first window: dlopen an app native plugin (see
// include/svelte_desktop.h) and run its sd_plugin_init. 0 on success.
SHELL_API int shell_load_plugin(const char *path);

// Any thread. JSON array of "service.op" / "service.*" rules pages may call
// through the bridge (server code is unrestricted). NULL = allow everything.
SHELL_API int shell_set_page_permissions(const char *rules_json);

// kind "open" | "save" | "message"; result arrives as {"type":"dialog","requestId",...}.
SHELL_API int shell_dialog(int request_id, const char *opts_json);

#ifdef __cplusplus
}
#endif

#endif
