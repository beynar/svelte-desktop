// svelte-desktop native plugin ABI.
//
// An app's `native/` folder (Swift, Objective-C, C) is compiled into
// libapp-native.dylib and loaded by the shell on the UI thread before the run
// loop starts. It exports one function:
//
//   int sd_plugin_init(const sd_host *host);     // return 0 on success
//
// and registers ops with host->register_op("service", "op", fn, user). Ops are
// regular platform ops: callable from pages (`nativeModule('service').op(args)`)
// and from server code, with the same permission checks. Handlers run on the
// main thread; resolve/reject may be called later, from any thread.
#ifndef SVELTE_DESKTOP_H
#define SVELTE_DESKTOP_H

#ifdef __cplusplus
extern "C" {
#endif

#define SD_ABI_VERSION 1

typedef struct sd_call sd_call;
/// `args_json` is a JSON object (never NULL). Reply exactly once via resolve/reject.
typedef void (*sd_op_fn)(sd_call *call, const char *args_json, void *user);

typedef struct sd_host {
  int abi; // SD_ABI_VERSION
  /// Register `service.op`. Returns 0, or -1 if the name is taken by the shell.
  int (*register_op)(const char *service, const char *op, sd_op_fn fn, void *user);
  /// Reply with a JSON value ("null", "42", "{\"a\":1}", "\"text\""). Any thread.
  void (*resolve)(sd_call *call, const char *value_json);
  /// Reply with an error. code: invalid_args | unsupported | unavailable | denied | internal. Any thread.
  void (*reject)(sd_call *call, const char *code, const char *message);
  /// Broadcast an event to every page and to server code (`onPlatform(name)`). Any thread.
  void (*emit)(const char *event, const char *data_json);
  /// NSWindow* / WKWebView* for a public window id (0 = main window), or NULL. Main thread.
  void *(*window)(int window_id);
  void *(*webview)(int window_id);
  /// Public id of the window whose page issued the call, or -1 (server code).
  int (*caller_window)(sd_call *call);
  void (*log)(const char *message);
} sd_host;

typedef int (*sd_plugin_init_fn)(const sd_host *host);

#ifdef __cplusplus
}
#endif

#endif
