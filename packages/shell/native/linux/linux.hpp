// Internal contract of the Linux backend (GTK 3 + WebKitGTK 4.1).
// Everything here runs on the GTK main thread unless stated otherwise.
//
// Files:
//   shell_linux.cc      windows, run loop, signals, navigation policy, page bridge,
//                       backend_* hooks of ../portable/core.hpp, shell_* exports
//   svc_app.cc          app.*  (+ single-instance lock)
//   svc_window.cc       window.*
//   svc_misc.cc         screen.*, clipboard.*, shell.*, theme.*, diagnostics.info,
//                       capabilities.describe, power.*
//   svc_dialog.cc       dialog.* (GtkFileChooserNative, GtkMessageDialog)
//   svc_webview.cc      webview.*, popover.*, events.emit
//   svc_optional.cc     notifications.* (libnotify), tray.* (ayatana-appindicator),
//                       secureStorage.* (libsecret) — all dlopen()ed at runtime
#pragma once
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

#include <functional>
#include <string>
#include <vector>

#include "../portable/core.hpp"

namespace sd {
namespace lx {

struct Window {
  int id = 0;
  std::string label;
  GtkWidget *window = nullptr; // GtkWindow
  WebKitWebView *webview = nullptr;
  bool shown = false;   // revealed at least once (hidden-until-ready done)
  bool visible = true;  // requested visibility at creation
  bool veto = false;
  bool closing = false; // programmatic close: bypass veto
  GdkWindowState state = (GdkWindowState)0;
  bool focused = false;
  int minW = 0, minH = 0, maxW = 0, maxH = 0;
  bool ignoreMouse = false;
};

// ---- windows (shell_linux.cc) ---------------------------------------------
Window *find_window(int native_id);
std::vector<int> window_ids();              // native ids, creation order
int primary_window();                       // native id of the primary window, 0 if none
int public_id(int native_id);               // 0 = primary
/// Resolves args.windowId (public id) → native id; else the caller window, the
/// active window, the primary window. 0 if none / unknown windowId.
int resolve_window(const Call &c);
/// window.create: opts as shell_window_create plus `path` and `label`.
/// Returns native id, -4 for a duplicate label, <0 on failure.
int create_window_from_platform(const json &opts);
void reveal(Window *w);
std::string app_name();
std::string app_identifier();
std::string app_version();
void set_app_name_override(const std::string &name);
void set_app_identifier_override(const std::string &id);
void request_quit();

// ---- web views (shell_linux.cc) ------------------------------------------
/// Creates a WebKitWebView with the page bridge attached (bridge script at
/// document start in the top frame, `__shell__` message handler, nonce-checked)
/// and the shell's navigation policy / crash recovery. `extra_script` is an
/// optional additional top-frame document-start script (popovers).
WebKitWebView *make_webview(int native_id, bool debug, const std::string &extra_script);
void detach_webview(int native_id);
WebKitWebView *webview_for(int native_id); // windows and popovers
bool same_origin(const std::string &url);
std::string origin_of(const std::string &url);

// ---- popovers (svc_webview.cc) -------------------------------------------
bool popover_page_ready(int native_id); // true if native_id is a popover
std::string popover_ident(int native_id); // "" if not a popover
bool popover_tray_click();               // true if a bound popover handled it

// ---- JS helpers (svc_webview.cc) -----------------------------------------
/// Evaluate `js` in the page (script semantics), reply with its JSON value.
void eval_to_json(WebKitWebView *wv, const std::string &js, CallPtr c, const char *what);

// ---- misc helpers ---------------------------------------------------------
inline json rect_json(double x, double y, double w, double h) { return json{{"x", x}, {"y", y}, {"width", w}, {"height", h}}; }
/// Frame rect (decorations included) in root coordinates.
GdkRectangle frame_rect(Window *w);
/// Content (client area) rect in root coordinates.
GdkRectangle content_rect(Window *w);
GdkMonitor *monitor_at(int x, int y);
GdkMonitor *primary_monitor();
void pointer_position(int *x, int *y);
std::string base64_encode(const unsigned char *data, size_t len);
std::vector<unsigned char> base64_decode(const std::string &s, bool *ok);
std::string user_dir(GUserDirectory d, const char *fallback_name);
std::string exe_path();
std::string exe_dir();
bool packaged(); // <exeDir>/lib/libshell.so exists (an app directory / AppImage)

// ---- service registration ---------------------------------------------------
void register_app();
void register_window();
void register_misc();   // screen, clipboard, shell, theme, diagnostics, capabilities, power
void register_dialog();
void register_webview(); // webview, popover, events
void register_optional(); // notifications, tray, secureStorage
/// Ops that cannot work in this environment (library or daemon missing), for
/// capabilities.describe: "service.op" → reason. Filled by register_optional().
const std::vector<std::string> &unavailable_ops();
/// Tray: bind a popover to the indicator (activations toggle it).
void tray_bind_popover(const std::string &id);
bool tray_is_set();

/// Legacy shell_dialog support: run the dialog service and translate its reply.
void dialog_legacy(int request_id, const json &opts);

} // namespace lx
} // namespace sd
